# DOT Delivery App - Backend Setup Guide

## Database Schema for Supabase

This repository contains the complete database schema for the DOT Delivery App using Supabase.

## Setup Instructions

### 1. Create Supabase Project

1. Go to [supabase.com](https://supabase.com)
2. Create a new project
3. Note down your project URL and anon key

### 2. Run the Schema

1. Open your Supabase project dashboard
2. Go to SQL Editor
3. Copy and paste the contents of `supabase_schema.sql`
4. Click "Run" to execute the schema

### 3. Configure Twilio Authentication

The schema is designed to work with Supabase Auth. To integrate Twilio for phone verification:

1. Set up Twilio account and get API credentials
2. Configure Supabase Auth to use custom phone provider
3. Use Supabase Edge Functions for Twilio integration

## Database Structure

### Core Tables

- **user_profiles** - Main user table extending Supabase Auth
- **customers** - Customer-specific data
- **merchants** - Merchant/business owner data
- **stores** - Physical store locations
- **products** - Menu items/products
- **couriers** - Delivery rider information
- **orders** - Customer orders
- **payments** - Payment transactions
- **wallet_transactions** - Wallet balance tracking

### Key Features

- ✅ Row Level Security (RLS) enabled on all tables
- ✅ Automatic order number generation
- ✅ Rating calculations via triggers
- ✅ Order status history tracking
- ✅ Support for multiple user roles (customer, merchant, courier)
- ✅ Location-based queries (latitude/longitude)
- ✅ Flexible payment methods
- ✅ Document verification system for couriers
- ✅ Notification system

## Next Steps

1. Set up Supabase Auth with phone verification
2. Create Edge Functions for Twilio integration
3. Set up API endpoints for the mobile app
4. Configure storage buckets for images/documents

## Notes

- All monetary values use DECIMAL(10, 2) for precision
- Timestamps use TIMESTAMP WITH TIME ZONE
- UUIDs are used for all primary keys
- Foreign keys have appropriate CASCADE/SET NULL behaviors
