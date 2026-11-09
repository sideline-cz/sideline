import { FinanceApi } from '@sideline/domain';
import { parseAmount } from './parseAmount.js';

export type FeeImportErrorCode =
  | FinanceApi.FeeImportRowErrorCode
  | 'invalid_header'
  | 'no_rows'
  | 'too_many_rows'
  | 'invalid_encoding'
  | 'malformed_row'
  | 'invalid_currency'
  | 'invalid_due_at';

export type ParsedFeeImportRow = {
  line: number;
  member: string;
  feeName: string;
  amountMinor: number;
  currency: string;
  dueDate: string | null; // 'YYYY-MM-DD'
};

type FeeImportError = { line: number; code: FeeImportErrorCode };

const HEADER = ['member', 'fee', 'amount', 'currency', 'dueat'];
const COLUMNS = HEADER.length;

/**
 * Parses a semicolon CSV (Excel dialect: BOM, CRLF, `"` quoting, comma decimals) into fee
 * import rows. Pure: text in, rows and errors out. Line numbers are the physical line where
 * each record starts; the header is line 1. The caller sends nothing when `errors` is not empty.
 */
export function parseFeeImportCsv(text: string): {
  rows: ParsedFeeImportRow[];
  errors: FeeImportError[];
} {
  const records = tokenise(text.startsWith('﻿') ? text.slice(1) : text);

  const header = records[0];
  if (
    header === undefined ||
    header.fields.length !== COLUMNS ||
    header.fields.some((f, i) => f.toLowerCase() !== HEADER[i])
  ) {
    return { rows: [], errors: [{ line: 1, code: 'invalid_header' }] };
  }
  const data = records.slice(1);
  if (data.length === 0) return { rows: [], errors: [{ line: 1, code: 'no_rows' }] };
  if (data.length > FinanceApi.FEE_IMPORT_MAX_ROWS) {
    return { rows: [], errors: [{ line: 1, code: 'too_many_rows' }] };
  }

  const rows: ParsedFeeImportRow[] = [];
  const errors: FeeImportError[] = [];
  for (const { line, fields } of data) {
    const [member = '', feeName = '', amount = '', rawCurrency = '', rawDueAt = ''] = fields;
    if (fields.length !== COLUMNS || member === '' || feeName === '') {
      errors.push({ line, code: 'malformed_row' });
      continue;
    }
    const currency = rawCurrency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      errors.push({ line, code: 'invalid_currency' });
      continue;
    }
    const amountMinor = toAmountMinor(amount, currency);
    if (amountMinor === null) {
      errors.push({ line, code: 'invalid_amount' });
      continue;
    }
    const dueDate = toDueDate(rawDueAt);
    if (dueDate === undefined) {
      errors.push({ line, code: 'invalid_due_at' });
      continue;
    }
    rows.push({ line, member, feeName, amountMinor, currency, dueDate });
  }
  return { rows, errors };
}

/**
 * `;` fields, `"` quoting with `""` escape, newlines allowed inside quotes. Fields are trimmed.
 * Empty fields after column 5 are dropped (Excel pads rows with `;;`); a record whose fields are
 * all empty (blank line, `;;;;`) is dropped.
 */
function tokenise(text: string): { line: number; fields: string[] }[] {
  const records: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;

  const endRecord = () => {
    fields.push(field.trim());
    while (fields.length > COLUMNS && fields[fields.length - 1] === '') fields.pop();
    if (fields.some((f) => f !== '')) records.push({ line: startLine, fields });
    fields = [];
    field = '';
    startLine = line;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ';') {
      fields.push(field.trim());
      field = '';
    } else if (c === '\n' || (c === '\r' && text[i + 1] === '\n')) {
      if (c === '\r') i++;
      line++;
      endRecord();
    } else {
      field += c;
    }
  }
  endRecord();
  return records;
}

function toAmountMinor(raw: string, currency: string): number | null {
  const value = raw.replace(/[\s ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  try {
    return parseAmount(value, currency);
  } catch {
    return null; // 0
  }
}

/** `null` = no due date, `undefined` = invalid. */
function toDueDate(raw: string): string | null | undefined {
  const value = raw.replace(/\s/g, '');
  if (value === '') return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const dmy = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  const [y, m, d] = iso
    ? [iso[1], iso[2], iso[3]].map(Number)
    : dmy
      ? [dmy[3], dmy[2], dmy[1]].map(Number)
      : [];
  if (y === undefined || m === undefined || d === undefined) return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return undefined;
  }
  return date.toISOString().slice(0, 10);
}
