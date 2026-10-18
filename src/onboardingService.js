import { supabaseAdmin } from './supabaseAdminClient.js';
import { getSuggestedProductCategoryNames } from './storeCategorySuggestions.js';
import { verifyStoreCategory } from './storeCategorizationAI.js';

const supabase = supabaseAdmin;

// Bucket names (override via env to match your Supabase project)
const COURIER_BUCKET = process.env.SUPABASE_COURIER_BUCKET || 'courier-documents';
const MERCHANT_BUCKET = process.env.SUPABASE_MERCHANT_BUCKET || 'merchant-documents';
const STORE_LOGOS_BUCKET = process.env.SUPABASE_STORE_LOGOS_BUCKET || 'store-logos';

function requireSupabase() {
  if (!supabase) {
    throw new Error('Server not configured (missing SUPABASE_SERVICE_ROLE_KEY)');
  }
}

function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mime: match[1], base64: match[2] };
}

// Matches courier_vehicles.vehicle_type CHECK (bike, car, motorcycle).
// The app labels bike as Scooter.
function canonicalVehicleType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'car') return 'car';
  if (raw === 'motorcycle' || raw === 'motorbike') return 'motorcycle';
  if (raw === 'scooter' || raw === 'bike' || raw === 'bicycle') return 'bike';
  return null;
}

function extForMime(mime) {
  if (!mime) return 'bin';
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('pdf')) return 'pdf';
  return 'bin';
}

async function uploadToBucket({ bucket, path, dataUrl }) {
  requireSupabase();
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) throw new Error('Invalid file payload (expected base64 data URL)');

  const buffer = Buffer.from(parsed.base64, 'base64');
  const { error: uploadError } = await supabase.storage.from(bucket).upload(path, buffer, {
    contentType: parsed.mime,
    upsert: true,
  });
  if (uploadError) {
    console.error('Storage upload error:', uploadError);
    throw new Error(uploadError.message || 'Failed to upload file');
  }

  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(path);
  return urlData?.publicUrl || null;
}

async function verificationFieldsForSave(userId) {
  const fresh = { verification_status: 'pending', is_verified: false, is_online: false };
  const { data, error } = await supabase
    .from('couriers')
    .select('verification_status, is_verified, is_online')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return fresh;
  const verified = data.verification_status === 'approved' || data.is_verified === true;
  if (!verified) return fresh;
  return {
    verification_status: data.verification_status || 'approved',
    is_verified: true,
    is_online: data.is_online === true,
  };
}

export async function saveCourierDocument({ userId, documentType, documentUrl, status = 'pending' }) {
  if (!userId || !documentType || !documentUrl) {
    throw new Error('Could not save the document');
  }
  const { data: rows, error: readError } = await supabase
    .from('courier_documents')
    .select('id, document_url, status')
    .eq('courier_id', userId)
    .eq('document_type', documentType)
    .limit(1);
  if (readError) throw new Error(readError.message || 'Failed to save document');

  if (rows?.[0]?.id) {
    const existing = rows[0];
    const replaced = existing.document_url !== documentUrl;
    const nextStatus = replaced ? status : (existing.status || status);
    const { error } = await supabase
      .from('courier_documents')
      .update({ document_url: documentUrl, status: nextStatus })
      .eq('id', existing.id);
    if (error) throw new Error(error.message || 'Failed to save document');
    if (replaced && existing.status === 'approved') {
      await supabase
        .from('couriers')
        .update({ is_verified: false, verification_status: 'pending' })
        .eq('id', userId);
    }
    return;
  }

  const { error } = await supabase.from('courier_documents').insert({
    courier_id: userId,
    document_type: documentType,
    document_url: documentUrl,
    status,
  });
  if (error) {
    if (/document_type_check/i.test(error.message || '')) {
      throw new Error('This file could not be saved. The account database still needs the document-type update.');
    }
    throw new Error(error.message || 'Failed to save document');
  }
}

async function courierDocumentUrl(userId, documentType) {
  const { data, error } = await supabase
    .from('courier_documents')
    .select('document_url')
    .eq('courier_id', userId)
    .eq('document_type', documentType)
    .maybeSingle();
  if (error) return null;
  return data?.document_url || null;
}

function cityFromAddress(address) {
  const value = String(address || '').trim();
  if (!value) return 'Harare';
  // Try to pick the last comma-separated token, otherwise default.
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  // Common patterns: "... CBD Harare, Zimbabwe" -> last might be "Zimbabwe"
  if (/harare/i.test(value)) return 'Harare';
  if (/bulawayo/i.test(value)) return 'Bulawayo';
  return last && last.length <= 64 ? last : 'Harare';
}

export async function upsertCourierProfile({
  userId,
  fullName,
  nationalId,
  dateOfBirth,
  city,
  profilePhotoBase64,
  nationalIdPhotoBase64,
}) {
  requireSupabase();
  if (!userId) throw new Error('userId is required');

  let name = String(fullName || '').trim();
  let idNumber = String(nationalId || '').trim();
  let dobRaw = String(dateOfBirth || '').trim();
  let cityValue = city ? String(city).trim() : '';
  if (!name || !idNumber || !dobRaw || !cityValue) {
    const [{ data: profile }, { data: existingCourier }] = await Promise.all([
      supabase.from('user_profiles').select('full_name').eq('id', userId).maybeSingle(),
      supabase.from('couriers').select('national_id, date_of_birth, city').eq('id', userId).maybeSingle(),
    ]);
    if (!name) name = String(profile?.full_name || '').trim();
    if (!idNumber) idNumber = String(existingCourier?.national_id || '').trim();
    if (!dobRaw && existingCourier?.date_of_birth) dobRaw = String(existingCourier.date_of_birth).slice(0, 10);
    if (!cityValue) cityValue = String(existingCourier?.city || '').trim();
  }
  if (!name) throw new Error('fullName is required');
  if (!idNumber) throw new Error('nationalId is required');
  if (!dobRaw) throw new Error('dateOfBirth is required');
  if (!profilePhotoBase64 && !(await courierDocumentUrl(userId, 'profile_photo'))) {
    throw new Error('A profile photo is required');
  }
  if (!nationalIdPhotoBase64 && !(await courierDocumentUrl(userId, 'national_id'))) {
    throw new Error('A national ID or passport photo is required');
  }

  // Expect date in DD/MM/YYYY from UI; convert to YYYY-MM-DD if possible
  let dobIso = dobRaw;
  const dobMatch = dobRaw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dobMatch) {
    dobIso = `${dobMatch[3]}-${dobMatch[2]}-${dobMatch[1]}`;
  }

  // Enforce minimum age of 18 years for couriers
  const parsedDob = new Date(dobIso);
  if (Number.isNaN(parsedDob.getTime())) {
    throw new Error('Invalid date of birth format');
  }
  const today = new Date();
  let age = today.getFullYear() - parsedDob.getFullYear();
  const m = today.getMonth() - parsedDob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < parsedDob.getDate())) {
    age -= 1;
  }
  if (age < 18) {
    throw new Error('You must be at least 18 years old to create a courier account');
  }

  // Update display name only; role is determined by table membership, email is never overwritten
  const { error: profileError } = await supabase
    .from('user_profiles')
    .update({ full_name: name })
    .eq('id', userId);
  if (profileError) throw new Error(profileError.message || 'Failed to update user profile');

  const verification = await verificationFieldsForSave(userId);
  const { error: courierError } = await supabase.from('couriers').upsert(
    {
      id: userId,
      national_id: idNumber,
      date_of_birth: dobIso,
      city: cityValue || null,
      ...verification,
    },
    { onConflict: 'id' },
  );
  if (courierError) throw new Error(courierError.message || 'Failed to save courier profile');

  const uploads = {};
  if (profilePhotoBase64) {
    const ext = extForMime(parseDataUrl(profilePhotoBase64)?.mime);
    const url = await uploadToBucket({
      bucket: COURIER_BUCKET,
      path: `couriers/${userId}/profile_photo.${ext}`,
      dataUrl: profilePhotoBase64,
    });
    uploads.profile_photo_url = url;
    await saveCourierDocument({ userId, documentType: 'profile_photo', documentUrl: url });
  }

  if (nationalIdPhotoBase64) {
    const ext = extForMime(parseDataUrl(nationalIdPhotoBase64)?.mime);
    const url = await uploadToBucket({
      bucket: COURIER_BUCKET,
      path: `couriers/${userId}/national_id.${ext}`,
      dataUrl: nationalIdPhotoBase64,
    });
    uploads.national_id_url = url;
    await saveCourierDocument({ userId, documentType: 'national_id', documentUrl: url });
  }

  return { success: true, uploads };
}

export async function saveCourierVehicle({
  userId,
  vehicleType,
  brand,
  model,
  year,
  color,
  licensePlate,
  vehiclePhotoBase64,
  registrationCertificateBase64,
}) {
  requireSupabase();
  if (!userId) throw new Error('userId is required');
  const existingPhotoUrl = vehiclePhotoBase64 ? null : await courierDocumentUrl(userId, 'vehicle_photo');
  const existingCertUrl = registrationCertificateBase64
    ? null
    : await courierDocumentUrl(userId, 'vehicle_registration');

  // Ensure courier row exists
  const vehicleVerification = await verificationFieldsForSave(userId);
  const { error: ensureCourierError } = await supabase.from('couriers').upsert(
    { id: userId, ...vehicleVerification },
    { onConflict: 'id' },
  );
  if (ensureCourierError) throw new Error(ensureCourierError.message || 'Failed to ensure courier');

  const { data: ownVehicles, error: ownVehiclesError } = await supabase
    .from('courier_vehicles')
    .select('id, vehicle_type, brand, model, year, color, license_plate, is_active, vehicle_photo_url, registration_certificate_url, created_at')
    .eq('courier_id', userId);
  if (ownVehiclesError) throw new Error(ownVehiclesError.message || 'Failed to load vehicle');

  const plateIncoming = String(licensePlate || '').trim().toUpperCase();
  const samePlate = plateIncoming
    ? (ownVehicles || []).find(
      (row) => String(row.license_plate || '').trim().toUpperCase() === plateIncoming,
    )
    : null;
  const activeVehicle = (ownVehicles || []).find((row) => row.is_active);
  const newestVehicle = [...(ownVehicles || [])].sort(
    (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0),
  )[0];
  // The plate is unique across every vehicle row, including inactive ones.
  // Update the row that already has it instead of inserting a second copy.
  const target = samePlate || activeVehicle || newestVehicle || null;

  const storedVehicleType = canonicalVehicleType(vehicleType) || canonicalVehicleType(target?.vehicle_type);
  const plate = plateIncoming || String(target?.license_plate || '').trim().toUpperCase();
  const keptBrand = String(brand || '').trim() || target?.brand || '';
  const keptModel = String(model || '').trim() || target?.model || '';
  if (!storedVehicleType) throw new Error('Vehicle type must be car, motorcycle, or scooter');
  if (!target && (!keptBrand || !keptModel || !plate)) {
    throw new Error('vehicle brand, model, and license plate are required');
  }
  const photoOnFile = existingPhotoUrl || target?.vehicle_photo_url;
  const certOnFile = existingCertUrl || target?.registration_certificate_url;
  if (!vehiclePhotoBase64 && !photoOnFile) throw new Error('A vehicle photo is required');
  if (!registrationCertificateBase64 && !certOnFile) {
    throw new Error('A vehicle registration certificate is required');
  }

  const fields = {
    vehicle_type: storedVehicleType,
    brand: keptBrand,
    model: keptModel,
    year: year ? Number(year) : (target?.year ?? null),
    color: String(color || '').trim() || target?.color || null,
    license_plate: plate,
    vehicle_photo_url: existingPhotoUrl || target?.vehicle_photo_url || null,
    registration_certificate_url: existingCertUrl || target?.registration_certificate_url || null,
    is_active: true,
  };

  let vehicle;
  if (target) {
    const { data, error } = await supabase
      .from('courier_vehicles')
      .update(fields)
      .eq('id', target.id)
      .select('*')
      .single();
    if (error) {
      if (/license_plate/i.test(error.message || '')) {
        throw new Error('That license plate is already registered to another vehicle.');
      }
      throw new Error(error.message || 'Failed to save vehicle');
    }
    vehicle = data;
  } else {
    const { data, error } = await supabase
      .from('courier_vehicles')
      .insert({ courier_id: userId, ...fields })
      .select('*')
      .single();
    if (error) {
      if (/license_plate/i.test(error.message || '')) {
        throw new Error('That license plate is already registered to another vehicle.');
      }
      throw new Error(error.message || 'Failed to save vehicle');
    }
    vehicle = data;
  }

  await supabase
    .from('courier_vehicles')
    .update({ is_active: false })
    .eq('courier_id', userId)
    .neq('id', vehicle.id);

  const uploads = {};
  if (vehiclePhotoBase64) {
    const ext = extForMime(parseDataUrl(vehiclePhotoBase64)?.mime);
    const url = await uploadToBucket({
      bucket: COURIER_BUCKET,
      path: `couriers/${userId}/vehicles/${vehicle.id}/vehicle_photo.${ext}`,
      dataUrl: vehiclePhotoBase64,
    });
    uploads.vehicle_photo_url = url;
    const { error: photoUpdateError } = await supabase
      .from('courier_vehicles')
      .update({ vehicle_photo_url: url })
      .eq('id', vehicle.id);
    if (photoUpdateError) throw new Error(photoUpdateError.message || 'Failed to save vehicle photo');
    await saveCourierDocument({ userId, documentType: 'vehicle_photo', documentUrl: url });
  }

  if (registrationCertificateBase64) {
    const ext = extForMime(parseDataUrl(registrationCertificateBase64)?.mime);
    const url = await uploadToBucket({
      bucket: COURIER_BUCKET,
      path: `couriers/${userId}/vehicles/${vehicle.id}/registration_certificate.${ext}`,
      dataUrl: registrationCertificateBase64,
    });
    uploads.registration_certificate_url = url;
    const { error: certUpdateError } = await supabase
      .from('courier_vehicles')
      .update({ registration_certificate_url: url })
      .eq('id', vehicle.id);
    if (certUpdateError) throw new Error(certUpdateError.message || 'Failed to save registration certificate');
    await saveCourierDocument({ userId, documentType: 'vehicle_registration', documentUrl: url });
  }

  return { success: true, vehicleId: vehicle.id, uploads };
}

export async function saveCourierDriverLicense({
  userId,
  licenseNumber,
  expiryDate,
  frontBase64,
  backBase64,
}) {
  requireSupabase();
  if (!userId) throw new Error('userId is required');
  let license = String(licenseNumber || '').trim();
  if (!license) {
    const { data: existingCourier } = await supabase
      .from('couriers')
      .select('drivers_license_number')
      .eq('id', userId)
      .maybeSingle();
    license = String(existingCourier?.drivers_license_number || '').trim();
  }
  if (!license) throw new Error('licenseNumber is required');
  const existingLicenseUrl = await courierDocumentUrl(userId, 'id_drivers_license');
  if ((!frontBase64 || !backBase64) && !existingLicenseUrl) {
    throw new Error('Front and back license photos are required');
  }

  const licenseVerification = await verificationFieldsForSave(userId);
  const { error: courierUpdateError } = await supabase.from('couriers').upsert(
    {
      id: userId,
      drivers_license_number: license,
      ...licenseVerification,
    },
    { onConflict: 'id' },
  );
  if (courierUpdateError)
    throw new Error(courierUpdateError.message || 'Failed to save license details');

  const uploads = {};
  let frontUrl = existingLicenseUrl;

  if (frontBase64) {
    frontUrl = await uploadToBucket({
      bucket: COURIER_BUCKET,
      path: `couriers/${userId}/driver_license/front.${extForMime(parseDataUrl(frontBase64)?.mime)}`,
      dataUrl: frontBase64,
    });
    uploads.front = frontUrl;
  }

  if (backBase64) {
    uploads.back = await uploadToBucket({
      bucket: COURIER_BUCKET,
      path: `couriers/${userId}/driver_license/back.${extForMime(parseDataUrl(backBase64)?.mime)}`,
      dataUrl: backBase64,
    });
  }

  // Front and back are one document (the license), not two — both photos are
  // kept in storage, but courier_documents gets a single row so the Documents
  // screen shows one "Driver's License" entry, not a duplicate per side.
  if (frontBase64 && frontUrl) {
    await saveCourierDocument({
      userId,
      documentType: 'id_drivers_license',
      documentUrl: frontUrl,
    });
  }

  return { success: true, uploads };
}

export async function saveCourierPayoutMethod({
  userId, methodType, provider, providerCode, accountNumber, accountName,
  detectionMethod, isDefault = true,
}) {
  requireSupabase();
  if (!userId) throw new Error('userId is required');
  if (!methodType) throw new Error('methodType is required');
  if (!provider || !String(provider).trim()) throw new Error('provider is required');
  if (!accountNumber || !String(accountNumber).trim()) throw new Error('accountNumber is required');

  if (isDefault) {
    await supabase
      .from('courier_payout_methods')
      .update({ is_default: false })
      .eq('courier_id', userId);
  }

  const insert = {
    courier_id: userId,
    method_type: methodType,
    provider: String(provider).trim(),
    provider_code: providerCode ? String(providerCode).trim().toUpperCase() : null,
    account_number: String(accountNumber).trim(),
    account_name: accountName ? String(accountName).trim() : null,
    detection_method: detectionMethod || null,
    is_default: isDefault,
  };

  const { data, error } = await supabase
    .from('courier_payout_methods')
    .insert(insert)
    .select('*')
    .single();
  if (error) throw new Error(error.message || 'Failed to save payout method');

  return { success: true, payoutMethodId: data.id };
}

export async function saveMerchantPayoutMethod({
  userId, methodType, provider, providerCode, accountNumber, accountName,
  detectionMethod, isDefault = true,
}) {
  requireSupabase();
  if (!userId) throw new Error('userId is required');
  if (!methodType) throw new Error('methodType is required');
  if (!provider || !String(provider).trim()) throw new Error('provider is required');
  if (!accountNumber || !String(accountNumber).trim()) throw new Error('accountNumber is required');

  if (isDefault) {
    await supabase
      .from('merchant_payout_methods')
      .update({ is_default: false })
      .eq('merchant_id', userId);
  }

  const insert = {
    merchant_id: userId,
    method_type: methodType,
    provider: String(provider).trim(),
    provider_code: providerCode ? String(providerCode).trim().toUpperCase() : null,
    account_number: String(accountNumber).trim(),
    account_name: accountName ? String(accountName).trim() : null,
    detection_method: detectionMethod || null,
    is_default: isDefault,
  };

  const { data, error } = await supabase
    .from('merchant_payout_methods')
    .insert(insert)
    .select('*')
    .single();
  if (error) throw new Error(error.message || 'Failed to save merchant payout method');

  return { success: true, payoutMethodId: data.id };
}

export async function upsertMerchantOnboarding({
  userId,
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
  delivery_radius_km,
  business_registration_number,
  tax_id,
  storeLogoBase64,
  storeBannerBase64,
  ownerIdBase64,
  businessCertificateBase64,
  proofOfAddressBase64,
}) {
  requireSupabase();
  if (!userId) throw new Error('userId is required');
  if (!businessName || !String(businessName).trim()) throw new Error('businessName is required');
  if (!businessType || !String(businessType).trim()) throw new Error('businessType is required');
  if (!storeName || !String(storeName).trim()) throw new Error('storeName is required');
  if (!address || !String(address).trim()) throw new Error('address is required');
  if (latitude == null || longitude == null) throw new Error('latitude and longitude are required');

  // Only update full_name if provided; never overwrite email (login email) or role (determined by table membership)
  if (ownerName && String(ownerName).trim()) {
    const { error: profileError } = await supabase
      .from('user_profiles')
      .update({ full_name: String(ownerName).trim() })
      .eq('id', userId);
    if (profileError) throw new Error(profileError.message || 'Failed to update user profile');
  }

  // A client may accidentally submit a business_types.id instead of its name (this happened once via
  // the admin dashboard's onboarding form). Normalize here so a raw id can never land in this free-text
  // column and surface to customers as-is.
  let resolvedBusinessType = String(businessType).trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resolvedBusinessType)) {
    const { data: typeRow } = await supabase
      .from('business_types')
      .select('name')
      .eq('id', resolvedBusinessType)
      .maybeSingle();
    if (typeRow?.name) resolvedBusinessType = typeRow.name;
  }

  const merchantPayload = {
    id: userId,
    business_name: String(businessName).trim(),
    business_type: resolvedBusinessType,
    is_active: true,
  };
  if (business_registration_number !== undefined) merchantPayload.business_registration_number = business_registration_number ? String(business_registration_number).trim() : null;
  if (tax_id !== undefined) merchantPayload.tax_id = tax_id ? String(tax_id).trim() : null;

  const { error: merchantError } = await supabase.from('merchants').upsert(merchantPayload, { onConflict: 'id' });
  if (merchantError) throw new Error(merchantError.message || 'Failed to save merchant');

  const cityValue = (city && String(city).trim()) || cityFromAddress(address);

  const { data: existingStore } = await supabase
    .from('stores')
    .select('id')
    .eq('merchant_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const storePayload = {
    merchant_id: userId,
    store_name: String(storeName).trim(),
    phone: phone ? String(phone).trim() : null,
    email: email ? String(email).trim() : null,
    address_line1: String(address).trim(),
    address_line2: address_line2 ? String(address_line2).trim() : null,
    city: cityValue,
    state_province: state_province ? String(state_province).trim() : null,
    postal_code: postal_code ? String(postal_code).trim() : null,
    country: (country && String(country).trim()) || 'Zimbabwe',
    latitude,
    longitude,
    description: description ? String(description).trim() : null,
    operating_hours:
      operating_hours
        ? typeof operating_hours === 'string'
          ? { summary: operating_hours }
          : typeof operating_hours === 'object' && Object.keys(operating_hours).length > 0
            ? operating_hours
            : null
        : null,
    is_open: is_open !== false,
    is_active: true,
  };
  if (delivery_radius_km !== undefined && delivery_radius_km !== null && delivery_radius_km !== '') {
    const radius = Number(delivery_radius_km);
    if (Number.isFinite(radius) && radius > 0) {
      storePayload.delivery_radius_km = radius;
    }
  }

  let storeId = existingStore?.id || null;
  if (storeId) {
    const { error: storeUpdateError } = await supabase.from('stores').update(storePayload).eq('id', storeId);
    if (storeUpdateError) throw new Error(storeUpdateError.message || 'Failed to update store');
  } else {
    const { data: inserted, error: storeInsertError } = await supabase
      .from('stores')
      .insert(storePayload)
      .select('id')
      .single();
    if (storeInsertError) throw new Error(storeInsertError.message || 'Failed to create store');
    storeId = inserted.id;
  }

  // Double-check the merchant's self-picked business type against what the
  // store's name/description actually say it sells, so a wrong pick never
  // surfaces as a customer-facing category mistake (never blocks onboarding).
  try {
    const { data: types } = await supabase.from('business_types').select('name');
    const categoryNames = (types || []).map((t) => t.name);
    const verified = await verifyStoreCategory({
      storeName: String(storeName).trim(),
      description: description ? String(description).trim() : '',
      declaredType: resolvedBusinessType,
      categoryNames,
    });
    if (verified) {
      await supabase.from('stores').update({ category_override: verified }).eq('id', storeId);
    }
  } catch (err) {
    console.warn('[CategoryVerify] onboarding verification skipped:', err?.message);
  }

  if (storeLogoBase64) {
    const ext = extForMime(parseDataUrl(storeLogoBase64)?.mime);
    const url = await uploadToBucket({
      bucket: STORE_LOGOS_BUCKET,
      path: `stores/${storeId}/logo.${ext}`,
      dataUrl: storeLogoBase64,
    });
    await supabase.from('stores').update({ logo: url }).eq('id', storeId);
  }

  if (storeBannerBase64) {
    const ext = extForMime(parseDataUrl(storeBannerBase64)?.mime);
    const url = await uploadToBucket({
      bucket: STORE_LOGOS_BUCKET,
      path: `stores/${storeId}/banner.${ext}`,
      dataUrl: storeBannerBase64,
    });
    await supabase.from('stores').update({ banner_url: url }).eq('id', storeId);
  }

  // Seed default product categories tailored to the business type when the store is first created
  // or when it has no categories yet. This lets the app show relevant sections (e.g. Bakery, Groceries).
  const { data: existingCategories, error: categoriesError } = await supabase
    .from('product_categories')
    .select('id')
    .eq('store_id', storeId)
    .limit(1);
  if (categoriesError) {
    console.error('merchant onboarding categories check error:', categoriesError);
  } else if (!existingCategories || existingCategories.length === 0) {
    const hint = `${String(businessName || '').trim()} ${String(storeName || '').trim()}`.trim();
    const categoriesToInsert = getSuggestedProductCategoryNames(resolvedBusinessType, { businessName: hint });

    const rows = categoriesToInsert.map((name, index) => ({
      store_id: storeId,
      name,
      display_order: index,
      is_active: true,
    }));

    if (rows.length > 0) {
      const { error: insertCategoriesError } = await supabase
        .from('product_categories')
        .insert(rows);
      if (insertCategoriesError) {
        console.error('merchant onboarding categories insert error:', insertCategoriesError);
      }
    }
  }

  // Merchant documents — delete existing then re-insert so resubmissions don't stack up
  const docUploads = [
    { key: 'owner_id',              dataUrl: ownerIdBase64 },
    { key: 'business_certificate',  dataUrl: businessCertificateBase64 },
    { key: 'proof_of_address',      dataUrl: proofOfAddressBase64 },
  ];

  for (const { key, dataUrl } of docUploads) {
    if (!dataUrl) continue;
    const ext = extForMime(parseDataUrl(dataUrl)?.mime);
    const url = await uploadToBucket({
      bucket: MERCHANT_BUCKET,
      path: `merchants/${userId}/${key}.${ext}`,
      dataUrl,
    });
    // Remove any previous version of this document type before inserting the new one
    await supabase
      .from('merchant_documents')
      .delete()
      .eq('merchant_id', userId)
      .eq('document_type', key);
    await supabase.from('merchant_documents').insert({
      merchant_id: userId,
      document_type: key,
      document_url: url,
      status: 'pending',
    });
  }

  return { success: true, storeId };
}
