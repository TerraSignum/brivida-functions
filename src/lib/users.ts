import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, QuerySnapshot, DocumentData } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { getDb } from './firestore';

const USERNAME_REGEX = /^[a-z0-9_.]{3,20}$/;
const USERNAME_BLACKLIST = new Set([
  'admin',
  'support',
  'brivida',
  'moderator',
  'help',
  'contact',
  'root',
  'team',
  'staff',
]);

const FINAL_PAYMENT_STATUSES = new Set([
  'refunded',
  'cancelled',
  'failed',
  'transferred',
]);

const CLOSED_DISPUTE_STATUSES = new Set([
  'resolved_refund_full',
  'resolved_refund_partial',
  'resolved_no_refund',
  'cancelled',
  'expired',
  'completed',
]);

export const usersService = {
  async reserveUsername({ uid, desired }: { uid: string; desired: string }) {
    const normalized = normalizeUsername(desired);
    validateUsername(normalized);

    const db = getDb();
    const usernamesCollection = db.collection('usernames');
    const userRef = db.collection('users').doc(uid);
    const desiredRef = usernamesCollection.doc(normalized);

    await db.runTransaction(async (transaction) => {
      const [userSnap, desiredSnap] = await Promise.all([
        transaction.get(userRef),
        transaction.get(desiredRef),
      ]);

      if (!userSnap.exists) {
        throw new HttpsError('not-found', 'User profile not found');
      }

      const userData = userSnap.data() || {};
      const currentUsername = (userData.usernameLower as string | undefined) ?? null;

      if (currentUsername === normalized) {
        if (!desiredSnap.exists) {
          transaction.set(desiredRef, {
            uid,
            reservedAt: Timestamp.now(),
          });
        }
        return;
      }

      if (desiredSnap.exists && desiredSnap.data()?.uid !== uid) {
        throw new HttpsError('already-exists', 'Username already taken', {
          code: 'ALREADY_TAKEN',
        });
      }

      const now = Timestamp.now();
      const updates: Record<string, unknown> = {
        username: normalized,
        usernameLower: normalized,
        usernameUpdatedAt: now,
      };

      if (currentUsername && currentUsername !== normalized) {
        updates.usernameHistory = FieldValue.arrayUnion({
          value: currentUsername,
          changedAt: now,
        });
      }

      transaction.update(userRef, updates);
      transaction.set(desiredRef, { uid, reservedAt: now });

      if (currentUsername && currentUsername !== normalized) {
        const previousRef = usernamesCollection.doc(currentUsername);
        transaction.delete(previousRef);
      }
    });

    logger.info('✅ reserveUsername succeeded', { uid, username: normalized });

    return { success: true, username: normalized };
  },

  async deleteAccount(uid: string) {
    const db = getDb();
    await ensureNoActiveOperations(uid);

    const userRef = db.collection('users').doc(uid);
    const usernamesCollection = db.collection('usernames');
    const proProfileRef = db.collection('proProfiles').doc(uid);

    await db.runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef);
      if (!userSnap.exists) {
        throw new HttpsError('not-found', 'User profile not found');
      }

      const userData = userSnap.data() || {};
      if (userData.deleted === true) {
        return;
      }

      const now = Timestamp.now();
      const updates: Record<string, unknown> = {
        deleted: true,
        deletedAt: now,
        marketingOptIn: false,
        status: 'deleted',
      };

      transaction.update(userRef, updates);

      const username = userData.usernameLower as string | undefined;
      if (username) {
        transaction.delete(usernamesCollection.doc(username));
      }

      const proProfileSnap = await transaction.get(proProfileRef);
      if (proProfileSnap.exists) {
        transaction.update(proProfileRef, {
          status: 'inactive',
          visibility: 'hidden',
          deactivatedAt: now,
        });
      }
    });

    try {
      await getAuth().deleteUser(uid);
    } catch (error: any) {
      if (error?.code === 'auth/user-not-found') {
        logger.warn('deleteAccount: auth user already removed', { uid });
      } else {
        logger.error('deleteAccount: failed to delete auth user', { uid, error });
        throw new HttpsError('internal', 'Failed to delete authentication user');
      }
    }

    logger.info('✅ deleteAccount succeeded', { uid });
    return { success: true };
  },
};

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function validateUsername(value: string) {
  if (!USERNAME_REGEX.test(value)) {
    throw new HttpsError('invalid-argument', 'Username format invalid', {
      code: 'INVALID_FORMAT',
    });
  }
  if (USERNAME_BLACKLIST.has(value)) {
    throw new HttpsError('failed-precondition', 'Username not allowed', {
      code: 'BLACKLISTED',
    });
  }
}

async function ensureNoActiveOperations(uid: string) {
  const db = getDb();

  const [customerPayments, proPayments, customerDisputes, proDisputes] = await Promise.all([
    db.collection('payments').where('customerUid', '==', uid).limit(20).get(),
    db.collection('payments').where('proUid', '==', uid).limit(20).get(),
    db.collection('disputes').where('customerUid', '==', uid).limit(20).get(),
    db.collection('disputes').where('proUid', '==', uid).limit(20).get(),
  ]);

  if (
    hasActivePayment(customerPayments) ||
    hasActivePayment(proPayments) ||
    hasActiveDispute(customerDisputes) ||
    hasActiveDispute(proDisputes)
  ) {
    throw new HttpsError('failed-precondition', 'Active operations block account deletion', {
      code: 'BLOCKED_ACTIVE_OPERATIONS',
    });
  }
}

function hasActivePayment(snapshot: QuerySnapshot<DocumentData>) {
  return snapshot.docs.some((doc) => {
    const status = doc.get('status');
    if (typeof status !== 'string') {
      return true;
    }
    return !FINAL_PAYMENT_STATUSES.has(status.toLowerCase());
  });
}

function hasActiveDispute(snapshot: QuerySnapshot<DocumentData>) {
  return snapshot.docs.some((doc) => {
    const status = doc.get('status');
    if (typeof status !== 'string') {
      return true;
    }
    return !CLOSED_DISPUTE_STATUSES.has(status);
  });
}
