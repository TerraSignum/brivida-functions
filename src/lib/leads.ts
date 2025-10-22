import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { chatService } from './chat';
import { etaService } from './eta';

export interface AcceptLeadParams {
  leadId: string;
  userId: string;
}

export interface DeclineLeadParams {
  leadId: string;
  userId: string;
}

export const leadsService = {
  async acceptLead({ leadId, userId }: AcceptLeadParams) {
    logger.info(`Processing accept lead ${leadId} for user ${userId}`);
    
    const db = getFirestore();

    return db.runTransaction(async (transaction) => {
      // Get the lead document
      const leadRef = db.collection('leads').doc(leadId);
      const leadDoc = await transaction.get(leadRef);

      if (!leadDoc.exists) {
        throw new HttpsError('not-found', 'Lead not found');
      }

      const leadData = leadDoc.data();
      if (!leadData) {
        throw new HttpsError('internal', 'Lead data is missing');
      }

      // Validate ownership
      if (leadData.proUid !== userId) {
        throw new HttpsError('permission-denied', 'You can only accept your own leads');
      }

      // Validate current status
      if (leadData.status !== 'pending') {
        throw new HttpsError('failed-precondition', 'Lead is no longer pending');
      }

      // Get the associated job
      const jobRef = db.collection('jobs').doc(leadData.jobId);
      const jobDoc = await transaction.get(jobRef);

      if (!jobDoc.exists) {
        throw new HttpsError('not-found', 'Associated job not found');
      }

      const jobData = jobDoc.data();
      if (!jobData) {
        throw new HttpsError('internal', 'Job data is missing');
      }

      // Validate job status
      if (jobData.status !== 'open') {
        throw new HttpsError('failed-precondition', 'Job is no longer open');
      }

      // Update lead to accepted
      transaction.update(leadRef, {
        status: 'accepted',
        acceptedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Update job to assigned and add pro to visibility
      transaction.update(jobRef, {
        status: 'assigned',
        visibleTo: FieldValue.arrayUnion(userId),
        updatedAt: FieldValue.serverTimestamp(),
      });

      logger.info(`Lead ${leadId} accepted and job ${leadData.jobId} assigned to user ${userId}`);
      
      // Create chat after successful transaction
      const chatResult = await chatService.ensureChat({
        jobId: leadData.jobId,
        customerUid: jobData.customerUid,
        proUid: userId,
      });

      // Create job event in pro's calendar
      let jobEventId: string | null = null;
      try {
        const now = FieldValue.serverTimestamp();
        
        // Create job event with default timing (can be adjusted later)
        // Create job event with timing from job data and ETA calculation
        const eventStart = new Date(jobData.scheduledDate?.toDate() || Date.now() + 86400000); // Tomorrow fallback
        
        // Calculate ETA from pro location to job location for travel planning
        let travelTimeMinutes = 0;
        try {
          const proProfile = await db.collection('proProfiles').doc(userId).get();
          const proData = proProfile.data();
          if (proProfile.exists && proData?.address && jobData.address) {
            const etaResult = await etaService.calculateEta({
              origin: proData.address,
              destination: jobData.address
            });
            travelTimeMinutes = etaResult.minutes;
            
            // Store ETA in job for future reference
            transaction.update(jobRef, {
              estimatedTravelTime: travelTimeMinutes,
              travelDataUpdatedAt: FieldValue.serverTimestamp(),
            });
          }
        } catch (etaError) {
          logger.warn('Failed to calculate ETA for job assignment:', etaError);
          // Continue without ETA data
        }
        
        // Use travel time for event start (considering buffer)
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
          bufferBefore: 15, // Default 15 minutes before
          bufferAfter: 15,  // Default 15 minutes after
          visibility: 'busy',
          jobId: leadData.jobId,
          createdAt: now,
          updatedAt: now,
        };

        const eventRef = await db.collection('calendarEvents').add(jobEventData);
        jobEventId = eventRef.id;
        
        logger.info(`Created job event ${jobEventId} for job ${leadData.jobId} and pro ${userId}`);
      } catch (eventError) {
        logger.warn(`Failed to create job event for job ${leadData.jobId}:`, eventError);
        // Don't fail the lead acceptance if event creation fails
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

  async declineLead({ leadId, userId }: DeclineLeadParams) {
    logger.info(`Processing decline lead ${leadId} for user ${userId}`);
    
    const db = getFirestore();

    return db.runTransaction(async (transaction) => {
      // Get the lead document
      const leadRef = db.collection('leads').doc(leadId);
      const leadDoc = await transaction.get(leadRef);

      if (!leadDoc.exists) {
        throw new HttpsError('not-found', 'Lead not found');
      }

      const leadData = leadDoc.data();
      if (!leadData) {
        throw new HttpsError('internal', 'Lead data is missing');
      }

      // Validate ownership
      if (leadData.proUid !== userId) {
        throw new HttpsError('permission-denied', 'You can only decline your own leads');
      }

      // Validate current status
      if (leadData.status !== 'pending') {
        throw new HttpsError('failed-precondition', 'Lead is no longer pending');
      }

      // Update lead to declined
      transaction.update(leadRef, {
        status: 'declined',
        updatedAt: FieldValue.serverTimestamp(),
      });

      logger.info(`Lead ${leadId} declined by user ${userId}`);
      
      return {
        leadId,
        message: 'Lead declined successfully',
      };
    });
  },
};