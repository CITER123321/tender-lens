// The analysis pipeline: parse -> clean -> route -> model(s) -> merge -> reconcile.
// The model call is injected, so this file is pure and fully unit-tested (see test/analyze.test.ts).

import { chunkText, compactText, stripBoilerplate } from './compact';
import { mergeChunkSummaries, modelToSummary, reconcile, summaryFromFacts } from './merge';
import { estimateTokens, timeLeft } from './normalize';
import { buildPrompt, type ModelOutput } from './prompt';
import { decideRoute, type Preference, type RouterConfig } from './router';
import type { AnalysisResult, Engine, NanoAvailability, ParsedFacts, Route, RouteMode, SourceKind, TenderSummary } from './types';

export interface GenerateResult {
  output: ModelOutput;
  source: 'on-device' | 'cloud';
}

export type Generate = (mode: RouteMode, prompt: string, pdf?: { base64: string; mimeType: string }) => Promise<GenerateResult>;

export interface AnalyzeInput {
  kind: 'page' | 'pdf';
  text: string;
  facts: ParsedFacts;
  url: string;
  sourceKind: SourceKind;
  pdf?: { pages: number; hasText: boolean; base64?: () => Promise<string> };
  preference: Preference;
  nano: NanoAvailability;
  online: boolean;
  config: RouterConfig & { cloudModel: string };
  onStatus?: (message: string) => void;
}

export interface AnalyzeDeps {
  /** null = mock mode (no model at all). */
  generate: Generate | null;
  now?: () => number;
}

export class BlockedError extends Error {
  constructor(public route: Route) {
    super(route.reason);
  }
}

export async function analyze(input: AnalyzeInput, deps: AnalyzeDeps): Promise<AnalysisResult> {
  const now = deps.now ?? (() => performance.now());
  const t0 = now();
  const status = input.onStatus ?? (() => {});
  const budget = input.config.onDeviceInputTokens;

  // 1. Local cleanup. In Auto mode, pages that are only a bit too long get trimmed to stay on the device.
  //    (On-device-only mode splits them into several passes instead, so nothing is dropped.)
  let working = stripBoilerplate(input.text);
  let note = '';
  const before = estimateTokens(working);
  if (input.kind === 'page' && input.preference === 'auto' && before > budget && before <= budget * 2) {
    working = compactText(working, budget * 3);
    note = ` Trimmed low-relevance lines locally (~${before.toLocaleString('en-US')} → ~${estimateTokens(working).toLocaleString('en-US')} tokens).`;
  }

  // 2. Route.
  const route = decideRoute(
    { kind: input.kind, text: working, pdfPages: input.pdf?.pages, pdfHasText: input.pdf?.hasText, preference: input.preference, nano: input.nano, online: input.online },
    input.config,
  );
  route.reason += note;

  // 3. Mock mode: parser only, no model.
  if (!deps.generate) {
    status('Mock mode: parser only, no model call.');
    route.reason = `Mock mode, no model was called. With Firebase configured: ${route.reason}`;
    const summary = mockSummary(input.facts);
    return finish(summary, 'mock', 'parser only (mock mode)', route, [], input, t0, now);
  }
  if (route.blocked) throw new BlockedError(route);

  // 4. Model call(s).
  const generate = deps.generate;
  const parts: TenderSummary[] = [];
  let engine: Engine = 'cloud';

  if (route.sendPdf && input.pdf?.base64) {
    status('Sending the PDF to the cloud model…');
    const r = await generate(route.mode, buildPrompt('(The full document is attached as a PDF.)', input.facts), {
      base64: await input.pdf.base64(),
      mimeType: 'application/pdf',
    });
    parts.push(modelToSummary(r.output));
    engine = r.source;
  } else {
    const chunks = route.chunks > 1 ? chunkText(working, budget * 3) : [working];
    for (let i = 0; i < chunks.length; i++) {
      status(chunks.length > 1 ? `On-device pass ${i + 1} of ${chunks.length}…` : route.mode === 'only_in_cloud' ? 'Asking the cloud model…' : 'Running Gemini Nano (cloud fallback if needed)…');
      const prompt = buildPrompt(chunks[i], input.facts, { index: i + 1, total: chunks.length });
      let r: GenerateResult;
      try {
        r = await generate(route.mode, prompt);
      } catch (e) {
        // Gemini Nano can fail (bad JSON, context overflow, model crash). In PREFER mode, retry in the cloud.
        if (route.mode !== 'prefer_on_device' || !input.online) throw e;
        status('On-device answer failed, retrying in the cloud…');
        route.reason += ` On-device attempt failed (${(e as Error).message.slice(0, 80)}), retried in the cloud.`;
        r = await generate('only_in_cloud', buildPrompt(working, input.facts));
      }
      parts.push(modelToSummary(r.output));
      engine = r.source;
    }
  }

  const merged = parts.length > 1 ? mergeChunkSummaries(parts) : parts[0];
  const { summary, conflicts } = reconcile(merged, input.facts);
  const model = engine === 'on-device' ? 'Gemini Nano (Chrome built-in)' : input.config.cloudModel;
  return finish(summary, engine, model, route, conflicts, input, t0, now);
}

function finish(
  summary: TenderSummary,
  engine: Engine,
  model: string,
  route: Route,
  conflicts: AnalysisResult['conflicts'],
  input: AnalyzeInput,
  t0: number,
  now: () => number,
): AnalysisResult {
  return { summary, facts: input.facts, engine, route, conflicts, model, ms: Math.round(now() - t0), sourceUrl: input.url, sourceKind: input.sourceKind };
}

/** What the UI shows when no model is configured: parser facts plus a few rule-based warnings. */
export function mockSummary(facts: ParsedFacts, at: Date = new Date()): TenderSummary {
  const s = summaryFromFacts(facts);
  const flags: string[] = [];
  if (facts.deadline) {
    const left = timeLeft(facts.deadline, at);
    if (!left.past && left.days < 7) flags.push(`Only ${left.days} days left to bid.`);
    if (left.past) flags.push('The bid deadline has passed.');
  }
  if (facts.deposit?.required) flags.push(`Bid security ${facts.deposit.amount ?? ''} must be paid before the deadline.`.replace('  ', ' '));
  if (facts.documents?.some((d) => /completed contracts/.test(d))) flags.push('References for completed contracts are required.');
  if (facts.documents?.some((d) => /key staff/.test(d))) flags.push('Named key staff are required.');
  s.redFlags = flags;
  s.summary = `${s.summary} (Mock mode: summary from the built-in parser only. Configure Firebase to get the AI summary.)`.trim();
  return s;
}
