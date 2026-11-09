// TDD — written before parseFeeImportCsv.ts exists. Spec: .dev-loop/plan.md, Task 4.
import { describe, expect, it } from 'vitest';
import { parseFeeImportCsv } from './parseFeeImportCsv.js';

const HEADER = 'member;fee;amount;currency;dueAt';

describe('parseFeeImportCsv', () => {
  it('parses the Excel dialect: BOM, CRLF, quotes, comma decimals, both date forms, trailing ;;', () => {
    const text =
      '﻿member;fee;amount;currency;dueAt\r\n' +
      'alice;Season 2026;1 500,50;czk;2026-09-30\r\n' +
      'bob;"Trip; ""Prague""";500;EUR;30.09.2026\r\n' +
      'carol;Season 2026;800;CZK;30. 9. 2026;;\r\n' +
      'dave;Season 2026;800;CZK;\r\n';

    const { rows, errors } = parseFeeImportCsv(text);

    expect(errors).toEqual([]);
    expect(rows.map((r) => r.line)).toEqual([2, 3, 4, 5]);
    expect(rows[0]).toMatchObject({
      line: 2,
      member: 'alice',
      feeName: 'Season 2026',
      amountMinor: 150050,
      currency: 'CZK',
      dueDate: '2026-09-30',
    });
    expect(rows[1]).toMatchObject({ line: 3, feeName: 'Trip; "Prague"', dueDate: '2026-09-30' });
    expect(rows[2]).toMatchObject({ line: 4, dueDate: '2026-09-30' });
    expect(rows[3]).toMatchObject({ line: 5, dueDate: null });
  });

  it('keeps physical line numbers across LF, a quoted newline, a blank line and ;;;;', () => {
    const text = [
      HEADER, // 1
      'alice;"Multi', // 2
      'line fee";500;CZK;2026-09-30', // 3
      '', // 4
      ';;;;', // 5
      'bob;Fee B;300;CZK;', // 6
      '',
    ].join('\n');

    const { rows, errors } = parseFeeImportCsv(text);

    expect(errors).toEqual([]);
    expect(rows.map((r) => r.line)).toEqual([2, 6]);
  });

  it('reports file-level errors on line 1 with no rows', () => {
    const validRows = (n: number) =>
      Array.from({ length: n }, (_, i) => `m${i};Fee;100;CZK;`).join('\r\n');

    expect(parseFeeImportCsv('')).toEqual({
      rows: [],
      errors: [{ line: 1, code: 'invalid_header' }],
    });
    expect(parseFeeImportCsv('name;fee;amount;currency;dueAt\nalice;Fee;100;CZK;')).toEqual({
      rows: [],
      errors: [{ line: 1, code: 'invalid_header' }],
    });
    expect(parseFeeImportCsv(`${HEADER}\r\n`)).toEqual({
      rows: [],
      errors: [{ line: 1, code: 'no_rows' }],
    });
    expect(parseFeeImportCsv(`${HEADER}\r\n${validRows(1001)}`)).toEqual({
      rows: [],
      errors: [{ line: 1, code: 'too_many_rows' }],
    });

    const atCap = parseFeeImportCsv(`${HEADER}\r\n${validRows(1000)}`);
    expect(atCap.errors).toEqual([]);
    expect(atCap.rows).toHaveLength(1000);
  });

  it('reports one error per bad row, in line order, and keeps only the valid rows', () => {
    const text = [
      HEADER, // 1
      'alice;Fee;500;CZK', // 2 — four columns
      'alice;Fee;abc;CZK;', // 3
      'alice;Fee;0;CZK;', // 4
      'alice;Fee;500;CZ;', // 5
      'alice;Fee;500;CZK;31.2.2026', // 6
      'alice;Fee;500;CZK;2026-09-30', // 7
    ].join('\n');

    const { rows, errors } = parseFeeImportCsv(text);

    expect(errors).toEqual([
      { line: 2, code: 'malformed_row' },
      { line: 3, code: 'invalid_amount' },
      { line: 4, code: 'invalid_amount' },
      { line: 5, code: 'invalid_currency' },
      { line: 6, code: 'invalid_due_at' },
    ]);
    expect(rows.map((r) => r.line)).toEqual([7]);
  });
});
