import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';

/**
 * Daily analytics aggregation function
 * Runs every 15 minutes to aggregate current day data idempotently
 */
export const aggregateDaily = onSchedule({
  schedule: 'every 15 minutes',
  timeZone: 'Europe/Berlin',
  region: 'europe-west1',
}, async () => {
  try {
    logger.info('🔄 ANALYTICS: Starting daily aggregation');
    
    const db = getFirestore();
    const now = new Date();
    
    // Get current UTC date for aggregation
    const utcDate = new Date(now.getTime());
    const dateId = formatDateId(utcDate);
    
    // Define start and end of day in UTC
    const startOfDay = new Date(utcDate);
    startOfDay.setUTCHours(0, 0, 0, 0);
    
    const endOfDay = new Date(utcDate);
    endOfDay.setUTCHours(23, 59, 59, 999);
    
    logger.info('📊 ANALYTICS: Aggregating for date', { 
      dateId, 
      startOfDay: startOfDay.toISOString(), 
      endOfDay: endOfDay.toISOString() 
    });
    
    // Query events for the day
    const eventsQuery = db.collection('analyticsEvents')
      .where('ts', '>=', Timestamp.fromDate(startOfDay))
      .where('ts', '<=', Timestamp.fromDate(endOfDay));
    
    const eventsSnapshot = await eventsQuery.get();
    
    if (eventsSnapshot.empty) {
      logger.info('📊 ANALYTICS: No events found for aggregation');
      return;
    }
    
    logger.info('📊 ANALYTICS: Processing events', { count: eventsSnapshot.size });
    
    // Initialize KPIs
    const kpis = {
      jobsCreated: 0,
      leadsCreated: 0,
      leadsAccepted: 0,
      paymentsCapturedEur: 0,
      paymentsReleasedEur: 0,
      refundsEur: 0,
      chatMessages: 0,
      activePros: new Set<string>(),
      activeCustomers: new Set<string>(),
      newUsers: new Set<string>(),
      disputesOpened: 0,
      disputesResolved: 0,
      ratings: [] as number[],
      pushDelivered: 0,
      pushOpened: 0,
    };
    
    // Process each event
    eventsSnapshot.docs.forEach(doc => {
      const event = doc.data();
      const { name, props, uid, role } = event;
      
      // Track active users by role
      if (uid && role) {
        if (role === 'pro') {
          kpis.activePros.add(uid);
        } else if (role === 'customer') {
          kpis.activeCustomers.add(uid);
        }
      }
      
      // Count events based on name
      processEventForKpis(name, props, uid, kpis);
    });
    
    // Calculate derived metrics
    const avgRating = kpis.ratings.length > 0 
      ? kpis.ratings.reduce((sum, rating) => sum + rating, 0) / kpis.ratings.length 
      : 0;
    
    const pushOpenRate = kpis.pushDelivered > 0 
      ? kpis.pushOpened / kpis.pushDelivered 
      : 0;
    
    // Build final KPIs object
    const finalKpis = {
      jobsCreated: kpis.jobsCreated,
      leadsCreated: kpis.leadsCreated,
      leadsAccepted: kpis.leadsAccepted,
      paymentsCapturedEur: Math.round(kpis.paymentsCapturedEur * 100) / 100, // Round to 2 decimals
      paymentsReleasedEur: Math.round(kpis.paymentsReleasedEur * 100) / 100,
      refundsEur: Math.round(kpis.refundsEur * 100) / 100,
      chatMessages: kpis.chatMessages,
      activePros: kpis.activePros.size,
      activeCustomers: kpis.activeCustomers.size,
      newUsers: kpis.newUsers.size,
      disputesOpened: kpis.disputesOpened,
      disputesResolved: kpis.disputesResolved,
      avgRating: Math.round(avgRating * 100) / 100,
      ratingsCount: kpis.ratings.length,
      pushDelivered: kpis.pushDelivered,
      pushOpened: kpis.pushOpened,
      pushOpenRate: Math.round(pushOpenRate * 10000) / 100, // Percentage with 2 decimals
    };
    
    // Write aggregated data (idempotent - overwrites if exists)
    const dailyDoc = db.collection('analyticsDaily').doc(dateId);
    await dailyDoc.set({
      kpis: finalKpis,
      updatedAt: Timestamp.fromDate(now),
    }, { merge: true });
    
    logger.info('✅ ANALYTICS: Daily aggregation completed', { 
      dateId, 
      eventsProcessed: eventsSnapshot.size,
      kpis: finalKpis,
    });
    
  } catch (error) {
    logger.error('❌ ANALYTICS: Error in daily aggregation', { error });
    throw error;
  }
});

/**
 * Process individual event for KPI calculation
 */
function processEventForKpis(name: string, props: any, uid: string | null, kpis: any) {
  switch (name) {
    case 'job_created':
      kpis.jobsCreated++;
      break;
      
    case 'lead_created':
      kpis.leadsCreated++;
      break;
      
    case 'lead_accepted':
      kpis.leadsAccepted++;
      break;
      
    case 'payment_captured':
      if (props?.amountEur && typeof props.amountEur === 'number') {
        kpis.paymentsCapturedEur += props.amountEur;
      }
      break;
      
    case 'payment_released':
      if (props?.amountEur && typeof props.amountEur === 'number') {
        kpis.paymentsReleasedEur += props.amountEur;
      }
      break;
      
    case 'payment_refunded':
      if (props?.amountEur && typeof props.amountEur === 'number') {
        kpis.refundsEur += props.amountEur;
      }
      break;
      
    case 'chat_msg_sent':
      kpis.chatMessages++;
      break;
      
    case 'signup_success':
      if (uid) {
        kpis.newUsers.add(uid);
      }
      break;
      
    case 'dispute_opened':
      kpis.disputesOpened++;
      break;
      
    case 'dispute_resolved':
      kpis.disputesResolved++;
      break;
      
    case 'review_submitted':
      if (props?.rating && typeof props.rating === 'number') {
        kpis.ratings.push(props.rating);
      }
      break;
      
    case 'push_delivered':
      kpis.pushDelivered++;
      break;
      
    case 'push_opened':
      kpis.pushOpened++;
      break;
  }
}

/**
 * Format date as yyyyMMdd for document ID
 */
function formatDateId(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Manual trigger for daily aggregation (for testing)
 */
export async function triggerDailyAggregation(targetDate?: Date) {
  const date = targetDate || new Date();
  const dateId = formatDateId(date);
  
  logger.info('🔧 ANALYTICS: Manual aggregation trigger', { dateId });
  
  // This would contain the same logic as the scheduled function
  // but can be called manually for testing or backfilling
}