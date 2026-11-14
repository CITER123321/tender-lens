// Getting notice text into the panel: the active tab, the Baza Konkurencyjności API, a selection or a PDF.

import { capturePage } from '../capture/capture';
import { bkApiUrl, bkAttachments, bkFacts, bkIdFromUrl, bkToText, type BkResponse } from '../core/bk';
import { detectSource, parseFacts } from '../core/parser';
import type { ParsedFacts, PdfLink, SourceKind } from '../core/types';
import { readPdf, type PdfInfo } from '../ai/pdf';

export interface Loaded {
  kind: 'page' | 'pdf';
  text: string;
  facts: ParsedFacts;
  url: string;
  sourceKind: SourceKind;
  pdfLinks: PdfLink[];
  pdf?: PdfInfo;
  label: string;
}

const MAX_PDF_BYTES = 18 * 1024 * 1024; // inline data limit for one Gemini request is ~20 MB

/**
 * The tab the panel works on. Normally the active tab of this window; `sidepanel.html?tabId=123`
 * pins the panel to one tab (used by the automated smoke test, which opens the panel as a normal tab).
 */
export async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const pinned = Number(new URLSearchParams(location.search).get('tabId'));
  if (pinned) return chrome.tabs.get(pinned).catch(() => undefined);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

export function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

export async function canRead(url: string | undefined): Promise<boolean> {
  const origin = url ? originPattern(url) : null;
  if (!origin) return false;
  return chrome.permissions.contains({ origins: [origin] });
}

/** Must be called from a click handler (permission prompts need a user gesture). */
export function requestRead(url: string): Promise<boolean> {
  const origin = originPattern(url);
  if (!origin) return Promise.resolve(false);
  return chrome.permissions.request({ origins: [origin] });
}

export const isPdfUrl = (url: string) => /\.pdf($|[?#])/i.test(url) || /\/api\/files\/\d+$/.test(url);

export async function loadFromTab(tab: chrome.tabs.Tab): Promise<Loaded> {
  const url = tab.url ?? '';
  if (isPdfUrl(url)) return loadPdf(await fetchPdf(url), url, url.split('/').pop() ?? 'PDF');

  const bkId = bkIdFromUrl(url);
  if (bkId) {
    const res = await fetch(bkApiUrl(bkId), { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const json = (await res.json()) as BkResponse;
      const text = bkToText(json);
      if (text) {
        return { kind: 'page', text, facts: bkFacts(json), url, sourceKind: 'bk', pdfLinks: bkAttachments(json), label: `Baza Konkurencyjności #${bkId}` };
      }
    }
    // fall through to DOM capture
  }

  let capture = await runCapture(tab.id!);
  if (capture.text.length < 400) {
    // Single-page apps (BZP, BK) render after load; give them a moment.
    await new Promise((r) => setTimeout(r, 1500));
    capture = await runCapture(tab.id!);
  }
  const sourceKind = detectSource(url, capture.text);
  return {
    kind: 'page',
    text: capture.text,
    facts: parseFacts(capture.text, sourceKind),
    url,
    sourceKind,
    pdfLinks: capture.pdfLinks,
    label: capture.title || url,
  };
}

async function runCapture(tabId: number) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: capturePage });
  if (!res?.result) throw new Error('Could not read this page.');
  return res.result;
}

export function loadSelection(text: string, url: string): Loaded {
  const sourceKind = detectSource(url, text);
  return {
    kind: 'page',
    text,
    facts: parseFacts(text, sourceKind === 'generic' ? 'selection' : sourceKind),
    url,
    sourceKind: 'selection',
    pdfLinks: [],
    label: 'Selected text',
  };
}

export async function fetchPdf(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_PDF_BYTES) throw new Error('This PDF is larger than 18 MB, which is too big for one request.');
  return buf;
}

export async function loadPdf(data: ArrayBuffer, url: string, label: string, onPage?: (n: number, total: number) => void): Promise<Loaded> {
  const head = new Uint8Array(data.slice(0, 5));
  if (String.fromCharCode(...head) !== '%PDF-') throw new Error('This file is not a PDF.');
  if (data.byteLength > MAX_PDF_BYTES) throw new Error('This PDF is larger than 18 MB, which is too big for one request.');
  const pdf = await readPdf(data, onPage);
  // A BZP or TED notice saved as PDF still has the numbered sections, so use that parser.
  const detected = detectSource('', pdf.text);
  const facts = parseFacts(pdf.text, detected === 'bzp' || detected === 'ted' ? detected : 'pdf');
  return { kind: 'pdf', text: pdf.text, facts, url, sourceKind: 'pdf', pdfLinks: [], pdf, label };
}
