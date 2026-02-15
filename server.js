const express = require('express');
const Stripe = require('stripe');
const admin = require('firebase-admin');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

// Initialize Express
const app = express();

// Middleware
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
}));

// Important: Webhook needs raw body, so we handle it before other middleware
app.post('/webhook', bodyParser.raw({type: 'application/json'}));

// Regular JSON parsing for other routes
app.use(bodyParser.json());

// Initialize Stripe with your secret key
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Firebase Admin
let serviceAccount;
try {
    // Try to load from separate file first
    serviceAccount = require('./service-account.json');
} catch (error) {
    // If no separate file, use environment variables (for production hosting)
    console.log('No service-account.json found, using env vars');
    serviceAccount = {
        type: "service_account",
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
    };
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Test route to check if server is running
app.get('/', (req, res) => {
    res.json({ 
        status: 'Server is running!',
        message: 'AloOttawa Payment Server',
        timestamp: new Date().toISOString()
    });
});

// ==================== PAYMENT ENDPOINTS ====================

// Endpoint to create a subscription
app.post('/api/create-subscription', async (req, res) => {
    try {
        const { paymentMethodId, priceId, userId, saveCard, userEmail, userName } = req.body;
        
        console.log('Creating subscription for user:', userId);
        console.log('Payment Method ID:', paymentMethodId);
        
        // Step 1: Get or create Stripe customer
        let customer;
        
        // Check if user already has a Stripe customer ID in Firestore
        const userDoc = await db.collection('users').doc(userId).get();
        const existingCustomerId = userDoc.exists ? userDoc.data().stripeCustomerId : null;
        
        if (existingCustomerId) {
            try {
                // Try to retrieve existing customer
                customer = await stripe.customers.retrieve(existingCustomerId);
                console.log('Found existing customer:', customer.id);
            } catch (err) {
                // Customer doesn't exist, create new
                console.log('Customer not found, creating new');
                customer = await stripe.customers.create({
                    email: userEmail,
                    name: userName,
                    payment_method: paymentMethodId,
                    metadata: {
                        userId: userId,
                        firebaseUid: userId
                    }
                });
            }
        } else {
            // Create new customer
            console.log('Creating new customer');
            customer = await stripe.customers.create({
                email: userEmail,
                name: userName,
                payment_method: paymentMethodId,
                metadata: {
                    userId: userId,
                    firebaseUid: userId
                }
            });
        }
        
        // Step 2: Attach payment method to customer (if not already attached)
        try {
            await stripe.paymentMethods.attach(paymentMethodId, {
                customer: customer.id
            });
            console.log('Payment method attached');
        } catch (attachError) {
            // If already attached, we get an error - that's fine
            console.log('Payment method might already be attached:', attachError.message);
        }
        
        // Step 3: Set as default payment method
        await stripe.customers.update(customer.id, {
            invoice_settings: {
                default_payment_method: paymentMethodId
            }
        });
        
        // Step 4: Create the subscription
        const subscription = await stripe.subscriptions.create({
            customer: customer.id,
            items: [{ price: priceId }],
            payment_behavior: 'default_incomplete',
            expand: ['latest_invoice.payment_intent'],
            metadata: {
                userId: userId,
                firebaseUid: userId
            }
        });
        
        // Step 5: Get the client secret for confirmation
        const clientSecret = subscription.latest_invoice.payment_intent.client_secret;
        
        // Step 6: Save customer ID to Firestore
        await db.collection('users').doc(userId).update({
            stripeCustomerId: customer.id,
            subscriptionId: subscription.id,
            subscriptionStatus: subscription.status,
            subscriptionUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Step 7: Save payment method if requested
        if (saveCard) {
            // Get payment method details
            const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
            
            // Save to Firestore
            await db.collection('users').doc(userId).collection('payment_methods').add({
                paymentMethodId: paymentMethodId,
                brand: paymentMethod.card.brand,
                last4: paymentMethod.card.last4,
                expMonth: paymentMethod.card.exp_month,
                expYear: paymentMethod.card.exp_year,
                isDefault: true,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        
        // Step 8: Log the payment
        await db.collection('payment_logs').add({
            userId: userId,
            customerId: customer.id,
            subscriptionId: subscription.id,
            amount: 9.99,
            currency: 'cad',
            status: subscription.status,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Step 9: Send response back to frontend
        res.json({
            success: true,
            subscriptionId: subscription.id,
            customerId: customer.id,
            clientSecret: clientSecret,
            status: subscription.status
        });
        
    } catch (error) {
        console.error('Subscription creation error:', error);
        res.status(400).json({ 
            success: false,
            error: error.message 
        });
    }
});

// Endpoint to cancel subscription
app.post('/api/cancel-subscription', async (req, res) => {
    try {
        const { subscriptionId, userId } = req.body;
        
        // Cancel the subscription at period end
        const subscription = await stripe.subscriptions.update(subscriptionId, {
            cancel_at_period_end: true
        });
        
        // Update Firestore
        await db.collection('users').doc(userId).update({
            subscriptionStatus: 'canceling',
            cancelAtPeriodEnd: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        res.json({
            success: true,
            message: 'Subscription will be cancelled at period end'
        });
        
    } catch (error) {
        console.error('Cancel subscription error:', error);
        res.status(400).json({ 
            success: false,
            error: error.message 
        });
    }
});

// Webhook to handle Stripe events
app.post('/webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        // Use webhook secret if you have one (recommended)
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
        
        if (webhookSecret) {
            event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        } else {
            event = JSON.parse(req.body);
        }
        
        console.log('Webhook event:', event.type);
        
        // Handle different event types
        switch (event.type) {
            case 'invoice.payment_succeeded':
                const invoice = event.data.object;
                const customerId = invoice.customer;
                
                // Find user by customer ID
                const usersSnapshot = await db.collection('users')
                    .where('stripeCustomerId', '==', customerId)
                    .get();
                
                if (!usersSnapshot.empty) {
                    const userDoc = usersSnapshot.docs[0];
                    await userDoc.ref.update({
                        subscriptionStatus: 'active',
                        lastPayment: admin.firestore.FieldValue.serverTimestamp(),
                        paymentHistory: admin.firestore.FieldValue.arrayUnion({
                            date: new Date().toISOString(),
                            amount: invoice.amount_paid / 100,
                            invoiceId: invoice.id
                        })
                    });
                }
                break;
                
            case 'invoice.payment_failed':
                const failedInvoice = event.data.object;
                // Handle failed payment (send email, etc.)
                console.log('Payment failed for customer:', failedInvoice.customer);
                break;
                
            case 'customer.subscription.deleted':
                const subscription = event.data.object;
                // Subscription cancelled
                const customerSnapshot = await db.collection('users')
                    .where('stripeCustomerId', '==', subscription.customer)
                    .get();
                
                if (!customerSnapshot.empty) {
                    const userDoc = customerSnapshot.docs[0];
                    await userDoc.ref.update({
                        subscriptionStatus: 'cancelled',
                        subscriptionEndedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }
                break;
        }
        
        res.json({ received: true });
        
    } catch (err) {
        console.error('Webhook error:', err.message);
        res.status(400).send(`Webhook Error: ${err.message}`);
    }
});

// Endpoint to get user's payment methods
app.get('/api/payment-methods/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Get user's Stripe customer ID
        const userDoc = await db.collection('users').doc(userId).get();
        const customerId = userDoc.exists ? userDoc.data().stripeCustomerId : null;
        
        if (!customerId) {
            return res.json({ paymentMethods: [] });
        }
        
        // Get payment methods from Stripe
        const paymentMethods = await stripe.paymentMethods.list({
            customer: customerId,
            type: 'card'
        });
        
        res.json({
            success: true,
            paymentMethods: paymentMethods.data
        });
        
    } catch (error) {
        console.error('Error fetching payment methods:', error);
        res.status(400).json({ 
            success: false,
            error: error.message 
        });
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📝 Test the server at http://localhost:${PORT}`);
});