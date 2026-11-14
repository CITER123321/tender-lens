// Smoke test: loads dist/ into a throwaway Chrome profile, checks the service worker starts,
// opens the side panel page and runs three analyses (selection, live Baza Konkurencyjności page, PDF).
// Usage: npm run build:mock && npm run smoke  (set CHROME_PATH if Chrome is not in the default place)
// Never touches your normal Chrome profile.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const shots = join(root, 'devpost', 'screenshots');
mkdirSync(shots, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = mkdtempSync(join(tmpdir(), 'tender-lens-smoke-'));
const problems = [];
const log = (...a) => console.log('[smoke]', ...a);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.HEADFUL ? false : true,
  pipe: true,
  enableExtensions: true,
  userDataDir: profile,
  defaultViewport: { width: 420, height: 900, deviceScaleFactor: 2 },
  args: ['--no-first-run', '--no-default-browser-check', '--lang=en-US'],
});

try {
  const id = await browser.installExtension(dist);
  log('extension id', id);
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${id}/`), { timeout: 15000 });
  log('service worker running:', sw.url());
  const worker = await sw.worker();
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  log('manifest loaded:', manifest.name, manifest.version);

  const watch = (page, name) => {
    page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`${name} console.error: ${m.text()}`);
    });
  };

  // 1) Selected text from any page (context-menu flow).
  const panel = await browser.newPage();
  watch(panel, 'panel');
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForSelector('#env .chip');
  const notice = [
    'Zapytanie ofertowe nr 3/2026',
    'Zamawiający: Gmina Przykładowo',
    'Przedmiot zamówienia: Wykonanie strony internetowej gminy wraz z systemem CMS.',
    'Termin składania ofert: 15.12.2026 r. do godz. 10:00',
    'Zamawiający wymaga wniesienia wadium w wysokości 2 000,00 zł.',
    'Kryteria oceny ofert: 1. Cena – 60% 2. Termin realizacji – 40%',
    'Do oferty należy dołączyć: formularz ofertowy, wykaz usług wraz z referencjami, oświadczenie o braku powiązań.',
  ].join('\n');
  await panel.evaluate((text) => chrome.storage.session.set({ pending: { type: 'selection', text, url: 'https://example.org/zapytanie', at: Date.now() } }), notice);
  await panel.waitForSelector('#result:not([hidden]) .title', { timeout: 15000 });
  const sel = await panel.evaluate(() => ({
    engine: document.querySelector('.engine-pill')?.textContent,
    deadline: document.querySelector('.deadline .value')?.textContent,
    deposit: document.querySelector('.deposit .value')?.textContent,
    checklist: document.querySelectorAll('.checklist li').length,
  }));
  log('selection result', sel);
  if (!/15 Dec 2026, 10:00/.test(sel.deadline ?? '')) problems.push(`selection: wrong deadline ${sel.deadline}`);
  if (sel.deposit !== '2 000,00 PLN') problems.push(`selection: wrong deposit ${sel.deposit}`);
  await panel.screenshot({ path: join(shots, '01-selection-mock.png'), fullPage: true });

  // Watch it, then check the watchlist tab.
  await panel.click('.act-watch');
  await panel.waitForFunction(() => document.querySelector('.act-watch')?.textContent?.includes('Watching'));
  await panel.click('#tab-watch');
  await panel.waitForSelector('#watch-list li');
  await panel.screenshot({ path: join(shots, '02-watchlist.png'), fullPage: true });
  await panel.click('#tab-settings');
  await panel.waitForSelector('#diag dt');
  await panel.screenshot({ path: join(shots, '03-settings.png'), fullPage: true });
  await panel.click('#tab-page');

  // 2) Live Baza Konkurencyjności notice (public JSON API), panel pinned to that tab.
  if (!process.env.OFFLINE) {
    const bk = await browser.newPage();
    await bk.goto('https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/ogloszenia/297362', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => problems.push(`bk goto: ${e.message}`));
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/*' }))[0]?.id);
    const p2 = await browser.newPage();
    watch(p2, 'panel-bk');
    await p2.goto(`chrome-extension://${id}/sidepanel.html?tabId=${tabId}`);
    await p2.waitForSelector('#analyze');
    await p2.waitForFunction(() => !document.querySelector('#quick')?.hidden || document.querySelector('#status')?.textContent, { timeout: 20000 }).catch(() => {});
    await p2.click('#analyze');
    await p2.waitForSelector('#result:not([hidden]) .title', { timeout: 30000 }).catch((e) => problems.push(`bk analyze: ${e.message}`));
    const r = await p2.evaluate(() => ({
      kind: document.querySelector('#source-kind')?.textContent,
      title: document.querySelector('.title')?.textContent,
      deadline: document.querySelector('.deadline .value')?.textContent,
      pdfs: document.querySelectorAll('#pdf-links li').length,
      status: document.querySelector('#status')?.textContent,
    }));
    log('BK result', r);
    await p2.screenshot({ path: join(shots, '04-bk-live-mock.png'), fullPage: true });
  }

  // 3) PDF upload: print a saved BZP notice to PDF, then feed it to the file input (pdf.js worker inside the extension).
  const printer = await browser.newPage();
  await printer.setContent(readFileSync(join(root, 'test/fixtures/bzp-works-deposit.html'), 'utf8'));
  const pdfPath = join(profile, 'notice.pdf');
  writeFileSync(pdfPath, await printer.pdf({ format: 'A4' }));
  await printer.close();
  await panel.bringToFront();
  const input = await panel.$('#pdf-file');
  await input.uploadFile(pdfPath);
  await panel.waitForFunction(() => /Done|error|failed/i.test(document.querySelector('#status')?.textContent ?? '') && document.querySelector('.engine-meta'), { timeout: 30000 }).catch((e) => problems.push(`pdf: ${e.message}`));
  const pdf = await panel.evaluate(() => ({
    kind: document.querySelector('#source-kind')?.textContent,
    status: document.querySelector('#status')?.textContent,
    route: document.querySelector('.route')?.textContent,
    deadline: document.querySelector('.deadline .value')?.textContent,
    deposit: document.querySelector('.deposit .value')?.textContent,
  }));
  log('PDF result', pdf);
  if (pdf.deposit !== '21 000,00 PLN') problems.push(`pdf: wrong deposit ${pdf.deposit}`);
  await panel.screenshot({ path: join(shots, '05-pdf-mock.png'), fullPage: true });
} catch (e) {
  problems.push(`fatal: ${e.stack ?? e}`);
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}

if (problems.length) {
  console.error('[smoke] PROBLEMS:\n- ' + problems.join('\n- '));
  process.exit(1);
}
log('all good, screenshots in devpost/screenshots/');
