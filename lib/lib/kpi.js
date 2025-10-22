"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aggregateKpiData = aggregateKpiData;
exports.getKpiSummary = getKpiSummary;
exports.calculateAdvancedMetrics = calculateAdvancedMetrics;
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/v2/https");
async function aggregateKpiData(dateRange) {
    try {
        const db = (0, firestore_1.getFirestore)();
        let query = db.collection('dailyKpis').orderBy('date', 'desc');
        if (dateRange) {
            query = query
                .where('date', '>=', dateRange.start)
                .where('date', '<=', dateRange.end);
        }
        const snapshot = await query.get();
        const totals = {
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
        for (const doc of snapshot.docs) {
            const data = doc.data();
            const kpis = data.kpis || {};
            totals.jobsCreated += kpis.jobsCreated || 0;
            totals.leadsCreated += kpis.leadsCreated || 0;
            totals.leadsAccepted += kpis.leadsAccepted || 0;
            totals.paymentsCapturedEur += kpis.paymentsCapturedEur || 0;
            totals.paymentsReleasedEur += kpis.paymentsReleasedEur || 0;
            totals.refundsEur += kpis.refundsEur || 0;
            totals.chatMessages += kpis.chatMessages || 0;
            totals.newUsers += kpis.newUsers || 0;
            totals.disputesOpened += kpis.disputesOpened || 0;
            totals.disputesResolved += kpis.disputesResolved || 0;
            totals.ratingsCount += kpis.ratingsCount || 0;
            totals.pushDelivered += kpis.pushDelivered || 0;
            totals.pushOpened += kpis.pushOpened || 0;
        }
        totals.pushOpenRate = totals.pushDelivered > 0
            ? (totals.pushOpened / totals.pushDelivered * 100)
            : 0;
        return totals;
    }
    catch (error) {
        console.error('Error aggregating KPI data:', error);
        throw new https_1.HttpsError('internal', 'Failed to aggregate KPI data');
    }
}
async function getKpiSummary(startDate, endDate) {
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
    }
    catch (error) {
        console.error('Error getting KPI summary:', error);
        throw new https_1.HttpsError('internal', 'Failed to get KPI summary');
    }
}
async function calculateAdvancedMetrics() {
    try {
        const db = (0, firestore_1.getFirestore)();
        const now = new Date();
        const thirtyDaysAgo = new Date(now);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const totals = await aggregateKpiData({
            start: thirtyDaysAgo,
            end: now,
        });
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
    }
    catch (error) {
        console.error('Error calculating advanced metrics:', error);
        throw new https_1.HttpsError('internal', 'Failed to calculate advanced metrics');
    }
}
async function fetchActiveUsers(db, startDate, endDate) {
    const snapshot = await db
        .collection('analyticsEvents')
        .where('ts', '>=', firestore_1.Timestamp.fromDate(startDate))
        .where('ts', '<', firestore_1.Timestamp.fromDate(endDate))
        .select('uid')
        .get();
    const activeUsers = new Set();
    for (const doc of snapshot.docs) {
        const uid = doc.get('uid');
        if (typeof uid === 'string' && uid.trim().length > 0) {
            activeUsers.add(uid);
        }
    }
    return activeUsers;
}
//# sourceMappingURL=kpi.js.map