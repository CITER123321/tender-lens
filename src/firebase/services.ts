import { getAuth, onAuthStateChanged, signInAnonymously, type User } from 'firebase/auth/web-extension';
import { fetchAndActivate, getRemoteConfig, getValue } from 'firebase/remote-config';
import { DEFAULT_ROUTER_CONFIG, type RouterConfig } from '../core/router';
import { DEFAULT_CLOUD_MODEL, getFirebaseApp } from './app';

/** Anonymous sign-in: the watchlist is per user without asking for an account. */
export async function ensureUser(): Promise<User | null> {
  const app = getFirebaseApp();
  if (!app) return null;
  const auth = getAuth(app);
  const current = await new Promise<User | null>((resolve) => {
    const stop = onAuthStateChanged(auth, (u) => {
      stop();
      resolve(u);
    });
  });
  if (current) return current;
  const cred = await signInAnonymously(auth);
  return cred.user;
}

export interface RuntimeConfig extends RouterConfig {
  cloudModel: string;
  source: 'remote' | 'defaults';
}

/**
 * Remote Config lets us tune routing without shipping a new extension build:
 * how many tokens we send to Gemini Nano, and which cloud model handles long documents.
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const defaults: RuntimeConfig = { ...DEFAULT_ROUTER_CONFIG, cloudModel: DEFAULT_CLOUD_MODEL, source: 'defaults' };
  const app = getFirebaseApp();
  if (!app) return defaults;
  try {
    const rc = getRemoteConfig(app);
    rc.settings.minimumFetchIntervalMillis = 60 * 60 * 1000;
    rc.settings.fetchTimeoutMillis = 4000;
    rc.defaultConfig = {
      ondevice_input_tokens: defaults.onDeviceInputTokens,
      max_local_chunks: defaults.maxLocalChunks,
      cloud_model: defaults.cloudModel,
    };
    await fetchAndActivate(rc);
    const tokens = getValue(rc, 'ondevice_input_tokens').asNumber();
    const chunks = getValue(rc, 'max_local_chunks').asNumber();
    const model = getValue(rc, 'cloud_model').asString();
    return {
      onDeviceInputTokens: tokens > 500 ? tokens : defaults.onDeviceInputTokens,
      maxLocalChunks: chunks > 0 ? chunks : defaults.maxLocalChunks,
      cloudModel: model || defaults.cloudModel,
      source: getValue(rc, 'cloud_model').getSource() === 'remote' ? 'remote' : 'defaults',
    };
  } catch (e) {
    console.warn('[Tender Lens] Remote Config unavailable, using defaults', e);
    return defaults;
  }
}
