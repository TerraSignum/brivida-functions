"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyDisputeResponse = exports.notifyDisputeOpened = exports.send1hReminders = exports.send24hReminders = exports.notifyChatMessage = exports.notifyPaymentReleased = exports.notifyPaymentCaptured = exports.notifyJobChanged = exports.notifyJobAssigned = exports.notifyLeadStatusChanged = exports.notifyLeadCreated = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firebase_functions_1 = require("firebase-functions");
const app_1 = require("firebase-admin/app");
const firestore_2 = require("firebase-admin/firestore");
const messaging_1 = require("firebase-admin/messaging");
const location_1 = require("./lib/location");
const notification_localization_1 = require("./lib/notification_localization");
(0, app_1.initializeApp)();
const db = (0, firestore_2.getFirestore)();
const messaging = (0, messaging_1.getMessaging)();
const NotificationType = {
    LEAD_NEW: 'lead_new',
    LEAD_ACCEPTED: 'lead_accepted',
    LEAD_DECLINED: 'lead_declined',
    JOB_ASSIGNED: 'job_assigned',
    JOB_CHANGED: 'job_changed',
    JOB_CANCELLED: 'job_cancelled',
    REMINDER_24H: 'reminder_24h',
    REMINDER_1H: 'reminder_1h',
    PAYMENT_CAPTURED: 'payment_captured',
    PAYMENT_RELEASED: 'payment_released',
    PAYMENT_REFUNDED: 'payment_refunded',
    DISPUTE_OPENED: 'dispute_opened',
    DISPUTE_RESPONSE: 'dispute_response',
    DISPUTE_DECISION: 'dispute_decision',
    CHAT_MESSAGE: 'chat_message',
};
async function createNotification(uid, type, templateKey, templateParams = {}, deeplinkRoute, relatedId, overrides) {
    var _a, _b;
    try {
        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            firebase_functions_1.logger.warn(`User ${uid} not found for notification`);
            return;
        }
        const userData = userDoc.data();
        const fcmToken = userData === null || userData === void 0 ? void 0 : userData.fcmToken;
        const preferences = (userData === null || userData === void 0 ? void 0 : userData.notificationPreferences) || {};
        if (!isNotificationEnabled(type, preferences)) {
            firebase_functions_1.logger.info(`Notification ${type} disabled for user ${uid}`);
            return;
        }
        const userLocale = resolveUserLocale(userData);
        const message = (0, notification_localization_1.getNotificationMessage)(userLocale, templateKey, templateParams);
        const title = (_a = overrides === null || overrides === void 0 ? void 0 : overrides.title) !== null && _a !== void 0 ? _a : message.title;
        const body = (_b = overrides === null || overrides === void 0 ? void 0 : overrides.body) !== null && _b !== void 0 ? _b : message.body;
        if (isQuietTime(preferences.quietHours)) {
            firebase_functions_1.logger.info(`Quiet time active for user ${uid}, skipping push notification`);
        }
        const notificationData = {
            uid,
            type,
            title,
            body,
            read: false,
            createdAt: new Date(),
            deeplinkRoute: deeplinkRoute || null,
            relatedId: relatedId || null,
            locale: message.locale,
            titleKey: message.titleKey,
            bodyKey: message.bodyKey,
            placeholders: message.params,
            templateKey,
        };
        const notificationRef = await db.collection('notifications').add(notificationData);
        firebase_functions_1.logger.info(`Created notification ${notificationRef.id} for user ${uid}`);
        if (fcmToken && !isQuietTime(preferences.quietHours)) {
            await sendPushNotification(fcmToken, {
                title,
                body,
                type,
                deeplinkRoute,
                relatedId,
                templateKey,
                titleKey: message.titleKey,
                bodyKey: message.bodyKey,
                locale: message.locale,
                placeholders: message.params,
            });
        }
    }
    catch (error) {
        firebase_functions_1.logger.error('Error creating notification:', error);
    }
}
function isNotificationEnabled(type, preferences) {
    if (!preferences)
        return true;
    switch (type) {
        case NotificationType.LEAD_NEW:
            return preferences.leadNew !== false;
        case NotificationType.LEAD_ACCEPTED:
        case NotificationType.LEAD_DECLINED:
            return preferences.leadStatus !== false;
        case NotificationType.JOB_ASSIGNED:
        case NotificationType.JOB_CHANGED:
        case NotificationType.JOB_CANCELLED:
            return preferences.jobAssigned !== false;
        case NotificationType.REMINDER_24H:
            return preferences.jobReminder24h !== false;
        case NotificationType.REMINDER_1H:
            return preferences.jobReminder1h !== false;
        case NotificationType.PAYMENT_CAPTURED:
        case NotificationType.PAYMENT_RELEASED:
        case NotificationType.PAYMENT_REFUNDED:
            return preferences.payment !== false;
        case NotificationType.DISPUTE_OPENED:
        case NotificationType.DISPUTE_RESPONSE:
        case NotificationType.DISPUTE_DECISION:
            return preferences.dispute !== false;
        case NotificationType.CHAT_MESSAGE:
            return true;
        default:
            return true;
    }
}
function isQuietTime(quietHours) {
    if (!quietHours)
        return false;
    const now = new Date();
    const currentTime = now.toLocaleTimeString('pt-PT', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: quietHours.timezone || 'Atlantic/Madeira'
    });
    const startTime = quietHours.start || '22:00';
    const endTime = quietHours.end || '07:00';
    if (startTime > endTime) {
        return currentTime >= startTime || currentTime <= endTime;
    }
    else {
        return currentTime >= startTime && currentTime <= endTime;
    }
}
async function sendPushNotification(fcmToken, payload) {
    try {
        const message = {
            token: fcmToken,
            notification: {
                title: payload.title,
                body: payload.body,
            },
            data: {
                type: payload.type,
                route: payload.deeplinkRoute || '',
                related_id: payload.relatedId || '',
                template_key: payload.templateKey,
                title_key: payload.titleKey,
                body_key: payload.bodyKey,
                locale: payload.locale,
                placeholders: JSON.stringify(payload.placeholders || {}),
            },
            android: {
                notification: {
                    icon: 'notification_icon',
                    color: '#1976D2',
                    sound: 'default',
                },
            },
            apns: {
                payload: {
                    aps: {
                        sound: 'default',
                        badge: 1,
                    },
                },
            },
        };
        const response = await messaging.send(message);
        firebase_functions_1.logger.info(`Push notification sent successfully: ${response}`);
    }
    catch (error) {
        firebase_functions_1.logger.error('Error sending push notification:', error);
    }
}
exports.notifyLeadCreated = (0, firestore_1.onDocumentCreated)({
    document: 'leads/{leadId}',
    region: 'europe-west1',
    secrets: [location_1.GOOGLE_API_KEY_SECRET],
    timeoutSeconds: 120,
}, async (event) => {
    var _a;
    const lead = (_a = event.data) === null || _a === void 0 ? void 0 : _a.data();
    if (!lead) {
        return;
    }
    const leadId = event.params.leadId;
    const context = await resolveLeadContext(leadId, lead);
    if (!context) {
        return;
    }
    try {
        const proProfiles = await db
            .collection('proProfiles')
            .where('services', 'array-contains-any', context.services)
            .where('active', '==', true)
            .limit(25)
            .get();
        const googleKey = (0, location_1.resolveGoogleApiKey)();
        const canUseGoogle = typeof googleKey === 'string' && googleKey.trim().length > 0;
        let notifiedCount = 0;
        for (const proDoc of proProfiles.docs) {
            const notified = await notifyProCandidateForLead({
                leadId,
                lead,
                proDoc,
                context,
                canUseGoogle,
            });
            if (notified) {
                notifiedCount++;
            }
        }
        firebase_functions_1.logger.info('Lead notifications processed', {
            leadId,
            jobId: context.jobId,
            evaluatedPros: proProfiles.size,
            notifiedPros: notifiedCount,
        });
    }
    catch (error) {
        firebase_functions_1.logger.error('Error notifying about new lead', { error, leadId, jobId: context.jobId });
    }
});
exports.notifyLeadStatusChanged = (0, firestore_1.onDocumentUpdated)('leads/{leadId}', async (event) => {
    var _a, _b;
    const beforeData = (_a = event.data) === null || _a === void 0 ? void 0 : _a.before.data();
    const afterData = (_b = event.data) === null || _b === void 0 ? void 0 : _b.after.data();
    if (!beforeData || !afterData)
        return;
    const leadId = event.params.leadId;
    const statusChanged = beforeData.status !== afterData.status;
    if (!statusChanged)
        return;
    const customerId = afterData.customerId;
    switch (afterData.status) {
        case 'accepted':
            if (customerId) {
                await createNotification(customerId, NotificationType.LEAD_ACCEPTED, 'lead.accepted', {}, `/leads/detail?id=${leadId}`, leadId);
            }
            break;
        case 'declined':
            if (customerId) {
                await createNotification(customerId, NotificationType.LEAD_DECLINED, 'lead.declined', {}, `/leads/detail?id=${leadId}`, leadId);
            }
            break;
    }
});
exports.notifyJobAssigned = (0, firestore_1.onDocumentCreated)('jobs/{jobId}', async (event) => {
    var _a;
    const job = (_a = event.data) === null || _a === void 0 ? void 0 : _a.data();
    if (!job)
        return;
    const jobId = event.params.jobId;
    const customerId = job.customerId;
    const proId = job.proId;
    if (customerId) {
        await createNotification(customerId, NotificationType.JOB_ASSIGNED, 'job.assigned.customer', {
            date: (locale) => formatDateInput(job.scheduledDateTime || job.scheduledDate || job.startDate, locale),
        }, `/jobs/detail?id=${jobId}`, jobId);
    }
    if (proId) {
        await createNotification(proId, NotificationType.JOB_ASSIGNED, 'job.assigned.pro', {
            date: (locale) => formatDateInput(job.scheduledDateTime || job.scheduledDate || job.startDate, locale),
        }, `/jobs/detail?id=${jobId}`, jobId);
    }
});
exports.notifyJobChanged = (0, firestore_1.onDocumentUpdated)('jobs/{jobId}', async (event) => {
    var _a, _b;
    const beforeData = (_a = event.data) === null || _a === void 0 ? void 0 : _a.before.data();
    const afterData = (_b = event.data) === null || _b === void 0 ? void 0 : _b.after.data();
    if (!beforeData || !afterData)
        return;
    const jobId = event.params.jobId;
    const customerId = afterData.customerId;
    const proId = afterData.proId;
    const dateChanged = beforeData.scheduledDate !== afterData.scheduledDate;
    const statusChanged = beforeData.status !== afterData.status;
    const addressChanged = beforeData.address !== afterData.address;
    if (dateChanged || statusChanged || addressChanged) {
        const changeKeys = getJobChangeKeys(beforeData, afterData);
        const templateParams = {
            changes: (locale) => (0, notification_localization_1.formatJobChanges)(locale, changeKeys),
        };
        if (customerId) {
            await createNotification(customerId, NotificationType.JOB_CHANGED, 'job.changed', templateParams, `/jobs/detail?id=${jobId}`, jobId);
        }
        if (proId) {
            await createNotification(proId, NotificationType.JOB_CHANGED, 'job.changed', templateParams, `/jobs/detail?id=${jobId}`, jobId);
        }
    }
    if (afterData.status === 'cancelled' && beforeData.status !== 'cancelled') {
        if (customerId) {
            await createNotification(customerId, NotificationType.JOB_CANCELLED, 'job.cancelled', {}, `/jobs/detail?id=${jobId}`, jobId);
        }
        if (proId) {
            await createNotification(proId, NotificationType.JOB_CANCELLED, 'job.cancelled', {}, `/jobs/detail?id=${jobId}`, jobId);
        }
    }
});
function extractLatLng(source) {
    var _a, _b;
    if (!source) {
        return null;
    }
    if (source instanceof firestore_2.GeoPoint) {
        return { lat: source.latitude, lng: source.longitude };
    }
    if (typeof source === 'object') {
        const value = source;
        const latCandidate = ((_a = value.lat) !== null && _a !== void 0 ? _a : value.latitude);
        const lngCandidate = ((_b = value.lng) !== null && _b !== void 0 ? _b : value.longitude);
        if (typeof latCandidate === 'number' && typeof lngCandidate === 'number') {
            return { lat: latCandidate, lng: lngCandidate };
        }
    }
    return null;
}
function normalizeServiceList(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter((item) => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim());
}
function resolveLeadServices(lead, jobData) {
    const leadServices = normalizeServiceList(lead.services);
    if (leadServices.length > 0) {
        return leadServices;
    }
    const jobServices = normalizeServiceList(jobData.services);
    if (jobServices.length > 0) {
        return jobServices;
    }
    return null;
}
async function resolveLeadContext(leadId, lead) {
    var _a, _b, _c, _d;
    const jobId = typeof lead.jobId === 'string' ? lead.jobId : undefined;
    if (!jobId) {
        firebase_functions_1.logger.warn('Lead created without jobId, skipping notifications', { leadId });
        return null;
    }
    try {
        const jobDoc = await db.collection('jobs').doc(jobId).get();
        if (!jobDoc.exists) {
            firebase_functions_1.logger.warn('Job not found for lead, skipping notifications', { leadId, jobId });
            return null;
        }
        const jobData = (_a = jobDoc.data()) !== null && _a !== void 0 ? _a : {};
        const jobPrivateDoc = await db.collection('jobsPrivate').doc(jobId).get();
        const jobPrivateData = (_b = jobPrivateDoc.data()) !== null && _b !== void 0 ? _b : {};
        const jobLocation = extractLatLng(jobPrivateData.location) ||
            extractLatLng((_c = jobData.location) === null || _c === void 0 ? void 0 : _c.coordinates) ||
            extractLatLng(jobData.location);
        if (!jobLocation) {
            firebase_functions_1.logger.warn('Job location missing, skipping lead notifications', { leadId, jobId });
            return null;
        }
        const services = resolveLeadServices(lead, jobData);
        if (!services) {
            firebase_functions_1.logger.warn('Lead created without services, skipping notifications', { leadId, jobId });
            return null;
        }
        const city = jobData.addressCity || jobPrivateData.city || ((_d = lead.location) === null || _d === void 0 ? void 0 : _d.city);
        return {
            jobId,
            location: jobLocation,
            city,
            services,
        };
    }
    catch (error) {
        firebase_functions_1.logger.error('Failed to resolve lead context', { error, leadId, jobId });
        return null;
    }
}
function resolveRadiusKm(proData) {
    const candidates = [
        proData.radius,
        proData.serviceRadius,
        proData.serviceRadiusKm,
        proData.radiusKm,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
            return candidate;
        }
    }
    return 25;
}
async function resolveDistanceKm(proLocation, jobLocation, context) {
    let distanceKm;
    let source = 'haversine';
    if (context.canUseGoogle) {
        try {
            const eta = await (0, location_1.calculateEta)(proLocation.lat, proLocation.lng, jobLocation.lat, jobLocation.lng);
            if (typeof eta.distanceValue === 'number' && Number.isFinite(eta.distanceValue)) {
                distanceKm = eta.distanceValue / 1000;
                source = 'google';
            }
        }
        catch (error) {
            firebase_functions_1.logger.warn('Distance Matrix lookup failed, using fallback distance', {
                leadId: context.leadId,
                proUid: context.proUid,
                error,
            });
        }
    }
    distanceKm !== null && distanceKm !== void 0 ? distanceKm : (distanceKm = calculateHaversineDistance(proLocation, jobLocation));
    if (!Number.isFinite(distanceKm)) {
        firebase_functions_1.logger.warn('Calculated distance is invalid, skipping pro', {
            leadId: context.leadId,
            proUid: context.proUid,
        });
        return null;
    }
    return { distanceKm, source };
}
async function notifyProCandidateForLead(params) {
    var _a, _b, _c;
    const { leadId, lead, proDoc, context, canUseGoogle } = params;
    const proData = (_a = proDoc.data()) !== null && _a !== void 0 ? _a : {};
    const proUid = proDoc.id;
    const proLocation = extractLatLng(proData.location);
    if (!proLocation) {
        firebase_functions_1.logger.debug('Skipping pro without location', { leadId, proUid });
        return false;
    }
    const serviceRadiusKm = resolveRadiusKm(proData);
    const distanceResult = await resolveDistanceKm(proLocation, context.location, {
        canUseGoogle,
        leadId,
        proUid,
    });
    if (!distanceResult) {
        return false;
    }
    const { distanceKm, source } = distanceResult;
    if (distanceKm > serviceRadiusKm) {
        firebase_functions_1.logger.debug('Pro outside service radius', {
            leadId,
            proUid,
            distanceKm: Math.round(distanceKm * 10) / 10,
            serviceRadiusKm,
            distanceSource: source,
        });
        return false;
    }
    await createNotification(proUid, NotificationType.LEAD_NEW, 'lead.new', {
        city: buildCityParam((_b = context.city) !== null && _b !== void 0 ? _b : (_c = lead.location) === null || _c === void 0 ? void 0 : _c.city),
    }, `/leads/detail?id=${leadId}`, leadId);
    return true;
}
function calculateHaversineDistance(origin, destination) {
    const earthRadiusKm = 6371;
    const dLat = degToRad(destination.lat - origin.lat);
    const dLng = degToRad(destination.lng - origin.lng);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(degToRad(origin.lat)) * Math.cos(degToRad(destination.lat)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusKm * c;
}
function degToRad(value) {
    return value * (Math.PI / 180);
}
exports.notifyPaymentCaptured = (0, firestore_1.onDocumentCreated)('payments/{paymentId}', async (event) => {
    var _a;
    const payment = (_a = event.data) === null || _a === void 0 ? void 0 : _a.data();
    if (!payment)
        return;
    const paymentId = event.params.paymentId;
    const customerId = payment.customerId;
    const amountRaw = typeof payment.amount === 'number' ? payment.amount : 0;
    const amount = amountRaw / 100;
    if (customerId) {
        await createNotification(customerId, NotificationType.PAYMENT_CAPTURED, 'payment.captured', {
            amountNumeric: amount,
        }, '/payments', paymentId);
    }
});
exports.notifyPaymentReleased = (0, firestore_1.onDocumentUpdated)('payments/{paymentId}', async (event) => {
    var _a, _b;
    const beforeData = (_a = event.data) === null || _a === void 0 ? void 0 : _a.before.data();
    const afterData = (_b = event.data) === null || _b === void 0 ? void 0 : _b.after.data();
    if (!beforeData || !afterData)
        return;
    const statusChanged = beforeData.status !== afterData.status;
    if (!statusChanged || afterData.status !== 'released')
        return;
    const paymentId = event.params.paymentId;
    const proId = afterData.proId;
    const amountRaw = typeof afterData.amount === 'number' ? afterData.amount : 0;
    const amount = amountRaw / 100;
    if (proId) {
        await createNotification(proId, NotificationType.PAYMENT_RELEASED, 'payment.released', {
            amountNumeric: amount,
        }, '/payments', paymentId);
    }
});
exports.notifyChatMessage = (0, firestore_1.onDocumentCreated)('chats/{chatId}/messages/{messageId}', async (event) => {
    var _a;
    const message = (_a = event.data) === null || _a === void 0 ? void 0 : _a.data();
    if (!message)
        return;
    const chatId = event.params.chatId;
    const senderId = message.senderId;
    const chatDoc = await db.collection('chats').doc(chatId).get();
    if (!chatDoc.exists)
        return;
    const chatData = chatDoc.data();
    const participants = (chatData === null || chatData === void 0 ? void 0 : chatData.participants) || [];
    for (const participantId of participants) {
        if (participantId !== senderId) {
            const preview = getMessagePreview(message.text);
            await createNotification(participantId, NotificationType.CHAT_MESSAGE, 'chat.newMessage', preview ? { preview } : {}, `/chat?id=${chatId}`, chatId, preview ? { body: preview } : undefined);
        }
    }
});
exports.send24hReminders = (0, scheduler_1.onSchedule)('0 9 * * *', async () => {
    firebase_functions_1.logger.info('Running 24-hour reminder job');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const dayAfter = new Date(tomorrow);
    dayAfter.setDate(dayAfter.getDate() + 1);
    const jobsQuery = db.collection('jobs')
        .where('scheduledDate', '>=', tomorrow)
        .where('scheduledDate', '<', dayAfter)
        .where('status', '==', 'confirmed');
    const jobsSnapshot = await jobsQuery.get();
    for (const jobDoc of jobsSnapshot.docs) {
        const job = jobDoc.data();
        const jobId = jobDoc.id;
        if (job.customerId) {
            await createNotification(job.customerId, NotificationType.REMINDER_24H, 'job.reminder24h.customer', {
                time: (locale) => formatTimeInput(job.scheduledTime || job.scheduledDateTime, locale),
            }, `/jobs/detail?id=${jobId}`, jobId);
        }
        if (job.proId) {
            await createNotification(job.proId, NotificationType.REMINDER_24H, 'job.reminder24h.pro', {
                time: (locale) => formatTimeInput(job.scheduledTime || job.scheduledDateTime, locale),
            }, `/jobs/detail?id=${jobId}`, jobId);
        }
    }
    firebase_functions_1.logger.info(`Sent 24h reminders for ${jobsSnapshot.size} jobs`);
});
exports.send1hReminders = (0, scheduler_1.onSchedule)('0 * * * *', async () => {
    firebase_functions_1.logger.info('Running 1-hour reminder job');
    const now = new Date();
    const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);
    const jobsQuery = db.collection('jobs')
        .where('scheduledDateTime', '>=', now)
        .where('scheduledDateTime', '<=', oneHourLater)
        .where('status', '==', 'confirmed');
    const jobsSnapshot = await jobsQuery.get();
    for (const jobDoc of jobsSnapshot.docs) {
        const job = jobDoc.data();
        const jobId = jobDoc.id;
        if (job.customerId) {
            await createNotification(job.customerId, NotificationType.REMINDER_1H, 'job.reminder1h.customer', {}, `/jobs/detail?id=${jobId}`, jobId);
        }
        if (job.proId) {
            await createNotification(job.proId, NotificationType.REMINDER_1H, 'job.reminder1h.pro', {}, `/jobs/detail?id=${jobId}`, jobId);
        }
    }
    firebase_functions_1.logger.info(`Sent 1h reminders for ${jobsSnapshot.size} jobs`);
});
exports.notifyDisputeOpened = (0, firestore_1.onDocumentCreated)('disputes/{disputeId}', async (event) => {
    var _a;
    const dispute = (_a = event.data) === null || _a === void 0 ? void 0 : _a.data();
    if (!dispute)
        return;
    const disputeId = event.params.disputeId;
    const customerId = dispute.customerId;
    const proId = dispute.proId;
    const openedBy = dispute.openedBy;
    const otherPartyId = openedBy === customerId ? proId : customerId;
    if (otherPartyId) {
        await createNotification(otherPartyId, NotificationType.DISPUTE_OPENED, 'dispute.opened', {}, `/disputes/detail?id=${disputeId}`, disputeId);
    }
});
exports.notifyDisputeResponse = (0, firestore_1.onDocumentUpdated)('disputes/{disputeId}', async (event) => {
    var _a, _b, _c, _d;
    const beforeData = (_a = event.data) === null || _a === void 0 ? void 0 : _a.before.data();
    const afterData = (_b = event.data) === null || _b === void 0 ? void 0 : _b.after.data();
    if (!beforeData || !afterData)
        return;
    const beforeResponses = ((_c = beforeData.responses) === null || _c === void 0 ? void 0 : _c.length) || 0;
    const afterResponses = ((_d = afterData.responses) === null || _d === void 0 ? void 0 : _d.length) || 0;
    if (afterResponses <= beforeResponses)
        return;
    const disputeId = event.params.disputeId;
    const customerId = afterData.customerId;
    const proId = afterData.proId;
    const lastResponse = afterData.responses[afterResponses - 1];
    const responderType = lastResponse.responderType;
    const otherPartyId = responderType === 'customer' ? proId : customerId;
    if (otherPartyId) {
        await createNotification(otherPartyId, NotificationType.DISPUTE_RESPONSE, 'dispute.response', {}, `/disputes/detail?id=${disputeId}`, disputeId);
    }
});
firebase_functions_1.logger.info('✅ Notification Cloud Functions loaded successfully');
function resolveUserLocale(userData) {
    var _a, _b;
    if (!userData || typeof userData !== 'object') {
        return undefined;
    }
    const candidates = [
        userData.locale,
        userData.preferredLocale,
        (_a = userData.settings) === null || _a === void 0 ? void 0 : _a.locale,
        (_b = userData.profile) === null || _b === void 0 ? void 0 : _b.locale,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }
    return undefined;
}
function fallbackCityLabel(locale) {
    var _a;
    const map = {
        de: 'Ihrer Nähe',
        en: 'your area',
        es: 'tu zona',
        fr: 'votre secteur',
        pt: 'sua região',
    };
    return (_a = map[locale]) !== null && _a !== void 0 ? _a : map.en;
}
function buildCityParam(cityValue) {
    return (locale) => {
        if (typeof cityValue === 'string' && cityValue.trim().length > 0) {
            return cityValue.trim();
        }
        return fallbackCityLabel(locale);
    };
}
function formatDateInput(value, locale) {
    const date = convertToDate(value);
    if (date) {
        try {
            return new Intl.DateTimeFormat(locale, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
            }).format(date);
        }
        catch (error) {
            firebase_functions_1.logger.warn('Date formatting failed, using ISO fallback', { error });
            return date.toISOString();
        }
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
    }
    return fallbackDateLabel(locale);
}
function formatTimeInput(value, locale) {
    if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
    }
    const date = convertToDate(value);
    if (date) {
        try {
            return new Intl.DateTimeFormat(locale, {
                hour: '2-digit',
                minute: '2-digit',
            }).format(date);
        }
        catch (error) {
            firebase_functions_1.logger.warn('Time formatting failed, using ISO substring', { error });
            return date.toISOString();
        }
    }
    return fallbackTimeLabel(locale);
}
function convertToDate(value) {
    if (!value) {
        return null;
    }
    if (value instanceof Date) {
        return value;
    }
    if (value instanceof firestore_2.Timestamp) {
        return value.toDate();
    }
    if (typeof value === 'object' && 'seconds' in value) {
        const seconds = value.seconds;
        if (typeof seconds === 'number') {
            return new Date(seconds * 1000);
        }
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return new Date(value);
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) {
            return new Date(parsed);
        }
    }
    return null;
}
function fallbackDateLabel(locale) {
    var _a;
    const map = {
        de: 'Termin folgt',
        en: 'Date to be confirmed',
        es: 'Fecha por confirmar',
        fr: 'Date à confirmer',
        pt: 'Data a confirmar',
    };
    return (_a = map[locale]) !== null && _a !== void 0 ? _a : map.en;
}
function fallbackTimeLabel(locale) {
    var _a;
    const map = {
        de: 'Zeit folgt',
        en: 'Time to be confirmed',
        es: 'Hora por confirmar',
        fr: 'Heure à confirmer',
        pt: 'Horário a confirmar',
    };
    return (_a = map[locale]) !== null && _a !== void 0 ? _a : map.en;
}
function getMessagePreview(text) {
    if (typeof text !== 'string' || text.trim().length === 0) {
        return undefined;
    }
    const trimmed = text.trim();
    if (trimmed.length <= 120) {
        return trimmed;
    }
    return `${trimmed.slice(0, 117)}...`;
}
function getJobChangeKeys(beforeData, afterData) {
    var _a, _b, _c, _d;
    const changes = [];
    if (((_a = beforeData.scheduledDate) === null || _a === void 0 ? void 0 : _a.toString()) !== ((_b = afterData.scheduledDate) === null || _b === void 0 ? void 0 : _b.toString())) {
        changes.push('date');
    }
    if (((_c = beforeData.address) === null || _c === void 0 ? void 0 : _c.toString()) !== ((_d = afterData.address) === null || _d === void 0 ? void 0 : _d.toString())) {
        changes.push('address');
    }
    if (beforeData.status !== afterData.status) {
        changes.push('status');
    }
    return changes;
}
//# sourceMappingURL=notifications.js.map