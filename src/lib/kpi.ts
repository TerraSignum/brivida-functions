// KPI Computation and Aggregation Functions

import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

interface DateRange {
  start: Date;
  end: Date;
}

interface KpiTotals {
  jobsCreated: number;
  leadsCreated: number;
  leadsAccepted: number;
  paymentsCapturedEur: number;
  paymentsReleasedEur: number;
  refundsEur: number;
  chatMessages: number;
  newUsers: number;
  disputesOpened: number;
  disputesResolved: number;
  ratingsCount: number;
  pushDelivered: number;
  pushOpened: number;
  pushOpenRate: number;
}

/**
 * Server-side KPI aggregation for better performance and reduced client load
 * Aggregates daily KPI data over a date range
 */
export async function aggregateKpiData(
  dateRange?: DateRange
): Promise<KpiTotals> {
  try {
    const db = getFirestore();
    let query = db.collection('dailyKpis').orderBy('date', 'desc');

    if (dateRange) {
      query = query
        .where('date', '>=', dateRange.start)
        .where('date', '<=', dateRange.end);
    }

    const snapshot = await query.get();

    const totals: KpiTotals = {
      jobsCreated: 0,
      leadsCreated: 0,
      leadsAccepted: 0,
      paymentsCapturedEur: 0,
      paymentsReleasedEur: 0,
      refundsEur: 0,
      chatMessages: 0,
      newUsers: 0,
      disputesOpened: 0,
      disputesResolved: 0,
      ratingsCount: 0,
      pushDelivered: 0,
      pushOpened: 0,
      pushOpenRate: 0,
    };

    // Aggregate data from all daily KPI records
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const kpis = (data.kpis as Record<string, unknown>) || {};

      totals.jobsCreated += (kpis.jobsCreated as number) || 0;
      totals.leadsCreated += (kpis.leadsCreated as number) || 0;
      totals.leadsAccepted += (kpis.leadsAccepted as number) || 0;
      totals.paymentsCapturedEur += (kpis.paymentsCapturedEur as number) || 0;
      totals.paymentsReleasedEur += (kpis.paymentsReleasedEur as number) || 0;
      totals.refundsEur += (kpis.refundsEur as number) || 0;
      totals.chatMessages += (kpis.chatMessages as number) || 0;
      totals.newUsers += (kpis.newUsers as number) || 0;
      totals.disputesOpened += (kpis.disputesOpened as number) || 0;
      totals.disputesResolved += (kpis.disputesResolved as number) || 0;
      totals.ratingsCount += (kpis.ratingsCount as number) || 0;
      totals.pushDelivered += (kpis.pushDelivered as number) || 0;
      totals.pushOpened += (kpis.pushOpened as number) || 0;
    }

    // Calculate derived metrics
    totals.pushOpenRate = totals.pushDelivered > 0
      ? (totals.pushOpened / totals.pushDelivered * 100)
      : 0;

    return totals;
  } catch (error) {
    console.error('Error aggregating KPI data:', error);
    throw new HttpsError('internal', 'Failed to aggregate KPI data');
  }
}

/**
 * Get KPI data for a specific time period with caching
 */
export async function getKpiSummary(
  startDate?: string,
  endDate?: string
): Promise<KpiTotals & { lastUpdated: string }> {
  try {
    const dateRange = startDate && endDate ? {
      start: new Date(startDate),
      end: new Date(endDate),
    } : undefined;

    const totals = await aggregateKpiData(dateRange);

    return {
      ...totals,
      lastUpdated: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error getting KPI summary:', error);
    throw new HttpsError('internal', 'Failed to get KPI summary');
  }
}

/**
 * Calculate advanced analytics metrics
 */
export async function calculateAdvancedMetrics(): Promise<{
  leadConversionRate: number;
  avgJobValue: number;
  disputeRate: number;
  userRetentionRate: number;
  revenueGrowthRate: number;
}> {
  try {
    const db = getFirestore();
    const now = new Date();

    // Get data from last 30 days for calculations
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const totals = await aggregateKpiData({
      start: thirtyDaysAgo,
      end: now,
    });

    // Calculate advanced metrics
    const leadConversionRate = totals.leadsCreated > 0
      ? (totals.leadsAccepted / totals.leadsCreated * 100)
      : 0;

    const avgJobValue = totals.jobsCreated > 0
      ? (totals.paymentsCapturedEur / totals.jobsCreated)
      : 0;

    const disputeRate = totals.jobsCreated > 0
      ? (totals.disputesOpened / totals.jobsCreated * 100)
      : 0;

    const sixtyDaysAgo = new Date(now);
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    const recentActiveUsers = await fetchActiveUsers(db, thirtyDaysAgo, now);
    const previousActiveUsers = await fetchActiveUsers(db, sixtyDaysAgo, thirtyDaysAgo);
    const retainedUsersCount = [...recentActiveUsers].filter((uid) => previousActiveUsers.has(uid)).length;

    const userRetentionRate = previousActiveUsers.size > 0
      ? (retainedUsersCount / previousActiveUsers.size) * 100
      : 0;

    const previousPeriodTotals = await aggregateKpiData({
      start: sixtyDaysAgo,
      end: thirtyDaysAgo,
    });

    const revenueGrowthRate = previousPeriodTotals.paymentsCapturedEur > 0
      ? ((totals.paymentsCapturedEur - previousPeriodTotals.paymentsCapturedEur) 
         / previousPeriodTotals.paymentsCapturedEur * 100)
      : 0;

    return {
      leadConversionRate,
      avgJobValue,
      disputeRate,
      userRetentionRate,
      revenueGrowthRate,
    };
  } catch (error) {
    console.error('Error calculating advanced metrics:', error);
    throw new HttpsError('internal', 'Failed to calculate advanced metrics');
  }
}

async function fetchActiveUsers(
  db: FirebaseFirestore.Firestore,
  startDate: Date,
  endDate: Date,
): Promise<Set<string>> {
  const snapshot = await db
    .collection('analyticsEvents')
    .where('ts', '>=', Timestamp.fromDate(startDate))
    .where('ts', '<', Timestamp.fromDate(endDate))
    .select('uid')
    .get();

  const activeUsers = new Set<string>();

  for (const doc of snapshot.docs) {
    const uid = doc.get('uid');
    if (typeof uid === 'string' && uid.trim().length > 0) {
      activeUsers.add(uid);
    }
  }

  return activeUsers;
}