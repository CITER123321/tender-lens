import { analyze, BlockedError, type Generate } from '../core/analyze';
import { buildChecklist, tenderId } from '../core/checklist';
import { buildIcs } from '../core/ics';
import { formatDeadline } from '../core/normalize';
import type { Preference } from '../core/router';
import type { AnalysisResult, ChecklistItem, NanoAvailability, WatchedTender } from '../core/types';
import { generateStructured, warmUpOnDevice } from '../ai/hybrid';
import { NANO_INPUT_LANGUAGES, nanoAvailability } from '../ai/nano';
import { toBase64 } from '../ai/pdf';
import { APP_CHECK_DEBUG, DEFAULT_CLOUD_MODEL, firebaseConfig, MOCK_AI } from '../firebase/app';
import { loadRuntimeConfig, type RuntimeConfig } from '../firebase/services';
import { getStore, type WatchStore } from '../store/watchlist';
import { countdown, el, ENGINE_LABEL, renderResult, renderWatchlist } from './render';
import { activeTab, canRead, fetchPdf, isPdfUrl, loadFromTab, loadPdf, loadSelection, requestRead, type Loaded } from './source';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  tab: undefined as chrome.tabs.Tab | undefined,
  loaded: undefined as Loaded | undefined,
  result: undefined as AnalysisResult | undefined,
  checklist: [] as ChecklistItem[],
  watched: new Map<string, WatchedTender>(),
  nano: 'no-api' as NanoAvailability,
  languages: ['en'],
  preference: 'auto' as Preference,
  config: undefined as RuntimeConfig | undefined,
  store: undefined as WatchStore | undefined,
  busy: false,
};

// ---------------------------------------------------------------------------
// Status helpers

function setStatus(msg: string, kind: 'info' | 'error' = 'info') {
  const s = $('status');
  s.textContent = msg;
  s.classList.toggle('error', kind === 'error');
}

function setProgress(p: number | null) {
  const wrap = $('progress');
  wrap.hidden = p === null;
  if (p !== null) $('progress-bar').style.width = `${Math.round(p * 100)}%`;
}

function setBusy(busy: boolean) {
  state.busy = busy;
  $<HTMLButtonElement>('analyze').disabled = busy;
}

function renderEnv() {
  const env = $('env');
  env.replaceChildren();
  if (MOCK_AI) env.append(el('span', { className: 'chip mock', textContent: 'Mock mode' }));
  else env.append(el('span', { className: 'chip cloud', textContent: 'Firebase' }));
  const nanoChip: Record<NanoAvailability, [string, string]> = {
    available: ['ok', 'Nano ready'],
    downloadable: ['warn', 'Nano not downloaded'],
    downloading: ['warn', 'Nano downloading'],
    unavailable: ['mock', 'No Nano: cloud'],
    'no-api': ['mock', 'No Nano: cloud'],
  };
  const [cls, label] = nanoChip[state.nano];
  env.append(el('span', { className: `chip ${cls}`, textContent: label, title: 'Gemini Nano availability on this computer' }));
}

// ---------------------------------------------------------------------------
// Tabs

function showView(name: 'page' | 'watch' | 'settings') {
  for (const v of ['page', 'watch', 'settings'] as const) {
    $(`view-${v}`).hidden = v !== name;
    $(`tab-${v}`).setAttribute('aria-selected', String(v === name));
  }
  if (name === 'watch') void refreshWatchlist();
  if (name === 'settings') void renderDiagnostics();
}

// ---------------------------------------------------------------------------
// Reading the active tab

const KIND_LABEL: Record<string, string> = {
  bzp: 'BZP · e-Zamówienia',
  bk: 'Baza Konkurencyjności',
  ted: 'TED · EU',
  pdf: 'PDF document',
  selection: 'Selected text',
  generic: 'Web page',
};

async function refreshTab() {
  const tab = await activeTab();
  state.tab = tab;
  const url = tab?.url ?? '';
  $('source-url').textContent = url.replace(/^https?:\/\//, '');
  $('source-url').title = url;
  const readable = await canRead(url);
  $('grant').hidden = readable || !/^https?:/.test(url);
  $('quick').hidden = true;
  $('source-kind').textContent = /^https?:/.test(url) ? (readable ? 'Ready' : 'Needs access') : 'Not a web page';
  if (readable && !state.busy) {
    try {
      state.loaded = await loadFromTab(tab!);
      showQuickFacts(state.loaded);
    } catch {
      /* page not ready or restricted; the Analyze button will retry */
    }
  }
}

function showQuickFacts(l: Loaded) {
  $('source-kind').textContent = KIND_LABEL[l.sourceKind] ?? l.sourceKind;
  $('source-url').textContent = l.kind === 'pdf' ? l.label : l.url.replace(/^https?:\/\//, '');
  $('source-url').title = l.url;
  const f = l.facts;
  const lines: [string, string][] = [];
  if (f.title) lines.push(['Notice', f.title]);
  if (f.deadline) lines.push(['Deadline', `${formatDeadline(f.deadline)} (${countdown(f.deadline).text})`]);
  if (f.deposit) lines.push(['Bid security', f.deposit.required ? f.deposit.amount ?? 'required' : f.deposit.required === false ? 'not required' : 'not stated']);
  if (f.criteria?.length) lines.push(['Criteria', f.criteria.map((c) => `${c.name} ${c.weight ?? '?'}%`).join(', ')]);
  const quick = $('quick');
  quick.replaceChildren(
    ...lines.map(([k, v]) => el('div', {}, el('b', { textContent: `${k}: ` }), v)),
    el('div', { className: 'small muted', textContent: lines.length ? 'Instant preview from the local parser, no AI yet.' : 'No tender facts found by the parser on this page.' }),
  );
  quick.hidden = false;
  if (lines.length) $('empty').hidden = true;
  renderPdfLinks(l.pdfLinks);
}

function renderPdfLinks(links: { href: string; text: string }[]) {
  const ul = $('pdf-links');
  ul.replaceChildren();
  for (const link of links.slice(0, 12)) {
    const b = el('button', { textContent: `📄 ${link.text}`, title: link.href });
    b.addEventListener('click', () => void analyzePdfUrl(link.href, link.text));
    ul.append(el('li', {}, b));
  }
  if (links.length) ($('pdf-box') as HTMLDetailsElement).open = true;
}

// ---------------------------------------------------------------------------
// Analysis

function startNanoDownloadIfNeeded() {
  // Called synchronously inside the click handler: model download needs a user gesture.
  if (MOCK_AI || state.preference === 'cloud-only') return;
  if (state.nano !== 'downloadable' && state.nano !== 'downloading') return;
  setProgress(0);
  warmUpOnDevice(state.config?.cloudModel ?? DEFAULT_CLOUD_MODEL, state.languages, (p) => {
    setProgress(p);
    setStatus(`Downloading Gemini Nano: ${Math.round(p * 100)}% (this run uses the cloud meanwhile)`);
  })
    .then(async () => {
      setProgress(null);
      state.nano = await nanoAvailability(state.languages);
      renderEnv();
    })
    .catch((e) => {
      setProgress(null);
      console.warn('Gemini Nano download failed', e);
    });
}

function generator(): Generate | null {
  if (MOCK_AI) return null;
  const model = state.config?.cloudModel ?? DEFAULT_CLOUD_MODEL;
  return (mode, prompt, pdf) => generateStructured(mode, model, state.languages, prompt, pdf);
}

async function runAnalysis(load: () => Promise<Loaded>) {
  if (state.busy) return;
  setBusy(true);
  $('empty').hidden = true;
  try {
    setStatus('Reading the notice…');
    const loaded = await load();
    state.loaded = loaded;
    showQuickFacts(loaded);
    if (!loaded.text.trim() && !loaded.pdf) throw new Error('No text found on this page.');
    state.config ??= await loadRuntimeConfig();
    const result = await analyze(
      {
        kind: loaded.kind,
        text: loaded.text,
        facts: loaded.facts,
        url: loaded.url,
        sourceKind: loaded.sourceKind,
        pdf: loaded.pdf ? { pages: loaded.pdf.pages, hasText: loaded.pdf.hasText, base64: () => toBase64(loaded.pdf!.bytes) } : undefined,
        preference: state.preference,
        nano: state.nano,
        online: navigator.onLine,
        config: state.config,
        onStatus: (m) => setStatus(m),
      },
      { generate: generator() },
    );
    state.result = result;
    const id = tenderId(result.sourceUrl, result.summary.reference);
    const prev = state.watched.get(id)?.checklist ?? [];
    state.checklist = buildChecklist(result.summary, prev);
    drawResult();
    setStatus(`Done. ${ENGINE_LABEL[result.engine]}.`);
  } catch (e) {
    const msg = e instanceof BlockedError ? e.message : friendlyError(e);
    setStatus(msg, 'error');
    console.error(e);
  } finally {
    setBusy(false);
  }
}

function friendlyError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/app-check|appCheck|App Check|attestation/i.test(m)) return `App Check rejected the request. Register the debug token in the Firebase console (see README). ${m}`;
  if (/API key not valid|API_KEY_INVALID/i.test(m)) return 'The Firebase API key in .env is not valid. Copy the web app config from the Firebase console again and rebuild.';
  if (/api.*not.*enabled|API_NOT_ENABLED|PERMISSION_DENIED/i.test(m)) return `Firebase AI Logic is not enabled for this project, or the key is wrong. ${m}`;
  if (/Cannot access|cannot be scripted|chrome:\/\//i.test(m)) return 'Chrome does not let extensions read this page.';
  return m;
}

function drawResult() {
  const r = state.result;
  if (!r) return;
  const id = tenderId(r.sourceUrl, r.summary.reference);
  renderResult($('result'), r, {
    watched: state.watched.has(id),
    checklist: state.checklist,
    onToggle: () => void persistChecklist(id),
    onWatch: () => void toggleWatch(),
    onIcs: () => downloadIcs(id, r.summary.title, r.summary.deadline, r.sourceUrl, describe(r)),
    onCopy: () => void copySummary(r),
  });
}

function describe(r: AnalysisResult): string {
  const s = r.summary;
  return [
    s.title,
    s.buyer && `Buyer: ${s.buyer}`,
    s.reference && `Ref: ${s.reference}`,
    s.deadline && `Deadline: ${formatDeadline(s.deadline)}`,
    `Bid security: ${s.deposit.required ? s.deposit.amount ?? 'required' : s.deposit.required === false ? 'not required' : 'not stated'}`,
    s.criteria.length && `Criteria: ${s.criteria.map((c) => `${c.name} ${c.weight ?? '?'}%`).join(', ')}`,
    s.summary,
    s.redFlags.length && `Watch out:\n- ${s.redFlags.join('\n- ')}`,
    `Checklist:\n${state.checklist.map((c) => `[${c.done ? 'x' : ' '}] ${c.text}`).join('\n')}`,
    r.sourceUrl,
  ]
    .filter(Boolean)
    .join('\n');
}

async function copySummary(r: AnalysisResult) {
  await navigator.clipboard.writeText(describe(r));
  setStatus('Copied to the clipboard.');
}

function downloadIcs(id: string, title: string, deadline: string | null, url: string, description: string) {
  if (!deadline) return;
  const ics = buildIcs({ uid: id, title: title || 'Tender', deadline, url, description });
  const a = el('a', { href: URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })), download: `bid-deadline-${id}.ics` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  setStatus('Calendar file downloaded (reminders 3 days and 1 day before).');
}

// ---------------------------------------------------------------------------
// Watchlist

async function store(): Promise<WatchStore> {
  state.store ??= await getStore();
  return state.store;
}

async function refreshWatchlist() {
  try {
    const s = await store();
    const items = await s.list();
    state.watched = new Map(items.map((t) => [t.id, t]));
    $('watch-count').textContent = items.length ? `(${items.length})` : '';
    $('store-kind').textContent = s.kind === 'firestore' ? 'Synced with Cloud Firestore (anonymous account).' : 'Saved in this browser only (mock mode or Firestore not configured).';
    $('watch-empty').hidden = items.length > 0;
    renderWatchlist($('watch-list'), items, {
      onOpen: (t) => void chrome.tabs.create({ url: t.url }),
      onIcs: (t) => downloadIcs(t.id, t.title, t.deadline, t.url, `${t.title}\n${t.summary}\n${t.url}`),
      onRemove: async (t) => {
        await s.remove(t.id);
        await refreshWatchlist();
        drawResult();
      },
      onToggle: async (t) => {
        await s.updateChecklist(t.id, t.checklist);
      },
    });
  } catch (e) {
    $('store-kind').textContent = `Watchlist unavailable: ${friendlyError(e)}`;
  }
}

async function toggleWatch() {
  const r = state.result;
  if (!r) return;
  const s = await store();
  const id = tenderId(r.sourceUrl, r.summary.reference);
  if (state.watched.has(id)) {
    await s.remove(id);
    state.watched.delete(id);
    setStatus('Removed from the watchlist.');
  } else {
    const now = new Date().toISOString();
    const t: WatchedTender = {
      id,
      url: r.sourceUrl,
      source: r.sourceKind,
      title: r.summary.title,
      buyer: r.summary.buyer,
      reference: r.summary.reference,
      deadline: r.summary.deadline,
      deposit: r.summary.deposit,
      summary: r.summary.summary,
      checklist: state.checklist,
      engine: r.engine,
      createdAt: now,
      updatedAt: now,
    };
    await s.save(t);
    state.watched.set(id, t);
    setStatus(s.kind === 'firestore' ? 'Saved to your watchlist in Firestore.' : 'Saved to your watchlist (this browser).');
  }
  $('watch-count').textContent = state.watched.size ? `(${state.watched.size})` : '';
  drawResult();
}

async function persistChecklist(id: string) {
  if (!state.watched.has(id)) return;
  const s = await store();
  await s.updateChecklist(id, state.checklist);
}

// ---------------------------------------------------------------------------
// PDFs

async function analyzePdfUrl(url: string, label: string) {
  if (!(await canRead(url))) {
    const ok = await requestRead(url);
    if (!ok) return setStatus('Access to that site was not granted.', 'error');
  }
  startNanoDownloadIfNeeded();
  await runAnalysis(async () => {
    setStatus('Downloading the PDF…');
    const data = await fetchPdf(url);
    return loadPdf(data, url, label, (n, total) => setStatus(`Reading PDF page ${n} of ${total} locally…`));
  });
}

async function analyzePdfFile(file: File) {
  startNanoDownloadIfNeeded();
  await runAnalysis(async () => loadPdf(await file.arrayBuffer(), state.tab?.url ?? `file:${file.name}`, file.name, (n, total) => setStatus(`Reading PDF page ${n} of ${total} locally…`)));
}

// ---------------------------------------------------------------------------
// Settings and diagnostics

async function renderDiagnostics() {
  const rows: [string, string][] = [
    ['Mode', MOCK_AI ? 'Mock (no Firebase config in .env)' : 'Firebase AI Logic hybrid'],
    ['Firebase project', firebaseConfig.projectId ?? '—'],
    ['App Check', MOCK_AI ? '—' : APP_CHECK_DEBUG ? 'Debug provider (token from .env)' : 'Not configured: requests will be rejected'],
    ['Cloud model', state.config?.cloudModel ?? DEFAULT_CLOUD_MODEL],
    ['Remote Config', state.config?.source ?? 'not loaded yet'],
    ['On-device budget', `${(state.config?.onDeviceInputTokens ?? 4500).toLocaleString('en-US')} input tokens`],
    ['Nano input languages', state.languages.join(', ')],
    ['Chrome', navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? 'unknown'],
    ['Online', navigator.onLine ? 'yes' : 'no'],
  ];
  try {
    const s = await store();
    rows.push(['Watchlist storage', s.kind === 'firestore' ? 'Cloud Firestore' : 'chrome.storage.local']);
  } catch {
    rows.push(['Watchlist storage', 'error']);
  }
  $('diag').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
  const detail: Record<NanoAvailability, string> = {
    available: 'Available. Short notices are processed on this computer.',
    downloadable: 'Supported, but the model is not downloaded yet (about 2-4 GB of disk space). Press "Download model".',
    downloading: 'Downloading…',
    unavailable: 'Not available on this hardware or Chrome build. Everything still works: the SDK falls back to the cloud model.',
    'no-api': 'This Chrome has no Prompt API (needs desktop Chrome 139+). The cloud model is used instead.',
  };
  $('nano-detail').textContent = detail[state.nano];
}

async function loadPrefs() {
  try {
    const { preference } = await chrome.storage.local.get('preference');
    if (preference === 'auto' || preference === 'local-only' || preference === 'cloud-only') state.preference = preference;
  } catch {
    /* defaults */
  }
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="pref"]')) {
    r.checked = r.value === state.preference;
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      state.preference = r.value as Preference;
      await chrome.storage.local.set({ preference: state.preference });
    });
  }
}

async function checkNano() {
  state.languages = NANO_INPUT_LANGUAGES;
  state.nano = await nanoAvailability(state.languages);
  renderEnv();
}

// ---------------------------------------------------------------------------
// Context menu hand-off (selection or PDF link)

async function handlePending() {
  const { pending } = (await chrome.storage.session.get('pending')) as { pending?: { type: string; text: string; url: string; at: number } };
  if (!pending || Date.now() - pending.at > 60_000) return;
  await chrome.storage.session.remove('pending');
  showView('page');
  if (pending.type === 'selection' && pending.text) {
    await runAnalysis(async () => loadSelection(pending.text, pending.url));
  } else if (pending.type === 'pdf-link' && pending.url) {
    await analyzePdfUrl(pending.url, pending.url.split('/').pop() ?? 'PDF');
  }
}

// ---------------------------------------------------------------------------
// Wiring

function wire() {
  $('tab-page').addEventListener('click', () => showView('page'));
  $('tab-watch').addEventListener('click', () => showView('watch'));
  $('tab-settings').addEventListener('click', () => showView('settings'));

  $('analyze').addEventListener('click', () => {
    startNanoDownloadIfNeeded();
    const tab = state.tab;
    if (!tab) return setStatus('No active tab.', 'error');
    if (tab.url && isPdfUrl(tab.url)) return void analyzePdfUrl(tab.url, tab.url.split('/').pop() ?? 'PDF');
    void runAnalysis(async () => {
      if (!(await canRead(tab.url))) throw new Error('Press "Allow this site" first so Tender Lens can read the page.');
      return loadFromTab(tab);
    });
  });

  $('grant').addEventListener('click', async () => {
    const url = state.tab?.url;
    if (!url) return;
    if (await requestRead(url)) await refreshTab();
  });

  const file = $<HTMLInputElement>('pdf-file');
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (f) void analyzePdfFile(f);
    file.value = '';
  });
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) void analyzePdfFile(f);
  });

  $('nano-check').addEventListener('click', async () => {
    await checkNano();
    await renderDiagnostics();
  });
  $('nano-download').addEventListener('click', () => {
    if (MOCK_AI) return setStatus('Mock mode: configure Firebase to use the hybrid model.', 'error');
    setProgress(0);
    warmUpOnDevice(state.config?.cloudModel ?? DEFAULT_CLOUD_MODEL, state.languages, (p) => {
      setProgress(p);
      $('nano-detail').textContent = `Downloading Gemini Nano: ${Math.round(p * 100)}%`;
    })
      .then(checkNano)
      .then(renderDiagnostics)
      .catch((e) => ($('nano-detail').textContent = `Download failed: ${friendlyError(e)}`))
      .finally(() => setProgress(null));
  });

  chrome.tabs.onActivated.addListener(() => void refreshTab());
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'complete' && tabId === state.tab?.id) void refreshTab();
  });
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.pending?.newValue) void handlePending();
  });
  window.addEventListener('online', renderEnv);
  window.addEventListener('offline', renderEnv);
}

async function init() {
  wire();
  renderEnv();
  await loadPrefs();
  await checkNano();
  await refreshTab();
  void handlePending();
  void refreshWatchlist();
  if (!MOCK_AI) loadRuntimeConfig().then((c) => (state.config = c)).catch(() => {});
}

void init();
