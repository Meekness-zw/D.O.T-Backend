import { supabaseAdmin } from './supabaseAdminClient.js';

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
  if (!fullName || !String(fullName).trim()) throw new Error('fullName is required');
  if (!nationalId || !String(nationalId).trim()) throw new Error('nationalId is required');
  if (!dateOfBirth || !String(dateOfBirth).trim()) throw new Error('dateOfBirth is required');

  // Expect date in DD/MM/YYYY from UI; convert to YYYY-MM-DD if possible
  const dobRaw = String(dateOfBirth).trim();
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

  // Update profile name and ensure role stays courier without touching email
  const { error: profileError } = await supabase
    .from('user_profiles')
    .update({
      full_name: String(fullName).trim(),
      role: 'courier',
    })
    .eq('id', userId);
  if (profileError) throw new Error(profileError.message || 'Failed to update user profile');

  const { error: courierError } = await supabase.from('couriers').upsert(
    {
      id: userId,
      national_id: String(nationalId).trim(),
      date_of_birth: dobIso,
      city: city ? String(city).trim() : null,
      verification_status: 'pending',
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

    await supabase.from('courier_documents').insert({
      courier_id: userId,
      document_type: 'profile_photo',
      document_url: url,
      status: 'pending',
    });
  }

  if (nationalIdPhotoBase64) {
    const ext = extForMime(parseDataUrl(nationalIdPhotoBase64)?.mime);
    const url = await uploadToBucket({
      bucket: COURIER_BUCKET,
      path: `couriers/${userId}/national_id.${ext}`,
      dataUrl: nationalIdPhotoBase64,
    });
    uploads.national_id_url = url;

    // Stored under the closest existing enum type.
    await supabase.from('courier_documents').insert({
      courier_id: userId,
      document_type: 'id_drivers_license',
      document_url: url,
      status: 'pending',
    });
  }

  // If we uploaded a profile photo, also persist it into user_profiles.profile_photo
  if (uploads.profile_photo_url) {
    try {
      await supabase
        .from('user_profiles')
        .update({ profile_photo: uploads.profile_photo_url })
        .eq('id', userId);
    } catch (e) {
      console.error('Failed to save courier profile photo to user_profiles:', e);
    }
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
  if (!vehicleType) throw new Error('vehicleType is required');
  if (!brand || !String(brand).trim()) throw new Error('vehicle brand is required');
  if (!model || !String(model).trim()) throw new Error('vehicle model is required');
  if (!licensePlate || !String(licensePlate).trim()) throw new Error('license plate is required');

  // Ensure courier row exists
  const { error: ensureCourierError } = await supabase.from('couriers').upsert(
    { id: userId, verification_status: 'pending' },
    { onConflict: 'id' },
  );
  if (ensureCourierError) throw new Error(ensureCourierError.message || 'Failed to ensure courier');

  // Deactivate previous vehicles
  await supabase.from('courier_vehicles').update({ is_active: false }).eq('courier_id', userId);

  const insert = {
    courier_id: userId,
    vehicle_type: vehicleType,
    brand: String(brand).trim(),
    model: String(model).trim(),
    year: year ? Number(year) : null,
    color: color ? String(color).trim() : null,
    license_plate: String(licensePlate).trim().toUpperCase(),
    is_active: true,
  };

  const { data: vehicle, error } = await supabase
    .from('courier_vehicles')
    .insert(insert)
    .select('*')
    .single();
  if (error) throw new Error(error.message || 'Failed to save vehicle');

  const uploads = {};
  if (vehiclePhotoBase64) {
    const ext = extForMime(parseDataUrl(vehiclePhotoBase64)?.mime);
    const url = await uploadToBucket({
      bucket: COURIER_BUCKET,
      path: `couriers/${userId}/vehicles/${vehicle.id}/vehicle_photo.${ext}`,
      dataUrl: vehiclePhotoBase64,
    });
    uploads.vehicle_photo_url = url;
    await supabase.from('courier_vehicles').update({ vehicle_photo_url: url }).eq('id', vehicle.id);
  }

  if (registrationCertificateBase64) {
    const ext = extForMime(parseDataUrl(registrationCertificateBase64)?.mime);
    const url = await uploadToBucket({
      bucket: COURIER_BUCKET,
      path: `couriers/${userId}/vehicles/${vehicle.id}/registration_certificate.${ext}`,
      dataUrl: registrationCertificateBase64,
    });
    uploads.registration_certificate_url = url;
    await supabase
      .from('courier_vehicles')
      .update({ registration_certificate_url: url })
      .eq('id', vehicle.id);

    await supabase.from('courier_documents').insert({
      courier_id: userId,
      document_type: 'vehicle_registration',
      document_url: url,
      status: 'pending',
    });
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
  if (!licenseNumber || !String(licenseNumber).trim()) throw new Error('licenseNumber is required');
  if (!frontBase64 || !backBase64) throw new Error('Front and back license photos are required');

  const { error: courierUpdateError } = await supabase.from('couriers').upsert(
    {
      id: userId,
      drivers_license_number: String(licenseNumber).trim(),
      verification_status: 'pending',
    },
    { onConflict: 'id' },
  );
  if (courierUpdateError)
    throw new Error(courierUpdateError.message || 'Failed to save license details');

  const uploads = {};

  const frontUrl = await uploadToBucket({
    bucket: COURIER_BUCKET,
    path: `couriers/${userId}/driver_license/front.${extForMime(parseDataUrl(frontBase64)?.mime)}`,
    dataUrl: frontBase64,
  });
  uploads.front = frontUrl;
  await supabase.from('courier_documents').insert({
    courier_id: userId,
    document_type: 'id_drivers_license',
    document_url: frontUrl,
    status: 'pending',
  });

  const backUrl = await uploadToBucket({
    bucket: COURIER_BUCKET,
    path: `couriers/${userId}/driver_license/back.${extForMime(parseDataUrl(backBase64)?.mime)}`,
    dataUrl: backBase64,
  });
  uploads.back = backUrl;
  await supabase.from('courier_documents').insert({
    courier_id: userId,
    document_type: 'id_drivers_license',
    document_url: backUrl,
    status: 'pending',
  });

  return { success: true, uploads };
}

export async function saveCourierPayoutMethod({ userId, methodType, provider, accountNumber, accountName, isDefault = true }) {
  requireSupabase();
  if (!userId) throw new Error('userId is required');
  if (!methodType) throw new Error('methodType is required');
  if (!provider || !String(provider).trim()) throw new Error('provider is required');
  if (!accountNumber || !String(accountNumber).trim()) throw new Error('accountNumber is required');

  // Only clear existing defaults when saving a new primary method
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
    account_number: String(accountNumber).trim(),
    account_name: accountName ? String(accountName).trim() : null,
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

  const fallbackEmail = email ? String(email).trim() : `${userId}@merchant.local`;

  const { error: profileError } = await supabase.from('user_profiles').upsert(
    {
      id: userId,
      full_name: ownerName ? String(ownerName).trim() : null,
      role: 'merchant',
      email: fallbackEmail,
    },
    { onConflict: 'id' },
  );
  if (profileError) throw new Error(profileError.message || 'Failed to update user profile');

  const merchantPayload = {
    id: userId,
    business_name: String(businessName).trim(),
    business_type: String(businessType).trim(),
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
    const type = String(businessType).toLowerCase();
    let categoriesToInsert = [];

    if (type === 'bakery') {
      categoriesToInsert = ['Bread', 'Pastries', 'Cakes', 'Cookies', 'Drinks'];
    } else if (type === 'grocery' || type === 'grocery / retail') {
      categoriesToInsert = ['Fruits & Vegetables', 'Meat & Poultry', 'Dairy & Eggs', 'Pantry Staples', 'Snacks & Drinks'];
    } else if (type === 'pharmacy') {
      categoriesToInsert = ['Prescription Medicines', 'Over-the-counter', 'Vitamins & Supplements', 'Personal Care', 'Baby & Kids'];
    } else if (type === 'restaurant' || type === 'restaurant / food') {
      categoriesToInsert = ['Starters', 'Mains', 'Sides', 'Drinks', 'Desserts'];
    } else if (type === 'hardware') {
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

