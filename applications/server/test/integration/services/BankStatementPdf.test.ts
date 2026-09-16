// TDD mode — tests written BEFORE `BankStatementPdf.ts` exists.
//
// Plan `.work-plans/fio-transaction-matching.md` D9 / D13 / D16 / §7.2 tests 167-172c. The
// diacritics regression: `pdfkit`'s base-14 `encodeText` silently desyncs the WHOLE REST of a
// string the moment it meets a character WinAnsi cannot map (`ě ď ň ř ť ů`) — it throws nothing,
// so "did not throw" is worthless as an assertion here. This suite asserts on the ACTUAL font
// resource embedded in the PDF and on the round-tripped extracted text.
//
// Contract this file pins down for
// `applications/server/src/services/BankStatementPdf.ts`:
//
//   export interface BankStatementPdfInput {
//     readonly config: {
//       readonly recipientName: string;
//       readonly registeredId: Option.Option<string>;
//       readonly registeredAddress: Option.Option<string>;
//       readonly computedIban: string;
//     };
//     readonly docLabel: Option.Option<string>;
//     readonly from: string; readonly to: string;   // 'YYYY-MM-DD'
//     readonly openingBalanceMinor: number;
//     readonly closingBalanceMinor: number;
//     readonly coverageGaps: ReadonlyArray<{ from: string; to: string }>;
//     readonly rows: ReadonlyArray<{
//       readonly bookedOn: string;
//       readonly counterpartyName: Option.Option<string>;
//       readonly variableSymbol: Option.Option<string>;
//       readonly messageForRecipient: Option.Option<string>;
//       readonly amountMinor: number;
//       readonly matchState: string;
//       readonly resolutionKind: Option.Option<'other_income' | 'not_relevant'>;
//     }>;
//   }
//   export const renderBankStatementPdf: (input: BankStatementPdfInput) => Effect.Effect<Buffer>
//   export const NOTO_SANS_REGULAR_PATH: URL   // resolved relative to import.meta.url
//   export const NOTO_SANS_BOLD_PATH: URL

import { describe, expect, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { PDFParse } from 'pdf-parse';

const DIACRITIC_LINE = 'Příspěvek za podzim — Novák, Řehoř, Ďáblice, Ťuhýk, Žluťoučký kůň';

const baseInput = () => ({
  config: {
    recipientName: 'Ultimate Frisbee Horní Počernice, z.s.',
    registeredId: Option.some('61858374'),
    registeredAddress: Option.some('U Prefy 5, 193 00 Praha 9'),
    computedIban: 'CZ7120100000002703474850',
  },
  docLabel: Option.some('Výpis pro grantovou zprávu'),
  from: '2024-01-01',
  to: '2024-03-31',
  openingBalanceMinor: 100_000,
  closingBalanceMinor: 250_000,
  coverageGaps: [] as ReadonlyArray<{ from: string; to: string }>,
  periodContinuityViolations: [] as ReadonlyArray<{
    dateStart: string;
    dateEnd: string;
    openingBalanceMinor: number;
    closingBalanceMinor: number;
    actualClosingMinor: number;
  }>,
  rows: [
    {
      bookedOn: '2024-02-01',
      counterpartyName: Option.some(DIACRITIC_LINE),
      variableSymbol: Option.some('12345'),
      messageForRecipient: Option.some(DIACRITIC_LINE),
      amountMinor: 150_000,
      matchState: 'matched',
      resolutionKind: Option.none<'other_income' | 'not_relevant'>(),
    },
  ],
});

/** Renders and returns both the raw PDF buffer and its extracted text. */
const renderAndExtract = async () => {
  const { renderBankStatementPdf } = await import('~/services/BankStatementPdf.js');
  const buffer = await Effect.runPromise(renderBankStatementPdf(baseInput() as never));
  const parser = new PDFParse({ data: buffer });
  const text = (await parser.getText()).text;
  await parser.destroy();
  return { buffer, text };
};

// ---------------------------------------------------------------------------
// 167 — the diacritics regression: NOT base-14, an embedded TrueType subset, text round-trips
// ---------------------------------------------------------------------------

describe('BankStatementPdf — diacritics regression (167)', () => {
  it('the raw PDF never names /Helvetica (or any base-14 font) as a text font', async () => {
    const { buffer } = await renderAndExtract();
    const raw = buffer.toString('latin1');
    expect(raw).not.toMatch(/\/BaseFont\s*\/Helvetica/);
    expect(raw).not.toMatch(/\/BaseFont\s*\/Times-Roman/);
    expect(raw).not.toMatch(/\/BaseFont\s*\/Courier/);
  });

  it('an embedded TrueType subset is present: /FontFile2 and an ABCDEF+NotoSans-style tag', async () => {
    const { buffer } = await renderAndExtract();
    const raw = buffer.toString('latin1');
    expect(raw).toContain('/FontFile2');
    // A PDF font subset tag is exactly 6 uppercase letters followed by '+'.
    expect(raw).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+NotoSans/);
  });

  it('the extracted text round-trips the full diacritic line, byte-exact', async () => {
    const { text } = await renderAndExtract();
    expect(text).toContain(DIACRITIC_LINE);
  });
});

// ---------------------------------------------------------------------------
// 168 — ě specifically (the char WinAnsi cannot map at all)
// ---------------------------------------------------------------------------

describe('BankStatementPdf — ě survives (168)', () => {
  it('U+011B (ě) is present in the extracted text, not just á/é/í (which WinAnsi handles fine)', async () => {
    const { text } = await renderAndExtract();
    expect(text).toContain('ě');
    // Sanity: WinAnsi-safe characters must ALSO survive (proves this isn't a garbled-but-lucky match).
    expect(text).toContain('á');
    expect(text).toContain('é');
    // The WinAnsi-BREAKING characters specifically:
    for (const ch of ['č', 'ď', 'ě', 'ň', 'ř', 'ť', 'ů']) {
      expect(text.toLowerCase()).toContain(ch);
    }
  });
});

// ---------------------------------------------------------------------------
// 169 — font resolves under both src (tsx) and build/esm
// ---------------------------------------------------------------------------

describe('BankStatementPdf — font path resolution (169)', () => {
  it('NOTO_SANS_REGULAR_PATH / NOTO_SANS_BOLD_PATH resolve to files that exist on disk', async () => {
    const { NOTO_SANS_REGULAR_PATH, NOTO_SANS_BOLD_PATH } = await import(
      '~/services/BankStatementPdf.js'
    );
    const fs = await import('node:fs');
    expect(fs.existsSync(NOTO_SANS_REGULAR_PATH)).toBe(true);
    expect(fs.existsSync(NOTO_SANS_BOLD_PATH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 171 — prints opening/closing balance and the NEÚPLNÝ VÝPIS band when coverage is incomplete
// ---------------------------------------------------------------------------

describe('BankStatementPdf — coverage banner and balances (171)', () => {
  it('prints the opening and closing balance for the requested range', async () => {
    const { text } = await renderAndExtract();
    expect(text).toContain('1000,00'); // 100_000 minor -> 1000,00 (or 1 000,00 — presence check only)
    expect(text).toContain('2500,00');
  });

  it('renders NEÚPLNÝ VÝPIS when coverageGaps is non-empty', async () => {
    const { renderBankStatementPdf } = await import('~/services/BankStatementPdf.js');
    const input = {
      ...baseInput(),
      coverageGaps: [{ from: '2024-01-15', to: '2024-01-20' }],
    };
    const buffer = await Effect.runPromise(renderBankStatementPdf(input as never));
    const parser = new PDFParse({ data: buffer });
    const text = (await parser.getText()).text;
    await parser.destroy();
    expect(text).toContain('NEÚPLNÝ VÝPIS');
  });

  it('does NOT render the incomplete-statement band when coverage is complete', async () => {
    const { text } = await renderAndExtract();
    expect(text).not.toContain('NEÚPLNÝ VÝPIS');
  });

  it('renders NEÚPLNÝ VÝPIS when periodContinuityViolations is non-empty, with no coverage gap', async () => {
    const { renderBankStatementPdf } = await import('~/services/BankStatementPdf.js');
    const input = {
      ...baseInput(),
      periodContinuityViolations: [
        {
          dateStart: '2024-02-01',
          dateEnd: '2024-02-29',
          openingBalanceMinor: 100_000,
          closingBalanceMinor: 250_000,
          actualClosingMinor: 200_000,
        },
      ],
    };
    const buffer = await Effect.runPromise(renderBankStatementPdf(input as never));
    const parser = new PDFParse({ data: buffer });
    const text = (await parser.getText()).text;
    await parser.destroy();
    expect(text).toContain('NEÚPLNÝ VÝPIS');
    expect(text).toContain('2024-02-01');
  });
});

// ---------------------------------------------------------------------------
// 172 — header prints recipient_name, registered_id, registered_address, the account, docLabel
// ---------------------------------------------------------------------------

describe('BankStatementPdf — header fields (172)', () => {
  it('prints recipient_name, registered_id, registered_address, the IBAN and docLabel', async () => {
    const { text } = await renderAndExtract();
    expect(text).toContain('Ultimate Frisbee Horní Počernice, z.s.');
    expect(text).toContain('61858374');
    expect(text).toContain('U Prefy 5, 193 00 Praha 9');
    expect(text).toContain('CZ7120100000002703474850');
    expect(text).toContain('Výpis pro grantovou zprávu');
  });
});

// ---------------------------------------------------------------------------
// 172b — resolution_kind picks the export word: "other_income" -> "Jiný příjem klubu"
// ---------------------------------------------------------------------------

describe('BankStatementPdf — resolution_kind picks the label (172b)', () => {
  it('an ignored row with resolution_kind=other_income renders "Jiný příjem klubu", never "Ignorováno"', async () => {
    const { renderBankStatementPdf } = await import('~/services/BankStatementPdf.js');
    const input = {
      ...baseInput(),
      rows: [
        {
          bookedOn: '2024-02-15',
          counterpartyName: Option.some('Městská část Praha 20'),
          variableSymbol: Option.none<string>(),
          messageForRecipient: Option.some('Dotace na sportovní činnost'),
          amountMinor: 12_000_000, // a 120 000 Kč municipal grant
          matchState: 'ignored',
          resolutionKind: Option.some('other_income' as const),
        },
      ],
    };
    const buffer = await Effect.runPromise(renderBankStatementPdf(input as never));
    const parser = new PDFParse({ data: buffer });
    const text = (await parser.getText()).text;
    await parser.destroy();
    expect(text).toContain('Jiný příjem klubu');
    expect(text).not.toContain('Ignorováno');
  });

  it('an ignored row with resolution_kind=not_relevant renders "Ignorováno"', async () => {
    const { renderBankStatementPdf } = await import('~/services/BankStatementPdf.js');
    const input = {
      ...baseInput(),
      rows: [
        {
          bookedOn: '2024-02-16',
          counterpartyName: Option.some('Neznámý plátce'),
          variableSymbol: Option.none<string>(),
          messageForRecipient: Option.none<string>(),
          amountMinor: 5000,
          matchState: 'ignored',
          resolutionKind: Option.some('not_relevant' as const),
        },
      ],
    };
    const buffer = await Effect.runPromise(renderBankStatementPdf(input as never));
    const parser = new PDFParse({ data: buffer });
    const text = (await parser.getText()).text;
    await parser.destroy();
    expect(text).toContain('Ignorováno');
  });
});

// ---------------------------------------------------------------------------
// 172c — BankTransactionResolutionKind has exactly two members, 'duplicate' absent
// ---------------------------------------------------------------------------

describe('BankTransactionResolutionKind — exactly two members (172c)', () => {
  it("has exactly {'other_income','not_relevant'} — 'duplicate' is absent", async () => {
    const { BankTransaction } = await import('@sideline/domain');
    expect(new Set(BankTransaction.BankTransactionResolutionKind.literals)).toEqual(
      new Set(['other_income', 'not_relevant']),
    );
    expect(BankTransaction.BankTransactionResolutionKind.literals).not.toContain('duplicate');
  });
});
