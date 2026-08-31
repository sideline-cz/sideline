// Blocker 1 guard (whole-series review, fix/discord-onboarding-webapp): `tr()` never throws on
// an unknown key — it `console.warn`s and returns the raw key string (`~/lib/translations.ts`).
// That is exactly how `ConnectDiscordPage` shipped a raw `discord_connect_regenerate` literal to
// users: the referenced key didn't exist in the catalogue (the real one is
// `discord_connect_regenerateButton`), nothing failed loudly, and the mismatch shipped straight
// through review and CI.
//
// This sweeps every `tr('literal-key')` / `tr("literal-key")` call site under `src/` and asserts
// the key actually resolves against the compiled `@sideline/i18n` catalogue. It is a source-text
// regex, not a type-checker — dynamic call sites (`tr(variable)`, `tr(\`template-${x}\`)`,
// `tr(lookup[key])`) are invisible to it by construction and are skipped rather than flagged;
// only a literal first argument is checked. See `TeamSettingsPage.dirty.test.ts` for the
// precedent of guarding an invariant this way when the type system can't express it.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { messageKeys } from '@sideline/i18n/registry';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// A call to a function literally named `tr`, with a single- or double-quoted string as the
// (first) argument — never a backtick template or a bare identifier/expression, which is exactly
// the set of call sites this test cannot safely resolve and must not flag.
const STATIC_TR_CALL = /\btr\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/g;

const collectSourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : collectSourceFiles(full);
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    if (/\.test\.(ts|tsx)$/.test(entry.name)) return [];
    // The `tr()` wrapper itself and the module it wraps aren't call sites.
    if (full === join(SRC_DIR, 'lib', 'translations.ts')) return [];
    return [full];
  });

describe('static tr() call sites resolve against the i18n catalogue', () => {
  const knownKeys = new Set(messageKeys);
  const files = collectSourceFiles(SRC_DIR);

  it('found at least a plausible number of static call sites (regex sanity check)', () => {
    const total = files.reduce(
      (sum, file) => sum + [...readFileSync(file, 'utf8').matchAll(STATIC_TR_CALL)].length,
      0,
    );
    // If this drops to (near) zero, the regex broke, not the codebase — `tr(` is used hundreds
    // of times with a literal key across `src/`.
    expect(total).toBeGreaterThan(100);
  });

  it('every literal key used in a tr(...) call exists in the compiled catalogue', () => {
    const unresolved: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(STATIC_TR_CALL)) {
        const key = match[2];
        if (!knownKeys.has(key)) {
          const line = content.slice(0, match.index).split('\n').length;
          unresolved.push(`${relative(SRC_DIR, file)}:${line} — "${key}"`);
        }
      }
    }
    expect(unresolved).toEqual([]);
  });
});
