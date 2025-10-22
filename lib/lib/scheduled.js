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
exports.autoReleaseEscrow = void 0;
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firestore_1 = require("firebase-admin/firestore");
const v2_1 = require("firebase-functions/v2");
const stripeService = __importStar(require("./stripe"));
exports.autoReleaseEscrow = (0, scheduler_1.onSchedule)({
    region: 'europe-west1',
    schedule: '0 * * * *',
    timeZone: 'Europe/Berlin',
}, async () => {
    const db = (0, firestore_1.getFirestore)();
    try {
        v2_1.logger.info('Starting automatic escrow release check');
        const now = new Date();
        const paymentsQuery = db.collection('payments')
            .where('status', '==', 'captured')
            .where('escrowHoldUntil', '<=', now)
            .limit(50);
        const paymentsSnapshot = await paymentsQuery.get();
        if (paymentsSnapshot.empty) {
            v2_1.logger.info('No payments eligible for automatic release');
            return;
        }
        v2_1.logger.info(`Found ${paymentsSnapshot.size} payments eligible for release`);
        const releasePromises = paymentsSnapshot.docs.map(async (paymentDoc) => {
            var _a, _b, _c, _d, _e;
            const payment = paymentDoc.data();
            const paymentId = paymentDoc.id;
            try {
                if (payment.status === 'transferred') {
                    v2_1.logger.info(`Payment ${paymentId} already transferred, skipping`);
                    return;
                }
                if (!payment.connectedAccountId) {
                    v2_1.logger.warn(`Payment ${paymentId} has no connected account, skipping`);
                    return;
                }
                v2_1.logger.info(`Auto-releasing payment ${paymentId} to ${payment.connectedAccountId}`);
                let proUid = (_a = payment.proUid) !== null && _a !== void 0 ? _a : null;
                let customerUid = (_b = payment.customerUid) !== null && _b !== void 0 ? _b : null;
                if (!proUid || !customerUid) {
                    try {
                        const jobSnapshot = payment.jobId
                            ? await db.collection('jobs').doc(payment.jobId).get()
                            : null;
                        const jobData = (jobSnapshot === null || jobSnapshot === void 0 ? void 0 : jobSnapshot.exists) ? jobSnapshot.data() : null;
                        proUid = proUid !== null && proUid !== void 0 ? proUid : ((_d = (_c = jobData === null || jobData === void 0 ? void 0 : jobData.assignedProUid) !== null && _c !== void 0 ? _c : jobData === null || jobData === void 0 ? void 0 : jobData.proUid) !== null && _d !== void 0 ? _d : null);
                        customerUid = customerUid !== null && customerUid !== void 0 ? customerUid : ((_e = jobData === null || jobData === void 0 ? void 0 : jobData.customerUid) !== null && _e !== void 0 ? _e : null);
                    }
                    catch (lookupError) {
                        v2_1.logger.warn(`Unable to resolve job metadata for payment ${paymentId}`, lookupError);
                    }
                }
                const { platformFeeAmount, amountNet } = stripeService.calculateFees(payment.amountGross);
                const transfer = await stripeService.createTransfer({
                    amount: Math.round(amountNet * 100),
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
                const transferData = {
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
                    db.collection('payments').doc(paymentId).update(paymentUpdate),
                    db.collection('transfers').doc(transfer.id).set(transferData),
                ]);
                v2_1.logger.info(`Successfully released payment ${paymentId}, transfer: ${transfer.id}`);
            }
            catch (error) {
                v2_1.logger.error(`Failed to release payment ${paymentId}:`, error);
            }
        });
        await Promise.allSettled(releasePromises);
        v2_1.logger.info('Automatic escrow release check completed');
    }
    catch (error) {
        v2_1.logger.error('Error in automatic escrow release:', error);
        throw error;
    }
});
//# sourceMappingURL=scheduled.js.map