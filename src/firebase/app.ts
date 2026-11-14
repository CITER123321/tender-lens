import { initializeApp, type FirebaseApp } from 'firebase/app';
import { CustomProvider, initializeAppCheck } from 'firebase/app-check';

const env = import.meta.env;

export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: env.VITE_FIREBASE_APP_ID as string | undefined,
};

/** Mock mode: no Firebase at all, deterministic parser + fake model. Used by tests, demos without keys and judges. */
export const MOCK_AI = env.VITE_AI_MOCK === 'true' || !firebaseConfig.apiKey || !firebaseConfig.projectId || !firebaseConfig.appId;

export const DEFAULT_CLOUD_MODEL = (env.VITE_CLOUD_MODEL as string | undefined) || 'gemini-3.5-flash-lite';

const debugToken = (env.VITE_APPCHECK_DEBUG_TOKEN as string | undefined)?.trim();
export const APP_CHECK_DEBUG = !!debugToken;

let app: FirebaseApp | null = null;

/**
 * Lazily initialises Firebase + App Check. Returns null in mock mode.
 *
 * App Check: Firebase AI Logic is protected by App Check. Chrome extensions cannot use reCAPTCHA
 * (it needs a web origin), so this build uses the App Check debug provider, which the hackathon
 * rules accept. The CustomProvider below is where a production attestation (a small backend that
 * mints App Check tokens) would plug in.
 */
export function getFirebaseApp(): FirebaseApp | null {
  if (MOCK_AI) return null;
  if (app) return app;
  if (debugToken) {
    // `true` makes the SDK generate a token and print it to the console; a UUID uses that exact token.
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
      debugToken === 'true' ? true : debugToken;
  }
  app = initializeApp(firebaseConfig);
  initializeAppCheck(app, {
    provider: new CustomProvider({
      getToken: async () => {
        throw new Error('No App Check attestation for this build. Set VITE_APPCHECK_DEBUG_TOKEN in .env (see README).');
      },
    }),
    isTokenAutoRefreshEnabled: true,
  });
  return app;
}
