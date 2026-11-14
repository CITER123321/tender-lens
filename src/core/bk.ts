// Baza Konkurencyjności (bazakonkurencyjnosci.funduszeeuropejskie.gov.pl) is a single-page app with a
// public JSON API. When the user is on /ogloszenia/<id> we read the API instead of scraping the DOM.

import { parseCriteria, parseDocuments, parseDeposit } from './parser';
import { normalizeAmount, parseDateTime } from './normalize';
import type { ParsedFacts, PdfLink } from './types';

export const BK_ORIGIN = 'https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl';

export function bkIdFromUrl(url: string): string | null {
  const m = url.match(/bazakonkurencyjnosci\.funduszeeuropejskie\.gov\.pl\/ogloszenia\/(\d+)/);
  return m ? m[1] : null;
}

export const bkApiUrl = (id: string) => `${BK_ORIGIN}/api/announcements/${id}`;

/* Minimal shape of the parts of the API response we use. */
interface BkText { description?: string | null; type?: { name?: string } | null }
interface BkOrder {
  title?: string;
  estimated_value?: number | null;
  order_items?: { description?: string; participation_conditions?: BkText[] }[];
  evaluation_criteria?: BkText[];
}
interface BkAdvertisement {
  title?: string;
  submission_deadline?: string;
  publication_date?: string;
  advertiser_address_details?: { name?: string };
  advertisement?: { id?: number; number?: string };
  orders?: BkOrder[];
  attachments?: { name?: string; file?: { uri?: string } }[];
}
export interface BkResponse { data?: { advertisement?: BkAdvertisement } }

const meaningful = (s?: string | null) =>
  !!s && s.trim().length > 3 && !/nie opisuje i nie wyznacza|nie dotyczy|^brak\.?$/i.test(s.trim());

/** Flatten the API response into readable Polish text (what the model reads). */
export function bkToText(json: BkResponse): string {
  const a = json.data?.advertisement;
  if (!a) return '';
  const lines: string[] = [];
  lines.push(`Ogłoszenie Baza Konkurencyjności nr ${a.advertisement?.number ?? a.advertisement?.id ?? ''}`);
  lines.push(`Tytuł: ${a.title ?? ''}`);
  lines.push(`Zamawiający: ${a.advertiser_address_details?.name ?? ''}`);
  lines.push(`Data publikacji: ${a.publication_date ?? ''}`);
  lines.push(`Termin składania ofert: ${a.submission_deadline ?? ''}`);
  (a.orders ?? []).forEach((o, i) => {
    lines.push(`\nCzęść ${i + 1}: ${o.title ?? ''}`);
    if (o.estimated_value) lines.push(`Szacunkowa wartość: ${o.estimated_value} zł`);
    for (const item of o.order_items ?? []) {
      if (item.description) lines.push(`Przedmiot zamówienia: ${item.description.trim()}`);
      for (const c of item.participation_conditions ?? []) {
        if (meaningful(c.description)) lines.push(`Warunek udziału (${c.type?.name ?? 'inne'}): ${c.description!.trim()}`);
      }
    }
    for (const c of o.evaluation_criteria ?? []) {
      if (c.description) lines.push(`Kryteria oceny ofert: ${c.description.trim()}`);
    }
  });
  const att = (a.attachments ?? []).map((x) => x.name).filter(Boolean);
  if (att.length) lines.push(`\nZałączniki: ${att.join('; ')}`);
  return lines.join('\n');
}

export function bkAttachments(json: BkResponse): PdfLink[] {
  return (json.data?.advertisement?.attachments ?? [])
    .filter((x) => x.file?.uri)
    .map((x) => ({ href: `${BK_ORIGIN}${x.file!.uri}`, text: x.name ?? 'attachment' }));
}

export function bkFacts(json: BkResponse): ParsedFacts {
  const a = json.data?.advertisement ?? {};
  const text = bkToText(json);
  const facts: ParsedFacts = { source: 'bk', evidence: {} };
  facts.title = a.title?.trim();
  facts.buyer = a.advertiser_address_details?.name?.trim();
  facts.reference = a.advertisement?.number ? `BK ${a.advertisement.number}` : undefined;
  if (a.submission_deadline) {
    const iso = parseDateTime(a.submission_deadline);
    if (iso) {
      facts.deadline = iso;
      facts.evidence.deadline = `submission_deadline: ${a.submission_deadline}`;
    }
  }
  const all = (a.orders ?? [])
    .flatMap((o) => o.order_items ?? [])
    .flatMap((i) => i.participation_conditions ?? [])
    .filter((c) => meaningful(c.description));
  const isDocList = (c: BkText) => /dokument/i.test(c.type?.name ?? '');
  const isReservation = (c: BkText) => /^Zamawiający zastrzega/i.test(c.description!.trim());
  const conditions = all
    .filter((c) => !isDocList(c) && !isReservation(c))
    .map((c) => clip(c.description!.trim().replace(/\s+/g, ' '), 260));
  if (conditions.length) facts.conditions = [...new Set(conditions)].slice(0, 6);
  const docLines = all
    .filter(isDocList)
    .flatMap((c) => c.description!.split(/\n|,\s*\n?/))
    .map((l) => l.replace(/^[\s•\-⁠]+/, '').trim())
    .filter((l) => l.length > 5 && /^[A-ZŁŚŻŹĆ]/u.test(l) && !/:$/.test(l) && !/^Dodatkowo/i.test(l));
  const criteria = parseCriteria(text);
  if (criteria.length) facts.criteria = criteria;
  const dep = parseDeposit(text);
  if (dep) {
    facts.deposit = dep.deposit;
    facts.evidence.deposit = dep.quote;
  }
  const est = (a.orders ?? []).map((o) => o.estimated_value).find((v) => typeof v === 'number');
  if (est) facts.evidence.estimatedValue = normalizeAmount(String(est)) ?? String(est);
  const docs = parseDocuments(text, facts.deposit?.required ?? null);
  // Keep the buyer's own document list too (Polish; the model translates it).
  const extra = docLines.filter((l) => !parseDocuments(l, null).length).slice(0, 6);
  if (docs.length || extra.length) facts.documents = [...docs, ...extra];
  return facts;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
