"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeStripe = initializeStripe;
exports.getWebhookSecret = getWebhookSecret;
exports.createConnectAccount = createConnectAccount;
exports.createAccountLink = createAccountLink;
exports.getAccount = getAccount;
exports.createPaymentIntent = createPaymentIntent;
exports.createCreditsPaymentIntent = createCreditsPaymentIntent;
exports.capturePaymentIntent = capturePaymentIntent;
exports.cancelPaymentIntent = cancelPaymentIntent;
exports.createRefund = createRefund;
exports.verifyWebhookSignature = verifyWebhookSignature;
exports.getCustomer = getCustomer;
exports.createTransfer = createTransfer;
exports.calculateFees = calculateFees;
exports.createCustomer = createCustomer;
const stripe_1 = __importDefault(require("stripe"));
const params_1 = require("firebase-functions/params");
const v2_1 = require("firebase-functions/v2");
const stripeSecretKey = (0, params_1.defineSecret)('STRIPE_SECRET_KEY');
const stripeWebhookSecret = (0, params_1.defineSecret)('STRIPE_WEBHOOK_SECRET');
let stripe = null;
function initializeStripe() {
    if (!stripe) {
        const secretKey = stripeSecretKey.value();
        if (!secretKey) {
            throw new Error('STRIPE_SECRET_KEY is not configured');
        }
        stripe = new stripe_1.default(secretKey, {
            typescript: true,
        });
        v2_1.logger.info('Stripe initialized successfully');
    }
    return stripe;
}
function getWebhookSecret() {
    const secret = stripeWebhookSecret.value();
    if (!secret) {
        throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }
    return secret;
}
async function createConnectAccount() {
    const stripeClient = initializeStripe();
    const account = await stripeClient.accounts.create({
        type: 'express',
        business_type: 'individual',
        capabilities: {
            transfers: { requested: true },
        },
    });
    v2_1.logger.info('Connect account created', { id: account.id });
    return account;
}
async function createAccountLink(accountId, refreshUrl, returnUrl) {
    const stripeClient = initializeStripe();
    const accountLink = await stripeClient.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding',
    });
    v2_1.logger.info('Account link created', { accountId, refreshUrl, returnUrl });
    return accountLink;
}
async function getAccount(accountId) {
    const stripeClient = initializeStripe();
    const account = await stripeClient.accounts.retrieve(accountId);
    v2_1.logger.info('Account retrieved', {
        id: accountId,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled
    });
    return account;
}
async function createPaymentIntent(params) {
    const stripeClient = initializeStripe();
    const { amount, currency, customerId, connectedAccountId, metadata } = params;
    const paymentIntentParams = {
        amount,
        currency,
        capture_method: 'automatic',
        transfer_group: connectedAccountId ? `job_${metadata === null || metadata === void 0 ? void 0 : metadata.jobId}` : undefined,
        metadata: {
            ...metadata,
            connectedAccountId: connectedAccountId || '',
            platform: 'brivida',
            created_at: new Date().toISOString(),
        },
    };
    if (customerId) {
        paymentIntentParams.customer = customerId;
    }
    const paymentIntent = await stripeClient.paymentIntents.create(paymentIntentParams);
    v2_1.logger.info('Payment intent created', {
        id: paymentIntent.id,
        amount,
        currency,
        connectedAccountId,
        metadata
    });
    return paymentIntent;
}
async function createCreditsPaymentIntent(params) {
    const stripeClient = initializeStripe();
    const { amount, currency, customerId, creditAmount } = params;
    const paymentIntent = await stripeClient.paymentIntents.create({
        amount,
        currency,
        automatic_payment_methods: {
            enabled: true,
        },
        customer: customerId,
        metadata: {
            type: 'credits_purchase',
            credit_amount: creditAmount.toString(),
            platform: 'brivida',
            created_at: new Date().toISOString(),
        },
    });
    v2_1.logger.info('Credits payment intent created', {
        id: paymentIntent.id,
        amount,
        currency,
        creditAmount
    });
    return paymentIntent;
}
async function capturePaymentIntent(paymentIntentId, amountToCapture) {
    const stripeClient = initializeStripe();
    const params = {};
    if (amountToCapture) {
        params.amount_to_capture = amountToCapture;
    }
    const paymentIntent = await stripeClient.paymentIntents.capture(paymentIntentId, params);
    v2_1.logger.info('Payment intent captured', {
        id: paymentIntentId,
        amount: amountToCapture
    });
    return paymentIntent;
}
async function cancelPaymentIntent(paymentIntentId) {
    const stripeClient = initializeStripe();
    const paymentIntent = await stripeClient.paymentIntents.cancel(paymentIntentId);
    v2_1.logger.info('Payment intent cancelled', { id: paymentIntentId });
    return paymentIntent;
}
async function createRefund(params) {
    const stripeClient = initializeStripe();
    const { paymentIntentId, amount, reason, metadata } = params;
    const refund = await stripeClient.refunds.create({
        payment_intent: paymentIntentId,
        amount,
        reason,
        metadata: {
            ...metadata,
            platform: 'brivida',
            created_at: new Date().toISOString(),
        },
    });
    v2_1.logger.info('Refund created', {
        id: refund.id,
        paymentIntentId,
        amount,
        reason
    });
    return refund;
}
function verifyWebhookSignature(payload, signature) {
    const stripeClient = initializeStripe();
    const webhookSecret = getWebhookSecret();
    try {
        const event = stripeClient.webhooks.constructEvent(payload, signature, webhookSecret);
        v2_1.logger.info('Webhook signature verified', {
            type: event.type,
            id: event.id
        });
        return event;
    }
    catch (error) {
        v2_1.logger.error('Webhook signature verification failed', { error });
        throw new Error('Invalid webhook signature');
    }
}
async function getCustomer(customerId) {
    const stripeClient = initializeStripe();
    try {
        const customer = await stripeClient.customers.retrieve(customerId);
        return customer.deleted ? null : customer;
    }
    catch (error) {
        v2_1.logger.error('Failed to retrieve customer', { customerId, error });
        return null;
    }
}
async function createTransfer(params) {
    const stripeClient = initializeStripe();
    const { amount, currency, destination, transferGroup, metadata } = params;
    const transfer = await stripeClient.transfers.create({
        amount,
        currency,
        destination,
        transfer_group: transferGroup,
        metadata: {
            ...metadata,
            platform: 'brivida',
            created_at: new Date().toISOString(),
        },
    });
    v2_1.logger.info('Transfer created', {
        id: transfer.id,
        amount,
        currency,
        destination,
        transferGroup
    });
    return transfer;
}
function calculateFees(amountGross, platformFeePct = 12.0) {
    const platformFeeAmount = Math.round(amountGross * platformFeePct) / 100;
    const amountNet = amountGross - platformFeeAmount;
    return {
        platformFeeAmount: Math.round(platformFeeAmount * 100) / 100,
        amountNet: Math.round(amountNet * 100) / 100,
    };
}
async function createCustomer(params) {
    const stripeClient = initializeStripe();
    const { email, name, metadata } = params;
    const customer = await stripeClient.customers.create({
        email,
        name,
        metadata: {
            ...metadata,
            platform: 'brivida',
            created_at: new Date().toISOString(),
        },
    });
    v2_1.logger.info('Customer created', {
        id: customer.id,
        email,
        name
    });
    return customer;
}
//# sourceMappingURL=stripe.js.map