"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runDataRetentionCleanup = runDataRetentionCleanup;
exports.initializeRetentionConfig = initializeRetentionConfig;
const firestore_1 = require("firebase-admin/firestore");
const v2_1 = require("firebase-functions/v2");
async function getRetentionConfig() {
    const db = (0, firestore_1.getFirestore)();
    try {
        const configDoc = await db.collection('adminSettings').doc('retention').get();
        if (configDoc.exists) {
            const config = configDoc.data();
            return {
                jobsPrivateRetentionMonths: (config === null || config === void 0 ? void 0 : config.jobsPrivateRetentionMonths) || 12,
                chatRetentionMonths: (config === null || config === void 0 ? void 0 : config.chatRetentionMonths) || 24,
                disputeRetentionMonths: (config === null || config === void 0 ? void 0 : config.disputeRetentionMonths) || 36,
            };
        }
    }
    catch (error) {
        v2_1.logger.error('Error getting retention config:', error);
    }
    return {
        jobsPrivateRetentionMonths: 12,
        chatRetentionMonths: 24,
        disputeRetentionMonths: 36,
    };
}
async function cleanupJobsPrivate(retentionMonths) {
    const db = (0, firestore_1.getFirestore)();
    let deletedCount = 0;
    try {
        const cutoffDate = new Date();
        cutoffDate.setMonth(cutoffDate.getMonth() - retentionMonths);
        v2_1.logger.info(`Cleaning up jobsPrivate data older than ${cutoffDate.toISOString()}`);
        const oldJobsQuery = await db
            .collection('jobsPrivate')
            .where('createdAt', '<', cutoffDate)
            .limit(100)
            .get();
        if (oldJobsQuery.empty) {
            v2_1.logger.info('No old jobsPrivate data found for cleanup');
            return 0;
        }
        const batch = db.batch();
        oldJobsQuery.docs.forEach((doc) => {
            var _a;
            const data = doc.data();
            v2_1.logger.info(`Deleting jobsPrivate document: ${doc.id} from ${(_a = data.createdAt) === null || _a === void 0 ? void 0 : _a.toDate()}`);
            batch.delete(doc.ref);
            deletedCount++;
        });
        await batch.commit();
        v2_1.logger.info(`Successfully deleted ${deletedCount} old jobsPrivate documents`);
    }
    catch (error) {
        v2_1.logger.error('Error during jobsPrivate cleanup:', error);
        throw error;
    }
    return deletedCount;
}
async function anonymizeOldChats(retentionMonths) {
    const db = (0, firestore_1.getFirestore)();
    let anonymizedCount = 0;
    try {
        const cutoffDate = new Date();
        cutoffDate.setMonth(cutoffDate.getMonth() - retentionMonths);
        v2_1.logger.info(`Anonymizing chat messages older than ${cutoffDate.toISOString()}`);
        const chatsSnapshot = await db.collection('chats').get();
        for (const chatDoc of chatsSnapshot.docs) {
            const messagesQuery = await chatDoc.ref
                .collection('messages')
                .where('timestamp', '<', cutoffDate)
                .limit(50)
                .get();
            if (!messagesQuery.empty) {
                const batch = db.batch();
                messagesQuery.docs.forEach((messageDoc) => {
                    batch.update(messageDoc.ref, {
                        text: '[ANONYMIZED]',
                        fileUrl: null,
                        fileName: null,
                        anonymizedAt: new Date(),
                    });
                    anonymizedCount++;
                });
                await batch.commit();
                v2_1.logger.info(`Anonymized ${messagesQuery.docs.length} messages in chat ${chatDoc.id}`);
            }
        }
    }
    catch (error) {
        v2_1.logger.error('Error during chat anonymization:', error);
        throw error;
    }
    return anonymizedCount;
}
async function cleanupOldDisputes(retentionMonths) {
    const db = (0, firestore_1.getFirestore)();
    let processedCount = 0;
    try {
        const cutoffDate = new Date();
        cutoffDate.setMonth(cutoffDate.getMonth() - retentionMonths);
        v2_1.logger.info(`Cleaning up disputes older than ${cutoffDate.toISOString()}`);
        const oldDisputesQuery = await db
            .collection('disputes')
            .where('createdAt', '<', cutoffDate)
            .where('status', 'in', ['resolved', 'closed'])
            .limit(50)
            .get();
        if (oldDisputesQuery.empty) {
            v2_1.logger.info('No old disputes found for cleanup');
            return 0;
        }
        const batch = db.batch();
        oldDisputesQuery.docs.forEach((doc) => {
            batch.update(doc.ref, {
                description: '[ANONYMIZED]',
                evidenceFiles: [],
                chatHistory: [],
                personalDataCleanedAt: new Date(),
            });
            processedCount++;
        });
        await batch.commit();
        v2_1.logger.info(`Anonymized ${processedCount} old dispute documents`);
    }
    catch (error) {
        v2_1.logger.error('Error during dispute cleanup:', error);
        throw error;
    }
    return processedCount;
}
async function runDataRetentionCleanup() {
    v2_1.logger.info('Starting scheduled data retention cleanup');
    try {
        const config = await getRetentionConfig();
        v2_1.logger.info('Using retention config:', config);
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
        v2_1.logger.info('Data retention cleanup completed:', summary);
        await logRetentionEvent(summary);
        return summary;
    }
    catch (error) {
        v2_1.logger.error('Data retention cleanup failed:', error);
        throw error;
    }
}
async function logRetentionEvent(summary) {
    const db = (0, firestore_1.getFirestore)();
    try {
        await db.collection('complianceLogs').add({
            type: 'data_retention_cleanup',
            timestamp: new Date(),
            summary,
            region: 'europe-west1',
        });
    }
    catch (error) {
        v2_1.logger.warn('Failed to log retention event:', error);
    }
}
async function initializeRetentionConfig() {
    const db = (0, firestore_1.getFirestore)();
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
            v2_1.logger.info('Initialized default retention configuration');
        }
    }
    catch (error) {
        v2_1.logger.error('Error initializing retention config:', error);
    }
}
//# sourceMappingURL=retention.js.map