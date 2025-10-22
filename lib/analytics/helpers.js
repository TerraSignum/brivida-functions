"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logServerEvent = logServerEvent;
exports.logPaymentEvent = logPaymentEvent;
exports.logDisputeEvent = logDisputeEvent;
exports.logTransferEvent = logTransferEvent;
exports.logAdminEvent = logAdminEvent;
exports.logPushEvent = logPushEvent;
const firestore_1 = require("firebase-admin/firestore");
const v2_1 = require("firebase-functions/v2");
const crypto_1 = require("crypto");
const ANALYTICS_SALT = process.env.ANALYTICS_SALT || 'default_salt_change_me';
function hashWithSalt(value) {
    return (0, crypto_1.createHash)('sha256').update(ANALYTICS_SALT + value).digest('hex');
}
async function logServerEvent({ uid, role, name, props = {}, request, }) {
    var _a;
    try {
        const db = (0, firestore_1.getFirestore)();
        const now = new Date();
        const context = {
            platform: 'server',
            appVersion: 'functions',
        };
        if (request) {
            if (request.ip) {
                context.ipHash = hashWithSalt(request.ip);
            }
            if ((_a = request === null || request === void 0 ? void 0 : request.get) === null || _a === void 0 ? void 0 : _a.call(request, 'User-Agent')) {
                context.uaHash = hashWithSalt(request.get('User-Agent'));
            }
        }
        const event = {
            uid: uid || null,
            role: role || null,
            ts: firestore_1.Timestamp.fromDate(now),
            src: 'server',
            name,
            props: sanitizeProps(props),
            context,
            sessionId: 'server_' + now.getTime(),
        };
        await db.collection('analyticsEvents').add(event);
        v2_1.logger.info('📊 ANALYTICS: Server event logged', { name, uid, role });
    }
    catch (error) {
        v2_1.logger.error('❌ ANALYTICS: Error logging server event', { error, name });
    }
}
function sanitizeProps(props) {
    const sanitized = {};
    const allowedKeys = new Set([
        'amountEur',
        'amountNet',
        'rating',
        'disputeReason',
        'disputeOutcome',
        'adminFlag',
        'exportKind',
        'pushType',
        'transferType',
        'jobType',
        'servicesCount',
        'sizeM2',
    ]);
    for (const [key, value] of Object.entries(props)) {
        if (!allowedKeys.has(key)) {
            continue;
        }
        if (typeof value === 'string') {
            if (value.length <= 120 && !containsPII(value)) {
                sanitized[key] = value;
            }
        }
        else if (typeof value === 'number' || typeof value === 'boolean') {
            sanitized[key] = value;
        }
        else if (value === null || value === undefined) {
            sanitized[key] = null;
        }
    }
    return sanitized;
}
function containsPII(value) {
    const lowerValue = value.toLowerCase();
    if (/^[^@]+@[^@]+\.[^@]+$/.test(value)) {
        return true;
    }
    if (/^\+?[\d\s\-()]{10,}$/.test(value.replace(/\s/g, ''))) {
        return true;
    }
    const piiKeywords = ['email', 'phone', 'address', 'name', 'street', 'city'];
    for (const keyword of piiKeywords) {
        if (lowerValue.includes(keyword)) {
            return true;
        }
    }
    return false;
}
async function logPaymentEvent(eventName, { uid, role, amountEur, request, }) {
    await logServerEvent({
        uid,
        role,
        name: eventName,
        props: { amountEur },
        request,
    });
}
async function logDisputeEvent(eventName, { uid, role, reason, outcome, amountEur, request, }) {
    await logServerEvent({
        uid,
        role,
        name: eventName,
        props: {
            ...(reason && { disputeReason: reason }),
            ...(outcome && { disputeOutcome: outcome }),
            ...(amountEur && { amountEur }),
        },
        request,
    });
}
async function logTransferEvent({ uid, role, amountNet, request, }) {
    await logServerEvent({
        uid,
        role,
        name: 'transfer_created',
        props: { amountNet },
        request,
    });
}
async function logAdminEvent(eventName, { uid, flag, exportKind, request, }) {
    await logServerEvent({
        uid,
        role: 'admin',
        name: eventName,
        props: {
            ...(flag && { adminFlag: flag }),
            ...(exportKind && { exportKind }),
        },
        request,
    });
}
async function logPushEvent(eventName, { uid, role, pushType, request, }) {
    await logServerEvent({
        uid,
        role,
        name: eventName,
        props: { ...(pushType && { pushType }) },
        request,
    });
}
//# sourceMappingURL=helpers.js.map