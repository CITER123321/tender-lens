import type { ChecklistItem, TenderSummary } from './types';

/** Small stable hash so checklist ticks survive re-analysis of the same notice. */
export function hashId(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function buildChecklist(s: TenderSummary, previous: ChecklistItem[] = []): ChecklistItem[] {
  const items: string[] = [];
  if (s.deposit.required) items.push(`Pay the bid security${s.deposit.amount ? ` (${s.deposit.amount})` : ''} before the deadline`);
  for (const d of s.documents) items.push(`Prepare: ${d}`);
  for (const c of s.conditions.slice(0, 4)) items.push(`Check you meet: ${c}`);
  items.push('Submit the offer on the platform named in the notice');
  const done = new Map(previous.map((p) => [p.id, p.done]));
  const seen = new Set<string>();
  return items
    .map((text) => ({ id: hashId(text), text, done: false }))
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .map((i) => ({ ...i, done: done.get(i.id) ?? false }));
}

/** Stable id for a tender, used as the Firestore document id. */
export function tenderId(url: string, reference: string): string {
  const key = reference || url.replace(/[?#].*$/, '');
  return `t_${hashId(key)}${hashId(`${key}#`)}`;
}
