-- ============================================
-- DOT Delivery App - Supabase Database Schema
-- ============================================
-- User data: user_profiles (core) + customers/merchants/couriers (role-specific).
-- History: orders, order_items, order_status_history; delivery_tracking; reviews.
-- Payments: payments (per-order), wallet_transactions (balance ledger for all roles).
-- Run this schema in Supabase SQL Editor to create/migrate tables.

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- USER PROFILES & ROLES
-- ============================================

-- User Profiles (extends Supabase Auth)
-- email nullable for phone-only auth; role must match one of customer/merchant/courier
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  full_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('customer', 'merchant', 'courier')),
  profile_photo TEXT,
  is_suspended BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
-- If table already existed with email NOT NULL, run: ALTER TABLE user_profiles ALTER COLUMN email DROP NOT NULL;
-- Add suspension support (run if table already exists): ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT FALSE;

-- ============================================
-- CUSTOMERS
-- ============================================

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY REFERENCES user_profiles(id) ON DELETE CASCADE,
  date_of_birth DATE,
  preferred_language TEXT DEFAULT 'en',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Customer Addresses
CREATE TABLE IF NOT EXISTS customer_addresses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label TEXT NOT NULL, -- e.g., "Home", "Work"
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city TEXT NOT NULL,
  state_province TEXT,
  postal_code TEXT,
  country TEXT DEFAULT 'Zimbabwe',
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_payment_methods (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('card', 'mobile_money', 'cash')),
  provider TEXT, -- e.g., "Visa", "EcoCash", "OneMoney"
  last_four_digits TEXT,
  expiry_date TEXT,
  phone_country_code TEXT, -- e.g. "+263"
  phone_number TEXT, -- full MSISDN or local format
  is_default BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- MERCHANTS
-- ============================================

CREATE TABLE IF NOT EXISTS merchants (
  id UUID PRIMARY KEY REFERENCES user_profiles(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  business_type TEXT, -- e.g., "Restaurant", "Pharmacy", "Grocery"
  business_registration_number TEXT,
  tax_id TEXT,
  is_verified BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Stores
CREATE TABLE IF NOT EXISTS stores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  store_name TEXT NOT NULL,
  logo TEXT,
  banner_url TEXT,
  description TEXT,
  phone TEXT,
  email TEXT,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city TEXT NOT NULL,
  state_province TEXT,
  postal_code TEXT,
  country TEXT DEFAULT 'Zimbabwe',
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  operating_hours JSONB, -- Store hours for each day
  is_open BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE,
  rating DECIMAL(3, 2) DEFAULT 0.00,
  total_reviews INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Store Images
CREATE TABLE IF NOT EXISTS store_images (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Customer Favorites (created after stores table)
CREATE TABLE IF NOT EXISTS customer_favorites (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(customer_id, store_id)
);

-- Product Categories
CREATE TABLE IF NOT EXISTS product_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Products/Menu Items
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  category_id UUID REFERENCES product_categories(id) ON DELETE SET NULL,
  category TEXT, -- Category name stored on product (e.g. "Burgers", "Drinks")
  name TEXT NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  unit TEXT DEFAULT 'item' CHECK (unit IN ('item', 'kg')),
  price_per_kg DECIMAL(10, 2), -- For items sold by weight
  image_url TEXT,
  is_available BOOLEAN DEFAULT TRUE,
  is_featured BOOLEAN DEFAULT FALSE,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Store Promotions / Deals
CREATE TABLE IF NOT EXISTS promotions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  tag TEXT,
  category TEXT, -- Optional: category name this promotion applies to (e.g. \"Burgers\")
  image_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  starts_at TIMESTAMP WITH TIME ZONE,
  ends_at TIMESTAMP WITH TIME ZONE,
  -- Auto-post on a set day every week or month (saved in DB; cron activates at recurrence_time)
  recurrence_type TEXT DEFAULT 'once' CHECK (recurrence_type IN ('once', 'weekly', 'monthly')),
  recurrence_weekday SMALLINT CHECK (recurrence_weekday IS NULL OR (recurrence_weekday >= 0 AND recurrence_weekday <= 6)), -- 0=Sunday .. 6=Saturday
  recurrence_month_day SMALLINT CHECK (recurrence_month_day IS NULL OR (recurrence_month_day >= 1 AND recurrence_month_day <= 31)),
  recurrence_time TEXT, -- HH:MM 24h, e.g. '09:00'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Merchant Settings
CREATE TABLE IF NOT EXISTS merchant_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE UNIQUE,
  new_order_sound BOOLEAN DEFAULT TRUE,
  vibration_alerts BOOLEAN DEFAULT TRUE,
  auto_accept_orders BOOLEAN DEFAULT FALSE,
  default_prep_time INTEGER DEFAULT 15, -- minutes
  rider_arrived_notification BOOLEAN DEFAULT TRUE,
  customer_messages_notification BOOLEAN DEFAULT TRUE,
  promotions_notification BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Support tickets (help requests from app)
CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  role_context TEXT NOT NULL DEFAULT 'merchant',
  category TEXT,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'pending', 'in_progress', 'resolved', 'closed')
  ),
  reference_code TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id ON support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at ON support_tickets(created_at DESC);

-- ============================================
-- COURIERS/RIDERS
-- ============================================

CREATE TABLE IF NOT EXISTS couriers (
  id UUID PRIMARY KEY REFERENCES user_profiles(id) ON DELETE CASCADE,
  national_id TEXT UNIQUE,
  date_of_birth DATE,
  city TEXT,
  drivers_license_number TEXT,
  drivers_license_expiry DATE,
  is_online BOOLEAN DEFAULT FALSE,
  is_verified BOOLEAN DEFAULT FALSE,
  verification_status TEXT DEFAULT 'pending' CHECK (verification_status IN ('pending', 'approved', 'rejected')),
  rating DECIMAL(3, 2) DEFAULT 0.00,
  total_deliveries INTEGER DEFAULT 0,
  total_earnings DECIMAL(10, 2) DEFAULT 0.00,
  account_balance DECIMAL(10, 2) DEFAULT 0.00,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Merchant Documents (for merchant onboarding verification)
CREATE TABLE IF NOT EXISTS merchant_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('owner_id', 'business_certificate', 'proof_of_address')),
  document_url TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  verified_at TIMESTAMP WITH TIME ZONE,
  verified_by UUID REFERENCES user_profiles(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Courier Vehicles
CREATE TABLE IF NOT EXISTS courier_vehicles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  courier_id UUID NOT NULL REFERENCES couriers(id) ON DELETE CASCADE,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('bike', 'car', 'motorcycle')),
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER,
  color TEXT,
  license_plate TEXT NOT NULL UNIQUE,
  registration_certificate_url TEXT,
  vehicle_photo_url TEXT,
  delivery_bag_available BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Courier Documents
CREATE TABLE IF NOT EXISTS courier_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  courier_id UUID NOT NULL REFERENCES couriers(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('id_drivers_license', 'vehicle_registration', 'insurance', 'profile_photo')),
  document_url TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  verified_at TIMESTAMP WITH TIME ZONE,
  verified_by UUID REFERENCES user_profiles(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Courier Payout Methods
CREATE TABLE IF NOT EXISTS courier_payout_methods (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  courier_id UUID NOT NULL REFERENCES couriers(id) ON DELETE CASCADE,
  method_type TEXT NOT NULL CHECK (method_type IN ('mobile_money', 'bank_account')),
  provider TEXT NOT NULL, -- e.g., "EcoCash", "NEDBANK"
  account_number TEXT NOT NULL,
  account_name TEXT,
  is_default BOOLEAN DEFAULT FALSE,
  is_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Courier Settings
CREATE TABLE IF NOT EXISTS courier_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  courier_id UUID NOT NULL REFERENCES couriers(id) ON DELETE CASCADE UNIQUE,
  language TEXT DEFAULT 'en',
  dark_mode BOOLEAN DEFAULT FALSE,
  push_notifications BOOLEAN DEFAULT TRUE,
  sound BOOLEAN DEFAULT TRUE,
  vibration BOOLEAN DEFAULT TRUE,
  preferred_map_app TEXT DEFAULT 'default',
  auto_open_maps BOOLEAN DEFAULT FALSE,
  biometric_login BOOLEAN DEFAULT FALSE,
  sms_updates BOOLEAN DEFAULT FALSE,
  email_updates BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- ORDERS
-- ============================================

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_number TEXT UNIQUE NOT NULL,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  courier_id UUID REFERENCES couriers(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'confirmed',
    'preparing',
    'ready',
    'assigned',
    'merchant_confirmed',
    'picked_up',
    'in_transit',
    'delivery_confirmation_pending',
    'delivered',
    'cancelled',
    'refunded'
  )),
  subtotal DECIMAL(10, 2) NOT NULL,
  delivery_fee DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  tax DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  total_amount DECIMAL(10, 2) NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('card', 'mobile_money', 'cash')),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
  pickup_address TEXT NOT NULL,
  pickup_latitude DECIMAL(10, 8) NOT NULL,
  pickup_longitude DECIMAL(11, 8) NOT NULL,
  delivery_address TEXT NOT NULL,
  delivery_latitude DECIMAL(10, 8) NOT NULL,
  delivery_longitude DECIMAL(11, 8) NOT NULL,
  estimated_prep_time INTEGER, -- minutes
  estimated_delivery_time TIMESTAMP WITH TIME ZONE,
  actual_delivery_time TIMESTAMP WITH TIME ZONE,
  pickup_notes TEXT,
  delivery_notes TEXT,
  qr_code TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Order Items
CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL, -- Snapshot of product name at time of order
  product_price DECIMAL(10, 2) NOT NULL, -- Snapshot of price at time of order
  quantity INTEGER NOT NULL DEFAULT 1,
  unit TEXT DEFAULT 'item' CHECK (unit IN ('item', 'kg')),
  weight_kg DECIMAL(5, 2), -- For items sold by weight
  subtotal DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Order Status History
CREATE TABLE IF NOT EXISTS order_status_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  notes TEXT,
  changed_by UUID REFERENCES user_profiles(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- PAYMENTS & TRANSACTIONS
-- ============================================

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount DECIMAL(10, 2) NOT NULL,
  currency TEXT DEFAULT 'USD',
  payment_method TEXT NOT NULL,
  payment_provider TEXT, -- e.g., "Stripe", "EcoCash", "Twilio"
  transaction_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Wallet Transactions
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  user_type TEXT NOT NULL CHECK (user_type IN ('customer', 'courier', 'merchant')),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('deposit', 'withdrawal', 'payment', 'refund', 'payout', 'earnings')),
  amount DECIMAL(10, 2) NOT NULL,
  balance_after DECIMAL(10, 2) NOT NULL,
  description TEXT,
  reference_id UUID, -- Reference to order, payment, etc.
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- DELIVERIES & TRACKING
-- ============================================

CREATE TABLE IF NOT EXISTS delivery_tracking (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  courier_id UUID NOT NULL REFERENCES couriers(id) ON DELETE CASCADE,
  current_latitude DECIMAL(10, 8),
  current_longitude DECIMAL(11, 8),
  status TEXT NOT NULL,
  estimated_arrival TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- REVIEWS & RATINGS
-- ============================================

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
  courier_id UUID REFERENCES couriers(id) ON DELETE SET NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- NOTIFICATIONS
-- ============================================

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('order', 'delivery', 'payment', 'system', 'promotion')),
  reference_id UUID, -- Reference to order, payment, etc.
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================

-- User Profiles
CREATE INDEX IF NOT EXISTS idx_user_profiles_role ON user_profiles(role);
CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles(email);
CREATE INDEX IF NOT EXISTS idx_user_profiles_phone ON user_profiles(phone);

-- Customers
CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer_id ON customer_addresses(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_payment_methods_customer_id ON customer_payment_methods(customer_id);

-- Stores
CREATE INDEX IF NOT EXISTS idx_stores_merchant_id ON stores(merchant_id);
CREATE INDEX IF NOT EXISTS idx_stores_location ON stores(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_stores_is_active ON stores(is_active);

-- Products
CREATE INDEX IF NOT EXISTS idx_products_store_id ON products(store_id);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(store_id, category);
CREATE INDEX IF NOT EXISTS idx_products_is_available ON products(is_available);

-- Orders
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_store_id ON orders(store_id);
CREATE INDEX IF NOT EXISTS idx_orders_courier_id ON orders(courier_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number);

-- Order Items
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

-- Couriers
CREATE INDEX IF NOT EXISTS idx_couriers_is_online ON couriers(is_online);
CREATE INDEX IF NOT EXISTS idx_couriers_verification_status ON couriers(verification_status);

-- Payments
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_customer_id ON payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- Wallet Transactions
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_id ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_at ON wallet_transactions(created_at DESC);

-- Notifications
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);

-- Promotions
CREATE INDEX IF NOT EXISTS idx_promotions_store_id ON promotions(store_id);
CREATE INDEX IF NOT EXISTS idx_promotions_is_active ON promotions(is_active);
CREATE INDEX IF NOT EXISTS idx_promotions_time ON promotions(starts_at, ends_at);

-- ============================================
-- FUNCTIONS & TRIGGERS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at triggers to relevant tables (DROP IF EXISTS so schema is re-runnable)
DROP TRIGGER IF EXISTS update_user_profiles_updated_at ON user_profiles;
CREATE TRIGGER update_user_profiles_updated_at BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_customers_updated_at ON customers;
CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_merchants_updated_at ON merchants;
CREATE TRIGGER update_merchants_updated_at BEFORE UPDATE ON merchants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_stores_updated_at ON stores;
CREATE TRIGGER update_stores_updated_at BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_products_updated_at ON products;
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_couriers_updated_at ON couriers;
CREATE TRIGGER update_couriers_updated_at BEFORE UPDATE ON couriers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_orders_updated_at ON orders;
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to generate order number
CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS TEXT AS $$
DECLARE
  new_order_number TEXT;
BEGIN
  new_order_number := 'CON' || LPAD(CAST((EXTRACT(EPOCH FROM NOW())::BIGINT % 1000000) AS TEXT), 6, '0');
  RETURN new_order_number;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-generate order number
CREATE OR REPLACE FUNCTION set_order_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.order_number IS NULL OR NEW.order_number = '' THEN
    NEW.order_number := generate_order_number();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_order_number_trigger ON orders;
CREATE TRIGGER set_order_number_trigger BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION set_order_number();

-- Function to update store rating when review is added
CREATE OR REPLACE FUNCTION update_store_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE stores
  SET 
    rating = (
      SELECT AVG(rating)::DECIMAL(3, 2)
      FROM reviews
      WHERE store_id = NEW.store_id AND rating IS NOT NULL
    ),
    total_reviews = (
      SELECT COUNT(*)
      FROM reviews
      WHERE store_id = NEW.store_id
    )
  WHERE id = NEW.store_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_store_rating_trigger ON reviews;
CREATE TRIGGER update_store_rating_trigger AFTER INSERT OR UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION update_store_rating();

-- Function to update courier rating
CREATE OR REPLACE FUNCTION update_courier_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE couriers
  SET 
    rating = (
      SELECT AVG(rating)::DECIMAL(3, 2)
      FROM reviews
      WHERE courier_id = NEW.courier_id AND rating IS NOT NULL
    )
  WHERE id = NEW.courier_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_courier_rating_trigger ON reviews;
CREATE TRIGGER update_courier_rating_trigger AFTER INSERT OR UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION update_courier_rating();

-- Function to log order status changes
CREATE OR REPLACE FUNCTION log_order_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO order_status_history (order_id, status, changed_by)
    VALUES (NEW.id, NEW.status, NEW.courier_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS log_order_status_change_trigger ON orders;
CREATE TRIGGER log_order_status_change_trigger AFTER UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION log_order_status_change();

-- ============================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================

-- Enable RLS on all tables
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE couriers ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- User Profiles: Users can read/update their own profile
DROP POLICY IF EXISTS "Users can view own profile" ON user_profiles;
CREATE POLICY "Users can view own profile" ON user_profiles
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own profile" ON user_profiles;
CREATE POLICY "Users can update own profile" ON user_profiles
  FOR UPDATE USING (auth.uid() = id);

-- Customers: Customers can manage their own data
DROP POLICY IF EXISTS "Customers can view own data" ON customers;
CREATE POLICY "Customers can view own data" ON customers
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Customers can update own data" ON customers;
CREATE POLICY "Customers can update own data" ON customers
  FOR UPDATE USING (auth.uid() = id);

DROP POLICY IF EXISTS "Customers can manage own addresses" ON customer_addresses;
CREATE POLICY "Customers can manage own addresses" ON customer_addresses
  FOR ALL USING (auth.uid() = customer_id);

DROP POLICY IF EXISTS "Customers can manage own payment methods" ON customer_payment_methods;
CREATE POLICY "Customers can manage own payment methods" ON customer_payment_methods
  FOR ALL USING (auth.uid() = customer_id);

-- Stores: Public can view active stores, merchants can manage their stores
DROP POLICY IF EXISTS "Anyone can view active stores" ON stores;
CREATE POLICY "Anyone can view active stores" ON stores
  FOR SELECT USING (is_active = TRUE);

DROP POLICY IF EXISTS "Merchants can manage own stores" ON stores;
CREATE POLICY "Merchants can manage own stores" ON stores
  FOR ALL USING (auth.uid() = merchant_id);

-- Products: Public can view available products, merchants can manage their products
DROP POLICY IF EXISTS "Anyone can view available products" ON products;
CREATE POLICY "Anyone can view available products" ON products
  FOR SELECT USING (is_available = TRUE AND EXISTS (
    SELECT 1 FROM stores WHERE stores.id = products.store_id AND stores.is_active = TRUE
  ));

DROP POLICY IF EXISTS "Merchants can manage own products" ON products;
CREATE POLICY "Merchants can manage own products" ON products
  FOR ALL USING (EXISTS (
    SELECT 1 FROM stores WHERE stores.id = products.store_id AND stores.merchant_id = auth.uid()
  ));

-- Orders: Customers can view their orders, merchants can view store orders, couriers can view assigned orders
DROP POLICY IF EXISTS "Customers can view own orders" ON orders;
CREATE POLICY "Customers can view own orders" ON orders
  FOR SELECT USING (auth.uid() = customer_id);

DROP POLICY IF EXISTS "Merchants can view store orders" ON orders;
CREATE POLICY "Merchants can view store orders" ON orders
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM stores WHERE stores.id = orders.store_id AND stores.merchant_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Couriers can view assigned orders" ON orders;
CREATE POLICY "Couriers can view assigned orders" ON orders
  FOR SELECT USING (auth.uid() = courier_id);

DROP POLICY IF EXISTS "Customers can create orders" ON orders;
CREATE POLICY "Customers can create orders" ON orders
  FOR INSERT WITH CHECK (auth.uid() = customer_id);

DROP POLICY IF EXISTS "Merchants can update store orders" ON orders;
CREATE POLICY "Merchants can update store orders" ON orders
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM stores WHERE stores.id = orders.store_id AND stores.merchant_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Couriers can update assigned orders" ON orders;
CREATE POLICY "Couriers can update assigned orders" ON orders
  FOR UPDATE USING (auth.uid() = courier_id);

-- Couriers: Couriers can manage their own data
DROP POLICY IF EXISTS "Couriers can view own data" ON couriers;
CREATE POLICY "Couriers can view own data" ON couriers
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Couriers can update own data" ON couriers;
CREATE POLICY "Couriers can update own data" ON couriers
  FOR UPDATE USING (auth.uid() = id);

DROP POLICY IF EXISTS "Couriers can manage own vehicles" ON courier_vehicles;
CREATE POLICY "Couriers can manage own vehicles" ON courier_vehicles
  FOR ALL USING (auth.uid() = courier_id);

DROP POLICY IF EXISTS "Couriers can manage own documents" ON courier_documents;
CREATE POLICY "Couriers can manage own documents" ON courier_documents
  FOR ALL USING (auth.uid() = courier_id);

DROP POLICY IF EXISTS "Couriers can manage own payout methods" ON courier_payout_methods;
CREATE POLICY "Couriers can manage own payout methods" ON courier_payout_methods
  FOR ALL USING (auth.uid() = courier_id);

-- Notifications: Users can view their own notifications
DROP POLICY IF EXISTS "Users can view own notifications" ON notifications;
CREATE POLICY "Users can view own notifications" ON notifications
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own notifications" ON notifications;
CREATE POLICY "Users can update own notifications" ON notifications
  FOR UPDATE USING (auth.uid() = user_id);

-- Wallet Transactions: Users can view their own transactions
DROP POLICY IF EXISTS "Users can view own wallet transactions" ON wallet_transactions;
CREATE POLICY "Users can view own wallet transactions" ON wallet_transactions
  FOR SELECT USING (auth.uid() = user_id);

-- Payments: Customers can view their own payments
DROP POLICY IF EXISTS "Customers can view own payments" ON payments;
CREATE POLICY "Customers can view own payments" ON payments
  FOR SELECT USING (auth.uid() = customer_id);

-- Order status history: readable with order (no direct policy; use service role or join via orders)
-- order_status_history is typically read via orders; service/backend can join as needed.

-- ============================================
-- COMMENTS FOR DOCUMENTATION
-- ============================================

COMMENT ON TABLE user_profiles IS 'Main user profiles extending Supabase Auth';
COMMENT ON TABLE customers IS 'Customer-specific information';
COMMENT ON TABLE merchants IS 'Merchant/business owner information';
COMMENT ON TABLE stores IS 'Physical store locations';
COMMENT ON TABLE products IS 'Menu items/products sold by stores';
COMMENT ON TABLE orders IS 'Customer orders';
COMMENT ON TABLE couriers IS 'Delivery courier/rider information';
COMMENT ON TABLE payments IS 'Payment transactions';
COMMENT ON TABLE wallet_transactions IS 'Wallet balance transactions for all user types';
COMMENT ON TABLE notifications IS 'User notifications';
