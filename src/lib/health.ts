import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { getDb } from './firestore';
import { logger } from 'firebase-functions/v2';
import { enforceAdminRole } from './auth';

// ========================================
// HEALTH SCORE CALCULATION
// ========================================

interface HealthMetrics {
  noShowRate: number;     // 0-1
  cancelRate: number;     // 0-1  
  avgResponseMins: number; // minutes
  inAppRatio: number;     // 0-1
  ratingAvg: number;      // 0-5
  ratingCount: number;    // count
}

interface HealthCalculationResult {
  score: number;
  metrics: HealthMetrics;
  badges: string[];
}

export async function calculateHealthScore(proUid: string): Promise<HealthCalculationResult> {
  try {
    logger.info('🔥 HEALTH: Calculating health score', { proUid });

    // Get all data needed for calculation
    const [
      abuseEvents,
      reviews,
      messages,
      jobs
    ] = await Promise.all([
      getAbuseEvents(proUid),
      getReviews(proUid), 
      getResponseTimes(proUid),
      getJobStats(proUid)
    ]);

    // Calculate individual metrics
    const metrics: HealthMetrics = {
      noShowRate: calculateNoShowRate(abuseEvents, jobs.total),
      cancelRate: calculateCancelRate(abuseEvents, jobs.total),
      avgResponseMins: calculateAvgResponseTime(messages),
      inAppRatio: calculateInAppRatio(abuseEvents, jobs.total),
      ratingAvg: reviews.averageRating,
      ratingCount: reviews.totalCount
    };

    // Calculate component scores (0-100 each)
    const noShowScore = Math.max(0, 100 * (1 - metrics.noShowRate));
    const cancelScore = Math.max(0, 100 * (1 - metrics.cancelRate));
    const responseScore = Math.max(0, 100 * (1 - metrics.avgResponseMins / 120)); // 120min = 0 points
    const inAppScore = Math.min(100, 100 * metrics.inAppRatio);
    const ratingScore = metrics.ratingAvg * 20; // 0-5 -> 0-100
    const countScore = Math.min(100, 5 * Math.log(1 + metrics.ratingCount)); // log scaling

    // Weighted final score
    const finalScore = Math.round(
      0.30 * noShowScore +
      0.15 * cancelScore +
      0.15 * responseScore +
      0.15 * inAppScore +
      0.20 * ratingScore +
      0.05 * countScore
    );

    // Determine auto-badges
    const badges = calculateAutoBadges(metrics);

    logger.info('✅ HEALTH: Health score calculated', { 
      proUid, 
      finalScore, 
      metrics, 
      badges 
    });

    return {
      score: finalScore,
      metrics,
      badges
    };

  } catch (error) {
    logger.error('❌ HEALTH: Error calculating health score', { error, proUid });
    throw error;
  }
}

// ========================================
// METRIC CALCULATIONS
// ========================================

async function getAbuseEvents(proUid: string) {
  const db = getDb();
  const snapshot = await db.collection('abuseEvents')
    .where('userUid', '==', proUid)
    .get();

  const events: any[] = [];
  snapshot.docs.forEach(doc => {
    events.push({ id: doc.id, ...doc.data() });
  });

  return events;
}

async function getReviews(proUid: string) {
  const db = getDb();
  const snapshot = await db.collection('reviews')
    .where('proUid', '==', proUid)
    .get();

  let totalRating = 0;
  let count = 0;

  snapshot.docs.forEach(doc => {
    const data = doc.data();
    totalRating += data.rating || 0;
    count++;
  });

  return {
    averageRating: count > 0 ? totalRating / count : 0,
    totalCount: count
  };
}

async function getResponseTimes(proUid: string) {
  const db = getDb();
  
  // Get chats where pro is involved
  const chatsSnapshot = await db.collection('chats')
    .where('memberUids', 'array-contains', proUid)
    .limit(50) // Recent chats only
    .get();

  const responseTimes: number[] = [];

  for (const chatDoc of chatsSnapshot.docs) {
    const messagesSnapshot = await db.collection('chats')
      .doc(chatDoc.id)
      .collection('messages')
      .orderBy('timestamp')
      .limit(20)
      .get();

    let lastCustomerMessage: any = null;
    
    messagesSnapshot.docs.forEach(msgDoc => {
      const msg = msgDoc.data();
      
      if (msg.senderId !== proUid) {
        // Customer message
        lastCustomerMessage = msg;
      } else if (lastCustomerMessage && msg.senderId === proUid) {
        // Pro response
        const responseTime = (msg.timestamp.toDate().getTime() - lastCustomerMessage.timestamp.toDate().getTime()) / (1000 * 60); // minutes
        if (responseTime > 0 && responseTime < 24 * 60) { // Within 24 hours
          responseTimes.push(responseTime);
        }
        lastCustomerMessage = null;
      }
    });
  }

  return responseTimes;
}

async function getJobStats(proUid: string) {
  const db = getDb();
  const snapshot = await db.collection('jobs')
    .where('proUid', '==', proUid)
    .get();

  let total = 0;
  let completed = 0;
  let cancelled = 0;

  snapshot.docs.forEach(doc => {
    const data = doc.data();
    total++;
    
    if (data.status === 'completed') {
      completed++;
    } else if (data.status === 'cancelled') {
      cancelled++;
    }
  });

  return { total, completed, cancelled };
}

function calculateNoShowRate(abuseEvents: any[], totalJobs: number): number {
  const noShows = abuseEvents.filter(e => e.type === 'no_show').length;
  return totalJobs > 0 ? noShows / totalJobs : 0;
}

function calculateCancelRate(abuseEvents: any[], totalJobs: number): number {
  const cancels = abuseEvents.filter(e => e.type === 'late_cancel').length;
  return totalJobs > 0 ? cancels / totalJobs : 0;
}

function calculateAvgResponseTime(responseTimes: number[]): number {
  if (responseTimes.length === 0) return 0;
  return responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length;
}

function calculateInAppRatio(abuseEvents: any[], totalJobs: number): number {
  const offPlatformEvents = abuseEvents.filter(e => 
    e.type === 'off_platform' || e.type === 'contact_drop'
  ).length;
  
  if (totalJobs === 0) return 1.0; // Perfect ratio if no jobs yet
  return Math.max(0, 1 - (offPlatformEvents / totalJobs));
}

function calculateAutoBadges(metrics: HealthMetrics): string[] {
  const badges: string[] = [];

  // Top Rated: rating ≥ 4.8 & count ≥ 20
  if (metrics.ratingAvg >= 4.8 && metrics.ratingCount >= 20) {
    badges.push('top_rated');
  }

  // Fast Responder: avg response ≤ 15 minutes
  if (metrics.avgResponseMins <= 15) {
    badges.push('fast_responder');
  }

  // Reliable: no-show rate ≤ 2%
  if (metrics.noShowRate <= 0.02) {
    badges.push('reliable');
  }

  return badges;
}

// ========================================
// ADMIN CALLABLE FUNCTIONS
// ========================================

interface SetFlagsData {
  proUid: string;
  softBanned?: boolean;
  hardBanned?: boolean;
  notes?: string;
}

interface BadgeData {
  proUid: string;
  badge: string;
}

interface RecalcHealthData {
  proUid: string;
}

export async function setFlags(request: CallableRequest<SetFlagsData>) {
  const { data, auth } = request;

  await enforceAdminRole(auth);
  const adminUid = auth!.uid;

  const { proUid, softBanned, hardBanned, notes } = data;

  if (!proUid) {
    throw new HttpsError('invalid-argument', 'proUid is required');
  }

  try {
    logger.info('🔥 ADMIN: Setting flags', { proUid, softBanned, hardBanned, notes });

    const db = getDb();
    const now = Timestamp.now();

    // Get current flags for audit log
    const proDoc = await db.collection('proProfiles').doc(proUid).get();
    const currentFlags = proDoc.exists ? proDoc.data()?.flags : null;

    // Update flags
    const flagsUpdate: any = {
      updatedAt: now
    };

    if (softBanned !== undefined) flagsUpdate.softBanned = softBanned;
    if (hardBanned !== undefined) flagsUpdate.hardBanned = hardBanned;
    if (notes !== undefined) flagsUpdate.notes = notes;

    await db.collection('proProfiles').doc(proUid).update({
      'flags': flagsUpdate
    });

    // Log admin action
    await db.collection('adminLogs').add({
      actorUid: adminUid,
      action: 'setFlag',
      targetType: 'user',
      targetId: proUid,
      before: currentFlags,
      after: flagsUpdate,
      notes: notes || 'Flags updated',
      createdAt: now
    });

    logger.info('✅ ADMIN: Flags set successfully', { proUid });
    return { success: true };

  } catch (error) {
    logger.error('❌ ADMIN: Error setting flags', { error, proUid });
    throw error instanceof HttpsError ? error : new HttpsError('internal', 'Failed to set flags');
  }
}

export async function addBadge(request: CallableRequest<BadgeData>) {
  const { data, auth } = request;

  await enforceAdminRole(auth);
  const adminUid = auth!.uid;

  const { proUid, badge } = data;

  if (!proUid || !badge) {
    throw new HttpsError('invalid-argument', 'proUid and badge are required');
  }

  try {
    logger.info('🔥 ADMIN: Adding badge', { proUid, badge });

    const db = getDb();
    const now = Timestamp.now();

    // Add badge to array (if not already present)
    await db.collection('proProfiles').doc(proUid).update({
      badges: FieldValue.arrayUnion(badge)
    });

    // Log admin action
    await db.collection('adminLogs').add({
      actorUid: adminUid,
      action: 'addBadge',
      targetType: 'user',
      targetId: proUid,
      after: { badge },
      notes: `Added badge: ${badge}`,
      createdAt: now
    });

    logger.info('✅ ADMIN: Badge added successfully', { proUid, badge });
    return { success: true };

  } catch (error) {
    logger.error('❌ ADMIN: Error adding badge', { error, proUid, badge });
    throw error instanceof HttpsError ? error : new HttpsError('internal', 'Failed to add badge');
  }
}

export async function removeBadge(request: CallableRequest<BadgeData>) {
  const { data, auth } = request;

  await enforceAdminRole(auth);
  const adminUid = auth!.uid;

  const { proUid, badge } = data;

  if (!proUid || !badge) {
    throw new HttpsError('invalid-argument', 'proUid and badge are required');
  }

  try {
    logger.info('🔥 ADMIN: Removing badge', { proUid, badge });

    const db = getDb();
    const now = Timestamp.now();

    // Remove badge from array
    await db.collection('proProfiles').doc(proUid).update({
      badges: FieldValue.arrayRemove(badge)
    });

    // Log admin action
    await db.collection('adminLogs').add({
      actorUid: adminUid,
      action: 'removeBadge',
      targetType: 'user',
      targetId: proUid,
      before: { badge },
      notes: `Removed badge: ${badge}`,
      createdAt: now
    });

    logger.info('✅ ADMIN: Badge removed successfully', { proUid, badge });
    return { success: true };

  } catch (error) {
    logger.error('❌ ADMIN: Error removing badge', { error, proUid, badge });
    throw error instanceof HttpsError ? error : new HttpsError('internal', 'Failed to remove badge');
  }
}

export async function recalcHealth(request: CallableRequest<RecalcHealthData>) {
  const { data, auth } = request;

  await enforceAdminRole(auth);
  const adminUid = auth!.uid;

  const { proUid } = data;

  if (!proUid) {
    throw new HttpsError('invalid-argument', 'proUid is required');
  }

  try {
    logger.info('🔥 ADMIN: Recalculating health', { proUid });

    const result = await calculateHealthScore(proUid);
    const db = getDb();
    const now = Timestamp.now();

    // Get current data for audit log
    const proDoc = await db.collection('proProfiles').doc(proUid).get();
    const currentHealth = proDoc.exists ? proDoc.data()?.health : null;
    const currentBadges = proDoc.exists ? proDoc.data()?.badges || [] : [];

    // Update health score
    await db.collection('proProfiles').doc(proUid).update({
      health: {
        score: result.score,
        noShowRate: result.metrics.noShowRate,
        cancelRate: result.metrics.cancelRate,
        avgResponseMins: result.metrics.avgResponseMins,
        inAppRatio: result.metrics.inAppRatio,
        ratingAvg: result.metrics.ratingAvg,
        ratingCount: result.metrics.ratingCount,
        updatedAt: now
      }
    });

    // Update auto-badges (merge with existing manual badges)
    const autoBadges = result.badges;
    const manualBadges = currentBadges.filter((badge: string) => 
      !['top_rated', 'fast_responder', 'reliable'].includes(badge)
    );
    const newBadges = [...manualBadges, ...autoBadges];

    await db.collection('proProfiles').doc(proUid).update({
      badges: newBadges
    });

    // Log admin action
    await db.collection('adminLogs').add({
      actorUid: adminUid,
      action: 'recalcHealth',
      targetType: 'user',
      targetId: proUid,
      before: { health: currentHealth, badges: currentBadges },
      after: { health: result, badges: newBadges },
      notes: `Health recalculated: ${result.score}/100`,
      createdAt: now
    });

    logger.info('✅ ADMIN: Health recalculated successfully', { proUid, score: result.score });
    return { 
      success: true, 
      score: result.score,
      badges: newBadges
    };

  } catch (error) {
    logger.error('❌ ADMIN: Error recalculating health', { error, proUid });
    throw error instanceof HttpsError ? error : new HttpsError('internal', 'Failed to recalculate health');
  }
}

// ========================================
// SCHEDULED FUNCTIONS
// ========================================

export async function recalcHealthNightly() {
  try {
    logger.info('🔥 HEALTH: Starting nightly health recalculation');

    const db = getDb();
    
    // Get all active pros (or those flagged for recalc)
    const prosSnapshot = await db.collection('proProfiles')
      .where('isActive', '==', true)
      .limit(100) // Process in batches
      .get();

    const promises = prosSnapshot.docs.map(async (doc) => {
      try {
        const proUid = doc.id;
        const result = await calculateHealthScore(proUid);
        
        // Update health data
        await doc.ref.update({
          health: {
            score: result.score,
            noShowRate: result.metrics.noShowRate,
            cancelRate: result.metrics.cancelRate,
            avgResponseMins: result.metrics.avgResponseMins,
            inAppRatio: result.metrics.inAppRatio,
            ratingAvg: result.metrics.ratingAvg,
            ratingCount: result.metrics.ratingCount,
            updatedAt: Timestamp.now()
          }
        });

        // Update auto-badges
        const currentBadges = doc.data().badges || [];
        const manualBadges = currentBadges.filter((badge: string) => 
          !['top_rated', 'fast_responder', 'reliable'].includes(badge)
        );
        const newBadges = [...manualBadges, ...result.badges];

        await doc.ref.update({ badges: newBadges });

        logger.info('✅ HEALTH: Updated health for pro', { proUid, score: result.score });
        
      } catch (error) {
        logger.error('❌ HEALTH: Failed to update pro health', { proUid: doc.id, error });
      }
    });

    await Promise.allSettled(promises);
    
    logger.info('✅ HEALTH: Nightly health recalculation completed', { processed: prosSnapshot.size });

  } catch (error) {
    logger.error('❌ HEALTH: Error in nightly health recalculation', { error });
    throw error;
  }
}