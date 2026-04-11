import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let firebaseAdminAuth = null;

export function getFirebaseAdminAuth() {
  if (firebaseAdminAuth) return firebaseAdminAuth;

  if (getApps().length === 0) {
    const serviceAccountPath = resolve(
      __dirname,
      '../../',
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    );
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));

    initializeApp({ credential: cert(serviceAccount) });
  }

  firebaseAdminAuth = getAuth();
  return firebaseAdminAuth;
}

export async function verifyFirebaseToken(idToken) {
  const auth = getFirebaseAdminAuth();
  const decoded = await auth.verifyIdToken(idToken);
  return decoded; // { uid, phone_number, ... }
}