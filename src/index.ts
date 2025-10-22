import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, HttpsError, onRequest } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { leadsService } from './lib/leads';
import { matchingService } from './lib/matching';
import { chatService } from './lib/chat';
import { notificationService } from './lib/notifications';
import { etaService, MAPBOX_TOKEN } from './lib/eta';
import { calendarService } from './lib/calendar';
import { firestoreHelpers } from './lib/firestore';
import * as stripeService from './lib/stripe';
import { openDispute, addEvidence, resolveDispute, expireDisputes, remindModeration } from './lib/disputes';
import { setFlags, addBadge, removeBadge, recalcHealth, recalcHealthNightly } from './lib/health';
import { exportCsv, exportMyTransfersCsv } from './lib/exports';
import { publishLegalDoc, getLegalDoc, setUserConsent, getUserConsent, getLegalStats, updateLegalVersions } from './lib/legal';
import { reviewsService } from './lib/reviews';
import { getKpiSummary, calculateAdvancedMetrics } from './lib/kpi';
import { reviewDocument, getPendingDocuments, getDocumentStats } from './lib/documents';
import { runDataRetentionCleanup, initializeRetentionConfig } from './lib/retention';
import { usersService } from './lib/users';
import { enforceAdminRole } from './lib/auth';
// Live location functions imported when needed
import { logServerEvent } from './analytics/helpers';
import {
  createPaymentIntentHandler,
  releaseTransferHandler,
  partialRefundHandler,
  handlePaymentIntentSucceeded,
  handleTransferCreated,
  handleChargeRefunded,
} from './lib/payments';

// Initialize Firebase Admin
initializeApp();

// Set region to europe-west1 as per requirements
const region = 'europe-west1';

export const acceptLeadCF = onCall(
  { region },
  async (request) => {
    const { auth, data } = request;

    // Check if user is authenticated
    if (!auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const { leadId } = data;
    if (!leadId || typeof leadId !== 'string') {
      throw new HttpsError('invalid-argument', 'leadId is required and must be a string');
    }

    try {
      const result = await leadsService.acceptLead({
        leadId,
        userId: auth.uid,
      });

      // Log analytics event for lead acceptance
      await logServerEvent({
        uid: auth.uid,
        role: auth.token?.role || 'pro',
        name: 'lead_accepted',
        props: {
          leadId,
          jobId: result.jobId,
        },
      });

      return { success: true, ...result };
    } catch (error) {
      logger.error('Error in acceptLeadCF:', error);
      
      if (error instanceof HttpsError) {
        throw error;
      }
      
      throw new HttpsError('internal', 'Failed to accept lead');
    }
  }
);

export const declineLeadCF = onCall(
  { region },
  async (request) => {
    const { auth, data } = request;

    // Check if user is authenticated
    if (!auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const { leadId } = data;
    if (!leadId || typeof leadId !== 'string') {
      throw new HttpsError('invalid-argument', 'leadId is required and must be a string');
    }

    try {
      const result = await leadsService.declineLead({
        leadId,
        userId: auth.uid,
      });

      return { success: true, ...result };
    } catch (error) {
      logger.error('Error in declineLeadCF:', error);
      
      if (error instanceof HttpsError) {
        throw error;
      }
      
      throw new HttpsError('internal', 'Failed to decline lead');
    }
  }
);

// Job creation with matching and lead generation
export const createJobWithMatchingCF = onCall(
  { region },
  async (request) => {
    const { auth, data } = request;

    // Check if user is authenticated
    if (!auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    // Validate required fields
    const { 
      jobId,
      title, 
      services, 
      location, 
      preferredDate, 
      duration, 
      budget 
    } = data;

    if (!jobId || !title || !services || !location || !preferredDate || !duration || !budget) {
      throw new HttpsError('invalid-argument', 'Missing required job fields');
    }

    if (!Array.isArray(services) || services.length === 0) {
      throw new HttpsError('invalid-argument', 'Services must be a non-empty array');
    }

    if (!location.address || !location.coordinates) {
      throw new HttpsError('invalid-argument', 'Location must include address and coordinates');
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

      const result = await matchingService.createJobWithLeads(jobData);

      return { 
        success: true, 
        jobId: result.jobId,
        leadsCreated: result.leadsCreated,
        message: `Job created successfully with ${result.leadsCreated} leads generated`
      };

    } catch (error) {
      logger.error('Error in createJobWithMatchingCF:', error);
      
      if (error instanceof HttpsError) {
        throw error;
      }
      
      throw new HttpsError('internal', 'Failed to create job with matching');
    }
  }
);

// Firestore trigger: when a new message is created
export const onMessageCreated = onDocumentCreated(
  { document: 'chats/{chatId}/messages/{messageId}', region },
  async (event) => {
    try {
      const messageData = event.data?.data();
      const chatId = event.params.chatId;
      const messageId = event.params.messageId;

      if (!messageData) {
        logger.error('No message data found');
        return;
      }

      logger.info(`Processing new message ${messageId} in chat ${chatId}`);

      // Update chat's lastMessageAt
      await chatService.updateLastMessageTime(chatId);

      // Get chat details to determine recipients
      const chatDoc = await event.data?.ref.parent.parent?.get();
      
      if (!chatDoc?.exists) {
        logger.error(`Chat ${chatId} not found`);
        return;
      }

      const chatData = chatDoc.data();
      if (!chatData?.members || !Array.isArray(chatData.members)) {
        logger.error(`Invalid chat members for chat ${chatId}`);
        return;
      }

      // Determine recipient (other member who didn't send the message)
      const senderUid = messageData.senderUid;
      const recipients = chatData.members.filter((uid: string) => uid !== senderUid);

      if (recipients.length === 0) {
        logger.warn(`No recipients found for chat ${chatId}`);
        return;
      }

      // Prepare notification content
      const messageType = messageData.type;
      const notificationTitle = 'New Message';
      let notificationBody = '';

      if (messageType === 'text' && messageData.text) {
        notificationBody = messageData.text.length > 50 
          ? messageData.text.substring(0, 50) + '...'
          : messageData.text;
      } else if (messageType === 'image') {
        notificationBody = 'Sent an image';
      } else {
        notificationBody = 'New message received';
      }

      // Send push notifications to all recipients
      const notificationPromises = recipients.map((recipientUid: string) =>
        notificationService.sendPushNotification({
          recipientUid,
          title: notificationTitle,
          body: notificationBody,
          data: {
            type: 'chat_message',
            chatId,
            messageId,
            senderUid,
          },
        })
      );

      await Promise.allSettled(notificationPromises);
      
      // Log analytics event for chat message
      await logServerEvent({
        uid: senderUid,
        role: 'unknown', // Could be customer or pro
        name: 'chat_message_sent',
        props: {
          chatId,
          messageId,
          messageType,
          recipientCount: recipients.length,
        },
      });
      
      logger.info(`Processed notifications for message ${messageId} in chat ${chatId}`);
      
    } catch (error) {
      logger.error('Error in onMessageCreated:', error);
      // Don't throw - this is a background function
    }
  }
);

// Calendar Functions

// ETA calculation using OSRM Public API
export const eta = onCall(
  { region, secrets: [MAPBOX_TOKEN] },
  async (request) => {
    const { auth, data } = request;

    // Check if user is authenticated
    if (!auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const { origin, destination } = data;
    
    if (!origin || !destination) {
      throw new HttpsError('invalid-argument', 'origin and destination are required');
    }

    if (!origin.lat || !origin.lng || !destination.lat || !destination.lng) {
      throw new HttpsError('invalid-argument', 'origin and destination must have lat and lng properties');
    }

    try {
      const result = await etaService.calculateEta({ origin, destination });
      return result;
    } catch (error) {
      logger.error('Error in eta function:', error);
      throw new HttpsError('internal', 'Failed to calculate ETA');
    }
  }
);

// ICS token management
export const ensureIcsToken = onCall(
  { region },
  async (request) => {
    const { auth } = request;

    // Check if user is authenticated
    if (!auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    try {
      const token = await calendarService.ensureIcsToken(auth.uid);
      return { token };
    } catch (error) {
      logger.error('Error in ensureIcsToken:', error);
      throw new HttpsError('internal', 'Failed to ensure ICS token');
    }
  }
);

// User profile & account management
export const reserveUsername = onCall(
  { region },
  async (request) => {
    const { auth, data } = request;

    if (!auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const desired = (data?.desired as string | undefined)?.trim();
    if (!desired) {
      throw new HttpsError('invalid-argument', 'desired is required');
    }

    try {
      const result = await usersService.reserveUsername({
        uid: auth.uid,
        desired,
      });

      await logServerEvent({
        uid: auth.uid,
        role: auth.token?.role ?? 'unknown',
        name: 'username_reserved',
        props: { username: result.username },
      });

      return result;
    } catch (error) {
      logger.error('Error in reserveUsername callable', { error, uid: auth.uid });
      if (error instanceof HttpsError) {
        throw error;
      }
      throw new HttpsError('internal', 'Failed to reserve username');
    }
  }
);

export const deleteAccount = onCall(
  { region },
  async (request) => {
    const { auth } = request;

    if (!auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    try {
      await usersService.deleteAccount(auth.uid);

      await logServerEvent({
        uid: auth.uid,
        role: auth.token?.role ?? 'unknown',
        name: 'account_deleted',
      });

      return { success: true };
    } catch (error) {
      logger.error('Error in deleteAccount callable', { error, uid: auth.uid });
      if (error instanceof HttpsError) {
        throw error;
      }
      throw new HttpsError('internal', 'Failed to delete account');
    }
  }
);

// ICS calendar export
export const calendarIcs = onRequest(
  { region },
  async (request, response) => {
    try {
      const token = request.query.token as string;
      
      if (!token) {
        response.status(400).json({ error: 'Token is required' });
        return;
      }

      // Find user by token
      const userUid = await calendarService.findUserByIcsToken(token);
      if (!userUid) {
        response.status(404).json({ error: 'Invalid token' });
        return;
      }

      // Get calendar events
      const events = await calendarService.getCalendarEvents(userUid);

      // Generate ICS content
  const icsContent = calendarService.generateIcsContent(events);

      // Set headers and return ICS content
      const headers = calendarService.getIcsHeaders();
      Object.entries(headers).forEach(([key, value]) => {
        response.setHeader(key, value);
      });

      response.status(200).send(icsContent);
      
    } catch (error) {
      logger.error('Error in calendarIcs:', error);
      response.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============= UTILITIES / DEBUG =============

/**
 * Send a test push notification to the authenticated user.
 * Useful for E2E validation of FCM delivery and deep links.
 */
export const sendTestPush = onCall(
  { region },
  async (request) => {
    const { auth, data } = request;

    if (!auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    try {
      const route = (data?.route as string) || '/notifications';
      const relatedId = (data?.relatedId as string) || 'debug';

      await notificationService.sendPushNotification({
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
    } catch (error) {
      logger.error('Error in sendTestPush:', error);
      throw new HttpsError('internal', 'Failed to send test push');
    }
  }
);

// Export scheduled functions
export { autoReleaseEscrow } from './lib/scheduled';

/**
 * Create PaymentIntent for job escrow
 */
export const createPaymentIntent = onCall(
  { region },
  createPaymentIntentHandler,
);

/**
 * Create Stripe Connect account for Pro user
 */
export const createConnectOnboarding = onCall(
  { region },
  async (request) => {
    const { auth, data } = request;

    if (!auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const { refreshUrl, returnUrl } = data;
    
    if (!refreshUrl || !returnUrl) {
      throw new HttpsError('invalid-argument', 'refreshUrl and returnUrl are required');
    }

    try {
      // Check if user already has a Connect account
      const userDoc = await firestoreHelpers.collections.users().doc(auth.uid).get();
      let stripeAccountId = userDoc.data()?.stripeAccountId;

      if (!stripeAccountId) {
        // Create new Connect account
        const account = await stripeService.createConnectAccount();
        stripeAccountId = account.id;

        // Store account ID in user profile
        await firestoreHelpers.collections.users().doc(auth.uid).update({
          stripeAccountId,
          updatedAt: new Date(),
        });
      }

      // Create onboarding link
      const accountLink = await stripeService.createAccountLink(
        stripeAccountId,
        refreshUrl,
        returnUrl
      );

      return {
        accountId: stripeAccountId,
        onboardingUrl: accountLink.url,
      };

    } catch (error) {
      logger.error('Error creating Connect onboarding:', error);
      
      if (error instanceof HttpsError) {
        throw error;
      }
      
      throw new HttpsError('internal', 'Failed to create Connect onboarding');
    }
  }
);

/**
 * Release escrow transfer to Pro (after 24h or manual approval)
 */
export const releaseTransfer = onCall(
  { region },
  releaseTransferHandler,
);

/**
 * Create partial refund for disputes
 */
export const partialRefund = onCall(
  { region },
  partialRefundHandler,
);

// ============= STRIPE WEBHOOK =============

/**
 * Handle Stripe webhooks for payment processing
 */
export const stripeWebhook = onRequest(
  { region },
  async (request, response) => {
    try {
      const signature = request.headers['stripe-signature'] as string;
      
      if (!signature) {
        logger.error('Missing stripe-signature header');
        response.status(400).send('Missing stripe-signature header');
        return;
      }

      // Verify webhook signature
      const event = stripeService.verifyWebhookSignature(
        request.rawBody || request.body,
        signature
      );

      logger.info('Webhook received', { type: event.type, id: event.id });

      // Handle different event types
      switch (event.type) {
        case 'payment_intent.succeeded':
          await handlePaymentIntentSucceeded(event.data.object as any);
          break;

        case 'account.updated':
          await handleAccountUpdated(event.data.object as any);
          break;

        case 'transfer.created':
          await handleTransferCreated(event.data.object as any);
          break;

        case 'charge.refunded':
          await handleChargeRefunded(event.data.object as any);
          break;

        default:
          logger.info('Unhandled webhook event type', { type: event.type });
      }

      response.status(200).send('ok');

    } catch (error) {
      logger.error('Webhook error:', error);
      response.status(400).send('Webhook error');
    }
  }
);

// Webhook handlers

async function handleAccountUpdated(account: any) {
  try {
    const accountId = account.id;
    
    // Find user with this Stripe account ID
    const usersSnapshot = await firestoreHelpers.collections.users()
      .where('stripeAccountId', '==', accountId)
      .limit(1)
      .get();

    if (usersSnapshot.empty) {
      logger.warn('User not found for account update', { accountId });
      return;
    }

    const userDoc = usersSnapshot.docs[0];
    const userData = userDoc.data();
    
    // Update user's Connect status
    await userDoc.ref.update({
      stripeAccountChargesEnabled: account.charges_enabled,
      stripeAccountPayoutsEnabled: account.payouts_enabled,
      stripeAccountDetailsSubmitted: account.details_submitted,
      updatedAt: new Date(),
    });

    // Log analytics event for account update
    await logServerEvent({
      uid: userDoc.id,
      role: userData?.role || 'unknown',
      name: 'stripe_account_updated',
      props: {
        accountId,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        detailsSubmitted: account.details_submitted,
      },
    });

    logger.info('User Connect status updated', { 
      userId: userDoc.id, 
      accountId,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled 
    });

  } catch (error) {
    logger.error('Error handling account.updated:', error);
  }
}

// ========================================
// DISPUTE SYSTEM FUNCTIONS
// ========================================

/**
 * Callable function for customers to open disputes
 */
export const openDisputeCF = onCall(
  { region },
  openDispute
);

/**
 * Callable function to add evidence to disputes
 */
export const addEvidenceCF = onCall(
  { region },
  addEvidence
);

/**
 * Callable function for admins to resolve disputes
 */
export const resolveDisputeCF = onCall(
  { region },
  resolveDispute
);

/**
 * Scheduled function to handle dispute expiry
 * Runs every hour to check for expired disputes
 */
export const expireDisputesCF = onSchedule(
  {
    region,
    schedule: '0 * * * *', // Every hour
    timeZone: 'Europe/Berlin'
  },
  async () => {
    try {
      await expireDisputes();
    } catch (error) {
      logger.error('Error in scheduled dispute expiry:', error);
    }
  }
);

/**
 * Scheduled function to remind moderators of pending disputes
 * Runs every 6 hours during business hours
 */
export const remindModerationCF = onSchedule(
  {
    region,
    schedule: '0 8,14,20 * * *', // 8am, 2pm, 8pm
    timeZone: 'Europe/Berlin'
  },
  async () => {
    try {
      await remindModeration();
    } catch (error) {
      logger.error('Error in moderation reminder:', error);
    }
  }
);

// ========================================
// ADMIN & HEALTH SYSTEM FUNCTIONS
// ========================================

/**
 * Callable function for admins to set pro flags (soft/hard ban)
 */
export const setFlagsCF = onCall(
  { region },
  setFlags
);

/**
 * Callable function for admins to add badges to pros
 */
export const addBadgeCF = onCall(
  { region },
  addBadge
);

/**
 * Callable function for admins to remove badges from pros
 */
export const removeBadgeCF = onCall(
  { region },
  removeBadge
);

/**
 * Callable function for admins to recalculate health scores
 */
export const recalcHealthCF = onCall(
  { region },
  recalcHealth
);

/**
 * Scheduled function to recalculate health scores nightly
 * Runs daily at 2 AM Berlin time
 */
export const recalcHealthNightlyCF = onSchedule(
  {
    region,
    schedule: '0 2 * * *', // Daily at 2 AM
    timeZone: 'Europe/Berlin'
  },
  async () => {
    try {
      await recalcHealthNightly();
    } catch (error) {
      logger.error('Error in nightly health recalculation:', error);
    }
  }
);

/**
 * Callable function for admins to export data as CSV
 */
export const exportCsvCF = onCall(
  { region },
  exportCsv
);

/**
 * Callable function for Pro users to export their own transfers as CSV
 */
export const exportMyTransfersCsvCF = onCall(
  { region },
  exportMyTransfersCsv
);

// ==================== LEGAL FUNCTIONS ====================

/**
 * Callable function for admins to publish legal documents
 */
export const publishLegalDocCF = onCall(
  { region },
  publishLegalDoc
);

/**
 * Callable function to get legal documents (public read)
 */
export const getLegalDocCF = onCall(
  { region },
  getLegalDoc
);

/**
 * Callable function to set user consent (authenticated users)
 */
export const setUserConsentCF = onCall(
  { region },
  setUserConsent
);

/**
 * Callable function to get user consent (authenticated users for own data, admins for any)
 */
export const getUserConsentCF = onCall(
  { region },
  getUserConsent
);

/**
 * Callable function for admins to get legal compliance statistics
 */
export const getLegalStatsCF = onCall(
  { region },
  getLegalStats
);

export const updateLegalVersionsCF = onCall(
  { region },
  updateLegalVersions
);

// ==================== REVIEWS FUNCTIONS ====================

/**
 * Callable function to submit a review for a completed job
 */
export const submitReviewCF = onCall(
  { region },
  async (request) => {
    const { auth, data } = request;

    // Check if user is authenticated
    if (!auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const { jobId, paymentId, rating, comment } = data;
    if (!jobId || !paymentId || !rating) {
      throw new HttpsError('invalid-argument', 'jobId, paymentId, and rating are required');
    }

    try {
      // Validate the review
      const validation = reviewsService.validateReview({ jobId, paymentId, rating, comment: comment || '' });
      if (!validation.isValid) {
        throw new HttpsError('invalid-argument', validation.errors.join(', '));
      }

      const result = await reviewsService.submitReview({
        request: { jobId, paymentId, rating, comment: comment || '' },
        userId: auth.uid,
      });

      return { success: true, ...result };
    } catch (error) {
      logger.error('Error in submitReviewCF:', error);
      
      if (error instanceof Error) {
        throw new HttpsError('internal', error.message);
      }
      
      throw new HttpsError('internal', 'An unknown error occurred');
    }
  }
);

/**
 * Callable function for admins to moderate reviews
 */
export const moderateReviewCF = onCall(
  { region },
  async (request) => {
    const { auth, data } = request;

    // Check if user is authenticated
    if (!auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }
    await enforceAdminRole(auth);

    const adminUid = auth.uid;
    const { reviewId, action, reason } = data;
    if (!reviewId || !action) {
      throw new HttpsError('invalid-argument', 'reviewId and action are required');
    }

    if (!['visible', 'hidden', 'flagged'].includes(action)) {
      throw new HttpsError('invalid-argument', 'action must be visible, hidden, or flagged');
    }

    try {
      await reviewsService.moderateReview({
        request: { reviewId, action, reason },
        adminUid,
        auth,
      });

      return { success: true };
    } catch (error) {
      logger.error('Error in moderateReviewCF:', error);
      
      if (error instanceof Error) {
        throw new HttpsError('internal', error.message);
      }
      
      throw new HttpsError('internal', 'An unknown error occurred');
    }
  }
);

/**
 * Callable function to check if user has reviewed a job
 */
export const hasReviewedJobCF = onCall(
  { region },
  async (request) => {
    const { auth, data } = request;

    // Check if user is authenticated
    if (!auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const { jobId } = data;
    if (!jobId) {
      throw new HttpsError('invalid-argument', 'jobId is required');
    }

    try {
      const hasReviewed = await reviewsService.hasReviewedJob({
        jobId,
        userId: auth.uid,
      });

      return { hasReviewed };
    } catch (error) {
      logger.error('Error in hasReviewedJobCF:', error);
      
      if (error instanceof Error) {
        throw new HttpsError('internal', error.message);
      }
      
      throw new HttpsError('internal', 'An unknown error occurred');
    }
  }
);

/**
 * Callable function to get pro rating aggregate
 */
export const getProRatingAggregateCF = onCall(
  { region },
  async (request) => {
    const { data } = request;

    const { proUid } = data;
    if (!proUid) {
      throw new HttpsError('invalid-argument', 'proUid is required');
    }

    try {
      const aggregate = await reviewsService.getProRatingAggregate(proUid);
      return { aggregate };
    } catch (error) {
      logger.error('Error in getProRatingAggregateCF:', error);
      
      if (error instanceof Error) {
        throw new HttpsError('internal', error.message);
      }
      
      throw new HttpsError('internal', 'An unknown error occurred');
    }
  }
);

// Export analytics functions
export { aggregateDaily } from './analytics/aggregation';
export { exportAnalyticsCsv } from './analytics/exports';

// Export location functions (PG-14)

// ============================================================================
// PG-15: DATA RETENTION & GDPR COMPLIANCE
// ============================================================================

/**
 * Scheduled function to clean up old personal data for GDPR compliance
 * Runs daily at 2 AM UTC (3 AM CET)
 */
export const dataRetentionCleanup = onSchedule(
  {
    schedule: '0 2 * * *', // Daily at 2 AM UTC
    timeZone: 'UTC',
    region,
  },
  async () => {
    logger.info('Starting scheduled data retention cleanup');
    
    try {
      const result = await runDataRetentionCleanup();
      logger.info('Data retention cleanup completed:', result);
    } catch (error) {
      logger.error('Data retention cleanup failed:', error);
      throw error;
    }
  }
);

/**
 * Callable function for admin to manually trigger data retention cleanup
 */
export const triggerDataRetentionCF = onCall(
  { region },
  async (request) => {
    const { auth } = request;

    // Check if user is authenticated and is admin
    if (!auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    try {
      await enforceAdminRole(auth);
      const adminUid = auth.uid;

      logger.info(`Admin ${adminUid} triggered manual data retention cleanup`);
      
      const result = await runDataRetentionCleanup();
      
      logger.info('Manual data retention cleanup completed:', result);
      
      return {
        success: true,
        result,
        triggeredBy: adminUid,
        triggeredAt: new Date().toISOString(),
      };

    } catch (error) {
      logger.error('Manual data retention cleanup failed:', error);
      
      if (error instanceof HttpsError) {
        throw error;
      }
      
      throw new HttpsError('internal', 'Data retention cleanup failed');
    }
  }
);

/**
 * Callable function to initialize or update retention configuration
 */
export const updateRetentionConfigCF = onCall(
  { region },
  async (request) => {
    const { auth, data } = request;

    // Check if user is authenticated and is admin
    if (!auth) {
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    try {
      await enforceAdminRole(auth);
      const adminUid = auth.uid;

      const { jobsPrivateRetentionMonths, chatRetentionMonths, disputeRetentionMonths } = data;

      // Validate input
      if (
        typeof jobsPrivateRetentionMonths !== 'number' ||
        typeof chatRetentionMonths !== 'number' ||
        typeof disputeRetentionMonths !== 'number' ||
        jobsPrivateRetentionMonths < 1 ||
        chatRetentionMonths < 1 ||
        disputeRetentionMonths < 1
      ) {
        throw new HttpsError('invalid-argument', 'Retention periods must be positive numbers');
      }

      // Update retention configuration
      await initializeRetentionConfig();
      
      const db = getFirestore();
      await db.collection('adminSettings').doc('retention').update({
        jobsPrivateRetentionMonths,
        chatRetentionMonths,
        disputeRetentionMonths,
        updatedAt: new Date(),
        updatedBy: adminUid,
      });

      logger.info(`Admin ${adminUid} updated retention configuration`, {
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

    } catch (error) {
      logger.error('Failed to update retention configuration:', error);
      
      if (error instanceof HttpsError) {
        throw error;
      }
      
      throw new HttpsError('internal', 'Failed to update retention configuration');
    }
  }
);
export { setJobAddressCF, getEtaCF, refreshJobGeocodeCF } from './lib/location';

// PG-16: Live Location Cleanup Functions
export { cleanupLiveLocations, triggerLiveLocationCleanupCF, cleanupJobLiveLocationsCF } from './lib/liveLocationCleanup';

// PG-17/18: Pricing & Advanced Job Features
export { createPaymentIntentCF, generateRecurringJobsCF, notifyExpressJobsCF } from './lib/pricing';

// PG-17: Document Verification System
// Document verification functions
export const reviewDocumentCF = onCall({ region }, reviewDocument);
export const getPendingDocumentsCF = onCall({ region }, getPendingDocuments);
export const getDocumentStatsCF = onCall({ region }, getDocumentStats);

// PG-17/18: Admin Services (Oficializa-te)

// KPI Analytics Functions
export const getKpiSummaryCF = onCall({ region }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'User must be authenticated');
  }
  await enforceAdminRole(request.auth);
  
  const { startDate, endDate } = request.data;
  return await getKpiSummary(startDate, endDate);
});

export const getAdvancedMetricsCF = onCall({ region }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'User must be authenticated');
  }
  await enforceAdminRole(request.auth);
  
  return await calculateAdvancedMetrics();
});
export { createAdminServiceCheckout, handleAdminServiceWebhook, updateAdminServiceStatus } from './lib/adminServices';