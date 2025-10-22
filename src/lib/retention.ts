import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';

/**
 * Data Retention Service for GDPR compliance
 * Handles automatic deletion/anonymization of personal data after retention periods
 */

interface RetentionConfig {
  jobsPrivateRetentionMonths: number;
  chatRetentionMonths: number;
  disputeRetentionMonths: number;
}

/**
 * Get retention configuration from admin settings
 */
async function getRetentionConfig(): Promise<RetentionConfig> {
  const db = getFirestore();
  
  try {
    const configDoc = await db.collection('adminSettings').doc('retention').get();
    
    if (configDoc.exists) {
      const config = configDoc.data();
      return {
        jobsPrivateRetentionMonths: config?.jobsPrivateRetentionMonths || 12,
        chatRetentionMonths: config?.chatRetentionMonths || 24,
        disputeRetentionMonths: config?.disputeRetentionMonths || 36,
      };
    }
  } catch (error) {
    logger.error('Error getting retention config:', error);
  }

  // Default values if config doesn't exist
  return {
    jobsPrivateRetentionMonths: 12,
    chatRetentionMonths: 24,
    disputeRetentionMonths: 36,
  };
}

/**
 * Delete or anonymize old jobsPrivate data
 */
async function cleanupJobsPrivate(retentionMonths: number): Promise<number> {
  const db = getFirestore();
  let deletedCount = 0;

  try {
    // Calculate cutoff date
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - retentionMonths);

    logger.info(`Cleaning up jobsPrivate data older than ${cutoffDate.toISOString()}`);

    // Query for old jobsPrivate documents
    const oldJobsQuery = await db
      .collection('jobsPrivate')
      .where('createdAt', '<', cutoffDate)
      .limit(100) // Process in batches to avoid timeouts
      .get();

    if (oldJobsQuery.empty) {
      logger.info('No old jobsPrivate data found for cleanup');
      return 0;
    }

    // Use batch to delete documents
    const batch = db.batch();
    
    oldJobsQuery.docs.forEach((doc) => {
      const data = doc.data();
      
      // Log what we're deleting (without sensitive data)
      logger.info(`Deleting jobsPrivate document: ${doc.id} from ${data.createdAt?.toDate()}`);
      
      batch.delete(doc.ref);
      deletedCount++;
    });

    await batch.commit();
    logger.info(`Successfully deleted ${deletedCount} old jobsPrivate documents`);

  } catch (error) {
    logger.error('Error during jobsPrivate cleanup:', error);
    throw error;
  }

  return deletedCount;
}

/**
 * Anonymize old chat messages (keep structure but remove content)
 */
async function anonymizeOldChats(retentionMonths: number): Promise<number> {
  const db = getFirestore();
  let anonymizedCount = 0;

  try {
    // Calculate cutoff date
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - retentionMonths);

    logger.info(`Anonymizing chat messages older than ${cutoffDate.toISOString()}`);

    // Query for old chats
    const chatsSnapshot = await db.collection('chats').get();

    for (const chatDoc of chatsSnapshot.docs) {
      const messagesQuery = await chatDoc.ref
        .collection('messages')
        .where('timestamp', '<', cutoffDate)
        .limit(50) // Process in smaller batches for nested collections
        .get();

      if (!messagesQuery.empty) {
        const batch = db.batch();
        
        messagesQuery.docs.forEach((messageDoc) => {
          // Anonymize message content but keep metadata for analytics
          batch.update(messageDoc.ref, {
            text: '[ANONYMIZED]',
            fileUrl: null,
            fileName: null,
            anonymizedAt: new Date(),
          });
          anonymizedCount++;
        });

        await batch.commit();
        logger.info(`Anonymized ${messagesQuery.docs.length} messages in chat ${chatDoc.id}`);
      }
    }

  } catch (error) {
    logger.error('Error during chat anonymization:', error);
    throw error;
  }

  return anonymizedCount;
}

/**
 * Delete old dispute evidence files and anonymize personal data
 */
async function cleanupOldDisputes(retentionMonths: number): Promise<number> {
  const db = getFirestore();
  let processedCount = 0;

  try {
    // Calculate cutoff date
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - retentionMonths);

    logger.info(`Cleaning up disputes older than ${cutoffDate.toISOString()}`);

    const oldDisputesQuery = await db
      .collection('disputes')
      .where('createdAt', '<', cutoffDate)
      .where('status', 'in', ['resolved', 'closed'])
      .limit(50)
      .get();

    if (oldDisputesQuery.empty) {
      logger.info('No old disputes found for cleanup');
      return 0;
    }

    const batch = db.batch();
    
    oldDisputesQuery.docs.forEach((doc) => {
      // Anonymize personal data but keep case structure for legal compliance
      batch.update(doc.ref, {
        description: '[ANONYMIZED]',
        evidenceFiles: [],
        chatHistory: [],
        personalDataCleanedAt: new Date(),
      });
      processedCount++;
    });

    await batch.commit();
    logger.info(`Anonymized ${processedCount} old dispute documents`);

  } catch (error) {
    logger.error('Error during dispute cleanup:', error);
    throw error;
  }

  return processedCount;
}

/**
 * Main data retention cleanup function
 */
export async function runDataRetentionCleanup(): Promise<{
  jobsPrivateDeleted: number;
  chatsAnonymized: number;
  disputesProcessed: number;
  configUsed: RetentionConfig;
}> {
  logger.info('Starting scheduled data retention cleanup');
  
  try {
    // Get current retention configuration
    const config = await getRetentionConfig();
    logger.info('Using retention config:', config);

    // Run cleanup tasks
    const [jobsPrivateDeleted, chatsAnonymized, disputesProcessed] = await Promise.all([
      cleanupJobsPrivate(config.jobsPrivateRetentionMonths),
      anonymizeOldChats(config.chatRetentionMonths),
      cleanupOldDisputes(config.disputeRetentionMonths),
    ]);

    const summary = {
      jobsPrivateDeleted,
      chatsAnonymized,
      disputesProcessed,
      configUsed: config,
    };

    logger.info('Data retention cleanup completed:', summary);

    // Log analytics event for compliance monitoring
    await logRetentionEvent(summary);

    return summary;

  } catch (error) {
    logger.error('Data retention cleanup failed:', error);
    throw error;
  }
}

/**
 * Log retention event for compliance monitoring
 */
async function logRetentionEvent(summary: any): Promise<void> {
  const db = getFirestore();
  
  try {
    await db.collection('complianceLogs').add({
      type: 'data_retention_cleanup',
      timestamp: new Date(),
      summary,
      region: 'europe-west1',
    });
  } catch (error) {
    logger.warn('Failed to log retention event:', error);
  }
}

/**
 * Initialize default retention configuration
 */
export async function initializeRetentionConfig(): Promise<void> {
  const db = getFirestore();
  
  try {
    const configDoc = await db.collection('adminSettings').doc('retention').get();
    
    if (!configDoc.exists) {
      await db.collection('adminSettings').doc('retention').set({
        jobsPrivateRetentionMonths: 12,
        chatRetentionMonths: 24,
        disputeRetentionMonths: 36,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      logger.info('Initialized default retention configuration');
    }
  } catch (error) {
    logger.error('Error initializing retention config:', error);
  }
}