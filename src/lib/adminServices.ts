/**
 * PG-17/18: Admin Services - Cloud Functions for Stripe integration
 * Handles checkout sessions and webhooks for "Oficializa-te" services
 */

import { https } from 'firebase-functions/v2';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import Stripe from 'stripe';
import { enforceAdminRole } from './auth';

// Use secrets with lazy initialization to avoid requiring env at module load
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeClient) {
    const key = STRIPE_SECRET_KEY.value();
    if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
    stripeClient = new Stripe(key, {
      apiVersion: '2025-08-27.basil',
    });
  }
  return stripeClient;
}

const db = getFirestore();
const messaging = getMessaging();

export interface AdminServicePackageInfo {
  package: 'basic' | 'secure';
  title: string;
  price: number; // in EUR
  features: string[];
}

export const ADMIN_SERVICE_PACKAGES: AdminServicePackageInfo[] = [
  {
    package: 'basic',
    title: 'Ajuda Básica',
    price: 79,
    features: [
      'Informações sobre registo como trabalhador independente',
      'Orientação sobre documentos necessários',
      'Lista de passos principais',
      'Suporte por email (3 trocas)',
    ],
  },
  {
    package: 'secure',
    title: 'Arranque Seguro',
    price: 129,
    features: [
      'Tudo do pacote básico',
      'Acompanhamento personalizado',
      'Suporte telefónico (2 chamadas)',
      'Revisão de documentos',
      'PDF guia completo',
      'Suporte por 30 dias',
    ],
  },
];

function appendQuery(base: string, query: string): string {
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${query}`;
}

/**
 * Creates a Stripe checkout session for admin services
 */
export const createAdminServiceCheckout = https.onCall(
  { region: 'europe-west1', secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    const { auth, data } = request;
    
    if (!auth?.uid) {
      throw new https.HttpsError('unauthenticated', 'Authentication required');
    }

    const { packageType, returnUrl } = data as {
      packageType?: string;
      returnUrl?: string;
    };
    
    if (!packageType || !['basic', 'secure'].includes(packageType)) {
      throw new https.HttpsError('invalid-argument', 'Invalid package type');
    }

    if (!returnUrl || typeof returnUrl !== 'string') {
      throw new https.HttpsError('invalid-argument', 'Return URL required');
    }

    if (!returnUrl.startsWith('https://')) {
      throw new https.HttpsError('invalid-argument', 'Return URL must be HTTPS');
    }

    try {
      // Get package info
      const packageInfo = ADMIN_SERVICE_PACKAGES.find(p => p.package === packageType);
      if (!packageInfo) {
        throw new https.HttpsError('not-found', 'Package not found');
      }

      // Verify user is a pro
      const userDoc = await db.collection('users').doc(auth.uid).get();
      if (!userDoc.exists) {
        throw new https.HttpsError('not-found', 'User not found');
      }

      const userData = userDoc.data();
      if (userData?.role !== 'pro') {
        throw new https.HttpsError('permission-denied', 'Only pros can purchase admin services');
      }

      // Create admin service record (pending payment)
      const adminServiceRef = db.collection('adminServices').doc();
      const adminService = {
        id: adminServiceRef.id,
        proId: auth.uid,
        package: packageType,
        price: packageInfo.price,
        status: 'pending_payment',
        createdAt: FieldValue.serverTimestamp(),
        followUpSent: false,
        pdfGuideDelivered: false,
      };

      await adminServiceRef.set(adminService);

      // Create Stripe checkout session
      const stripe = getStripe();
      const successUrl = appendQuery(
        returnUrl,
        `session_id={CHECKOUT_SESSION_ID}&status=success&admin_service_id=${adminServiceRef.id}`,
      );

      const cancelUrl = appendQuery(
        returnUrl,
        `status=cancelled&admin_service_id=${adminServiceRef.id}`,
      );

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        client_reference_id: adminServiceRef.id,
        customer_email: userData.email,
        line_items: [
          {
            price_data: {
              currency: 'eur',
              product_data: {
                name: `Brivida ${packageInfo.title}`,
                description: 'Serviço de apoio ao registo como trabalhador independente',
                images: [], // Empty images array
              },
              unit_amount: packageInfo.price * 100, // Convert to cents
            },
            quantity: 1,
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          adminServiceId: adminServiceRef.id,
          proId: auth.uid,
          package: packageType,
        },
      });

      // Update admin service with Stripe session ID
      await adminServiceRef.update({
        stripeSessionId: session.id,
      });

      return {
        sessionId: session.id,
        checkoutUrl: session.url,
        adminServiceId: adminServiceRef.id,
      };

    } catch (error) {
      console.error('Error creating admin service checkout:', error);
      throw new https.HttpsError('internal', 'Failed to create checkout session');
    }
  }
);

/**
 * Handles Stripe webhooks for admin services
 */
export const handleAdminServiceWebhook = https.onRequest(
  { region: 'europe-west1', secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (request, response) => {
    const sig = request.headers['stripe-signature'] as string;
    const endpointSecret = STRIPE_WEBHOOK_SECRET.value();

    let event: Stripe.Event;

    try {
      const stripe = getStripe();
  event = stripe.webhooks.constructEvent(request.rawBody, sig, endpointSecret);
    } catch (err) {
      console.error('Webhook signature verification failed:', err);
      response.status(400).send('Webhook signature verification failed');
      return;
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted(event.data.object);
          break;
        
        case 'payment_intent.succeeded':
          await handlePaymentSucceeded(event.data.object);
          break;
        
        case 'payment_intent.payment_failed':
          await handlePaymentFailed(event.data.object);
          break;
        
        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      response.status(200).send('Success');
    } catch (error) {
      console.error('Error handling webhook:', error);
      response.status(500).send('Webhook handler failed');
    }
  }
);

/**
 * Handle successful checkout completion
 */
async function handleCheckoutCompleted(session: any) {
  const adminServiceId = session.metadata?.adminServiceId;
  
  if (!adminServiceId) {
    console.error('No adminServiceId in checkout session metadata');
    return;
  }

  const adminServiceRef = db.collection('adminServices').doc(adminServiceId);
  
  try {
    await db.runTransaction(async (transaction) => {
      const adminServiceDoc = await transaction.get(adminServiceRef);
      
      if (!adminServiceDoc.exists) {
        throw new Error(`Admin service ${adminServiceId} not found`);
      }
      
      // Update admin service status
      transaction.update(adminServiceRef, {
        status: 'pending',
        paidAt: FieldValue.serverTimestamp(),
        stripePaymentIntentId: session.payment_intent,
        updatedAt: FieldValue.serverTimestamp(),
      });

      console.log(`Admin service ${adminServiceId} payment completed`);
    });

    // Send notification to admins
    await notifyAdminsOfNewService(adminServiceId);
    
    // Send confirmation to pro
    await sendProConfirmation(adminServiceId);

  } catch (error) {
    console.error('Error handling checkout completion:', error);
  }
}

/**
 * Handle successful payment
 */
async function handlePaymentSucceeded(paymentIntent: any) {
  console.log(`Payment succeeded: ${paymentIntent.id}`);
  
  // Find admin service by payment intent ID
  const servicesQuery = await db.collection('adminServices')
    .where('stripePaymentIntentId', '==', paymentIntent.id)
    .limit(1)
    .get();

  if (servicesQuery.empty) {
    console.error(`No admin service found for payment intent ${paymentIntent.id}`);
    return;
  }

  const adminServiceDoc = servicesQuery.docs[0];
  await adminServiceDoc.ref.update({
    paymentConfirmedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Handle failed payment
 */
async function handlePaymentFailed(paymentIntent: any) {
  console.log(`Payment failed: ${paymentIntent.id}`);
  
  // Find admin service by payment intent ID
  const servicesQuery = await db.collection('adminServices')
    .where('stripePaymentIntentId', '==', paymentIntent.id)
    .limit(1)
    .get();

  if (servicesQuery.empty) {
    console.error(`No admin service found for payment intent ${paymentIntent.id}`);
    return;
  }

  const adminServiceDoc = servicesQuery.docs[0];
  await adminServiceDoc.ref.update({
    status: 'payment_failed',
    paymentFailedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Send FCM notifications to admin users about new service
 */
async function notifyAdminsOfNewService(adminServiceId: string) {
  try {
    // Get admin service details
    const adminServiceDoc = await db.collection('adminServices').doc(adminServiceId).get();
    if (!adminServiceDoc.exists) return;
    
    const adminServiceData = adminServiceDoc.data();
    const packageInfo = ADMIN_SERVICE_PACKAGES.find(p => p.package === adminServiceData?.package);
    
    // Get all admin users
    const adminsQuery = await db.collection('users')
      .where('role', '==', 'admin')
      .where('fcmToken', '!=', null)
      .get();

    if (adminsQuery.empty) {
      console.log('No admin users with FCM tokens found');
      return;
    }

    const tokens = adminsQuery.docs
      .map(doc => doc.data().fcmToken)
      .filter(token => token);

    if (tokens.length === 0) return;

    // Send notification
    const message = {
      notification: {
        title: '🏛️ Novo Serviço Admin',
        body: `${packageInfo?.title} (€${adminServiceData?.price}) - Pro: ${adminServiceData?.proId}`,
      },
      data: {
        type: 'admin_service_new',
        adminServiceId: adminServiceId,
        package: adminServiceData?.package || '',
        proId: adminServiceData?.proId || '',
      },
      tokens: tokens,
    };

    const response = await messaging.sendEachForMulticast(message);
    console.log(`Admin notification sent: ${response.successCount}/${tokens.length} delivered`);

  } catch (error) {
    console.error('Error sending admin notifications:', error);
  }
}

/**
 * Send confirmation notification to pro
 */
async function sendProConfirmation(adminServiceId: string) {
  try {
    // Get admin service and pro details
    const adminServiceDoc = await db.collection('adminServices').doc(adminServiceId).get();
    if (!adminServiceDoc.exists) return;
    
    const adminServiceData = adminServiceDoc.data();
    const proId = adminServiceData?.proId;
    
    if (!proId) return;

    // Get pro FCM token
    const proDoc = await db.collection('users').doc(proId).get();
    const proData = proDoc.data();
    const fcmToken = proData?.fcmToken;
    
    if (!fcmToken) return;

    const packageInfo = ADMIN_SERVICE_PACKAGES.find(p => p.package === adminServiceData?.package);

    // Send confirmation notification
    const message = {
      notification: {
        title: '✅ Pagamento Confirmado',
        body: `${packageInfo?.title} - Em breve receberá contacto da nossa equipa`,
      },
      data: {
        type: 'admin_service_confirmed',
        adminServiceId: adminServiceId,
        package: adminServiceData?.package || '',
      },
      token: fcmToken,
    };

    await messaging.send(message);
    console.log(`Pro confirmation sent to ${proId}`);

  } catch (error) {
    console.error('Error sending pro confirmation:', error);
  }
}

/**
 * Callable function to manually update admin service status
 */
export const updateAdminServiceStatus = https.onCall(
  { region: 'europe-west1' },
  async (request) => {
    const { auth, data } = request;
    
    if (!auth?.uid) {
      throw new https.HttpsError('unauthenticated', 'Authentication required');
    }

    await enforceAdminRole(auth);
    const adminUid = auth.uid;

    const { adminServiceId, status, assignedAdminId, notes } = data;
    
    if (!adminServiceId || !status) {
      throw new https.HttpsError('invalid-argument', 'Service ID and status required');
    }

    try {
      const updateData: any = {
        status,
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (assignedAdminId) {
        updateData.assignedAdminId = assignedAdminId;
        updateData.assignedAt = FieldValue.serverTimestamp();
      }

      if (notes) {
        updateData.adminNotes = notes;
      }

      if (status === 'completed') {
        updateData.completedAt = FieldValue.serverTimestamp();
      }

      await db.collection('adminServices').doc(adminServiceId).update(updateData);

      await db.collection('adminLogs').add({
        action: 'admin_service_status_update',
        timestamp: FieldValue.serverTimestamp(),
        adminUid,
        adminServiceId,
        newStatus: status,
        assignedAdminId: assignedAdminId || null,
      });

      return { success: true };

    } catch (error) {
      console.error('Error updating admin service status:', error);
      throw new https.HttpsError('internal', 'Failed to update service status');
    }
  }
);