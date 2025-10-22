"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.leadsService = void 0;
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/v2/https");
const v2_1 = require("firebase-functions/v2");
const chat_1 = require("./chat");
const eta_1 = require("./eta");
exports.leadsService = {
    async acceptLead({ leadId, userId }) {
        v2_1.logger.info(`Processing accept lead ${leadId} for user ${userId}`);
        const db = (0, firestore_1.getFirestore)();
        return db.runTransaction(async (transaction) => {
            var _a;
            const leadRef = db.collection('leads').doc(leadId);
            const leadDoc = await transaction.get(leadRef);
            if (!leadDoc.exists) {
                throw new https_1.HttpsError('not-found', 'Lead not found');
            }
            const leadData = leadDoc.data();
            if (!leadData) {
                throw new https_1.HttpsError('internal', 'Lead data is missing');
            }
            if (leadData.proUid !== userId) {
                throw new https_1.HttpsError('permission-denied', 'You can only accept your own leads');
            }
            if (leadData.status !== 'pending') {
                throw new https_1.HttpsError('failed-precondition', 'Lead is no longer pending');
            }
            const jobRef = db.collection('jobs').doc(leadData.jobId);
            const jobDoc = await transaction.get(jobRef);
            if (!jobDoc.exists) {
                throw new https_1.HttpsError('not-found', 'Associated job not found');
            }
            const jobData = jobDoc.data();
            if (!jobData) {
                throw new https_1.HttpsError('internal', 'Job data is missing');
            }
            if (jobData.status !== 'open') {
                throw new https_1.HttpsError('failed-precondition', 'Job is no longer open');
            }
            transaction.update(leadRef, {
                status: 'accepted',
                acceptedAt: firestore_1.FieldValue.serverTimestamp(),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            transaction.update(jobRef, {
                status: 'assigned',
                visibleTo: firestore_1.FieldValue.arrayUnion(userId),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            v2_1.logger.info(`Lead ${leadId} accepted and job ${leadData.jobId} assigned to user ${userId}`);
            const chatResult = await chat_1.chatService.ensureChat({
                jobId: leadData.jobId,
                customerUid: jobData.customerUid,
                proUid: userId,
            });
            let jobEventId = null;
            try {
                const now = firestore_1.FieldValue.serverTimestamp();
                const eventStart = new Date(((_a = jobData.scheduledDate) === null || _a === void 0 ? void 0 : _a.toDate()) || Date.now() + 86400000);
                let travelTimeMinutes = 0;
                try {
                    const proProfile = await db.collection('proProfiles').doc(userId).get();
                    const proData = proProfile.data();
                    if (proProfile.exists && (proData === null || proData === void 0 ? void 0 : proData.address) && jobData.address) {
                        const etaResult = await eta_1.etaService.calculateEta({
                            origin: proData.address,
                            destination: jobData.address
                        });
                        travelTimeMinutes = etaResult.minutes;
                        transaction.update(jobRef, {
                            estimatedTravelTime: travelTimeMinutes,
                            travelDataUpdatedAt: firestore_1.FieldValue.serverTimestamp(),
                        });
                    }
                }
                catch (etaError) {
                    v2_1.logger.warn('Failed to calculate ETA for job assignment:', etaError);
                }
                const eventEnd = new Date(eventStart.getTime() + (jobData.estimatedDuration || 3) * 60 * 60 * 1000);
                const jobEventData = {
                    ownerUid: userId,
                    type: 'job',
                    start: eventStart,
                    end: eventEnd,
                    rrule: null,
                    location: jobData.address ? {
                        address: jobData.address,
                        coordinates: jobData.coordinates || null,
                    } : null,
                    bufferBefore: 15,
                    bufferAfter: 15,
                    visibility: 'busy',
                    jobId: leadData.jobId,
                    createdAt: now,
                    updatedAt: now,
                };
                const eventRef = await db.collection('calendarEvents').add(jobEventData);
                jobEventId = eventRef.id;
                v2_1.logger.info(`Created job event ${jobEventId} for job ${leadData.jobId} and pro ${userId}`);
            }
            catch (eventError) {
                v2_1.logger.warn(`Failed to create job event for job ${leadData.jobId}:`, eventError);
            }
            return {
                leadId,
                jobId: leadData.jobId,
                chatId: chatResult.chatId,
                chatExisted: chatResult.existed,
                jobEventId,
                message: 'Lead accepted successfully',
            };
        });
    },
    async declineLead({ leadId, userId }) {
        v2_1.logger.info(`Processing decline lead ${leadId} for user ${userId}`);
        const db = (0, firestore_1.getFirestore)();
        return db.runTransaction(async (transaction) => {
            const leadRef = db.collection('leads').doc(leadId);
            const leadDoc = await transaction.get(leadRef);
            if (!leadDoc.exists) {
                throw new https_1.HttpsError('not-found', 'Lead not found');
            }
            const leadData = leadDoc.data();
            if (!leadData) {
                throw new https_1.HttpsError('internal', 'Lead data is missing');
            }
            if (leadData.proUid !== userId) {
                throw new https_1.HttpsError('permission-denied', 'You can only decline your own leads');
            }
            if (leadData.status !== 'pending') {
                throw new https_1.HttpsError('failed-precondition', 'Lead is no longer pending');
            }
            transaction.update(leadRef, {
                status: 'declined',
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            v2_1.logger.info(`Lead ${leadId} declined by user ${userId}`);
            return {
                leadId,
                message: 'Lead declined successfully',
            };
        });
    },
};
//# sourceMappingURL=leads.js.map