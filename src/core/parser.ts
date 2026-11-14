// Deterministic parser for tender notices. It runs before any model call:
//  - it gives the user an instant answer for the fields that have a fixed format,
//  - it feeds "hints" to the model (helps the small on-device model a lot),
//  - it double-checks the model on dates and money, which must never be hallucinated.

import { normalizeAmount, parseDateTime } from './normalize';
import type { Criterion, Deposit, ParsedFacts, SourceKind } from './types';

export function detectSource(url: string, text: string): SourceKind {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* not a URL */
  }
  if (host.endsWith('ezamowienia.gov.pl') || /Ogłoszenie nr \d{4}\/BZP \d+/.test(text)) return 'bzp';
  if (host.includes('bazakonkurencyjnosci')) return 'bk';
  if (host.endsWith('ted.europa.eu') || /Deadline for receipt of (tenders|requests)/.test(text)) return 'ted';
  if (/\.pdf($|[?#])/i.test(url)) return 'pdf';
  return 'generic';
}

const firstLine = (s: string | undefined) => (s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
const clip = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function grab(text: string, re: RegExp): string | undefined {
  const m = text.match(re);
  return m ? firstLine(m[1]) || undefined : undefined;
}

/** Like grab, but skips matches that are labels themselves ("albo umowy ramowej:", "1.1.) Rola …"). */
function grabValue(text: string, re: RegExp): string | undefined {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(g)) {
    const v = firstLine(m[1]).replace(/^[:\s]+/, '');
    if (v && !/:$/.test(v) && !/^\d+(\.\d+)*\.?\)/.test(v) && !/^(albo|oraz|lub|i)\b/i.test(v)) return clip(v, 200);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Deadline

const DEADLINE_PATTERNS: RegExp[] = [
  /8\.1\.\)\s*Termin składania ofert:\s*([^\n]+)/,
  /Termin składania (?:ofert|wniosków)[^\n\d]{0,80}\n?[^\n\d]{0,30}(\d[^\n]{0,70})/i,
  /Termin (?:złożenia|na złożenie) ofert[^\n\d]{0,80}\n?[^\n\d]{0,30}(\d[^\n]{0,70})/i,
  /ofert\p{L}*\s+(?:należy\s+)?(?:składać|złożyć|przesłać)[^\d\n]{0,80}(\d[^\n]{0,70})/iu,
  /(?:tender|bid|offer)s?\s+(?:submission\s+)?deadline[\s:|]*([^\n]{0,70})/i,
];

export function parseDeadline(text: string): { iso: string; quote: string } | null {
  // TED gives an explicit UTC offset: "30/11/2026 10:00:00 (UTC+01:00)"
  const ted = text.match(/Deadline for receipt of (?:tenders|requests to participate)[\s:|]*(\d{1,2}\/\d{1,2}\/\d{4})[\s|]*(\d{1,2}:\d{2})(?::\d{2})?\s*\(UTC([+-]\d{2}:\d{2})\)/);
  if (ted) {
    const iso = parseDateTime(`${ted[1]} ${ted[2]}`, ted[3]);
    if (iso) return { iso, quote: ted[0] };
  }
  for (const re of DEADLINE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const iso = parseDateTime(m[1]);
    if (iso) return { iso, quote: clip(m[0].replace(/\s+/g, ' ').trim(), 160) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bid security (wadium)

export function parseDeposit(text: string): { deposit: Deposit; quote: string } | null {
  const bzp = text.match(/6\.4\.\)\s*Zamawiający wymaga wadium:\s*(Tak|Nie)/);
  const none = text.match(/(?:nie\s+(?:wymaga|żąda|przewiduje)\s+(?:wniesienia\s+)?wadium|wadium\s+nie\s+(?:jest\s+)?(?:wymagane|jest\s+wymagane))/i);

  const amounts: string[] = [];
  const amountRe = /wadi(?:um|a)\b[^\n]{0,160}?(?:w\s+(?:wysokości|kwocie)|kwot[aęy]|wynosi)[\s:]*([\d][\d . ]*(?:,\d{2})?)\s*(zł|złotych|PLN|EUR|euro)/gi;
  for (const m of text.matchAll(amountRe)) {
    const currency = /eur/i.test(m[2]) ? 'EUR' : 'PLN';
    const n = normalizeAmount(m[1], currency);
    if (n && !amounts.includes(n)) amounts.push(n);
    if (amounts.length >= 4) break;
  }
  const short = text.match(/wadium[\s:]+([\d][\d . ]*(?:,\d{2})?)\s*(zł|PLN|EUR)/i);
  if (!amounts.length && short) {
    const n = normalizeAmount(short[1], /eur/i.test(short[2]) ? 'EUR' : 'PLN');
    if (n) amounts.push(n);
  }

  if (bzp) {
    const required = bzp[1] === 'Tak';
    return {
      deposit: { required, amount: required ? amounts.join(' / ') || null : null },
      quote: bzp[0],
    };
  }
  if (amounts.length) return { deposit: { required: true, amount: amounts.join(' / ') }, quote: `wadium … ${amounts[0]}` };
  if (none) return { deposit: { required: false, amount: null }, quote: none[0] };
  return null;
}

// ---------------------------------------------------------------------------
// Award criteria

export function parseCriteria(text: string): Criterion[] {
  const out: Criterion[] = [];
  // BZP: "4.3.5.) Nazwa kryterium: Cena ... 4.3.6.) Waga: 60"
  for (const m of text.matchAll(/4\.3\.5\.\)\s*Nazwa kryterium:\s*([^\n]+)[\s\S]{0,300}?4\.3\.6\.\)\s*Waga:\s*(\d+(?:[.,]\d+)?)/g)) {
    out.push({ name: m[1].trim(), weight: Number(m[2].replace(',', '.')) });
  }
  if (out.length) return out;

  // Free text near the word "kryteri" / "criteri": "Cena – 60%", "Termin realizacji: 40 pkt (40%)"
  const at = text.search(/kryteri|award criteri/i);
  if (at < 0) return out;
  const window = text.slice(at, at + 2500);
  // "Kryteria wyboru oferty: cena, znaczenie kryterium: 100 %" (Baza Konkurencyjności style)
  for (const m of window.matchAll(/(?:^|[:;.\n]\s*)([\p{L} ]{3,60}?),\s*(?:znaczenie|waga)(?: kryterium)?\s*[:–-]?\s*(\d{1,3}(?:[.,]\d+)?)\s*%/gu)) {
    const name = m[1].trim();
    if (out.some((c) => c.name.toLowerCase() === name.toLowerCase())) continue;
    out.push({ name: name.charAt(0).toUpperCase() + name.slice(1), weight: Number(m[2].replace(',', '.')) });
  }
  if (out.length) return out;
  const re = /(?:^|\n|\t|;)\s*(?:\d+[.)]\s*|[a-z]\)\s*|[-•]\s*)?([A-ZŁŚŻŹĆ„"][^\n:;%]{1,70}?)\s*(?:[–—:\-(]|\s)\s*(?:waga\s*|znaczenie(?: kryterium)?:?\s*)?(\d{1,3}(?:[.,]\d+)?)\s*(?:%|pkt|punkt)/gu;
  for (const m of window.matchAll(re)) {
    const name = m[1].replace(/^(?:kryteri\p{L}*|nazwa)\s*:?\s*/iu, '').replace(/[„"”]/g, '').trim();
    const weight = Number(m[2].replace(',', '.'));
    if (!name || weight > 100 || /^\d/.test(name)) continue;
    if (out.some((c) => c.name.toLowerCase() === name.toLowerCase())) continue;
    out.push({ name: clip(name, 80), weight });
    if (out.length >= 8) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Required documents: a small dictionary of what Polish notices usually ask for.

const DOCUMENTS: [RegExp, string][] = [
  [/formularz\p{L}*\s+ofert/iu, 'Offer form (formularz ofertowy)'],
  [/\bJEDZ\b|\bESPD\b|jednolit\p{L}+ europejsk\p{L}+ dokument/iu, 'ESPD / JEDZ'],
  [/art\.?\s*125\s*ust\.?\s*1/i, 'Declaration under Art. 125(1) Pzp (no exclusion, conditions met)'],
  [/grup\p{L}*\s+kapitałow/iu, 'Capital group declaration (Art. 108(1)(5) Pzp)'],
  [/aktualności informacji/i, 'Declaration that earlier statements are still valid'],
  [/wykaz\p{L}*\s+(?:wykonanych\s+)?(?:usług|robót|dostaw|zamówień)/iu, 'List of completed contracts with proof (e.g. references)'],
  [/wykaz\p{L}*\s+osób/iu, 'List of key staff'],
  [/Krajow\p{L}+ Rejestr\p{L}* Sądow|Centraln\p{L}+ Ewidencj|\bKRS\b|\bCEIDG\b/iu, 'Company register extract (KRS or CEIDG)'],
  [/pełnomocnictw/i, 'Power of attorney (if a proxy signs)'],
  [/oświadcz\p{L}*\s+o\s+braku\s+powiązań/iu, 'Declaration of no personal or capital links'],
  [/765\/2006|269\/2014|agresj\p{L}+ na Ukrainę/iu, 'Sanctions declaration (Russia/Belarus)'],
  [/przedmiotow\p{L}+\s+środk\p{L}+\s+dowodow/iu, 'Product evidence (specs, certificates)'],
  [/kosztorys\p{L}*\s+ofertow/iu, 'Priced bill of quantities (kosztorys ofertowy)'],
  [/polis\p{L}*|ubezpieczeni\p{L}*\s+od\s+odpowiedzialności/iu, 'Liability insurance policy'],
  [/oświadcz\p{L}*\s+o\s+(?:posiadanej\s+)?wiedzy\s+i\s+doświadczeni/iu, 'Declaration of knowledge and experience'],
  [/podpis\p{L}*\s+(?:kwalifikowan|zaufan|osobist)/iu, 'Qualified, trusted or personal e-signature'],
];

export function parseDocuments(text: string, depositRequired: boolean | null): string[] {
  const docs = DOCUMENTS.filter(([re]) => re.test(text)).map(([, label]) => label);
  if (depositRequired) docs.push('Proof of bid security (wadium)');
  return docs;
}

// ---------------------------------------------------------------------------
// Participation conditions (kept in the original language, the model translates them)

export function parseConditions(text: string): string[] {
  const bzpNo = /5\.3\.\)\s*Warunki udziału w postępowaniu:\s*Nie/.test(text);
  if (bzpNo) return ['No participation conditions (warunki udziału) set'];
  const m = text.match(/5\.4\.\)\s*Nazwa i opis warunków udziału w postępowaniu\.?\s*([\s\S]*?)(?:\n\s*5\.5\.\)|\n\s*SEKCJA)/);
  const block = m?.[1] ?? '';
  if (!block) return [];
  // Rendered pages lose the original line breaks, so split on list markers and sentence ends as well.
  return block
    .split(/\n|\t|;\s+|\s(?=[a-h]\)\s)|[:,]\s+(?=co najmniej\s)|\.\s+(?=[A-ZŁŚŻ][a-ząćęłńóśźż]+\s)/u)
    .map((l) => l.replace(/^[\s\-•\t]*(?:[a-z]\)|\d+\))?\s*/i, '').trim())
    .filter((l) => l.length > 25 && !/:$/.test(l) && !/^(?:przez|w przypadku|do\s+„?wartości|zamawiający dopuszcza|pod warunkiem)|kurs\S* walut|nbp\.pl/i.test(l))
    .slice(0, 8)
    .map((l) => clip(l, 320));
}

// ---------------------------------------------------------------------------

export function parseFacts(text: string, source: SourceKind): ParsedFacts {
  const facts: ParsedFacts = { source, evidence: {} };

  if (source === 'bzp') {
    facts.title = grab(text, /2\.3\.\)\s*Nazwa zamówienia albo umowy ramowej:\s*\n?\s*([^\n]+)/);
    facts.buyer = grab(text, /1\.2\.\)\s*Nazwa zamawiającego:\s*([^\n]+)/);
    const num = grab(text, /(?:Ogłoszenie nr|2\.5\.\) Numer ogłoszenia:)\s*(\d{4}\/BZP \d+)/);
    const ref = grab(text, /4\.1\.2\.\)\s*Numer referencyjny:\s*([^\n]+)/);
    facts.reference = [ref, num].filter(Boolean).join(' · ') || undefined;
  } else if (source === 'ted') {
    facts.title = grab(text, /\nTitle:\s*([^\n]+)/);
    facts.buyer = grab(text, /Official name:\s*([^\n]+)/);
    const pub = grab(text, /(\d{5,7}-\d{4}) - (?:Competition|Result|Planning)/);
    const internal = grab(text, /Internal identifier:\s*([^\n]+)/);
    facts.reference = [internal, pub ? `TED ${pub}` : undefined].filter(Boolean).join(' · ') || undefined;
  } else {
    facts.title = grabValue(text, /(?:Tytuł|Nazwa zamówienia|Przedmiot zamówienia)\s*:?\s*\n?\s*([^\n]{8,200})/i);
    facts.buyer = grabValue(text, /(?:Zamawiający|Nazwa zamawiającego|Ogłoszeniodawca)\s*:?\s*\n?\s*([^\n]{3,160})/i);
    facts.reference = grabValue(text, /(?:Numer ogłoszenia|Znak sprawy|Numer referencyjny|Nr postępowania)\s*:?\s*\n?\s*([^\n]{3,80})/i);
  }

  const deadline = parseDeadline(text);
  if (deadline) {
    facts.deadline = deadline.iso;
    facts.evidence.deadline = deadline.quote;
  }
  const dep = parseDeposit(text);
  if (dep) {
    facts.deposit = dep.deposit;
    facts.evidence.deposit = dep.quote;
  }
  const criteria = parseCriteria(text);
  if (criteria.length) facts.criteria = criteria;
  const conditions = parseConditions(text);
  if (conditions.length) facts.conditions = conditions;
  const docs = parseDocuments(text, facts.deposit?.required ?? null);
  if (docs.length) facts.documents = docs;
  return facts;
}
