/**
 * Cloud Functions for Brivida Notification System
 * 
 * Triggers notifications for various events:
 * - Lead events (new, accepted, declined)
 * - Job events (assigned, changed, cancelled)
 * - Payment events (captured, released, refunded)
 * - Dispute events (opened, response, decision)
 * - Chat message notifications
 * - Calendar reminders (24h, 1h before job)
 */

import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { GeoPoint, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { calculateEta, GOOGLE_API_KEY_SECRET, resolveGoogleApiKey } from './lib/location';
import {
  getNotificationMessage,
  NotificationTemplateKey,
  NotificationTemplateParams,
  formatJobChanges,
  LocaleCode,
} from './lib/notification_localization';

// Initialize Firebase Admin
initializeApp();
const db = getFirestore();
const messaging = getMessaging();

// Notification types enum
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

/**
 * Helper function to create notification
 */
interface NotificationOverrides {
  title?: string;
  body?: string;
}

async function createNotification(
  uid: string,
  type: string,
  templateKey: NotificationTemplateKey,
  templateParams: NotificationTemplateParams = {},
  deeplinkRoute?: string,
  relatedId?: string,
  overrides?: NotificationOverrides
) {
  try {
    // Check user preferences
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      logger.warn(`User ${uid} not found for notification`);
      return;
    }

    const userData = userDoc.data();
    const fcmToken = userData?.fcmToken;
    
    // Check if notifications are enabled for this type
    const preferences = userData?.notificationPreferences || {};
    if (!isNotificationEnabled(type, preferences)) {
      logger.info(`Notification ${type} disabled for user ${uid}`);
      return;
    }

    const userLocale = resolveUserLocale(userData);
    const message = getNotificationMessage(userLocale, templateKey, templateParams);
    const title = overrides?.title ?? message.title;
    const body = overrides?.body ?? message.body;

    // Check quiet hours
    if (isQuietTime(preferences.quietHours)) {
      logger.info(`Quiet time active for user ${uid}, skipping push notification`);
      // Still create inbox entry, just no push
    }

    // Create notification in Firestore (inbox)
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
    logger.info(`Created notification ${notificationRef.id} for user ${uid}`);

    // Send push notification if not quiet time and user has FCM token
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

  } catch (error) {
    logger.error('Error creating notification:', error);
  }
}

/**
 * Check if notification type is enabled in user preferences
 */
function isNotificationEnabled(type: string, preferences: any): boolean {
  // Default to enabled if no preferences set
  if (!preferences) return true;

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
      return true; // Chat always enabled
    default:
      return true;
  }
}

/**
 * Check if current time is within quiet hours
 */
function isQuietTime(quietHours: any): boolean {
  if (!quietHours) return false;

  const now = new Date();
  const currentTime = now.toLocaleTimeString('pt-PT', { 
    hour: '2-digit', 
    minute: '2-digit',
    timeZone: quietHours.timezone || 'Atlantic/Madeira'
  });

  const startTime = quietHours.start || '22:00';
  const endTime = quietHours.end || '07:00';

  // Handle overnight quiet hours (e.g., 22:00 to 07:00)
  if (startTime > endTime) {
    return currentTime >= startTime || currentTime <= endTime;
  } else {
    return currentTime >= startTime && currentTime <= endTime;
  }
}

/**
 * Send FCM push notification
 */
async function sendPushNotification(
  fcmToken: string,
  payload: {
    title: string;
    body: string;
    type: string;
    deeplinkRoute?: string;
    relatedId?: string;
    templateKey: NotificationTemplateKey;
    titleKey: string;
    bodyKey: string;
    locale: LocaleCode;
    placeholders: Record<string, string>;
  }
) {
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
    logger.info(`Push notification sent successfully: ${response}`);
  } catch (error) {
    logger.error('Error sending push notification:', error);
  }
}

// ================================
// LEAD EVENT TRIGGERS
// ================================

/**
 * Trigger when new lead is created
 */
export const notifyLeadCreated = onDocumentCreated(
  {
    document: 'leads/{leadId}',
    region: 'europe-west1',
    secrets: [GOOGLE_API_KEY_SECRET],
    timeoutSeconds: 120,
  },
  async (event) => {
    const lead = event.data?.data();
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

  const googleKey = resolveGoogleApiKey();
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

      logger.info('Lead notifications processed', {
        leadId,
        jobId: context.jobId,
        evaluatedPros: proProfiles.size,
        notifiedPros: notifiedCount,
      });
    } catch (error) {
      logger.error('Error notifying about new lead', { error, leadId, jobId: context.jobId });
    }
  },
);

/**
 * Trigger when lead status changes
 */
export const notifyLeadStatusChanged = onDocumentUpdated('leads/{leadId}', async (event) => {
  const beforeData = event.data?.before.data();
  const afterData = event.data?.after.data();
  
  if (!beforeData || !afterData) return;
  
  const leadId = event.params.leadId;
  const statusChanged = beforeData.status !== afterData.status;
  
  if (!statusChanged) return;

  const customerId = afterData.customerId;

  switch (afterData.status) {
    case 'accepted':
      // Notify customer that pro accepted
      if (customerId) {
        await createNotification(
          customerId,
          NotificationType.LEAD_ACCEPTED,
          'lead.accepted',
          {},
          `/leads/detail?id=${leadId}`,
          leadId
        );
      }
      break;

    case 'declined':
      // Notify customer that pro declined
      if (customerId) {
        await createNotification(
          customerId,
          NotificationType.LEAD_DECLINED,
          'lead.declined',
          {},
          `/leads/detail?id=${leadId}`,
          leadId
        );
      }
      break;
  }
});

// ================================
// JOB EVENT TRIGGERS
// ================================

/**
 * Trigger when job is created/assigned
 */
export const notifyJobAssigned = onDocumentCreated('jobs/{jobId}', async (event) => {
  const job = event.data?.data();
  if (!job) return;

  const jobId = event.params.jobId;
  const customerId = job.customerId;
  const proId = job.proId;

  // Notify customer
  if (customerId) {
    await createNotification(
      customerId,
      NotificationType.JOB_ASSIGNED,
      'job.assigned.customer',
      {
        date: (locale) =>
          formatDateInput(
            job.scheduledDateTime || job.scheduledDate || job.startDate,
            locale,
          ),
      },
      `/jobs/detail?id=${jobId}`,
      jobId
    );
  }

  // Notify professional
  if (proId) {
    await createNotification(
      proId,
      NotificationType.JOB_ASSIGNED,
      'job.assigned.pro',
      {
        date: (locale) =>
          formatDateInput(
            job.scheduledDateTime || job.scheduledDate || job.startDate,
            locale,
          ),
      },
      `/jobs/detail?id=${jobId}`,
      jobId
    );
  }
});

/**
 * Trigger when job is updated
 */
export const notifyJobChanged = onDocumentUpdated('jobs/{jobId}', async (event) => {
  const beforeData = event.data?.before.data();
  const afterData = event.data?.after.data();
  
  if (!beforeData || !afterData) return;
  
  const jobId = event.params.jobId;
  const customerId = afterData.customerId;
  const proId = afterData.proId;

  // Check for significant changes
  const dateChanged = beforeData.scheduledDate !== afterData.scheduledDate;
  const statusChanged = beforeData.status !== afterData.status;
  const addressChanged = beforeData.address !== afterData.address;

  if (dateChanged || statusChanged || addressChanged) {
    const changeKeys = getJobChangeKeys(beforeData, afterData);
    const templateParams: NotificationTemplateParams = {
      changes: (locale) => formatJobChanges(locale, changeKeys),
    };

    if (customerId) {
      await createNotification(
        customerId,
        NotificationType.JOB_CHANGED,
        'job.changed',
        templateParams,
        `/jobs/detail?id=${jobId}`,
        jobId
      );
    }

    if (proId) {
      await createNotification(
        proId,
        NotificationType.JOB_CHANGED,
        'job.changed',
        templateParams,
        `/jobs/detail?id=${jobId}`,
        jobId
      );
    }
  }

  // Handle cancellation specifically
  if (afterData.status === 'cancelled' && beforeData.status !== 'cancelled') {
    if (customerId) {
      await createNotification(
        customerId,
        NotificationType.JOB_CANCELLED,
        'job.cancelled',
        {},
        `/jobs/detail?id=${jobId}`,
        jobId
      );
    }

    if (proId) {
      await createNotification(
        proId,
        NotificationType.JOB_CANCELLED,
        'job.cancelled',
        {},
        `/jobs/detail?id=${jobId}`,
        jobId
      );
    }
  }
});

type LatLng = { lat: number; lng: number };

interface LeadNotificationContext {
  jobId: string;
  location: LatLng;
  city?: string;
  services: string[];
}

function extractLatLng(source: unknown): LatLng | null {
  if (!source) {
    return null;
  }

  if (source instanceof GeoPoint) {
    return { lat: source.latitude, lng: source.longitude };
  }

  if (typeof source === 'object') {
    const value = source as Record<string, unknown>;
    const latCandidate = (value.lat ?? value.latitude) as number | undefined;
    const lngCandidate = (value.lng ?? value.longitude) as number | undefined;

    if (typeof latCandidate === 'number' && typeof lngCandidate === 'number') {
      return { lat: latCandidate, lng: lngCandidate };
    }
  }

  return null;
}

function normalizeServiceList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function resolveLeadServices(
  lead: FirebaseFirestore.DocumentData,
  jobData: FirebaseFirestore.DocumentData,
): string[] | null {
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

async function resolveLeadContext(
  leadId: string,
  lead: FirebaseFirestore.DocumentData,
): Promise<LeadNotificationContext | null> {
  const jobId = typeof lead.jobId === 'string' ? lead.jobId : undefined;

  if (!jobId) {
    logger.warn('Lead created without jobId, skipping notifications', { leadId });
    return null;
  }

  try {
    const jobDoc = await db.collection('jobs').doc(jobId).get();

    if (!jobDoc.exists) {
      logger.warn('Job not found for lead, skipping notifications', { leadId, jobId });
      return null;
    }

    const jobData = jobDoc.data() ?? {};
    const jobPrivateDoc = await db.collection('jobsPrivate').doc(jobId).get();
    const jobPrivateData = jobPrivateDoc.data() ?? {};

    const jobLocation =
      extractLatLng(jobPrivateData.location) ||
      extractLatLng(jobData.location?.coordinates) ||
      extractLatLng(jobData.location);

    if (!jobLocation) {
      logger.warn('Job location missing, skipping lead notifications', { leadId, jobId });
      return null;
    }

    const services = resolveLeadServices(lead, jobData);
    if (!services) {
      logger.warn('Lead created without services, skipping notifications', { leadId, jobId });
      return null;
    }

    const city: string | undefined =
      jobData.addressCity || jobPrivateData.city || lead.location?.city;

    return {
      jobId,
      location: jobLocation,
      city,
      services,
    };
  } catch (error) {
    logger.error('Failed to resolve lead context', { error, leadId, jobId });
    return null;
  }
}

function resolveRadiusKm(proData: FirebaseFirestore.DocumentData): number {
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

async function resolveDistanceKm(
  proLocation: LatLng,
  jobLocation: LatLng,
  context: { canUseGoogle: boolean; leadId: string; proUid: string }
): Promise<{ distanceKm: number; source: 'google' | 'haversine' } | null> {
  let distanceKm: number | undefined;
  let source: 'google' | 'haversine' = 'haversine';

  if (context.canUseGoogle) {
    try {
      const eta = await calculateEta(
        proLocation.lat,
        proLocation.lng,
        jobLocation.lat,
        jobLocation.lng,
      );

      if (typeof eta.distanceValue === 'number' && Number.isFinite(eta.distanceValue)) {
        distanceKm = eta.distanceValue / 1000;
        source = 'google';
      }
    } catch (error) {
      logger.warn('Distance Matrix lookup failed, using fallback distance', {
        leadId: context.leadId,
        proUid: context.proUid,
        error,
      });
    }
  }

  distanceKm ??= calculateHaversineDistance(proLocation, jobLocation);

  if (!Number.isFinite(distanceKm)) {
    logger.warn('Calculated distance is invalid, skipping pro', {
      leadId: context.leadId,
      proUid: context.proUid,
    });
    return null;
  }

  return { distanceKm, source };
}

async function notifyProCandidateForLead(params: {
  leadId: string;
  lead: FirebaseFirestore.DocumentData;
  proDoc: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>;
  context: LeadNotificationContext;
  canUseGoogle: boolean;
}): Promise<boolean> {
  const { leadId, lead, proDoc, context, canUseGoogle } = params;
  const proData = proDoc.data() ?? {};
  const proUid = proDoc.id;

  const proLocation = extractLatLng(proData.location);
  if (!proLocation) {
    logger.debug('Skipping pro without location', { leadId, proUid });
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
    logger.debug('Pro outside service radius', {
      leadId,
      proUid,
      distanceKm: Math.round(distanceKm * 10) / 10,
      serviceRadiusKm,
      distanceSource: source,
    });
    return false;
  }

  await createNotification(
    proUid,
    NotificationType.LEAD_NEW,
        'lead.new',
        {
          city: buildCityParam(context.city ?? lead.location?.city),
        },
    `/leads/detail?id=${leadId}`,
    leadId,
  );

  return true;
}

function calculateHaversineDistance(origin: LatLng, destination: LatLng): number {
  const earthRadiusKm = 6371;
  const dLat = degToRad(destination.lat - origin.lat);
  const dLng = degToRad(destination.lng - origin.lng);

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(degToRad(origin.lat)) * Math.cos(degToRad(destination.lat)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function degToRad(value: number): number {
  return value * (Math.PI / 180);
}

// ================================
// PAYMENT EVENT TRIGGERS
// ================================

/**
 * Trigger when payment is captured
 */
export const notifyPaymentCaptured = onDocumentCreated('payments/{paymentId}', async (event) => {
  const payment = event.data?.data();
  if (!payment) return;

  const paymentId = event.params.paymentId;
  const customerId = payment.customerId;
  const amountRaw = typeof payment.amount === 'number' ? payment.amount : 0;
  const amount = amountRaw / 100;

  if (customerId) {
    await createNotification(
      customerId,
      NotificationType.PAYMENT_CAPTURED,
      'payment.captured',
      {
        amountNumeric: amount,
      },
      '/payments',
      paymentId
    );
  }
});

/**
 * Trigger when payment is released to pro
 */
export const notifyPaymentReleased = onDocumentUpdated('payments/{paymentId}', async (event) => {
  const beforeData = event.data?.before.data();
  const afterData = event.data?.after.data();
  
  if (!beforeData || !afterData) return;
  
  const statusChanged = beforeData.status !== afterData.status;
  if (!statusChanged || afterData.status !== 'released') return;

  const paymentId = event.params.paymentId;
  const proId = afterData.proId;
  const amountRaw = typeof afterData.amount === 'number' ? afterData.amount : 0;
  const amount = amountRaw / 100;

  if (proId) {
    await createNotification(
      proId,
      NotificationType.PAYMENT_RELEASED,
      'payment.released',
      {
        amountNumeric: amount,
      },
      '/payments',
      paymentId
    );
  }
});

// ================================
// CHAT MESSAGE TRIGGERS
// ================================

/**
 * Trigger when new chat message is sent
 */
export const notifyChatMessage = onDocumentCreated('chats/{chatId}/messages/{messageId}', async (event) => {
  const message = event.data?.data();
  if (!message) return;

  const chatId = event.params.chatId;
  const senderId = message.senderId;

  // Get chat participants
  const chatDoc = await db.collection('chats').doc(chatId).get();
  if (!chatDoc.exists) return;

  const chatData = chatDoc.data();
  const participants = chatData?.participants || [];

  // Notify all participants except sender
  for (const participantId of participants) {
    if (participantId !== senderId) {
      const preview = getMessagePreview(message.text);
      await createNotification(
        participantId,
        NotificationType.CHAT_MESSAGE,
        'chat.newMessage',
        preview ? { preview } : {},
        `/chat?id=${chatId}`,
        chatId,
        preview ? { body: preview } : undefined
      );
    }
  }
});

// ================================
// SCHEDULED REMINDERS
// ================================

/**
 * Daily job to send 24-hour reminders
 */
export const send24hReminders = onSchedule('0 9 * * *', async () => {
  logger.info('Running 24-hour reminder job');

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  const dayAfter = new Date(tomorrow);
  dayAfter.setDate(dayAfter.getDate() + 1);

  // Get jobs scheduled for tomorrow
  const jobsQuery = db.collection('jobs')
    .where('scheduledDate', '>=', tomorrow)
    .where('scheduledDate', '<', dayAfter)
    .where('status', '==', 'confirmed');

  const jobsSnapshot = await jobsQuery.get();

  for (const jobDoc of jobsSnapshot.docs) {
    const job = jobDoc.data();
    const jobId = jobDoc.id;

    // Send reminder to customer
    if (job.customerId) {
      await createNotification(
        job.customerId,
        NotificationType.REMINDER_24H,
        'job.reminder24h.customer',
        {
          time: (locale) => formatTimeInput(job.scheduledTime || job.scheduledDateTime, locale),
        },
        `/jobs/detail?id=${jobId}`,
        jobId
      );
    }

    // Send reminder to professional
    if (job.proId) {
      await createNotification(
        job.proId,
        NotificationType.REMINDER_24H,
        'job.reminder24h.pro',
        {
          time: (locale) => formatTimeInput(job.scheduledTime || job.scheduledDateTime, locale),
        },
        `/jobs/detail?id=${jobId}`,
        jobId
      );
    }
  }

  logger.info(`Sent 24h reminders for ${jobsSnapshot.size} jobs`);
});

/**
 * Hourly job to send 1-hour reminders
 */
export const send1hReminders = onSchedule('0 * * * *', async () => {
  logger.info('Running 1-hour reminder job');

  const now = new Date();
  const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);

  // Get jobs starting in the next hour
  const jobsQuery = db.collection('jobs')
    .where('scheduledDateTime', '>=', now)
    .where('scheduledDateTime', '<=', oneHourLater)
    .where('status', '==', 'confirmed');

  const jobsSnapshot = await jobsQuery.get();

  for (const jobDoc of jobsSnapshot.docs) {
    const job = jobDoc.data();
    const jobId = jobDoc.id;

    // Send reminder to customer
    if (job.customerId) {
      await createNotification(
        job.customerId,
        NotificationType.REMINDER_1H,
        'job.reminder1h.customer',
        {},
        `/jobs/detail?id=${jobId}`,
        jobId
      );
    }

    // Send reminder to professional
    if (job.proId) {
      await createNotification(
        job.proId,
        NotificationType.REMINDER_1H,
        'job.reminder1h.pro',
        {},
        `/jobs/detail?id=${jobId}`,
        jobId
      );
    }
  }

  logger.info(`Sent 1h reminders for ${jobsSnapshot.size} jobs`);
});

// ================================
// DISPUTE EVENT TRIGGERS
// ================================

/**
 * Trigger when dispute is opened
 */
export const notifyDisputeOpened = onDocumentCreated('disputes/{disputeId}', async (event) => {
  const dispute = event.data?.data();
  if (!dispute) return;

  const disputeId = event.params.disputeId;
  const customerId = dispute.customerId;
  const proId = dispute.proId;
  const openedBy = dispute.openedBy;

  // Notify the other party
  const otherPartyId = openedBy === customerId ? proId : customerId;

  if (otherPartyId) {
    await createNotification(
      otherPartyId,
      NotificationType.DISPUTE_OPENED,
      'dispute.opened',
      {},
      `/disputes/detail?id=${disputeId}`,
      disputeId
    );
  }
});

/**
 * Trigger when dispute response is added
 */
export const notifyDisputeResponse = onDocumentUpdated('disputes/{disputeId}', async (event) => {
  const beforeData = event.data?.before.data();
  const afterData = event.data?.after.data();
  
  if (!beforeData || !afterData) return;
  
  // Check if new response was added
  const beforeResponses = beforeData.responses?.length || 0;
  const afterResponses = afterData.responses?.length || 0;
  
  if (afterResponses <= beforeResponses) return;

  const disputeId = event.params.disputeId;
  const customerId = afterData.customerId;
  const proId = afterData.proId;
  const lastResponse = afterData.responses[afterResponses - 1];
  const responderType = lastResponse.responderType;

  // Notify the other party
  const otherPartyId = responderType === 'customer' ? proId : customerId;

  if (otherPartyId) {
    await createNotification(
      otherPartyId,
      NotificationType.DISPUTE_RESPONSE,
      'dispute.response',
      {},
      `/disputes/detail?id=${disputeId}`,
      disputeId
    );
  }
});

logger.info('✅ Notification Cloud Functions loaded successfully');

function resolveUserLocale(userData: FirebaseFirestore.DocumentData | undefined): string | undefined {
  if (!userData || typeof userData !== 'object') {
    return undefined;
  }

  const candidates = [
    userData.locale,
    userData.preferredLocale,
    userData.settings?.locale,
    userData.profile?.locale,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

function fallbackCityLabel(locale: LocaleCode): string {
  const map: Record<LocaleCode, string> = {
    de: 'Ihrer Nähe',
    en: 'your area',
    es: 'tu zona',
    fr: 'votre secteur',
    pt: 'sua região',
  };
  return map[locale] ?? map.en;
}

function buildCityParam(cityValue: unknown): (locale: LocaleCode) => string {
  return (locale) => {
    if (typeof cityValue === 'string' && cityValue.trim().length > 0) {
      return cityValue.trim();
    }
    return fallbackCityLabel(locale);
  };
}

function formatDateInput(value: unknown, locale: LocaleCode): string {
  const date = convertToDate(value);
  if (date) {
    try {
      return new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(date);
    } catch (error) {
      logger.warn('Date formatting failed, using ISO fallback', { error });
      return date.toISOString();
    }
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  return fallbackDateLabel(locale);
}

function formatTimeInput(value: unknown, locale: LocaleCode): string {
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
    } catch (error) {
      logger.warn('Time formatting failed, using ISO substring', { error });
      return date.toISOString();
    }
  }

  return fallbackTimeLabel(locale);
}

function convertToDate(value: unknown): Date | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (value instanceof Timestamp) {
    return value.toDate();
  }

  if (typeof value === 'object' && 'seconds' in (value as Record<string, unknown>)) {
    const seconds = (value as { seconds: number }).seconds;
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

function fallbackDateLabel(locale: LocaleCode): string {
  const map: Record<LocaleCode, string> = {
    de: 'Termin folgt',
    en: 'Date to be confirmed',
    es: 'Fecha por confirmar',
    fr: 'Date à confirmer',
    pt: 'Data a confirmar',
  };
  return map[locale] ?? map.en;
}

function fallbackTimeLabel(locale: LocaleCode): string {
  const map: Record<LocaleCode, string> = {
    de: 'Zeit folgt',
    en: 'Time to be confirmed',
    es: 'Hora por confirmar',
    fr: 'Heure à confirmer',
    pt: 'Horário a confirmar',
  };
  return map[locale] ?? map.en;
}

function getMessagePreview(text: unknown): string | undefined {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return undefined;
  }

  const trimmed = text.trim();
  if (trimmed.length <= 120) {
    return trimmed;
  }

  return `${trimmed.slice(0, 117)}...`;
}

function getJobChangeKeys(
  beforeData: FirebaseFirestore.DocumentData,
  afterData: FirebaseFirestore.DocumentData
): string[] {
  const changes: string[] = [];

  if (beforeData.scheduledDate?.toString() !== afterData.scheduledDate?.toString()) {
    changes.push('date');
  }

  if (beforeData.address?.toString() !== afterData.address?.toString()) {
    changes.push('address');
  }

  if (beforeData.status !== afterData.status) {
    changes.push('status');
  }

  return changes;
}