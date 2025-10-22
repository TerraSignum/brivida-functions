"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPaymentIntentHandler = createPaymentIntentHandler;
exports.releaseTransferHandler = releaseTransferHandler;
exports.partialRefundHandler = partialRefundHandler;
exports.handlePaymentIntentSucceeded = handlePaymentIntentSucceeded;
exports.handleTransferCreated = handleTransferCreated;
exports.handleChargeRefunded = handleChargeRefunded;
const v2_1 = require("firebase-functions/v2");
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("./firestore");
const stripeService = __importStar(require("./stripe"));
const auth_1 = require("./auth");
const helpers_1 = require("../analytics/helpers");
const DEFAULT_CURRENCY = 'eur';
const MIN_AMOUNT_EUR = 0.5;
async function createPaymentIntentHandler(request) {
    const { auth, data } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const { jobId, amount, currency = DEFAULT_CURRENCY, connectedAccountId } = data;
    if (!jobId || amount == null) {
        throw new https_1.HttpsError('invalid-argument', 'jobId and amount are required');
    }
    if (amount < MIN_AMOUNT_EUR) {
        throw new https_1.HttpsError('invalid-argument', 'Amount must be at least 50 cents');
    }
    try {
        const job = await firestore_1.firestoreHelpers.getJob(jobId);
        if (!job) {
            throw new https_1.HttpsError('not-found', 'Job not found');
        }
        if (job.customerUid !== auth.uid) {
            throw new https_1.HttpsError('permission-denied', 'Only job customer can create payment');
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
        await firestore_1.firestoreHelpers.collections.payments().doc(paymentIntent.id).set(paymentData);
        return {
            paymentIntentId: paymentIntent.id,
            clientSecret: paymentIntent.client_secret,
        };
    }
    catch (error) {
        v2_1.logger.error('Error creating payment intent:', error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to create payment intent');
    }
}
function toDate(value) {
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
function ensureManualReleaseAllowed(payment, authUid, manualRelease) {
    if (!manualRelease) {
        return;
    }
    if (payment.customerUid !== authUid) {
        throw new https_1.HttpsError('permission-denied', 'Only customer can manually release payment');
    }
}
function ensurePaymentEligibleForTransfer(payment, manualRelease) {
    if (!manualRelease) {
        const escrowUntil = toDate(payment.escrowHoldUntil);
        if (new Date() < escrowUntil) {
            throw new https_1.HttpsError('failed-precondition', 'Escrow hold period has not expired');
        }
    }
    if (payment.status === 'transferred') {
        throw new https_1.HttpsError('failed-precondition', 'Payment already transferred');
    }
    if (payment.status !== 'captured') {
        throw new https_1.HttpsError('failed-precondition', 'Payment must be captured before transfer');
    }
    if (!payment.connectedAccountId) {
        throw new https_1.HttpsError('failed-precondition', 'No connected account for transfer');
    }
}
async function resolveTransferParticipants(paymentId, payment) {
    var _a, _b, _c, _d, _e;
    let proUid = (_a = payment.proUid) !== null && _a !== void 0 ? _a : null;
    let customerUid = (_b = payment.customerUid) !== null && _b !== void 0 ? _b : null;
    if (!proUid || !customerUid) {
        try {
            const jobSnapshot = payment.jobId
                ? await firestore_1.firestoreHelpers.collections.jobs().doc(payment.jobId).get()
                : null;
            const jobData = (jobSnapshot === null || jobSnapshot === void 0 ? void 0 : jobSnapshot.exists) ? jobSnapshot.data() : null;
            if (!proUid) {
                proUid = (_d = (_c = jobData === null || jobData === void 0 ? void 0 : jobData.assignedProUid) !== null && _c !== void 0 ? _c : jobData === null || jobData === void 0 ? void 0 : jobData.proUid) !== null && _d !== void 0 ? _d : null;
            }
            if (!customerUid) {
                customerUid = (_e = jobData === null || jobData === void 0 ? void 0 : jobData.customerUid) !== null && _e !== void 0 ? _e : null;
            }
        }
        catch (error) {
            v2_1.logger.warn('PAYMENTS: Unable to resolve job metadata during transfer', {
                paymentId,
                error: error instanceof Error ? error.message : error,
            });
        }
    }
    return { proUid, customerUid };
}
async function releaseTransferHandler(request) {
    const { auth, data } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const { paymentId, manualRelease = false } = data;
    if (!paymentId) {
        throw new https_1.HttpsError('invalid-argument', 'paymentId is required');
    }
    try {
        const paymentDoc = await firestore_1.firestoreHelpers.collections.payments().doc(paymentId).get();
        if (!paymentDoc.exists) {
            throw new https_1.HttpsError('not-found', 'Payment not found');
        }
        const payment = paymentDoc.data();
        if (!payment) {
            throw new https_1.HttpsError('not-found', 'Payment data not found');
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
        const transferData = {
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
        const paymentUpdate = {
            status: 'transferred',
            transferId: transfer.id,
            transferredAt: new Date(),
            platformFee: platformFeeAmount,
        };
        if (proUid) {
            paymentUpdate.proUid = proUid;
        }
        await Promise.all([
            firestore_1.firestoreHelpers.collections.payments().doc(paymentId).update(paymentUpdate),
            firestore_1.firestoreHelpers.collections.transfers().doc(transfer.id).set(transferData),
        ]);
        return {
            transferId: transfer.id,
            amountNet,
            platformFee: platformFeeAmount,
        };
    }
    catch (error) {
        v2_1.logger.error('Error releasing transfer:', error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to release transfer');
    }
}
async function partialRefundHandler(request) {
    const { auth, data } = request;
    if (!auth) {
        throw new https_1.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const { paymentId, refundAmount, reason = 'requested_by_customer' } = data;
    if (!paymentId || refundAmount == null) {
        throw new https_1.HttpsError('invalid-argument', 'paymentId and refundAmount are required');
    }
    if (refundAmount <= 0) {
        throw new https_1.HttpsError('invalid-argument', 'Refund amount must be positive');
    }
    try {
        const paymentDoc = await firestore_1.firestoreHelpers.collections.payments().doc(paymentId).get();
        if (!paymentDoc.exists) {
            throw new https_1.HttpsError('not-found', 'Payment not found');
        }
        const payment = paymentDoc.data();
        if (!payment) {
            throw new https_1.HttpsError('not-found', 'Payment data not found');
        }
        if (payment.customerUid !== auth.uid) {
            const userIsAdmin = await (0, auth_1.isAdmin)(auth);
            if (!userIsAdmin) {
                throw new https_1.HttpsError('permission-denied', 'Only customer or admin can request refund');
            }
        }
        if (payment.status !== 'captured') {
            throw new https_1.HttpsError('failed-precondition', 'Payment must be captured for refund');
        }
        if (refundAmount > payment.amountGross) {
            throw new https_1.HttpsError('invalid-argument', 'Refund amount cannot exceed payment amount');
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
        await firestore_1.firestoreHelpers.collections.refunds().doc(refund.id).set(refundData);
        return {
            refundId: refund.id,
            amount: refundAmount,
            currency: payment.currency,
        };
    }
    catch (error) {
        v2_1.logger.error('Error creating partial refund:', error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError('internal', 'Failed to create partial refund');
    }
}
async function handlePaymentIntentSucceeded(paymentIntent) {
    try {
        const paymentId = paymentIntent.id;
        const paymentDoc = await firestore_1.firestoreHelpers.collections.payments().doc(paymentId).get();
        if (!paymentDoc.exists) {
            v2_1.logger.warn('Payment not found for succeeded PaymentIntent', { paymentId });
            return;
        }
        await firestore_1.firestoreHelpers.collections.payments().doc(paymentId).update({
            status: 'captured',
            capturedAt: new Date(),
            stripeChargeId: paymentIntent.latest_charge,
        });
        const payment = paymentDoc.data();
        if (payment === null || payment === void 0 ? void 0 : payment.jobId) {
            await firestore_1.firestoreHelpers.updateJob(payment.jobId, {
                status: 'assigned',
                updatedAt: new Date(),
            });
        }
        await (0, helpers_1.logServerEvent)({
            uid: payment === null || payment === void 0 ? void 0 : payment.customerUid,
            role: 'customer',
            name: 'payment_captured',
            props: {
                paymentId,
                jobId: payment === null || payment === void 0 ? void 0 : payment.jobId,
                customerUid: payment === null || payment === void 0 ? void 0 : payment.customerUid,
                proUid: payment === null || payment === void 0 ? void 0 : payment.proUid,
                amountEur: payment === null || payment === void 0 ? void 0 : payment.amountEur,
            },
        });
        v2_1.logger.info('Payment captured successfully', { paymentId });
    }
    catch (error) {
        v2_1.logger.error('Error handling payment_intent.succeeded:', error);
    }
}
async function handleTransferCreated(transfer) {
    try {
        const transferId = transfer.id;
        const transferDoc = await firestore_1.firestoreHelpers.collections.transfers().doc(transferId).get();
        if (transferDoc.exists) {
            const transferData = transferDoc.data();
            await firestore_1.firestoreHelpers.collections.transfers().doc(transferId).update({
                status: 'completed',
                completedAt: new Date(),
            });
            await (0, helpers_1.logServerEvent)({
                uid: transferData === null || transferData === void 0 ? void 0 : transferData.proUid,
                role: 'pro',
                name: 'payment_released',
                props: {
                    transferId,
                    paymentId: transferData === null || transferData === void 0 ? void 0 : transferData.paymentId,
                    jobId: transferData === null || transferData === void 0 ? void 0 : transferData.jobId,
                    amountEur: transferData === null || transferData === void 0 ? void 0 : transferData.amountEur,
                },
            });
            v2_1.logger.info('Transfer completed', { transferId });
        }
    }
    catch (error) {
        v2_1.logger.error('Error handling transfer.created:', error);
    }
}
async function handleChargeRefunded(charge) {
    try {
        const paymentsSnapshot = await firestore_1.firestoreHelpers.collections.payments()
            .where('stripeChargeId', '==', charge.id)
            .limit(1)
            .get();
        if (paymentsSnapshot.empty) {
            v2_1.logger.warn('Payment not found for refunded charge', { chargeId: charge.id });
            return;
        }
        const paymentDoc = paymentsSnapshot.docs[0];
        const paymentData = paymentDoc.data();
        const totalRefunded = charge.amount_refunded / 100;
        await paymentDoc.ref.update({
            totalRefunded,
            lastRefundedAt: new Date(),
        });
        await (0, helpers_1.logServerEvent)({
            uid: paymentData === null || paymentData === void 0 ? void 0 : paymentData.customerUid,
            role: 'customer',
            name: 'payment_refunded',
            props: {
                paymentId: paymentDoc.id,
                chargeId: charge.id,
                jobId: paymentData === null || paymentData === void 0 ? void 0 : paymentData.jobId,
                customerUid: paymentData === null || paymentData === void 0 ? void 0 : paymentData.customerUid,
                proUid: paymentData === null || paymentData === void 0 ? void 0 : paymentData.proUid,
                totalRefunded,
                amountEur: paymentData === null || paymentData === void 0 ? void 0 : paymentData.amountEur,
            },
        });
        v2_1.logger.info('Payment refund recorded', {
            paymentId: paymentDoc.id,
            chargeId: charge.id,
            totalRefunded,
        });
    }
    catch (error) {
        v2_1.logger.error('Error handling charge.refunded:', error);
    }
}
//# sourceMappingURL=payments.js.map