"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usersService = void 0;
const auth_1 = require("firebase-admin/auth");
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/v2/https");
const v2_1 = require("firebase-functions/v2");
const firestore_2 = require("./firestore");
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
exports.usersService = {
    async reserveUsername({ uid, desired }) {
        const normalized = normalizeUsername(desired);
        validateUsername(normalized);
        const db = (0, firestore_2.getDb)();
        const usernamesCollection = db.collection('usernames');
        const userRef = db.collection('users').doc(uid);
        const desiredRef = usernamesCollection.doc(normalized);
        await db.runTransaction(async (transaction) => {
            var _a, _b;
            const [userSnap, desiredSnap] = await Promise.all([
                transaction.get(userRef),
                transaction.get(desiredRef),
            ]);
            if (!userSnap.exists) {
                throw new https_1.HttpsError('not-found', 'User profile not found');
            }
            const userData = userSnap.data() || {};
            const currentUsername = (_a = userData.usernameLower) !== null && _a !== void 0 ? _a : null;
            if (currentUsername === normalized) {
                if (!desiredSnap.exists) {
                    transaction.set(desiredRef, {
                        uid,
                        reservedAt: firestore_1.Timestamp.now(),
                    });
                }
                return;
            }
            if (desiredSnap.exists && ((_b = desiredSnap.data()) === null || _b === void 0 ? void 0 : _b.uid) !== uid) {
                throw new https_1.HttpsError('already-exists', 'Username already taken', {
                    code: 'ALREADY_TAKEN',
                });
            }
            const now = firestore_1.Timestamp.now();
            const updates = {
                username: normalized,
                usernameLower: normalized,
                usernameUpdatedAt: now,
            };
            if (currentUsername && currentUsername !== normalized) {
                updates.usernameHistory = firestore_1.FieldValue.arrayUnion({
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
        v2_1.logger.info('✅ reserveUsername succeeded', { uid, username: normalized });
        return { success: true, username: normalized };
    },
    async deleteAccount(uid) {
        const db = (0, firestore_2.getDb)();
        await ensureNoActiveOperations(uid);
        const userRef = db.collection('users').doc(uid);
        const usernamesCollection = db.collection('usernames');
        const proProfileRef = db.collection('proProfiles').doc(uid);
        await db.runTransaction(async (transaction) => {
            const userSnap = await transaction.get(userRef);
            if (!userSnap.exists) {
                throw new https_1.HttpsError('not-found', 'User profile not found');
            }
            const userData = userSnap.data() || {};
            if (userData.deleted === true) {
                return;
            }
            const now = firestore_1.Timestamp.now();
            const updates = {
                deleted: true,
                deletedAt: now,
                marketingOptIn: false,
                status: 'deleted',
            };
            transaction.update(userRef, updates);
            const username = userData.usernameLower;
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
            await (0, auth_1.getAuth)().deleteUser(uid);
        }
        catch (error) {
            if ((error === null || error === void 0 ? void 0 : error.code) === 'auth/user-not-found') {
                v2_1.logger.warn('deleteAccount: auth user already removed', { uid });
            }
            else {
                v2_1.logger.error('deleteAccount: failed to delete auth user', { uid, error });
                throw new https_1.HttpsError('internal', 'Failed to delete authentication user');
            }
        }
        v2_1.logger.info('✅ deleteAccount succeeded', { uid });
        return { success: true };
    },
};
function normalizeUsername(value) {
    return value.trim().toLowerCase();
}
function validateUsername(value) {
    if (!USERNAME_REGEX.test(value)) {
        throw new https_1.HttpsError('invalid-argument', 'Username format invalid', {
            code: 'INVALID_FORMAT',
        });
    }
    if (USERNAME_BLACKLIST.has(value)) {
        throw new https_1.HttpsError('failed-precondition', 'Username not allowed', {
            code: 'BLACKLISTED',
        });
    }
}
async function ensureNoActiveOperations(uid) {
    const db = (0, firestore_2.getDb)();
    const [customerPayments, proPayments, customerDisputes, proDisputes] = await Promise.all([
        db.collection('payments').where('customerUid', '==', uid).limit(20).get(),
        db.collection('payments').where('proUid', '==', uid).limit(20).get(),
        db.collection('disputes').where('customerUid', '==', uid).limit(20).get(),
        db.collection('disputes').where('proUid', '==', uid).limit(20).get(),
    ]);
    if (hasActivePayment(customerPayments) ||
        hasActivePayment(proPayments) ||
        hasActiveDispute(customerDisputes) ||
        hasActiveDispute(proDisputes)) {
        throw new https_1.HttpsError('failed-precondition', 'Active operations block account deletion', {
            code: 'BLOCKED_ACTIVE_OPERATIONS',
        });
    }
}
function hasActivePayment(snapshot) {
    return snapshot.docs.some((doc) => {
        const status = doc.get('status');
        if (typeof status !== 'string') {
            return true;
        }
        return !FINAL_PAYMENT_STATUSES.has(status.toLowerCase());
    });
}
function hasActiveDispute(snapshot) {
    return snapshot.docs.some((doc) => {
        const status = doc.get('status');
        if (typeof status !== 'string') {
            return true;
        }
        return !CLOSED_DISPUTE_STATUSES.has(status);
    });
}
//# sourceMappingURL=users.js.map