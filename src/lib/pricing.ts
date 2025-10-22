/**
 * PG-18: Cloud Functions for Pricing & Payment Logic
 * Uses calc.ts library for all pricing calculations
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { computeAmounts, validatePricingInputs, type ExtraId, type JobCategory } from './calc';

const db = admin.firestore();

interface CreatePaymentIntentRequest {
  jobId: string;
  customerUid: string;
  category: JobCategory;
  baseHours: number;
  extras: ExtraId[];
  materialProvidedByPro: boolean;
  isExpress: boolean;
  isRecurring: boolean;
  occurrenceIndex: number;
}

/**
 * PG-18: Create payment intent with advanced pricing calculation
 * Captures payment immediately for escrow system
 */
export const createPaymentIntentCF = functions
  .region('europe-west1')
  .https.onCall(async (data: CreatePaymentIntentRequest, context) => {
    if (!context.auth?.uid) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }

    if (context.auth.uid !== data.customerUid) {
      throw new functions.https.HttpsError('permission-denied', 'Can only create payment for yourself');
    }

    try {
      // Validate inputs
      const validation = validatePricingInputs({
        category: data.category,
        extras: data.extras,
        occurrenceIndex: data.occurrenceIndex,
      });

      if (!validation.valid) {
        throw new functions.https.HttpsError('invalid-argument', validation.errors.join(', ') || 'Invalid pricing inputs');
      }

      // Calculate pricing
      const amounts = computeAmounts({
        baseHours: data.baseHours,
        extras: data.extras,
        materialProvidedByPro: data.materialProvidedByPro,
        isExpress: data.isExpress,
        occurrenceIndex: data.occurrenceIndex,
      });

      // Get customer info
      const customerDoc = await db.collection('users').doc(data.customerUid).get();
      if (!customerDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'Customer not found');
      }

      const { default: Stripe } = await import('stripe');
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
        apiVersion: '2025-08-27.basil',
      });

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amounts.amountTotal * 100), // Convert to cents
        currency: 'eur',
        capture_method: 'automatic', // Immediate capture for escrow
        metadata: {
          jobId: data.jobId,
          customerUid: data.customerUid,
          category: data.category,
          isExpress: data.isExpress.toString(),
          isRecurring: data.isRecurring.toString(),
          occurrenceIndex: data.occurrenceIndex.toString(),
          totalHours: amounts.totalHours.toString(),
          baseAmount: amounts.baseAmount.toString(),
          materialAmount: amounts.materialAmount.toString(),
          platformFee: amounts.platformEur.toString(),
          proAmount: amounts.proEur.toString(),
        },
        description: `Brivida Job ${data.jobId} - ${data.category} (${amounts.totalHours}h)`,
      });

      // Store payment record
      await db.collection('payments').doc(paymentIntent.id).set({
        id: paymentIntent.id,
        jobId: data.jobId,
        customerUid: data.customerUid,
        status: 'pending',
        amounts,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Update job with payment info
      await db.collection('jobs').doc(data.jobId).update({
        paymentId: paymentIntent.id,
        paymentStatus: 'pending',
        paymentCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
        // Store calculated amounts in job
        baseHours: amounts.totalHours,
        extrasHours: amounts.extrasHours,
        materialFeeEur: amounts.materialAmount,
        budget: amounts.amountTotal,
        paidAmount: amounts.amountTotal,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        clientSecret: paymentIntent.client_secret,
        amounts,
      };
    } catch (error) {
      console.error('Error creating payment intent:', error);
      throw new functions.https.HttpsError('internal', 'Failed to create payment intent');
    }
  });

/**
 * PG-17: Generate recurring jobs automatically
 * Called after successful payment of initial job
 */
export const generateRecurringJobsCF = functions
  .region('europe-west1')
  .https.onCall(async (data: { jobId: string; occurrences: number }, context) => {
    if (!context.auth?.uid) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }

    try {
      const jobDoc = await db.collection('jobs').doc(data.jobId).get();
      if (!jobDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'Job not found');
      }

      const job = jobDoc.data()!;
      
      // Verify user owns this job
      if (job.customerUid !== context.auth.uid) {
        throw new functions.https.HttpsError('permission-denied', 'Not your job');
      }

      // Check if job has recurrence
      if (!job.recurrence || job.recurrence.type === 'none') {
        throw new functions.https.HttpsError('invalid-argument', 'Job is not recurring');
      }

      const batch = db.batch();
      const recurringJobs = [];
      
      // Generate specified number of recurring jobs
      for (let i = 1; i <= data.occurrences; i++) {
        const nextDate = new Date(job.window.start.toDate());
        nextDate.setDate(nextDate.getDate() + (job.recurrence.intervalDays * i));

        const recurringJobId = db.collection('jobs').doc().id;
        const recurringJob = {
          ...job,
          id: recurringJobId,
          parentJobId: data.jobId,
          occurrenceIndex: i + 1,
          window: {
            start: admin.firestore.Timestamp.fromDate(nextDate),
            end: admin.firestore.Timestamp.fromDate(new Date(nextDate.getTime() + (job.window.end.toDate().getTime() - job.window.start.toDate().getTime()))),
          },
          status: 'pending',
          paymentStatus: 'none',
          paymentId: null,
          assignedProUid: null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        batch.set(db.collection('jobs').doc(recurringJobId), recurringJob);
        recurringJobs.push(recurringJob);
      }

      await batch.commit();

      // Update parent job to mark as recurring series created
      await db.collection('jobs').doc(data.jobId).update({
        recurringSeriesGenerated: true,
        recurringJobsCount: data.occurrences,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        success: true,
        generatedJobs: recurringJobs.length,
        nextDates: recurringJobs.map(job => job.window.start.toDate().toISOString()),
      };
    } catch (error) {
      console.error('Error generating recurring jobs:', error);
      throw new functions.https.HttpsError('internal', 'Failed to generate recurring jobs');
    }
  });

/**
 * PG-17: Send immediate notifications for express jobs
 * Enhanced matching for urgent bookings
 */
export const notifyExpressJobsCF = functions
  .region('europe-west1')
  .firestore.document('jobs/{jobId}')
  .onCreate(async (snap) => {
    const job = snap.data();
    
    // Only process express jobs
    if (!job.isExpress) {
      return;
    }

    try {
      // Find nearby pros (within 20km for express)
      const prosQuery = await db.collection('proProfiles')
        .where('isActive', '==', true)
        .where('acceptsExpressJobs', '==', true)
        .get();

      const notifications = [];
      
      for (const proDoc of prosQuery.docs) {
        const pro = proDoc.data();
        
        // Check if pro supports required services
        const supportsServices = job.services.every((service: string) => 
          pro.services?.includes(service)
        );
        
        if (!supportsServices) continue;

        // Get pro's FCM token
        const userDoc = await db.collection('users').doc(proDoc.id).get();
        const user = userDoc.data();
        
        if (!user?.fcmToken) continue;

        // Send express notification
        const message = {
          token: user.fcmToken,
          notification: {
            title: '🚨 Express-Auftrag verfügbar!',
            body: `${job.category}-Reinigung (${job.baseHours}h) - +20% Express-Bonus!`,
          },
          data: {
            type: 'express_job',
            jobId: snap.id,
            category: job.category,
            hours: job.baseHours.toString(),
            bonus: 'express_20_percent',
          },
          android: {
            priority: 'high' as const,
            notification: {
              channelId: 'express_jobs',
              priority: 'high' as const,
            },
          },
          apns: {
            headers: {
              'apns-priority': '10',
            },
            payload: {
              aps: {
                badge: 1,
                sound: 'express_alert.caf',
              },
            },
          },
        };

        notifications.push(admin.messaging().send(message));
      }

      // Send all notifications
      if (notifications.length > 0) {
        await Promise.allSettled(notifications);
        console.log(`Sent ${notifications.length} express job notifications for job ${snap.id}`);
      }

      // Update job with notification stats
      await snap.ref.update({
        expressNotificationsSent: notifications.length,
        expressNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    } catch (error) {
      console.error('Error sending express notifications:', error);
    }
  });