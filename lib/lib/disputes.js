"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openDispute = openDispute;
exports.addEvidence = addEvidence;
exports.resolveDispute = resolveDispute;
exports.expireDisputes = expireDisputes;
exports.remindModeration = remindModeration;
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/v2/https");
const firestore_2 = require("./firestore");
const stripe_1 = require("./stripe");
const notifications_1 = require("./notifications");
const v2_1 = require("firebase-functions/v2");
const auth_1 = require("./auth");
async function openDispute(request) {
    var _a;
    const { data, auth } = request;
    if (!(auth === null || auth === void 0 ? void 0 : auth.uid)) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const { jobId, paymentId, reason, description, requestedAmount, mediaPaths = [] } = data;
    if (!jobId || !paymentId || !reason || !description || requestedAmount <= 0) {
        throw new https_1.HttpsError('invalid-argument', 'Missing or invalid required fields');
    }
    try {
        v2_1.logger.info('🔥 FUNCTIONS: Opening dispute', { jobId, paymentId, reason, requestedAmount });
        const db = (0, firestore_2.getDb)();
        const paymentDoc = await db.collection('payments').doc(paymentId).get();
        if (!paymentDoc.exists) {
            throw new https_1.HttpsError('not-found', 'Payment not found');
        }
        const payment = paymentDoc.data();
        if (payment.customerUid !== auth.uid) {
            throw new https_1.HttpsError('permission-denied', 'Only the customer can open a dispute');
        }
        if (!['captured', 'released', 'partially_refunded'].includes(payment.status)) {
            throw new https_1.HttpsError('failed-precondition', 'Payment must be captured to open dispute');
        }
        const capturedAt = ((_a = payment.capturedAt) === null || _a === void 0 ? void 0 : _a.toDate()) || new Date();
        const deadline = new Date(capturedAt.getTime() + 24 * 60 * 60 * 1000);
        if (new Date() > deadline) {
            throw new https_1.HttpsError('deadline-exceeded', 'Dispute must be opened within 24 hours of payment capture');
        }
        const existingDispute = await db.collection('disputes')
            .where('jobId', '==', jobId)
            .where('status', 'in', ['open', 'awaiting_pro', 'under_review'])
            .limit(1)
            .get();
        if (!existingDispute.empty) {
            throw new https_1.HttpsError('already-exists', 'An active dispute already exists for this job');
        }
        const jobDoc = await db.collection('jobs').doc(jobId).get();
        if (!jobDoc.exists) {
            throw new https_1.HttpsError('not-found', 'Job not found');
        }
        const job = jobDoc.data();
        const proUid = job.proUid;
        const caseId = db.collection('disputes').doc().id;
        const now = firestore_1.Timestamp.now();
        const evidence = mediaPaths.map(path => ({
            type: getEvidenceType(path),
            path,
            createdAt: now
        }));
        const dispute = {
            jobId,
            paymentId,
            customerUid: auth.uid,
            proUid,
            status: 'open',
            reason,
            description,
            requestedAmount,
            awardedAmount: null,
            openedAt: now,
            deadlineProResponse: firestore_1.Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)),
            deadlineDecision: firestore_1.Timestamp.fromDate(new Date(Date.now() + 48 * 60 * 60 * 1000)),
            resolvedAt: null,
            evidence,
            proResponse: [],
            audit: [{
                    by: 'customer',
                    action: 'case_opened',
                    note: `Dispute opened for ${reason}`,
                    at: now
                }]
        };
        await db.collection('disputes').doc(caseId).set(dispute);
        try {
            await notifications_1.notificationService.sendPushNotification({
                recipientUid: proUid,
                title: 'New Dispute Opened',
                body: 'A customer has opened a dispute for one of your jobs',
                data: { type: 'dispute', caseId, jobId }
            });
            v2_1.logger.info('✅ FUNCTIONS: Push notification sent to pro', { proUid, caseId });
        }
        catch (pushError) {
            v2_1.logger.warn('⚠️ FUNCTIONS: Failed to send push notification', { error: pushError });
        }
        try {
            const chatId = `${jobId}_chat`;
            await db.collection('chats').doc(chatId).collection('messages').add({
                senderId: 'system',
                text: `Dispute opened: ${reason}`,
                type: 'system',
                timestamp: now,
                metadata: { disputeId: caseId }
            });
            v2_1.logger.info('✅ FUNCTIONS: System message added to chat', { chatId, caseId });
        }
        catch (chatError) {
            v2_1.logger.warn('⚠️ FUNCTIONS: Failed to add chat message', { error: chatError });
        }
        v2_1.logger.info('✅ FUNCTIONS: Dispute opened successfully', { caseId });
        return { caseId };
    }
    catch (error) {
        v2_1.logger.error('❌ FUNCTIONS: Error opening dispute', { error, data });
        throw error instanceof https_1.HttpsError ? error : new https_1.HttpsError('internal', 'Failed to open dispute');
    }
}
async function addEvidence(request) {
    const { data, auth } = request;
    const uid = requireAuthUid(auth);
    const { caseId, role, text, mediaPaths } = normalizeAddEvidenceData(data);
    try {
        v2_1.logger.info('🔥 FUNCTIONS: Adding evidence', {
            caseId,
            role,
            hasText: Boolean(text),
            mediaCount: mediaPaths.length
        });
        const db = (0, firestore_2.getDb)();
        const disputeRecord = await fetchDisputeOrThrow(db, caseId);
        ensureParticipantAccess(disputeRecord.data, uid, role);
        ensureDisputeActive(disputeRecord.data.status);
        const timestamp = firestore_1.Timestamp.now();
        const newEvidence = createEvidenceEntries(text, mediaPaths, timestamp);
        const auditNote = text
            ? `Added ${newEvidence.length} evidence items`
            : `Added ${mediaPaths.length} media files`;
        const updates = buildEvidenceUpdates({
            role,
            dispute: disputeRecord.data,
            newEvidence,
            note: auditNote,
            timestamp
        });
        await disputeRecord.ref.update(updates);
        await notifyEvidenceUpdate(disputeRecord.data, role, caseId);
        v2_1.logger.info('✅ FUNCTIONS: Evidence added successfully', { caseId, role });
        return { success: true };
    }
    catch (error) {
        v2_1.logger.error('❌ FUNCTIONS: Error adding evidence', { error, data });
        throw error instanceof https_1.HttpsError ? error : new https_1.HttpsError('internal', 'Failed to add evidence');
    }
}
function requireAuthUid(auth) {
    if (!(auth === null || auth === void 0 ? void 0 : auth.uid)) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    return auth.uid;
}
function normalizeAddEvidenceData(data) {
    var _a;
    const mediaPaths = (_a = data.mediaPaths) !== null && _a !== void 0 ? _a : [];
    if (!data.caseId || !data.role || (!data.text && mediaPaths.length === 0)) {
        throw new https_1.HttpsError('invalid-argument', 'Must provide text or media evidence');
    }
    return {
        caseId: data.caseId,
        role: data.role,
        text: data.text,
        mediaPaths
    };
}
async function fetchDisputeOrThrow(db, caseId) {
    const ref = db.collection('disputes').doc(caseId);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
        throw new https_1.HttpsError('not-found', 'Dispute not found');
    }
    return { ref, data: snapshot.data() };
}
function ensureParticipantAccess(dispute, uid, role) {
    const isCustomer = role === 'customer' && dispute.customerUid === uid;
    const isPro = role === 'pro' && dispute.proUid === uid;
    if (!isCustomer && !isPro) {
        throw new https_1.HttpsError('permission-denied', 'Access denied');
    }
}
function ensureDisputeActive(status) {
    if (!['open', 'awaiting_pro', 'under_review'].includes(status)) {
        throw new https_1.HttpsError('failed-precondition', 'Cannot add evidence to resolved dispute');
    }
}
function createEvidenceEntries(text, mediaPaths, timestamp) {
    const entries = [];
    if (text) {
        entries.push({
            type: 'text',
            text,
            createdAt: timestamp
        });
    }
    mediaPaths.forEach((path) => {
        entries.push({
            type: getEvidenceType(path),
            path,
            createdAt: timestamp
        });
    });
    return entries;
}
function buildEvidenceUpdates({ role, dispute, newEvidence, note, timestamp }) {
    const auditEntry = createAuditEntry(role, note, timestamp);
    if (role === 'customer') {
        return {
            evidence: firestore_1.FieldValue.arrayUnion(...newEvidence),
            audit: firestore_1.FieldValue.arrayUnion(auditEntry)
        };
    }
    const hasExistingResponse = Array.isArray(dispute.proResponse) && dispute.proResponse.length > 0;
    const auditEntries = hasExistingResponse
        ? [auditEntry]
        : [auditEntry, createStatusChangeEntry(timestamp)];
    const updates = {
        proResponse: firestore_1.FieldValue.arrayUnion(...newEvidence),
        audit: firestore_1.FieldValue.arrayUnion(...auditEntries)
    };
    if (!hasExistingResponse) {
        updates.status = 'under_review';
    }
    return updates;
}
function createAuditEntry(role, note, timestamp) {
    return {
        by: role,
        action: `${role}_evidence_added`,
        note,
        at: timestamp
    };
}
function createStatusChangeEntry(timestamp) {
    return {
        by: 'system',
        action: 'status_changed',
        note: 'Status changed to under_review after pro response',
        at: timestamp
    };
}
async function notifyEvidenceUpdate(dispute, role, caseId) {
    const notifyUid = role === 'customer' ? dispute.proUid : dispute.customerUid;
    const title = role === 'customer' ? 'New Customer Evidence' : 'Pro Response Added';
    const body = role === 'customer'
        ? 'The customer has added new evidence to the dispute'
        : 'The pro has responded to the dispute';
    try {
        await notifications_1.notificationService.sendPushNotification({
            recipientUid: notifyUid,
            title,
            body,
            data: { type: 'dispute_update', caseId, role }
        });
        v2_1.logger.info('✅ FUNCTIONS: Push notification sent', { notifyUid, caseId });
    }
    catch (pushError) {
        v2_1.logger.warn('⚠️ FUNCTIONS: Failed to send push notification', { error: pushError });
    }
}
async function resolveDispute(request) {
    const { data, auth } = request;
    requireAuthUid(auth);
    const userIsAdmin = await (0, auth_1.isAdmin)(auth);
    if (!userIsAdmin) {
        throw new https_1.HttpsError('permission-denied', 'Admin access required');
    }
    const { caseId, decision, amount } = normalizeResolveDisputeData(data);
    try {
        v2_1.logger.info('🔥 FUNCTIONS: Resolving dispute', { caseId, decision, amount });
        const db = (0, firestore_2.getDb)();
        const disputeRecord = await fetchDisputeOrThrow(db, caseId);
        ensureDisputePending(disputeRecord.data.status);
        const paymentRecord = await fetchPaymentOrThrow(db, disputeRecord.data.paymentId);
        const resolutionPlan = determineResolutionPlan(decision, amount, paymentRecord.data);
        const timestamp = firestore_1.Timestamp.now();
        const stripeRefundId = await processRefundIfNeeded(resolutionPlan, paymentRecord.data);
        await applyDisputeResolution(disputeRecord.ref, resolutionPlan, decision, timestamp);
        if (resolutionPlan.refundAmount > 0) {
            if (!stripeRefundId) {
                throw new https_1.HttpsError('internal', 'Refund missing identifier');
            }
            await applyRefundSideEffects({
                db,
                disputeId: caseId,
                paymentId: disputeRecord.data.paymentId,
                payment: paymentRecord.data,
                resolutionPlan,
                stripeRefundId,
                timestamp
            });
        }
        await sendResolutionNotifications(disputeRecord.data, decision, resolutionPlan.refundAmount, caseId);
        await addResolutionChatMessage(db, disputeRecord.data, decision, resolutionPlan.refundAmount, caseId, timestamp);
        v2_1.logger.info('✅ FUNCTIONS: Dispute resolved successfully', {
            caseId,
            decision,
            refundAmount: resolutionPlan.refundAmount
        });
        return {
            success: true,
            refundAmount: resolutionPlan.refundAmount,
            awardedAmount: resolutionPlan.awardedAmount
        };
    }
    catch (error) {
        v2_1.logger.error('❌ FUNCTIONS: Error resolving dispute', { error, data });
        throw error instanceof https_1.HttpsError ? error : new https_1.HttpsError('internal', 'Failed to resolve dispute');
    }
}
function normalizeResolveDisputeData(data) {
    if (!data.caseId || !data.decision) {
        throw new https_1.HttpsError('invalid-argument', 'Missing required fields');
    }
    if (data.decision === 'refund_partial' && (!data.amount || data.amount <= 0)) {
        throw new https_1.HttpsError('invalid-argument', 'Partial refund requires valid amount');
    }
    return {
        caseId: data.caseId,
        decision: data.decision,
        amount: data.amount
    };
}
async function fetchPaymentOrThrow(db, paymentId) {
    const ref = db.collection('payments').doc(paymentId);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
        throw new https_1.HttpsError('not-found', 'Payment not found');
    }
    return { ref, data: snapshot.data() };
}
function ensureDisputePending(status) {
    if (!['open', 'awaiting_pro', 'under_review'].includes(status)) {
        throw new https_1.HttpsError('failed-precondition', 'Dispute is already resolved');
    }
}
function determineResolutionPlan(decision, amount, payment) {
    switch (decision) {
        case 'refund_full':
            return {
                finalStatus: 'resolved_refund_full',
                awardedAmount: payment.amountGross,
                refundAmount: payment.amountGross
            };
        case 'refund_partial': {
            if (!amount) {
                throw new https_1.HttpsError('invalid-argument', 'Partial refund requires valid amount');
            }
            if (amount > payment.amountGross) {
                throw new https_1.HttpsError('invalid-argument', 'Refund amount exceeds payment amount');
            }
            return {
                finalStatus: 'resolved_refund_partial',
                awardedAmount: amount,
                refundAmount: amount
            };
        }
        case 'no_refund':
            return {
                finalStatus: 'resolved_no_refund',
                awardedAmount: 0,
                refundAmount: 0
            };
        case 'cancelled':
            return {
                finalStatus: 'cancelled',
                awardedAmount: 0,
                refundAmount: 0
            };
        default:
            throw new https_1.HttpsError('invalid-argument', 'Invalid decision');
    }
}
async function processRefundIfNeeded(plan, payment) {
    if (plan.refundAmount <= 0) {
        return null;
    }
    try {
        const refundResult = await (0, stripe_1.createRefund)({
            paymentIntentId: payment.stripePaymentIntentId,
            amount: Math.round(plan.refundAmount * 100),
            reason: 'requested_by_customer'
        });
        v2_1.logger.info('✅ FUNCTIONS: Stripe refund created', {
            refundId: refundResult.id,
            amount: plan.refundAmount
        });
        return refundResult.id;
    }
    catch (stripeError) {
        v2_1.logger.error('❌ FUNCTIONS: Stripe refund failed', { error: stripeError });
        throw new https_1.HttpsError('internal', 'Failed to process refund');
    }
}
async function applyDisputeResolution(disputeRef, plan, decision, timestamp) {
    await disputeRef.update({
        status: plan.finalStatus,
        awardedAmount: plan.awardedAmount,
        resolvedAt: timestamp,
        audit: firestore_1.FieldValue.arrayUnion(createDecisionAuditEntry(decision, plan.refundAmount, timestamp))
    });
}
function createDecisionAuditEntry(decision, refundAmount, timestamp) {
    return {
        by: 'admin',
        action: 'decision_made',
        note: refundAmount > 0 ? `Decision: ${decision}, refund: €${refundAmount}` : `Decision: ${decision}`,
        at: timestamp
    };
}
async function applyRefundSideEffects({ db, disputeId, paymentId, payment, resolutionPlan, stripeRefundId, timestamp }) {
    const paymentStatus = resolutionPlan.refundAmount >= payment.amountGross ? 'refunded' : 'partially_refunded';
    await db.collection('payments').doc(paymentId).update({
        status: paymentStatus,
        refundedAmount: firestore_1.FieldValue.increment(resolutionPlan.refundAmount),
        updatedAt: timestamp
    });
    await db.collection('refunds').add({
        paymentId,
        disputeId,
        stripeRefundId,
        amount: resolutionPlan.refundAmount,
        reason: 'dispute_resolution',
        createdAt: timestamp,
        status: 'completed'
    });
}
async function sendResolutionNotifications(dispute, decision, refundAmount, caseId) {
    const { customerBody, proBody } = buildResolutionMessages(decision, refundAmount);
    try {
        await Promise.all([
            notifications_1.notificationService.sendPushNotification({
                recipientUid: dispute.customerUid,
                title: 'Dispute Resolved',
                body: customerBody,
                data: { type: 'dispute_resolved', caseId, decision }
            }),
            notifications_1.notificationService.sendPushNotification({
                recipientUid: dispute.proUid,
                title: 'Dispute Resolved',
                body: proBody,
                data: { type: 'dispute_resolved', caseId, decision }
            })
        ]);
        v2_1.logger.info('✅ FUNCTIONS: Notifications sent to both parties');
    }
    catch (pushError) {
        v2_1.logger.warn('⚠️ FUNCTIONS: Failed to send notifications', { error: pushError });
    }
}
function buildResolutionMessages(decision, refundAmount) {
    switch (decision) {
        case 'refund_full':
            return {
                customerBody: 'Your dispute was resolved with a full refund',
                proBody: 'The dispute was resolved with a full refund to the customer'
            };
        case 'refund_partial':
            return {
                customerBody: `Your dispute was resolved with a partial refund of €${refundAmount}`,
                proBody: `The dispute was resolved with a partial refund of €${refundAmount}`
            };
        case 'no_refund':
            return {
                customerBody: 'Your dispute was resolved with no refund',
                proBody: 'The dispute was resolved with no refund'
            };
        default:
            return {
                customerBody: 'Your dispute has been resolved',
                proBody: 'The dispute has been resolved'
            };
    }
}
async function addResolutionChatMessage(db, dispute, decision, refundAmount, caseId, timestamp) {
    try {
        const chatId = `${dispute.jobId}_chat`;
        await db.collection('chats').doc(chatId).collection('messages').add({
            senderId: 'system',
            text: refundAmount > 0
                ? `Dispute resolved: ${decision} - Refund: €${refundAmount}`
                : `Dispute resolved: ${decision}`,
            type: 'system',
            timestamp,
            metadata: { disputeId: caseId, decision, refundAmount }
        });
        v2_1.logger.info('✅ FUNCTIONS: System message added to chat');
    }
    catch (chatError) {
        v2_1.logger.warn('⚠️ FUNCTIONS: Failed to add chat message', { error: chatError });
    }
}
function getEvidenceType(path) {
    var _a;
    const extension = (_a = path.split('.').pop()) === null || _a === void 0 ? void 0 : _a.toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension || '')) {
        return 'image';
    }
    else if (['mp3', 'wav', 'm4a', 'aac', 'ogg'].includes(extension || '')) {
        return 'audio';
    }
    return 'text';
}
async function expireDisputes() {
    try {
        v2_1.logger.info('🔥 FUNCTIONS: Running dispute expiry check');
        const db = (0, firestore_2.getDb)();
        const now = new Date();
        const batch = db.batch();
        let updateCount = 0;
        const proDeadlineQuery = await db.collection('disputes')
            .where('status', '==', 'open')
            .where('deadlineProResponse', '<=', firestore_1.Timestamp.fromDate(now))
            .limit(100)
            .get();
        proDeadlineQuery.docs.forEach((doc) => {
            const ref = db.collection('disputes').doc(doc.id);
            batch.update(ref, {
                status: 'under_review',
                audit: firestore_1.FieldValue.arrayUnion({
                    by: 'system',
                    action: 'auto_status_change',
                    note: 'Status changed to under_review - pro response deadline passed',
                    at: firestore_1.Timestamp.fromDate(now)
                })
            });
            updateCount++;
        });
        const decisionDeadlineQuery = await db.collection('disputes')
            .where('status', 'in', ['open', 'awaiting_pro', 'under_review'])
            .where('deadlineDecision', '<=', firestore_1.Timestamp.fromDate(now))
            .limit(100)
            .get();
        decisionDeadlineQuery.docs.forEach((doc) => {
            const ref = db.collection('disputes').doc(doc.id);
            batch.update(ref, {
                status: 'expired',
                audit: firestore_1.FieldValue.arrayUnion({
                    by: 'system',
                    action: 'auto_expired',
                    note: 'Dispute expired - decision deadline passed',
                    at: firestore_1.Timestamp.fromDate(now)
                })
            });
            updateCount++;
        });
        if (updateCount > 0) {
            await batch.commit();
            v2_1.logger.info(`✅ FUNCTIONS: Updated ${updateCount} expired disputes`);
        }
        else {
            v2_1.logger.info('✅ FUNCTIONS: No disputes to expire');
        }
        return { updated: updateCount };
    }
    catch (error) {
        v2_1.logger.error('❌ FUNCTIONS: Error expiring disputes', { error });
        throw error;
    }
}
async function remindModeration() {
    try {
        v2_1.logger.info('🔥 FUNCTIONS: Running moderation reminder check');
        const db = (0, firestore_2.getDb)();
        const now = new Date();
        const warningTime = new Date(now.getTime() + 12 * 60 * 60 * 1000);
        const nearDeadlineQuery = await db.collection('disputes')
            .where('status', '==', 'under_review')
            .where('deadlineDecision', '<=', firestore_1.Timestamp.fromDate(warningTime))
            .where('deadlineDecision', '>', firestore_1.Timestamp.fromDate(now))
            .limit(50)
            .get();
        if (nearDeadlineQuery.empty) {
            v2_1.logger.info('✅ FUNCTIONS: No disputes need moderation reminders');
            return { reminded: 0 };
        }
        const urgentDisputes = nearDeadlineQuery.docs.map((doc) => ({
            id: doc.id,
            deadline: doc.data().deadlineDecision.toDate(),
            ...doc.data()
        }));
        v2_1.logger.warn('⚠️ FUNCTIONS: Urgent disputes require moderation', {
            count: urgentDisputes.length,
            disputes: urgentDisputes.map((d) => ({ id: d.id, deadline: d.deadline }))
        });
        return { reminded: urgentDisputes.length };
    }
    catch (error) {
        v2_1.logger.error('❌ FUNCTIONS: Error in moderation reminder', { error });
        throw error;
    }
}
//# sourceMappingURL=disputes.js.map