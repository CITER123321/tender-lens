// iCalendar (.ics) export for the bid deadline, with reminders 3 days and 1 day before.

export interface IcsEvent {
  uid: string;
  title: string;
  /** ISO 8601 with offset. */
  deadline: string;
  url?: string;
  description?: string;
  /** Length of the calendar block that ends at the deadline. */
  durationMinutes?: number;
  now?: Date;
}

const two = (n: number) => String(n).padStart(2, '0');

export function toIcsUtc(d: Date): string {
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
}

export function escapeIcs(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold lines longer than 75 octets (RFC 5545 section 3.1). */
export function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curLen = 0;
  for (const ch of line) {
    const len = new TextEncoder().encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (curLen + len > limit) {
      out.push(cur);
      cur = '';
      curLen = 0;
    }
    cur += ch;
    curLen += len;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function buildIcs(ev: IcsEvent): string {
  const end = new Date(ev.deadline);
  if (Number.isNaN(end.getTime())) throw new Error(`Invalid deadline: ${ev.deadline}`);
  const start = new Date(end.getTime() - (ev.durationMinutes ?? 60) * 60000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Tender Lens//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${ev.uid}@tender-lens`,
    `DTSTAMP:${toIcsUtc(ev.now ?? new Date())}`,
    `DTSTART:${toIcsUtc(start)}`,
    `DTEND:${toIcsUtc(end)}`,
    `SUMMARY:${escapeIcs(`Bid deadline: ${ev.title}`)}`,
    ev.description ? `DESCRIPTION:${escapeIcs(ev.description)}` : '',
    ev.url ? `URL:${ev.url}` : '',
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeIcs(`3 days left: ${ev.title}`)}`, 'TRIGGER;RELATED=END:-P3D', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeIcs(`Tomorrow: ${ev.title}`)}`, 'TRIGGER;RELATED=END:-P1D', 'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
