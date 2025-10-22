import { logger } from 'firebase-functions/v2';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';

import { firestoreHelpers } from './firestore';
import * as stripeService from './stripe';
import { isAdmin } from './auth';
import { logServerEvent } from '../analytics/helpers';

interface CreatePaymentIntentData {
  jobId?: string;
  amount?: number;
  currency?: string;
  connectedAccountId?: string;
}

interface ReleaseTransferData {
  paymentId?: string;
  manualRelease?: boolean;
}

interface PartialRefundData {
  paymentId?: string;
  refundAmount?: number;
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
}

const DEFAULT_CURRENCY = 'eur';
const MIN_AMOUNT_EUR = 0.5; // 50 cents

export async function createPaymentIntentHandler(
  request: CallableRequest<CreatePaymentIntentData>,
) {
  const { auth, data } = request;

  if (!auth) {
    throw new HttpsError('unauthenticated', 'User must be authenticated');
  }

  const { jobId, amount, currency = DEFAULT_CURRENCY, connectedAccountId } = data;

  if (!jobId || amount == null) {
    throw new HttpsError('invalid-argument', 'jobId and amount are required');
  }

  if (amount < MIN_AMOUNT_EUR) {
    throw new HttpsError('invalid-argument', 'Amount must be at least 50 cents');
  }

  try {
    const job = await firestoreHelpers.getJob(jobId);
    if (!job) {
      throw new HttpsError('not-found', 'Job not found');
    }

    if (job.customerUid !== auth.uid) {
      throw new HttpsError('permission-denied', 'Only job customer can create payment');
    }

    const paymentIntent = await stripeService.createPaymentIntent({
      amount: Math.round(amount * 100),
      currency,
      customerId: auth.uid,
      connectedAccountId,
      metadata: {
        jobId,
        customerUid: auth.uid,
        connectedAccountId: connectedAccountId || '',
      },
    });

    const paymentData = {
      id: paymentIntent.id,
      jobId,
      customerUid: auth.uid,
      connectedAccountId: connectedAccountId || null,
      amountGross: amount,
      currency,
      status: 'pending',
      escrowHoldUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      stripePaymentIntentId: paymentIntent.id,
    };

    await firestoreHelpers.collections.payments().doc(paymentIntent.id).set(paymentData);

    return {
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
    };
  } catch (error) {
    logger.error('Error creating payment intent:', error);

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError('internal', 'Failed to create payment intent');
  }
}

function toDate(value: any): Date {
  if (!value) {
    return new Date(0);
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value.toDate === 'function') {
    return value.toDate();
  }

  return new Date(value);
}

function ensureManualReleaseAllowed(payment: any, authUid: string, manualRelease: boolean) {
  if (!manualRelease) {
    return;
  }

  if (payment.customerUid !== authUid) {
    throw new HttpsError('permission-denied', 'Only customer can manually release payment');
  }
}

function ensurePaymentEligibleForTransfer(payment: any, manualRelease: boolean) {
  if (!manualRelease) {
    const escrowUntil = toDate(payment.escrowHoldUntil);
    if (new Date() < escrowUntil) {
      throw new HttpsError('failed-precondition', 'Escrow hold period has not expired');
    }
  }

  if (payment.status === 'transferred') {
    throw new HttpsError('failed-precondition', 'Payment already transferred');
  }

  if (payment.status !== 'captured') {
    throw new HttpsError('failed-precondition', 'Payment must be captured before transfer');
  }

  if (!payment.connectedAccountId) {
    throw new HttpsError('failed-precondition', 'No connected account for transfer');
  }
}

async function resolveTransferParticipants(paymentId: string, payment: any) {
  let proUid: string | null = payment.proUid ?? null;
  let customerUid: string | null = payment.customerUid ?? null;

  if (!proUid || !customerUid) {
    try {
      const jobSnapshot = payment.jobId
        ? await firestoreHelpers.collections.jobs().doc(payment.jobId).get()
        : null;
      const jobData = jobSnapshot?.exists ? jobSnapshot.data() : null;

      if (!proUid) {
        proUid = jobData?.assignedProUid ?? jobData?.proUid ?? null;
      }

      if (!customerUid) {
        customerUid = jobData?.customerUid ?? null;
      }
    } catch (error) {
      logger.warn('PAYMENTS: Unable to resolve job metadata during transfer', {
        paymentId,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  return { proUid, customerUid };
}

export async function releaseTransferHandler(
  request: CallableRequest<ReleaseTransferData>,
) {
  const { auth, data } = request;

  if (!auth) {
    throw new HttpsError('unauthenticated', 'User must be authenticated');
  }

  const { paymentId, manualRelease = false } = data;

  if (!paymentId) {
    throw new HttpsError('invalid-argument', 'paymentId is required');
  }

  try {
    const paymentDoc = await firestoreHelpers.collections.payments().doc(paymentId).get();
    if (!paymentDoc.exists) {
      throw new HttpsError('not-found', 'Payment not found');
    }

    const payment = paymentDoc.data();
    if (!payment) {
      throw new HttpsError('not-found', 'Payment data not found');
    }

    ensureManualReleaseAllowed(payment, auth.uid, manualRelease);
    ensurePaymentEligibleForTransfer(payment, manualRelease);

    const { platformFeeAmount, amountNet } = stripeService.calculateFees(payment.amountGross);

    const { proUid, customerUid } = await resolveTransferParticipants(paymentId, payment);

    const transfer = await stripeService.createTransfer({
      amount: Math.round(amountNet * 100),
      currency: payment.currency,
      destination: payment.connectedAccountId,
      transferGroup: `job_${payment.jobId}`,
      metadata: {
        paymentId,
        jobId: payment.jobId,
        platformFee: platformFeeAmount.toString(),
      },
    });

    const transferData: Record<string, unknown> = {
      id: transfer.id,
      paymentId,
      jobId: payment.jobId,
      connectedAccountId: payment.connectedAccountId,
      amountNet,
      platformFee: platformFeeAmount,
      currency: payment.currency,
      status: 'completed',
      manualRelease,
      releasedBy: manualRelease ? auth.uid : 'system',
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
      firestoreHelpers.collections.payments().doc(paymentId).update(paymentUpdate),
      firestoreHelpers.collections.transfers().doc(transfer.id).set(transferData),
    ]);

    return {
      transferId: transfer.id,
      amountNet,
      platformFee: platformFeeAmount,
    };
  } catch (error) {
    logger.error('Error releasing transfer:', error);

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError('internal', 'Failed to release transfer');
  }
}

export async function partialRefundHandler(
  request: CallableRequest<PartialRefundData>,
) {
  const { auth, data } = request;

  if (!auth) {
    throw new HttpsError('unauthenticated', 'User must be authenticated');
  }

  const { paymentId, refundAmount, reason = 'requested_by_customer' } = data;

  if (!paymentId || refundAmount == null) {
    throw new HttpsError('invalid-argument', 'paymentId and refundAmount are required');
  }

  if (refundAmount <= 0) {
    throw new HttpsError('invalid-argument', 'Refund amount must be positive');
  }

  try {
    const paymentDoc = await firestoreHelpers.collections.payments().doc(paymentId).get();
    if (!paymentDoc.exists) {
      throw new HttpsError('not-found', 'Payment not found');
    }

    const payment = paymentDoc.data();
    if (!payment) {
      throw new HttpsError('not-found', 'Payment data not found');
    }

    if (payment.customerUid !== auth.uid) {
      const userIsAdmin = await isAdmin(auth as any);
      if (!userIsAdmin) {
        throw new HttpsError('permission-denied', 'Only customer or admin can request refund');
      }
    }

    if (payment.status !== 'captured') {
      throw new HttpsError('failed-precondition', 'Payment must be captured for refund');
    }

    if (refundAmount > payment.amountGross) {
      throw new HttpsError('invalid-argument', 'Refund amount cannot exceed payment amount');
    }

    const refund = await stripeService.createRefund({
      paymentIntentId: payment.stripePaymentIntentId,
      amount: Math.round(refundAmount * 100),
      reason,
      metadata: {
        paymentId,
        jobId: payment.jobId,
        requestedBy: auth.uid,
      },
    });

    const refundData = {
      id: refund.id,
      paymentId,
      jobId: payment.jobId,
      amount: refundAmount,
      currency: payment.currency,
      reason,
      status: 'completed',
      requestedBy: auth.uid,
      createdAt: new Date(),
      stripeRefundId: refund.id,
    };

    await firestoreHelpers.collections.refunds().doc(refund.id).set(refundData);

    return {
      refundId: refund.id,
      amount: refundAmount,
      currency: payment.currency,
    };
  } catch (error) {
    logger.error('Error creating partial refund:', error);

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError('internal', 'Failed to create partial refund');
  }
}

export async function handlePaymentIntentSucceeded(paymentIntent: any) {
  try {
    const paymentId = paymentIntent.id;
    const paymentDoc = await firestoreHelpers.collections.payments().doc(paymentId).get();

    if (!paymentDoc.exists) {
      logger.warn('Payment not found for succeeded PaymentIntent', { paymentId });
      return;
    }

    await firestoreHelpers.collections.payments().doc(paymentId).update({
      status: 'captured',
      capturedAt: new Date(),
      stripeChargeId: paymentIntent.latest_charge,
    });

    const payment = paymentDoc.data();
    if (payment?.jobId) {
      await firestoreHelpers.updateJob(payment.jobId, {
        status: 'assigned',
        updatedAt: new Date(),
      });
    }

    await logServerEvent({
      uid: payment?.customerUid,
      role: 'customer',
      name: 'payment_captured',
      props: {
        paymentId,
        jobId: payment?.jobId,
        customerUid: payment?.customerUid,
        proUid: payment?.proUid,
        amountEur: payment?.amountEur,
      },
    });

    logger.info('Payment captured successfully', { paymentId });
  } catch (error) {
    logger.error('Error handling payment_intent.succeeded:', error);
  }
}

export async function handleTransferCreated(transfer: any) {
  try {
    const transferId = transfer.id;
    const transferDoc = await firestoreHelpers.collections.transfers().doc(transferId).get();

    if (transferDoc.exists) {
      const transferData = transferDoc.data();

      await firestoreHelpers.collections.transfers().doc(transferId).update({
        status: 'completed',
        completedAt: new Date(),
      });

      await logServerEvent({
        uid: transferData?.proUid,
        role: 'pro',
        name: 'payment_released',
        props: {
          transferId,
          paymentId: transferData?.paymentId,
          jobId: transferData?.jobId,
          amountEur: transferData?.amountEur,
        },
      });

      logger.info('Transfer completed', { transferId });
    }
  } catch (error) {
    logger.error('Error handling transfer.created:', error);
  }
}

export async function handleChargeRefunded(charge: any) {
  try {
    const paymentsSnapshot = await firestoreHelpers.collections.payments()
      .where('stripeChargeId', '==', charge.id)
      .limit(1)
      .get();

    if (paymentsSnapshot.empty) {
      logger.warn('Payment not found for refunded charge', { chargeId: charge.id });
      return;
    }

    const paymentDoc = paymentsSnapshot.docs[0];
    const paymentData = paymentDoc.data();
    const totalRefunded = charge.amount_refunded / 100;

    await paymentDoc.ref.update({
      totalRefunded,
      lastRefundedAt: new Date(),
    });

    await logServerEvent({
      uid: paymentData?.customerUid,
      role: 'customer',
      name: 'payment_refunded',
      props: {
        paymentId: paymentDoc.id,
        chargeId: charge.id,
        jobId: paymentData?.jobId,
        customerUid: paymentData?.customerUid,
        proUid: paymentData?.proUid,
        totalRefunded,
        amountEur: paymentData?.amountEur,
      },
    });

    logger.info('Payment refund recorded', {
      paymentId: paymentDoc.id,
      chargeId: charge.id,
      totalRefunded,
    });
  } catch (error) {
    logger.error('Error handling charge.refunded:', error);
  }
}
