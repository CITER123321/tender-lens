// Turning model output into the final summary, merging chunked on-device passes,
// and reconciling the model with the deterministic parser.

import { formatDeadline, normalizeAmount, parseDateTime } from './normalize';
import type { ModelOutput } from './prompt';
import type { Conflict, Criterion, ParsedFacts, TenderSummary } from './types';

export function modelToSummary(o: ModelOutput): TenderSummary {
  let deadline: string | null = null;
  if (o.deadlineDate) deadline = parseDateTime(`${o.deadlineDate} ${o.deadlineTime || ''}`.trim());
  const amount = o.depositAmount ? normalizeAmount(o.depositAmount, /eur/i.test(o.depositAmount) ? 'EUR' : 'PLN') : null;
  return {
    title: o.title,
    buyer: o.buyer,
    reference: o.reference,
    deadline,
    deposit: {
      required: o.depositRequired === 'yes' ? true : o.depositRequired === 'no' ? false : amount ? true : null,
      amount: o.depositRequired === 'no' ? null : amount,
    },
    conditions: o.conditions,
    criteria: o.criteria.map((c) => ({ name: c.name, weight: Number.isFinite(c.weight) ? c.weight : null })),
    documents: o.documents,
    summary: o.summary,
    redFlags: o.redFlags,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9ąćęłńóśźż]+/g, ' ').trim();

/** Merge lists, dropping near-duplicates (same words, or one contained in the other). */
export function mergeLists(...lists: string[][]): string[] {
  const out: string[] = [];
  const keys: string[] = [];
  for (const item of lists.flat()) {
    const k = norm(item);
    if (!k) continue;
    if (keys.some((x) => x === k || (x.length > 12 && k.includes(x)) || (k.length > 12 && x.includes(k)))) continue;
    keys.push(k);
    out.push(item.trim());
  }
  return out;
}

function mergeCriteria(...lists: Criterion[][]): Criterion[] {
  const out: Criterion[] = [];
  for (const c of lists.flat()) {
    const existing = out.find((x) => norm(x.name) === norm(c.name));
    if (existing) {
      if (existing.weight === null) existing.weight = c.weight;
    } else out.push({ ...c });
  }
  return out;
}

/** Combine the results of several on-device passes over parts of one long document. */
export function mergeChunkSummaries(parts: TenderSummary[]): TenderSummary {
  const pick = <T>(f: (p: TenderSummary) => T | null | undefined | '') => {
    for (const p of parts) {
      const v = f(p);
      if (v !== null && v !== undefined && v !== '') return v as T;
    }
    return undefined;
  };
  const depRequired = parts.some((p) => p.deposit.required === true)
    ? true
    : parts.some((p) => p.deposit.required === false)
      ? false
      : null;
  return {
    title: pick((p) => p.title) ?? '',
    buyer: pick((p) => p.buyer) ?? '',
    reference: pick((p) => p.reference) ?? '',
    deadline: pick((p) => p.deadline) ?? null,
    deposit: { required: depRequired, amount: depRequired ? pick((p) => p.deposit.amount) ?? null : null },
    conditions: mergeLists(...parts.map((p) => p.conditions)).slice(0, 10),
    criteria: mergeCriteria(...parts.map((p) => p.criteria)),
    documents: mergeLists(...parts.map((p) => p.documents)).slice(0, 14),
    summary: parts.map((p) => p.summary).filter(Boolean).slice(0, 2).join(' '),
    redFlags: mergeLists(...parts.map((p) => p.redFlags)).slice(0, 8),
  };
}

/**
 * Parser facts win for dates and money (regexes don't hallucinate). When the model disagrees,
 * the disagreement is reported so the user knows to double-check the notice.
 */
export function reconcile(model: TenderSummary, facts: ParsedFacts): { summary: TenderSummary; conflicts: Conflict[] } {
  const conflicts: Conflict[] = [];
  const s: TenderSummary = structuredClone(model);

  if (facts.deadline) {
    if (s.deadline && new Date(s.deadline).getTime() !== new Date(facts.deadline).getTime()) {
      conflicts.push({ field: 'deadline', parser: formatDeadline(facts.deadline), model: formatDeadline(s.deadline) });
    }
    s.deadline = facts.deadline;
  }
  if (facts.deposit) {
    const m = s.deposit;
    const differs = (m.required !== null && m.required !== facts.deposit.required) ||
      (!!m.amount && !!facts.deposit.amount && m.amount !== facts.deposit.amount);
    if (differs) {
      const show = (d: typeof m) => (d.required === false ? 'not required' : d.amount ?? (d.required ? 'required' : 'unknown'));
      conflicts.push({ field: 'deposit', parser: show(facts.deposit), model: show(m) });
    }
    s.deposit = { required: facts.deposit.required, amount: facts.deposit.amount ?? (facts.deposit.required ? m.amount : null) };
  }
  if (!s.title && facts.title) s.title = facts.title;
  if (!s.buyer && facts.buyer) s.buyer = facts.buyer;
  if (facts.reference) s.reference = facts.reference;
  const factWeights = (facts.criteria ?? []).reduce((a, c) => a + (c.weight ?? 0), 0);
  if (facts.criteria?.length && (Math.abs(factWeights - 100) < 0.5 || !s.criteria.length)) {
    // Keep the model's English names when it found the same number of criteria.
    s.criteria = facts.criteria.map((c, i) => ({
      name: s.criteria.length === facts.criteria!.length && s.criteria[i]?.name ? s.criteria[i].name : c.name,
      weight: c.weight,
    }));
  }
  s.documents = mergeLists(s.documents, facts.documents ?? []).slice(0, 16);
  if (!s.conditions.length && facts.conditions?.length) s.conditions = facts.conditions;
  return { summary: s, conflicts };
}

/** Used in mock mode and as the instant "parser only" preview before the model answers. */
export function summaryFromFacts(facts: ParsedFacts): TenderSummary {
  const bits: string[] = [];
  const dot = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
  if (facts.title) bits.push(dot(facts.title));
  if (facts.buyer) bits.push(dot(`Buyer: ${facts.buyer}`));
  return {
    title: facts.title ?? '',
    buyer: facts.buyer ?? '',
    reference: facts.reference ?? '',
    deadline: facts.deadline ?? null,
    deposit: facts.deposit ?? { required: null, amount: null },
    conditions: facts.conditions ?? [],
    criteria: facts.criteria ?? [],
    documents: facts.documents ?? [],
    summary: bits.join(' '),
    redFlags: [],
  };
}
