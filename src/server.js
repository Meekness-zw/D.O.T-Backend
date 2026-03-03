import 'dotenv/config.js';
import express from 'express';
import cors from 'cors';
import { sendOtpToPhone, verifyPhoneOtp, loginWithPassword } from './authService.js';
import { ensureUserProfile, getProfile, updateProfile, uploadProfilePhoto } from './userService.js';
import { getOrdersForUser, getWalletTransactionsForUser, getPaymentsForUser, getFullUserMe } from './historyService.js';
import { createPesepayTransaction, handlePesepayCallback } from './paymentService.js';
import { verifyAccessToken } from './sessionToken.js';
import { supabaseAdmin } from './supabaseAdminClient.js';
import {
  upsertCourierProfile,
  saveCourierVehicle,
  saveCourierDriverLicense,
  saveCourierPayoutMethod,
  upsertMerchantOnboarding,
} from './onboardingService.js';
import {
  getAdminStats,
  getAdminUsers,
  getAdminOrders,
  getAdminDeliveries,
  getAdminPayments,
  getAdminStores,
  getAdminMerchants,
  getAdminCouriers,
} from './adminService.js';
import { supabaseAdmin as publicSupabase } from './supabaseAdminClient.js';

const app = express();
const supabase = supabaseAdmin;
const PORT = process.env.PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Environment validation (Twilio + Supabase for phone auth)
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_JWT_SECRET',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_VERIFY_SERVICE_SID',
];
const missingEnvVars = requiredEnvVars.filter((varName) => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnvVars.join(', '));
  console.error('Copy backend/.env.example to backend/.env and fill in your Twilio and Supabase values.');
  process.exit(1);
}

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://localhost:8081', 'exp://localhost:8081'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin || allowedOrigins.includes(origin) || NODE_ENV === 'development') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

/** Auth middleware: require Bearer token, set req.userId from JWT sub */
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  const payload = token ? verifyAccessToken(token, process.env.SUPABASE_JWT_SECRET) : null;
  if (!payload?.sub) {
    return res.status(401).json({ error: 'Unauthorized', details: 'Valid access token required' });
  }
  req.userId = payload.sub;
  next();
}

/** Admin middleware: require x-admin-key or Authorization Bearer matching ADMIN_API_KEY */
function requireAdmin(req, res, next) {
  const apiKey = process.env.ADMIN_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'Admin API not configured', details: 'Set ADMIN_API_KEY in server env' });
  }
  const headerKey = req.headers['x-admin-key'] || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (headerKey !== apiKey) {
    return res.status(401).json({ error: 'Unauthorized', details: 'Valid admin API key required' });
  }
  next();
}

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Request timeout middleware (30 seconds)
app.use((req, res, next) => {
  req.setTimeout(30000, () => {
    res.status(408).json({ error: 'Request timeout' });
  });
  next();
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'DOT backend API',
    version: '1.0.0',
    environment: NODE_ENV
  });
});

// Public stores listing & search (no auth required; uses public RLS policies)
app.get('/stores', async (req, res) => {
  try {
    const supabasePublic = publicSupabase;
    if (!supabasePublic) throw new Error('Server not configured');

    const {
      search,
      category,
      city,
      limit: limitParam,
      offset: offsetParam,
      hasPromos,
    } = req.query || {};

    const limit = Math.min(parseInt(limitParam, 10) || 50, 100);
    const offset = parseInt(offsetParam, 10) || 0;

    let query = supabasePublic
      .from('stores')
      .select(
        `
          id,
          store_name,
          logo,
          description,
          city,
          rating,
          total_reviews,
          is_open,
          is_active
        `,
      )
      .eq('is_active', true)
      .range(offset, offset + limit - 1);

    if (city) {
      query = query.ilike('city', city);
    }

    if (category) {
      const term = `%${category.trim()}%`;
      query = query.or(`description.ilike.${term},store_name.ilike.${term}`);
    }

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      query = query.or(`store_name.ilike.${term},description.ilike.${term},city.ilike.${term}`);
    }

    const { data, error } = await query;
    if (error) {
      console.error('public /stores error:', error);
      throw new Error(error.message || 'Failed to load stores');
    }

    // Basic placeholder for promotions flag: if hasPromos=true, keep as is for now (extend when promotions table exists)
    let stores = data || [];
    if (hasPromos === 'true') {
      stores = stores.slice(0, 10);
    }

    return res.json({ stores });
  } catch (error) {
    console.error('get /stores error:', error);
    return res.status(500).json({
      error: 'Failed to load stores',
      details: error.message || 'Please try again later',
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding: couriers & merchants (auth required)
// ─────────────────────────────────────────────────────────────────────────────

// POST /couriers/onboarding/profile
app.post('/couriers/onboarding/profile', requireAuth, async (req, res) => {
  try {
    const {
      fullName,
      nationalId,
      dateOfBirth,
      city,
      profilePhotoBase64,
      nationalIdPhotoBase64,
    } = req.body || {};

    const data = await upsertCourierProfile({
      userId: req.userId,
      fullName,
      nationalId,
      dateOfBirth,
      city,
      profilePhotoBase64,
      nationalIdPhotoBase64,
    });

    return res.json(data);
  } catch (error) {
    console.error('courier profile onboarding error:', error);
    return res.status(400).json({ error: error.message || 'Failed to save courier profile' });
  }
});

// POST /couriers/onboarding/vehicle
app.post('/couriers/onboarding/vehicle', requireAuth, async (req, res) => {
  try {
    const {
      vehicleType,
      brand,
      model,
      year,
      color,
      licensePlate,
      vehiclePhotoBase64,
      registrationCertificateBase64,
    } = req.body || {};

    const data = await saveCourierVehicle({
      userId: req.userId,
      vehicleType,
      brand,
      model,
      year,
      color,
      licensePlate,
      vehiclePhotoBase64,
      registrationCertificateBase64,
    });

    return res.json(data);
  } catch (error) {
    console.error('courier vehicle onboarding error:', error);
    return res.status(400).json({ error: error.message || 'Failed to save courier vehicle' });
  }
});

// POST /couriers/onboarding/driver-license
app.post('/couriers/onboarding/driver-license', requireAuth, async (req, res) => {
  try {
    const { licenseNumber, expiryDate, frontBase64, backBase64, selfieBase64 } = req.body || {};

    const data = await saveCourierDriverLicense({
      userId: req.userId,
      licenseNumber,
      expiryDate,
      frontBase64,
      backBase64,
      selfieBase64,
    });

    return res.json(data);
  } catch (error) {
    console.error('courier driver-license onboarding error:', error);
    return res.status(400).json({ error: error.message || 'Failed to save driver license' });
  }
});

// POST /couriers/onboarding/payout-method
app.post('/couriers/onboarding/payout-method', requireAuth, async (req, res) => {
  try {
    const { methodType, provider, accountNumber, accountName } = req.body || {};
    const data = await saveCourierPayoutMethod({
      userId: req.userId,
      methodType,
      provider,
      accountNumber,
      accountName,
    });
    return res.json(data);
  } catch (error) {
    console.error('courier payout onboarding error:', error);
    return res.status(400).json({ error: error.message || 'Failed to save payout method' });
  }
});

// POST /merchants/onboarding
app.post('/merchants/onboarding', requireAuth, async (req, res) => {
  try {
    const {
      businessName,
      businessType,
      storeName,
      ownerName,
      phone,
      email,
      address,
      latitude,
      longitude,
      storeLogoBase64,
      ownerIdBase64,
      businessCertificateBase64,
      proofOfAddressBase64,
    } = req.body || {};

    const data = await upsertMerchantOnboarding({
      userId: req.userId,
      businessName,
      businessType,
      storeName,
      ownerName,
      phone,
      email,
      address,
      latitude,
      longitude,
      storeLogoBase64,
      ownerIdBase64,
      businessCertificateBase64,
      proofOfAddressBase64,
    });

    return res.json(data);
  } catch (error) {
    console.error('merchant onboarding error:', error);
    return res.status(400).json({ error: error.message || 'Failed to save merchant onboarding' });
  }
});

// POST /auth/login-password { phone, password }
app.post('/auth/login-password', async (req, res) => {
  try {
    const { phone, password } = req.body || {};

    if (!phone || !password) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'Both phone number and password are required'
      });
    }

    // Basic phone validation
    if (!phone.startsWith('+') || phone.length < 10) {
      return res.status(400).json({
        error: 'Invalid phone number format',
        details: 'Phone number must be in E.164 format (e.g., +263712345678)'
      });
    }

    const data = await loginWithPassword({ phone, password });

    return res.json({
      success: true,
      user: data.user,
      session: data.session
    });
  } catch (error) {
    console.error('login-password error:', error);
    const msg = error.message || '';

    if (msg.includes('No account found')) {
      return res.status(404).json({
        error: msg,
        details: msg,
      });
    }

    if (msg.includes('Incorrect phone or password')) {
      return res.status(401).json({
        error: msg,
        details: 'Please check your phone number and password',
      });
    }

    if (msg.includes('Password is required')) {
      return res.status(400).json({
        error: msg,
        details: msg,
      });
    }

    return res.status(500).json({
      error: 'Failed to sign in',
      details: 'Please try again',
    });
  }
});

// POST /auth/send-otp { phone }
app.post('/auth/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        error: 'Phone number is required',
        details: 'Please provide a phone number in E.164 format (e.g., +263712345678)'
      });
    }

    // Basic phone validation
    if (!phone.startsWith('+') || phone.length < 10) {
      return res.status(400).json({
        error: 'Invalid phone number format',
        details: 'Phone number must be in E.164 format (e.g., +263712345678)'
      });
    }

    await sendOtpToPhone(phone);
    return res.json({
      success: true,
      message: 'Verification code sent successfully',
      phone: phone
    });
  } catch (error) {
    console.error('send-otp error:', error);
    return res.status(500).json({
      error: 'Failed to send verification code',
      details: error.message || 'Please try again later'
    });
  }
});

// POST /auth/verify-otp { phone, token }
app.post('/auth/verify-otp', async (req, res) => {
  try {
    const { phone, token, isSignUp = false, password } = req.body;
    console.log('[Auth] /auth/verify-otp called for phone:', phone, '| isSignUp:', isSignUp);
    if (!phone || !token) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'Both phone number and verification code are required'
      });
    }

    if (token.length !== 6 || !/^\d+$/.test(token)) {
      return res.status(400).json({
        error: 'Invalid verification code',
        details: 'Verification code must be 6 digits'
      });
    }

    const data = await verifyPhoneOtp({ phone, token, isSignUp, password });

    return res.json({
      success: true,
      user: data.user,
      session: data.session
    });
  } catch (error) {
    console.error('verify-otp error:', error);

    const msg = error.message || '';

    // Account conflict errors (sign-up with existing phone, sign-in with unknown phone)
    if (
      msg.includes('already exists') ||
      msg.includes('sign in instead') ||
      msg.includes('sign up first') ||
      msg.includes('No account found')
    ) {
      return res.status(409).json({
        error: msg,
        details: msg,
      });
    }

    // Bad OTP code / expired
    if (msg.includes('Invalid verification') || msg.includes('expired')) {
      return res.status(400).json({
        error: msg,
        details: 'Please request a new verification code',
      });
    }

    return res.status(500).json({
      error: 'Failed to verify code',
      details: 'Please try again',
    });
  }
});


// POST /users/ensure-profile { userId, email, phone, fullName, role }
app.post('/users/ensure-profile', async (req, res) => {
  try {
    const { userId, email, phone, fullName, role } = req.body;

    if (!userId || !role) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'userId and role are required'
      });
    }

    // Validate role
    const validRoles = ['customer', 'merchant', 'courier'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({
        error: 'Invalid role',
        details: `Role must be one of: ${validRoles.join(', ')}`
      });
    }

    await ensureUserProfile({ userId, email, phone, fullName, role });
    return res.json({
      success: true,
      message: 'User profile created successfully'
    });
  } catch (error) {
    console.error('ensure-profile error:', error);
    return res.status(500).json({
      error: 'Failed to create user profile',
      details: error.message || 'Please try again later'
    });
  }
});

// GET /users/profile — returns current user's profile from DB (auth required)
app.get('/users/profile', requireAuth, async (req, res) => {
  try {
    console.log('[Auth] /users/profile for userId:', req.userId);
    const profile = await getProfile(req.userId);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found', details: 'No profile for this user' });
    }
    return res.json(profile);
  } catch (error) {
    console.error('get profile error:', error);
    return res.status(500).json({
      error: 'Failed to load profile',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /users/me — profile + role-specific row (customer | merchant | courier) with all fields
app.get('/users/me', requireAuth, async (req, res) => {
  try {
    const data = await getFullUserMe(req.userId);
    if (!data) {
      return res.status(404).json({ error: 'User not found', details: 'No profile for this user' });
    }
    return res.json(data);
  } catch (error) {
    console.error('get /users/me error:', error);
    return res.status(500).json({
      error: 'Failed to load user',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /users/me/orders — order history for current user (by role: customer, merchant, courier)
app.get('/users/me/orders', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const status = req.query.status || undefined;
    const { orders, role } = await getOrdersForUser(req.userId, { limit, offset, status });
    return res.json({ orders, role });
  } catch (error) {
    console.error('get orders error:', error);
    return res.status(500).json({
      error: 'Failed to load orders',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /users/me/wallet-transactions — wallet transaction history
app.get('/users/me/wallet-transactions', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const transactions = await getWalletTransactionsForUser(req.userId, { limit, offset });
    return res.json({ transactions });
  } catch (error) {
    console.error('get wallet-transactions error:', error);
    return res.status(500).json({
      error: 'Failed to load wallet transactions',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /users/me/payments — payment history (customers only; others get empty array)
app.get('/users/me/payments', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const payments = await getPaymentsForUser(req.userId, { limit, offset });
    return res.json({ payments });
  } catch (error) {
    console.error('get payments error:', error);
    return res.status(500).json({
      error: 'Failed to load payments',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /users/me/addresses — saved delivery addresses for the current customer
app.get('/users/me/addresses', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const { data, error } = await supabase
      .from('customer_addresses')
      .select('id, label, address_line1, city, latitude, longitude, is_default, created_at, updated_at')
      .eq('customer_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('get addresses error:', error);
      throw new Error(error.message || 'Failed to load addresses');
    }

    return res.json({ addresses: data || [] });
  } catch (error) {
    console.error('get /users/me/addresses error:', error);
    return res.status(500).json({
      error: 'Failed to load addresses',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /users/me/addresses — create a new saved address for the current customer
app.post('/users/me/addresses', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { label, address, city, latitude, longitude } = req.body || {};

    if (!label || !address) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'label and address are required',
      });
    }

    const insert = {
      customer_id: req.userId,
      label: String(label).trim(),
      address_line1: String(address).trim(),
      city: city ? String(city).trim() : 'Harare',
      latitude:
        latitude != null && latitude !== '' && Number.isFinite(Number(latitude)) ? Number(latitude) : null,
      longitude:
        longitude != null && longitude !== '' && Number.isFinite(Number(longitude)) ? Number(longitude) : null,
    };

    const { data, error } = await supabase
      .from('customer_addresses')
      .insert(insert)
      .select('id, label, address_line1, city, latitude, longitude, is_default, created_at, updated_at')
      .single();

    if (error) {
      console.error('create address error:', error);
      throw new Error(error.message || 'Failed to create address');
    }

    return res.status(201).json(data);
  } catch (error) {
    console.error('post /users/me/addresses error:', error);
    return res.status(500).json({
      error: 'Failed to create address',
      details: error.message || 'Please try again later',
    });
  }
});

// DELETE /users/me/addresses/:id — delete a saved address for the current customer
app.delete('/users/me/addresses/:id', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    const { error } = await supabase
      .from('customer_addresses')
      .delete()
      .eq('id', id)
      .eq('customer_id', req.userId);

    if (error) {
      console.error('delete address error:', error);
      throw new Error(error.message || 'Failed to delete address');
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('delete /users/me/addresses error:', error);
    return res.status(500).json({
      error: 'Failed to delete address',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /users/me/addresses/:id/default — mark one address as default (and unset others)
app.post('/users/me/addresses/:id/default', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    // Unset other defaults for this user
    const { error: clearError } = await supabase
      .from('customer_addresses')
      .update({ is_default: false })
      .eq('customer_id', req.userId);

    if (clearError) {
      console.error('clear default address error:', clearError);
      throw new Error(clearError.message || 'Failed to clear default address');
    }

    // Set selected address as default
    const { data, error } = await supabase
      .from('customer_addresses')
      .update({ is_default: true })
      .eq('id', id)
      .eq('customer_id', req.userId)
      .select('id, label, address_line1, city, is_default, created_at, updated_at')
      .single();

    if (error) {
      console.error('set default address error:', error);
      throw new Error(error.message || 'Failed to set default address');
    }

    return res.json(data);
  } catch (error) {
    console.error('post /users/me/addresses/:id/default error:', error);
    return res.status(500).json({
      error: 'Failed to set default address',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /payments/pesepay/start — start a Pesepay seamless payment (auth required)
app.post('/payments/pesepay/start', requireAuth, async (req, res) => {
  try {
    const {
      amount,
      currencyCode,
      paymentMethodCode,
      reasonForPayment,
      merchantReference,
      orderId,
      resultUrl,
      returnUrl,
      customer,
    } = req.body || {};

    if (!amount || amount <= 0) {
      return res.status(400).json({
        error: 'Invalid amount',
        details: 'amount must be greater than 0',
      });
    }

    if (!paymentMethodCode) {
      return res.status(400).json({
        error: 'Missing paymentMethodCode',
        details: 'Provide a valid Pesepay paymentMethodCode',
      });
    }

    if (!customer?.phoneNumber) {
      return res.status(400).json({
        error: 'Missing customer phoneNumber',
        details: 'customer.phoneNumber is required for Pesepay',
      });
    }

    if (!reasonForPayment) {
      return res.status(400).json({
        error: 'Missing reasonForPayment',
        details: 'reasonForPayment is required',
      });
    }

    if (!resultUrl) {
      return res.status(400).json({
        error: 'Missing resultUrl',
        details: 'resultUrl (your public callback URL) is required for Pesepay',
      });
    }

    const data = await createPesepayTransaction({
      userId: req.userId,
      amount,
      currencyCode: currencyCode || 'USD',
      paymentMethodCode,
      reasonForPayment,
      merchantReference,
      orderId,
      resultUrl,
      returnUrl,
      customer,
    });

    return res.json(data);
  } catch (error) {
    console.error('Pesepay start error:', error);
    return res.status(500).json({
      error: 'Failed to start Pesepay payment',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /payments/pesepay/callback — Pesepay resultUrl callback (no auth, called by Pesepay)
app.post('/payments/pesepay/callback', async (req, res) => {
  try {
    const result = await handlePesepayCallback(req.body);
    // Respond with a simple OK so Pesepay knows we processed it
    return res.json({ ok: true, transactionStatus: result?.transaction?.transactionStatus });
  } catch (error) {
    console.error('Pesepay callback error:', error);
    return res.status(500).json({
      error: 'Failed to process Pesepay callback',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /users/me/payment-methods — payment methods saved for the current customer
app.get('/users/me/payment-methods', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const { data, error } = await supabase
      .from('customer_payment_methods')
      .select('id, type, provider, last_four_digits, expiry_date, phone_country_code, phone_number, is_default, is_active, created_at, updated_at')
      .eq('customer_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('get payment-methods error:', error);
      throw new Error(error.message || 'Failed to load payment methods');
    }

    return res.json({ paymentMethods: data || [] });
  } catch (error) {
    console.error('get /users/me/payment-methods error:', error);
    return res.status(500).json({
      error: 'Failed to load payment methods',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /users/me/payment-methods — create a new payment method for the current customer
app.post('/users/me/payment-methods', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const {
      type,
      provider,
      lastFourDigits,
      expiryDate,
      phoneCountryCode,
      phoneNumber,
    } = req.body || {};

    if (!type || !provider) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'type and provider are required',
      });
    }

    const insert = {
      customer_id: req.userId,
      type: String(type).trim(),
      provider: String(provider).trim(),
      last_four_digits: lastFourDigits ? String(lastFourDigits).trim() : null,
      expiry_date: expiryDate ? String(expiryDate).trim() : null,
      phone_country_code: phoneCountryCode ? String(phoneCountryCode).trim() : null,
      phone_number: phoneNumber ? String(phoneNumber).trim() : null,
    };

    const { data, error } = await supabase
      .from('customer_payment_methods')
      .insert(insert)
      .select('id, type, provider, last_four_digits, expiry_date, phone_country_code, phone_number, is_default, is_active, created_at, updated_at')
      .single();

    if (error) {
      console.error('create payment-method error:', error);
      throw new Error(error.message || 'Failed to create payment method');
    }

    return res.status(201).json(data);
  } catch (error) {
    console.error('post /users/me/payment-methods error:', error);
    return res.status(500).json({
      error: 'Failed to create payment method',
      details: error.message || 'Please try again later',
    });
  }
});

// PATCH /users/me/payment-methods/:id — update a payment method for the current customer
app.patch('/users/me/payment-methods/:id', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;
    const {
      type,
      provider,
      lastFourDigits,
      expiryDate,
      phoneCountryCode,
      phoneNumber,
    } = req.body || {};

    const updateData = {};
    if (type !== undefined) updateData.type = String(type).trim();
    if (provider !== undefined) updateData.provider = String(provider).trim();
    if (lastFourDigits !== undefined) updateData.last_four_digits = lastFourDigits ? String(lastFourDigits).trim() : null;
    if (expiryDate !== undefined) updateData.expiry_date = expiryDate ? String(expiryDate).trim() : null;
    if (phoneCountryCode !== undefined) updateData.phone_country_code = phoneCountryCode ? String(phoneCountryCode).trim() : null;
    if (phoneNumber !== undefined) updateData.phone_number = phoneNumber ? String(phoneNumber).trim() : null;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        error: 'No fields to update',
        details: 'Provide fields to update for the payment method',
      });
    }

    const { data, error } = await supabase
      .from('customer_payment_methods')
      .update(updateData)
      .eq('id', id)
      .eq('customer_id', req.userId)
      .select('id, type, provider, last_four_digits, expiry_date, phone_country_code, phone_number, is_default, is_active, created_at, updated_at')
      .single();

    if (error) {
      console.error('update payment-method error:', error);
      throw new Error(error.message || 'Failed to update payment method');
    }

    return res.json(data);
  } catch (error) {
    console.error('patch /users/me/payment-methods/:id error:', error);
    return res.status(500).json({
      error: 'Failed to update payment method',
      details: error.message || 'Please try again later',
    });
  }
});

// DELETE /users/me/payment-methods/:id — delete a payment method for the current customer
app.delete('/users/me/payment-methods/:id', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    const { error } = await supabase
      .from('customer_payment_methods')
      .delete()
      .eq('id', id)
      .eq('customer_id', req.userId);

    if (error) {
      console.error('delete payment-method error:', error);
      throw new Error(error.message || 'Failed to delete payment method');
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('delete /users/me/payment-methods/:id error:', error);
    return res.status(500).json({
      error: 'Failed to delete payment method',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /users/me/payment-methods/:id/default — mark one payment method as default
app.post('/users/me/payment-methods/:id/default', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    // Clear existing defaults
    const { error: clearError } = await supabase
      .from('customer_payment_methods')
      .update({ is_default: false })
      .eq('customer_id', req.userId);

    if (clearError) {
      console.error('clear default payment-method error:', clearError);
      throw new Error(clearError.message || 'Failed to clear default payment method');
    }

    // Set selected as default
    const { data, error } = await supabase
      .from('customer_payment_methods')
      .update({ is_default: true })
      .eq('id', id)
      .eq('customer_id', req.userId)
      .select('id, type, provider, last_four_digits, expiry_date, phone_country_code, phone_number, is_default, is_active, created_at, updated_at')
      .single();

    if (error) {
      console.error('set default payment-method error:', error);
      throw new Error(error.message || 'Failed to set default payment method');
    }

    return res.json(data);
  } catch (error) {
    console.error('post /users/me/payment-methods/:id/default error:', error);
    return res.status(500).json({
      error: 'Failed to set default payment method',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /users/me/favorites — favorite stores for the current customer
app.get('/users/me/favorites', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const { data, error } = await supabase
      .from('customer_favorites')
      .select(
        `
          id,
          store_id,
          created_at,
          stores (
            id,
            store_name,
            logo,
            rating,
            total_reviews,
            city
          )
        `,
      )
      .eq('customer_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('get favorites error:', error);
      throw new Error(error.message || 'Failed to load favorites');
    }

    return res.json({ favorites: data || [] });
  } catch (error) {
    console.error('get /users/me/favorites error:', error);
    return res.status(500).json({
      error: 'Failed to load favorites',
      details: error.message || 'Please try again later',
    });
  }
});

// DELETE /users/me/favorites/:id — remove a favorite store for the current customer
app.delete('/users/me/favorites/:id', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    const { error } = await supabase
      .from('customer_favorites')
      .delete()
      .eq('id', id)
      .eq('customer_id', req.userId);

    if (error) {
      console.error('delete favorite error:', error);
      throw new Error(error.message || 'Failed to delete favorite');
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('delete /users/me/favorites/:id error:', error);
    return res.status(500).json({
      error: 'Failed to delete favorite',
      details: error.message || 'Please try again later',
    });
  }
});

// PATCH /users/profile — update full_name, email, and optionally profile photo (auth required)
// Body: { full_name?, email?, profile_photo_base64? } (base64 data URL or raw base64 string)
app.patch('/users/profile', requireAuth, async (req, res) => {
  try {
    const { full_name, email, profile_photo_base64 } = req.body;
    const updates = {};
    if (full_name !== undefined) updates.full_name = full_name || null;
    if (email !== undefined) updates.email = email || null;

    let profilePhotoUrl = null;
    if (profile_photo_base64) {
      const base64Data = profile_photo_base64.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const contentType = profile_photo_base64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
      profilePhotoUrl = await uploadProfilePhoto(req.userId, buffer, contentType);
      updates.profile_photo = profilePhotoUrl;
    }

    const profile = await updateProfile(req.userId, updates);
    return res.json(profile);
  } catch (error) {
    console.error('update profile error:', error);
    return res.status(500).json({
      error: 'Failed to update profile',
      details: error.message || 'Please try again later',
    });
  }
});

// ========== Admin Dashboard API (require ADMIN_API_KEY) ==========
app.get('/admin/stats', requireAdmin, async (req, res) => {
  try {
    const stats = await getAdminStats();
    return res.json(stats);
  } catch (error) {
    console.error('admin/stats error:', error);
    return res.status(500).json({ error: 'Failed to load stats', details: error.message || 'Try again later' });
  }
});

app.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const role = req.query.role || undefined;
    const search = req.query.search || undefined;
    const result = await getAdminUsers({ limit, offset, role, search });
    return res.json(result);
  } catch (error) {
    console.error('admin/users error:', error);
    return res.status(500).json({ error: 'Failed to load users', details: error.message || 'Try again later' });
  }
});

app.get('/admin/orders', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const status = req.query.status || undefined;
    const from = req.query.from || undefined;
    const to = req.query.to || undefined;
    const result = await getAdminOrders({ limit, offset, status, from, to });
    return res.json(result);
  } catch (error) {
    console.error('admin/orders error:', error);
    return res.status(500).json({ error: 'Failed to load orders', details: error.message || 'Try again later' });
  }
});

app.get('/admin/deliveries', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const result = await getAdminDeliveries({ limit, offset });
    return res.json(result);
  } catch (error) {
    console.error('admin/deliveries error:', error);
    return res.status(500).json({ error: 'Failed to load deliveries', details: error.message || 'Try again later' });
  }
});

app.get('/admin/payments', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const result = await getAdminPayments({ limit, offset });
    return res.json(result);
  } catch (error) {
    console.error('admin/payments error:', error);
    return res.status(500).json({ error: 'Failed to load payments', details: error.message || 'Try again later' });
  }
});

app.get('/admin/stores', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const result = await getAdminStores({ limit, offset });
    return res.json(result);
  } catch (error) {
    console.error('admin/stores error:', error);
    return res.status(500).json({ error: 'Failed to load stores', details: error.message || 'Try again later' });
  }
});

app.get('/admin/merchants', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const result = await getAdminMerchants({ limit, offset });
    return res.json(result);
  } catch (error) {
    console.error('admin/merchants error:', error);
    return res.status(500).json({ error: 'Failed to load merchants', details: error.message || 'Try again later' });
  }
});

app.get('/admin/couriers', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const result = await getAdminCouriers({ limit, offset });
    return res.json(result);
  } catch (error) {
    console.error('admin/couriers error:', error);
    return res.status(500).json({ error: 'Failed to load couriers', details: error.message || 'Try again later' });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: NODE_ENV === 'development' ? err.message : 'Please try again later'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    details: `${req.method} ${req.path} is not a valid endpoint`
  });
});

app.listen(PORT, () => {
  console.log('✅ DOT Backend API started successfully');
  console.log(`📍 Server: http://localhost:${PORT}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log(`🔒 CORS allowed origins:`, allowedOrigins);
});
