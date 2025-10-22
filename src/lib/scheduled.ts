import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import * as stripeService from './stripe';

/**
 * Scheduled function to release escrow payments after 24h hold period
 * Runs every hour to check for payments eligible for automatic release
 */
export const autoReleaseEscrow = onSchedule(
  {
    region: 'europe-west1',
    schedule: '0 * * * *', // Every hour at minute 0
    timeZone: 'Europe/Berlin',
  },
  async () => {
    const db = getFirestore();
    
    try {
      logger.info('Starting automatic escrow release check');
      
      // Query for payments that:
      // 1. Are captured (not pending)
      // 2. Have not been transferred yet
      // 3. Have passed the 24h escrow hold period
      const now = new Date();
      const paymentsQuery = db.collection('payments')
        .where('status', '==', 'captured')
        .where('escrowHoldUntil', '<=', now)
        .limit(50); // Process in batches
      
      const paymentsSnapshot = await paymentsQuery.get();
      
      if (paymentsSnapshot.empty) {
        logger.info('No payments eligible for automatic release');
        return;
      }
      
      logger.info(`Found ${paymentsSnapshot.size} payments eligible for release`);
      
      // Process each payment
      const releasePromises = paymentsSnapshot.docs.map(async (paymentDoc) => {
        const payment = paymentDoc.data();
        const paymentId = paymentDoc.id;
        
        try {
          // Double-check that payment hasn't been transferred already
          if (payment.status === 'transferred') {
            logger.info(`Payment ${paymentId} already transferred, skipping`);
            return;
          }
          
          // Only release if there's a connected account for transfer
          if (!payment.connectedAccountId) {
            logger.warn(`Payment ${paymentId} has no connected account, skipping`);
            return;
          }
          
          logger.info(`Auto-releasing payment ${paymentId} to ${payment.connectedAccountId}`);

          let proUid: string | null = payment.proUid ?? null;
          let customerUid: string | null = payment.customerUid ?? null;

          if (!proUid || !customerUid) {
            try {
              const jobSnapshot = payment.jobId
                ? await db.collection('jobs').doc(payment.jobId).get()
                : null;
              const jobData = jobSnapshot?.exists ? jobSnapshot.data() : null;
              proUid = proUid ?? (jobData?.assignedProUid ?? jobData?.proUid ?? null);
              customerUid = customerUid ?? (jobData?.customerUid ?? null);
            } catch (lookupError) {
              logger.warn(`Unable to resolve job metadata for payment ${paymentId}`, lookupError);
            }
          }
          
          // Calculate fees and net amount
          const { platformFeeAmount, amountNet } = stripeService.calculateFees(payment.amountGross);
          
          // Create transfer
          const transfer = await stripeService.createTransfer({
            amount: Math.round(amountNet * 100), // Convert to cents
            currency: payment.currency,
            destination: payment.connectedAccountId,
            transferGroup: `job_${payment.jobId}`,
            metadata: {
              paymentId,
              jobId: payment.jobId,
              platformFee: platformFeeAmount.toString(),
              autoRelease: 'true',
            },
          });
          
          // Update payment status and create transfer record
          const transferData: Record<string, unknown> = {
            id: transfer.id,
            paymentId,
            jobId: payment.jobId,
            connectedAccountId: payment.connectedAccountId,
            amountNet,
            platformFee: platformFeeAmount,
            currency: payment.currency,
            status: 'completed',
            manualRelease: false,
            releasedBy: 'system',
            createdAt: new Date(),
            stripeTransferId: transfer.id,
          };

          if (payment.amountGross != null) {
            transferData.amountGross = payment.amountGross;
          }
          if (proUid) {
            transferData.proUid = proUid;
          }
          if (customerUid) {
            transferData.customerUid = customerUid;
          }
          
          const paymentUpdate: Record<string, unknown> = {
            status: 'transferred',
            transferId: transfer.id,
            transferredAt: new Date(),
            platformFee: platformFeeAmount,
          };

          if (proUid) {
            paymentUpdate.proUid = proUid;
          }

          await Promise.all([
            db.collection('payments').doc(paymentId).update(paymentUpdate),
            db.collection('transfers').doc(transfer.id).set(transferData),
          ]);
          
          logger.info(`Successfully released payment ${paymentId}, transfer: ${transfer.id}`);
          
        } catch (error) {
          logger.error(`Failed to release payment ${paymentId}:`, error);
          // Continue with other payments even if one fails
        }
      });
      
      await Promise.allSettled(releasePromises);
      logger.info('Automatic escrow release check completed');
      
    } catch (error) {
      logger.error('Error in automatic escrow release:', error);
      throw error; // Rethrow to trigger Cloud Scheduler retry
    }
  }
);