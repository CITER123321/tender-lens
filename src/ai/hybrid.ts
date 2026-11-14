// Firebase AI Logic hybrid inference: one GenerativeModel per inference mode, same schema everywhere.

import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  InferenceSource,
  Schema,
  type GenerativeModel,
  type Part,
} from 'firebase/ai';
import { getFirebaseApp } from '../firebase/app';
import { parseModelJson, type ModelOutput } from '../core/prompt';
import type { RouteMode } from '../core/types';

const list = () => Schema.array({ items: Schema.string() });

/** Same schema for the cloud model (responseSchema) and Gemini Nano (responseConstraint). */
export const tenderSchema = Schema.object({
  properties: {
    title: Schema.string(),
    buyer: Schema.string(),
    reference: Schema.string(),
    deadlineDate: Schema.string({ description: 'YYYY-MM-DD or empty' }),
    deadlineTime: Schema.string({ description: 'HH:MM 24h or empty' }),
    depositRequired: Schema.enumString({ enum: ['yes', 'no', 'unknown'] }),
    depositAmount: Schema.string(),
    summary: Schema.string(),
    conditions: list(),
    criteria: Schema.array({
      items: Schema.object({ properties: { name: Schema.string(), weight: Schema.number() } }),
    }),
    documents: list(),
    redFlags: list(),
  },
});

const MODE: Record<RouteMode, InferenceMode> = {
  prefer_on_device: InferenceMode.PREFER_ON_DEVICE,
  only_on_device: InferenceMode.ONLY_ON_DEVICE,
  only_in_cloud: InferenceMode.ONLY_IN_CLOUD,
  prefer_in_cloud: InferenceMode.PREFER_IN_CLOUD,
};

const cache = new Map<string, GenerativeModel>();

export function getModel(mode: RouteMode, cloudModel: string, inputLanguages: string[]): GenerativeModel {
  const key = `${mode}|${cloudModel}|${inputLanguages.join(',')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const app = getFirebaseApp();
  if (!app) throw new Error('Firebase is not configured (mock mode).');
  const ai = getAI(app, { backend: new GoogleAIBackend() });
  const model = getGenerativeModel(ai, {
    mode: MODE[mode],
    inCloudParams: {
      model: cloudModel,
      generationConfig: { responseMimeType: 'application/json', responseSchema: tenderSchema, temperature: 0.1 },
    },
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: inputLanguages }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      },
      promptOptions: { responseConstraint: tenderSchema },
    },
  });
  cache.set(key, model);
  return model;
}

/**
 * Must run inside a user gesture (button click). Starts the Gemini Nano download if needed and
 * reports progress. Requests made before the download finishes fall back to the cloud (PREFER_ON_DEVICE).
 */
export function warmUpOnDevice(cloudModel: string, inputLanguages: string[], onProgress: (p: number) => void): Promise<void> {
  try {
    return getModel('prefer_on_device', cloudModel, inputLanguages).initializeDeviceModel(onProgress);
  } catch (e) {
    return Promise.reject(e);
  }
}

export interface HybridCall {
  output: ModelOutput;
  source: 'on-device' | 'cloud';
  raw: string;
}

export async function generateStructured(
  mode: RouteMode,
  cloudModel: string,
  inputLanguages: string[],
  prompt: string,
  pdf?: { base64: string; mimeType: string },
): Promise<HybridCall> {
  const model = getModel(mode, cloudModel, inputLanguages);
  const parts: (string | Part)[] = [prompt];
  if (pdf) parts.push({ type: 'inlineData', inlineData: { data: pdf.base64, mimeType: pdf.mimeType } });
  const result = await model.generateContent(parts);
  const raw = result.response.text();
  const source = result.response.inferenceSource === InferenceSource.ON_DEVICE ? 'on-device' : 'cloud';
  return { output: parseModelJson(raw), source, raw };
}
