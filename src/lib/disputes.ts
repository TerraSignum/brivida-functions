import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { getDb } from './firestore';
import { createRefund } from './stripe';
import { notificationService } from './notifications';
import { logger } from 'firebase-functions/v2';
import { isAdmin } from './auth';

interface OpenDisputeData {
  jobId: string;
  paymentId: string;
  reason: 'no_show' | 'poor_quality' | 'damage' | 'overcharge' | 'other';
  description: string;
  requestedAmount: number;
  mediaPaths?: string[];
}

interface AddEvidenceData {
  caseId: string;
  role: 'customer' | 'pro';
  text?: string;
  mediaPaths?: string[];
}

interface ResolveDisputeData {
  caseId: string;
  decision: 'refund_full' | 'refund_partial' | 'no_refund' | 'cancelled';
  amount?: number;
}

type CallableAuthContext = CallableRequest<unknown>['auth'];

export async function openDispute(request: CallableRequest<OpenDisputeData>) {
  const { data, auth } = request;
  
  if (!auth?.uid) {
    throw new HttpsError('unauthenticated', 'User must be authenticated');
  }

  const { jobId, paymentId, reason, description, requestedAmount, mediaPaths = [] } = data;

  if (!jobId || !paymentId || !reason || !description || requestedAmount <= 0) {
    throw new HttpsError('invalid-argument', 'Missing or invalid required fields');
  }

  try {
    logger.info('🔥 FUNCTIONS: Opening dispute', { jobId, paymentId, reason, requestedAmount });

    const db = getDb();
    
    // Get and validate payment
    const paymentDoc = await db.collection('payments').doc(paymentId).get();
    if (!paymentDoc.exists) {
      throw new HttpsError('not-found', 'Payment not found');
    }

    const payment = paymentDoc.data()!;
    
    // Validate caller is customer
    if (payment.customerUid !== auth.uid) {
      throw new HttpsError('permission-denied', 'Only the customer can open a dispute');
    }

    // Check payment status
    if (!['captured', 'released', 'partially_refunded'].includes(payment.status)) {
      throw new HttpsError('failed-precondition', 'Payment must be captured to open dispute');
    }

    // Check 24h deadline
    const capturedAt = payment.capturedAt?.toDate() || new Date();
    const deadline = new Date(capturedAt.getTime() + 24 * 60 * 60 * 1000); // 24 hours
    if (new Date() > deadline) {
      throw new HttpsError('deadline-exceeded', 'Dispute must be opened within 24 hours of payment capture');
    }

    // Check if dispute already exists for this job
    const existingDispute = await db.collection('disputes')
      .where('jobId', '==', jobId)
      .where('status', 'in', ['open', 'awaiting_pro', 'under_review'])
      .limit(1)
      .get();
    
    if (!existingDispute.empty) {
      throw new HttpsError('already-exists', 'An active dispute already exists for this job');
    }

    // Get job for pro UID
    const jobDoc = await db.collection('jobs').doc(jobId).get();
    if (!jobDoc.exists) {
      throw new HttpsError('not-found', 'Job not found');
    }
    
    const job = jobDoc.data()!;
    const proUid = job.proUid;

    // Create dispute
    const caseId = db.collection('disputes').doc().id;
    const now = Timestamp.now();
    
    const evidence: any[] = mediaPaths.map(path => ({
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
      deadlineProResponse: Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)), // +24h
      deadlineDecision: Timestamp.fromDate(new Date(Date.now() + 48 * 60 * 60 * 1000)), // +48h
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

    // Send push notification to pro
    try {
      await notificationService.sendPushNotification({
        recipientUid: proUid,
        title: 'New Dispute Opened',
        body: 'A customer has opened a dispute for one of your jobs',
        data: { type: 'dispute', caseId, jobId }
      });
      logger.info('✅ FUNCTIONS: Push notification sent to pro', { proUid, caseId });
    } catch (pushError) {
      logger.warn('⚠️ FUNCTIONS: Failed to send push notification', { error: pushError });
    }

    // Add system message to chat
    try {
      const chatId = `${jobId}_chat`;
      await db.collection('chats').doc(chatId).collection('messages').add({
        senderId: 'system',
        text: `Dispute opened: ${reason}`,
        type: 'system',
        timestamp: now,
        metadata: { disputeId: caseId }
      });
      logger.info('✅ FUNCTIONS: System message added to chat', { chatId, caseId });
    } catch (chatError) {
      logger.warn('⚠️ FUNCTIONS: Failed to add chat message', { error: chatError });
    }

    logger.info('✅ FUNCTIONS: Dispute opened successfully', { caseId });
    return { caseId };

  } catch (error) {
    logger.error('❌ FUNCTIONS: Error opening dispute', { error, data });
    throw error instanceof HttpsError ? error : new HttpsError('internal', 'Failed to open dispute');
  }
}

export async function addEvidence(request: CallableRequest<AddEvidenceData>) {
  const { data, auth } = request;
  const uid = requireAuthUid(auth);
  const { caseId, role, text, mediaPaths } = normalizeAddEvidenceData(data);

  try {
    logger.info('🔥 FUNCTIONS: Adding evidence', {
      caseId,
      role,
      hasText: Boolean(text),
      mediaCount: mediaPaths.length
    });

    const db = getDb();
    const disputeRecord = await fetchDisputeOrThrow(db, caseId);
    ensureParticipantAccess(disputeRecord.data, uid, role);
    ensureDisputeActive(disputeRecord.data.status);

    const timestamp = Timestamp.now();
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

    logger.info('✅ FUNCTIONS: Evidence added successfully', { caseId, role });
    return { success: true };
  } catch (error) {
    logger.error('❌ FUNCTIONS: Error adding evidence', { error, data });
    throw error instanceof HttpsError ? error : new HttpsError('internal', 'Failed to add evidence');
  }
}

function requireAuthUid(auth: CallableAuthContext | undefined | null): string {
  if (!auth?.uid) {
    throw new HttpsError('unauthenticated', 'User must be authenticated');
  }
  return auth.uid;
}

function normalizeAddEvidenceData(data: AddEvidenceData) {
  const mediaPaths = data.mediaPaths ?? [];

  if (!data.caseId || !data.role || (!data.text && mediaPaths.length === 0)) {
    throw new HttpsError('invalid-argument', 'Must provide text or media evidence');
  }

  return {
    caseId: data.caseId,
    role: data.role,
    text: data.text,
    mediaPaths
  } as const;
}

async function fetchDisputeOrThrow(db: FirebaseFirestore.Firestore, caseId: string) {
  const ref = db.collection('disputes').doc(caseId);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    throw new HttpsError('not-found', 'Dispute not found');
  }

  return { ref, data: snapshot.data()! };
}

function ensureParticipantAccess(dispute: FirebaseFirestore.DocumentData, uid: string, role: 'customer' | 'pro') {
  const isCustomer = role === 'customer' && dispute.customerUid === uid;
  const isPro = role === 'pro' && dispute.proUid === uid;

  if (!isCustomer && !isPro) {
    throw new HttpsError('permission-denied', 'Access denied');
  }
}

function ensureDisputeActive(status: string) {
  if (!['open', 'awaiting_pro', 'under_review'].includes(status)) {
    throw new HttpsError('failed-precondition', 'Cannot add evidence to resolved dispute');
  }
}

function createEvidenceEntries(text: string | undefined, mediaPaths: string[], timestamp: Timestamp) {
  const entries: Array<Record<string, unknown>> = [];

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

function buildEvidenceUpdates({
  role,
  dispute,
  newEvidence,
  note,
  timestamp
}: {
  role: 'customer' | 'pro';
  dispute: FirebaseFirestore.DocumentData;
  newEvidence: Array<Record<string, unknown>>;
  note: string;
  timestamp: Timestamp;
}) {
  const auditEntry = createAuditEntry(role, note, timestamp);

  if (role === 'customer') {
    return {
      evidence: FieldValue.arrayUnion(...newEvidence),
      audit: FieldValue.arrayUnion(auditEntry)
    };
  }

  const hasExistingResponse = Array.isArray(dispute.proResponse) && dispute.proResponse.length > 0;
  const auditEntries = hasExistingResponse
    ? [auditEntry]
    : [auditEntry, createStatusChangeEntry(timestamp)];

  const updates: Record<string, unknown> = {
    proResponse: FieldValue.arrayUnion(...newEvidence),
    audit: FieldValue.arrayUnion(...auditEntries)
  };

  if (!hasExistingResponse) {
    updates.status = 'under_review';
  }

  return updates;
}

function createAuditEntry(role: 'customer' | 'pro', note: string, timestamp: Timestamp) {
  return {
    by: role,
    action: `${role}_evidence_added`,
    note,
    at: timestamp
  };
}

function createStatusChangeEntry(timestamp: Timestamp) {
  return {
    by: 'system',
    action: 'status_changed',
    note: 'Status changed to under_review after pro response',
    at: timestamp
  };
}

async function notifyEvidenceUpdate(
  dispute: FirebaseFirestore.DocumentData,
  role: 'customer' | 'pro',
  caseId: string
) {
  const notifyUid = role === 'customer' ? dispute.proUid : dispute.customerUid;
  const title = role === 'customer' ? 'New Customer Evidence' : 'Pro Response Added';
  const body =
    role === 'customer'
      ? 'The customer has added new evidence to the dispute'
      : 'The pro has responded to the dispute';

  try {
    await notificationService.sendPushNotification({
      recipientUid: notifyUid,
      title,
      body,
      data: { type: 'dispute_update', caseId, role }
    });
    logger.info('✅ FUNCTIONS: Push notification sent', { notifyUid, caseId });
  } catch (pushError) {
    logger.warn('⚠️ FUNCTIONS: Failed to send push notification', { error: pushError });
  }
}

export async function resolveDispute(request: CallableRequest<ResolveDisputeData>) {
  const { data, auth } = request;
  requireAuthUid(auth);

  const userIsAdmin = await isAdmin(auth);
  if (!userIsAdmin) {
    throw new HttpsError('permission-denied', 'Admin access required');
  }

  const { caseId, decision, amount } = normalizeResolveDisputeData(data);

  try {
    logger.info('🔥 FUNCTIONS: Resolving dispute', { caseId, decision, amount });

    const db = getDb();
    const disputeRecord = await fetchDisputeOrThrow(db, caseId);
    ensureDisputePending(disputeRecord.data.status);

    const paymentRecord = await fetchPaymentOrThrow(db, disputeRecord.data.paymentId);
    const resolutionPlan = determineResolutionPlan(decision, amount, paymentRecord.data);
    const timestamp = Timestamp.now();

    const stripeRefundId = await processRefundIfNeeded(resolutionPlan, paymentRecord.data);
    await applyDisputeResolution(disputeRecord.ref, resolutionPlan, decision, timestamp);

    if (resolutionPlan.refundAmount > 0) {
      if (!stripeRefundId) {
        throw new HttpsError('internal', 'Refund missing identifier');
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

    logger.info('✅ FUNCTIONS: Dispute resolved successfully', {
      caseId,
      decision,
      refundAmount: resolutionPlan.refundAmount
    });

    return {
      success: true,
      refundAmount: resolutionPlan.refundAmount,
      awardedAmount: resolutionPlan.awardedAmount
    };
  } catch (error) {
    logger.error('❌ FUNCTIONS: Error resolving dispute', { error, data });
    throw error instanceof HttpsError ? error : new HttpsError('internal', 'Failed to resolve dispute');
  }
}

function normalizeResolveDisputeData(data: ResolveDisputeData) {
  if (!data.caseId || !data.decision) {
    throw new HttpsError('invalid-argument', 'Missing required fields');
  }

  if (data.decision === 'refund_partial' && (!data.amount || data.amount <= 0)) {
    throw new HttpsError('invalid-argument', 'Partial refund requires valid amount');
  }

  return {
    caseId: data.caseId,
    decision: data.decision,
    amount: data.amount
  } as const;
}

async function fetchPaymentOrThrow(db: FirebaseFirestore.Firestore, paymentId: string) {
  const ref = db.collection('payments').doc(paymentId);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    throw new HttpsError('not-found', 'Payment not found');
  }

  return { ref, data: snapshot.data()! };
}

function ensureDisputePending(status: string) {
  if (!['open', 'awaiting_pro', 'under_review'].includes(status)) {
    throw new HttpsError('failed-precondition', 'Dispute is already resolved');
  }
}

interface ResolutionPlan {
  finalStatus: string;
  awardedAmount: number;
  refundAmount: number;
}

function determineResolutionPlan(
  decision: ResolveDisputeData['decision'],
  amount: number | undefined,
  payment: FirebaseFirestore.DocumentData
): ResolutionPlan {
  switch (decision) {
    case 'refund_full':
      return {
        finalStatus: 'resolved_refund_full',
        awardedAmount: payment.amountGross,
        refundAmount: payment.amountGross
      };

    case 'refund_partial': {
      if (!amount) {
        throw new HttpsError('invalid-argument', 'Partial refund requires valid amount');
      }

      if (amount > payment.amountGross) {
        throw new HttpsError('invalid-argument', 'Refund amount exceeds payment amount');
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
      throw new HttpsError('invalid-argument', 'Invalid decision');
  }
}

async function processRefundIfNeeded(plan: ResolutionPlan, payment: FirebaseFirestore.DocumentData) {
  if (plan.refundAmount <= 0) {
    return null;
  }

  try {
    const refundResult = await createRefund({
      paymentIntentId: payment.stripePaymentIntentId,
      amount: Math.round(plan.refundAmount * 100),
      reason: 'requested_by_customer'
    });
    logger.info('✅ FUNCTIONS: Stripe refund created', {
      refundId: refundResult.id,
      amount: plan.refundAmount
    });
    return refundResult.id;
  } catch (stripeError) {
    logger.error('❌ FUNCTIONS: Stripe refund failed', { error: stripeError });
    throw new HttpsError('internal', 'Failed to process refund');
  }
}

async function applyDisputeResolution(
  disputeRef: FirebaseFirestore.DocumentReference,
  plan: ResolutionPlan,
  decision: ResolveDisputeData['decision'],
  timestamp: Timestamp
) {
  await disputeRef.update({
    status: plan.finalStatus,
    awardedAmount: plan.awardedAmount,
    resolvedAt: timestamp,
    audit: FieldValue.arrayUnion(createDecisionAuditEntry(decision, plan.refundAmount, timestamp))
  });
}

function createDecisionAuditEntry(
  decision: ResolveDisputeData['decision'],
  refundAmount: number,
  timestamp: Timestamp
) {
  return {
    by: 'admin',
    action: 'decision_made',
    note: refundAmount > 0 ? `Decision: ${decision}, refund: €${refundAmount}` : `Decision: ${decision}`,
    at: timestamp
  };
}

async function applyRefundSideEffects({
  db,
  disputeId,
  paymentId,
  payment,
  resolutionPlan,
  stripeRefundId,
  timestamp
}: {
  db: FirebaseFirestore.Firestore;
  disputeId: string;
  paymentId: string;
  payment: FirebaseFirestore.DocumentData;
  resolutionPlan: ResolutionPlan;
  stripeRefundId: string;
  timestamp: Timestamp;
}) {
  const paymentStatus =
    resolutionPlan.refundAmount >= payment.amountGross ? 'refunded' : 'partially_refunded';

  await db.collection('payments').doc(paymentId).update({
    status: paymentStatus,
    refundedAmount: FieldValue.increment(resolutionPlan.refundAmount),
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

async function sendResolutionNotifications(
  dispute: FirebaseFirestore.DocumentData,
  decision: ResolveDisputeData['decision'],
  refundAmount: number,
  caseId: string
) {
  const { customerBody, proBody } = buildResolutionMessages(decision, refundAmount);

  try {
    await Promise.all([
      notificationService.sendPushNotification({
        recipientUid: dispute.customerUid,
        title: 'Dispute Resolved',
        body: customerBody,
        data: { type: 'dispute_resolved', caseId, decision }
      }),
      notificationService.sendPushNotification({
        recipientUid: dispute.proUid,
        title: 'Dispute Resolved',
        body: proBody,
        data: { type: 'dispute_resolved', caseId, decision }
      })
    ]);
    logger.info('✅ FUNCTIONS: Notifications sent to both parties');
  } catch (pushError) {
    logger.warn('⚠️ FUNCTIONS: Failed to send notifications', { error: pushError });
  }
}

function buildResolutionMessages(
  decision: ResolveDisputeData['decision'],
  refundAmount: number
) {
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

async function addResolutionChatMessage(
  db: FirebaseFirestore.Firestore,
  dispute: FirebaseFirestore.DocumentData,
  decision: ResolveDisputeData['decision'],
  refundAmount: number,
  caseId: string,
  timestamp: Timestamp
) {
  try {
    const chatId = `${dispute.jobId}_chat`;
    await db.collection('chats').doc(chatId).collection('messages').add({
      senderId: 'system',
      text:
        refundAmount > 0
          ? `Dispute resolved: ${decision} - Refund: €${refundAmount}`
          : `Dispute resolved: ${decision}`,
      type: 'system',
      timestamp,
      metadata: { disputeId: caseId, decision, refundAmount }
    });
    logger.info('✅ FUNCTIONS: System message added to chat');
  } catch (chatError) {
    logger.warn('⚠️ FUNCTIONS: Failed to add chat message', { error: chatError });
  }
}

// Helper function to determine evidence type from file path
function getEvidenceType(path: string): 'image' | 'audio' | 'text' {
  const extension = path.split('.').pop()?.toLowerCase();
  
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension || '')) {
    return 'image';
  } else if (['mp3', 'wav', 'm4a', 'aac', 'ogg'].includes(extension || '')) {
    return 'audio';
  }
  
  return 'text'; // Default fallback
}

// Scheduled function to handle dispute expiry
export async function expireDisputes() {
  try {
    logger.info('🔥 FUNCTIONS: Running dispute expiry check');

    const db = getDb();
    const now = new Date();
    const batch = db.batch();
    let updateCount = 0;

    // Find disputes past pro response deadline
    const proDeadlineQuery = await db.collection('disputes')
      .where('status', '==', 'open')
      .where('deadlineProResponse', '<=', Timestamp.fromDate(now))
      .limit(100)
      .get();

    proDeadlineQuery.docs.forEach((doc: any) => {
      const ref = db.collection('disputes').doc(doc.id);
      batch.update(ref, {
        status: 'under_review',
        audit: FieldValue.arrayUnion({
          by: 'system',
          action: 'auto_status_change',
          note: 'Status changed to under_review - pro response deadline passed',
          at: Timestamp.fromDate(now)
        })
      });
      updateCount++;
    });

    // Find disputes past decision deadline
    const decisionDeadlineQuery = await db.collection('disputes')
      .where('status', 'in', ['open', 'awaiting_pro', 'under_review'])
      .where('deadlineDecision', '<=', Timestamp.fromDate(now))
      .limit(100)
      .get();

    decisionDeadlineQuery.docs.forEach((doc: any) => {
      const ref = db.collection('disputes').doc(doc.id);
      batch.update(ref, {
        status: 'expired',
        audit: FieldValue.arrayUnion({
          by: 'system',
          action: 'auto_expired',
          note: 'Dispute expired - decision deadline passed',
          at: Timestamp.fromDate(now)
        })
      });
      updateCount++;
    });

    if (updateCount > 0) {
      await batch.commit();
      logger.info(`✅ FUNCTIONS: Updated ${updateCount} expired disputes`);
    } else {
      logger.info('✅ FUNCTIONS: No disputes to expire');
    }

    return { updated: updateCount };

  } catch (error) {
    logger.error('❌ FUNCTIONS: Error expiring disputes', { error });
    throw error;
  }
}

// Scheduled function to remind moderators of pending disputes
export async function remindModeration() {
  try {
    logger.info('🔥 FUNCTIONS: Running moderation reminder check');

    const db = getDb();
    const now = new Date();
    const warningTime = new Date(now.getTime() + 12 * 60 * 60 * 1000); // 12 hours before deadline

    // Find disputes nearing decision deadline
    const nearDeadlineQuery = await db.collection('disputes')
      .where('status', '==', 'under_review')
      .where('deadlineDecision', '<=', Timestamp.fromDate(warningTime))
      .where('deadlineDecision', '>', Timestamp.fromDate(now))
      .limit(50)
      .get();

    if (nearDeadlineQuery.empty) {
      logger.info('✅ FUNCTIONS: No disputes need moderation reminders');
      return { reminded: 0 };
    }

    // Get admin users (in a real app, you'd have a dedicated collection for admins)
    // For now, we'll just log the reminder
    const urgentDisputes = nearDeadlineQuery.docs.map((doc: any) => ({
      id: doc.id,
      deadline: doc.data().deadlineDecision.toDate(),
      ...doc.data()
    }));

    logger.warn('⚠️ FUNCTIONS: Urgent disputes require moderation', {
      count: urgentDisputes.length,
      disputes: urgentDisputes.map((d: any) => ({ id: d.id, deadline: d.deadline }))
    });

    // In a production app, you would:
    // 1. Send notifications to admin users
    // 2. Send emails to moderators
    // 3. Create alerts in an admin dashboard
    // 4. Update a moderation queue

    return { reminded: urgentDisputes.length };

  } catch (error) {
    logger.error('❌ FUNCTIONS: Error in moderation reminder', { error });
    throw error;
  }
}