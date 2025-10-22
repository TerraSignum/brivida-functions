"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanupJobLiveLocationsCF = exports.triggerLiveLocationCleanupCF = exports.cleanupLiveLocations = void 0;
const scheduler_1 = require("firebase-functions/v2/scheduler");
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-admin/firestore");
const firebase_functions_1 = require("firebase-functions");
const auth_1 = require("./auth");
const db = (0, firestore_1.getFirestore)();
async function processJobCleanup(jobDoc, cutoffTime) {
    const jobId = jobDoc.id;
    let deletedCount = 0;
    const job = await db.collection('jobs').doc(jobId).get();
    if (!job.exists) {
        await jobDoc.ref.delete();
        firebase_functions_1.logger.info(`Deleted live locations for non-existent job: ${jobId}`);
        return 1;
    }
    const jobData = job.data();
    const jobStatus = jobData.status;
    if (!['assigned', 'in_progress'].includes(jobStatus)) {
        await jobDoc.ref.delete();
        firebase_functions_1.logger.info(`Deleted live locations for completed job: ${jobId} (status: ${jobStatus})`);
        return 1;
    }
    const prosSnapshot = await jobDoc.ref.collection('pros').get();
    for (const proDoc of prosSnapshot.docs) {
        const data = proDoc.data();
        if (!data.updatedAt || data.updatedAt.toDate() < cutoffTime) {
            await proDoc.ref.delete();
            deletedCount++;
            if (data.updatedAt) {
                const age = Math.round((Date.now() - data.updatedAt.toDate().getTime()) / 60000);
                firebase_functions_1.logger.info(`Deleted stale location for pro ${proDoc.id} in job ${jobId} (age: ${age} minutes)`);
            }
        }
    }
    const remainingPros = await jobDoc.ref.collection('pros').get();
    if (remainingPros.empty) {
        await jobDoc.ref.delete();
    }
    return deletedCount;
}
exports.cleanupLiveLocations = (0, scheduler_1.onSchedule)({
    schedule: 'every 15 minutes',
    timeZone: 'UTC',
    region: 'europe-west1',
}, async () => {
    firebase_functions_1.logger.info('Starting live location cleanup');
    try {
        const now = new Date();
        const cutoffTime = new Date(now.getTime() - 2 * 60 * 60 * 1000);
        let totalDeleted = 0;
        const liveLocationsSnapshot = await db.collection('liveLocations').get();
        for (const jobDoc of liveLocationsSnapshot.docs) {
            const deleted = await processJobCleanup(jobDoc, cutoffTime);
            totalDeleted += deleted;
        }
        firebase_functions_1.logger.info(`Live location cleanup completed. Deleted ${totalDeleted} stale locations`);
        await db.collection('adminLogs').add({
            action: 'live_location_cleanup',
            timestamp: firestore_1.FieldValue.serverTimestamp(),
            deletedCount: totalDeleted,
            details: 'Scheduled cleanup of stale live location data',
        });
    }
    catch (error) {
        firebase_functions_1.logger.error('Live location cleanup failed:', error);
        await db.collection('adminLogs').add({
            action: 'live_location_cleanup_error',
            timestamp: firestore_1.FieldValue.serverTimestamp(),
            error: error instanceof Error ? error.message : String(error),
            details: 'Scheduled cleanup encountered an error',
        });
        throw error;
    }
});
async function processManualJobCleanup(jobDoc, cutoffTime, details) {
    const jobId = jobDoc.id;
    let deletedCount = 0;
    const job = await db.collection('jobs').doc(jobId).get();
    if (!job.exists) {
        await jobDoc.ref.delete();
        deletedCount++;
        details.push(`Deleted locations for non-existent job: ${jobId}`);
        return deletedCount;
    }
    const jobData = job.data();
    const jobStatus = jobData.status;
    if (!['assigned', 'in_progress'].includes(jobStatus)) {
        await jobDoc.ref.delete();
        deletedCount++;
        details.push(`Deleted locations for completed job: ${jobId} (status: ${jobStatus})`);
        return deletedCount;
    }
    const prosSnapshot = await jobDoc.ref.collection('pros').get();
    let deletedFromJob = 0;
    for (const proDoc of prosSnapshot.docs) {
        const data = proDoc.data();
        if (!data.updatedAt || data.updatedAt.toDate() < cutoffTime) {
            await proDoc.ref.delete();
            deletedFromJob++;
            deletedCount++;
        }
    }
    if (deletedFromJob > 0) {
        details.push(`Deleted ${deletedFromJob} stale location(s) from job: ${jobId}`);
    }
    const remainingPros = await jobDoc.ref.collection('pros').get();
    if (remainingPros.empty) {
        await jobDoc.ref.delete();
    }
    return deletedCount;
}
exports.triggerLiveLocationCleanupCF = (0, https_1.onCall)({ region: 'europe-west1' }, async (request) => {
    const { auth } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    }
    await (0, auth_1.enforceAdminRole)(auth);
    const adminUid = auth.uid;
    firebase_functions_1.logger.info('Manual live location cleanup triggered by admin:', adminUid);
    try {
        const now = new Date();
        const cutoffTime = new Date(now.getTime() - 2 * 60 * 60 * 1000);
        let totalDeleted = 0;
        const details = [];
        const liveLocationsSnapshot = await db.collection('liveLocations').get();
        for (const jobDoc of liveLocationsSnapshot.docs) {
            const deleted = await processManualJobCleanup(jobDoc, cutoffTime, details);
            totalDeleted += deleted;
        }
        await db.collection('adminLogs').add({
            action: 'manual_live_location_cleanup',
            timestamp: firestore_1.FieldValue.serverTimestamp(),
            adminUid,
            triggeredBy: adminUid,
            deletedCount: totalDeleted,
            details: details.join('; '),
        });
        firebase_functions_1.logger.info(`Manual live location cleanup completed. Deleted ${totalDeleted} stale locations`);
        return {
            success: true,
            deletedCount: totalDeleted,
            details,
            message: `Successfully cleaned up ${totalDeleted} stale live location entries`,
        };
    }
    catch (error) {
        firebase_functions_1.logger.error('Manual live location cleanup failed:', error);
        await db.collection('adminLogs').add({
            action: 'manual_live_location_cleanup_error',
            timestamp: firestore_1.FieldValue.serverTimestamp(),
            adminUid,
            error: error instanceof Error ? error.message : String(error),
        });
        throw new https_1.HttpsError('internal', 'Cleanup failed: ' + (error instanceof Error ? error.message : String(error)));
    }
});
exports.cleanupJobLiveLocationsCF = (0, https_1.onCall)({ region: 'europe-west1' }, async (request) => {
    var _a, _b;
    const { jobId } = request.data;
    if (!jobId || typeof jobId !== 'string') {
        throw new https_1.HttpsError('invalid-argument', 'jobId is required');
    }
    if (!((_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid)) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required');
    }
    const job = await db.collection('jobs').doc(jobId).get();
    if (!job.exists) {
        throw new https_1.HttpsError('not-found', 'Job not found');
    }
    const jobData = job.data();
    const userIsAdmin = await (0, auth_1.isAdmin)(request.auth);
    const isAuthorized = userIsAdmin ||
        request.auth.uid === jobData.customerUid ||
        request.auth.uid === jobData.assignedProUid ||
        ((_b = jobData.visibleTo) === null || _b === void 0 ? void 0 : _b.includes(request.auth.uid));
    if (!isAuthorized) {
        throw new https_1.HttpsError('permission-denied', 'Not authorized for this job');
    }
    try {
        const liveLocationDoc = db.collection('liveLocations').doc(jobId);
        await liveLocationDoc.delete();
        firebase_functions_1.logger.info(`Cleaned up live locations for job: ${jobId} by user: ${request.auth.uid}`);
        await db.collection('adminLogs').add({
            action: 'job_live_location_cleanup',
            timestamp: firestore_1.FieldValue.serverTimestamp(),
            jobId,
            triggeredBy: request.auth.uid,
            details: `Live locations cleaned up for job completion/cancellation`,
        });
        return {
            success: true,
            message: `Live locations cleaned up for job ${jobId}`,
        };
    }
    catch (error) {
        firebase_functions_1.logger.error(`Failed to cleanup live locations for job ${jobId}:`, error);
        throw new https_1.HttpsError('internal', 'Cleanup failed: ' + (error instanceof Error ? error.message : String(error)));
    }
});
//# sourceMappingURL=liveLocationCleanup.js.map