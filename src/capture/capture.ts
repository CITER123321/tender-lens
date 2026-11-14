import type { PageCapture } from '../core/types';

/**
 * Runs INSIDE the tender page via chrome.scripting.executeScript({ func: capturePage }).
 * It must stay self-contained: no imports, no closures over module variables.
 * It is also called directly from Vitest with a jsdom document.
 */
export function capturePage(): PageCapture {
  const BLOCK = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION',
    'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV',
    'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL', 'MAT-CARD', 'APP-ROOT',
  ]);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'BUTTON', 'SELECT', 'INPUT', 'TEXTAREA']);

  // Prefer the main content area when the site has one.
  const root: Element =
    document.querySelector('main') ??
    document.querySelector('[role="main"]') ??
    document.querySelector('#content, .content, app-root') ??
    document.body;

  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out.push((node.nodeValue ?? '').replace(/[ \t\r\n ]+/g, ' '));
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (SKIP.has(el.tagName)) return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    const block = BLOCK.has(el.tagName);
    if (block) out.push('\n');
    if (el.tagName === 'TD' || el.tagName === 'TH') out.push(' | ');
    for (const child of Array.from(el.childNodes)) walk(child);
    if (block) out.push('\n');
  };
  walk(root);

  const text = out
    .join('')
    .split('\n')
    .map((l) => l.replace(/^[ |]+|[ |]+$/g, '').replace(/ {2,}/g, ' '))
    .filter((l) => l.length > 0)
    .join('\n');

  const pdfLinks: { href: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    const href = (a as HTMLAnchorElement).href;
    const label = (a.textContent ?? '').trim().replace(/\s+/g, ' ');
    const looksPdf = /\.pdf($|[?#])/i.test(href) || /\.pdf\b/i.test(label) || /\/api\/files\/\d+/.test(href);
    if (looksPdf && !seen.has(href)) {
      seen.add(href);
      pdfLinks.push({ href, text: label.slice(0, 120) || href.split('/').pop() || href });
    }
  }

  return {
    url: location.href,
    title: document.title,
    text,
    pdfLinks: pdfLinks.slice(0, 40),
    selection: String(globalThis.getSelection?.() ?? '').trim(),
    capturedAt: new Date().toISOString(),
  };
}
