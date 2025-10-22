import { getAuth } from 'firebase-admin/auth';
import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';

const RAW_ADMIN_EMAILS = ['sandro.bucciarelli89@gmail.com'];
const ADMIN_EMAIL_WHITELIST = new Set(
  RAW_ADMIN_EMAILS.map((email) => email.trim().toLowerCase())
);

function normalizeEmail(email?: string | null): string | null {
  if (!email) {
    return null;
  }
  return email.trim().toLowerCase();
}

function isWhitelistedEmail(email?: string | null): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return false;
  }
  return ADMIN_EMAIL_WHITELIST.has(normalized);
}

/**
 * Validates that the authenticated user has admin role
 * @param auth - Firebase auth context from callable function
 * @throws HttpsError if user is not admin
 */
export async function enforceAdminRole(auth: any): Promise<void> {
  if (!auth) {
    throw new HttpsError('unauthenticated', 'User must be authenticated');
  }

  try {
    const userRecord = await getAuth().getUser(auth.uid);
    const customClaims = userRecord.customClaims;
    const hasAdminRole =
      !!customClaims && customClaims.role === 'admin';
    const isAdmin = hasAdminRole || isWhitelistedEmail(userRecord.email);

    if (!isAdmin) {
      logger.warn('Admin access denied', {
        uid: auth.uid,
        role: customClaims ? customClaims.role : undefined,
        email: userRecord.email,
      });
      throw new HttpsError('permission-denied', 'Admin role required');
    }

    logger.info('Admin access granted', {
      uid: auth.uid,
      email: userRecord.email,
    });
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }
    logger.error('Error checking admin role', { uid: auth.uid, error });
    throw new HttpsError('internal', 'Failed to verify admin role');
  }
}

/**
 * Checks if the authenticated user has admin role (non-throwing)
 * @param auth - Firebase auth context from callable function
 * @returns true if user is admin, false otherwise
 */
export async function isAdmin(auth: any): Promise<boolean> {
  if (!auth) {
    return false;
  }

  try {
    const userRecord = await getAuth().getUser(auth.uid);
    const customClaims = userRecord.customClaims;
    const hasAdminRole =
      !!customClaims && customClaims.role === 'admin';
    return hasAdminRole || isWhitelistedEmail(userRecord.email);
  } catch (error) {
    logger.error('Error checking admin role', { uid: auth.uid, error });
    return false;
  }
}