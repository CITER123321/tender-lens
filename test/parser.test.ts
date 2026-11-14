import { describe, expect, it } from 'vitest';
import { detectSource, parseFacts, parseDeadline, parseDeposit, parseCriteria } from '../src/core/parser';
import { bkFacts, bkToText, bkAttachments, bkIdFromUrl, type BkResponse } from '../src/core/bk';
import { captureFixture, fixture } from './helpers';

const BZP_URL = 'https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/';

describe('BZP notices (ezamowienia.gov.pl)', () => {
  it('IT portal: deadline, no deposit, three weighted criteria, conditions, documents', () => {
    const page = captureFixture('bzp-it-portal.html', `${BZP_URL}08df3e42-1e1c-a9ee-c1c5-d5000193e747`);
    const source = detectSource(page.url, page.text);
    expect(source).toBe('bzp');
    const f = parseFacts(page.text, source);
    expect(f.deadline).toBe('2026-11-24T11:00:00+01:00');
    expect(f.deposit).toEqual({ required: false, amount: null });
    expect(f.buyer).toBe('MUZEUM ARCHEOLOGICZNE W KRAKOWIE');
    expect(f.title).toMatch(/Archeologiczny Atlas Małopolski/);
    expect(f.reference).toBe('DA-271-6/26 · 2026/BZP 00529093');
    expect(f.criteria).toEqual([
      { name: 'Cena', weight: 60 },
      { name: 'Doświadczenie zespołu (DZ)', weight: 20 },
      { name: 'Wydłużenie okresu gwarancji (G)', weight: 20 },
    ]);
    expect(f.conditions?.length).toBeGreaterThanOrEqual(2);
    expect(f.conditions?.join(' ')).toMatch(/250 000,00 zł/);
    expect(f.documents).toEqual(expect.arrayContaining([
      'Declaration under Art. 125(1) Pzp (no exclusion, conditions met)',
      'Capital group declaration (Art. 108(1)(5) Pzp)',
      'List of key staff',
      'Company register extract (KRS or CEIDG)',
    ]));
    expect(f.documents).not.toContain('Proof of bid security (wadium)');
  });

  it('construction works: deposit amount is found and normalised', () => {
    const page = captureFixture('bzp-works-deposit.html', `${BZP_URL}x`);
    const f = parseFacts(page.text, 'bzp');
    expect(f.deadline).toBe('2026-11-24T10:00:00+01:00');
    expect(f.deposit).toEqual({ required: true, amount: '21 000,00 PLN' });
    expect(f.documents).toContain('Proof of bid security (wadium)');
  });

  it('IT support: deadline and the meta file agree for every BZP fixture', () => {
    for (const name of ['bzp-it-portal', 'bzp-it-support', 'bzp-works-deposit']) {
      const meta = JSON.parse(fixture(`${name}.meta.json`)) as { submittingOffersDate: string };
      const page = captureFixture(`${name}.html`, `${BZP_URL}x`);
      const f = parseFacts(page.text, 'bzp');
      expect(new Date(f.deadline!).toISOString(), name).toBe(new Date(meta.submittingOffersDate).toISOString());
    }
  });
});

describe('TED notice (EU Official Journal, Polish buyer)', () => {
  it('reads the deadline with the explicit UTC offset, buyer and reference', () => {
    const page = captureFixture('ted-backup-pl.html', 'https://ted.europa.eu/en/notice/-/detail/756942-2026');
    const source = detectSource(page.url, page.text);
    expect(source).toBe('ted');
    const f = parseFacts(page.text, source);
    expect(f.deadline).toBe('2026-11-30T10:00:00+01:00');
    expect(f.buyer).toBe('NARODOWY FUNDUSZ ZDROWIA');
    expect(f.title).toBe('Modernizacja środowiska backupu');
    expect(f.reference).toBe('NFZ03-WAG-SDZP.251.9.2026 · TED 756942-2026');
  });
});

describe('Baza Konkurencyjności (JSON API)', () => {
  const load = (n: string) => JSON.parse(fixture(n)) as BkResponse;

  it('software module request for quotation', () => {
    const json = load('bk-297362-software.json');
    const f = bkFacts(json);
    expect(f.source).toBe('bk');
    expect(f.deadline).toBe('2026-12-07T23:59:00+01:00');
    expect(f.title).toMatch(/modułu wyliczenia materiałowego/);
    expect(f.criteria).toEqual([{ name: 'Cena', weight: 100 }]);
    // "Zamawiający nie opisuje i nie wyznacza..." placeholders are dropped
    expect(f.conditions).toEqual([
      expect.stringMatching(/wiedzę i doświadczenie w projektowaniu aplikacji/),
      expect.stringMatching(/działającego demonstratora/),
    ]);
    // The buyer's own document list is mapped to known documents (and the rest kept as written).
    expect(f.documents).toEqual(expect.arrayContaining([
      'Declaration of no personal or capital links',
      'Declaration of knowledge and experience',
    ]));
    expect(bkAttachments(json).map((a) => a.text)).toContain('zał. 3 formularz oferty.docx');
    expect(bkAttachments(json)[0].href).toMatch(/^https:\/\/bazakonkurencyjnosci\.funduszeeuropejskie\.gov\.pl\/api\/files\/\d+$/);
  });

  it('video production: price-only, flattened text keeps the deadline line', () => {
    const json = load('bk-297281-video.json');
    expect(bkToText(json)).toMatch(/Termin składania ofert: 2026-11-18 09:00:00/);
    const f = bkFacts(json);
    expect(f.deadline).toBe('2026-11-18T09:00:00+01:00');
    expect(f.criteria?.[0]).toEqual({ name: 'Cena', weight: 100 });
  });

  it('extracts the announcement id from the page URL', () => {
    expect(bkIdFromUrl('https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/ogloszenia/297362?tab=1')).toBe('297362');
    expect(bkIdFromUrl('https://example.org/ogloszenia/1')).toBeNull();
  });
});

describe('free-text patterns (other platforms, PDFs)', () => {
  it('Polish long-form dates and "do godz."', () => {
    expect(parseDeadline('Termin składania ofert upływa w dniu 3 grudnia 2026 r. o godz. 12:00.')?.iso).toBe('2026-12-03T12:00:00+01:00');
    expect(parseDeadline('Ofertę należy złożyć do dnia 05.06.2026 r. do godz. 9.30')?.iso).toBe('2026-06-05T09:30:00+02:00');
  });

  it('date without a time means end of day', () => {
    expect(parseDeadline('Termin składania ofert: 15.12.2026')?.iso).toBe('2026-12-15T23:59:00+01:00');
  });

  it('deposit phrased in different ways', () => {
    expect(parseDeposit('Wykonawca wnosi wadium w kwocie 5000,00 złotych.')?.deposit).toEqual({ required: true, amount: '5 000,00 PLN' });
    expect(parseDeposit('Zamawiający nie wymaga wniesienia wadium.')?.deposit).toEqual({ required: false, amount: null });
    expect(parseDeposit('Brak informacji')).toBeNull();
  });

  it('criteria written as a list', () => {
    const text = 'Kryteria oceny ofert:\n1. Cena – 60%\n2. Termin realizacji – 30%\n3. Okres gwarancji – 10%';
    expect(parseCriteria(text)).toEqual([
      { name: 'Cena', weight: 60 },
      { name: 'Termin realizacji', weight: 30 },
      { name: 'Okres gwarancji', weight: 10 },
    ]);
  });
});

describe('generic notices', () => {
  it('skips label-only matches for title and buyer', () => {
    const text = 'Nazwa zamówienia albo umowy ramowej:\n1.1.) Rola zamawiającego\nZapytanie ofertowe\nPrzedmiot zamówienia: Dostawa serwera dla szkoły\nZamawiający: Szkoła Podstawowa nr 1 w Gorzowie';
    const f = parseFacts(text, 'generic');
    expect(f.title).toBe('Dostawa serwera dla szkoły');
    expect(f.buyer).toBe('Szkoła Podstawowa nr 1 w Gorzowie');
  });
});
