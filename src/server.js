import 'dotenv/config.js';
import express from 'express';
import cors from 'cors';
import { loginWithPassword, checkPhoneRegistered, deleteUserById } from './authService.js';
import { verifyFirebaseToken } from './firebaseAdmin.js';
import {
  ensureUserProfile,
  getProfile,
  getRoles,
  updateProfile,
  uploadProfilePhoto,
  recordCourierProfilePhotoDocument,
} from './userService.js';
import { getOrdersForUser, getWalletTransactionsForUser, getPaymentsForUser, getFullUserMe, getMerchantDashboardStats } from './historyService.js';
import { initiateContipayPayment, handleContipayCallback, getContipayConfig } from './contipayService.js';
import { createSupabaseAccessToken, verifyAccessToken } from './sessionToken.js';
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
  getAdminStatsCharts,
  getAdminUsers,
  getAdminOrders,
  getAdminDeliveries,
  getAdminPayments,
  getAdminStores,
  getAdminMerchants,
  getAdminCouriers,
  getAdminPendingDocuments,
  getAdminPendingUsers,
  approveCourier,
  approveMerchant,
  rejectCourier,
  rejectMerchant,
  getAdminCourierDetail,
  getAdminMerchantDetail,
} from './adminService.js';
import { supabaseAdmin as publicSupabase } from './supabaseAdminClient.js';
import { enrichStoreForCustomerListing, assertStoreAcceptingOrders } from './storeHours.js';
import { getMerchantHelpPayload } from './merchantHelpContent.js';
import {
  insertUserNotification,
  notifyCustomerMerchantOrderStatus,
  notifyCustomerCourierAssigned,
  notifyCustomerOrderPlaced,
  notifyCustomerOrderSelfCancelled,
} from './orderNotifications.js';
import { recordCourierDeliveryEarnings } from './orderPaymentSplit.js';
import crypto from 'crypto';
import axios from 'axios';

const app = express();
const supabase = supabaseAdmin;
const PORT = process.env.PORT || 4000;

// Send push notification to all verified, non-busy couriers about a new ready order
async function notifyAvailableCouriers(orderId, orderNumber, storeName) {
  if (!supabase) return;
  try {
    // Get all verified couriers
    const { data: couriers } = await supabase
      .from('couriers')
      .select('id, user_profiles ( push_token )')
      .eq('is_verified', true);
    if (!couriers?.length) return;

    // Exclude couriers currently on an active delivery
    const { data: busyRows } = await supabase
      .from('orders')
      .select('courier_id')
      .in('status', ['assigned', 'merchant_confirmed', 'picked_up', 'in_transit', 'delivery_confirmation_pending'])
      .not('courier_id', 'is', null);
    const busyIds = new Set((busyRows || []).map((r) => r.courier_id));

    const numLabel = orderNumber ? `#${orderNumber}` : 'An order';
    const store = storeName || 'a store';
    const pushMessages = [];
    for (const courier of couriers) {
      if (busyIds.has(courier.id)) continue;
      const token = courier.user_profiles?.push_token;
      if (!token || !token.startsWith('ExponentPushToken')) continue;
      pushMessages.push({ to: token, title: 'New delivery available', body: `${numLabel} from ${store} is ready for pickup.`, data: { type: 'new_job', orderId }, sound: 'default' });
    }
    if (!pushMessages.length) return;
    await axios.post('https://exp.host/push/send', pushMessages, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 10000,
    });
  } catch (err) {
    console.warn('[Push] Failed to notify couriers for order', orderId, err?.message);
  }
}
const NODE_ENV = process.env.NODE_ENV || 'development';

// Simple distance + ETA helpers
function deg2rad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) *
      Math.cos(deg2rad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function estimateEtaMinutes(distanceKm) {
  const speedKmh = 25; // average courier speed
  const minutes = (distanceKm / speedKmh) * 60;
  const clamped = Math.min(Math.max(minutes, 10), 60); // 10–60 mins
  return Math.round(clamped);
}

// Delivery fee: $5 base for ≤10 km; beyond that $0.50/km ($0.55 during rush hour).
// Rush hour = weekdays 7–9 am and 5–7 pm Zimbabwe time (CAT = UTC+2).
function isRushHour(date = new Date()) {
  const localHour = (date.getUTCHours() + 2) % 24;
  const day = date.getUTCDay(); // 0=Sun, 6=Sat
  const weekday = day >= 1 && day <= 5;
  return weekday && ((localHour >= 7 && localHour < 9) || (localHour >= 17 && localHour < 19));
}

function calculateDeliveryFee(distanceKm) {
  const BASE = 5.00;
  const BASE_KM = 10;
  if (distanceKm <= BASE_KM) return BASE;
  const rate = isRushHour() ? 0.55 : 0.50;
  return Math.round((BASE + (distanceKm - BASE_KM) * rate) * 100) / 100;
}

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

app.use(express.json({ limit: '20mb' }));

/** Auth middleware: verify Bearer token via Supabase, set req.userId */
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', details: 'Valid access token required' });
  }
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user?.id) {
      return res.status(401).json({ error: 'Unauthorized', details: 'Invalid or expired token' });
    }
    req.userId = data.user.id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized', details: err.message });
  }
}

// POST /auth/firebase-verify { idToken, phone, name, role, password }
app.post('/auth/firebase-verify', async (req, res) => {
  try {
    const { idToken, phone, name, role, password } = req.body;

    if (!idToken || !role || !password) {
      return res.status(400).json({ error: 'idToken, role, and password are required' });
    }

    const validRoles = ['customer', 'merchant', 'courier'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // 1. Verify the Firebase ID token — confirms the phone number is real
    const decoded = await verifyFirebaseToken(idToken);
    const verifiedPhone = decoded.phone_number || phone;

    // 2. Check if this phone already has a Supabase account
    const existing = await checkPhoneRegistered(verifiedPhone);

    let userId;
    if (existing.registered) {
      userId = existing.userId;
    } else {
      // 3. Create the user in Supabase Auth so login-password works
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        phone: verifiedPhone,
        password,
        phone_confirm: true,
      });
      if (authError) throw authError;
      userId = authData.user.id;
    }

    // 4. Create/update rows in user_profiles + role table
    await ensureUserProfile({
      userId,
      email: null,
      phone: verifiedPhone,
      fullName: name || '',
      role,
      password,
    });

    // 5. Sign in to get a live Supabase session
    const sessionData = await loginWithPassword({ phone: verifiedPhone, password });

    return res.status(201).json({
      success: true,
      user: { ...sessionData.user, role },
      session: sessionData.session,
    });
  } catch (error) {
    console.error('firebase-verify error:', error);
    return res.status(401).json({
      error: 'Verification failed',
      details: error.message || 'Invalid or expired token',
    });
  }
});

// In-memory OTP store: phone -> { code, expiresAt, name, role, password }
const otpStore = new Map();

// POST /auth/send-otp { phone, name, role, password }
app.post('/auth/send-otp', async (req, res) => {
  try {
    const { phone, name, role, password } = req.body;
    if (!phone || !role || !password) {
      return res.status(400).json({ error: 'phone, role, and password are required' });
    }
    const validRoles = ['customer', 'merchant', 'courier'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    otpStore.set(phone, { code, expiresAt, name, role, password });

    const dexatelApiKey = process.env.DEXATEL_API_KEY;
    const dexatelSender = process.env.DEXATEL_SENDER;
    if (!dexatelApiKey || !dexatelSender) {
      return res.status(503).json({ error: 'OTP service not configured' });
    }

    try {
      await axios.post(
        'https://api.dexatel.com/v1/messages',
        { data: { from: dexatelSender, to: [phone], text: `Your Delivery On Time verification code is: ${code}`, channel: 'sms' } },
        { headers: { 'Content-Type': 'application/json', 'X-Dexatel-Key': dexatelApiKey } }
      );
    } catch (smsErr) {
      const status = smsErr.response?.status;
      const detail = JSON.stringify(smsErr.response?.data ?? smsErr.message);
      console.error(`Dexatel error [${status}]:`, detail);
      return res.status(502).json({ error: 'Failed to send verification code', details: detail });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('send-otp error:', error.message);
    return res.status(500).json({ error: 'Failed to send OTP', details: error.message });
  }
});

// POST /auth/verify-otp { phone, code }
app.post('/auth/verify-otp', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ error: 'phone and code are required' });
    }

    const entry = otpStore.get(phone);
    if (!entry) {
      return res.status(400).json({ error: 'No OTP found for this number. Please request a new code.' });
    }
    if (Date.now() > entry.expiresAt) {
      otpStore.delete(phone);
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }
    if (entry.code !== String(code)) {
      return res.status(400).json({ error: 'Incorrect verification code.' });
    }

    otpStore.delete(phone);
    const { name, role, password } = entry;

    const existing = await checkPhoneRegistered(phone);
    let userId;
    if (existing.registered) {
      userId = existing.userId;
      const { data: profile } = await supabaseAdmin
        .from('user_profiles')
        .select('is_suspended')
        .eq('id', userId)
        .single();
      if (profile?.is_suspended) {
        return res.status(403).json({ error: 'Your account has been suspended. Please contact support.' });
      }
    } else {
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        phone,
        password,
        phone_confirm: true,
      });
      if (authError) {
        if (authError.code === 'phone_exists') {
          // Phone exists in auth.users but not in user_profiles (e.g. prior failed attempt)
          const { data: listData, error: listError } = await supabaseAdmin.auth.admin.listUsers();
          if (listError) throw listError;
          const match = listData.users.find(u => u.phone === phone);
          if (!match) throw new Error('Phone already registered but user not found. Please contact support.');
          userId = match.id;
          // Update their password to the one they just registered with
          await supabaseAdmin.auth.admin.updateUserById(userId, { password });
        } else {
          throw authError;
        }
      } else {
        userId = authData.user.id;
      }
    }

    await ensureUserProfile({ userId, email: null, phone, fullName: name || '', role, password });

    const sessionData = await loginWithPassword({ phone, password });

    return res.status(201).json({
      success: true,
      user: { ...sessionData.user, role },
      session: sessionData.session,
    });
  } catch (error) {
    console.error('verify-otp error:', error);
    return res.status(400).json({ error: 'Verification failed', details: error.message });
  }
});

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

// GET /debug/contipay — test ContiPay configuration
app.get('/debug/contipay', (req, res) => {
  try {
    const config = getContipayConfig();
    res.json({
      hasKey: !!config.apiKey,
      keyPrefix: config.apiKey?.slice(0, 4) || 'none',
      keyLength: config.apiKey?.length || 0,
      baseUrl: process.env.CONTIPAY_API_URL || 'https://api.contipay.co.zw',
      envVars: Object.keys(process.env).filter(k => k.startsWith('CONTI')).join(', ')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Business Types ─────────────────────────────────────────────────────────

// GET /business-types — public list of all business categories
app.get('/business-types', async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { data, error } = await supabase
      .from('business_types')
      .select('id, name, icon')
      .order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return res.json({ business_types: data || [] });
  } catch (err) {
    console.error('GET /business-types error:', err);
    return res.status(500).json({ error: 'Failed to load business types', details: err.message });
  }
});

// POST /business-types — create a new business type (auth required; merchant submitting "Other")
app.post('/business-types', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { name, icon } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const label = String(name).trim();
    // Derive a slug from the label
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

    // Upsert so concurrent submissions of the same type are idempotent
    const { data, error } = await supabase
      .from('business_types')
      .upsert({ id, name: label, icon: icon || 'shopping-bag', is_default: false }, { onConflict: 'id' })
      .select('id, name, icon, is_default')
      .single();

    if (error) throw new Error(error.message);
    return res.status(201).json(data);
  } catch (err) {
    console.error('POST /business-types error:', err);
    return res.status(500).json({ error: 'Failed to create business type', details: err.message });
  }
});

// ─── Public Stores ───────────────────────────────────────────────────────────

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
      user_lat,
      user_lng,
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
          banner_url,
          description,
          city,
          latitude,
          longitude,
          rating,
          total_reviews,
          is_open,
          is_active,
          operating_hours,
          merchants ( business_type )
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

    // Attach distance + ETA if user lat/lng provided
    let userLat = null;
    let userLng = null;
    if (user_lat != null && user_lat !== '' && user_lng != null && user_lng !== '') {
      const latNum = Number(user_lat);
      const lngNum = Number(user_lng);
      if (Number.isFinite(latNum) && Number.isFinite(lngNum)) {
        userLat = latNum;
        userLng = lngNum;
      }
    }

    if (userLat != null && userLng != null) {
      stores = stores.map((s) => {
        if (s.latitude != null && s.longitude != null) {
          const distance_km = haversineKm(userLat, userLng, s.latitude, s.longitude);
          const eta_minutes = estimateEtaMinutes(distance_km);
          return { ...s, distance_km, eta_minutes };
        }
        return { ...s, distance_km: null, eta_minutes: null };
      });
    }

    // Flatten merchants.business_type → top-level business_type, remove nested object
    stores = stores.map(({ merchants, ...rest }) => ({
      ...rest,
      business_type: merchants?.business_type || null,
    }));

    stores = stores.map((s) => enrichStoreForCustomerListing(s));

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

// GET /courier/vehicle — get the active vehicle for the logged-in courier
app.get('/courier/vehicle', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const { data, error } = await supabase
      .from('courier_vehicles')
      .select(
        'id, courier_id, vehicle_type, brand, model, year, color, license_plate, delivery_bag_available, vehicle_photo_url, registration_certificate_url, is_active, created_at, updated_at',
      )
      .eq('courier_id', req.userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      console.error('get /courier/vehicle error:', error);
      throw new Error(error.message || 'Failed to load courier vehicle');
    }

    let vehicle = Array.isArray(data) && data.length > 0 ? data[0] : null;

    // Attempt to create a signed URL for the vehicle photo if we have a storage URL
    if (vehicle?.vehicle_photo_url) {
      try {
        const originalUrl = vehicle.vehicle_photo_url;
        const u = new URL(originalUrl);
        const parts = u.pathname.split('/').filter(Boolean);
        // Expected patterns:
        // /storage/v1/object/public/<bucket>/<path>
        // /storage/v1/object/<bucket>/<path>
        const objectIdx = parts.findIndex((p) => p === 'object');
        if (objectIdx !== -1) {
          const afterObject = parts.slice(objectIdx + 1);
          if (afterObject.length >= 2) {
            const bucket = afterObject[0] === 'public' ? afterObject[1] : afterObject[0];
            const pathParts =
              afterObject[0] === 'public' ? afterObject.slice(2) : afterObject.slice(1);
            const path = decodeURIComponent(pathParts.join('/'));
            if (bucket && path) {
              const { data: signed, error: signErr } = await supabase.storage
                .from(bucket)
                .createSignedUrl(path, 60 * 60); // 1 hour
              if (!signErr && signed?.signedUrl) {
                vehicle = { ...vehicle, vehicle_photo_signed_url: signed.signedUrl };
              }
            }
          }
        }
      } catch (e) {
        console.error('Failed to sign vehicle photo URL:', e);
      }
    }

    return res.json({ vehicle });
  } catch (error) {
    console.error('get /courier/vehicle error:', error);
    return res.status(500).json({
      error: 'Failed to load courier vehicle',
      details: error.message || 'Please try again later',
    });
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
    const { methodType, provider, accountNumber, accountName, secondary } = req.body || {};
    const data = await saveCourierPayoutMethod({
      userId: req.userId,
      methodType,
      provider,
      accountNumber,
      accountName,
    });
    // Save optional secondary payout method
    if (secondary?.provider && secondary?.accountNumber) {
      await saveCourierPayoutMethod({
        userId: req.userId,
        methodType: secondary.methodType || 'mobile_money',
        provider: secondary.provider,
        accountNumber: secondary.accountNumber,
        accountName: secondary.accountName || null,
        isDefault: false,
      });
    }
    return res.json(data);
  } catch (error) {
    console.error('courier payout onboarding error:', error);
    return res.status(400).json({ error: error.message || 'Failed to save payout method' });
  }
});

// GET /courier/payout-method — get default payout method for courier wallet
app.get('/courier/payout-method', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const { data, error } = await supabase
      .from('courier_payout_methods')
      .select('id, method_type, provider, account_number, account_name, is_default')
      .eq('courier_id', req.userId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('get /courier/payout-method error:', error);
      throw new Error(error.message || 'Failed to load payout method');
    }

    return res.json({ payoutMethod: data || null });
  } catch (error) {
    console.error('get /courier/payout-method error:', error);
    return res.status(500).json({
      error: 'Failed to load payout method',
      details: error.message || 'Please try again later',
    });
  }
});

// List all documents uploaded by the authenticated courier
app.get('/courier/documents', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const { data, error } = await supabase
      .from('courier_documents')
      .select('id, courier_id, document_type, document_url, status, created_at')
      .eq('courier_id', req.userId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('get /courier/documents error:', error);
      throw new Error(error.message || 'Failed to load documents');
    }

    return res.json({ documents: data || [] });
  } catch (error) {
    console.error('get /courier/documents error:', error);
    return res.status(500).json({
      error: 'Failed to load documents',
      details: error.message || 'Please try again later',
    });
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
      address_line2,
      city,
      state_province,
      postal_code,
      country,
      latitude,
      longitude,
      description,
      operating_hours,
      is_open,
      business_registration_number,
      tax_id,
      storeLogoBase64,
      storeBannerBase64,
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
      address_line2,
      city,
      state_province,
      postal_code,
      country,
      latitude,
      longitude,
      description,
      operating_hours,
      is_open,
      business_registration_number,
      tax_id,
      storeLogoBase64,
      storeBannerBase64,
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

// PATCH /merchant/profile — update merchant (business_name, business_type, business_registration_number, tax_id)
app.patch('/merchant/profile', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { business_name, business_type, business_registration_number, tax_id } = req.body || {};
    const update = {};
    if (business_name !== undefined && String(business_name).trim()) update.business_name = String(business_name).trim();
    if (business_type !== undefined) update.business_type = business_type ? String(business_type).trim() : null;
    if (business_registration_number !== undefined) update.business_registration_number = business_registration_number ? String(business_registration_number).trim() : null;
    if (tax_id !== undefined) update.tax_id = tax_id ? String(tax_id).trim() : null;
    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        error: 'No fields to update',
        details: 'Provide at least one of: business_name, business_type, business_registration_number, tax_id',
      });
    }

    const { data: merchantRow, error: merchantError } = await supabase
      .from('merchants')
      .update(update)
      .eq('id', req.userId)
      .select('id, business_name, business_type, business_registration_number, tax_id, is_active')
      .maybeSingle();

    if (merchantError) {
      console.error('patch /merchant/profile error:', merchantError);
      throw new Error(merchantError.message || 'Failed to update merchant profile');
    }

    if (!merchantRow) {
      return res.status(404).json({ error: 'Merchant not found' });
    }

    return res.json(merchantRow);
  } catch (error) {
    console.error('patch /merchant/profile error:', error);
    return res.status(500).json({
      error: 'Failed to update merchant profile',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /merchant/products — list products for stores owned by current merchant
app.get('/merchant/products', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const { data: stores, error: storesError } = await supabase
      .from('stores')
      .select('id')
      .eq('merchant_id', req.userId)
      .eq('is_active', true);

    if (storesError) {
      console.error('merchant products stores error:', storesError);
      throw new Error(storesError.message || 'Failed to load stores for merchant');
    }

    const storeIds = Array.isArray(stores) ? stores.map((s) => s.id) : [];
    if (storeIds.length === 0) {
      return res.json({ products: [] });
    }

    const { data, error } = await supabase
      .from('products')
      .select(
        `
        id,
        store_id,
        category_id,
        name,
        description,
        price,
        unit,
        is_available,
        is_featured,
        image_url,
        product_categories ( name )
      `,
      )
      .in('store_id', storeIds)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('merchant products query error:', error);
      throw new Error(error.message || 'Failed to load products');
    }

    const products = (data || []).map((p) => ({
      id: p.id,
      store_id: p.store_id,
      category_id: p.category_id,
      name: p.name,
      description: p.description,
      price: p.price,
      unit: p.unit,
      is_available: p.is_available,
      is_featured: p.is_featured,
      image_url: p.image_url,
      category_name:
        (Array.isArray(p.product_categories)
          ? p.product_categories[0]?.name
          : p.product_categories?.name) || null,
    }));

    return res.json({ products });
  } catch (error) {
    console.error('get /merchant/products error:', error);
    return res.status(500).json({
      error: 'Failed to load products',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /stores/:storeId/menu — public menu for a store (categories + products)
app.get('/stores/:storeId/menu', async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { storeId } = req.params;

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('id, is_active, is_open, operating_hours')
      .eq('id', storeId)
      .maybeSingle();

    if (storeError || !store || store.is_active === false) {
      return res.status(404).json({ error: 'Store not found' });
    }

    const closed = assertStoreAcceptingOrders(store);
    if (!closed.ok) {
      return res.status(closed.status).json(closed.body);
    }

    const { data: productsData, error: productsError } = await supabase
      .from('products')
      .select(
        `
        id,
        store_id,
        category_id,
        name,
        description,
        price,
        unit,
        is_available,
        is_featured,
        image_url,
        product_categories ( name )
      `,
      )
      .eq('store_id', storeId)
      .eq('is_available', true)
      .order('display_order', { ascending: true });

    if (productsError) {
      console.error('public store menu products error:', productsError);
      throw new Error(productsError.message || 'Failed to load menu');
    }

    const products = (productsData || []).map((p) => {
      const categoryName =
        (Array.isArray(p.product_categories)
          ? p.product_categories[0]?.name
          : p.product_categories?.name) || 'Other';
      return {
        id: p.id,
        store_id: p.store_id,
        name: p.name,
        description: p.description,
        price: p.price,
        unit: p.unit,
        is_available: p.is_available,
        is_featured: p.is_featured,
        image_url: p.image_url,
        category: categoryName,
      };
    });

    const categorySet = new Set();
    products.forEach((p) => {
      if (p.is_featured) categorySet.add('Popular');
      if (p.category) categorySet.add(p.category);
    });
    const categories = Array.from(categorySet);
    if (categories.length === 0) categories.push('Menu');

    return res.json({ categories, products });
  } catch (error) {
    console.error('get /stores/:storeId/menu error:', error);
    return res.status(500).json({
      error: 'Failed to load menu',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /stores/:storeId/delivery-fee?delivery_lat=&delivery_lng= — estimate delivery fee for a store
app.get('/stores/:storeId/delivery-fee', async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { storeId } = req.params;
    const deliveryLat = parseFloat(req.query.delivery_lat);
    const deliveryLng = parseFloat(req.query.delivery_lng);
    if (!Number.isFinite(deliveryLat) || !Number.isFinite(deliveryLng)) {
      return res.status(400).json({ error: 'delivery_lat and delivery_lng are required' });
    }
    const { data: store, error } = await supabase
      .from('stores')
      .select('latitude, longitude')
      .eq('id', storeId)
      .maybeSingle();
    if (error || !store) return res.status(404).json({ error: 'Store not found' });
    const distanceKm = haversineKm(store.latitude, store.longitude, deliveryLat, deliveryLng);
    const fee = calculateDeliveryFee(distanceKm);
    return res.json({ delivery_fee: fee, distance_km: Math.round(distanceKm * 10) / 10, is_rush_hour: isRushHour() });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to calculate delivery fee' });
  }
});

// PATCH /merchant/products/:id — update product fields (only for merchant's own products)
app.patch('/merchant/products/:id', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    const { data: product, error: productError } = await supabase
      .from('products')
      .select('id, store_id')
      .eq('id', id)
      .maybeSingle();

    if (productError) {
      console.error('merchant products find error:', productError);
      throw new Error(productError.message || 'Failed to load product');
    }

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('merchant_id')
      .eq('id', product.store_id)
      .maybeSingle();

    if (storeError) {
      console.error('merchant products store check error:', storeError);
      throw new Error(storeError.message || 'Failed to verify store ownership');
    }

    if (!store || store.merchant_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden', details: 'Cannot modify this product' });
    }

    const { name, description, price, is_available, is_featured, image_url, category_id, category_name, unit } = req.body || {};

    let resolvedCategoryId = category_id !== undefined ? (category_id || null) : undefined;
    if (resolvedCategoryId === undefined && category_name !== undefined && String(category_name || '').trim()) {
      const catName = String(category_name).trim();
      const { data: existing } = await supabase
        .from('product_categories')
        .select('id')
        .eq('store_id', product.store_id)
        .ilike('name', catName)
        .maybeSingle();
      if (existing) {
        resolvedCategoryId = existing.id;
      } else {
        const { data: created } = await supabase
          .from('product_categories')
          .insert({ store_id: product.store_id, name: catName })
          .select('id')
          .single();
        if (created) resolvedCategoryId = created.id;
      }
    }

    const update = {};
    if (name !== undefined) update.name = String(name).trim();
    if (description !== undefined) update.description = description ? String(description).trim() : null;
    if (price !== undefined && price !== null && price !== '') {
      update.price = Number(price);
    }
    if (is_available !== undefined) update.is_available = !!is_available;
    if (is_featured !== undefined) update.is_featured = !!is_featured;
    if (image_url !== undefined) update.image_url = image_url ? String(image_url).trim() : null;
    if (resolvedCategoryId !== undefined) update.category_id = resolvedCategoryId;
    if (unit !== undefined) update.unit = unit === 'kg' ? 'kg' : 'item';

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        error: 'No fields to update',
        details: 'Provide at least one updatable field',
      });
    }

    const { data: updated, error: updateError } = await supabase
      .from('products')
      .update(update)
      .eq('id', id)
      .select('id, store_id, name, description, price, unit, is_available, is_featured, image_url')
      .single();

    if (updateError) {
      console.error('merchant products update error:', updateError);
      throw new Error(updateError.message || 'Failed to update product');
    }

    return res.json(updated);
  } catch (error) {
    console.error('patch /merchant/products/:id error:', error);
    return res.status(500).json({
      error: 'Failed to update product',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /merchant/stores — list stores for current merchant (for dashboard)
app.get('/merchant/stores', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    let data, error;
    const fullSelect =
      'id, store_name, logo, banner_url, description, phone, email, address_line1, address_line2, city, state_province, postal_code, country, latitude, longitude, is_open, is_active, operating_hours';
    const minimalSelect = 'id, store_name, logo, merchant_id, created_at';
    let result = await supabase
      .from('stores')
      .select(fullSelect)
      .eq('merchant_id', req.userId)
      .order('created_at', { ascending: false });
    data = result.data;
    error = result.error;
    if (error) {
      console.error('get /merchant/stores Supabase error:', { code: error.code, message: error.message, details: error.details });
      // If full select fails (e.g. missing column in DB), retry with minimal columns
      result = await supabase
        .from('stores')
        .select(minimalSelect)
        .eq('merchant_id', req.userId)
        .order('created_at', { ascending: false });
      data = result.data;
      error = result.error;
    }
    if (error) {
      console.error('get /merchant/stores Supabase retry error:', { code: error.code, message: error.message });
      throw new Error(error.message || 'Failed to load stores');
    }
    const stores = data || [];
    for (const store of stores) {
      try {
        if (store.logo && typeof store.logo === 'string') {
          const pathMatch = store.logo.match(/\/store-logos\/(.+)$/);
          if (pathMatch) {
            const { data: signed, error: signErr } = await supabase.storage
              .from('store-logos')
              .createSignedUrl(pathMatch[1], 3600);
            if (!signErr && signed?.signedUrl) store.logo = signed.signedUrl;
          }
        }
      } catch (e) {
        console.error('store logo signed url error:', e);
      }
    }
    return res.json({ stores });
  } catch (err) {
    console.error('get /merchant/stores error:', err);
    return res.status(500).json({
      error: 'Failed to load stores',
      details: err.message || 'Please try again later',
    });
  }
});

// PATCH /merchant/stores/:id — update store (only merchant's own store)
app.patch('/merchant/stores/:id', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('id, merchant_id')
      .eq('id', id)
      .maybeSingle();
    if (storeError || !store || store.merchant_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden', details: 'Store not found or access denied' });
    }
    const {
      store_name,
      logo,
      banner_url,
      description,
      phone,
      email,
      address_line1,
      address_line2,
      city,
      state_province,
      postal_code,
      country,
      latitude,
      longitude,
      is_open,
      is_active,
      operating_hours,
    } = req.body || {};
    const update = {};
    if (store_name !== undefined && String(store_name).trim()) update.store_name = String(store_name).trim();
    if (logo !== undefined) update.logo = logo ? String(logo).trim() : null;
    if (banner_url !== undefined) update.banner_url = banner_url ? String(banner_url).trim() : null;
    if (description !== undefined) update.description = description ? String(description).trim() : null;
    if (phone !== undefined) update.phone = phone ? String(phone).trim() : null;
    if (email !== undefined) update.email = email ? String(email).trim() : null;
    if (address_line1 !== undefined && String(address_line1).trim()) update.address_line1 = String(address_line1).trim();
    if (address_line2 !== undefined) update.address_line2 = address_line2 ? String(address_line2).trim() : null;
    if (city !== undefined && String(city).trim()) update.city = String(city).trim();
    if (state_province !== undefined) update.state_province = state_province ? String(state_province).trim() : null;
    if (postal_code !== undefined) update.postal_code = postal_code ? String(postal_code).trim() : null;
    if (country !== undefined) update.country = country ? String(country).trim() : null;
    if (latitude !== undefined && latitude !== null && latitude !== '') update.latitude = Number(latitude);
    if (longitude !== undefined && longitude !== null && longitude !== '') update.longitude = Number(longitude);
    if (is_open !== undefined) update.is_open = !!is_open;
    if (is_active !== undefined) update.is_active = !!is_active;
    if (operating_hours !== undefined) {
      if (operating_hours === null) update.operating_hours = null;
      else if (typeof operating_hours === 'object') update.operating_hours = operating_hours;
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No fields to update', details: 'Provide at least one updatable field' });
    }
    const { data: updated, error: updateError } = await supabase
      .from('stores')
      .update(update)
      .eq('id', id)
      .select()
      .single();
    if (updateError) throw new Error(updateError.message || 'Failed to update store');
    return res.json(updated);
  } catch (error) {
    console.error('patch /merchant/stores/:id error:', error);
    return res.status(500).json({
      error: 'Failed to update store',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /merchant/settings — app preferences for current merchant (stored in merchant_settings)
app.get('/merchant/settings', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const { data: merchantRow, error: merchantError } = await supabase
      .from('merchants')
      .select('id')
      .eq('id', req.userId)
      .maybeSingle();

    if (merchantError) {
      console.error('get /merchant/settings merchant lookup:', merchantError);
      throw new Error(merchantError.message || 'Failed to verify merchant');
    }
    if (!merchantRow) {
      return res.status(403).json({ error: 'Forbidden', details: 'Merchant profile required' });
    }

    const { data, error } = await supabase
      .from('merchant_settings')
      .select(
        'new_order_sound, vibration_alerts, auto_accept_orders, default_prep_time, rider_arrived_notification, customer_messages_notification, promotions_notification',
      )
      .eq('merchant_id', req.userId)
      .maybeSingle();

    if (error) {
      console.error('get /merchant/settings error:', error);
      throw new Error(error.message || 'Failed to load merchant settings');
    }

    const s = data || {};
    return res.json({
      new_order_sound: s.new_order_sound ?? true,
      vibration_alerts: s.vibration_alerts ?? true,
      auto_accept_orders: s.auto_accept_orders ?? false,
      default_prep_time: typeof s.default_prep_time === 'number' ? s.default_prep_time : 15,
      rider_arrived_notification: s.rider_arrived_notification ?? true,
      customer_messages_notification: s.customer_messages_notification ?? true,
      promotions_notification: s.promotions_notification ?? true,
    });
  } catch (error) {
    console.error('get /merchant/settings error:', error);
    return res.status(500).json({
      error: 'Failed to load merchant settings',
      details: error.message || 'Please try again later',
    });
  }
});

// PUT /merchant/settings — upsert merchant app preferences
app.put('/merchant/settings', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const { data: merchantRow, error: merchantError } = await supabase
      .from('merchants')
      .select('id')
      .eq('id', req.userId)
      .maybeSingle();

    if (merchantError) {
      console.error('put /merchant/settings merchant lookup:', merchantError);
      throw new Error(merchantError.message || 'Failed to verify merchant');
    }
    if (!merchantRow) {
      return res.status(403).json({ error: 'Forbidden', details: 'Merchant profile required' });
    }

    const {
      new_order_sound,
      vibration_alerts,
      auto_accept_orders,
      default_prep_time,
      rider_arrived_notification,
      customer_messages_notification,
      promotions_notification,
    } = req.body || {};

    const payload = { merchant_id: req.userId };

    if (new_order_sound !== undefined) payload.new_order_sound = !!new_order_sound;
    if (vibration_alerts !== undefined) payload.vibration_alerts = !!vibration_alerts;
    if (auto_accept_orders !== undefined) payload.auto_accept_orders = !!auto_accept_orders;
    if (default_prep_time !== undefined && default_prep_time !== null && default_prep_time !== '') {
      const n = Number(default_prep_time);
      if (!Number.isNaN(n) && n >= 1 && n <= 180) payload.default_prep_time = Math.round(n);
    }
    if (rider_arrived_notification !== undefined)
      payload.rider_arrived_notification = !!rider_arrived_notification;
    if (customer_messages_notification !== undefined)
      payload.customer_messages_notification = !!customer_messages_notification;
    if (promotions_notification !== undefined) payload.promotions_notification = !!promotions_notification;

    if (Object.keys(payload).length <= 1) {
      return res.status(400).json({
        error: 'No settings to update',
        details: 'Provide at least one setting field',
      });
    }

    const { data, error } = await supabase
      .from('merchant_settings')
      .upsert(payload, { onConflict: 'merchant_id' })
      .select(
        'new_order_sound, vibration_alerts, auto_accept_orders, default_prep_time, rider_arrived_notification, customer_messages_notification, promotions_notification',
      )
      .maybeSingle();

    if (error) {
      console.error('put /merchant/settings error:', error);
      throw new Error(error.message || 'Failed to save merchant settings');
    }

    const s = data || {};
    return res.json({
      new_order_sound: s.new_order_sound ?? true,
      vibration_alerts: s.vibration_alerts ?? true,
      auto_accept_orders: s.auto_accept_orders ?? false,
      default_prep_time: typeof s.default_prep_time === 'number' ? s.default_prep_time : 15,
      rider_arrived_notification: s.rider_arrived_notification ?? true,
      customer_messages_notification: s.customer_messages_notification ?? true,
      promotions_notification: s.promotions_notification ?? true,
    });
  } catch (error) {
    console.error('put /merchant/settings error:', error);
    return res.status(500).json({
      error: 'Failed to save merchant settings',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /merchant/help — contact info + FAQs + quick actions (server-driven copy)
app.get('/merchant/help', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { data: merchantRow, error: merchantError } = await supabase
      .from('merchants')
      .select('id')
      .eq('id', req.userId)
      .maybeSingle();
    if (merchantError) {
      console.error('get /merchant/help merchant lookup:', merchantError);
      throw new Error(merchantError.message || 'Failed to verify merchant');
    }
    if (!merchantRow) {
      return res.status(403).json({ error: 'Forbidden', details: 'Merchant profile required' });
    }
    const { quickActions, faqs } = getMerchantHelpPayload();
    return res.json({
      contact: {
        phone: process.env.SUPPORT_PHONE || null,
        email: process.env.SUPPORT_EMAIL || null,
        whatsappUrl: process.env.SUPPORT_WHATSAPP_URL || null,
        hours: process.env.SUPPORT_HOURS || 'Mon–Fri 8:00–18:00',
      },
      quickActions,
      faqs,
    });
  } catch (error) {
    console.error('get /merchant/help error:', error);
    return res.status(500).json({
      error: 'Failed to load help',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /merchant/customers/create — merchant creates a new customer account
app.post('/merchant/customers/create', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    // Verify caller is a merchant
    const { data: merchantRow, error: merchantError } = await supabase
      .from('merchants')
      .select('id')
      .eq('id', req.userId)
      .maybeSingle();
    if (merchantError) throw new Error(merchantError.message || 'Failed to verify merchant');
    if (!merchantRow) {
      return res.status(403).json({ error: 'Forbidden', details: 'Merchant profile required' });
    }

    const { fullName, phone, password } = req.body;

    if (!fullName || !phone || !password) {
      return res.status(400).json({ error: 'fullName, phone and password are required' });
    }
    if (!phone.startsWith('+') || phone.length < 10) {
      return res.status(400).json({ error: 'Invalid phone number format. Use E.164 format e.g. +263712345678' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Reject duplicate phone
    const existing = await checkPhoneRegistered(phone);
    if (existing.registered) {
      return res.status(409).json({ error: 'An account with this phone number already exists' });
    }

    // Create Supabase Auth user (phone already confirmed — no OTP needed)
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      phone,
      password,
      phone_confirm: true,
    });
    if (authError) throw authError;

    const userId = authData.user.id;

    await ensureUserProfile({ userId, email: null, phone, fullName, role: 'customer', password });

    return res.status(201).json({ success: true, userId, message: 'Customer account created successfully' });
  } catch (error) {
    console.error('POST /merchant/customers/create error:', error);
    return res.status(500).json({ error: 'Failed to create customer', details: error.message });
  }
});

// GET /merchant/support-tickets — current merchant's requests
app.get('/merchant/support-tickets', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { data: merchantRow, error: merchantError } = await supabase
      .from('merchants')
      .select('id')
      .eq('id', req.userId)
      .maybeSingle();
    if (merchantError) throw new Error(merchantError.message || 'Failed to verify merchant');
    if (!merchantRow) {
      return res.status(403).json({ error: 'Forbidden', details: 'Merchant profile required' });
    }

    const { data, error } = await supabase
      .from('support_tickets')
      .select('id, reference_code, subject, category, status, created_at')
      .eq('user_id', req.userId)
      .eq('role_context', 'merchant')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('get /merchant/support-tickets error:', error);
      throw new Error(error.message || 'Failed to load tickets');
    }

    return res.json({ tickets: data || [] });
  } catch (error) {
    console.error('get /merchant/support-tickets error:', error);
    return res.status(500).json({
      error: 'Failed to load support tickets',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /merchant/support-tickets/:id — single ticket (must belong to user)
app.get('/merchant/support-tickets/:id', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;
    const { data, error } = await supabase
      .from('support_tickets')
      .select(
        'id, reference_code, subject, category, message, status, created_at, updated_at',
      )
      .eq('id', id)
      .eq('user_id', req.userId)
      .eq('role_context', 'merchant')
      .maybeSingle();

    if (error) {
      console.error('get /merchant/support-tickets/:id error:', error);
      throw new Error(error.message || 'Failed to load ticket');
    }
    if (!data) {
      return res.status(404).json({ error: 'Not found', details: 'Ticket not found' });
    }
    return res.json(data);
  } catch (error) {
    console.error('get /merchant/support-tickets/:id error:', error);
    return res.status(500).json({
      error: 'Failed to load ticket',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /merchant/support-tickets — create a help request
app.post('/merchant/support-tickets', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { data: merchantRow, error: merchantError } = await supabase
      .from('merchants')
      .select('id')
      .eq('id', req.userId)
      .maybeSingle();
    if (merchantError) throw new Error(merchantError.message || 'Failed to verify merchant');
    if (!merchantRow) {
      return res.status(403).json({ error: 'Forbidden', details: 'Merchant profile required' });
    }

    const { category, subject, message } = req.body || {};
    const subj = subject != null ? String(subject).trim() : '';
    const msg = message != null ? String(message).trim() : '';
    if (!subj || !msg) {
      return res.status(400).json({
        error: 'Missing fields',
        details: 'subject and message are required',
      });
    }

    let reference_code = `M-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: created, error: insertError } = await supabase
        .from('support_tickets')
        .insert({
          user_id: req.userId,
          role_context: 'merchant',
          category: category ? String(category).trim() : null,
          subject: subj,
          message: msg,
          status: 'open',
          reference_code,
        })
        .select('id, reference_code, subject, category, status, created_at')
        .single();

      if (!insertError && created) {
        return res.status(201).json(created);
      }
      if (insertError?.code === '23505') {
        reference_code = `M-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        continue;
      }
      console.error('post /merchant/support-tickets error:', insertError);
      throw new Error(insertError?.message || 'Failed to create ticket');
    }
    throw new Error('Could not allocate a unique ticket reference');
  } catch (error) {
    console.error('post /merchant/support-tickets error:', error);
    return res.status(500).json({
      error: 'Failed to create support ticket',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /courier/support-tickets — courier submits a help/issue request
app.post('/courier/support-tickets', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { category, subject, message } = req.body || {};
    if (!subject || !message) {
      return res.status(400).json({ error: 'subject and message are required' });
    }
    const { data, error } = await supabase
      .from('support_tickets')
      .insert({
        user_id: req.userId,
        role_context: 'courier',
        category: category || 'general',
        subject: String(subject).trim().slice(0, 255),
        message: String(message).trim(),
        status: 'open',
      })
      .select('id, status, created_at')
      .single();
    if (error) throw new Error(error.message || 'Failed to create ticket');
    return res.status(201).json({ ticket: data });
  } catch (error) {
    console.error('post /courier/support-tickets error:', error);
    return res.status(500).json({
      error: 'Failed to create support ticket',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /customer/support-tickets — customer submits a help/issue request
app.post('/customer/support-tickets', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { category, subject, message } = req.body || {};
    if (!subject || !message) {
      return res.status(400).json({ error: 'subject and message are required' });
    }
    const { data, error } = await supabase
      .from('support_tickets')
      .insert({
        user_id: req.userId,
        role_context: 'customer',
        category: category || 'general',
        subject: String(subject).trim().slice(0, 255),
        message: String(message).trim(),
        status: 'open',
      })
      .select('id, status, created_at')
      .single();
    if (error) throw new Error(error.message || 'Failed to create ticket');
    return res.status(201).json({ ticket: data });
  } catch (error) {
    console.error('post /customer/support-tickets error:', error);
    return res.status(500).json({
      error: 'Failed to create support ticket',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /merchant/stores/:id/upload-logo — upload store logo and return URL
app.post('/merchant/stores/:id/upload-logo', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;
    const { image_base64 } = req.body || {};

    if (!image_base64) {
      return res.status(400).json({
        error: 'Missing image_base64',
        details: 'image_base64 is required',
      });
    }

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('id, merchant_id')
      .eq('id', id)
      .maybeSingle();

    if (storeError || !store || store.merchant_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden', details: 'Store not found or access denied' });
    }

    const match = String(image_base64).match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid image payload', details: 'Expected base64 data URL' });
    }
    const mime = match[1];
    const base64 = match[2];
    const buffer = Buffer.from(base64, 'base64');
    const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'bin';

    const filename = `stores/${id}/logo.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('store-logos')
      .upload(filename, buffer, {
        contentType: mime,
        upsert: true,
      });

    if (uploadError) {
      console.error('store logo upload error:', uploadError);
      throw new Error(uploadError.message || 'Failed to upload logo');
    }

    const { data: urlData } = supabase.storage.from('store-logos').getPublicUrl(filename);
    const logoUrl = urlData?.publicUrl || null;

    if (!logoUrl) {
      return res.status(500).json({
        error: 'Failed to resolve logo URL',
        details: 'Upload succeeded but URL could not be resolved',
      });
    }

    // Save on store
    const { error: updateError } = await supabase
      .from('stores')
      .update({ logo: logoUrl })
      .eq('id', id);

    if (updateError) {
      console.error('store logo update error:', updateError);
      throw new Error(updateError.message || 'Failed to update store logo');
    }

    return res.json({ logo_url: logoUrl });
  } catch (error) {
    console.error('post /merchant/stores/:id/upload-logo error:', error);
    return res.status(500).json({
      error: 'Failed to upload logo',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /merchant/stores/:id/upload-banner — upload store banner image and return URL
app.post('/merchant/stores/:id/upload-banner', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;
    const { image_base64 } = req.body || {};

    if (!image_base64) {
      return res.status(400).json({
        error: 'Missing image_base64',
        details: 'image_base64 is required',
      });
    }

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('id, merchant_id')
      .eq('id', id)
      .maybeSingle();

    if (storeError || !store || store.merchant_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden', details: 'Store not found or access denied' });
    }

    const match = String(image_base64).match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid image payload', details: 'Expected base64 data URL' });
    }
    const mime = match[1];
    const base64 = match[2];
    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch (bufErr) {
      console.error('store banner buffer error:', bufErr);
      return res.status(400).json({ error: 'Invalid image', details: bufErr.message || 'Failed to decode base64' });
    }
    const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'bin';

    const filename = `stores/${id}/banner.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('store-logos')
      .upload(filename, buffer, {
        contentType: mime,
        upsert: true,
      });

    if (uploadError) {
      console.error('store banner upload error:', uploadError);
      return res.status(500).json({
        error: 'Failed to upload banner',
        details: uploadError.message || 'Storage upload failed. Check that the store-logos bucket exists and allows uploads to stores/*.',
      });
    }

    const { data: urlData } = supabase.storage.from('store-logos').getPublicUrl(filename);
    const bannerUrl = urlData?.publicUrl || null;

    if (!bannerUrl) {
      return res.status(500).json({
        error: 'Failed to resolve banner URL',
        details: 'Upload succeeded but URL could not be resolved',
      });
    }

    const { error: updateError } = await supabase
      .from('stores')
      .update({ banner_url: bannerUrl })
      .eq('id', id);

    if (updateError) {
      console.error('store banner update error:', updateError);
      return res.status(500).json({
        error: 'Failed to save banner URL',
        details: updateError.message || 'Database update failed. Ensure the stores table has a banner_url column.',
      });
    }

    return res.json({ banner_url: bannerUrl });
  } catch (error) {
    console.error('post /merchant/stores/:id/upload-banner error:', error);
    return res.status(500).json({
      error: 'Failed to upload banner',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /merchant/stores/:storeId/categories — product categories for a store
// If no categories exist yet, seed sensible defaults based on merchant.business_type.
app.get('/merchant/stores/:storeId/categories', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { storeId } = req.params;

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('id, merchant_id')
      .eq('id', storeId)
      .maybeSingle();

    if (storeError || !store || store.merchant_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden', details: 'Store not found or access denied' });
    }

    let { data: categories, error } = await supabase
      .from('product_categories')
      .select('id, name, display_order')
      .eq('store_id', storeId)
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    if (error) throw new Error(error.message || 'Failed to load categories');

    if (!categories || categories.length === 0) {
      // Look up merchant business_type and seed default categories for this type of shop.
      const { data: merchantRow, error: merchantError } = await supabase
        .from('merchants')
        .select('business_type')
        .eq('id', store.merchant_id)
        .maybeSingle();

      if (merchantError) {
        console.error('merchant categories business_type error:', merchantError);
      } else {
        const type = String(merchantRow?.business_type || '').toLowerCase();
        let categoriesToInsert = [];

        if (type === 'bakery') {
          categoriesToInsert = ['Bread', 'Pastries', 'Cakes', 'Cookies', 'Drinks'];
        } else if (type === 'grocery' || type === 'grocery / retail') {
          categoriesToInsert = ['Fruits & Vegetables', 'Meat & Poultry', 'Dairy & Eggs', 'Pantry Staples', 'Snacks & Drinks'];
        } else if (type === 'pharmacy') {
          categoriesToInsert = ['Prescription Medicines', 'Over-the-counter', 'Vitamins & Supplements', 'Personal Care', 'Baby & Kids'];
        } else if (type === 'restaurant' || type === 'restaurant / food') {
          categoriesToInsert = ['Starters', 'Mains', 'Sides', 'Drinks', 'Desserts'];
        } else if (type === 'hardware' || type === 'hardware store') {
          categoriesToInsert = ['Tools', 'Building Materials', 'Plumbing', 'Electrical', 'Paint & Finishes'];
        } else {
          categoriesToInsert = ['Featured', 'Best Sellers', 'New Arrivals'];
        }

        const rows = categoriesToInsert.map((name, index) => ({
          store_id: storeId,
          name,
          display_order: index,
          is_active: true,
        }));

        if (rows.length > 0) {
          const { error: insertError } = await supabase
            .from('product_categories')
            .insert(rows);
          if (insertError) {
            console.error('merchant categories seed insert error:', insertError);
          } else {
            const { data: seeded, error: reloadError } = await supabase
              .from('product_categories')
              .select('id, name, display_order')
              .eq('store_id', storeId)
              .eq('is_active', true)
              .order('display_order', { ascending: true });
            if (!reloadError) {
              categories = seeded || [];
            }
          }
        }
      }
    }

    return res.json({ categories: categories || [] });
  } catch (error) {
    console.error('get /merchant/stores/:storeId/categories error:', error);
    return res.status(500).json({
      error: 'Failed to load categories',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /merchant/products — create product (store must belong to merchant)
app.post('/merchant/products', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { store_id, name, description, price, category_id, category_name, unit, image_url, is_available, is_featured } = req.body || {};
    if (!store_id || !name || price === undefined || price === null) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'store_id, name, and price are required',
      });
    }
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('id')
      .eq('id', store_id)
      .eq('merchant_id', req.userId)
      .maybeSingle();
    if (storeError || !store) {
      return res.status(403).json({ error: 'Forbidden', details: 'Store not found or access denied' });
    }

    let resolvedCategoryId = category_id || null;
    if (!resolvedCategoryId && category_name && String(category_name).trim()) {
      const catName = String(category_name).trim();
      const { data: existing } = await supabase
        .from('product_categories')
        .select('id')
        .eq('store_id', store_id)
        .ilike('name', catName)
        .maybeSingle();
      if (existing) {
        resolvedCategoryId = existing.id;
      } else {
        const { data: created } = await supabase
          .from('product_categories')
          .insert({ store_id, name: catName })
          .select('id')
          .single();
        if (created) resolvedCategoryId = created.id;
      }
    }

    const insert = {
      store_id,
      name: String(name).trim(),
      description: description ? String(description).trim() : null,
      price: Number(price),
      unit: unit === 'kg' ? 'kg' : 'item',
      image_url: image_url ? String(image_url).trim() : null,
      is_available: is_available !== false,
      is_featured: !!is_featured,
    };
    if (resolvedCategoryId) insert.category_id = resolvedCategoryId;
    const { data: created, error: insertError } = await supabase
      .from('products')
      .insert(insert)
      .select('id, store_id, name, description, price, unit, image_url, is_available, is_featured, category_id')
      .single();
    if (insertError) {
      console.error('post /merchant/products error:', insertError);
      throw new Error(insertError.message || 'Failed to create product');
    }
    return res.status(201).json(created);
  } catch (error) {
    console.error('post /merchant/products error:', error);
    return res.status(500).json({
      error: 'Failed to create product',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /merchant/products/upload-image — upload a product image and return its URL
app.post('/merchant/products/upload-image', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { store_id, image_base64 } = req.body || {};

    if (!store_id || !image_base64) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'store_id and image_base64 are required',
      });
    }

    // Ensure store belongs to this merchant
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('id, merchant_id')
      .eq('id', store_id)
      .maybeSingle();

    if (storeError || !store || store.merchant_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden', details: 'Store not found or access denied' });
    }

    // Parse data URL
    const match = String(image_base64).match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid image payload', details: 'Expected base64 data URL' });
    }
    const mime = match[1];
    const base64 = match[2];
    const buffer = Buffer.from(base64, 'base64');
    const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'bin';

    const filename = `${store_id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('product-images')
      .upload(filename, buffer, {
        contentType: mime,
        upsert: true,
      });

    if (uploadError) {
      console.error('product image upload error:', uploadError);
      throw new Error(uploadError.message || 'Failed to upload image');
    }

    const { data: urlData } = supabase.storage.from('product-images').getPublicUrl(filename);
    const imageUrl = urlData?.publicUrl || null;

    if (!imageUrl) {
      return res.status(500).json({
        error: 'Failed to resolve image URL',
        details: 'Upload succeeded but URL could not be resolved',
      });
    }

    return res.json({ image_url: imageUrl });
  } catch (error) {
    console.error('post /merchant/products/upload-image error:', error);
    return res.status(500).json({
      error: 'Failed to upload image',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /merchant/promotions/upload-image — upload a promo image and return its URL
app.post('/merchant/promotions/upload-image', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { store_id, image_base64 } = req.body || {};

    if (!store_id || !image_base64) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'store_id and image_base64 are required',
      });
    }

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('id, merchant_id')
      .eq('id', store_id)
      .maybeSingle();

    if (storeError || !store || store.merchant_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden', details: 'Store not found or access denied' });
    }

    const match = String(image_base64).match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid image payload', details: 'Expected base64 data URL' });
    }
    const mime = match[1];
    const base64 = match[2];
    const buffer = Buffer.from(base64, 'base64');
    const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'bin';

    const filename = `promotions/${store_id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('promo-images')
      .upload(filename, buffer, {
        contentType: mime,
        upsert: true,
      });

    if (uploadError) {
      console.error('promo image upload error:', uploadError);
      throw new Error(uploadError.message || 'Failed to upload image');
    }

    const { data: urlData } = supabase.storage.from('promo-images').getPublicUrl(filename);
    const imageUrl = urlData?.publicUrl || null;

    if (!imageUrl) {
      return res.status(500).json({
        error: 'Failed to resolve image URL',
        details: 'Upload succeeded but URL could not be resolved',
      });
    }

    return res.json({ image_url: imageUrl });
  } catch (error) {
    console.error('post /merchant/promotions/upload-image error:', error);
    return res.status(500).json({
      error: 'Failed to upload image',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /public/promotions — list active promo deals (for customer app home screen)
app.get('/public/promotions', async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const now = new Date().toISOString();
    console.log('[PublicPromos] Request at', now);

    const { data, error } = await supabase
      .from('promotions')
      .select(
        `
        id,
        store_id,
        title,
        description,
        tag,
        category,
        image_url,
        is_active,
        starts_at,
        ends_at,
        stores (
          store_name,
          logo,
          city
        )
      `,
      )
      .eq('is_active', true)
      .or('starts_at.is.null,starts_at.lte.' + now)
      .or('ends_at.is.null,ends_at.gte.' + now)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('[PublicPromos] Supabase error', { code: error.code, message: error.message, details: error.details });
      throw new Error(error.message || 'Failed to load promotions');
    }

    console.log('[PublicPromos] Raw rows count:', Array.isArray(data) ? data.length : 0);

    const deals = (data || []).map((p) => ({
      id: p.id,
      store_id: p.store_id,
      title: p.title,
      description: p.description,
      tag: p.tag,
      category: p.category,
      image_url: p.image_url,
      store_name: p.stores?.store_name || null,
      store_logo: p.stores?.logo || null,
      store_city: p.stores?.city || null,
      starts_at: p.starts_at,
      ends_at: p.ends_at,
    }));

    console.log('[PublicPromos] Returning deals count:', deals.length);

    return res.json({ promotions: deals });
  } catch (error) {
    console.error('get /public/promotions error:', error);
    return res.status(500).json({
      error: 'Failed to load promotions',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /merchant/promotions — list promotions for stores owned by current merchant
app.get('/merchant/promotions', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const { data: stores, error: storesError } = await supabase
      .from('stores')
      .select('id')
      .eq('merchant_id', req.userId)
      .eq('is_active', true);

    if (storesError) {
      console.error('merchant promotions stores error:', storesError);
      throw new Error(storesError.message || 'Failed to load stores for merchant');
    }

    const storeIds = Array.isArray(stores) ? stores.map((s) => s.id) : [];
    if (storeIds.length === 0) {
      return res.json({ promotions: [] });
    }

    const { data, error } = await supabase
      .from('promotions')
      .select('id, store_id, title, description, tag, category, image_url, is_active, starts_at, ends_at, recurrence_type, recurrence_weekday, recurrence_month_day, recurrence_time')
      .in('store_id', storeIds)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message || 'Failed to load promotions');

    return res.json({ promotions: data || [] });
  } catch (error) {
    console.error('get /merchant/promotions error:', error);
    return res.status(500).json({
      error: 'Failed to load promotions',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /merchant/promotions — create a new promotion for a store
app.post('/merchant/promotions', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { store_id, title, description, tag, image_url, is_active, starts_at, ends_at, recurrence_type, recurrence_weekday, recurrence_month_day, recurrence_time } = req.body || {};

    if (!store_id || !title) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'store_id and title are required',
      });
    }

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('id, merchant_id')
      .eq('id', store_id)
      .maybeSingle();

    if (storeError || !store || store.merchant_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden', details: 'Store not found or access denied' });
    }

    const insert = {
      store_id,
      title: String(title).trim(),
      description: description ? String(description).trim() : null,
      tag: tag ? String(tag).trim() : null,
      category: req.body?.category ? String(req.body.category).trim() : null,
      image_url: image_url ? String(image_url).trim() : null,
      is_active: is_active !== false,
      starts_at: starts_at || null,
      ends_at: ends_at || null,
      recurrence_type: recurrence_type === 'weekly' || recurrence_type === 'monthly' ? recurrence_type : 'once',
      recurrence_weekday: recurrence_type === 'weekly' && recurrence_weekday >= 0 && recurrence_weekday <= 6 ? Number(recurrence_weekday) : null,
      recurrence_month_day: recurrence_type === 'monthly' && recurrence_month_day >= 1 && recurrence_month_day <= 31 ? Number(recurrence_month_day) : null,
      recurrence_time: recurrence_type === 'weekly' || recurrence_type === 'monthly' ? (recurrence_time && /^\d{1,2}:\d{2}$/.test(String(recurrence_time).trim()) ? String(recurrence_time).trim() : null) : null,
    };

    const { data, error } = await supabase
      .from('promotions')
      .insert(insert)
      .select('id, store_id, title, description, tag, category, image_url, is_active, starts_at, ends_at, recurrence_type, recurrence_weekday, recurrence_month_day, recurrence_time')
      .single();

    if (error) throw new Error(error.message || 'Failed to create promotion');

    return res.status(201).json(data);
  } catch (error) {
    console.error('post /merchant/promotions error:', error);
    return res.status(500).json({
      error: 'Failed to create promotion',
      details: error.message || 'Please try again later',
    });
  }
});

// PATCH /merchant/promotions/:id — update an existing promotion
app.patch('/merchant/promotions/:id', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    const { data: promo, error: promoError } = await supabase
      .from('promotions')
      .select('id, store_id')
      .eq('id', id)
      .maybeSingle();

    if (promoError || !promo) {
      return res.status(404).json({ error: 'Promotion not found' });
    }

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('merchant_id')
      .eq('id', promo.store_id)
      .maybeSingle();

    if (storeError || !store || store.merchant_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden', details: 'Cannot modify this promotion' });
    }

    const { title, description, tag, category, image_url, is_active, starts_at, ends_at, recurrence_type, recurrence_weekday, recurrence_month_day, recurrence_time } = req.body || {};
    const update = {};
    if (title !== undefined && String(title).trim()) update.title = String(title).trim();
    if (description !== undefined) update.description = description ? String(description).trim() : null;
    if (tag !== undefined) update.tag = tag ? String(tag).trim() : null;
    if (category !== undefined) update.category = category ? String(category).trim() : null;
    if (image_url !== undefined) update.image_url = image_url ? String(image_url).trim() : null;
    if (is_active !== undefined) update.is_active = !!is_active;
    if (starts_at !== undefined) update.starts_at = starts_at || null;
    if (ends_at !== undefined) update.ends_at = ends_at || null;
    if (recurrence_type !== undefined) {
      update.recurrence_type = recurrence_type === 'weekly' || recurrence_type === 'monthly' ? recurrence_type : 'once';
      if (update.recurrence_type === 'once') {
        update.recurrence_weekday = null;
        update.recurrence_month_day = null;
        update.recurrence_time = null;
      }
    }
    if (recurrence_weekday !== undefined) update.recurrence_weekday = recurrence_type === 'weekly' && recurrence_weekday >= 0 && recurrence_weekday <= 6 ? Number(recurrence_weekday) : null;
    if (recurrence_month_day !== undefined) update.recurrence_month_day = recurrence_type === 'monthly' && recurrence_month_day >= 1 && recurrence_month_day <= 31 ? Number(recurrence_month_day) : null;
    if (recurrence_time !== undefined) update.recurrence_time = (recurrence_type === 'weekly' || recurrence_type === 'monthly') && recurrence_time && /^\d{1,2}:\d{2}$/.test(String(recurrence_time).trim()) ? String(recurrence_time).trim() : null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        error: 'No fields to update',
        details: 'Provide at least one updatable field',
      });
    }

    const { data: updated, error: updateError } = await supabase
      .from('promotions')
      .update(update)
      .eq('id', id)
      .select('id, store_id, title, description, tag, category, image_url, is_active, starts_at, ends_at, recurrence_type, recurrence_weekday, recurrence_month_day, recurrence_time')
      .single();

    if (updateError) throw new Error(updateError.message || 'Failed to update promotion');

    return res.json(updated);
  } catch (error) {
    console.error('patch /merchant/promotions/:id error:', error);
    return res.status(500).json({
      error: 'Failed to update promotion',
      details: error.message || 'Please try again later',
    });
  }
});

// DELETE /merchant/promotions/:id — delete a promotion
app.delete('/merchant/promotions/:id', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    const { data: promo, error: promoError } = await supabase
      .from('promotions')
      .select('id, store_id')
      .eq('id', id)
      .maybeSingle();

    if (promoError || !promo) {
      return res.status(404).json({ error: 'Promotion not found' });
    }

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('merchant_id')
      .eq('id', promo.store_id)
      .maybeSingle();

    if (storeError || !store || store.merchant_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden', details: 'Cannot delete this promotion' });
    }

    const { error: deleteError } = await supabase
      .from('promotions')
      .delete()
      .eq('id', id);

    if (deleteError) throw new Error(deleteError.message || 'Failed to delete promotion');

    return res.status(204).send();
  } catch (error) {
    console.error('delete /merchant/promotions/:id error:', error);
    return res.status(500).json({
      error: 'Failed to delete promotion',
      details: error.message || 'Please try again later',
    });
  }
});

// DELETE /merchant/products/:id — delete product (only for merchant's own products)
app.delete('/merchant/products/:id', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('id, store_id')
      .eq('id', id)
      .maybeSingle();
    if (productError) throw new Error(productError.message || 'Failed to load product');
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('merchant_id')
      .eq('id', product.store_id)
      .maybeSingle();
    if (storeError || !store || store.merchant_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden', details: 'Cannot delete this product' });
    }
    const { error: deleteError } = await supabase.from('products').delete().eq('id', id);
    if (deleteError) {
      console.error('delete /merchant/products error:', deleteError);
      throw new Error(deleteError.message || 'Failed to delete product');
    }
    return res.status(204).send();
  } catch (error) {
    console.error('delete /merchant/products/:id error:', error);
    return res.status(500).json({
      error: 'Failed to delete product',
      details: error.message || 'Please try again later',
    });
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

// POST /auth/refresh { refreshToken } — exchange a Supabase refresh token for a new access token
app.post('/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken || typeof refreshToken !== 'string') {
      return res.status(400).json({ error: 'refreshToken is required' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Server not configured' });
    }
    const { data, error } = await supabaseAdmin.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data?.session) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }
    return res.json({
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
    });
  } catch (err) {
    console.error('POST /auth/refresh error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auth/check-phone { phone } — check if phone is already registered (any role)
app.post('/auth/check-phone', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ error: 'Phone number is required' });
    }
    if (!phone.startsWith('+') || phone.length < 10) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }
    const result = await checkPhoneRegistered(phone);
    return res.json(result);
  } catch (error) {
    console.error('check-phone error:', error);
    return res.status(500).json({ error: error.message || 'Check failed' });
  }
});

// POST /auth/register { phone, password, name, role }
app.post('/auth/register', async (req, res) => {
  try {
    const { phone, password, name, role } = req.body;

    if (!phone || !password || !role) {
      return res.status(400).json({ error: 'Phone, password, and role are required' });
    }

    const validRoles = ['customer', 'merchant', 'courier'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    if (!phone.startsWith('+') || phone.length < 10) {
      return res.status(400).json({ error: 'Invalid phone number format. Use E.164 format (e.g. +263712345678)' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Reject duplicate phone numbers
    const existing = await checkPhoneRegistered(phone);
    if (existing.registered) {
      return res.status(409).json({ error: 'An account with this phone number already exists' });
    }

    // Create user in Supabase Auth (phone_confirm skips OTP requirement)
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      phone,
      password,
      phone_confirm: true,
    });
    if (authError) throw authError;

    const userId = authData.user.id;

    // Create rows in user_profiles + role-specific table
    await ensureUserProfile({
      userId,
      email: null,
      phone,
      fullName: name || '',
      role,
      password,
    });

    // Sign in to return a live session
    const sessionData = await loginWithPassword({ phone, password });

    return res.status(201).json({
      success: true,
      user: { ...sessionData.user, role },
      session: sessionData.session,
    });
  } catch (error) {
    console.error('register error:', error);
    return res.status(500).json({
      error: 'Registration failed',
      details: error.message || 'Please try again',
    });
  }
});


// POST /users/ensure-profile { userId, email, phone, fullName, role, password }
app.post('/users/ensure-profile', async (req, res) => {
  try {
    const { userId, email, phone, fullName, role, password } = req.body;

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

    await ensureUserProfile({ userId, email, phone, fullName, role, password });
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

// POST /users/me/add-role — add customer | merchant | courier to current account (multi-role; does not remove others)
app.post('/users/me/add-role', requireAuth, async (req, res) => {
  try {
    const { role } = req.body || {};
    const valid = ['customer', 'merchant', 'courier'];
    if (!valid.includes(role)) {
      return res.status(400).json({
        error: 'Invalid role',
        details: `role must be one of: ${valid.join(', ')}`,
      });
    }
    const profile = await getProfile(req.userId);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found', details: 'No profile for this user' });
    }

    await ensureUserProfile({
      userId: req.userId,
      email: profile.email,
      phone: profile.phone,
      fullName: profile.full_name,
      role,
    });

    const roles = await getRoles(req.userId);
    return res.json({ success: true, roles: roles.length > 0 ? roles : [role] });
  } catch (error) {
    console.error('post /users/me/add-role error:', error);
    return res.status(500).json({
      error: 'Failed to add role',
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
    if (data.store?.logo && supabase) {
      const publicUrl = data.store.logo;
      const pathMatch = String(publicUrl).match(/\/store-logos\/(.+)$/);
      if (pathMatch) {
        const path = pathMatch[1];
        try {
          const { data: signed, error: signErr } = await supabase.storage
            .from('store-logos')
            .createSignedUrl(path, 3600);
          if (!signErr && signed?.signedUrl) {
            data.store.logo = signed.signedUrl;
          }
        } catch (e) {
          console.error('store logo signed url error:', e);
        }
      }
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

// DELETE /users/me/account — permanently delete the current user's account (auth + profile + role data)
app.delete('/users/me/account', requireAuth, async (req, res) => {
  try {
    await deleteUserById(req.userId);
    return res.status(200).json({ success: true, message: 'Account deleted' });
  } catch (error) {
    console.error('delete account error:', error);
    return res.status(500).json({
      error: 'Failed to delete account',
      details: error.message || 'Please try again later',
    });
  }
});

// PUT /users/me/push-token — save Expo push token for the current user
app.put('/users/me/push-token', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'token is required' });
    }
    const { error } = await supabase
      .from('user_profiles')
      .update({ push_token: token })
      .eq('id', req.userId);
    if (error) throw new Error(error.message || 'Failed to save push token');
    return res.json({ success: true });
  } catch (error) {
    console.error('PUT /users/me/push-token error:', error);
    return res.status(500).json({ error: error.message || 'Failed to save push token' });
  }
});

// GET /users/me/orders — order history for current user (by role). Use ?role=customer|merchant|courier when user has multiple roles.
app.get('/users/me/orders', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const status = req.query.status || undefined;
    const role = req.query.role || undefined;
    const { orders, role: resolvedRole } = await getOrdersForUser(req.userId, { limit, offset, status, role });
    return res.json({ orders, role: resolvedRole });
  } catch (error) {
    console.error('get orders error:', error);
    return res.status(500).json({
      error: 'Failed to load orders',
      details: error.message || 'Please try again later',
    });
  }
});

// PATCH /orders/:id — merchant updates order status (confirm, preparing, ready, cancelled)
app.patch('/orders/:id', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;
    const { status } = req.body || {};
    const allowed = ['confirmed', 'preparing', 'ready', 'cancelled'];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({
        error: 'Invalid status',
        details: `status must be one of: ${allowed.join(', ')}`,
      });
    }
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, store_id, status, payment_status, payment_method, customer_id, order_number')
      .eq('id', id)
      .maybeSingle();
    if (orderError || !order) return res.status(404).json({ error: 'Order not found' });
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('merchant_id')
      .eq('id', order.store_id)
      .maybeSingle();
    if (storeError || !store || store.merchant_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden', details: 'Cannot update this order' });
    }

    // Merchants may cancel/reject unpaid orders; payment gate applies to other transitions only.
    const isCancelling = status === 'cancelled';
    if (!isCancelling && order.status === 'awaiting_payment') {
      return res.status(400).json({
        error: 'Payment not confirmed',
        details:
          'This order is still awaiting online payment. Accept becomes available after payment succeeds; you can still cancel.',
      });
    }
    if (
      !isCancelling &&
      order.payment_method === 'contipay' &&
      order.payment_status !== 'paid'
    ) {
      return res.status(400).json({
        error: 'Payment not confirmed',
        details:
          'Online payment must complete before you can accept or progress this order; you can still cancel.',
      });
    }

    const { data: updated, error: updateError } = await supabase
      .from('orders')
      .update({ status })
      .eq('id', id)
      .select('id, order_number, status')
      .single();
    if (updateError) throw new Error(updateError.message || 'Failed to update order');

    // Record status change in history table
    const { error: historyError } = await supabase.from('order_status_history').insert({
      order_id: updated.id,
      status,
      notes: null,
      changed_by: req.userId,
    });
    if (historyError) {
      console.error('order_status_history insert error:', historyError);
    }

    const { data: storeRow } = await supabase
      .from('stores')
      .select('store_name')
      .eq('id', order.store_id)
      .maybeSingle();

    await notifyCustomerMerchantOrderStatus(supabase, {
      customerId: order.customer_id,
      orderId: updated.id,
      orderNumber: updated.order_number,
      status,
      storeName: storeRow?.store_name,
    });

    if (status === 'ready') {
      notifyAvailableCouriers(updated.id, updated.order_number, storeRow?.store_name).catch(() => {});
    }

    return res.json(updated);
  } catch (error) {
    console.error('patch /orders/:id error:', error);
    return res.status(500).json({
      error: 'Failed to update order',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /orders/:id/cancel — customer cancels before the store marks the order ready (wallet refunds applied)
app.post('/orders/:id/cancel', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select(
        'id, customer_id, store_id, status, payment_status, payment_method, total_amount, order_number',
      )
      .eq('id', id)
      .maybeSingle();

    if (orderError || !order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.customer_id !== req.userId) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'You can only cancel your own orders',
      });
    }

    const st = String(order.status || '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '_');
    const cancellable = new Set(['awaiting_payment', 'pending']);
    if (!cancellable.has(st)) {
      return res.status(400).json({
        error: 'Cannot cancel this order',
        details:
          'You can only cancel before the merchant accepts your order. Contact support if you need help.',
      });
    }

    if (order.payment_status === 'paid' && order.payment_method === 'contipay') {
      return res.status(400).json({
        error: 'Cannot cancel in the app',
        details:
          'This order was paid online. Please contact support if you need to cancel or refund.',
      });
    }

    const totalAmount = Number(order.total_amount);
    if (
      order.payment_status === 'paid' &&
      order.payment_method === 'wallet' &&
      Number.isFinite(totalAmount) &&
      totalAmount > 0
    ) {
      const { data: lastTx } = await supabase
        .from('wallet_transactions')
        .select('balance_after')
        .eq('user_id', order.customer_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const prevBalance = Number(lastTx?.balance_after) || 0;
      const newBalance = prevBalance + totalAmount;

      const { error: refundError } = await supabase.from('wallet_transactions').insert({
        user_id: order.customer_id,
        user_type: 'customer',
        transaction_type: 'refund',
        amount: totalAmount,
        balance_after: newBalance,
        description: `Refund: cancelled order ${order.order_number}`,
        reference_id: order.id,
        status: 'completed',
      });

      if (refundError) {
        console.error('customer cancel wallet refund error:', refundError);
        throw new Error(refundError.message || 'Failed to refund wallet');
      }

      await supabase
        .from('payments')
        .update({ status: 'refunded' })
        .eq('order_id', order.id)
        .eq('customer_id', order.customer_id);
    }

    const nextPaymentStatus =
      order.payment_status === 'paid' && order.payment_method === 'wallet'
        ? 'refunded'
        : order.payment_status;

    const { data: updated, error: updateError } = await supabase
      .from('orders')
      .update({
        status: 'cancelled',
        payment_status: nextPaymentStatus,
      })
      .eq('id', id)
      .select('id, order_number, status, payment_status')
      .single();

    if (updateError) {
      console.error('customer cancel order update error:', updateError);
      throw new Error(updateError.message || 'Failed to cancel order');
    }

    const { error: historyError } = await supabase.from('order_status_history').insert({
      order_id: updated.id,
      status: 'cancelled',
      notes: 'Cancelled by customer',
      changed_by: req.userId,
    });
    if (historyError) {
      console.error('order_status_history insert (customer cancel) error:', historyError);
    }

    await notifyCustomerOrderSelfCancelled(supabase, {
      customerId: order.customer_id,
      orderId: updated.id,
      orderNumber: updated.order_number,
    });

    return res.json({ order: updated });
  } catch (error) {
    console.error('post /orders/:id/cancel error:', error);
    return res.status(500).json({
      error: 'Failed to cancel order',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /orders/:id — fetch a single order for the current user (customer, merchant, or courier)
app.get('/orders/:id', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    const { data: order, error } = await supabase
      .from('orders')
      .select(
        `
        id,
        order_number,
        customer_id,
        store_id,
        courier_id,
        status,
        subtotal,
        delivery_fee,
        tax,
        total_amount,
        payment_method,
        payment_status,
        pickup_address,
        pickup_latitude,
        pickup_longitude,
        delivery_address,
        delivery_latitude,
        delivery_longitude,
        delivery_notes,
        courier_latitude,
        courier_longitude,
        courier_location_updated_at,
        estimated_prep_time,
        estimated_delivery_time,
        created_at,
        updated_at,
        order_items (
          id,
          product_id,
          product_name,
          product_price,
          quantity,
          unit,
          weight_kg,
          subtotal
        )
      `,
      )
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('get /orders/:id error:', error);
      throw new Error(error.message || 'Failed to load order');
    }
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Ensure user is involved in the order (customer, merchant, or courier)
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('merchant_id, store_name')
      .eq('id', order.store_id)
      .maybeSingle();
    if (storeError) {
      console.error('get /orders/:id store error:', storeError);
      throw new Error(storeError.message || 'Failed to load store for order');
    }

    const isCustomer = order.customer_id === req.userId;
    const isCourier = order.courier_id === req.userId;
    const isMerchant = store?.merchant_id === req.userId;
    if (!isCustomer && !isCourier && !isMerchant) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'You are not allowed to view this order',
      });
    }

    let courier_full_name = null;
    let courier_phone = null;
    if (order.courier_id) {
      const { data: cp } = await supabase
        .from('user_profiles')
        .select('full_name, phone')
        .eq('id', order.courier_id)
        .maybeSingle();
      courier_full_name = cp?.full_name || null;
      courier_phone = cp?.phone || null;
    }

    let courier_vehicle_type = null;
    if (order.courier_id) {
      const { data: vehicle } = await supabase
        .from('courier_vehicles')
        .select('vehicle_type')
        .eq('courier_id', order.courier_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      courier_vehicle_type = vehicle?.vehicle_type || null;
    }

    return res.json({
      order: {
        ...order,
        store_name: store?.store_name || null,
        courier_full_name,
        courier_vehicle_type,
        courier_phone,
      },
    });
  } catch (error) {
    console.error('get /orders/:id error:', error);
    return res.status(500).json({
      error: 'Failed to load order',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /courier/orders/:id/arrived — courier signals they are physically at the pickup location
app.post('/courier/orders/:id/arrived', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, store_id, status, order_number, courier_id')
      .eq('id', id)
      .maybeSingle();

    if (orderError) throw new Error(orderError.message || 'Failed to load order');
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.courier_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden', details: 'This order is not assigned to you' });
    }
    if (order.status !== 'assigned') {
      return res.status(400).json({
        error: 'Cannot mark arrived',
        details: `Order is already in status: ${order.status}`,
      });
    }

    const { data: updated, error: updateError } = await supabase
      .from('orders')
      .update({ status: 'courier_arrived' })
      .eq('id', id)
      .select('id, order_number, status')
      .single();

    if (updateError) throw new Error(updateError.message || 'Failed to update order');

    await supabase.from('order_status_history').insert({
      order_id: id,
      status: 'courier_arrived',
      notes: 'Courier arrived at pickup location',
      changed_by: req.userId,
    });

    // Notify merchant that the courier is at the door
    try {
      const { data: store } = await supabase
        .from('stores')
        .select('merchant_id')
        .eq('id', order.store_id)
        .maybeSingle();
      if (store?.merchant_id) {
        const { data: merchantProfile } = await supabase
          .from('user_profiles')
          .select('push_token')
          .eq('id', store.merchant_id)
          .maybeSingle();
        const token = merchantProfile?.push_token;
        if (token?.startsWith('ExponentPushToken')) {
          await axios.post('https://exp.host/push/send', {
            to: token,
            title: 'Courier has arrived',
            body: `The courier for order #${order.order_number} is at your location. Please confirm pickup.`,
            data: { type: 'courier_arrived', orderId: id },
            sound: 'default',
          }, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 10000 });
        }
      }
    } catch (notifyErr) {
      console.warn('[Push] Failed to notify merchant of courier arrival:', notifyErr?.message);
    }

    return res.json({ order: updated });
  } catch (error) {
    console.error('post /courier/orders/:id/arrived error:', error);
    return res.status(500).json({ error: 'Failed to mark arrived', details: error.message || 'Please try again later' });
  }
});

// POST /merchant/orders/:id/confirm-dispatch — merchant confirms that the courier may leave with the order
app.post('/merchant/orders/:id/confirm-dispatch', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, store_id, courier_id, status, order_number')
      .eq('id', id)
      .maybeSingle();

    if (orderError) {
      console.error('merchant confirm dispatch order error:', orderError);
      throw new Error(orderError.message || 'Failed to load order');
    }
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('merchant_id')
      .eq('id', order.store_id)
      .maybeSingle();

    if (storeError || !store || store.merchant_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden', details: 'Cannot update this order' });
    }

    if (!['assigned', 'courier_arrived'].includes(order.status)) {
      return res.status(400).json({
        error: 'Cannot confirm dispatch',
        details: 'Order must have an assigned courier before merchant confirmation.',
      });
    }

    const { data: updated, error: updateError } = await supabase
      .from('orders')
      .update({ status: 'merchant_confirmed' })
      .eq('id', id)
      .select('id, order_number, status, courier_id')
      .single();

    if (updateError) {
      console.error('merchant confirm dispatch update error:', updateError);
      throw new Error(updateError.message || 'Failed to confirm dispatch');
    }

    const { error: historyError } = await supabase.from('order_status_history').insert({
      order_id: id,
      status: 'merchant_confirmed',
      notes: 'Merchant confirmed dispatch',
      changed_by: req.userId,
    });
    if (historyError) {
      console.error('order_status_history insert (merchant_confirmed) error:', historyError);
    }

    // Notify courier that merchant has confirmed — they can now start delivery
    if (updated?.courier_id) {
      try {
        const { data: courierProfile } = await supabase
          .from('user_profiles')
          .select('push_token')
          .eq('id', updated.courier_id)
          .maybeSingle();
        const token = courierProfile?.push_token;
        if (token?.startsWith('ExponentPushToken')) {
          await axios.post('https://exp.host/push/send', {
            to: token,
            title: 'Pickup confirmed',
            body: `The merchant has confirmed order #${updated.order_number}. You can now start delivery.`,
            data: { type: 'merchant_confirmed', orderId: id },
            sound: 'default',
          }, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 10000 });
        }
      } catch (notifyErr) {
        console.warn('[Push] Failed to notify courier of merchant confirmation:', notifyErr?.message);
      }
    }

    return res.json({ order: updated });
  } catch (error) {
    console.error('post /merchant/orders/:id/confirm-dispatch error:', error);
    return res.status(500).json({
      error: 'Failed to confirm dispatch',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /customer/orders/:id/confirm-delivery — customer confirms the courier has delivered the order
app.post('/customer/orders/:id/confirm-delivery', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, customer_id, courier_id, status, order_number, delivery_fee')
      .eq('id', id)
      .maybeSingle();

    if (orderError) {
      console.error('customer confirm delivery order error:', orderError);
      throw new Error(orderError.message || 'Failed to load order');
    }
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.customer_id !== req.userId) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'You are not the customer for this order',
      });
    }

    if (order.status === 'delivered') {
      const { data: deliveredRow } = await supabase
        .from('orders')
        .select('id, order_number, status, delivery_fee, actual_delivery_time')
        .eq('id', id)
        .single();
      return res.json({ order: deliveredRow });
    }

    if (order.status !== 'delivery_confirmation_pending') {
      return res.status(400).json({
        error: 'Cannot confirm delivery',
        details: 'Delivery confirmation is not pending for this order.',
      });
    }

    const { data: updated, error: updateError } = await supabase
      .from('orders')
      .update({
        status: 'delivered',
        actual_delivery_time: new Date().toISOString(),
      })
      .eq('id', id)
      .select('id, order_number, status, delivery_fee, actual_delivery_time')
      .single();

    if (updateError) {
      console.error('customer confirm delivery update error:', updateError);
      throw new Error(updateError.message || 'Failed to update order');
    }

    const { error: historyError } = await supabase.from('order_status_history').insert({
      order_id: id,
      status: 'delivered',
      notes: 'Customer confirmed delivery',
      changed_by: req.userId,
    });
    if (historyError) {
      console.error('order_status_history insert (customer confirmed delivery) error:', historyError);
    }

    if (order.courier_id) {
      await recordCourierDeliveryEarnings({
        courierId: order.courier_id,
        orderId: id,
        amount: order.delivery_fee,
        orderNumber: order.order_number,
      });

      // Notify courier that customer confirmed delivery
      try {
        const { data: courierProfile } = await supabase
          .from('user_profiles')
          .select('push_token')
          .eq('id', order.courier_id)
          .maybeSingle();
        const courierToken = courierProfile?.push_token;
        if (courierToken && courierToken.startsWith('ExponentPushToken')) {
          const orderLabel = order.order_number ? `#${order.order_number}` : 'Your delivery';
          await axios.post('https://exp.host/push/send', [{
            to: courierToken,
            title: 'Delivery confirmed!',
            body: `${orderLabel} has been confirmed by the customer. Great work!`,
            data: { type: 'delivery_completed', orderId: id },
            sound: 'default',
          }], { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 10000 });
        }
      } catch (pushErr) {
        console.warn('[Push] Failed to notify courier of delivery confirmation:', pushErr?.message);
      }
    }

    return res.json({ order: updated });
  } catch (error) {
    console.error('post /customer/orders/:id/confirm-delivery error:', error);
    return res.status(500).json({
      error: 'Failed to confirm delivery',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /customer/orders/:id/review — customer submits ratings for merchant and courier after delivery
app.post('/customer/orders/:id/review', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;
    const {
      merchant_rating: merchantRatingRaw,
      courier_rating: courierRatingRaw,
      merchant_comment: merchantComment,
      courier_comment: courierComment,
    } = req.body;

    const merchantRating = merchantRatingRaw == null ? null : Number(merchantRatingRaw);
    const courierRating = courierRatingRaw == null ? null : Number(courierRatingRaw);

    if (
      (merchantRating == null || Number.isNaN(merchantRating)) &&
      (courierRating == null || Number.isNaN(courierRating))
    ) {
      return res.status(400).json({
        error: 'Missing ratings',
        details: 'Provide merchant_rating and/or courier_rating between 1 and 5.',
      });
    }

    if (merchantRating != null && (merchantRating < 1 || merchantRating > 5)) {
      return res.status(400).json({
        error: 'Invalid merchant rating',
        details: 'merchant_rating must be between 1 and 5.',
      });
    }
    if (courierRating != null && (courierRating < 1 || courierRating > 5)) {
      return res.status(400).json({
        error: 'Invalid courier rating',
        details: 'courier_rating must be between 1 and 5.',
      });
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, customer_id, store_id, courier_id, status')
      .eq('id', id)
      .maybeSingle();

    if (orderError) {
      console.error('customer review order load error:', orderError);
      throw new Error(orderError.message || 'Failed to load order');
    }
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.customer_id !== req.userId) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'You are not the customer for this order.',
      });
    }
    if (order.status !== 'delivered') {
      return res.status(400).json({
        error: 'Order not delivered',
        details: 'You can only submit a review after delivery is complete.',
      });
    }

    const upsertReview = async ({ storeId, courierId, rating, comment }) => {
      const baseQuery = supabase
        .from('reviews')
        .select('id')
        .eq('order_id', id)
        .eq('customer_id', req.userId);

      let existingQuery = baseQuery;
      if (storeId) {
        existingQuery = existingQuery.eq('store_id', storeId).is('courier_id', null);
      } else {
        existingQuery = existingQuery.is('store_id', null).eq('courier_id', courierId);
      }
      const { data: existing, error: existingError } = await existingQuery.maybeSingle();
      if (existingError) {
        console.error('review existing lookup error:', existingError);
        throw new Error(existingError.message || 'Failed to lookup existing review');
      }

      const payload = {
        order_id: id,
        customer_id: req.userId,
        store_id: storeId || null,
        courier_id: courierId || null,
        rating,
        comment: comment || null,
      };

      if (existing?.id) {
        const { data: updated, error: updateError } = await supabase
          .from('reviews')
          .update(payload)
          .eq('id', existing.id)
          .single();
        if (updateError) {
          console.error('review update error:', updateError);
          throw new Error(updateError.message || 'Failed to update review');
        }
        return updated;
      }

      const { data: inserted, error: insertError } = await supabase
        .from('reviews')
        .insert(payload)
        .single();
      if (insertError) {
        console.error('review insert error:', insertError);
        throw new Error(insertError.message || 'Failed to submit review');
      }
      return inserted;
    };

    const createdReviews = [];
    if (merchantRating != null && order.store_id) {
      createdReviews.push(
        await upsertReview({
          storeId: order.store_id,
          courierId: null,
          rating: merchantRating,
          comment: merchantComment,
        }),
      );
    }
    if (courierRating != null && order.courier_id) {
      createdReviews.push(
        await upsertReview({
          storeId: null,
          courierId: order.courier_id,
          rating: courierRating,
          comment: courierComment,
        }),
      );
    }

    return res.json({ reviews: createdReviews });
  } catch (error) {
    console.error('post /customer/orders/:id/review error:', error);
    return res.status(500).json({
      error: 'Failed to submit review',
      details: error.message || 'Please try again later',
    });
  }
});

// DELETE /orders/:id — customer removes a finished order from their history (DB delete; cascades to order_items, etc.)
app.delete('/orders/:id', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;
    const { data: order, error } = await supabase
      .from('orders')
      .select('id, customer_id, status')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      console.error('delete /orders/:id select error:', error);
      throw new Error(error.message || 'Failed to load order');
    }
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.customer_id !== req.userId) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'You can only delete your own orders',
      });
    }
    const terminal = new Set(['delivered', 'cancelled', 'refunded', 'completed']);
    const statusNorm = String(order.status || '')
      .toLowerCase()
      .replace(/\s+/g, '_');
    if (!terminal.has(statusNorm)) {
      return res.status(400).json({
        error: 'Cannot delete this order',
        details:
          'Only completed orders (delivered, cancelled, or refunded) can be removed from your history.',
      });
    }
    const { error: delError } = await supabase.from('orders').delete().eq('id', id);
    if (delError) {
      console.error('delete /orders/:id error:', delError);
      throw new Error(delError.message || 'Failed to delete order');
    }
    return res.json({ ok: true, id });
  } catch (error) {
    console.error('delete /orders/:id error:', error);
    return res.status(500).json({
      error: 'Failed to delete order',
      details: error.message || 'Please try again later',
    });
  }
});

const COURIER_ACTIVE_STATUSES = ['assigned', 'courier_arrived', 'merchant_confirmed', 'picked_up', 'in_transit', 'delivery_confirmation_pending'];

// GET /courier/orders/active — delivery in progress for this courier (resume after app restart)
app.get('/courier/orders/active', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const me = await getFullUserMe(req.userId);
    if (!me?.roles?.includes('courier')) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'User is not a courier',
      });
    }

    const { data: row, error } = await supabase
      .from('orders')
      .select(
        `
        id,
        order_number,
        total_amount,
        status,
        pickup_address,
        pickup_latitude,
        pickup_longitude,
        delivery_address,
        delivery_latitude,
        delivery_longitude,
        customer_id,
        stores (
          store_name,
          logo,
          city
        )
      `,
      )
      .eq('courier_id', req.userId)
      .in('status', COURIER_ACTIVE_STATUSES)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('get /courier/orders/active error:', error);
      throw new Error(error.message || 'Failed to load active order');
    }

    let customer = null;
    if (row?.customer_id) {
      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('full_name, profile_photo')
        .eq('id', row.customer_id)
        .maybeSingle();
      if (profileError) {
        console.error('get /courier/orders/active customer profile error:', profileError);
        throw new Error(profileError.message || 'Failed to load customer profile');
      }
      if (profile) {
        customer = {
          name: profile.full_name || null,
          profilePhoto: profile.profile_photo || null,
        };
      }
    }

    return res.json({ order: row ? { ...row, customer } : null });
  } catch (error) {
    console.error('get /courier/orders/active error:', error);
    return res.status(500).json({
      error: 'Failed to load active order',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /courier/jobs/open — list ready orders with no courier assigned
app.get('/courier/jobs/open', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    // Ensure user has courier role
    const me = await getFullUserMe(req.userId);
    if (!me?.roles?.includes('courier')) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'User is not a courier',
      });
    }

    const { data: busyRow } = await supabase
      .from('orders')
      .select('id')
      .eq('courier_id', req.userId)
      .in('status', COURIER_ACTIVE_STATUSES)
      .limit(1)
      .maybeSingle();

    if (busyRow?.id) {
      return res.json({ jobs: [], hasActiveJob: true });
    }

    let droppedOrderIds = [];
    const { data: droppedRows, error: droppedRowsError } = await supabase
      .from('order_status_history')
      .select('order_id')
      .eq('status', 'ready')
      .eq('changed_by', req.userId)
      .eq('notes', 'Courier dropped assignment');

    if (droppedRowsError) {
      console.error('get /courier/jobs/open dropped orders query error:', droppedRowsError);
    } else if (Array.isArray(droppedRows)) {
      droppedOrderIds = droppedRows
        .map((row) => row.order_id)
        .filter((orderId) => orderId != null);
    }

    let ordersQuery = supabase
      .from('orders')
      .select(
        `
        id,
        order_number,
        total_amount,
        delivery_fee,
        status,
        pickup_address,
        pickup_latitude,
        pickup_longitude,
        delivery_address,
        delivery_latitude,
        delivery_longitude,
        customer_id,
        stores (
          store_name,
          logo,
          city
        )
      `,
      )
      .eq('status', 'ready')
      .is('courier_id', null)
      .order('created_at', { ascending: true });

    if (droppedOrderIds.length > 0) {
      ordersQuery = ordersQuery.not('id', 'in', `(${droppedOrderIds.join(',')})`);
    }

    const { data, error } = await ordersQuery;

    if (error) {
      console.error('get /courier/jobs/open error:', error);
      throw new Error(error.message || 'Failed to load jobs');
    }

    const customerIds = Array.from(
      new Set((data || []).map((job) => job.customer_id).filter(Boolean)),
    );
    let customerProfiles = [];
    if (customerIds.length > 0) {
      const { data: profiles, error: profilesError } = await supabase
        .from('user_profiles')
        .select('id, full_name, profile_photo')
        .in('id', customerIds);
      if (profilesError) {
        console.error('get /courier/jobs/open customer profiles error:', profilesError);
        throw new Error(profilesError.message || 'Failed to load customer profiles');
      }
      customerProfiles = profiles || [];
    }

    const customerMap = (customerProfiles || []).reduce((acc, profile) => {
      if (profile?.id) {
        acc[profile.id] = profile;
      }
      return acc;
    }, {});

    const jobs = (data || []).map((job) => {
      const profile = customerMap[job.customer_id];
      return {
        ...job,
        customer: profile
          ? {
              name: profile.full_name || null,
              profilePhoto: profile.profile_photo || null,
            }
          : null,
      };
    });

    return res.json({ jobs });
  } catch (error) {
    console.error('get /courier/jobs/open error:', error);
    return res.status(500).json({
      error: 'Failed to load jobs',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /courier/jobs/:id/accept — courier accepts a job
app.post('/courier/jobs/:id/accept', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    // Ensure user has courier role
    const me = await getFullUserMe(req.userId);
    if (!me?.roles?.includes('courier')) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'User is not a courier',
      });
    }

    const { data: existingActive } = await supabase
      .from('orders')
      .select('id')
      .eq('courier_id', req.userId)
      .in('status', COURIER_ACTIVE_STATUSES)
      .limit(1)
      .maybeSingle();

    if (existingActive?.id) {
      return res.status(400).json({
        error: 'Already on a delivery',
        details: 'Finish your current delivery before accepting another job.',
      });
    }

    // Single atomic update: only wins if still ready and unassigned (avoids races with other couriers).
    const { data: updated, error: updateError } = await supabase
      .from('orders')
      .update({ courier_id: req.userId, status: 'assigned' })
      .eq('id', id)
      .eq('status', 'ready')
      .is('courier_id', null)
      .select('id, order_number, status, courier_id, customer_id')
      .maybeSingle();

    if (updateError) {
      console.error('courier accept job update error:', updateError);
      throw new Error(updateError.message || 'Failed to assign courier');
    }
    if (!updated) {
      return res.status(400).json({
        error: 'Job not available',
        details:
          'Order is no longer ready (another courier may have taken it, or the store changed the order status).',
      });
    }

    const { error: historyError } = await supabase.from('order_status_history').insert({
      order_id: updated.id,
      status: 'assigned',
      notes: 'Courier accepted job',
      changed_by: req.userId,
    });
    if (historyError) {
      console.error('order_status_history insert (assigned) error:', historyError);
    }

    const { data: courierProf } = await supabase
      .from('user_profiles')
      .select('full_name')
      .eq('id', req.userId)
      .maybeSingle();

    await notifyCustomerCourierAssigned(supabase, {
      customerId: updated.customer_id,
      orderId: updated.id,
      orderNumber: updated.order_number,
      courierName: courierProf?.full_name,
    });

    const { customer_id: _omitCustomer, ...orderResponse } = updated;
    return res.json({ order: { ...orderResponse, accepted_at: new Date().toISOString() } });
  } catch (error) {
    console.error('post /courier/jobs/:id/accept error:', error);
    return res.status(500).json({
      error: 'Failed to accept job',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /courier/orders/:id/drop — assigned courier drops a job before pickup
app.post('/courier/orders/:id/drop', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    const me = await getFullUserMe(req.userId);
    if (!me?.roles?.includes('courier')) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'User is not a courier',
      });
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, courier_id, status, order_number, customer_id')
      .eq('id', id)
      .maybeSingle();

    if (orderError) {
      console.error('courier drop order error:', orderError);
      throw new Error(orderError.message || 'Failed to load order');
    }
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.courier_id !== req.userId) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'You are not assigned to this order',
      });
    }
    if (order.status !== 'assigned') {
      const postArrival = ['courier_arrived', 'merchant_confirmed', 'picked_up', 'in_transit', 'delivery_confirmation_pending'].includes(order.status);
      return res.status(400).json({
        error: 'Cannot drop job',
        details: postArrival
          ? 'You have already arrived at the pickup location and must complete this delivery.'
          : 'Job can only be dropped before pickup.',
      });
    }

    // Enforce 3-minute drop window from acceptance
    const { data: assignedRow } = await supabase
      .from('order_status_history')
      .select('created_at')
      .eq('order_id', id)
      .eq('status', 'assigned')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (assignedRow?.created_at) {
      const msElapsed = Date.now() - new Date(assignedRow.created_at).getTime();
      if (msElapsed > 3 * 60 * 1000) {
        return res.status(400).json({
          error: 'Cannot drop job',
          details: 'The 3-minute cancellation window has passed. You must complete this delivery.',
        });
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from('orders')
      .update({ courier_id: null, status: 'ready' })
      .eq('id', id)
      .eq('courier_id', req.userId)
      .eq('status', 'assigned')
      .select('id, order_number, status, courier_id, customer_id')
      .maybeSingle();

    if (updateError) {
      console.error('courier drop job update error:', updateError);
      throw new Error(updateError.message || 'Failed to drop job');
    }
    if (!updated) {
      return res.status(400).json({
        error: 'Job not available',
        details: 'Job cannot be dropped at this time.',
      });
    }

    const { error: historyError } = await supabase.from('order_status_history').insert({
      order_id: id,
      status: 'ready',
      notes: 'Courier dropped assignment',
      changed_by: req.userId,
    });
    if (historyError) {
      console.error('order_status_history insert (drop) error:', historyError);
    }

    return res.json({ order: updated });
  } catch (error) {
    console.error('post /courier/orders/:id/drop error:', error);
    return res.status(500).json({
      error: 'Failed to drop job',
      details: error.message || 'Please try again later',
    });
  }
});

// PATCH /courier/orders/:id/location — assigned courier reports GPS (customer live map)
app.patch('/courier/orders/:id/location', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;
    const { latitude, longitude } = req.body || {};

    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({
        error: 'Invalid coordinates',
        details: 'latitude and longitude must be numbers',
      });
    }

    const me = await getFullUserMe(req.userId);
    if (!me?.roles?.includes('courier')) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'User is not a courier',
      });
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, courier_id')
      .eq('id', id)
      .maybeSingle();

    if (orderError) {
      console.error('courier location order error:', orderError);
      throw new Error(orderError.message || 'Failed to load order');
    }
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.courier_id !== req.userId) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'You are not assigned to this order',
      });
    }

    const { data: updated, error: updateError } = await supabase
      .from('orders')
      .update({
        courier_latitude: lat,
        courier_longitude: lng,
        courier_location_updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('id, courier_latitude, courier_longitude, courier_location_updated_at')
      .single();

    if (updateError) {
      console.error('courier location update error:', updateError);
      throw new Error(updateError.message || 'Failed to update location');
    }

    return res.json({ order: updated });
  } catch (error) {
    console.error('patch /courier/orders/:id/location error:', error);
    return res.status(500).json({
      error: 'Failed to update location',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /courier/orders/:id/pickup — mark order picked up / en route (assigned → in_transit)
app.post('/courier/orders/:id/pickup', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    const me = await getFullUserMe(req.userId);
    if (!me?.roles?.includes('courier')) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'User is not a courier',
      });
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, courier_id, status, order_number')
      .eq('id', id)
      .maybeSingle();

    if (orderError) {
      console.error('courier pickup order error:', orderError);
      throw new Error(orderError.message || 'Failed to load order');
    }
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.courier_id !== req.userId) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'You are not assigned to this order',
      });
    }

    if (order.status === 'in_transit' || order.status === 'picked_up') {
      const { data: current } = await supabase
        .from('orders')
        .select('id, status, order_number')
        .eq('id', id)
        .single();
      return res.json({ order: current });
    }

    if (order.status !== 'merchant_confirmed') {
      return res.status(400).json({
        error: 'Cannot pick up',
        details: 'Order must be confirmed by the merchant before pickup',
      });
    }

    const updatePayload = { status: 'in_transit' };
    const { estimated_delivery_time } = req.body || {};
    if (estimated_delivery_time) {
      const parsed = new Date(estimated_delivery_time);
      if (!Number.isNaN(parsed.getTime())) {
        updatePayload.estimated_delivery_time = parsed.toISOString();
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from('orders')
      .update(updatePayload)
      .eq('id', id)
      .select('id, order_number, status, courier_id, estimated_delivery_time')
      .single();

    if (updateError) {
      console.error('courier pickup update error:', updateError);
      throw new Error(updateError.message || 'Failed to update order');
    }

    const { error: historyError } = await supabase.from('order_status_history').insert({
      order_id: id,
      status: 'in_transit',
      notes: 'Courier picked up order',
      changed_by: req.userId,
    });
    if (historyError) {
      console.error('order_status_history insert (in_transit) error:', historyError);
    }

    return res.json({ order: updated });
  } catch (error) {
    console.error('post /courier/orders/:id/pickup error:', error);
    return res.status(500).json({
      error: 'Failed to record pickup',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /courier/orders/:id/complete — mark delivered; credit courier delivery_fee to wallet
app.post('/courier/orders/:id/complete', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    const me = await getFullUserMe(req.userId);
    if (!me?.roles?.includes('courier')) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'User is not a courier',
      });
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select(
        'id, courier_id, status, order_number, delivery_fee, total_amount, payment_status, payment_method'
      )
      .eq('id', id)
      .maybeSingle();

    if (orderError) {
      console.error('courier complete order error:', orderError);
      throw new Error(orderError.message || 'Failed to load order');
    }
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.courier_id !== req.userId) {
      return res.status(403).json({
        error: 'Forbidden',
        details: 'You are not assigned to this order',
      });
    }

    if (order.status === 'cancelled' || order.status === 'refunded') {
      return res.status(400).json({
        error: 'Order not deliverable',
        details: `Order status is ${order.status}`,
      });
    }

    const paidOk =
      order.payment_status === 'paid' || order.payment_method === 'cash';

    if (!paidOk) {
      return res.status(400).json({
        error: 'Payment not settled',
        details: 'Order must be paid before marking delivered (or cash on delivery)',
      });
    }

    const deliveryFee = Number(order.delivery_fee) || 0;

    // If the courier already requested delivery confirmation, return the pending order state.
    if (order.status === 'delivery_confirmation_pending') {
      const { data: pendingOrder, error: pendingError } = await supabase
        .from('orders')
        .select('id, order_number, status, delivery_fee')
        .eq('id', id)
        .single();
      if (pendingError) {
        console.error('courier complete pending order error:', pendingError);
        throw new Error(pendingError.message || 'Failed to load pending order');
      }
      return res.json({ order: pendingOrder });
    }

    const allowedBeforeDelivered = ['picked_up', 'in_transit'];
    if (!allowedBeforeDelivered.includes(order.status)) {
      return res.status(400).json({
        error: 'Cannot complete delivery',
        details: 'Order must be picked up and on the way before confirmation can be requested',
      });
    }

    const { data: pending, error: updateError } = await supabase
      .from('orders')
      .update({
        status: 'delivery_confirmation_pending',
      })
      .eq('id', id)
      .select('id, order_number, status, delivery_fee')
      .single();

    if (updateError) {
      console.error('courier complete update error:', updateError);
      throw new Error(updateError.message || 'Failed to update order');
    }

    const { error: historyError } = await supabase.from('order_status_history').insert({
      order_id: id,
      status: 'delivery_confirmation_pending',
      notes: 'Courier requested delivery confirmation from customer',
      changed_by: req.userId,
    });
    if (historyError) {
      console.error('order_status_history insert (delivery_confirmation_pending) error:', historyError);
    }

    // Notify customer to confirm delivery
    try {
      const { data: customerProfile } = await supabase
        .from('user_profiles')
        .select('push_token')
        .eq('id', order.customer_id)
        .maybeSingle();
      const customerToken = customerProfile?.push_token;
      if (customerToken && customerToken.startsWith('ExponentPushToken')) {
        const orderLabel = order.order_number ? `#${order.order_number}` : 'Your order';
        await axios.post('https://exp.host/push/send', [{
          to: customerToken,
          title: 'Your order has arrived!',
          body: `${orderLabel} has been delivered. Please confirm you received it.`,
          data: { type: 'delivery_confirmation', orderId: id },
          sound: 'default',
        }], { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 10000 });
      }
    } catch (pushErr) {
      console.warn('[Push] Failed to notify customer of delivery confirmation request:', pushErr?.message);
    }

    return res.json({ order: pending });
  } catch (error) {
    console.error('post /courier/orders/:id/complete error:', error);
    return res.status(500).json({
      error: 'Failed to complete delivery',
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

// POST /orders — create a new customer order for a single store
// Body: { items: [{ product_id, product_name, product_price, quantity, unit, weight_kg, subtotal }], store_id, payment_method: 'cash' | 'wallet', delivery_notes? }
app.post('/orders', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const { items, store_id, payment_method, delivery_notes } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: 'Invalid items',
        details: 'Order must contain at least one item',
      });
    }

    if (!store_id) {
      return res.status(400).json({
        error: 'Missing store_id',
        details: 'store_id is required to place an order',
      });
    }

    if (!['cash', 'wallet', 'contipay'].includes(payment_method)) {
      return res.status(400).json({
        error: 'Invalid payment_method',
        details: 'payment_method must be cash, wallet, or contipay',
      });
    }

    // Ensure a customer row exists
    const { data: existingCustomer, error: customerError } = await supabase
      .from('customers')
      .select('id')
      .eq('id', req.userId)
      .maybeSingle();

    if (customerError) {
      console.error('create order ensure customer error:', customerError);
      throw new Error(customerError.message || 'Failed to ensure customer');
    }

    if (!existingCustomer) {
      const { error: insertCustomerError } = await supabase
        .from('customers')
        .insert({ id: req.userId })
        .select('id')
        .single();
      if (insertCustomerError) {
        console.error('create order insert customer error:', insertCustomerError);
        throw new Error(insertCustomerError.message || 'Failed to create customer');
      }
    }

    // Fetch store for pickup address/coordinates + hours / open flag
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select(
        'id, store_name, address_line1, city, latitude, longitude, is_active, is_open, operating_hours, merchant_id',
      )
      .eq('id', store_id)
      .maybeSingle();

    if (storeError) {
      console.error('create order store error:', storeError);
      throw new Error(storeError.message || 'Failed to load store');
    }

    if (!store) {
      return res.status(400).json({
        error: 'Invalid store',
        details: 'Store not found',
      });
    }

    const orderEligibility = assertStoreAcceptingOrders(store);
    if (!orderEligibility.ok) {
      return res.status(orderEligibility.status).json(orderEligibility.body);
    }

    if (
      store.latitude == null ||
      store.longitude == null ||
      !store.address_line1 ||
      !store.city
    ) {
      return res.status(400).json({
        error: 'Store location incomplete',
        details: 'Store must have a full address and coordinates to place an order',
      });
    }

    // Fetch default delivery address for customer
    const { data: addresses, error: addressesError } = await supabase
      .from('customer_addresses')
      .select('id, label, address_line1, city, latitude, longitude, is_default')
      .eq('customer_id', req.userId)
      .order('created_at', { ascending: false });

    if (addressesError) {
      console.error('create order addresses error:', addressesError);
      throw new Error(addressesError.message || 'Failed to load addresses');
    }

    const defAddr =
      (addresses || []).find((a) => a.is_default) || (addresses || [])[0] || null;

    if (
      !defAddr ||
      !defAddr.address_line1 ||
      !defAddr.city ||
      defAddr.latitude == null ||
      defAddr.longitude == null
    ) {
      return res.status(400).json({
        error: 'Missing delivery address',
        details: 'A default saved address with coordinates is required to place an order',
      });
    }

    const deliveryAddress = `${defAddr.address_line1}, ${defAddr.city}`;

    // Compute amounts
    const subtotal = items.reduce(
      (sum, item) => sum + Number(item.subtotal || 0),
      0,
    );
    const distanceKm = haversineKm(
      store.latitude, store.longitude,
      defAddr.latitude, defAddr.longitude,
    );
    const deliveryFee = calculateDeliveryFee(distanceKm);
    const tax = 0;
    const totalAmount = subtotal + deliveryFee + tax;

    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      return res.status(400).json({
        error: 'Invalid total',
        details: 'Order total must be greater than 0',
      });
    }

    // If paying by wallet, ensure sufficient balance and create a debit transaction
    let paymentStatus = 'pending';
    let orderStatus = 'pending';

    if (payment_method === 'contipay') {
      orderStatus = 'awaiting_payment';
      paymentStatus = 'pending';
    } else if (payment_method === 'wallet') {
      const { data: lastTx } = await supabase
        .from('wallet_transactions')
        .select('balance_after')
        .eq('user_id', req.userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const currentBalance = lastTx?.balance_after || 0;
      if (currentBalance < totalAmount) {
        return res.status(400).json({
          error: 'Insufficient wallet balance',
          details: 'Your wallet balance is not enough to pay for this order',
        });
      }

      paymentStatus = 'paid';
    }

    // Generate simple order_number
    const orderNumber = `DOT-${Date.now().toString(36).toUpperCase()}`;

    // Create order + items in a single transaction
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        order_number: orderNumber,
        customer_id: req.userId,
        store_id,
        status: orderStatus,
        subtotal: subtotal,
        delivery_fee: deliveryFee,
        tax,
        total_amount: totalAmount,
        payment_method,
        payment_status: paymentStatus,
        pickup_address: `${store.address_line1}, ${store.city}`,
        pickup_latitude: store.latitude,
        pickup_longitude: store.longitude,
        delivery_address: deliveryAddress,
        delivery_latitude: defAddr.latitude,
        delivery_longitude: defAddr.longitude,
        delivery_notes,
      })
      .select('*')
      .single();

    if (orderError) {
      console.error('create order insert order error:', orderError);
      throw new Error(orderError.message || 'Failed to create order');
    }

    const orderItemsPayload = items.map((item) => ({
      order_id: order.id,
      product_id: item.product_id,
      product_name: item.product_name,
      product_price: item.product_price,
      quantity: item.unit === 'kg' ? 1 : item.quantity,
      unit: item.unit === 'kg' ? 'kg' : 'item',
      weight_kg: item.unit === 'kg' ? item.quantity : null,
      subtotal: item.subtotal,
    }));

    const { error: itemsError } = await supabase
      .from('order_items')
      .insert(orderItemsPayload);

    if (itemsError) {
      console.error('create order insert items error:', itemsError);
      throw new Error(itemsError.message || 'Failed to create order items');
    }

    // If wallet payment, record payment + wallet debit transaction
    if (payment_method === 'wallet') {
      const { data: payment, error: paymentError } = await supabase
        .from('payments')
        .insert({
          order_id: order.id,
          customer_id: req.userId,
          amount: totalAmount,
          currency: 'USD',
          payment_method: 'wallet',
          payment_provider: 'Wallet',
          status: 'completed',
        })
        .select('*')
        .single();

      if (paymentError) {
        console.error('create order insert payment error:', paymentError);
        throw new Error(paymentError.message || 'Failed to create payment');
      }

      const { data: lastTxAfter } = await supabase
        .from('wallet_transactions')
        .select('balance_after')
        .eq('user_id', req.userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const prevBalance = lastTxAfter?.balance_after || 0;
      const newBalance = prevBalance - totalAmount;

      const { error: walletError } = await supabase
        .from('wallet_transactions')
        .insert({
          user_id: req.userId,
          user_type: 'customer',
          transaction_type: 'debit',
          amount: totalAmount,
          balance_after: newBalance,
          description: `Order payment ${orderNumber}`,
          reference_id: payment.id,
          status: 'completed',
        });

      if (walletError) {
        console.error('create order wallet debit error:', walletError);
        throw new Error(walletError.message || 'Failed to record wallet transaction');
      }
    }

    try {
      await notifyCustomerOrderPlaced(supabase, {
        customerId: req.userId,
        orderId: order.id,
        orderNumber: order.order_number,
        storeName: store.store_name,
        awaitingPayment: orderStatus === 'awaiting_payment',
        paymentMethod: payment_method || null,
        totalAmount: totalAmount || null,
      });
    } catch (notifyErr) {
      console.error('notifyCustomerOrderPlaced failed (non-fatal):', notifyErr);
    }

    // Notify the merchant that a new order has arrived
    if (store.merchant_id) {
      try {
        const itemCount = items.length;
        await insertUserNotification(supabase, {
          userId: store.merchant_id,
          title: 'New order received',
          message: `Order ${orderNumber} — ${itemCount} item${itemCount !== 1 ? 's' : ''} — $${totalAmount.toFixed(2)}`,
          type: 'order',
          referenceId: order.id,
          data: { orderId: order.id, orderNumber },
        });
      } catch (merchantNotifyErr) {
        console.error('merchant order notification failed (non-fatal):', merchantNotifyErr);
      }
    }

    return res.status(201).json({ order });
  } catch (error) {
    console.error('post /orders error:', error);
    return res.status(500).json({
      error: 'Failed to place order',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /merchant/dashboard-stats — real-time KPIs, revenue by day, best products, categories (from DB)
app.get('/merchant/dashboard-stats', requireAuth, async (req, res) => {
  try {
    const stats = await getMerchantDashboardStats(req.userId);
    return res.json(stats);
  } catch (error) {
    console.error('get /merchant/dashboard-stats error:', error);
    return res.status(500).json({
      error: 'Failed to load dashboard stats',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /merchant/onboarding-status — check if merchant has fully completed setup
app.get('/merchant/onboarding-status', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    // Merchant core row must exist
    const { data: merchant, error: merchantError } = await supabase
      .from('merchants')
      .select('id, business_name, business_type, is_active, approval_status, rejected_reason')
      .eq('id', req.userId)
      .maybeSingle();

    console.log('[merchant/onboarding-status] Merchant row:', merchant);

    if (merchantError) {
      console.error('merchant status merchant error:', merchantError);
      throw new Error(merchantError.message || 'Failed to load merchant');
    }

    // Allow merchant if is_active is true OR null/undefined (null means not explicitly disabled)
    const isMerchant = !!merchant;
    const approvalStatus = merchant?.approval_status || 'pending';
    const isApproved = approvalStatus === 'approved';
    const isRejected = approvalStatus === 'rejected';
    const rejectedReason = merchant?.rejected_reason || null;

    // At least one store with required address/geo fields
    // Be lenient - check for any store, not just is_active = true
    let hasStore = false;
    if (isMerchant) {
      const { data: stores, error: storesError } = await supabase
        .from('stores')
        .select('id, address_line1, city, latitude, longitude, is_active')
        .eq('merchant_id', req.userId)
        .limit(5);

      console.log('[merchant/onboarding-status] Stores found:', stores);

      if (!storesError && Array.isArray(stores) && stores.length > 0) {
        // Find first store with required fields
        for (const store of stores) {
          if (store.address_line1 && store.city && store.latitude != null && store.longitude != null) {
            hasStore = true;
            break;
          }
        }
      }
    }

    // Required merchant documents: owner_id and proof_of_address must exist
    // For existing merchants, make documents optional to allow them in
    let hasRequiredDocuments = false;
    if (isMerchant) {
      try {
        const { data: docs, error: docsError } = await supabase
          .from('merchant_documents')
          .select('document_type')
          .eq('merchant_id', req.userId);

        if (!docsError && Array.isArray(docs) && docs.length > 0) {
          const types = docs.map((d) => d.document_type);
          hasRequiredDocuments = types.includes('owner_id') && types.includes('proof_of_address');
        }
      } catch (docsErr) {
        console.log('[merchant/onboarding-status] Documents check error, allowing:', docsErr.message);
      }
    }

    // For now, make documents optional - if user has merchant + store, they're considered onboarded
    const onboardingComplete = isMerchant && hasStore;

    return res.json({
      isMerchant,
      hasStore,
      hasRequiredDocuments,
      onboardingComplete,
      approvalStatus,
      isApproved,
      isRejected,
      rejectedReason,
    });
  } catch (error) {
    console.error('get /merchant/onboarding-status error:', error);
    return res.status(500).json({
      error: 'Failed to load merchant onboarding status',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /courier/onboarding-status — check if courier profile is fully set up and verified
app.get('/courier/onboarding-status', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const { data: courier, error: courierError } = await supabase
      .from('couriers')
      .select(
        'id, city, national_id, date_of_birth, drivers_license_number, verification_status',
      )
      .eq('id', req.userId)
      .maybeSingle();

    if (courierError) {
      console.error('courier status courier error:', courierError);
      throw new Error(courierError.message || 'Failed to load courier');
    }

    // Consider profile step complete as soon as a courier row exists.
    // Field-level validation (national_id, dob, city) is enforced at save time.
    const hasProfile = !!courier;

    let hasVehicle = false;
    if (courier) {
      const { data: vehicles, error: vehiclesError } = await supabase
        .from('courier_vehicles')
        .select('id')
        .eq('courier_id', req.userId)
        .eq('is_active', true)
        .limit(1);

      if (vehiclesError) {
        console.error('courier status vehicles error:', vehiclesError);
        throw new Error(vehiclesError.message || 'Failed to load courier vehicles');
      }

      hasVehicle = Array.isArray(vehicles) && vehicles.length > 0;
    }

    const hasDriverLicense =
      !!courier &&
      !!courier.drivers_license_number;

    let hasPayoutMethod = false;
    if (courier) {
      const { data: payoutMethods, error: payoutError } = await supabase
        .from('courier_payout_methods')
        .select('id')
        .eq('courier_id', req.userId)
        .limit(1);

      if (payoutError) {
        console.error('courier status payout error:', payoutError);
        throw new Error(payoutError.message || 'Failed to load payout methods');
      }

      hasPayoutMethod = Array.isArray(payoutMethods) && payoutMethods.length > 0;
    }

    const verificationStatus = courier?.verification_status || 'pending';
    const onboardingComplete =
      hasProfile && hasVehicle && hasDriverLicense && hasPayoutMethod;
    const isApproved = verificationStatus === 'approved';

    return res.json({
      hasProfile,
      hasVehicle,
      hasDriverLicense,
      hasPayoutMethod,
      verificationStatus,
      onboardingComplete,
      isApproved,
    });
  } catch (error) {
    console.error('get /courier/onboarding-status error:', error);
    return res.status(500).json({
      error: 'Failed to load courier onboarding status',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /business-types — get all business types (for business type selection)
app.get('/business-types', async (req, res) => {
  try {
    if (!supabasePublic) throw new Error('Server not configured');

    const { data, error } = await supabasePublic
      .from('business_types')
      .select('id, name, icon, is_custom')
      .order('is_custom', { ascending: true })
      .order('name', { ascending: true });

    if (error) throw new Error(error.message || 'Failed to load business types');

    return res.json({ business_types: data || [] });
  } catch (error) {
    console.error('get /business-types error:', error);
    return res.status(500).json({
      error: 'Failed to load business types',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /business-types — create a new business type (requires auth)
app.post('/business-types', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const { name, icon } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: 'Business type name is required',
      });
    }

    // Check if already exists
    const { data: existing } = await supabase
      .from('business_types')
      .select('id, name, icon')
      .ilike('name', name.trim())
      .maybeSingle();

    if (existing) {
      return res.json({ 
        id: existing.id, 
        name: existing.name, 
        icon: existing.icon,
        is_custom: true 
      });
    }

    // Map business type to an icon
    const iconMap = {
      'restaurant': 'coffee',
      'grocery': 'shopping-cart',
      'pharmacy': 'activity',
      'hardware': 'settings',
      'pet': 'heart',
      'electronics': 'cpu',
      'clothing': 'shopping-bag',
      'beauty': 'smile',
      'furniture': 'home',
      'books': 'book-open',
    };
    
    const nameLower = name.toLowerCase();
    let selectedIcon = icon || 'shopping-bag';
    for (const [key, value] of Object.entries(iconMap)) {
      if (nameLower.includes(key)) {
        selectedIcon = value;
        break;
      }
    }

    const { data, error } = await supabase
      .from('business_types')
      .insert({
        name: name.trim(),
        icon: selectedIcon,
        is_custom: true,
      })
      .select('id, name, icon, is_custom')
      .single();

    if (error) throw new Error(error.message || 'Failed to create business type');

    return res.json(data);
  } catch (error) {
    console.error('post /business-types error:', error);
    return res.status(500).json({
      error: 'Failed to create business type',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /courier/settings — current courier app settings
app.get('/courier/settings', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const { data, error } = await supabase
      .from('courier_settings')
      .select(
        'language, dark_mode, push_notifications, sound, vibration, preferred_map_app, auto_open_maps',
      )
      .eq('courier_id', req.userId)
      .maybeSingle();

    if (error) {
      console.error('get /courier/settings error:', error);
      throw new Error(error.message || 'Failed to load courier settings');
    }

    const settings = data || {};

    return res.json({
      language: settings.language || 'en',
      dark_mode: settings.dark_mode ?? false,
      push_notifications: settings.push_notifications ?? true,
      sound: settings.sound ?? true,
      vibration: settings.vibration ?? true,
      preferred_map_app: settings.preferred_map_app || 'default',
      auto_open_maps: settings.auto_open_maps ?? false,
    });
  } catch (error) {
    console.error('get /courier/settings error:', error);
    return res.status(500).json({
      error: 'Failed to load courier settings',
      details: error.message || 'Please try again later',
    });
  }
});

// PUT /courier/settings — update courier app settings
app.put('/courier/settings', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const {
      language,
      dark_mode,
      push_notifications,
      sound,
      vibration,
      preferred_map_app,
      auto_open_maps,
    } = req.body || {};

    const payload = {
      courier_id: req.userId,
    };

    if (language !== undefined) payload.language = language || 'en';
    if (dark_mode !== undefined) payload.dark_mode = !!dark_mode;
    if (push_notifications !== undefined) payload.push_notifications = !!push_notifications;
    if (sound !== undefined) payload.sound = !!sound;
    if (vibration !== undefined) payload.vibration = !!vibration;
    if (preferred_map_app !== undefined)
      payload.preferred_map_app = preferred_map_app || 'default';
    if (auto_open_maps !== undefined) payload.auto_open_maps = !!auto_open_maps;

    const { data, error } = await supabase
      .from('courier_settings')
      .upsert(payload, { onConflict: 'courier_id' })
      .select(
        'language, dark_mode, push_notifications, sound, vibration, preferred_map_app, auto_open_maps',
      )
      .maybeSingle();

    if (error) {
      console.error('put /courier/settings error:', error);
      throw new Error(error.message || 'Failed to save courier settings');
    }

    const settings = data || {};

    return res.json({
      language: settings.language || 'en',
      dark_mode: settings.dark_mode ?? false,
      push_notifications: settings.push_notifications ?? true,
      sound: settings.sound ?? true,
      vibration: settings.vibration ?? true,
      preferred_map_app: settings.preferred_map_app || 'default',
      auto_open_maps: settings.auto_open_maps ?? false,
    });
  } catch (error) {
    console.error('put /courier/settings error:', error);
    return res.status(500).json({
      error: 'Failed to save courier settings',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /courier/performance — summary metrics for current courier
// Query: ?period=day|week|month (default: day)
app.get('/courier/performance', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const courierId = req.userId;
    const periodParam = String(req.query.period || 'day').toLowerCase();
    const allowedPeriods = ['day', 'week', 'month'];
    const period = allowedPeriods.includes(periodParam) ? periodParam : 'day';

    const [
      { data: courierRow, error: courierError },
      { data: completedOrders, error: ordersError },
      { data: earningsRows, error: earningsError },
    ] = await Promise.all([
      supabase
        .from('couriers')
        .select('total_deliveries, total_earnings, created_at')
        .eq('id', courierId)
        .maybeSingle(),
      supabase
        .from('orders')
        .select('id, total_amount, created_at')
        .eq('courier_id', courierId)
        .eq('status', 'delivered'),
      supabase
        .from('wallet_transactions')
        .select('amount, created_at')
        .eq('user_id', courierId)
        .eq('user_type', 'courier')
        .eq('transaction_type', 'earnings'),
    ]);

    if (courierError) {
      console.error('courier performance courier error:', courierError);
      throw new Error(courierError.message || 'Failed to load courier');
    }
    if (ordersError) {
      console.error('courier performance orders error:', ordersError);
      throw new Error(ordersError.message || 'Failed to load orders');
    }
    if (earningsError) {
      console.error('courier performance earnings error:', earningsError);
      throw new Error(earningsError.message || 'Failed to load earnings');
    }

    const totalDeliveries = courierRow?.total_deliveries ?? (completedOrders?.length || 0);
    const totalEarnings = Number(
      courierRow?.total_earnings ??
        (earningsRows || []).reduce((sum, r) => sum + Number(r.amount || 0), 0),
    );

    // Date range based on period
    const now = new Date();
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);

    if (period === 'week') {
      start.setDate(start.getDate() - 6); // last 7 days including today
    } else if (period === 'month') {
      start.setDate(start.getDate() - 29); // last 30 days including today
    }

    const startIso = start.toISOString();
    const end = new Date(now);
    end.setUTCHours(23, 59, 59, 999);
    const endIso = end.toISOString();

    const { data: periodOrders, error: periodOrdersError } = await supabase
      .from('orders')
      .select('id, total_amount, created_at')
      .eq('courier_id', courierId)
      .eq('status', 'delivered')
      .gte('created_at', startIso)
      .lte('created_at', endIso);

    if (periodOrdersError) {
      console.error('courier performance period orders error:', periodOrdersError);
      throw new Error(periodOrdersError.message || 'Failed to load period orders');
    }

    const periodOrdersCount = periodOrders?.length || 0;
    const periodEarnings = (periodOrders || []).reduce(
      (sum, o) => sum + Number(o.total_amount || 0),
      0,
    );

    const response = {
      period,
      periodEarnings,
      periodOrdersCount,
      totalDeliveries,
      totalEarnings,
      currency: 'USD',
      // Placeholders for now; can be enhanced later with real distance/fees
      mileageKm: null,
      perKmRate: null,
      receivedFares: periodEarnings,
      serviceFeesAndTaxes: 0,
      generatedAt: new Date().toISOString(),
      range: {
        start: startIso,
        end: endIso,
      },
    };

    return res.json(response);
  } catch (error) {
    console.error('get /courier/performance error:', error);
    return res.status(500).json({
      error: 'Failed to load courier performance',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /users/me/notifications — notifications for current user (filter by ?role=customer|merchant|courier)
app.get('/users/me/notifications', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const requestedRole = req.query.role ? String(req.query.role).toLowerCase() : null;

    // Validate role if provided
    const validRoles = ['customer', 'merchant', 'courier'];
    if (requestedRole && !validRoles.includes(requestedRole)) {
      return res.status(400).json({
        error: 'Invalid role',
        details: `Role must be one of: ${validRoles.join(', ')}`
      });
    }

    let query = supabase
      .from('notifications')
      .select('id, title, message, type, reference_id, is_read, created_at')
      .eq('user_id', req.userId);

    // Filter by role if provided (only if role column exists in your table)
    if (requestedRole) {
      query = query.eq('role', requestedRole);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('get notifications error:', error);
      throw new Error(error.message || 'Failed to load notifications');
    }

    return res.json({ notifications: data || [] });
  } catch (error) {
    console.error('get /users/me/notifications error:', error);
    return res.status(500).json({
      error: 'Failed to load notifications',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /users/me/notifications — create a notification for the current user
app.post('/users/me/notifications', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { title, message, type = 'system', referenceId } = req.body || {};

    if (!title || !message) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'title and message are required',
      });
    }

    const allowedTypes = ['order', 'delivery', 'payment', 'system', 'promotion'];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        error: 'Invalid notification type',
        details: `type must be one of: ${allowedTypes.join(', ')}`,
      });
    }

    const insert = {
      user_id: req.userId,
      title: String(title).trim(),
      message: String(message).trim(),
      type,
      reference_id: referenceId || null,
    };

    const { data, error } = await supabase
      .from('notifications')
      .insert(insert)
      .select('id, title, message, type, reference_id, is_read, created_at')
      .single();

    if (error) {
      console.error('create notification error:', error);
      throw new Error(error.message || 'Failed to create notification');
    }

    return res.status(201).json(data);
  } catch (error) {
    console.error('post /users/me/notifications error:', error);
    return res.status(500).json({
      error: 'Failed to create notification',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /users/me/notifications/:id/read — mark a single notification as read
app.post('/users/me/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;

    const { data, error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', req.userId)
      .select('id, title, message, type, reference_id, is_read, created_at')
      .single();

    if (error) {
      console.error('mark notification read error:', error);
      throw new Error(error.message || 'Failed to mark notification as read');
    }

    return res.json(data);
  } catch (error) {
    console.error('post /users/me/notifications/:id/read error:', error);
    return res.status(500).json({
      error: 'Failed to mark notification as read',
      details: error.message || 'Please try again later',
    });
  }
});

// POST /users/me/notifications/read-all — mark all notifications as read
app.post('/users/me/notifications/read-all', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', req.userId)
      .eq('is_read', false);

    if (error) {
      console.error('mark all notifications read error:', error);
      throw new Error(error.message || 'Failed to mark notifications as read');
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('post /users/me/notifications/read-all error:', error);
    return res.status(500).json({
      error: 'Failed to mark notifications as read',
      details: error.message || 'Please try again later',
    });
  }
});

// DELETE /users/me/notifications — clear all notifications for the current user
app.delete('/users/me/notifications', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    const { error } = await supabase
      .from('notifications')
      .delete()
      .eq('user_id', req.userId);

    if (error) {
      console.error('clear notifications error:', error);
      throw new Error(error.message || 'Failed to clear notifications');
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('delete /users/me/notifications error:', error);
    return res.status(500).json({
      error: 'Failed to clear notifications',
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

// POST /payments/contipay/start — initiate a ContiPay payment for an order (auth required)
app.post('/payments/contipay/start', requireAuth, async (req, res) => {
  try {
    const { orderId, amount } = req.body || {};

    if (!orderId) {
      return res.status(400).json({ error: 'Missing orderId' });
    }
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount', details: 'amount must be > 0' });
    }

    // Validate order belongs to user and is awaiting payment
    const { data: ord, error: ordErr } = await supabase
      .from('orders')
      .select('id, customer_id, order_number, status, payment_method, payment_status, total_amount')
      .eq('id', orderId)
      .maybeSingle();

    if (ordErr || !ord) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (ord.customer_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (ord.payment_method !== 'contipay' || ord.status !== 'awaiting_payment') {
      return res.status(400).json({ error: 'Order is not awaiting ContiPay payment' });
    }
    const expected = Number(ord.total_amount);
    if (!Number.isFinite(expected) || Math.abs(expected - Number(amount)) > 0.02) {
      return res.status(400).json({ error: 'Amount mismatch', details: 'amount must match the order total' });
    }

    // Get customer profile for phone/email
    const profile = await getProfile(req.userId);
    const phone = profile?.phone;
    const email = profile?.email || '';

    if (!phone) {
      return res.status(400).json({
        error: 'Phone number required',
        details: 'Add a phone number to your profile so ContiPay can process payment.',
      });
    }

    const apiBase = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
    const callbackUrl = `${apiBase.replace(/\/$/, '')}/payments/contipay/callback`;
    const returnUrl = `${apiBase.replace(/\/$/, '')}/payments/contipay/return?orderId=${encodeURIComponent(orderId)}&status=success`;
    const cancelUrl = `${apiBase.replace(/\/$/, '')}/payments/contipay/return?orderId=${encodeURIComponent(orderId)}&status=cancelled`;
    const reference = `DOT-${ord.order_number || orderId.slice(0, 8)}-${Date.now()}`;

    const result = await initiateContipayPayment({
      userId: req.userId,
      orderId: ord.id,
      amount: Number(amount),
      phone,
      email,
      fullName: profile?.full_name || '',
      reference,
      callbackUrl,
      returnUrl,
      cancelUrl,
    });

    return res.json({ paymentUrl: result.paymentUrl, reference });
  } catch (error) {
    console.error('ContiPay start error:', error);
    console.error('ContiPay start error details:', error.response?.data || error.message);
    return res.status(500).json({
      error: 'Failed to start ContiPay payment',
      details: error.response?.data?.message || error.response?.data?.error || error.message || 'Please try again later',
    });
  }
});

// GET /payments/contipay/return — browser redirect after ContiPay hosted page; forwards to app deep link
app.get('/payments/contipay/return', (req, res) => {
  const scheme = process.env.APP_PAYMENT_DEEP_LINK_SCHEME || 'dotdeliveryontime';
  const q = new URLSearchParams(req.query || {});
  const target = `${scheme}://payment-return?${q.toString()}`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Returning to app</title>
<meta http-equiv="refresh" content="0;url=${target.replace(/"/g, '&quot;')}">
<script>window.location.replace(${JSON.stringify(target)});</script></head>
<body><p>Returning to the app…</p></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
});

// POST /payments/contipay/callback — ContiPay server-to-server result callback (no auth)
app.post('/payments/contipay/callback', async (req, res) => {
  try {
    await handleContipayCallback(req.body);
    return res.json({ ok: true });
  } catch (error) {
    console.error('ContiPay callback error:', error);
    return res.status(500).json({
      error: 'Failed to process ContiPay callback',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /users/me/payment-methods — payment methods saved for the current customer
app.get('/users/me/payment-methods', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');

    // Ensure user has a customer row (multi-role: merchant+customer may have just switched)
    const { error: upsertErr } = await supabase.from('customers').upsert({ id: req.userId }, { onConflict: 'id' });
    if (upsertErr) {
      console.warn('payment-methods: ensure customer row:', upsertErr.message);
    }

    const { data, error } = await supabase
      .from('customer_payment_methods')
      .select('id, type, provider, last_four_digits, expiry_date, phone_country_code, phone_number, is_default, is_active, created_at, updated_at')
      .eq('customer_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('get payment-methods error:', error);
      const detailParts = [
        error.message,
        error.code && `code=${error.code}`,
        error.details,
        error.hint && `hint=${error.hint}`,
      ].filter(Boolean);
      const details = detailParts.length ? detailParts.join(' | ') : 'Database error';
      return res.status(500).json({
        error: 'Failed to load payment methods',
        details,
      });
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

// POST /users/me/favorites — add a favorite store for the current customer
app.post('/users/me/favorites', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { store_id } = req.body || {};

    if (!store_id) {
      return res.status(400).json({
        error: 'Missing required field',
        details: 'store_id is required',
      });
    }

    // Ensure a customer row exists for this user (mirrors other customer features)
    const { data: customerExisting, error: customerError } = await supabase
      .from('customers')
      .select('id')
      .eq('id', req.userId)
      .maybeSingle();

    if (customerError) {
      console.error('favorites ensure customer error:', customerError);
      throw new Error(customerError.message || 'Failed to ensure customer');
    }

    if (!customerExisting) {
      const { error: insertCustomerError } = await supabase
        .from('customers')
        .insert({ id: req.userId })
        .select('id')
        .single();
      if (insertCustomerError) {
        console.error('favorites create customer error:', insertCustomerError);
        throw new Error(insertCustomerError.message || 'Failed to create customer');
      }
    }

    const { data, error } = await supabase
      .from('customer_favorites')
      .insert({
        customer_id: req.userId,
        store_id,
      })
      .select('id, store_id, created_at')
      .single();

    if (error) {
      // Ignore unique-constraint duplicate: treat as success
      const isUniqueViolation =
        error.code === '23505' || (error.message || '').toLowerCase().includes('unique');
      if (isUniqueViolation) {
        return res.status(200).json({
          id: null,
          store_id,
          created_at: new Date().toISOString(),
          already_exists: true,
        });
      }

      console.error('create favorite error:', error);
      throw new Error(error.message || 'Failed to create favorite');
    }

    return res.status(201).json(data);
  } catch (error) {
    console.error('post /users/me/favorites error:', error);
    return res.status(500).json({
      error: 'Failed to create favorite',
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
    if (profilePhotoUrl) {
      try {
        await recordCourierProfilePhotoDocument(req.userId, profilePhotoUrl);
      } catch (e) {
        console.error('courier profile photo document sync:', e?.message || e);
      }
    }
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

app.get('/admin/stats/charts', requireAdmin, async (req, res) => {
  try {
    const charts = await getAdminStatsCharts();
    return res.json(charts);
  } catch (error) {
    console.error('admin/stats/charts error:', error);
    return res.status(500).json({ error: 'Failed to load chart data', details: error.message || 'Try again later' });
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

// DELETE /admin/users/:id — permanently delete a user (auth + profile)
app.delete('/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'User ID required' });
    await deleteUserById(id);
    return res.json({ success: true, message: 'User deleted' });
  } catch (error) {
    console.error('admin delete user error:', error);
    return res.status(500).json({ error: 'Failed to delete user', details: error.message || 'Try again later' });
  }
});

// PATCH /admin/users/:id/suspend — suspend or unsuspend a user
app.patch('/admin/users/:id/suspend', requireAdmin, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;
    const { suspend } = req.body;
    if (!id) return res.status(400).json({ error: 'User ID required' });
    const { error } = await supabase
      .from('user_profiles')
      .update({ is_suspended: !!suspend })
      .eq('id', id);
    if (error) throw error;
    return res.json({ success: true, is_suspended: !!suspend });
  } catch (error) {
    console.error('admin suspend user error:', error);
    return res.status(500).json({ error: 'Failed to update user', details: error.message || 'Try again later' });
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

// PATCH /admin/merchants/:id — set merchant is_verified (admin only)
app.patch('/admin/merchants/:id', requireAdmin, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const { id } = req.params;
    const { is_verified } = req.body || {};
    if (typeof is_verified !== 'boolean') {
      return res.status(400).json({ error: 'Bad request', details: 'Body must include is_verified (boolean)' });
    }
    const { data, error } = await supabase
      .from('merchants')
      .update({ is_verified })
      .eq('id', id)
      .select('id, business_name, is_verified')
      .maybeSingle();
    if (error) throw new Error(error.message || 'Failed to update merchant');
    if (!data) return res.status(404).json({ error: 'Merchant not found' });
    return res.json(data);
  } catch (error) {
    console.error('PATCH admin/merchants error:', error);
    return res.status(500).json({ error: error.message || 'Failed to update merchant' });
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

app.get('/admin/documents/pending', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const { documents, total } = await getAdminPendingDocuments({ limit, offset });
    return res.json({ documents, total });
  } catch (error) {
    console.error('admin/documents/pending error:', error);
    return res
      .status(500)
      .json({ error: 'Failed to load pending documents', details: error.message || 'Try again later' });
  }
});

// "Approve Users" tab helpers
// List all pending couriers and merchants
app.get('/admin/users/pending', requireAdmin, async (req, res) => {
  try {
    const result = await getAdminPendingUsers();
    return res.json(result);
  } catch (error) {
    console.error('admin/users/pending error:', error);
    return res.status(500).json({ error: 'Failed to load pending users', details: error.message || 'Try again later' });
  }
});

// Approve a courier by ID (marks verified + approves their pending documents)
app.post('/admin/couriers/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const courier = await approveCourier(id);
    return res.json({ courier });
  } catch (error) {
    console.error('admin/couriers/:id/approve error:', error);
    return res.status(500).json({ error: 'Failed to approve courier', details: error.message || 'Try again later' });
  }
});

// Approve a merchant by ID (marks verified + active)
app.post('/admin/merchants/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const merchant = await approveMerchant(id);
    return res.json({ merchant });
  } catch (error) {
    console.error('admin/merchants/:id/approve error:', error);
    return res.status(500).json({ error: 'Failed to approve merchant', details: error.message || 'Try again later' });
  }
});

// Reject a merchant by ID
app.post('/admin/merchants/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    const merchant = await rejectMerchant(id, reason);
    return res.json({ merchant });
  } catch (error) {
    console.error('admin/merchants/:id/reject error:', error);
    return res.status(500).json({ error: 'Failed to reject merchant', details: error.message || 'Try again later' });
  }
});

// Reject a courier by ID
app.post('/admin/couriers/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    const courier = await rejectCourier(id, reason);
    return res.json({ courier });
  } catch (error) {
    console.error('admin/couriers/:id/reject error:', error);
    return res.status(500).json({ error: 'Failed to reject courier', details: error.message || 'Try again later' });
  }
});

// Detailed view of a single courier (profile + vehicles + documents)
app.get('/admin/couriers/:id/detail', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const detail = await getAdminCourierDetail(id);
    return res.json(detail);
  } catch (error) {
    console.error('admin/couriers/:id/detail error:', error);
    return res.status(500).json({ error: 'Failed to load courier', details: error.message || 'Try again later' });
  }
});

// Detailed view of a single merchant (profile + stores + documents)
app.get('/admin/merchants/:id/detail', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const detail = await getAdminMerchantDetail(id);
    return res.json(detail);
  } catch (error) {
    console.error('admin/merchants/:id/detail error:', error);
    return res.status(500).json({ error: 'Failed to load merchant', details: error.message || 'Try again later' });
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

// Run scheduled promotions: activate promotions whose recurrence matches current UTC time (weekly/monthly).
async function runScheduledPromotions() {
  if (!supabase) return;
  const now = new Date();
  const utcDow = now.getUTCDay(); // 0=Sun .. 6=Sat
  const utcDom = now.getUTCDate(); // 1-31
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  const { data: weekly } = await supabase
    .from('promotions')
    .select('id')
    .eq('recurrence_type', 'weekly')
    .eq('recurrence_weekday', utcDow)
    .eq('recurrence_time', timeStr);
  const { data: monthly } = await supabase
    .from('promotions')
    .select('id')
    .eq('recurrence_type', 'monthly')
    .eq('recurrence_month_day', utcDom)
    .eq('recurrence_time', timeStr);

  const ids = [...(weekly || []), ...(monthly || [])].map((r) => r.id);
  if (ids.length === 0) return;
  const { error } = await supabase.from('promotions').update({ is_active: true }).in('id', ids);
  if (error) console.error('runScheduledPromotions error:', error);
  else if (ids.length) console.log('[Cron] Activated recurring promotions:', ids.length);
}

// ─── Google Maps proxy endpoints ─────────────────────────────────────────────
// These proxy requests to the Google Maps APIs so the API key stays on the server.

// GET /maps/places/autocomplete?input=...&components=...&types=...
app.get('/maps/places/autocomplete', async (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(503).json({ status: 'REQUEST_DENIED', error_message: 'Google Maps API key not configured on server.' });
  try {
    const params = new URLSearchParams({
      key: apiKey,
      input: req.query.input || '',
      ...(req.query.components ? { components: req.query.components } : {}),
      ...(req.query.types ? { types: req.query.types } : {}),
      ...(req.query.location ? { location: req.query.location } : {}),
      ...(req.query.radius ? { radius: req.query.radius } : {}),
    });
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`;
    const r = await axios.get(url, { timeout: 8000 });
    return res.json(r.data);
  } catch (err) {
    console.error('GET /maps/places/autocomplete error:', err.message);
    return res.status(502).json({ status: 'UNKNOWN_ERROR', error_message: err.message });
  }
});

// GET /maps/places/details?place_id=...&fields=...
app.get('/maps/places/details', async (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(503).json({ status: 'REQUEST_DENIED', error_message: 'Google Maps API key not configured on server.' });
  if (!req.query.place_id) return res.status(400).json({ status: 'INVALID_REQUEST', error_message: 'place_id is required.' });
  try {
    const params = new URLSearchParams({
      key: apiKey,
      place_id: req.query.place_id,
      ...(req.query.fields ? { fields: req.query.fields } : {}),
    });
    const url = `https://maps.googleapis.com/maps/api/place/details/json?${params}`;
    const r = await axios.get(url, { timeout: 8000 });
    return res.json(r.data);
  } catch (err) {
    console.error('GET /maps/places/details error:', err.message);
    return res.status(502).json({ status: 'UNKNOWN_ERROR', error_message: err.message });
  }
});

// GET /maps/geocode?latlng=lat,lng  (reverse geocoding — Android only; iOS uses native)
app.get('/maps/geocode', async (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(503).json({ status: 'REQUEST_DENIED', error_message: 'Google Maps API key not configured on server.' });
  if (!req.query.latlng) return res.status(400).json({ status: 'INVALID_REQUEST', error_message: 'latlng is required.' });
  try {
    const params = new URLSearchParams({
      key: apiKey,
      latlng: req.query.latlng,
    });
    const url = `https://maps.googleapis.com/maps/api/geocode/json?${params}`;
    const r = await axios.get(url, { timeout: 8000 });
    return res.json(r.data);
  } catch (err) {
    console.error('GET /maps/geocode error:', err.message);
    return res.status(502).json({ status: 'UNKNOWN_ERROR', error_message: err.message });
  }
});

app.listen(PORT, () => {
  console.log('✅ DOT Backend API started successfully');
  console.log(`📍 Server: http://localhost:${PORT}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log('[ENV CHECK] ContiPay vars present at startup:', {
    CONTIPAY_API_KEY:          !!process.env.CONTIPAY_API_KEY,
    CONTIPAY_API_SECRET:       !!process.env.CONTIPAY_API_SECRET,
    CONTIPAY_AUTH_KEY:         !!process.env.CONTIPAY_AUTH_KEY,
    CONTIPAY_AUTH_SECRET:      !!process.env.CONTIPAY_AUTH_SECRET,
    CONTIPAY_MERCHANT_ID:      !!process.env.CONTIPAY_MERCHANT_ID,
    CONTIPAY_ENV:              process.env.CONTIPAY_ENV || '(not set, defaults to DEV)',
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  console.log(`🔒 CORS allowed origins:`, allowedOrigins);
  runScheduledPromotions();
  setInterval(runScheduledPromotions, 15 * 60 * 1000);
});
