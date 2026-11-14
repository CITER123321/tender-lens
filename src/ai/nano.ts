import type { NanoAvailability } from '../core/types';

interface LanguageModelStatic {
  availability(options?: unknown): Promise<string>;
}

const lm = () => (globalThis as unknown as { LanguageModel?: LanguageModelStatic }).LanguageModel;

/** Asks Chrome's built-in Prompt API whether Gemini Nano can run here, without downloading anything. */
export async function nanoAvailability(inputLanguages: string[] = ['en']): Promise<NanoAvailability> {
  const api = lm();
  if (!api) return 'no-api';
  try {
    const a = await api.availability({
      expectedInputs: [{ type: 'text', languages: inputLanguages }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });
    return (['available', 'downloadable', 'downloading', 'unavailable'].includes(a) ? a : 'unavailable') as NanoAvailability;
  } catch {
    return 'unavailable';
  }
}

/**
 * Gemini Nano in Chrome 157 accepts these input languages: de, en, es, fr, ja. Polish is not on the list,
 * and asking for it makes Chrome abort the call. We declare English: the model still reads Polish text well
 * enough for extraction, and the parser hints keep dates and money right. Bump this when Chrome adds Polish.
 */
export const NANO_INPUT_LANGUAGES = ['en'];
