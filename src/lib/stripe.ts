import Stripe from 'stripe';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';

// Define Stripe secrets
const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');
const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');

let stripe: Stripe | null = null;

/**
 * Initialize Stripe with secret key
 */
export function initializeStripe(): Stripe {
  if (!stripe) {
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    
    stripe = new Stripe(secretKey, {
      typescript: true,
    });
    
    logger.info('Stripe initialized successfully');
  }
  
  return stripe;
}

/**
 * Get webhook secret for signature verification
 */
export function getWebhookSecret(): string {
  const secret = stripeWebhookSecret.value();
  if (!secret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }
  return secret;
}

/**
 * Create Stripe Connect Express account for Pro
 */
export async function createConnectAccount(): Promise<Stripe.Account> {
  const stripeClient = initializeStripe();
  
  const account = await stripeClient.accounts.create({
    type: 'express',
    business_type: 'individual',
    capabilities: {
      transfers: { requested: true },
    },
  });
  
  logger.info('Connect account created', { id: account.id });
  
  return account;
}

/**
 * Create account onboarding link for Stripe Connect Express
 */
export async function createAccountLink(
  accountId: string,
  refreshUrl: string,
  returnUrl: string
): Promise<Stripe.AccountLink> {
  const stripeClient = initializeStripe();
  
  const accountLink = await stripeClient.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
  
  logger.info('Account link created', { accountId, refreshUrl, returnUrl });
  
  return accountLink;
}

/**
 * Get account details for KYC status
 */
export async function getAccount(accountId: string): Promise<Stripe.Account> {
  const stripeClient = initializeStripe();
  
  const account = await stripeClient.accounts.retrieve(accountId);
  
  logger.info('Account retrieved', { 
    id: accountId, 
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled 
  });
  
  return account;
}

/**
 * Create a payment intent for job payment (escrow) with Connect support
 */
export async function createPaymentIntent(params: {
  amount: number; // in cents
  currency: string;
  customerId?: string;
  connectedAccountId?: string;
  metadata?: Record<string, string>;
}): Promise<Stripe.PaymentIntent> {
  const stripeClient = initializeStripe();
  
  const { amount, currency, customerId, connectedAccountId, metadata } = params;
  
  const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
    amount,
    currency,
    capture_method: 'automatic', // Automatic capture, manual transfer for escrow
    transfer_group: connectedAccountId ? `job_${metadata?.jobId}` : undefined,
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
  
  logger.info('Payment intent created', { 
    id: paymentIntent.id, 
    amount, 
    currency,
    connectedAccountId,
    metadata 
  });
  
  return paymentIntent;
}

/**
 * Create a payment intent for credit purchases
 */
export async function createCreditsPaymentIntent(params: {
  amount: number; // in cents
  currency: string;
  customerId?: string;
  creditAmount: number;
}): Promise<Stripe.PaymentIntent> {
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
  
  logger.info('Credits payment intent created', { 
    id: paymentIntent.id, 
    amount, 
    currency,
    creditAmount 
  });
  
  return paymentIntent;
}

/**
 * Capture payment intent (complete escrow)
 */
export async function capturePaymentIntent(
  paymentIntentId: string,
  amountToCapture?: number
): Promise<Stripe.PaymentIntent> {
  const stripeClient = initializeStripe();
  
  const params: Stripe.PaymentIntentCaptureParams = {};
  if (amountToCapture) {
    params.amount_to_capture = amountToCapture;
  }
  
  const paymentIntent = await stripeClient.paymentIntents.capture(
    paymentIntentId,
    params
  );
  
  logger.info('Payment intent captured', { 
    id: paymentIntentId, 
    amount: amountToCapture 
  });
  
  return paymentIntent;
}

/**
 * Cancel payment intent (refund escrow)
 */
export async function cancelPaymentIntent(
  paymentIntentId: string
): Promise<Stripe.PaymentIntent> {
  const stripeClient = initializeStripe();
  
  const paymentIntent = await stripeClient.paymentIntents.cancel(paymentIntentId);
  
  logger.info('Payment intent cancelled', { id: paymentIntentId });
  
  return paymentIntent;
}

/**
 * Create a refund
 */
export async function createRefund(params: {
  paymentIntentId: string;
  amount?: number;
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  metadata?: Record<string, string>;
}): Promise<Stripe.Refund> {
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
  
  logger.info('Refund created', { 
    id: refund.id, 
    paymentIntentId, 
    amount,
    reason 
  });
  
  return refund;
}

/**
 * Verify webhook signature
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string
): Stripe.Event {
  const stripeClient = initializeStripe();
  const webhookSecret = getWebhookSecret();
  
  try {
    const event = stripeClient.webhooks.constructEvent(
      payload,
      signature,
      webhookSecret
    );
    
    logger.info('Webhook signature verified', { 
      type: event.type, 
      id: event.id 
    });
    
    return event;
  } catch (error) {
    logger.error('Webhook signature verification failed', { error });
    throw new Error('Invalid webhook signature');
  }
}

/**
 * Get customer by ID
 */
export async function getCustomer(customerId: string): Promise<Stripe.Customer | null> {
  const stripeClient = initializeStripe();
  
  try {
    const customer = await stripeClient.customers.retrieve(customerId);
    return customer.deleted ? null : customer as Stripe.Customer;
  } catch (error) {
    logger.error('Failed to retrieve customer', { customerId, error });
    return null;
  }
}

/**
 * Create transfer to connected account (after escrow release)
 */
export async function createTransfer(params: {
  amount: number; // in cents
  currency: string;
  destination: string; // connected account ID
  transferGroup?: string;
  metadata?: Record<string, string>;
}): Promise<Stripe.Transfer> {
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
  
  logger.info('Transfer created', { 
    id: transfer.id, 
    amount, 
    currency,
    destination,
    transferGroup 
  });
  
  return transfer;
}

/**
 * Calculate platform fee and net amount
 */
export function calculateFees(amountGross: number, platformFeePct: number = 12.0) {
  const platformFeeAmount = Math.round(amountGross * platformFeePct) / 100;
  const amountNet = amountGross - platformFeeAmount;
  
  return {
    platformFeeAmount: Math.round(platformFeeAmount * 100) / 100, // Round to 2 decimals
    amountNet: Math.round(amountNet * 100) / 100,
  };
}

/**
 * Create customer
 */
export async function createCustomer(params: {
  email?: string;
  name?: string;
  metadata?: Record<string, string>;
}): Promise<Stripe.Customer> {
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
  
  logger.info('Customer created', { 
    id: customer.id, 
    email, 
    name 
  });
  
  return customer;
}