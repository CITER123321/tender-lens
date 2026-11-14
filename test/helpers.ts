import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { capturePage } from '../src/capture/capture';
import type { PageCapture } from '../src/core/types';

export const fixture = (name: string) => readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');

/** Load a saved notice into a jsdom window and run the same capture code the extension injects. */
export function captureFixture(name: string, url: string): PageCapture {
  const dom = new JSDOM(fixture(name), { url });
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, location: g.location, getSelection: g.getSelection };
  g.document = dom.window.document;
  g.location = dom.window.location;
  g.getSelection = () => '';
  try {
    return capturePage();
  } finally {
    Object.assign(g, saved);
    dom.window.close();
  }
}
