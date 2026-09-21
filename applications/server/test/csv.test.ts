// TDD mode — tests written BEFORE `csv.ts` exists.
//
// Plan `.work-plans/fio-transaction-matching.md` D8 / §7.1 tests 51-59. Pure, no DB, no Effect.
//
// Contract this file pins down for `applications/server/src/utils/csv.ts`:
//
//   export const CSV_DELIMITER: ';'
//   export const CSV_BOM: '﻿'
//   export const CSV_LINE_ENDING: '\r\n'
//
//   export const escapeCsvField:
//     (raw: string, options?: { readonly numeric?: boolean }) => string
//     — quotes on `;`, `"`, or a newline; doubles embedded `"`; prefixes a bare `'`
//       when the first character is one of `= + - @ TAB CR` UNLESS `options.numeric` is true.
//
//   export const formatCsvAmount: (minor: number) => string
//     — comma decimal separator, e.g. -13050 -> '-130,50'.
//
//   export const buildCsvDocument:
//     (header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>) => string
//     — BOM once at index 0, CRLF row endings, delimiter-joined, NO escaping performed here
//       (callers pass already-escaped fields via escapeCsvField).

import { describe, expect, it } from 'vitest';
import {
  buildCsvDocument,
  CSV_BOM,
  CSV_DELIMITER,
  CSV_LINE_ENDING,
  escapeCsvField,
  formatCsvAmount,
} from '~/utils/csv.js';

// ---------------------------------------------------------------------------
// 51 — delimiter is ';'
// ---------------------------------------------------------------------------

describe('csv — delimiter (51)', () => {
  it('CSV_DELIMITER is a semicolon', () => {
    expect(CSV_DELIMITER).toBe(';');
  });

  it('buildCsvDocument joins fields with the delimiter', () => {
    const doc = buildCsvDocument(['A', 'B'], [['1', '2']]);
    expect(doc).toContain('A;B');
    expect(doc).toContain('1;2');
  });
});

// ---------------------------------------------------------------------------
// 52 — BOM present exactly once, at index 0
// ---------------------------------------------------------------------------

describe('csv — UTF-8 BOM (52)', () => {
  it('the document starts with exactly one BOM at index 0', () => {
    const doc = buildCsvDocument(['A'], [['1'], ['2']]);
    expect(doc.charCodeAt(0)).toBe(0xfeff);
    // Count every occurrence of the BOM character in the whole document — must be exactly one.
    const occurrences = [...doc].filter((ch) => ch === CSV_BOM).length;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 53 — CRLF throughout
// ---------------------------------------------------------------------------

describe('csv — CRLF line endings (53)', () => {
  it('CSV_LINE_ENDING is CRLF', () => {
    expect(CSV_LINE_ENDING).toBe('\r\n');
  });

  it('every row (including the header) is CRLF-terminated, never a bare LF', () => {
    const doc = buildCsvDocument(
      ['A', 'B'],
      [
        ['1', '2'],
        ['3', '4'],
      ],
    );
    const withoutBom = doc.slice(1);
    // No LF appears without a preceding CR.
    expect(withoutBom.includes('\n')).toBe(true);
    const bareLfCount = (withoutBom.match(/(?<!\r)\n/g) ?? []).length;
    expect(bareLfCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 54 — the quoting predicate tests ';', not ','
// ---------------------------------------------------------------------------

describe('escapeCsvField — quoting predicate tests the delimiter, not a comma (54)', () => {
  it('a value containing a comma is NOT quoted (the delimiter is ";")', () => {
    expect(escapeCsvField('Novák, Jan')).toBe('Novák, Jan');
  });

  it('a value containing a semicolon IS quoted', () => {
    expect(escapeCsvField('Novák; Jan')).toBe('"Novák; Jan"');
  });
});

// ---------------------------------------------------------------------------
// 55 — embedded quotes are doubled
// ---------------------------------------------------------------------------

describe('escapeCsvField — embedded quote doubling (55)', () => {
  it('a value containing a double quote is quoted, and the quote is doubled', () => {
    expect(escapeCsvField('he said "hi"')).toBe('"he said ""hi"""');
  });
});

// ---------------------------------------------------------------------------
// 56 / 57 — formula injection: text columns only, never numeric
// ---------------------------------------------------------------------------

describe('escapeCsvField — formula injection guard (56, 57)', () => {
  // These four triggers contain no ';', '"' or newline themselves, so the prefixed value never
  // additionally needs quoting — the escaped output is exactly `'` + the original value.
  it.each(["=cmd|'/c calc'!A1", '+1+1', '-1+1', '@SUM(A1:A2)'])(
    'text column starting with a formula trigger is prefixed with a bare quote: %s',
    (value) => {
      expect(escapeCsvField(value)).toBe(`'${value}`);
    },
  );

  it('a leading TAB is prefixed (does not itself force quoting)', () => {
    const value = '\tSUM(A1:A2)';
    expect(escapeCsvField(value)).toBe(`'${value}`);
  });

  it('a leading CR is prefixed AND the whole field is quoted, because CR also triggers quoting', () => {
    const value = '\rSUM(A1:A2)';
    const escaped = escapeCsvField(value);
    expect(escaped).toBe(`"'${value}"`);
  });

  it('a numeric column starting with "-" is NOT prefixed (57)', () => {
    expect(escapeCsvField('-130,50', { numeric: true })).toBe('-130,50');
  });

  it('a numeric column starting with "=" is still NOT prefixed — numeric always wins', () => {
    // Amounts never legitimately start with '=', but the contract is unconditional: numeric
    // columns are never prefixed, so a defensive caller passing numeric:true is honoured.
    expect(escapeCsvField('=1', { numeric: true })).toBe('=1');
  });

  it('a text column NOT starting with a trigger character is left untouched', () => {
    expect(escapeCsvField('Jan Novák')).toBe('Jan Novák');
  });
});

// ---------------------------------------------------------------------------
// 58 — decimal separator is a comma
// ---------------------------------------------------------------------------

describe('formatCsvAmount — comma decimal separator (58)', () => {
  it('formats a positive amount with a comma', () => {
    expect(formatCsvAmount(123450)).toBe('1234,50');
  });

  it('formats a negative amount with the sign preserved and a comma', () => {
    expect(formatCsvAmount(-13050)).toBe('-130,50');
  });

  it('always renders both decimal places', () => {
    expect(formatCsvAmount(100)).toBe('1,00');
    expect(formatCsvAmount(7)).toBe('0,07');
  });
});

// ---------------------------------------------------------------------------
// 59 — a value containing \r\n is quoted and preserved
// ---------------------------------------------------------------------------

describe('escapeCsvField — embedded CRLF is quoted and preserved (59)', () => {
  it('a value with an embedded \\r\\n is quoted, and the content is preserved verbatim', () => {
    const value = 'line one\r\nline two';
    const escaped = escapeCsvField(value);
    expect(escaped).toBe(`"${value}"`);
  });
});
