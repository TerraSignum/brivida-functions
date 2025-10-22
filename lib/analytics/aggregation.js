"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aggregateDaily = void 0;
exports.triggerDailyAggregation = triggerDailyAggregation;
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firestore_1 = require("firebase-admin/firestore");
const v2_1 = require("firebase-functions/v2");
exports.aggregateDaily = (0, scheduler_1.onSchedule)({
    schedule: 'every 15 minutes',
    timeZone: 'Europe/Berlin',
    region: 'europe-west1',
}, async () => {
    try {
        v2_1.logger.info('🔄 ANALYTICS: Starting daily aggregation');
        const db = (0, firestore_1.getFirestore)();
        const now = new Date();
        const utcDate = new Date(now.getTime());
        const dateId = formatDateId(utcDate);
        const startOfDay = new Date(utcDate);
        startOfDay.setUTCHours(0, 0, 0, 0);
        const endOfDay = new Date(utcDate);
        endOfDay.setUTCHours(23, 59, 59, 999);
        v2_1.logger.info('📊 ANALYTICS: Aggregating for date', {
            dateId,
            startOfDay: startOfDay.toISOString(),
            endOfDay: endOfDay.toISOString()
        });
        const eventsQuery = db.collection('analyticsEvents')
            .where('ts', '>=', firestore_1.Timestamp.fromDate(startOfDay))
            .where('ts', '<=', firestore_1.Timestamp.fromDate(endOfDay));
        const eventsSnapshot = await eventsQuery.get();
        if (eventsSnapshot.empty) {
            v2_1.logger.info('📊 ANALYTICS: No events found for aggregation');
            return;
        }
        v2_1.logger.info('📊 ANALYTICS: Processing events', { count: eventsSnapshot.size });
        const kpis = {
            jobsCreated: 0,
            leadsCreated: 0,
            leadsAccepted: 0,
            paymentsCapturedEur: 0,
            paymentsReleasedEur: 0,
            refundsEur: 0,
            chatMessages: 0,
            activePros: new Set(),
            activeCustomers: new Set(),
            newUsers: new Set(),
            disputesOpened: 0,
            disputesResolved: 0,
            ratings: [],
            pushDelivered: 0,
            pushOpened: 0,
        };
        eventsSnapshot.docs.forEach(doc => {
            const event = doc.data();
            const { name, props, uid, role } = event;
            if (uid && role) {
                if (role === 'pro') {
                    kpis.activePros.add(uid);
                }
                else if (role === 'customer') {
                    kpis.activeCustomers.add(uid);
                }
            }
            processEventForKpis(name, props, uid, kpis);
        });
        const avgRating = kpis.ratings.length > 0
            ? kpis.ratings.reduce((sum, rating) => sum + rating, 0) / kpis.ratings.length
            : 0;
        const pushOpenRate = kpis.pushDelivered > 0
            ? kpis.pushOpened / kpis.pushDelivered
            : 0;
        const finalKpis = {
            jobsCreated: kpis.jobsCreated,
            leadsCreated: kpis.leadsCreated,
            leadsAccepted: kpis.leadsAccepted,
            paymentsCapturedEur: Math.round(kpis.paymentsCapturedEur * 100) / 100,
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
            pushOpenRate: Math.round(pushOpenRate * 10000) / 100,
        };
        const dailyDoc = db.collection('analyticsDaily').doc(dateId);
        await dailyDoc.set({
            kpis: finalKpis,
            updatedAt: firestore_1.Timestamp.fromDate(now),
        }, { merge: true });
        v2_1.logger.info('✅ ANALYTICS: Daily aggregation completed', {
            dateId,
            eventsProcessed: eventsSnapshot.size,
            kpis: finalKpis,
        });
    }
    catch (error) {
        v2_1.logger.error('❌ ANALYTICS: Error in daily aggregation', { error });
        throw error;
    }
});
function processEventForKpis(name, props, uid, kpis) {
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
            if ((props === null || props === void 0 ? void 0 : props.amountEur) && typeof props.amountEur === 'number') {
                kpis.paymentsCapturedEur += props.amountEur;
            }
            break;
        case 'payment_released':
            if ((props === null || props === void 0 ? void 0 : props.amountEur) && typeof props.amountEur === 'number') {
                kpis.paymentsReleasedEur += props.amountEur;
            }
            break;
        case 'payment_refunded':
            if ((props === null || props === void 0 ? void 0 : props.amountEur) && typeof props.amountEur === 'number') {
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
            if ((props === null || props === void 0 ? void 0 : props.rating) && typeof props.rating === 'number') {
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
function formatDateId(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}
async function triggerDailyAggregation(targetDate) {
    const date = targetDate || new Date();
    const dateId = formatDateId(date);
    v2_1.logger.info('🔧 ANALYTICS: Manual aggregation trigger', { dateId });
}
//# sourceMappingURL=aggregation.js.map