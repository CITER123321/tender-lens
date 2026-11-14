// Date and money helpers for Polish (and EU) procurement notices.

const PL_MONTHS: Record<string, number> = {
  stycznia: 1, styczeń: 1, styczen: 1,
  lutego: 2, luty: 2,
  marca: 3, marzec: 3,
  kwietnia: 4, kwiecień: 4, kwiecien: 4,
  maja: 5, maj: 5,
  czerwca: 6, czerwiec: 6,
  lipca: 7, lipiec: 7,
  sierpnia: 8, sierpień: 8, sierpien: 8,
  września: 9, wrzesnia: 9, wrzesień: 9, wrzesien: 9,
  października: 10, pazdziernika: 10, październik: 10, pazdziernik: 10,
  listopada: 11, listopad: 11,
  grudnia: 12, grudzień: 12, grudzien: 12,
};

export function monthFromPolish(word: string): number | null {
  return PL_MONTHS[word.toLowerCase()] ?? null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Offset of Europe/Warsaw for a given local wall-clock time, e.g. "+01:00" in winter
 * and "+02:00" in summer. Uses Intl so it follows the real DST rules.
 */
export function warsawOffset(year: number, month: number, day: number, hour = 12, minute = 0): string {
  // Treat the wall-clock time as UTC, then ask what Warsaw shows at that instant.
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw',
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  const offsetMin = Math.round((shown - guess) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Build an ISO string with an explicit offset. Defaults to Warsaw time. */
export function toIso(year: number, month: number, day: number, hour = 23, minute = 59, offset?: string): string | null {
  if (!isValidDate(year, month, day) || hour > 23 || minute > 59) return null;
  const off = offset ?? warsawOffset(year, month, day, hour, minute);
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${off}`;
}

export function isValidDate(year: number, month: number, day: number): boolean {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * Parse the date formats seen in notices:
 *   2026-11-24 11:00 | 24.11.2026 r. godz. 11:00 | 24/11/2026 10:00:00 | 24 listopada 2026 r. do godz. 10:00
 * Returns an ISO string (Warsaw offset unless one is given) or null.
 */
export function parseDateTime(raw: string, explicitOffset?: string): string | null {
  const s = raw.replace(/\s+/g, ' ').trim();
  let y: number | undefined, m: number | undefined, d: number | undefined;
  let rest = s;

  let match = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    [y, m, d] = [+match[1], +match[2], +match[3]];
    rest = s.slice((match.index ?? 0) + match[0].length);
  } else if ((match = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/))) {
    [d, m, y] = [+match[1], +match[2], +match[3]];
    rest = s.slice((match.index ?? 0) + match[0].length);
  } else if ((match = s.match(/(\d{1,2})\s+([a-ząćęłńóśźż]+)\s+(\d{4})/i))) {
    const mm = monthFromPolish(match[2]);
    if (mm) {
      [d, m, y] = [+match[1], mm, +match[3]];
      rest = s.slice((match.index ?? 0) + match[0].length);
    }
  }
  if (y === undefined || m === undefined || d === undefined) return null;

  // Time must come shortly after the date ("r. godz. 10:00", " | 10:00:00").
  const t = rest.slice(0, 40).match(/(\d{1,2})[:.](\d{2})(?![\d.,]*\s*(?:zł|pln|%))/i);
  const hour = t ? +t[1] : 23;
  const minute = t ? +t[2] : 59;
  return toIso(y, m, d, hour, minute, explicitOffset);
}

/** "21.000,00 zł" | "21 000 PLN" | "5000,00 złotych" -> "21 000,00 PLN" */
export function normalizeAmount(raw: string, currency = 'PLN'): string | null {
  let s = raw.replace(/ /g, ' ').trim();
  s = s.replace(/[^\d.,\s]/g, '').trim();
  if (!/\d/.test(s)) return null;
  // Decide which separator is the decimal one.
  let intPart = s;
  let dec = '00';
  const decMatch = s.match(/[.,](\d{2})$/);
  if (decMatch) {
    intPart = s.slice(0, -3);
    dec = decMatch[1];
  }
  const digits = intPart.replace(/[^\d]/g, '');
  if (!digits) return null;
  const grouped = digits.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped},${dec} ${currency}`;
}

/** Days (rounded down) and hours left until an ISO deadline. */
export function timeLeft(deadlineIso: string, now: Date = new Date()): { days: number; hours: number; past: boolean } {
  const diff = new Date(deadlineIso).getTime() - now.getTime();
  const past = diff < 0;
  const abs = Math.abs(diff);
  return { days: Math.floor(abs / 86400000), hours: Math.floor((abs % 86400000) / 3600000), past };
}

/** "Tue, 24 Nov 2026, 11:00 (Warsaw)" */
export function formatDeadline(iso: string): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d);
  return `${date}, ${time} (Warsaw time)`;
}

/** Rough token estimate. Polish text splits into more tokens than English, so be conservative. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
