import { supabaseAdmin } from './supabaseAdminClient.js';
import { checkPhoneRegistered, deleteUserById } from './authService.js';
import { ensureUserProfile } from './userService.js';
import { pinProblem, setAccountPin } from './pinAuth.js';
import { controllerEmails } from './merchantControl.js';
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
 * Create a DOT courier the rider can log into immediately, with the phone
 * number and 4-digit PIN the admin sets. The account email defaults to the DOT
 * inbox (shared by all DOT couriers), so codes for a new phone or a forgotten
 * PIN go to the team, who pass them to the rider.
 *
 * DOT staff supply the name, vehicle and plate; ID, date of birth, license and
 * photos are optional and can be added later. Payout setup is skipped and
 * payouts_enabled is false: DOT pays the rider, not each job.
 */
export async function createInternalCourier(body = {}) {
  if (!supabaseAdmin) throw fail('Server not configured', 500);

  const fullName = requireText(body.fullName, 'Full name');
  const phone = normalizeE164(body.phone);
  if (!phone) {
    throw fail('Enter the phone number with its country code, e.g. +263 77 123 4567.');
  }
  const email = String(body.email || '').trim().toLowerCase() || controllerEmails()[0];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('A valid email address is required');
  const sharedDotEmail = controllerEmails().includes(email);
  const pin = String(body.pin || '');
  const problem = pinProblem(pin);
  if (problem) throw fail(problem);

  const nationalId = String(body.nationalId || '').trim();
  const dateOfBirth = String(body.dateOfBirth || '').trim();
  const city = String(body.city || '').trim();
  const vehicleType = requireText(body.vehicleType, 'Vehicle type');
  if (!VEHICLE_TYPES.has(vehicleType)) throw fail('Vehicle type must be bike, car, or motorcycle');
  const brand = requireText(body.brand, 'Vehicle brand');
  const model = requireText(body.model, 'Vehicle model');
  const licensePlate = requireText(body.licensePlate, 'License plate');
  const licenseNumber = String(body.licenseNumber || '').trim();

  const profilePhotoBase64 = body.profilePhotoBase64;
  const nationalIdPhotoBase64 = body.nationalIdPhotoBase64;
  const vehiclePhotoBase64 = body.vehiclePhotoBase64;
  const registrationCertificateBase64 = body.registrationCertificateBase64;
  const licenseFrontBase64 = body.licenseFrontBase64;
  const licenseBackBase64 = body.licenseBackBase64;

  const existing = await checkPhoneRegistered(phone);
  if (existing.registered) throw fail('A user with this phone number already exists.', 409);

  // The DOT inbox is shared by all DOT couriers; any other email is one account's.
  if (!sharedDotEmail) {
    const { data: emailTaken } = await supabaseAdmin
      .from('user_profiles')
      .select('id')
      .eq('email', email)
      .limit(1);
    if (emailTaken?.length) throw fail('This email address is already in use.', 409);
  }

  let userId;
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    phone,
    phone_confirm: true,
  });
  if (authError) {
    if (authError.code === 'phone_exists') {
      const match = await findAuthUserByPhone(phone);
      if (match) await supabaseAdmin.auth.admin.deleteUser(match.id);
      const { data: retryData, error: retryError } = await supabaseAdmin.auth.admin.createUser({
        phone,
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
    });
    await setAccountPin(userId, pin);

    await upsertCourierProfile({
      userId,
      fullName,
      nationalId,
      dateOfBirth,
      city,
      profilePhotoBase64,
      nationalIdPhotoBase64,
      documentsOptional: true,
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
      documentsOptional: true,
    });
    if (licenseNumber) {
      await saveCourierDriverLicense({
        userId,
        licenseNumber,
        expiryDate: body.licenseExpiry,
        frontBase64: licenseFrontBase64,
        backBase64: licenseBackBase64,
        documentsOptional: true,
      });
    }

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
