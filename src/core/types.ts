// Shared types. Everything in src/core is pure TypeScript with no browser or Firebase
// dependencies, so it runs the same in the side panel and in Vitest.

export type SourceKind = 'bzp' | 'bk' | 'ted' | 'pdf' | 'selection' | 'generic';

/** Which engine produced the final summary. */
export type Engine = 'on-device' | 'cloud' | 'mock';

export interface Criterion {
  name: string;
  /** Weight in percent, null when the notice does not say. */
  weight: number | null;
}

export interface Deposit {
  /** true = required, false = explicitly not required, null = notice does not say. */
  required: boolean | null;
  /** Amount as written, normalised to "21 000,00 PLN" style. */
  amount: string | null;
}

/** The structured result shown in the side panel and saved to the watchlist. */
export interface TenderSummary {
  title: string;
  buyer: string;
  reference: string;
  /** ISO 8601 with offset, e.g. 2026-11-24T11:00:00+01:00. Null when unknown. */
  deadline: string | null;
  deposit: Deposit;
  conditions: string[];
  criteria: Criterion[];
  documents: string[];
  summary: string;
  redFlags: string[];
}

/** Facts found by the deterministic parser. Every field is optional. */
export interface ParsedFacts {
  source: SourceKind;
  title?: string;
  buyer?: string;
  reference?: string;
  deadline?: string;
  deposit?: Deposit;
  criteria?: Criterion[];
  documents?: string[];
  conditions?: string[];
  questionsDeadline?: string;
  /** Short quotes (original language) that justify the facts above. */
  evidence: Record<string, string>;
}

export interface PdfLink {
  href: string;
  text: string;
}

/** What we read from the active tab. */
export interface PageCapture {
  url: string;
  title: string;
  text: string;
  pdfLinks: PdfLink[];
  selection: string;
  capturedAt: string;
}

export type NanoAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'no-api';

export type RouteMode = 'prefer_on_device' | 'only_on_device' | 'only_in_cloud' | 'prefer_in_cloud';

export interface Route {
  mode: RouteMode;
  /** How many on-device calls we will make (1 unless the text is chunked locally). */
  chunks: number;
  /** Send the original PDF bytes to the cloud model instead of extracted text. */
  sendPdf: boolean;
  /** Human-readable explanation shown in the UI. */
  reason: string;
  estimatedTokens: number;
  /** True when no engine may run this request (e.g. offline without Gemini Nano). */
  blocked: boolean;
}

export interface Conflict {
  field: 'deadline' | 'deposit';
  parser: string;
  model: string;
}

export interface AnalysisResult {
  summary: TenderSummary;
  facts: ParsedFacts;
  engine: Engine;
  route: Route;
  conflicts: Conflict[];
  model: string;
  ms: number;
  sourceUrl: string;
  sourceKind: SourceKind;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface WatchedTender {
  id: string;
  url: string;
  source: SourceKind;
  title: string;
  buyer: string;
  reference: string;
  deadline: string | null;
  deposit: Deposit;
  summary: string;
  checklist: ChecklistItem[];
  engine: Engine;
  createdAt: string;
  updatedAt: string;
}
