import { supabaseAdmin } from './supabaseAdminClient.js';
import { checkPhoneRegistered, deleteUserById } from './authService.js';
import { ensureUserProfile } from './userService.js';
import { assertStrongPassword } from './passwordPolicy.js';
import { approveCourier } from './adminService.js';
import {
  upsertCourierProfile,
  saveCourierVehicle,
  saveCourierDriverLicense,
} from './onboardingService.js';

const VEHICLE_TYPES = new Set(['bike', 'car', 'motorcycle']);

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeE164(phone) {
  const cleaned = String(phone || '').replace(/[\s\-().]/g, '');
  if (!/^\+[1-9]\d{6,14}$/.test(cleaned)) return null;
  return cleaned;
}

function requireText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw fail(`${label} is required`);
  return text;
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

async function findAuthUserByPhone(phone) {
  const target = digitsOnly(phone);
  if (!target) return null;
  let page = 1;
  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = Array.isArray(data?.users) ? data.users : [];
    const match = users.find((user) => digitsOnly(user.phone) === target);
    if (match) return match;
    if (users.length < 1000) return null;
    page += 1;
  }
}

async function removeCreatedUser(userId) {
  try {
    await deleteUserById(userId);
  } catch (error) {
    console.error('[internal-courier] rollback failed:', error?.message || error);
  }
}

/**
 * Create a courier account the rider can log into immediately.
 * DOT staff supply the profile, vehicle, and license. Payout setup is
 * skipped and payouts_enabled is false: DOT pays the rider, not each job.
 */
export async function createInternalCourier(body = {}) {
  if (!supabaseAdmin) throw fail('Server not configured', 500);

  const fullName = requireText(body.fullName, 'Full name');
  const phone = normalizeE164(body.phone);
  if (!phone) {
    throw fail('Enter the phone number with its country code, e.g. +263 77 123 4567.');
  }
  const email = requireText(body.email, 'Email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('A valid email address is required');
  const password = String(body.password || '');
  const passwordCheck = await assertStrongPassword(password);
  if (!passwordCheck.valid) throw fail(passwordCheck.error);

  const nationalId = requireText(body.nationalId, 'National ID');
  const dateOfBirth = requireText(body.dateOfBirth, 'Date of birth');
  const city = requireText(body.city, 'City');
  const vehicleType = requireText(body.vehicleType, 'Vehicle type');
  if (!VEHICLE_TYPES.has(vehicleType)) throw fail('Vehicle type must be bike, car, or motorcycle');
  const brand = requireText(body.brand, 'Vehicle brand');
  const model = requireText(body.model, 'Vehicle model');
  const licensePlate = requireText(body.licensePlate, 'License plate');
  const licenseNumber = requireText(body.licenseNumber, 'Driver license number');

  const profilePhotoBase64 = body.profilePhotoBase64;
  const nationalIdPhotoBase64 = body.nationalIdPhotoBase64;
  const vehiclePhotoBase64 = body.vehiclePhotoBase64;
  const registrationCertificateBase64 = body.registrationCertificateBase64;
  const licenseFrontBase64 = body.licenseFrontBase64;
  const licenseBackBase64 = body.licenseBackBase64;
  if (!profilePhotoBase64) throw fail('A profile photo is required');
  if (!nationalIdPhotoBase64) throw fail('A national ID or passport photo is required');
  if (!vehiclePhotoBase64) throw fail('A vehicle photo is required');
  if (!registrationCertificateBase64) throw fail('A vehicle registration certificate is required');
  if (!licenseFrontBase64 || !licenseBackBase64) throw fail('Front and back license photos are required');

  const existing = await checkPhoneRegistered(phone);
  if (existing.registered) throw fail('A user with this phone number already exists.', 409);

  const { data: emailTaken } = await supabaseAdmin
    .from('user_profiles')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  if (emailTaken) throw fail('This email address is already in use.', 409);

  let userId;
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    phone,
    password,
    phone_confirm: true,
  });
  if (authError) {
    if (authError.code === 'phone_exists') {
      const match = await findAuthUserByPhone(phone);
      if (match) await supabaseAdmin.auth.admin.deleteUser(match.id);
      const { data: retryData, error: retryError } = await supabaseAdmin.auth.admin.createUser({
        phone,
        password,
        phone_confirm: true,
      });
      if (retryError) throw fail(retryError.message || 'Failed to create the login', 500);
      userId = retryData.user.id;
    } else {
      throw fail(authError.message || 'Failed to create the login', 500);
    }
  } else {
    userId = authData.user.id;
  }

  try {
    await ensureUserProfile({
      userId,
      email,
      phone,
      fullName,
      role: 'courier',
      password,
    });

    await upsertCourierProfile({
      userId,
      fullName,
      nationalId,
      dateOfBirth,
      city,
      profilePhotoBase64,
      nationalIdPhotoBase64,
    });
    await saveCourierVehicle({
      userId,
      vehicleType,
      brand,
      model,
      year: body.year,
      color: body.color,
      licensePlate,
      vehiclePhotoBase64,
      registrationCertificateBase64,
    });
    await saveCourierDriverLicense({
      userId,
      licenseNumber,
      expiryDate: body.licenseExpiry,
      frontBase64: licenseFrontBase64,
      backBase64: licenseBackBase64,
    });

    const profileUpdate = { payouts_enabled: false };
    const expiry = String(body.licenseExpiry || '').trim();
    if (expiry) profileUpdate.drivers_license_expiry = expiry;

    const { error: payoutError } = await supabaseAdmin
      .from('couriers')
      .update(profileUpdate)
      .eq('id', userId);
    if (payoutError) {
      if (/payouts_enabled/i.test(payoutError.message || '')) {
        throw fail(
          'The couriers.payouts_enabled column is missing. Run migrations/2026-10-07-internal-riders.sql in the Supabase SQL editor, then try again.',
          500,
        );
      }
      throw fail(payoutError.message || 'Failed to turn off job payouts', 500);
    }

    await approveCourier(userId);

    return {
      id: userId,
      full_name: fullName,
      phone,
      email,
      payouts_enabled: false,
      verification_status: 'approved',
    };
  } catch (error) {
    await removeCreatedUser(userId);
    if (error.status) throw error;
    throw fail(error.message || 'Failed to create the internal rider', 400);
  }
}
