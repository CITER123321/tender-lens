import { describe, expect, it, vi } from 'vitest';
import { analyze, BlockedError, mockSummary, type Generate } from '../src/core/analyze';
import { buildChecklist, tenderId } from '../src/core/checklist';
import { chunkText, compactText, stripBoilerplate } from '../src/core/compact';
import { buildIcs, foldLine } from '../src/core/ics';
import { mergeChunkSummaries, reconcile } from '../src/core/merge';
import { normalizeAmount, parseDateTime, warsawOffset } from '../src/core/normalize';
import { buildPrompt, parseModelJson, type ModelOutput } from '../src/core/prompt';
import { DEFAULT_ROUTER_CONFIG, decideRoute } from '../src/core/router';
import { parseFacts } from '../src/core/parser';
import type { ParsedFacts, TenderSummary } from '../src/core/types';
import { captureFixture } from './helpers';

const out = (o: Partial<ModelOutput> = {}): ModelOutput => ({
  title: 'Website for a museum',
  buyer: 'Archaeological Museum in Kraków',
  reference: '',
  deadlineDate: '2026-11-24',
  deadlineTime: '11:00',
  depositRequired: 'no',
  depositAmount: '',
  summary: 'The museum is buying an extension of its web portal and mobile app.',
  conditions: ['Two portal projects worth at least PLN 250,000 in total in the last 5 years'],
  criteria: [{ name: 'Price', weight: 60 }, { name: 'Team experience', weight: 20 }, { name: 'Longer warranty', weight: 20 }],
  documents: ['List of key staff'],
  redFlags: ['Needs a project manager with two finished portal projects'],
  ...o,
});

const config = { ...DEFAULT_ROUTER_CONFIG, cloudModel: 'gemini-test' };
const bzp = captureFixture('bzp-it-portal.html', 'https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/x');
const bzpFacts = parseFacts(bzp.text, 'bzp');

describe('normalize', () => {
  it('Warsaw offset follows daylight saving time', () => {
    expect(warsawOffset(2026, 1, 15)).toBe('+01:00');
    expect(warsawOffset(2026, 7, 15)).toBe('+02:00');
    expect(warsawOffset(2026, 3, 29, 3, 0)).toBe('+02:00'); // after the spring change
  });
  it('rejects impossible dates', () => {
    expect(parseDateTime('31.02.2026')).toBeNull();
  });
  it('amount formats', () => {
    expect(normalizeAmount('21.000,00 zł')).toBe('21 000,00 PLN');
    expect(normalizeAmount('1 500')).toBe('1 500,00 PLN');
    expect(normalizeAmount('12000.50', 'EUR')).toBe('12 000,50 EUR');
  });
});

describe('router', () => {
  const base = { kind: 'page' as const, preference: 'auto' as const, nano: 'available' as const, online: true };
  const text = (tokens: number) => 'x'.repeat(tokens * 3);

  it('short notice -> prefer on-device', () => {
    const r = decideRoute({ ...base, text: text(1000) });
    expect(r.mode).toBe('prefer_on_device');
    expect(r.blocked).toBe(false);
  });
  it('Nano missing -> still prefer_on_device so the SDK falls back, and the reason says so', () => {
    const r = decideRoute({ ...base, nano: 'unavailable', text: text(1000) });
    expect(r.mode).toBe('prefer_on_device');
    expect(r.reason).toMatch(/falls back to the cloud/);
  });
  it('long page -> cloud', () => {
    expect(decideRoute({ ...base, text: text(20000) }).mode).toBe('only_in_cloud');
  });
  it('long PDF -> cloud reads the original file', () => {
    const r = decideRoute({ ...base, kind: 'pdf', pdfPages: 140, pdfHasText: true, text: text(90000) });
    expect(r).toMatchObject({ mode: 'only_in_cloud', sendPdf: true });
    expect(r.reason).toMatch(/140-page PDF/);
  });
  it('local-only splits long text into on-device passes, or blocks when too long', () => {
    expect(decideRoute({ ...base, preference: 'local-only', text: text(12000) })).toMatchObject({ mode: 'only_on_device', chunks: 3 });
    expect(decideRoute({ ...base, preference: 'local-only', text: text(90000) }).blocked).toBe(true);
  });
  it('scanned PDF needs the cloud', () => {
    expect(decideRoute({ ...base, kind: 'pdf', pdfHasText: false, text: '' })).toMatchObject({ mode: 'only_in_cloud', sendPdf: true });
    expect(decideRoute({ ...base, kind: 'pdf', pdfHasText: false, text: '', preference: 'local-only' }).blocked).toBe(true);
  });
  it('offline: on-device only, or blocked without Nano', () => {
    expect(decideRoute({ ...base, online: false, text: text(1000) }).mode).toBe('only_on_device');
    expect(decideRoute({ ...base, online: false, nano: 'no-api', text: text(1000) }).blocked).toBe(true);
  });
  it('cloud-only setting', () => {
    expect(decideRoute({ ...base, preference: 'cloud-only', text: text(10) }).mode).toBe('only_in_cloud');
  });
});

describe('compact', () => {
  it('drops GDPR and platform boilerplate from a BZP notice', () => {
    const clean = stripBoilerplate(bzp.text);
    expect(clean).not.toMatch(/RODO/);
    expect(clean).not.toMatch(/Regulamin Platformy/);
    expect(clean).toMatch(/8\.1\.\) Termin składania ofert/);
    expect(clean.length).toBeLessThan(bzp.text.length * 0.8);
  });
  it('compactText keeps the deadline and criteria within the budget', () => {
    const c = compactText(bzp.text, 6000);
    expect(c.length).toBeLessThanOrEqual(6000);
    expect(c).toMatch(/Termin składania ofert: 2026-11-24 11:00/);
    expect(c).toMatch(/4\.3\.6\.\) Waga/);
  });
  it('chunkText respects the size limit', () => {
    const chunks = chunkText(bzp.text, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 4000)).toBe(true);
    expect(chunks.join('\n').length).toBeGreaterThanOrEqual(bzp.text.length - chunks.length);
  });
});

describe('prompt and model output', () => {
  it('prompt carries parser hints and the glossary', () => {
    const p = buildPrompt('tekst', bzpFacts);
    expect(p).toMatch(/Parser hints/);
    expect(p).toMatch(/Tue, 24 Nov 2026, 11:00/);
    expect(p).toMatch(/wadium = bid security deposit/);
  });
  it('parses fenced JSON and fills gaps', () => {
    const o = parseModelJson('```json\n{"title":"A","depositRequired":"true","criteria":[{"name":"Price","weight":"100"}],"documents":"Offer form"}\n```');
    expect(o.title).toBe('A');
    expect(o.depositRequired).toBe('yes');
    expect(o.criteria).toEqual([{ name: 'Price', weight: 100 }]);
    expect(o.documents).toEqual(['Offer form']);
    expect(o.conditions).toEqual([]);
  });
});

describe('merge and reconcile', () => {
  const s = (p: Partial<TenderSummary>): TenderSummary => ({
    title: '', buyer: '', reference: '', deadline: null, deposit: { required: null, amount: null },
    conditions: [], criteria: [], documents: [], summary: '', redFlags: [], ...p,
  });
  it('merges chunk results without duplicates', () => {
    const m = mergeChunkSummaries([
      s({ title: 'T', documents: ['Offer form'], criteria: [{ name: 'Price', weight: 60 }] }),
      s({ deadline: '2026-11-24T11:00:00+01:00', documents: ['offer form', 'List of key staff'], deposit: { required: true, amount: '1 000,00 PLN' } }),
    ]);
    expect(m.title).toBe('T');
    expect(m.deadline).toBe('2026-11-24T11:00:00+01:00');
    expect(m.documents).toEqual(['Offer form', 'List of key staff']);
    expect(m.deposit).toEqual({ required: true, amount: '1 000,00 PLN' });
  });
  it('parser wins on dates and money and reports the conflict', () => {
    const facts: ParsedFacts = { source: 'bzp', evidence: {}, deadline: '2026-11-24T11:00:00+01:00', deposit: { required: true, amount: '21 000,00 PLN' } };
    const { summary, conflicts } = reconcile(s({ deadline: '2026-11-25T11:00:00+01:00', deposit: { required: true, amount: '2 100,00 PLN' } }), facts);
    expect(summary.deadline).toBe(facts.deadline);
    expect(summary.deposit.amount).toBe('21 000,00 PLN');
    expect(conflicts.map((c) => c.field)).toEqual(['deadline', 'deposit']);
  });
  it('keeps English criterion names from the model when the parser found the same criteria', () => {
    const { summary } = reconcile(s({ criteria: [{ name: 'Price', weight: 60 }, { name: 'Team', weight: 20 }, { name: 'Warranty', weight: 20 }] }), bzpFacts);
    expect(summary.criteria).toEqual([{ name: 'Price', weight: 60 }, { name: 'Team', weight: 20 }, { name: 'Warranty', weight: 20 }]);
  });
});

describe('analyze pipeline (fake model)', () => {
  const input = (over: Partial<Parameters<typeof analyze>[0]> = {}) => ({
    kind: 'page' as const, text: bzp.text, facts: bzpFacts, url: bzp.url, sourceKind: 'bzp' as const,
    preference: 'auto' as const, nano: 'available' as const, online: true, config, ...over,
  });

  it('BZP notice fits Gemini Nano after local cleanup and runs on-device', async () => {
    const generate = vi.fn<Generate>(async () => ({ output: out(), source: 'on-device' }));
    const r = await analyze(input(), { generate });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toBe('prefer_on_device');
    expect(r.engine).toBe('on-device');
    expect(r.model).toMatch(/Gemini Nano/);
    expect(r.summary.deadline).toBe('2026-11-24T11:00:00+01:00');
    expect(r.summary.reference).toBe('DA-271-6/26 · 2026/BZP 00529093');
    expect(r.conflicts).toEqual([]);
  });

  it('SDK fallback: same call, answered by the cloud', async () => {
    const generate = vi.fn<Generate>(async () => ({ output: out(), source: 'cloud' }));
    const r = await analyze(input({ nano: 'unavailable' }), { generate });
    expect(r.engine).toBe('cloud');
    expect(r.model).toBe('gemini-test');
  });

  it('on-device failure is retried in the cloud', async () => {
    const generate = vi.fn<Generate>(async (mode) => {
      if (mode === 'prefer_on_device') throw new Error('Unexpected token in JSON');
      return { output: out(), source: 'cloud' };
    });
    const r = await analyze(input(), { generate });
    expect(generate.mock.calls.map((c) => c[0])).toEqual(['prefer_on_device', 'only_in_cloud']);
    expect(r.engine).toBe('cloud');
    expect(r.route.reason).toMatch(/retried in the cloud/);
  });

  it('local-only long text: several on-device passes merged into one result', async () => {
    const long = `${bzp.text}\n${bzp.text.replace(/8\.1\.\)/g, 'x')}`.repeat(3);
    const generate = vi.fn<Generate>(async (_m, prompt) => ({
      output: out({ documents: [prompt.includes('part 1 of') ? 'Offer form' : 'List of key staff'] }),
      source: 'on-device',
    }));
    const r = await analyze(input({ text: long, preference: 'local-only' }), { generate });
    expect(generate.mock.calls.length).toBeGreaterThan(1);
    expect(generate.mock.calls.every((c) => c[0] === 'only_on_device')).toBe(true);
    expect(r.summary.documents).toEqual(expect.arrayContaining(['Offer form', 'List of key staff']));
  });

  it('long PDF goes to the cloud as a file', async () => {
    const generate = vi.fn<Generate>(async () => ({ output: out(), source: 'cloud' }));
    const base64 = vi.fn(async () => 'JVBERi0=');
    const r = await analyze(input({ kind: 'pdf', text: 'x'.repeat(200000), pdf: { pages: 150, hasText: true, base64 }, sourceKind: 'pdf' }), { generate });
    expect(generate.mock.calls[0][0]).toBe('only_in_cloud');
    expect(generate.mock.calls[0][2]).toEqual({ base64: 'JVBERi0=', mimeType: 'application/pdf' });
    expect(r.route.sendPdf).toBe(true);
  });

  it('blocked route throws a readable error', async () => {
    await expect(analyze(input({ online: false, nano: 'no-api' }), { generate: vi.fn() })).rejects.toBeInstanceOf(BlockedError);
  });

  it('mock mode returns parser facts and rule-based warnings', async () => {
    const r = await analyze(input(), { generate: null });
    expect(r.engine).toBe('mock');
    expect(r.summary.criteria).toHaveLength(3);
    expect(r.route.reason).toMatch(/^Mock mode/);
    const m = mockSummary(bzpFacts, new Date('2026-11-20T10:00:00+01:00'));
    expect(m.redFlags).toEqual(expect.arrayContaining(['Only 4 days left to bid.', 'Named key staff are required.']));
  });
});

describe('checklist and calendar', () => {
  const summary = mockSummary(parseFacts(captureFixture('bzp-works-deposit.html', 'https://ezamowienia.gov.pl/x').text, 'bzp'));

  it('checklist starts with the deposit and keeps ticks across re-analysis', () => {
    const first = buildChecklist(summary);
    expect(first[0].text).toBe('Pay the bid security (21 000,00 PLN) before the deadline');
    first[0].done = true;
    const again = buildChecklist(summary, first);
    expect(again[0].done).toBe(true);
    expect(new Set(again.map((i) => i.id)).size).toBe(again.length);
  });

  it('tender id is stable', () => {
    expect(tenderId('https://a/b?x=1', '')).toBe(tenderId('https://a/b?x=2', ''));
    expect(tenderId('u', 'REF-1')).not.toBe(tenderId('u', 'REF-2'));
  });

  it('ics: UTC times, two reminders, escaped text, folded lines', () => {
    const ics = buildIcs({
      uid: 't1', title: 'Rozbudowa remizy OSP; etap 1, 2', deadline: '2026-11-24T10:00:00+01:00',
      url: 'https://ezamowienia.gov.pl/x', description: 'Line 1\nLine 2', now: new Date('2026-11-14T12:00:00Z'),
    });
    expect(ics).toMatch(/DTEND:20261124T090000Z/);
    expect(ics).toMatch(/DTSTART:20261124T080000Z/);
    expect(ics).toMatch(/SUMMARY:Bid deadline: Rozbudowa remizy OSP\\; etap 1\\, 2/);
    expect(ics.match(/BEGIN:VALARM/g)).toHaveLength(2);
    expect(ics).toMatch(/TRIGGER;RELATED=END:-P3D/);
    expect(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(foldLine('ą'.repeat(60)).split('\r\n ').length).toBe(2);
  });
});

describe('on-device only keeps the whole notice', () => {
  const works = captureFixture('bzp-works-deposit.html', 'https://ezamowienia.gov.pl/x').text;
  it('a notice slightly over the window runs as several passes instead of being trimmed', async () => {
    const generate = vi.fn<Generate>(async () => ({ output: out(), source: 'on-device' }));
    const r = await analyze(
      { kind: 'page', text: `${bzp.text}
${works}`, facts: bzpFacts, url: bzp.url, sourceKind: 'bzp', preference: 'local-only', nano: 'available', online: true, config },
      { generate },
    );
    expect(generate.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(r.route.reason).toMatch(/local passes/);
    expect(r.route.reason).not.toMatch(/Trimmed/);
  });
});
