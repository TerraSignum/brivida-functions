"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateAdminServiceStatus = exports.handleAdminServiceWebhook = exports.createAdminServiceCheckout = exports.ADMIN_SERVICE_PACKAGES = void 0;
const v2_1 = require("firebase-functions/v2");
const params_1 = require("firebase-functions/params");
const firestore_1 = require("firebase-admin/firestore");
const messaging_1 = require("firebase-admin/messaging");
const stripe_1 = __importDefault(require("stripe"));
const auth_1 = require("./auth");
const STRIPE_SECRET_KEY = (0, params_1.defineSecret)('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = (0, params_1.defineSecret)('STRIPE_WEBHOOK_SECRET');
let stripeClient = null;
function getStripe() {
    if (!stripeClient) {
        const key = STRIPE_SECRET_KEY.value();
        if (!key)
            throw new Error('STRIPE_SECRET_KEY is not configured');
        stripeClient = new stripe_1.default(key, {
            apiVersion: '2025-08-27.basil',
        });
    }
    return stripeClient;
}
const db = (0, firestore_1.getFirestore)();
const messaging = (0, messaging_1.getMessaging)();
exports.ADMIN_SERVICE_PACKAGES = [
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
function appendQuery(base, query) {
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}${query}`;
}
exports.createAdminServiceCheckout = v2_1.https.onCall({ region: 'europe-west1', secrets: [STRIPE_SECRET_KEY] }, async (request) => {
    const { auth, data } = request;
    if (!(auth === null || auth === void 0 ? void 0 : auth.uid)) {
        throw new v2_1.https.HttpsError('unauthenticated', 'Authentication required');
    }
    const { packageType, returnUrl } = data;
    if (!packageType || !['basic', 'secure'].includes(packageType)) {
        throw new v2_1.https.HttpsError('invalid-argument', 'Invalid package type');
    }
    if (!returnUrl || typeof returnUrl !== 'string') {
        throw new v2_1.https.HttpsError('invalid-argument', 'Return URL required');
    }
    if (!returnUrl.startsWith('https://')) {
        throw new v2_1.https.HttpsError('invalid-argument', 'Return URL must be HTTPS');
    }
    try {
        const packageInfo = exports.ADMIN_SERVICE_PACKAGES.find(p => p.package === packageType);
        if (!packageInfo) {
            throw new v2_1.https.HttpsError('not-found', 'Package not found');
        }
        const userDoc = await db.collection('users').doc(auth.uid).get();
        if (!userDoc.exists) {
            throw new v2_1.https.HttpsError('not-found', 'User not found');
        }
        const userData = userDoc.data();
        if ((userData === null || userData === void 0 ? void 0 : userData.role) !== 'pro') {
            throw new v2_1.https.HttpsError('permission-denied', 'Only pros can purchase admin services');
        }
        const adminServiceRef = db.collection('adminServices').doc();
        const adminService = {
            id: adminServiceRef.id,
            proId: auth.uid,
            package: packageType,
            price: packageInfo.price,
            status: 'pending_payment',
            createdAt: firestore_1.FieldValue.serverTimestamp(),
            followUpSent: false,
            pdfGuideDelivered: false,
        };
        await adminServiceRef.set(adminService);
        const stripe = getStripe();
        const successUrl = appendQuery(returnUrl, `session_id={CHECKOUT_SESSION_ID}&status=success&admin_service_id=${adminServiceRef.id}`);
        const cancelUrl = appendQuery(returnUrl, `status=cancelled&admin_service_id=${adminServiceRef.id}`);
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
                            images: [],
                        },
                        unit_amount: packageInfo.price * 100,
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
        await adminServiceRef.update({
            stripeSessionId: session.id,
        });
        return {
            sessionId: session.id,
            checkoutUrl: session.url,
            adminServiceId: adminServiceRef.id,
        };
    }
    catch (error) {
        console.error('Error creating admin service checkout:', error);
        throw new v2_1.https.HttpsError('internal', 'Failed to create checkout session');
    }
});
exports.handleAdminServiceWebhook = v2_1.https.onRequest({ region: 'europe-west1', secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] }, async (request, response) => {
    const sig = request.headers['stripe-signature'];
    const endpointSecret = STRIPE_WEBHOOK_SECRET.value();
    let event;
    try {
        const stripe = getStripe();
        event = stripe.webhooks.constructEvent(request.rawBody, sig, endpointSecret);
    }
    catch (err) {
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
    }
    catch (error) {
        console.error('Error handling webhook:', error);
        response.status(500).send('Webhook handler failed');
    }
});
async function handleCheckoutCompleted(session) {
    var _a;
    const adminServiceId = (_a = session.metadata) === null || _a === void 0 ? void 0 : _a.adminServiceId;
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
            transaction.update(adminServiceRef, {
                status: 'pending',
                paidAt: firestore_1.FieldValue.serverTimestamp(),
                stripePaymentIntentId: session.payment_intent,
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            console.log(`Admin service ${adminServiceId} payment completed`);
        });
        await notifyAdminsOfNewService(adminServiceId);
        await sendProConfirmation(adminServiceId);
    }
    catch (error) {
        console.error('Error handling checkout completion:', error);
    }
}
async function handlePaymentSucceeded(paymentIntent) {
    console.log(`Payment succeeded: ${paymentIntent.id}`);
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
        paymentConfirmedAt: firestore_1.FieldValue.serverTimestamp(),
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    });
}
async function handlePaymentFailed(paymentIntent) {
    console.log(`Payment failed: ${paymentIntent.id}`);
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
        paymentFailedAt: firestore_1.FieldValue.serverTimestamp(),
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    });
}
async function notifyAdminsOfNewService(adminServiceId) {
    try {
        const adminServiceDoc = await db.collection('adminServices').doc(adminServiceId).get();
        if (!adminServiceDoc.exists)
            return;
        const adminServiceData = adminServiceDoc.data();
        const packageInfo = exports.ADMIN_SERVICE_PACKAGES.find(p => p.package === (adminServiceData === null || adminServiceData === void 0 ? void 0 : adminServiceData.package));
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
        if (tokens.length === 0)
            return;
        const message = {
            notification: {
                title: '🏛️ Novo Serviço Admin',
                body: `${packageInfo === null || packageInfo === void 0 ? void 0 : packageInfo.title} (€${adminServiceData === null || adminServiceData === void 0 ? void 0 : adminServiceData.price}) - Pro: ${adminServiceData === null || adminServiceData === void 0 ? void 0 : adminServiceData.proId}`,
            },
            data: {
                type: 'admin_service_new',
                adminServiceId: adminServiceId,
                package: (adminServiceData === null || adminServiceData === void 0 ? void 0 : adminServiceData.package) || '',
                proId: (adminServiceData === null || adminServiceData === void 0 ? void 0 : adminServiceData.proId) || '',
            },
            tokens: tokens,
        };
        const response = await messaging.sendEachForMulticast(message);
        console.log(`Admin notification sent: ${response.successCount}/${tokens.length} delivered`);
    }
    catch (error) {
        console.error('Error sending admin notifications:', error);
    }
}
async function sendProConfirmation(adminServiceId) {
    try {
        const adminServiceDoc = await db.collection('adminServices').doc(adminServiceId).get();
        if (!adminServiceDoc.exists)
            return;
        const adminServiceData = adminServiceDoc.data();
        const proId = adminServiceData === null || adminServiceData === void 0 ? void 0 : adminServiceData.proId;
        if (!proId)
            return;
        const proDoc = await db.collection('users').doc(proId).get();
        const proData = proDoc.data();
        const fcmToken = proData === null || proData === void 0 ? void 0 : proData.fcmToken;
        if (!fcmToken)
            return;
        const packageInfo = exports.ADMIN_SERVICE_PACKAGES.find(p => p.package === (adminServiceData === null || adminServiceData === void 0 ? void 0 : adminServiceData.package));
        const message = {
            notification: {
                title: '✅ Pagamento Confirmado',
                body: `${packageInfo === null || packageInfo === void 0 ? void 0 : packageInfo.title} - Em breve receberá contacto da nossa equipa`,
            },
            data: {
                type: 'admin_service_confirmed',
                adminServiceId: adminServiceId,
                package: (adminServiceData === null || adminServiceData === void 0 ? void 0 : adminServiceData.package) || '',
            },
            token: fcmToken,
        };
        await messaging.send(message);
        console.log(`Pro confirmation sent to ${proId}`);
    }
    catch (error) {
        console.error('Error sending pro confirmation:', error);
    }
}
exports.updateAdminServiceStatus = v2_1.https.onCall({ region: 'europe-west1' }, async (request) => {
    const { auth, data } = request;
    if (!(auth === null || auth === void 0 ? void 0 : auth.uid)) {
        throw new v2_1.https.HttpsError('unauthenticated', 'Authentication required');
    }
    await (0, auth_1.enforceAdminRole)(auth);
    const adminUid = auth.uid;
    const { adminServiceId, status, assignedAdminId, notes } = data;
    if (!adminServiceId || !status) {
        throw new v2_1.https.HttpsError('invalid-argument', 'Service ID and status required');
    }
    try {
        const updateData = {
            status,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        };
        if (assignedAdminId) {
            updateData.assignedAdminId = assignedAdminId;
            updateData.assignedAt = firestore_1.FieldValue.serverTimestamp();
        }
        if (notes) {
            updateData.adminNotes = notes;
        }
        if (status === 'completed') {
            updateData.completedAt = firestore_1.FieldValue.serverTimestamp();
        }
        await db.collection('adminServices').doc(adminServiceId).update(updateData);
        await db.collection('adminLogs').add({
            action: 'admin_service_status_update',
            timestamp: firestore_1.FieldValue.serverTimestamp(),
            adminUid,
            adminServiceId,
            newStatus: status,
            assignedAdminId: assignedAdminId || null,
        });
        return { success: true };
    }
    catch (error) {
        console.error('Error updating admin service status:', error);
        throw new v2_1.https.HttpsError('internal', 'Failed to update service status');
    }
});
//# sourceMappingURL=adminServices.js.map