// Prompt and output contract shared by the on-device and the cloud model.

import { formatDeadline } from './normalize';
import type { ParsedFacts } from './types';

/** Raw JSON the model returns. Kept flat and string-heavy so the small on-device model copes. */
export interface ModelOutput {
  title: string;
  buyer: string;
  reference: string;
  deadlineDate: string;
  deadlineTime: string;
  depositRequired: 'yes' | 'no' | 'unknown';
  depositAmount: string;
  summary: string;
  conditions: string[];
  criteria: { name: string; weight: number }[];
  documents: string[];
  redFlags: string[];
}

/** Plain JSON schema. Converted to a Firebase `Schema` in src/ai, used as-is for validation here. */
export const OUTPUT_FIELDS = [
  'title', 'buyer', 'reference', 'deadlineDate', 'deadlineTime', 'depositRequired', 'depositAmount',
  'summary', 'conditions', 'criteria', 'documents', 'redFlags',
] as const;

const GLOSSARY = [
  'termin składania ofert = bid deadline',
  'wadium = bid security deposit',
  'warunki udziału = participation conditions',
  'kryteria oceny ofert = award criteria',
  'SWZ / zapytanie ofertowe = tender specification / request for quotation',
  'JEDZ = ESPD',
  'oświadczenie = signed declaration',
  'wykaz usług / robót = list of completed contracts',
  'zabezpieczenie należytego wykonania umowy = performance bond',
  'Zamawiający = buyer, Wykonawca = bidder',
].join('; ');

export function buildPrompt(text: string, facts: ParsedFacts, part?: { index: number; total: number }): string {
  const hints: string[] = [];
  if (facts.deadline) hints.push(`deadline = ${formatDeadline(facts.deadline)}`);
  if (facts.deposit) hints.push(`bid security required = ${facts.deposit.required === null ? 'unknown' : facts.deposit.required ? 'yes' : 'no'}${facts.deposit.amount ? `, amount ${facts.deposit.amount}` : ''}`);
  if (facts.criteria?.length) hints.push(`criteria = ${facts.criteria.map((c) => `${c.name} ${c.weight ?? '?'}%`).join(', ')}`);

  return [
    'You help a small company decide whether to bid in a public tender. Read the notice below (often in Polish) and fill the JSON fields in plain English.',
    'Rules:',
    '- Use only facts stated in the notice. If a field is not stated, use an empty string or an empty list.',
    '- deadlineDate as YYYY-MM-DD, deadlineTime as HH:MM (24h, local time of the notice).',
    '- depositAmount keeps the original currency, e.g. "21 000,00 PLN".',
    '- conditions, documents and redFlags: short English lines, at most 20 words each, at most 8 items.',
    '- criteria: name in English and weight in percent.',
    '- summary: 2-3 sentences: what is being bought, by whom, and anything unusual.',
    '- redFlags: things a small bidder could easily miss (tight deadline, references with minimum values, required staff, site visit, mandatory platform account, signature type, penalties).',
    `Glossary: ${GLOSSARY}.`,
    hints.length ? `Parser hints (from regular expressions, trust them for dates and money): ${hints.join('; ')}.` : '',
    part && part.total > 1 ? `This is part ${part.index} of ${part.total} of a longer document. Fill only what this part states.` : '',
    'NOTICE:',
    '"""',
    text,
    '"""',
  ].filter(Boolean).join('\n');
}

/** Tolerant parser for model output (handles ```json fences and missing fields). */
export function parseModelJson(raw: string): ModelOutput {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1];
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  const o = JSON.parse(s) as Partial<Record<string, unknown>>;

  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
  const list = (v: unknown) =>
    Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean).slice(0, 12) : typeof v === 'string' && v ? [v] : [];
  const dep = str(o.depositRequired).toLowerCase();

  return {
    title: str(o.title),
    buyer: str(o.buyer),
    reference: str(o.reference),
    deadlineDate: str(o.deadlineDate),
    deadlineTime: str(o.deadlineTime),
    depositRequired: dep === 'yes' || dep === 'true' ? 'yes' : dep === 'no' || dep === 'false' ? 'no' : 'unknown',
    depositAmount: str(o.depositAmount),
    summary: str(o.summary),
    conditions: list(o.conditions),
    criteria: Array.isArray(o.criteria)
      ? (o.criteria as unknown[])
          .map((c) => {
            const r = (c ?? {}) as Record<string, unknown>;
            return { name: str(r.name), weight: Number(r.weight) };
          })
          .filter((c) => c.name)
          .slice(0, 10)
      : [],
    documents: list(o.documents),
    redFlags: list(o.redFlags),
  };
}
