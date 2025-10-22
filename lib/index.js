"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPaymentIntentCF = exports.cleanupJobLiveLocationsCF = exports.triggerLiveLocationCleanupCF = exports.cleanupLiveLocations = exports.refreshJobGeocodeCF = exports.getEtaCF = exports.setJobAddressCF = exports.updateRetentionConfigCF = exports.triggerDataRetentionCF = exports.dataRetentionCleanup = exports.exportAnalyticsCsv = exports.aggregateDaily = exports.getProRatingAggregateCF = exports.hasReviewedJobCF = exports.moderateReviewCF = exports.submitReviewCF = exports.updateLegalVersionsCF = exports.getLegalStatsCF = exports.getUserConsentCF = exports.setUserConsentCF = exports.getLegalDocCF = exports.publishLegalDocCF = exports.exportMyTransfersCsvCF = exports.exportCsvCF = exports.recalcHealthNightlyCF = exports.recalcHealthCF = exports.removeBadgeCF = exports.addBadgeCF = exports.setFlagsCF = exports.remindModerationCF = exports.expireDisputesCF = exports.resolveDisputeCF = exports.addEvidenceCF = exports.openDisputeCF = exports.stripeWebhook = exports.partialRefund = exports.releaseTransfer = exports.createConnectOnboarding = exports.createPaymentIntent = exports.autoReleaseEscrow = exports.sendTestPush = exports.calendarIcs = exports.deleteAccount = exports.reserveUsername = exports.ensureIcsToken = exports.eta = exports.onMessageCreated = exports.createJobWithMatchingCF = exports.declineLeadCF = exports.acceptLeadCF = void 0;
exports.updateAdminServiceStatus = exports.handleAdminServiceWebhook = exports.createAdminServiceCheckout = exports.getAdvancedMetricsCF = exports.getKpiSummaryCF = exports.getDocumentStatsCF = exports.getPendingDocumentsCF = exports.reviewDocumentCF = exports.notifyExpressJobsCF = exports.generateRecurringJobsCF = void 0;
const app_1 = require("firebase-admin/app");
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/v2/https");
const firestore_2 = require("firebase-functions/v2/firestore");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const v2_1 = require("firebase-functions/v2");
const leads_1 = require("./lib/leads");
const matching_1 = require("./lib/matching");
const chat_1 = require("./lib/chat");
const notifications_1 = require("./lib/notifications");
const eta_1 = require("./lib/eta");
const calendar_1 = require("./lib/calendar");
const firestore_3 = require("./lib/firestore");
const stripeService = __importStar(require("./lib/stripe"));
const disputes_1 = require("./lib/disputes");
const health_1 = require("./lib/health");
const exports_1 = require("./lib/exports");
const legal_1 = require("./lib/legal");
const reviews_1 = require("./lib/reviews");
const kpi_1 = require("./lib/kpi");
const documents_1 = require("./lib/documents");
const retention_1 = require("./lib/retention");
const users_1 = require("./lib/users");
const auth_1 = require("./lib/auth");
const helpers_1 = require("./analytics/helpers");
const payments_1 = require("./lib/payments");
(0, app_1.initializeApp)();
const region = 'europe-west1';
exports.acceptLeadCF = (0, https_1.onCall)({ region }, async (request) => {
    var _a;
    const { auth, data } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const { leadId } = data;
    if (!leadId || typeof leadId !== 'string') {
        throw new https_1.HttpsError('invalid-argument', 'leadId is required and must be a string');
    }
    try {
        const result = await leads_1.leadsService.acceptLead({
            leadId,
            userId: auth.uid,
        });
        await (0, helpers_1.logServerEvent)({
            uid: auth.uid,
            role: ((_a = auth.token) === null || _a === void 0 ? void 0 : _a.role) || 'pro',
            name: 'lead_accepted',
            props: {
                leadId,
                jobId: result.jobId,
            },
        });
        return { success: true, ...result };
    }
    catch (error) {
        v2_1.logger.error('Error in acceptLeadCF:', error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to accept lead');
    }
});
exports.declineLeadCF = (0, https_1.onCall)({ region }, async (request) => {
    const { auth, data } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const { leadId } = data;
    if (!leadId || typeof leadId !== 'string') {
        throw new https_1.HttpsError('invalid-argument', 'leadId is required and must be a string');
    }
    try {
        const result = await leads_1.leadsService.declineLead({
            leadId,
            userId: auth.uid,
        });
        return { success: true, ...result };
    }
    catch (error) {
        v2_1.logger.error('Error in declineLeadCF:', error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to decline lead');
    }
});
exports.createJobWithMatchingCF = (0, https_1.onCall)({ region }, async (request) => {
    const { auth, data } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const { jobId, title, services, location, preferredDate, duration, budget } = data;
    if (!jobId || !title || !services || !location || !preferredDate || !duration || !budget) {
        throw new https_1.HttpsError('invalid-argument', 'Missing required job fields');
    }
    if (!Array.isArray(services) || services.length === 0) {
        throw new https_1.HttpsError('invalid-argument', 'Services must be a non-empty array');
    }
    if (!location.address || !location.coordinates) {
        throw new https_1.HttpsError('invalid-argument', 'Location must include address and coordinates');
    }
    try {
        const jobData = {
            id: jobId,
            customerUid: auth.uid,
            title,
            services,
            location: {
                address: location.address,
                coordinates: location.coordinates,
            },
            preferredDate: new Date(preferredDate),
            duration,
            budget,
            status: 'open',
        };
        const result = await matching_1.matchingService.createJobWithLeads(jobData);
        return {
            success: true,
            jobId: result.jobId,
            leadsCreated: result.leadsCreated,
            message: `Job created successfully with ${result.leadsCreated} leads generated`
        };
    }
    catch (error) {
        v2_1.logger.error('Error in createJobWithMatchingCF:', error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to create job with matching');
    }
});
exports.onMessageCreated = (0, firestore_2.onDocumentCreated)({ document: 'chats/{chatId}/messages/{messageId}', region }, async (event) => {
    var _a, _b, _c;
    try {
        const messageData = (_a = event.data) === null || _a === void 0 ? void 0 : _a.data();
        const chatId = event.params.chatId;
        const messageId = event.params.messageId;
        if (!messageData) {
            v2_1.logger.error('No message data found');
            return;
        }
        v2_1.logger.info(`Processing new message ${messageId} in chat ${chatId}`);
        await chat_1.chatService.updateLastMessageTime(chatId);
        const chatDoc = await ((_c = (_b = event.data) === null || _b === void 0 ? void 0 : _b.ref.parent.parent) === null || _c === void 0 ? void 0 : _c.get());
        if (!(chatDoc === null || chatDoc === void 0 ? void 0 : chatDoc.exists)) {
            v2_1.logger.error(`Chat ${chatId} not found`);
            return;
        }
        const chatData = chatDoc.data();
        if (!(chatData === null || chatData === void 0 ? void 0 : chatData.members) || !Array.isArray(chatData.members)) {
            v2_1.logger.error(`Invalid chat members for chat ${chatId}`);
            return;
        }
        const senderUid = messageData.senderUid;
        const recipients = chatData.members.filter((uid) => uid !== senderUid);
        if (recipients.length === 0) {
            v2_1.logger.warn(`No recipients found for chat ${chatId}`);
            return;
        }
        const messageType = messageData.type;
        const notificationTitle = 'New Message';
        let notificationBody = '';
        if (messageType === 'text' && messageData.text) {
            notificationBody = messageData.text.length > 50
                ? messageData.text.substring(0, 50) + '...'
                : messageData.text;
        }
        else if (messageType === 'image') {
            notificationBody = 'Sent an image';
        }
        else {
            notificationBody = 'New message received';
        }
        const notificationPromises = recipients.map((recipientUid) => notifications_1.notificationService.sendPushNotification({
            recipientUid,
            title: notificationTitle,
            body: notificationBody,
            data: {
                type: 'chat_message',
                chatId,
                messageId,
                senderUid,
            },
        }));
        await Promise.allSettled(notificationPromises);
        await (0, helpers_1.logServerEvent)({
            uid: senderUid,
            role: 'unknown',
            name: 'chat_message_sent',
            props: {
                chatId,
                messageId,
                messageType,
                recipientCount: recipients.length,
            },
        });
        v2_1.logger.info(`Processed notifications for message ${messageId} in chat ${chatId}`);
    }
    catch (error) {
        v2_1.logger.error('Error in onMessageCreated:', error);
    }
});
exports.eta = (0, https_1.onCall)({ region, secrets: [eta_1.MAPBOX_TOKEN] }, async (request) => {
    const { auth, data } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const { origin, destination } = data;
    if (!origin || !destination) {
        throw new https_1.HttpsError('invalid-argument', 'origin and destination are required');
    }
    if (!origin.lat || !origin.lng || !destination.lat || !destination.lng) {
        throw new https_1.HttpsError('invalid-argument', 'origin and destination must have lat and lng properties');
    }
    try {
        const result = await eta_1.etaService.calculateEta({ origin, destination });
        return result;
    }
    catch (error) {
        v2_1.logger.error('Error in eta function:', error);
        throw new https_1.HttpsError('internal', 'Failed to calculate ETA');
    }
});
exports.ensureIcsToken = (0, https_1.onCall)({ region }, async (request) => {
    const { auth } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    try {
        const token = await calendar_1.calendarService.ensureIcsToken(auth.uid);
        return { token };
    }
    catch (error) {
        v2_1.logger.error('Error in ensureIcsToken:', error);
        throw new https_1.HttpsError('internal', 'Failed to ensure ICS token');
    }
});
exports.reserveUsername = (0, https_1.onCall)({ region }, async (request) => {
    var _a, _b, _c;
    const { auth, data } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const desired = (_a = data === null || data === void 0 ? void 0 : data.desired) === null || _a === void 0 ? void 0 : _a.trim();
    if (!desired) {
        throw new https_1.HttpsError('invalid-argument', 'desired is required');
    }
    try {
        const result = await users_1.usersService.reserveUsername({
            uid: auth.uid,
            desired,
        });
        await (0, helpers_1.logServerEvent)({
            uid: auth.uid,
            role: (_c = (_b = auth.token) === null || _b === void 0 ? void 0 : _b.role) !== null && _c !== void 0 ? _c : 'unknown',
            name: 'username_reserved',
            props: { username: result.username },
        });
        return result;
    }
    catch (error) {
        v2_1.logger.error('Error in reserveUsername callable', { error, uid: auth.uid });
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to reserve username');
    }
});
exports.deleteAccount = (0, https_1.onCall)({ region }, async (request) => {
    var _a, _b;
    const { auth } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    try {
        await users_1.usersService.deleteAccount(auth.uid);
        await (0, helpers_1.logServerEvent)({
            uid: auth.uid,
            role: (_b = (_a = auth.token) === null || _a === void 0 ? void 0 : _a.role) !== null && _b !== void 0 ? _b : 'unknown',
            name: 'account_deleted',
        });
        return { success: true };
    }
    catch (error) {
        v2_1.logger.error('Error in deleteAccount callable', { error, uid: auth.uid });
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to delete account');
    }
});
exports.calendarIcs = (0, https_1.onRequest)({ region }, async (request, response) => {
    try {
        const token = request.query.token;
        if (!token) {
            response.status(400).json({ error: 'Token is required' });
            return;
        }
        const userUid = await calendar_1.calendarService.findUserByIcsToken(token);
        if (!userUid) {
            response.status(404).json({ error: 'Invalid token' });
            return;
        }
        const events = await calendar_1.calendarService.getCalendarEvents(userUid);
        const icsContent = calendar_1.calendarService.generateIcsContent(events);
        const headers = calendar_1.calendarService.getIcsHeaders();
        Object.entries(headers).forEach(([key, value]) => {
            response.setHeader(key, value);
        });
        response.status(200).send(icsContent);
    }
    catch (error) {
        v2_1.logger.error('Error in calendarIcs:', error);
        response.status(500).json({ error: 'Internal server error' });
    }
});
exports.sendTestPush = (0, https_1.onCall)({ region }, async (request) => {
    const { auth, data } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    try {
        const route = (data === null || data === void 0 ? void 0 : data.route) || '/notifications';
        const relatedId = (data === null || data === void 0 ? void 0 : data.relatedId) || 'debug';
        await notifications_1.notificationService.sendPushNotification({
            recipientUid: auth.uid,
            title: 'Brivida Test Push',
            body: 'This is a test notification for deep link validation.',
            data: {
                type: 'debug',
                route,
                related_id: relatedId,
            },
        });
        return { success: true };
    }
    catch (error) {
        v2_1.logger.error('Error in sendTestPush:', error);
        throw new https_1.HttpsError('internal', 'Failed to send test push');
    }
});
var scheduled_1 = require("./lib/scheduled");
Object.defineProperty(exports, "autoReleaseEscrow", { enumerable: true, get: function () { return scheduled_1.autoReleaseEscrow; } });
exports.createPaymentIntent = (0, https_1.onCall)({ region }, payments_1.createPaymentIntentHandler);
exports.createConnectOnboarding = (0, https_1.onCall)({ region }, async (request) => {
    var _a;
    const { auth, data } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const { refreshUrl, returnUrl } = data;
    if (!refreshUrl || !returnUrl) {
        throw new https_1.HttpsError('invalid-argument', 'refreshUrl and returnUrl are required');
    }
    try {
        const userDoc = await firestore_3.firestoreHelpers.collections.users().doc(auth.uid).get();
        let stripeAccountId = (_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.stripeAccountId;
        if (!stripeAccountId) {
            const account = await stripeService.createConnectAccount();
            stripeAccountId = account.id;
            await firestore_3.firestoreHelpers.collections.users().doc(auth.uid).update({
                stripeAccountId,
                updatedAt: new Date(),
            });
        }
        const accountLink = await stripeService.createAccountLink(stripeAccountId, refreshUrl, returnUrl);
        return {
            accountId: stripeAccountId,
            onboardingUrl: accountLink.url,
        };
    }
    catch (error) {
        v2_1.logger.error('Error creating Connect onboarding:', error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to create Connect onboarding');
    }
});
exports.releaseTransfer = (0, https_1.onCall)({ region }, payments_1.releaseTransferHandler);
exports.partialRefund = (0, https_1.onCall)({ region }, payments_1.partialRefundHandler);
exports.stripeWebhook = (0, https_1.onRequest)({ region }, async (request, response) => {
    try {
        const signature = request.headers['stripe-signature'];
        if (!signature) {
            v2_1.logger.error('Missing stripe-signature header');
            response.status(400).send('Missing stripe-signature header');
            return;
        }
        const event = stripeService.verifyWebhookSignature(request.rawBody || request.body, signature);
        v2_1.logger.info('Webhook received', { type: event.type, id: event.id });
        switch (event.type) {
            case 'payment_intent.succeeded':
                await (0, payments_1.handlePaymentIntentSucceeded)(event.data.object);
                break;
            case 'account.updated':
                await handleAccountUpdated(event.data.object);
                break;
            case 'transfer.created':
                await (0, payments_1.handleTransferCreated)(event.data.object);
                break;
            case 'charge.refunded':
                await (0, payments_1.handleChargeRefunded)(event.data.object);
                break;
            default:
                v2_1.logger.info('Unhandled webhook event type', { type: event.type });
        }
        response.status(200).send('ok');
    }
    catch (error) {
        v2_1.logger.error('Webhook error:', error);
        response.status(400).send('Webhook error');
    }
});
async function handleAccountUpdated(account) {
    try {
        const accountId = account.id;
        const usersSnapshot = await firestore_3.firestoreHelpers.collections.users()
            .where('stripeAccountId', '==', accountId)
            .limit(1)
            .get();
        if (usersSnapshot.empty) {
            v2_1.logger.warn('User not found for account update', { accountId });
            return;
        }
        const userDoc = usersSnapshot.docs[0];
        const userData = userDoc.data();
        await userDoc.ref.update({
            stripeAccountChargesEnabled: account.charges_enabled,
            stripeAccountPayoutsEnabled: account.payouts_enabled,
            stripeAccountDetailsSubmitted: account.details_submitted,
            updatedAt: new Date(),
        });
        await (0, helpers_1.logServerEvent)({
            uid: userDoc.id,
            role: (userData === null || userData === void 0 ? void 0 : userData.role) || 'unknown',
            name: 'stripe_account_updated',
            props: {
                accountId,
                chargesEnabled: account.charges_enabled,
                payoutsEnabled: account.payouts_enabled,
                detailsSubmitted: account.details_submitted,
            },
        });
        v2_1.logger.info('User Connect status updated', {
            userId: userDoc.id,
            accountId,
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled
        });
    }
    catch (error) {
        v2_1.logger.error('Error handling account.updated:', error);
    }
}
exports.openDisputeCF = (0, https_1.onCall)({ region }, disputes_1.openDispute);
exports.addEvidenceCF = (0, https_1.onCall)({ region }, disputes_1.addEvidence);
exports.resolveDisputeCF = (0, https_1.onCall)({ region }, disputes_1.resolveDispute);
exports.expireDisputesCF = (0, scheduler_1.onSchedule)({
    region,
    schedule: '0 * * * *',
    timeZone: 'Europe/Berlin'
}, async () => {
    try {
        await (0, disputes_1.expireDisputes)();
    }
    catch (error) {
        v2_1.logger.error('Error in scheduled dispute expiry:', error);
    }
});
exports.remindModerationCF = (0, scheduler_1.onSchedule)({
    region,
    schedule: '0 8,14,20 * * *',
    timeZone: 'Europe/Berlin'
}, async () => {
    try {
        await (0, disputes_1.remindModeration)();
    }
    catch (error) {
        v2_1.logger.error('Error in moderation reminder:', error);
    }
});
exports.setFlagsCF = (0, https_1.onCall)({ region }, health_1.setFlags);
exports.addBadgeCF = (0, https_1.onCall)({ region }, health_1.addBadge);
exports.removeBadgeCF = (0, https_1.onCall)({ region }, health_1.removeBadge);
exports.recalcHealthCF = (0, https_1.onCall)({ region }, health_1.recalcHealth);
exports.recalcHealthNightlyCF = (0, scheduler_1.onSchedule)({
    region,
    schedule: '0 2 * * *',
    timeZone: 'Europe/Berlin'
}, async () => {
    try {
        await (0, health_1.recalcHealthNightly)();
    }
    catch (error) {
        v2_1.logger.error('Error in nightly health recalculation:', error);
    }
});
exports.exportCsvCF = (0, https_1.onCall)({ region }, exports_1.exportCsv);
exports.exportMyTransfersCsvCF = (0, https_1.onCall)({ region }, exports_1.exportMyTransfersCsv);
exports.publishLegalDocCF = (0, https_1.onCall)({ region }, legal_1.publishLegalDoc);
exports.getLegalDocCF = (0, https_1.onCall)({ region }, legal_1.getLegalDoc);
exports.setUserConsentCF = (0, https_1.onCall)({ region }, legal_1.setUserConsent);
exports.getUserConsentCF = (0, https_1.onCall)({ region }, legal_1.getUserConsent);
exports.getLegalStatsCF = (0, https_1.onCall)({ region }, legal_1.getLegalStats);
exports.updateLegalVersionsCF = (0, https_1.onCall)({ region }, legal_1.updateLegalVersions);
exports.submitReviewCF = (0, https_1.onCall)({ region }, async (request) => {
    const { auth, data } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const { jobId, paymentId, rating, comment } = data;
    if (!jobId || !paymentId || !rating) {
        throw new https_1.HttpsError('invalid-argument', 'jobId, paymentId, and rating are required');
    }
    try {
        const validation = reviews_1.reviewsService.validateReview({ jobId, paymentId, rating, comment: comment || '' });
        if (!validation.isValid) {
            throw new https_1.HttpsError('invalid-argument', validation.errors.join(', '));
        }
        const result = await reviews_1.reviewsService.submitReview({
            request: { jobId, paymentId, rating, comment: comment || '' },
            userId: auth.uid,
        });
        return { success: true, ...result };
    }
    catch (error) {
        v2_1.logger.error('Error in submitReviewCF:', error);
        if (error instanceof Error) {
            throw new https_1.HttpsError('internal', error.message);
        }
        throw new https_1.HttpsError('internal', 'An unknown error occurred');
    }
});
exports.moderateReviewCF = (0, https_1.onCall)({ region }, async (request) => {
    const { auth, data } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    await (0, auth_1.enforceAdminRole)(auth);
    const adminUid = auth.uid;
    const { reviewId, action, reason } = data;
    if (!reviewId || !action) {
        throw new https_1.HttpsError('invalid-argument', 'reviewId and action are required');
    }
    if (!['visible', 'hidden', 'flagged'].includes(action)) {
        throw new https_1.HttpsError('invalid-argument', 'action must be visible, hidden, or flagged');
    }
    try {
        await reviews_1.reviewsService.moderateReview({
            request: { reviewId, action, reason },
            adminUid,
            auth,
        });
        return { success: true };
    }
    catch (error) {
        v2_1.logger.error('Error in moderateReviewCF:', error);
        if (error instanceof Error) {
            throw new https_1.HttpsError('internal', error.message);
        }
        throw new https_1.HttpsError('internal', 'An unknown error occurred');
    }
});
exports.hasReviewedJobCF = (0, https_1.onCall)({ region }, async (request) => {
    const { auth, data } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const { jobId } = data;
    if (!jobId) {
        throw new https_1.HttpsError('invalid-argument', 'jobId is required');
    }
    try {
        const hasReviewed = await reviews_1.reviewsService.hasReviewedJob({
            jobId,
            userId: auth.uid,
        });
        return { hasReviewed };
    }
    catch (error) {
        v2_1.logger.error('Error in hasReviewedJobCF:', error);
        if (error instanceof Error) {
            throw new https_1.HttpsError('internal', error.message);
        }
        throw new https_1.HttpsError('internal', 'An unknown error occurred');
    }
});
exports.getProRatingAggregateCF = (0, https_1.onCall)({ region }, async (request) => {
    const { data } = request;
    const { proUid } = data;
    if (!proUid) {
        throw new https_1.HttpsError('invalid-argument', 'proUid is required');
    }
    try {
        const aggregate = await reviews_1.reviewsService.getProRatingAggregate(proUid);
        return { aggregate };
    }
    catch (error) {
        v2_1.logger.error('Error in getProRatingAggregateCF:', error);
        if (error instanceof Error) {
            throw new https_1.HttpsError('internal', error.message);
        }
        throw new https_1.HttpsError('internal', 'An unknown error occurred');
    }
});
var aggregation_1 = require("./analytics/aggregation");
Object.defineProperty(exports, "aggregateDaily", { enumerable: true, get: function () { return aggregation_1.aggregateDaily; } });
var exports_2 = require("./analytics/exports");
Object.defineProperty(exports, "exportAnalyticsCsv", { enumerable: true, get: function () { return exports_2.exportAnalyticsCsv; } });
exports.dataRetentionCleanup = (0, scheduler_1.onSchedule)({
    schedule: '0 2 * * *',
    timeZone: 'UTC',
    region,
}, async () => {
    v2_1.logger.info('Starting scheduled data retention cleanup');
    try {
        const result = await (0, retention_1.runDataRetentionCleanup)();
        v2_1.logger.info('Data retention cleanup completed:', result);
    }
    catch (error) {
        v2_1.logger.error('Data retention cleanup failed:', error);
        throw error;
    }
});
exports.triggerDataRetentionCF = (0, https_1.onCall)({ region }, async (request) => {
    const { auth } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    try {
        await (0, auth_1.enforceAdminRole)(auth);
        const adminUid = auth.uid;
        v2_1.logger.info(`Admin ${adminUid} triggered manual data retention cleanup`);
        const result = await (0, retention_1.runDataRetentionCleanup)();
        v2_1.logger.info('Manual data retention cleanup completed:', result);
        return {
            success: true,
            result,
            triggeredBy: adminUid,
            triggeredAt: new Date().toISOString(),
        };
    }
    catch (error) {
        v2_1.logger.error('Manual data retention cleanup failed:', error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Data retention cleanup failed');
    }
});
exports.updateRetentionConfigCF = (0, https_1.onCall)({ region }, async (request) => {
    const { auth, data } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    try {
        await (0, auth_1.enforceAdminRole)(auth);
        const adminUid = auth.uid;
        const { jobsPrivateRetentionMonths, chatRetentionMonths, disputeRetentionMonths } = data;
        if (typeof jobsPrivateRetentionMonths !== 'number' ||
            typeof chatRetentionMonths !== 'number' ||
            typeof disputeRetentionMonths !== 'number' ||
            jobsPrivateRetentionMonths < 1 ||
            chatRetentionMonths < 1 ||
            disputeRetentionMonths < 1) {
            throw new https_1.HttpsError('invalid-argument', 'Retention periods must be positive numbers');
        }
        await (0, retention_1.initializeRetentionConfig)();
        const db = (0, firestore_1.getFirestore)();
        await db.collection('adminSettings').doc('retention').update({
            jobsPrivateRetentionMonths,
            chatRetentionMonths,
            disputeRetentionMonths,
            updatedAt: new Date(),
            updatedBy: adminUid,
        });
        v2_1.logger.info(`Admin ${adminUid} updated retention configuration`, {
            jobsPrivateRetentionMonths,
            chatRetentionMonths,
            disputeRetentionMonths,
        });
        return {
            success: true,
            config: {
                jobsPrivateRetentionMonths,
                chatRetentionMonths,
                disputeRetentionMonths,
            },
            updatedBy: adminUid,
            updatedAt: new Date().toISOString(),
        };
    }
    catch (error) {
        v2_1.logger.error('Failed to update retention configuration:', error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to update retention configuration');
    }
});
var location_1 = require("./lib/location");
Object.defineProperty(exports, "setJobAddressCF", { enumerable: true, get: function () { return location_1.setJobAddressCF; } });
Object.defineProperty(exports, "getEtaCF", { enumerable: true, get: function () { return location_1.getEtaCF; } });
Object.defineProperty(exports, "refreshJobGeocodeCF", { enumerable: true, get: function () { return location_1.refreshJobGeocodeCF; } });
var liveLocationCleanup_1 = require("./lib/liveLocationCleanup");
Object.defineProperty(exports, "cleanupLiveLocations", { enumerable: true, get: function () { return liveLocationCleanup_1.cleanupLiveLocations; } });
Object.defineProperty(exports, "triggerLiveLocationCleanupCF", { enumerable: true, get: function () { return liveLocationCleanup_1.triggerLiveLocationCleanupCF; } });
Object.defineProperty(exports, "cleanupJobLiveLocationsCF", { enumerable: true, get: function () { return liveLocationCleanup_1.cleanupJobLiveLocationsCF; } });
var pricing_1 = require("./lib/pricing");
Object.defineProperty(exports, "createPaymentIntentCF", { enumerable: true, get: function () { return pricing_1.createPaymentIntentCF; } });
Object.defineProperty(exports, "generateRecurringJobsCF", { enumerable: true, get: function () { return pricing_1.generateRecurringJobsCF; } });
Object.defineProperty(exports, "notifyExpressJobsCF", { enumerable: true, get: function () { return pricing_1.notifyExpressJobsCF; } });
exports.reviewDocumentCF = (0, https_1.onCall)({ region }, documents_1.reviewDocument);
exports.getPendingDocumentsCF = (0, https_1.onCall)({ region }, documents_1.getPendingDocuments);
exports.getDocumentStatsCF = (0, https_1.onCall)({ region }, documents_1.getDocumentStats);
exports.getKpiSummaryCF = (0, https_1.onCall)({ region }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    await (0, auth_1.enforceAdminRole)(request.auth);
    const { startDate, endDate } = request.data;
    return await (0, kpi_1.getKpiSummary)(startDate, endDate);
});
exports.getAdvancedMetricsCF = (0, https_1.onCall)({ region }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    await (0, auth_1.enforceAdminRole)(request.auth);
    return await (0, kpi_1.calculateAdvancedMetrics)();
});
var adminServices_1 = require("./lib/adminServices");
Object.defineProperty(exports, "createAdminServiceCheckout", { enumerable: true, get: function () { return adminServices_1.createAdminServiceCheckout; } });
Object.defineProperty(exports, "handleAdminServiceWebhook", { enumerable: true, get: function () { return adminServices_1.handleAdminServiceWebhook; } });
Object.defineProperty(exports, "updateAdminServiceStatus", { enumerable: true, get: function () { return adminServices_1.updateAdminServiceStatus; } });
//# sourceMappingURL=index.js.map