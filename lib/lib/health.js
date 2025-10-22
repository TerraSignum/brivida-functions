"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateHealthScore = calculateHealthScore;
exports.setFlags = setFlags;
exports.addBadge = addBadge;
exports.removeBadge = removeBadge;
exports.recalcHealth = recalcHealth;
exports.recalcHealthNightly = recalcHealthNightly;
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/v2/https");
const firestore_2 = require("./firestore");
const v2_1 = require("firebase-functions/v2");
const auth_1 = require("./auth");
async function calculateHealthScore(proUid) {
    try {
        v2_1.logger.info('🔥 HEALTH: Calculating health score', { proUid });
        const [abuseEvents, reviews, messages, jobs] = await Promise.all([
            getAbuseEvents(proUid),
            getReviews(proUid),
            getResponseTimes(proUid),
            getJobStats(proUid)
        ]);
        const metrics = {
            noShowRate: calculateNoShowRate(abuseEvents, jobs.total),
            cancelRate: calculateCancelRate(abuseEvents, jobs.total),
            avgResponseMins: calculateAvgResponseTime(messages),
            inAppRatio: calculateInAppRatio(abuseEvents, jobs.total),
            ratingAvg: reviews.averageRating,
            ratingCount: reviews.totalCount
        };
        const noShowScore = Math.max(0, 100 * (1 - metrics.noShowRate));
        const cancelScore = Math.max(0, 100 * (1 - metrics.cancelRate));
        const responseScore = Math.max(0, 100 * (1 - metrics.avgResponseMins / 120));
        const inAppScore = Math.min(100, 100 * metrics.inAppRatio);
        const ratingScore = metrics.ratingAvg * 20;
        const countScore = Math.min(100, 5 * Math.log(1 + metrics.ratingCount));
        const finalScore = Math.round(0.30 * noShowScore +
            0.15 * cancelScore +
            0.15 * responseScore +
            0.15 * inAppScore +
            0.20 * ratingScore +
            0.05 * countScore);
        const badges = calculateAutoBadges(metrics);
        v2_1.logger.info('✅ HEALTH: Health score calculated', {
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
    }
    catch (error) {
        v2_1.logger.error('❌ HEALTH: Error calculating health score', { error, proUid });
        throw error;
    }
}
async function getAbuseEvents(proUid) {
    const db = (0, firestore_2.getDb)();
    const snapshot = await db.collection('abuseEvents')
        .where('userUid', '==', proUid)
        .get();
    const events = [];
    snapshot.docs.forEach(doc => {
        events.push({ id: doc.id, ...doc.data() });
    });
    return events;
}
async function getReviews(proUid) {
    const db = (0, firestore_2.getDb)();
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
async function getResponseTimes(proUid) {
    const db = (0, firestore_2.getDb)();
    const chatsSnapshot = await db.collection('chats')
        .where('memberUids', 'array-contains', proUid)
        .limit(50)
        .get();
    const responseTimes = [];
    for (const chatDoc of chatsSnapshot.docs) {
        const messagesSnapshot = await db.collection('chats')
            .doc(chatDoc.id)
            .collection('messages')
            .orderBy('timestamp')
            .limit(20)
            .get();
        let lastCustomerMessage = null;
        messagesSnapshot.docs.forEach(msgDoc => {
            const msg = msgDoc.data();
            if (msg.senderId !== proUid) {
                lastCustomerMessage = msg;
            }
            else if (lastCustomerMessage && msg.senderId === proUid) {
                const responseTime = (msg.timestamp.toDate().getTime() - lastCustomerMessage.timestamp.toDate().getTime()) / (1000 * 60);
                if (responseTime > 0 && responseTime < 24 * 60) {
                    responseTimes.push(responseTime);
                }
                lastCustomerMessage = null;
            }
        });
    }
    return responseTimes;
}
async function getJobStats(proUid) {
    const db = (0, firestore_2.getDb)();
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
        }
        else if (data.status === 'cancelled') {
            cancelled++;
        }
    });
    return { total, completed, cancelled };
}
function calculateNoShowRate(abuseEvents, totalJobs) {
    const noShows = abuseEvents.filter(e => e.type === 'no_show').length;
    return totalJobs > 0 ? noShows / totalJobs : 0;
}
function calculateCancelRate(abuseEvents, totalJobs) {
    const cancels = abuseEvents.filter(e => e.type === 'late_cancel').length;
    return totalJobs > 0 ? cancels / totalJobs : 0;
}
function calculateAvgResponseTime(responseTimes) {
    if (responseTimes.length === 0)
        return 0;
    return responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length;
}
function calculateInAppRatio(abuseEvents, totalJobs) {
    const offPlatformEvents = abuseEvents.filter(e => e.type === 'off_platform' || e.type === 'contact_drop').length;
    if (totalJobs === 0)
        return 1.0;
    return Math.max(0, 1 - (offPlatformEvents / totalJobs));
}
function calculateAutoBadges(metrics) {
    const badges = [];
    if (metrics.ratingAvg >= 4.8 && metrics.ratingCount >= 20) {
        badges.push('top_rated');
    }
    if (metrics.avgResponseMins <= 15) {
        badges.push('fast_responder');
    }
    if (metrics.noShowRate <= 0.02) {
        badges.push('reliable');
    }
    return badges;
}
async function setFlags(request) {
    var _a;
    const { data, auth } = request;
    await (0, auth_1.enforceAdminRole)(auth);
    const adminUid = auth.uid;
    const { proUid, softBanned, hardBanned, notes } = data;
    if (!proUid) {
        throw new https_1.HttpsError('invalid-argument', 'proUid is required');
    }
    try {
        v2_1.logger.info('🔥 ADMIN: Setting flags', { proUid, softBanned, hardBanned, notes });
        const db = (0, firestore_2.getDb)();
        const now = firestore_1.Timestamp.now();
        const proDoc = await db.collection('proProfiles').doc(proUid).get();
        const currentFlags = proDoc.exists ? (_a = proDoc.data()) === null || _a === void 0 ? void 0 : _a.flags : null;
        const flagsUpdate = {
            updatedAt: now
        };
        if (softBanned !== undefined)
            flagsUpdate.softBanned = softBanned;
        if (hardBanned !== undefined)
            flagsUpdate.hardBanned = hardBanned;
        if (notes !== undefined)
            flagsUpdate.notes = notes;
        await db.collection('proProfiles').doc(proUid).update({
            'flags': flagsUpdate
        });
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
        v2_1.logger.info('✅ ADMIN: Flags set successfully', { proUid });
        return { success: true };
    }
    catch (error) {
        v2_1.logger.error('❌ ADMIN: Error setting flags', { error, proUid });
        throw error instanceof https_1.HttpsError ? error : new https_1.HttpsError('internal', 'Failed to set flags');
    }
}
async function addBadge(request) {
    const { data, auth } = request;
    await (0, auth_1.enforceAdminRole)(auth);
    const adminUid = auth.uid;
    const { proUid, badge } = data;
    if (!proUid || !badge) {
        throw new https_1.HttpsError('invalid-argument', 'proUid and badge are required');
    }
    try {
        v2_1.logger.info('🔥 ADMIN: Adding badge', { proUid, badge });
        const db = (0, firestore_2.getDb)();
        const now = firestore_1.Timestamp.now();
        await db.collection('proProfiles').doc(proUid).update({
            badges: firestore_1.FieldValue.arrayUnion(badge)
        });
        await db.collection('adminLogs').add({
            actorUid: adminUid,
            action: 'addBadge',
            targetType: 'user',
            targetId: proUid,
            after: { badge },
            notes: `Added badge: ${badge}`,
            createdAt: now
        });
        v2_1.logger.info('✅ ADMIN: Badge added successfully', { proUid, badge });
        return { success: true };
    }
    catch (error) {
        v2_1.logger.error('❌ ADMIN: Error adding badge', { error, proUid, badge });
        throw error instanceof https_1.HttpsError ? error : new https_1.HttpsError('internal', 'Failed to add badge');
    }
}
async function removeBadge(request) {
    const { data, auth } = request;
    await (0, auth_1.enforceAdminRole)(auth);
    const adminUid = auth.uid;
    const { proUid, badge } = data;
    if (!proUid || !badge) {
        throw new https_1.HttpsError('invalid-argument', 'proUid and badge are required');
    }
    try {
        v2_1.logger.info('🔥 ADMIN: Removing badge', { proUid, badge });
        const db = (0, firestore_2.getDb)();
        const now = firestore_1.Timestamp.now();
        await db.collection('proProfiles').doc(proUid).update({
            badges: firestore_1.FieldValue.arrayRemove(badge)
        });
        await db.collection('adminLogs').add({
            actorUid: adminUid,
            action: 'removeBadge',
            targetType: 'user',
            targetId: proUid,
            before: { badge },
            notes: `Removed badge: ${badge}`,
            createdAt: now
        });
        v2_1.logger.info('✅ ADMIN: Badge removed successfully', { proUid, badge });
        return { success: true };
    }
    catch (error) {
        v2_1.logger.error('❌ ADMIN: Error removing badge', { error, proUid, badge });
        throw error instanceof https_1.HttpsError ? error : new https_1.HttpsError('internal', 'Failed to remove badge');
    }
}
async function recalcHealth(request) {
    var _a, _b;
    const { data, auth } = request;
    await (0, auth_1.enforceAdminRole)(auth);
    const adminUid = auth.uid;
    const { proUid } = data;
    if (!proUid) {
        throw new https_1.HttpsError('invalid-argument', 'proUid is required');
    }
    try {
        v2_1.logger.info('🔥 ADMIN: Recalculating health', { proUid });
        const result = await calculateHealthScore(proUid);
        const db = (0, firestore_2.getDb)();
        const now = firestore_1.Timestamp.now();
        const proDoc = await db.collection('proProfiles').doc(proUid).get();
        const currentHealth = proDoc.exists ? (_a = proDoc.data()) === null || _a === void 0 ? void 0 : _a.health : null;
        const currentBadges = proDoc.exists ? ((_b = proDoc.data()) === null || _b === void 0 ? void 0 : _b.badges) || [] : [];
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
        const autoBadges = result.badges;
        const manualBadges = currentBadges.filter((badge) => !['top_rated', 'fast_responder', 'reliable'].includes(badge));
        const newBadges = [...manualBadges, ...autoBadges];
        await db.collection('proProfiles').doc(proUid).update({
            badges: newBadges
        });
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
        v2_1.logger.info('✅ ADMIN: Health recalculated successfully', { proUid, score: result.score });
        return {
            success: true,
            score: result.score,
            badges: newBadges
        };
    }
    catch (error) {
        v2_1.logger.error('❌ ADMIN: Error recalculating health', { error, proUid });
        throw error instanceof https_1.HttpsError ? error : new https_1.HttpsError('internal', 'Failed to recalculate health');
    }
}
async function recalcHealthNightly() {
    try {
        v2_1.logger.info('🔥 HEALTH: Starting nightly health recalculation');
        const db = (0, firestore_2.getDb)();
        const prosSnapshot = await db.collection('proProfiles')
            .where('isActive', '==', true)
            .limit(100)
            .get();
        const promises = prosSnapshot.docs.map(async (doc) => {
            try {
                const proUid = doc.id;
                const result = await calculateHealthScore(proUid);
                await doc.ref.update({
                    health: {
                        score: result.score,
                        noShowRate: result.metrics.noShowRate,
                        cancelRate: result.metrics.cancelRate,
                        avgResponseMins: result.metrics.avgResponseMins,
                        inAppRatio: result.metrics.inAppRatio,
                        ratingAvg: result.metrics.ratingAvg,
                        ratingCount: result.metrics.ratingCount,
                        updatedAt: firestore_1.Timestamp.now()
                    }
                });
                const currentBadges = doc.data().badges || [];
                const manualBadges = currentBadges.filter((badge) => !['top_rated', 'fast_responder', 'reliable'].includes(badge));
                const newBadges = [...manualBadges, ...result.badges];
                await doc.ref.update({ badges: newBadges });
                v2_1.logger.info('✅ HEALTH: Updated health for pro', { proUid, score: result.score });
            }
            catch (error) {
                v2_1.logger.error('❌ HEALTH: Failed to update pro health', { proUid: doc.id, error });
            }
        });
        await Promise.allSettled(promises);
        v2_1.logger.info('✅ HEALTH: Nightly health recalculation completed', { processed: prosSnapshot.size });
    }
    catch (error) {
        v2_1.logger.error('❌ HEALTH: Error in nightly health recalculation', { error });
        throw error;
    }
}
//# sourceMappingURL=health.js.map