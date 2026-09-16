/**
 * Plan `.work-plans/fio-transaction-matching.md` D9 / D13 / D16 / T11 — renders the formal PDF
 * statement handed to a municipality as grant evidence.
 *
 * **The diacritics trap.** pdfkit's base-14 fonts route text through WinAnsi, which has no
 * representation for `č ď ě ň ř ť ů` — it does not throw, it silently emits a malformed glyph
 * token and desynchronises the REST of the string. A smoke test using only `á é í ó ú ý š ž`
 * (which WinAnsi *does* map) would pass while the document is garbage. The fix is to never touch
 * a base-14 font: vendor a Unicode TTF (Noto Sans), `registerFont(...)` it once, and call
 * `doc.font(...)` before every single `.text()` call — pdfkit does NOT remember the "current"
 * font across unrelated draw calls reliably enough to trust omitting it once vendored fonts are
 * mixed with headers/body/bold.
 *
 * Two build traps (see `applications/server/AGENTS.md` and this package's `package.json`):
 *   1. The production image is `node:25-slim`, which ships NO fonts at all — a base-14 fallback
 *      is not an option in prod even by accident.
 *   2. `tsc` does not copy non-`.ts` assets. `scripts/copy-assets.mjs` copies
 *      `src/assets/fonts/*` to `build/esm/assets/fonts/*` as an explicit build step, and
 *      `scripts/assert-dist.mjs` fails the build loudly if they did not land there.
 */
import { fileURLToPath } from 'node:url';

import PDFDocument = require('pdfkit');

import { Effect, Option } from 'effect';
import { formatCsvAmount } from '~/utils/csv.js';

// ---------------------------------------------------------------------------
// Vendored fonts — resolved relative to THIS file, so the same relative path works from
// `src/services/BankStatementPdf.ts` (tsx/dev) and `build/esm/services/BankStatementPdf.js`
// (prod) as long as `copy-assets.mjs` mirrors the `assets/` directory next to `services/` in
// both locations.
// ---------------------------------------------------------------------------

export const NOTO_SANS_REGULAR_PATH = new URL(
  '../assets/fonts/NotoSans-Regular.ttf',
  import.meta.url,
);
export const NOTO_SANS_BOLD_PATH = new URL('../assets/fonts/NotoSans-Bold.ttf', import.meta.url);

const FONT_REGULAR = 'NotoSans';
const FONT_BOLD = 'NotoSans-Bold';

// ---------------------------------------------------------------------------
// Input contract (pinned by `test/integration/services/BankStatementPdf.test.ts`)
// ---------------------------------------------------------------------------

export interface BankStatementPdfRow {
  readonly bookedOn: string; // 'YYYY-MM-DD'
  readonly counterpartyName: Option.Option<string>;
  readonly variableSymbol: Option.Option<string>;
  readonly messageForRecipient: Option.Option<string>;
  readonly amountMinor: number; // signed
  readonly matchState: string;
  readonly resolutionKind: Option.Option<'other_income' | 'not_relevant'>;
}

export interface BankStatementPdfInput {
  readonly config: {
    readonly recipientName: string;
    readonly registeredId: Option.Option<string>;
    readonly registeredAddress: Option.Option<string>;
    readonly computedIban: string;
  };
  readonly docLabel: Option.Option<string>;
  readonly from: string; // 'YYYY-MM-DD'
  readonly to: string; // 'YYYY-MM-DD'
  readonly openingBalanceMinor: number;
  readonly closingBalanceMinor: number;
  readonly coverageGaps: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /** D13 — same red band as `coverageGaps` (see `bankCoverage.checkPeriodContinuity`). */
  readonly periodContinuityViolations: ReadonlyArray<{
    readonly dateStart: string;
    readonly dateEnd: string;
    readonly openingBalanceMinor: number;
    readonly closingBalanceMinor: number;
    readonly actualClosingMinor: number;
  }>;
  readonly rows: ReadonlyArray<BankStatementPdfRow>;
}

// ---------------------------------------------------------------------------
// D16 — resolution_kind picks the export word, never "Ignorováno" for real club income.
// ---------------------------------------------------------------------------

const MATCH_STATE_LABELS: Record<string, string> = {
  matched: 'Spárováno',
  partially_matched: 'Částečně spárováno',
  unmatched: 'Nespárováno',
  ignored: 'Ignorováno',
  not_applicable: 'Výdaj',
};

/** Exported so `api/bank-sync.ts`'s CSV builder renders the exact same "Stav přiřazení" word as
 * this PDF — one label function, D16's `other_income`/`not_relevant` discriminator applied
 * identically in both export formats. */
export const resolveMatchStateLabel = (
  matchState: string,
  resolutionKind: Option.Option<'other_income' | 'not_relevant'>,
): string => {
  if (matchState === 'ignored') {
    return Option.match(resolutionKind, {
      onNone: () => 'Ignorováno',
      onSome: (kind) => (kind === 'other_income' ? 'Jiný příjem klubu' : 'Ignorováno'),
    });
  }
  return MATCH_STATE_LABELS[matchState] ?? matchState;
};

const resolveStateLabel = (row: BankStatementPdfRow): string =>
  resolveMatchStateLabel(row.matchState, row.resolutionKind);

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

const PAGE_MARGIN = 50;

const formatAmount = (minor: number): string => `${formatCsvAmount(minor)} Kč`;

const drawHeader = (doc: PDFKit.PDFDocument, input: BankStatementPdfInput): void => {
  doc.font(FONT_BOLD, 18).text(input.config.recipientName, { align: 'left' });
  doc.moveDown(0.3);

  Option.match(input.config.registeredId, {
    onNone: () => undefined,
    onSome: (id) => doc.font(FONT_REGULAR, 10).text(`IČO: ${id}`),
  });
  Option.match(input.config.registeredAddress, {
    onNone: () => undefined,
    onSome: (address) => doc.font(FONT_REGULAR, 10).text(address),
  });
  doc.font(FONT_REGULAR, 10).text(`Účet: ${input.config.computedIban}`);
  doc.moveDown(0.6);

  doc.font(FONT_BOLD, 14).text('Výpis bankovních transakcí');
  doc.font(FONT_REGULAR, 9).text('Doklad pro grantové vyúčtování');
  Option.match(input.docLabel, {
    onNone: () => undefined,
    onSome: (label) => doc.font(FONT_REGULAR, 12).text(label),
  });
  doc.font(FONT_REGULAR, 11).text(`Období: ${input.from} – ${input.to}`);
  doc.moveDown(0.4);
};

const drawCoverageBand = (doc: PDFKit.PDFDocument, input: BankStatementPdfInput): void => {
  if (input.coverageGaps.length === 0 && input.periodContinuityViolations.length === 0) return;
  doc.fillColor('#B00020');
  doc.font(FONT_BOLD, 12).text('NEÚPLNÝ VÝPIS');
  if (input.coverageGaps.length > 0) {
    doc
      .font(FONT_REGULAR, 9)
      .text(`Chybějící úseky: ${input.coverageGaps.map((g) => `${g.from}–${g.to}`).join('; ')}`);
  }
  if (input.periodContinuityViolations.length > 0) {
    doc
      .font(FONT_REGULAR, 9)
      .text(
        `Nesouhlasí zůstatek za období: ${input.periodContinuityViolations
          .map(
            (v) =>
              `${v.dateStart}–${v.dateEnd} (očekáváno ${formatAmount(v.closingBalanceMinor)}, dopočteno ${formatAmount(v.actualClosingMinor)})`,
          )
          .join('; ')}`,
      );
  }
  doc.fillColor('black');
  doc.moveDown(0.4);
};

const drawBalances = (doc: PDFKit.PDFDocument, input: BankStatementPdfInput): void => {
  doc.font(FONT_REGULAR, 10).text(`Počáteční zůstatek: ${formatAmount(input.openingBalanceMinor)}`);
  doc.font(FONT_REGULAR, 10).text(`Konečný zůstatek: ${formatAmount(input.closingBalanceMinor)}`);
  doc.moveDown(0.5);
};

const drawRow = (doc: PDFKit.PDFDocument, row: BankStatementPdfRow, index: number): void => {
  const pageWidth = doc.page.width - PAGE_MARGIN * 2;
  doc
    .font(FONT_BOLD, 10)
    .text(`${String(index + 1)}. ${row.bookedOn}  ${formatAmount(row.amountMinor)}`, {
      width: pageWidth,
      lineBreak: false,
    });
  doc.moveDown(0.15);

  const counterparty = Option.getOrElse(row.counterpartyName, () => '—');
  doc.font(FONT_REGULAR, 9).text(`Protistrana: ${counterparty}`, {
    width: pageWidth,
    lineBreak: false,
  });

  const vs = Option.getOrElse(row.variableSymbol, () => '—');
  doc.font(FONT_REGULAR, 9).text(`VS: ${vs}`, { width: pageWidth, lineBreak: false });

  const message = Option.getOrElse(row.messageForRecipient, () => '—');
  doc.font(FONT_REGULAR, 9).text(`Zpráva pro příjemce: ${message}`, {
    width: pageWidth,
    lineBreak: false,
  });

  doc.font(FONT_REGULAR, 9).text(`Stav: ${resolveStateLabel(row)}`, {
    width: pageWidth,
    lineBreak: false,
  });
  doc.moveDown(0.5);
};

const drawFooter = (doc: PDFKit.PDFDocument): void => {
  doc.moveDown(0.5);
  doc.font(FONT_REGULAR, 8).text(`Vygenerováno: ${new Date().toISOString()}`, { align: 'right' });
};

// ---------------------------------------------------------------------------
// renderBankStatementPdf
// ---------------------------------------------------------------------------

const renderToBuffer = (input: BankStatementPdfInput): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
    const chunks: Array<Buffer> = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont(FONT_REGULAR, fileURLToPath(NOTO_SANS_REGULAR_PATH));
    doc.registerFont(FONT_BOLD, fileURLToPath(NOTO_SANS_BOLD_PATH));

    drawHeader(doc, input);
    drawCoverageBand(doc, input);
    drawBalances(doc, input);

    doc.font(FONT_BOLD, 11).text('Transakce');
    doc.moveDown(0.3);
    input.rows.forEach((row, index) => {
      drawRow(doc, row, index);
    });

    drawFooter(doc);

    doc.end();
  });

export const renderBankStatementPdf = (input: BankStatementPdfInput): Effect.Effect<Buffer> =>
  Effect.promise(() => renderToBuffer(input));
