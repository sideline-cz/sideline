#!/usr/bin/env node
/**
 * Two independent rules, both scoped to `applications/bot/src`:
 *
 *  1. Asserts there is exactly one place that BUILDS a raw Discord timestamp token
 *     (`<t:seconds:style>`): `rest/discordTimestamp.ts`.
 *
 *     That token had been copy-pasted 15 times across 14 files — a `toDiscordTimestamp`
 *     (or `toDiscordDateTimestamp`, or an inline literal) hand-rolled per call site, each
 *     one independently responsible for remembering to branch on `all_day`. Most did not:
 *     eight separate Discord surfaces rendered a fabricated clock time for events that
 *     only ever had a *date*, because whichever copy rendered them had never been taught
 *     the distinction. Consolidating the duplicates onto one primitive fixed the eight
 *     sites in one pass; rule 1 is what stops copy #15 from reintroducing the same bug
 *     at a ninth site.
 *
 *  2. Asserts every `toDiscordTimestamp(...)` call rendering a date-only style (`D`/`d`)
 *     wraps a `discordDateInstant(...)` projection, not a raw instant — outside
 *     `rest/events/eventWhen.ts`, the one place already disciplined about this.
 *
 *     Rule 1 alone does not catch this: a call site can dutifully import the shared
 *     `toDiscordTimestamp` primitive (satisfying rule 1) and still pass it a raw
 *     `start_at` with style `'D'` — exactly the "fabricated date" bug class rule 1 exists
 *     to prevent, just one level removed. `<t:S:D>` renders CLIENT-SIDE, in the viewer's
 *     own timezone; a raw instant (team-local midnight, or any other un-anchored value)
 *     can therefore display the WRONG calendar date to a viewer far enough from the
 *     team's own zone. `discordDateInstant` exists precisely to make that display instant
 *     stable across every viewer timezone (anchoring at 12:00Z of the intended date) — see
 *     its doc comment in `rest/discordTimestamp.ts`.
 *
 * Two independent signals for rule 1, because either one alone is easy to step around:
 *  - the raw token `<t:` as a **substring**, not only inside a backtick template —
 *    `'<t:' + seconds + ':f>'` builds the identical string by concatenation and
 *    would slip past a template-literal-only scan;
 *  - any `toDiscord…Timestamp = ` declaration, not only the literal identifier
 *    `toDiscordTimestamp` — one of the original 14 copies was named
 *    `toDiscordDateTimestamp`, so a scan for the exact name would have missed it.
 *
 * Rule 2 parses each `toDiscordTimestamp(...)` call's own argument list (paren-balanced,
 * comma-split at the top level only) rather than a single regex, because the SECOND
 * argument is sometimes a computed expression, not a bare literal — e.g.
 * `toDiscordTimestamp(entry.start_at, entry.all_day ? 'D' : 'f')` is a violation (the
 * `'D'` branch renders a raw instant date-only) even though the argument as a whole is
 * not the literal string `'D'`.
 *
 * Block comments (`/* ... *\/`, including JSDoc) are stripped before scanning: the
 * primitive's own doc comment, and `eventWhen.ts`'s, both quote the token they emit
 * for documentation — that is not a duplicate implementation and must not fail here.
 *
 * `*.test.ts` files are exempt — several assert on the literal token in the payload
 * they build, which is the point of the test, not a duplicate implementation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SRC = join(ROOT, 'applications/bot/src');
const PRIMITIVE_RELATIVE = join('rest', 'discordTimestamp.ts');
const EVENT_WHEN_RELATIVE = join('rest', 'events', 'eventWhen.ts');

const TOKEN_PATTERN = /<t:/g;
const NAME_PATTERN = /toDiscord\w*Timestamp\s*=/g;

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
};

/** Strips block comments so documentation that quotes the token is not mistaken for
 *  a reimplementation of it. */
const stripBlockComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every non-test `.ts` file under `srcDir` that still builds the token outside the
 *  shared primitive, with the number of occurrences found (counted, not lines). */
export const findViolations = (srcDir) => {
  const violations = [];
  for (const file of walk(srcDir)) {
    if (relative(srcDir, file) === PRIMITIVE_RELATIVE) continue;
    const code = stripBlockComments(readFileSync(file, 'utf8'));
    const count =
      [...code.matchAll(TOKEN_PATTERN)].length + [...code.matchAll(NAME_PATTERN)].length;
    if (count > 0) violations.push({ file, count });
  }
  return violations;
};

/** Index of the `)` matching the `(` at `openIdx`, or -1 if `text` is malformed. */
const findMatchingParen = (text, openIdx) => {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** Splits a call's argument-list text into top-level arguments, respecting nesting —
 *  `discordDateInstant(startDate, event.start_at), 'D'` must split into exactly TWO
 *  arguments, not four, so the inner comma doesn't get mistaken for a top-level one. */
const splitTopLevelArgs = (argsText) => {
  const args = [];
  let depth = 0;
  let current = '';
  for (const ch of argsText) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      args.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) args.push(current);
  return args;
};

const RAW_DATE_STYLE_PATTERN = /['"][Dd]['"]/;
const DATE_INSTANT_PREFIX = 'discordDateInstant(';
const TIMESTAMP_CALL = 'toDiscordTimestamp(';

/** Every `toDiscordTimestamp(...)` call in `code` whose style argument is (or, for a
 *  computed/ternary style, contains) a literal `'D'`/`'d'`, and whose first argument is
 *  NOT itself a `discordDateInstant(...)` projection — a date-only style rendered off a
 *  raw, un-anchored instant (plan S4 review finding). Returns the count found. */
const countRawDateStyleCalls = (code) => {
  let count = 0;
  let searchFrom = 0;
  while (true) {
    const start = code.indexOf(TIMESTAMP_CALL, searchFrom);
    if (start === -1) break;
    const openIdx = start + TIMESTAMP_CALL.length - 1;
    const closeIdx = findMatchingParen(code, openIdx);
    if (closeIdx === -1) break;
    const argsText = code.slice(openIdx + 1, closeIdx);
    searchFrom = closeIdx + 1;

    const args = splitTopLevelArgs(argsText);
    if (args.length < 2) continue;
    const firstArg = args[0].trim();
    const styleArg = args[args.length - 1];
    if (RAW_DATE_STYLE_PATTERN.test(styleArg) && !firstArg.startsWith(DATE_INSTANT_PREFIX)) {
      count++;
    }
  }
  return count;
};

/** Every non-test `.ts` file under `srcDir`, other than `eventWhen.ts`, that renders a
 *  date-only style (`D`/`d`) off a raw instant instead of a `discordDateInstant(...)`
 *  projection, with the number of occurrences found. */
export const findRawDateStyleViolations = (srcDir) => {
  const violations = [];
  for (const file of walk(srcDir)) {
    if (relative(srcDir, file) === EVENT_WHEN_RELATIVE) continue;
    const code = stripBlockComments(readFileSync(file, 'utf8'));
    const count = countRawDateStyleCalls(code);
    if (count > 0) violations.push({ file, count });
  }
  return violations;
};

const srcDir = process.argv[2] ?? DEFAULT_SRC;
const violations = findViolations(srcDir).sort((a, b) => a.file.localeCompare(b.file));
const rawDateStyleViolations = findRawDateStyleViolations(srcDir).sort((a, b) =>
  a.file.localeCompare(b.file),
);

if (violations.length > 0) {
  console.error(
    'Discord timestamp guard FAILED — a raw `<t:` token or a `toDiscord*Timestamp` helper',
  );
  console.error(`exists outside ${PRIMITIVE_RELATIVE}:\n`);
  let total = 0;
  for (const { file, count } of violations) {
    console.error(`  ${relative(ROOT, file)} — ${count} occurrence${count === 1 ? '' : 's'}`);
    total += count;
  }
  console.error(
    `\n${total} occurrence${total === 1 ? '' : 's'} across ${violations.length} file${violations.length === 1 ? '' : 's'}.`,
  );
  console.error('\nUse the shared primitive instead:');
  console.error("  import { toDiscordTimestamp } from '~/rest/discordTimestamp.js';");
  console.error(
    '(or `discordDateInstant` / `discordTimestampFromEpochSeconds` for the all-day and raw-seconds cases).',
  );
}

if (rawDateStyleViolations.length > 0) {
  console.error(
    "Discord timestamp guard FAILED — a `toDiscordTimestamp(...)` call renders style 'D'/'d'",
  );
  console.error(`off a raw instant outside ${EVENT_WHEN_RELATIVE}:\n`);
  let total = 0;
  for (const { file, count } of rawDateStyleViolations) {
    console.error(`  ${relative(ROOT, file)} — ${count} occurrence${count === 1 ? '' : 's'}`);
    total += count;
  }
  console.error(
    `\n${total} occurrence${total === 1 ? '' : 's'} across ${rawDateStyleViolations.length} file${rawDateStyleViolations.length === 1 ? '' : 's'}.`,
  );
  console.error(
    "\n'D'/'d' renders CLIENT-SIDE, in the VIEWER's own timezone — a raw instant can show the",
  );
  console.error('WRONG calendar date to a viewer far enough from the anchor timezone. Wrap it:');
  console.error(
    "  toDiscordTimestamp(discordDateInstant(dateOnly, fallbackInstant), 'D')  // not the raw instant",
  );
}

if (violations.length > 0 || rawDateStyleViolations.length > 0) {
  process.exit(1);
}

console.log(
  `Discord timestamp guard OK — ${PRIMITIVE_RELATIVE} is the only builder of the token, and no` +
    ` date-only style is rendered off a raw instant outside ${EVENT_WHEN_RELATIVE}`,
);
