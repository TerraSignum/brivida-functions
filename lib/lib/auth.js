"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enforceAdminRole = enforceAdminRole;
exports.isAdmin = isAdmin;
const auth_1 = require("firebase-admin/auth");
const https_1 = require("firebase-functions/v2/https");
const v2_1 = require("firebase-functions/v2");
const RAW_ADMIN_EMAILS = ['sandro.bucciarelli89@gmail.com'];
const ADMIN_EMAIL_WHITELIST = new Set(RAW_ADMIN_EMAILS.map((email) => email.trim().toLowerCase()));
function normalizeEmail(email) {
    if (!email) {
        return null;
    }
    return email.trim().toLowerCase();
}
function isWhitelistedEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) {
        return false;
    }
    return ADMIN_EMAIL_WHITELIST.has(normalized);
}
async function enforceAdminRole(auth) {
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    try {
        const userRecord = await (0, auth_1.getAuth)().getUser(auth.uid);
        const customClaims = userRecord.customClaims;
        const hasAdminRole = !!customClaims && customClaims.role === 'admin';
        const isAdmin = hasAdminRole || isWhitelistedEmail(userRecord.email);
        if (!isAdmin) {
            v2_1.logger.warn('Admin access denied', {
                uid: auth.uid,
                role: customClaims ? customClaims.role : undefined,
                email: userRecord.email,
            });
            throw new https_1.HttpsError('permission-denied', 'Admin role required');
        }
        v2_1.logger.info('Admin access granted', {
            uid: auth.uid,
            email: userRecord.email,
        });
    }
    catch (error) {
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        v2_1.logger.error('Error checking admin role', { uid: auth.uid, error });
        throw new https_1.HttpsError('internal', 'Failed to verify admin role');
    }
}
async function isAdmin(auth) {
    if (!auth) {
        return false;
    }
    try {
        const userRecord = await (0, auth_1.getAuth)().getUser(auth.uid);
        const customClaims = userRecord.customClaims;
        const hasAdminRole = !!customClaims && customClaims.role === 'admin';
        return hasAdminRole || isWhitelistedEmail(userRecord.email);
    }
    catch (error) {
        v2_1.logger.error('Error checking admin role', { uid: auth.uid, error });
        return false;
    }
}
//# sourceMappingURL=auth.js.map