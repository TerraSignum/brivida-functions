// PG-16: Live Location Cleanup Functions
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { isAdmin, enforceAdminRole } from './auth';

const db = getFirestore();

/**
 * Process cleanup for a specific job document
 */
async function processJobCleanup(jobDoc: any, cutoffTime: Date): Promise<number> {
  const jobId = jobDoc.id;
  let deletedCount = 0;

  // Check if job exists and is active
  const job = await db.collection('jobs').doc(jobId).get();
  if (!job.exists) {
    await jobDoc.ref.delete();
    logger.info(`Deleted live locations for non-existent job: ${jobId}`);
    return 1;
  }

  const jobData = job.data()!;
  const jobStatus = jobData.status;

  // If job is not in active status, delete all live locations
  if (!['assigned', 'in_progress'].includes(jobStatus)) {
    await jobDoc.ref.delete();
    logger.info(`Deleted live locations for completed job: ${jobId} (status: ${jobStatus})`);
    return 1;
  }

  // For active jobs, check individual pro locations for staleness
  const prosSnapshot = await jobDoc.ref.collection('pros').get();
  
  for (const proDoc of prosSnapshot.docs) {
    const data = proDoc.data();
    
    if (!data.updatedAt || data.updatedAt.toDate() < cutoffTime) {
      await proDoc.ref.delete();
      deletedCount++;
      
      if (data.updatedAt) {
        const age = Math.round((Date.now() - data.updatedAt.toDate().getTime()) / 60000);
        logger.info(`Deleted stale location for pro ${proDoc.id} in job ${jobId} (age: ${age} minutes)`);
      }
    }
  }

  // If no pros are left, delete the job's live location document
  const remainingPros = await jobDoc.ref.collection('pros').get();
  if (remainingPros.empty) {
    await jobDoc.ref.delete();
  }

  return deletedCount;
}

/**
 * Scheduled function to cleanup old live location data
 * Runs every 15 minutes to clean up stale location data
 */
export const cleanupLiveLocations = onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: 'UTC',
    region: 'europe-west1',
  },
  async () => {
    logger.info('Starting live location cleanup');

    try {
      const now = new Date();
      const cutoffTime = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago
      let totalDeleted = 0;

      // Get all live location collections
      const liveLocationsSnapshot = await db.collection('liveLocations').get();

      for (const jobDoc of liveLocationsSnapshot.docs) {
        const deleted = await processJobCleanup(jobDoc, cutoffTime);
        totalDeleted += deleted;
      }

      logger.info(`Live location cleanup completed. Deleted ${totalDeleted} stale locations`);

      // Log cleanup activity for monitoring
      await db.collection('adminLogs').add({
        action: 'live_location_cleanup',
        timestamp: FieldValue.serverTimestamp(),
        deletedCount: totalDeleted,
        details: 'Scheduled cleanup of stale live location data',
      });

    } catch (error) {
      logger.error('Live location cleanup failed:', error);
      
      // Log error for admin monitoring
      await db.collection('adminLogs').add({
        action: 'live_location_cleanup_error',
        timestamp: FieldValue.serverTimestamp(),
        error: error instanceof Error ? error.message : String(error),
        details: 'Scheduled cleanup encountered an error',
      });
      
      throw error;
    }
  }
);

/**
 * Process manual cleanup for a specific job document
 */
async function processManualJobCleanup(jobDoc: any, cutoffTime: Date, details: string[]): Promise<number> {
  const jobId = jobDoc.id;
  let deletedCount = 0;

  // Check if job exists and is active
  const job = await db.collection('jobs').doc(jobId).get();
  if (!job.exists) {
    await jobDoc.ref.delete();
    deletedCount++;
    details.push(`Deleted locations for non-existent job: ${jobId}`);
    return deletedCount;
  }

  const jobData = job.data()!;
  const jobStatus = jobData.status;

  if (!['assigned', 'in_progress'].includes(jobStatus)) {
    await jobDoc.ref.delete();
    deletedCount++;
    details.push(`Deleted locations for completed job: ${jobId} (status: ${jobStatus})`);
    return deletedCount;
  }

  // Check individual pro locations
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

  // Clean up empty job documents
  const remainingPros = await jobDoc.ref.collection('pros').get();
  if (remainingPros.empty) {
    await jobDoc.ref.delete();
  }

  return deletedCount;
}

/**
 * Callable function to manually trigger live location cleanup (admin only)
 */
export const triggerLiveLocationCleanupCF = onCall(
  { region: 'europe-west1' },
  async (request) => {
    const { auth } = request;
    if (!auth) {
      throw new HttpsError('unauthenticated', 'Authentication required');
    }

    await enforceAdminRole(auth);
    const adminUid = auth.uid;

    logger.info('Manual live location cleanup triggered by admin:', adminUid);

    try {
      const now = new Date();
      const cutoffTime = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago
      let totalDeleted = 0;
      const details: string[] = [];

      // Get all live location collections
      const liveLocationsSnapshot = await db.collection('liveLocations').get();

      for (const jobDoc of liveLocationsSnapshot.docs) {
        const deleted = await processManualJobCleanup(jobDoc, cutoffTime, details);
        totalDeleted += deleted;
      }

      // Log the manual cleanup
      await db.collection('adminLogs').add({
        action: 'manual_live_location_cleanup',
        timestamp: FieldValue.serverTimestamp(),
        adminUid,
        triggeredBy: adminUid,
        deletedCount: totalDeleted,
        details: details.join('; '),
      });

      logger.info(`Manual live location cleanup completed. Deleted ${totalDeleted} stale locations`);

      return {
        success: true,
        deletedCount: totalDeleted,
        details,
        message: `Successfully cleaned up ${totalDeleted} stale live location entries`,
      };

    } catch (error) {
      logger.error('Manual live location cleanup failed:', error);
      
      await db.collection('adminLogs').add({
        action: 'manual_live_location_cleanup_error',
        timestamp: FieldValue.serverTimestamp(),
        adminUid,
        error: error instanceof Error ? error.message : String(error),
      });
      
      throw new HttpsError('internal', 'Cleanup failed: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
);

/**
 * Function to clean up live locations for a specific job (called when job status changes)
 */
export const cleanupJobLiveLocationsCF = onCall(
  { region: 'europe-west1' },
  async (request) => {
    const { jobId } = request.data;

    if (!jobId || typeof jobId !== 'string') {
      throw new HttpsError('invalid-argument', 'jobId is required');
    }

    // Verify the caller is authorized for this job
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Authentication required');
    }

    // Check if user is admin, customer, or assigned pro for this job
    const job = await db.collection('jobs').doc(jobId).get();
    if (!job.exists) {
      throw new HttpsError('not-found', 'Job not found');
    }

    const jobData = job.data()!;
    const userIsAdmin = await isAdmin(request.auth);
    const isAuthorized = 
      userIsAdmin ||
      request.auth.uid === jobData.customerUid ||
      request.auth.uid === jobData.assignedProUid ||
      jobData.visibleTo?.includes(request.auth.uid);

    if (!isAuthorized) {
      throw new HttpsError('permission-denied', 'Not authorized for this job');
    }

    try {
      // Delete all live locations for this job
      const liveLocationDoc = db.collection('liveLocations').doc(jobId);
      await liveLocationDoc.delete();

      logger.info(`Cleaned up live locations for job: ${jobId} by user: ${request.auth.uid}`);

      // Log the cleanup
      await db.collection('adminLogs').add({
        action: 'job_live_location_cleanup',
        timestamp: FieldValue.serverTimestamp(),
        jobId,
        triggeredBy: request.auth.uid,
        details: `Live locations cleaned up for job completion/cancellation`,
      });

      return {
        success: true,
        message: `Live locations cleaned up for job ${jobId}`,
      };

    } catch (error) {
      logger.error(`Failed to cleanup live locations for job ${jobId}:`, error);
      throw new HttpsError('internal', 'Cleanup failed: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
);