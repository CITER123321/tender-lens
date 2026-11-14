// Decides where a request runs. This is the heart of the hybrid design:
// short notices stay on the device (private, free, works offline), long specifications go to the cloud,
// and the user can forbid the cloud entirely (then long text is split into several on-device passes).

import { estimateTokens } from './normalize';
import type { NanoAvailability, Route } from './types';

export type Preference = 'auto' | 'local-only' | 'cloud-only';

export interface RouterConfig {
  /** Input tokens we allow for one on-device prompt. Chrome's window is ~9k tokens; we keep room for instructions and output. */
  onDeviceInputTokens: number;
  /** Upper limit of on-device passes in local-only mode. */
  maxLocalChunks: number;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = { onDeviceInputTokens: 4500, maxLocalChunks: 8 };

export interface RouteRequest {
  kind: 'page' | 'pdf';
  /** Text after boilerplate removal. */
  text: string;
  pdfPages?: number;
  /** False for scanned PDFs without a text layer. */
  pdfHasText?: boolean;
  preference: Preference;
  nano: NanoAvailability;
  online: boolean;
}

const nanoNote: Record<NanoAvailability, string> = {
  available: 'Gemini Nano is ready on this device',
  downloadable: 'Gemini Nano is not downloaded yet, so this run uses the cloud while the model downloads',
  downloading: 'Gemini Nano is still downloading, so this run uses the cloud',
  unavailable: 'Gemini Nano is not available on this device, so the SDK falls back to the cloud',
  'no-api': 'this browser has no on-device Prompt API, so the SDK falls back to the cloud',
};

export function decideRoute(req: RouteRequest, cfg: RouterConfig = DEFAULT_ROUTER_CONFIG): Route {
  const tokens = estimateTokens(req.text);
  const budget = cfg.onDeviceInputTokens;
  const fmt = (n: number) => n.toLocaleString('en-US');
  const size = `~${fmt(tokens)} tokens`;
  const pages = req.pdfPages ? `${req.pdfPages}-page PDF, ` : '';
  const nanoUsable = req.nano === 'available' || req.nano === 'downloadable' || req.nano === 'downloading';
  const base = { estimatedTokens: tokens, sendPdf: false, chunks: 1, blocked: false };

  if (req.preference === 'cloud-only') {
    if (!req.online) return { ...base, mode: 'only_in_cloud', blocked: true, reason: 'Cloud-only is selected, but you are offline.' };
    return { ...base, mode: 'only_in_cloud', sendPdf: req.kind === 'pdf', reason: `Cloud-only selected in settings (${pages}${size}).` };
  }

  if (req.kind === 'pdf' && req.pdfHasText === false) {
    if (req.preference === 'local-only' || !req.online) {
      return { ...base, mode: 'only_on_device', chunks: 0, blocked: true, reason: 'This PDF is a scan with no text layer. Only the cloud model can read it; allow cloud or go online.' };
    }
    return { ...base, mode: 'only_in_cloud', sendPdf: true, reason: `Scanned PDF (${pages.replace(', ', '')}) has no text layer, so the cloud model reads the file itself.` };
  }

  const chunks = Math.max(1, Math.ceil(tokens / budget));

  if (!req.online) {
    if (!nanoUsable) return { ...base, mode: 'only_on_device', chunks: 0, blocked: true, reason: 'You are offline and Gemini Nano is not available on this device.' };
    if (chunks > cfg.maxLocalChunks) return { ...base, mode: 'only_on_device', chunks: 0, blocked: true, reason: `Offline, and the text (${size}) is too long for on-device passes.` };
    return { ...base, mode: 'only_on_device', chunks, reason: `Offline: running on Gemini Nano${chunks > 1 ? ` in ${chunks} passes` : ''} (${size}).` };
  }

  if (tokens <= budget) {
    if (req.preference === 'local-only') {
      return { ...base, mode: 'only_on_device', reason: `Fits the on-device window (${size} of ${fmt(budget)}). Cloud is switched off.` };
    }
    return { ...base, mode: 'prefer_on_device', reason: `Fits the on-device window (${size} of ${fmt(budget)}); ${nanoNote[req.nano]}.` };
  }

  if (req.preference === 'local-only') {
    if (chunks > cfg.maxLocalChunks) {
      return { ...base, mode: 'only_on_device', chunks: 0, blocked: true, reason: `${pages}${size} would need ${chunks} on-device passes (limit ${cfg.maxLocalChunks}). Allow cloud for this document.` };
    }
    return { ...base, mode: 'only_on_device', chunks, reason: `${pages}${size} is over the on-device window, so it is split into ${chunks} local passes. Nothing leaves this computer.` };
  }

  if (req.kind === 'pdf') {
    return { ...base, mode: 'only_in_cloud', sendPdf: true, reason: `Long document (${pages}${size}) is over the on-device window (${fmt(budget)}), so the cloud model reads the original PDF.` };
  }
  return { ...base, mode: 'only_in_cloud', reason: `${size} after cleanup is over the on-device window (${fmt(budget)}), so it goes to the cloud.` };
}
