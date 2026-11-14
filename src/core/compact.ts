// Shrinks a notice so it fits the on-device context window.
// Polish notices are full of boilerplate (GDPR clauses, platform manuals, sanctions law quotes).
// Dropping that locally is often the difference between "runs on Gemini Nano" and "needs the cloud".

const BOILERPLATE: RegExp[] = [
  /RODO|2016\/679|danych osobowych|Inspektor\p{L}* Ochrony Danych|ochrony osób fizycznych/iu,
  /Regulamin\p{L}* Platformy|Centrum Pomocy|Formularzy do komunikacji|maksymalny rozmiar plików/iu,
  /rozporządzeni\p{L}+ Prezesa Rady Ministrów w sprawie/iu,
  /beneficjent\p{L}* rzeczywist|jednostką dominującą|praniu pieniędzy/iu,
  /Personal data|data protection|cookies/i,
];

const KEYWORDS: RegExp[] = [
  /termin|deadline|godz\./i,
  /wadium|zabezpieczeni|guarantee|security/i,
  /warun\p{L}* udziału|selection criteri|zdolnoś|doświadczeni|experience/iu,
  /kryteri|award criteri|waga|weight|cena|price/i,
  /oświadcz|wykaz|dokument|załącznik|formularz|JEDZ|ESPD|referencj/i,
  /przedmiot\p{L}* zamówienia|description|opis/iu,
  /realizacji|duration|okres/i,
  /podpis|signature|platform/i,
];

/** BZP section numbers whose whole content is boilerplate. */
const BZP_DROP = /^\s*3\.(?:6|15|16)\.\)/;
const BZP_HEADER = /^\s*(?:SEKCJA|\d+\.\d+(?:\.\d+)*\.?\))/;

export function stripBoilerplate(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let dropping = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (BZP_HEADER.test(line)) dropping = BZP_DROP.test(line);
    if (dropping) continue;
    if (BOILERPLATE.some((re) => re.test(line))) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Returns text no longer than maxChars. Keeps the most relevant paragraphs in their original order.
 */
export function compactText(text: string, maxChars: number): string {
  const clean = stripBoilerplate(text);
  if (clean.length <= maxChars) return clean;

  const paras = clean.split('\n').map((p, i) => {
    const body = p.length > 1200 ? `${p.slice(0, 1200)}…` : p;
    let score = KEYWORDS.reduce((s, re) => s + (re.test(p) ? 2 : 0), 0);
    if (i < 15) score += 3; // title area
    if (BZP_HEADER.test(p)) score += 1;
    if (/\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4}|%|zł|PLN|EUR/.test(p)) score += 2;
    return { i, body, score };
  });

  const chosen = new Set<number>();
  let used = 0;
  for (const p of [...paras].sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (used + p.body.length + 1 > maxChars) continue;
    chosen.add(p.i);
    used += p.body.length + 1;
  }
  return paras.filter((p) => chosen.has(p.i)).map((p) => p.body).join('\n');
}

/** Split text into chunks of at most maxChars, on line boundaries where possible. */
export function chunkText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    const pieces = line.length > maxChars ? line.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, 'g')) ?? [] : [line];
    for (const piece of pieces) {
      if (cur.length + piece.length + 1 > maxChars && cur) {
        chunks.push(cur);
        cur = '';
      }
      cur = cur ? `${cur}\n${piece}` : piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
