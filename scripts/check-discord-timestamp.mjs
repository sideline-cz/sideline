#!/usr/bin/env node
/**
 * Asserts there is exactly one place under `applications/bot/src` that builds a raw
 * Discord timestamp token (`<t:seconds:style>`): `rest/discordTimestamp.ts`.
 *
 * That token had been copy-pasted 15 times across 14 files — a `toDiscordTimestamp`
 * (or `toDiscordDateTimestamp`, or an inline literal) hand-rolled per call site, each
 * one independently responsible for remembering to branch on `all_day`. Most did not:
 * eight separate Discord surfaces rendered a fabricated clock time for events that
 * only ever had a *date*, because whichever copy rendered them had never been taught
 * the distinction. Consolidating the duplicates onto one primitive fixed the eight
 * sites in one pass; this guard is what stops copy #15 from reintroducing the same
 * bug at a ninth site.
 *
 * Two independent signals, because either one alone is easy to step around:
 *  - the raw token `<t:` as a **substring**, not only inside a backtick template —
 *    `'<t:' + seconds + ':f>'` builds the identical string by concatenation and
 *    would slip past a template-literal-only scan;
 *  - any `toDiscord…Timestamp = ` declaration, not only the literal identifier
 *    `toDiscordTimestamp` — one of the original 14 copies was named
 *    `toDiscordDateTimestamp`, so a scan for the exact name would have missed it.
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
const ALLOWED_RELATIVE = join('rest', 'discordTimestamp.ts');

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
    if (relative(srcDir, file) === ALLOWED_RELATIVE) continue;
    const code = stripBlockComments(readFileSync(file, 'utf8'));
    const count =
      [...code.matchAll(TOKEN_PATTERN)].length + [...code.matchAll(NAME_PATTERN)].length;
    if (count > 0) violations.push({ file, count });
  }
  return violations;
};

const srcDir = process.argv[2] ?? DEFAULT_SRC;
const violations = findViolations(srcDir).sort((a, b) => a.file.localeCompare(b.file));

if (violations.length > 0) {
  console.error(
    'Discord timestamp guard FAILED — a raw `<t:` token or a `toDiscord*Timestamp` helper',
  );
  console.error(`exists outside ${ALLOWED_RELATIVE}:\n`);
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
  process.exit(1);
}

console.log(`Discord timestamp guard OK — ${ALLOWED_RELATIVE} is the only builder of the token`);
