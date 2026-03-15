import 'dotenv/config.js';
import express from 'express';
import cors from 'cors';
import { sendOtpToPhone, verifyPhoneOtp, loginWithPassword, checkPhoneRegistered, deleteUserById } from './authService.js';
import { ensureUserProfile, getProfile, updateProfile, uploadProfilePhoto } from './userService.js';
import { getOrdersForUser, getWalletTransactionsForUser, getPaymentsForUser, getFullUserMe, getMerchantDashboardStats } from './historyService.js';
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
  getAdminStatsCharts,
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
          banner_url,
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

    const { name, description, price, is_available, is_featured, image_url, category_id, unit } = req.body || {};

    const update = {};
    if (name !== undefined) update.name = String(name).trim();
    if (description !== undefined) update.description = description ? String(description).trim() : null;
    if (price !== undefined && price !== null && price !== '') {
      update.price = Number(price);
    }
    if (is_available !== undefined) update.is_available = !!is_available;
    if (is_featured !== undefined) update.is_featured = !!is_featured;
    if (image_url !== undefined) update.image_url = image_url ? String(image_url).trim() : null;
    if (category_id !== undefined) update.category_id = category_id || null;
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
    const fullSelect = 'id, store_name, logo, banner_url, description, phone, email, address_line1, address_line2, city, state_province, postal_code, country, latitude, longitude, is_open';
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
    const { store_id, name, description, price, category_id, unit, image_url, is_available, is_featured } = req.body || {};
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
    if (category_id) insert.category_id = category_id;
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
      .select('id, store_id')
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
    const { data: updated, error: updateError } = await supabase
      .from('orders')
      .update({ status })
      .eq('id', id)
      .select('id, order_number, status')
      .single();
    if (updateError) throw new Error(updateError.message || 'Failed to update order');
    return res.json(updated);
  } catch (error) {
    console.error('patch /orders/:id error:', error);
    return res.status(500).json({
      error: 'Failed to update order',
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

    // Merchant core row must exist and be active
    const { data: merchant, error: merchantError } = await supabase
      .from('merchants')
      .select('id, business_name, business_type, is_active')
      .eq('id', req.userId)
      .maybeSingle();

    if (merchantError) {
      console.error('merchant status merchant error:', merchantError);
      throw new Error(merchantError.message || 'Failed to load merchant');
    }

    const isMerchant = !!merchant && merchant.is_active !== false;

    // At least one active store with required address/geo fields
    let hasStore = false;
    if (isMerchant) {
      const { data: stores, error: storesError } = await supabase
        .from('stores')
        .select('id, address_line1, city, latitude, longitude, is_active')
        .eq('merchant_id', req.userId)
        .eq('is_active', true)
        .limit(1);

      if (storesError) {
        console.error('merchant status stores error:', storesError);
        throw new Error(storesError.message || 'Failed to load stores for merchant');
      }

      hasStore =
        Array.isArray(stores) &&
        stores.length > 0 &&
        !!stores[0].address_line1 &&
        !!stores[0].city &&
        stores[0].latitude != null &&
        stores[0].longitude != null;
    }

    // Required merchant documents: owner_id and proof_of_address must exist
    let hasRequiredDocuments = false;
    if (isMerchant) {
      const { data: docs, error: docsError } = await supabase
        .from('merchant_documents')
        .select('document_type')
        .eq('merchant_id', req.userId);

      if (docsError) {
        console.error('merchant status documents error:', docsError);
        throw new Error(docsError.message || 'Failed to load merchant documents');
      }

      const types = Array.isArray(docs) ? docs.map((d) => d.document_type) : [];
      const hasOwnerId = types.includes('owner_id');
      const hasProofOfAddress = types.includes('proof_of_address');

      hasRequiredDocuments = hasOwnerId && hasProofOfAddress;
    }

    const onboardingComplete = isMerchant && hasStore && hasRequiredDocuments;

    return res.json({
      isMerchant,
      hasStore,
      hasRequiredDocuments,
      onboardingComplete,
    });
  } catch (error) {
    console.error('get /merchant/onboarding-status error:', error);
    return res.status(500).json({
      error: 'Failed to load merchant onboarding status',
      details: error.message || 'Please try again later',
    });
  }
});

// GET /users/me/notifications — notifications for current user
app.get('/users/me/notifications', requireAuth, async (req, res) => {
  try {
    if (!supabase) throw new Error('Server not configured');
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;

    const { data, error } = await supabase
      .from('notifications')
      .select('id, title, message, type, reference_id, is_read, created_at')
      .eq('user_id', req.userId)
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
      return res.status(500).json({
        error: 'Failed to load payment methods',
        details: error.message || 'Database error',
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

app.listen(PORT, () => {
  console.log('✅ DOT Backend API started successfully');
  console.log(`📍 Server: http://localhost:${PORT}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log(`🔒 CORS allowed origins:`, allowedOrigins);
  runScheduledPromotions();
  setInterval(runScheduledPromotions, 15 * 60 * 1000);
});
