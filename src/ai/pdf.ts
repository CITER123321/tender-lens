// Local PDF text extraction (pdf.js runs inside the extension, nothing is uploaded at this step).

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfInfo {
  pages: number;
  text: string;
  /** False for scanned documents (images only). */
  hasText: boolean;
  bytes: Uint8Array;
}

const MAX_PAGES = 400;

export async function readPdf(data: ArrayBuffer, onPage?: (n: number, total: number) => void): Promise<PdfInfo> {
  const bytes = new Uint8Array(data.slice(0));
  // pdf.js may transfer the buffer it gets, so give it a copy.
  const task = getDocument({ data: bytes.slice(0), disableFontFace: true });
  const doc = await task.promise;
  const pages = doc.numPages;
  const out: string[] = [];
  for (let i = 1; i <= Math.min(pages, MAX_PAGES); i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      line += item.str;
      if (item.hasEOL) {
        out.push(line);
        line = '';
      } else line += ' ';
    }
    if (line.trim()) out.push(line);
    out.push('');
    onPage?.(i, pages);
  }
  await task.destroy();
  const text = out.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { pages, text, hasText: text.replace(/\s/g, '').length > Math.min(pages, MAX_PAGES) * 40, bytes };
}

export async function toBase64(bytes: Uint8Array): Promise<string> {
  const blob = new Blob([bytes as BlobPart]);
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(',') + 1);
}
