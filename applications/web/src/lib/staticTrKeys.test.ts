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
//
// Should-fix 4 (review of 46806427): two gaps in this guard.
//
// 1. `tr('prefix_' + x)` — a legitimate pattern nothing here uses today, but nothing stopped it —
//    used to be mis-captured as the literal key `"prefix_"`, which does not exist in the
//    catalogue, so this test would FAIL on code that is not a bug. `extractStaticTrKeys` now
//    looks at what follows the closing quote and skips a match immediately followed by `+`
//    (string concatenation) rather than mis-flagging it. This is cheap to do and cheap to get
//    wrong, so it is unit-tested directly against synthetic source below, independent of whatever
//    happens to be in `src/` right now.
//
// 2. Several real call sites build the key itself and can never be seen by a literal-argument
//    scan: `SyncRolesButton.tsx`'s `discord_syncError_${bucket}`, `ConnectDiscordPage.tsx`'s
//    `errorCopyKey` (returns one of several string literals, but the `tr(...)` call site itself
//    receives a variable), `AccessLevelSelect`'s `labelMap`/`helpMap`, `DashboardCustomizer`'s
//    `WIDGET_LABELS`, and `PaymentStatusBadge`'s `` tr(`finance_status_${status}`) ``. This test
//    cannot safely resolve any of them — nor can it catch the reverse mistake, a key deleted from
//    the catalogue while only ever referenced dynamically (this is exactly how commit 46806427
//    could have silently orphaned any of the seven keys it deleted, had one still been read this
//    way). Asserting the FULL enumerable set the code can produce for each family is cheap
//    (they're all finite, hand-counted unions) and catches that deletion; it is not a general
//    dynamic-key type system, and is not meant to be one.
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

interface StaticTrMatch {
  readonly key: string;
  readonly index: number;
}

/** Extracts every `tr('literal')` key from `content`, skipping a match that is immediately
 * followed (ignoring whitespace) by `+` — i.e. `tr('prefix_' + x)` — since that literal is only a
 * fragment of the real key, not the key itself, and must not be checked against the catalogue. */
const extractStaticTrKeys = (content: string): ReadonlyArray<StaticTrMatch> => {
  const matches: StaticTrMatch[] = [];
  for (const match of content.matchAll(STATIC_TR_CALL)) {
    const index = match.index;
    const afterMatch = content.slice(index + match[0].length);
    const isConcatenation = /^\s*\+/.test(afterMatch);
    if (isConcatenation) continue;
    matches.push({ key: match[2], index });
  }
  return matches;
};

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

describe('extractStaticTrKeys (regex behavior, synthetic fixtures)', () => {
  it('captures an ordinary literal call', () => {
    expect(extractStaticTrKeys(`tr('discord_connect_retry')`)).toEqual([
      { key: 'discord_connect_retry', index: 0 },
    ]);
  });

  it('skips a concatenated key instead of mis-capturing the leading fragment', () => {
    expect(extractStaticTrKeys(`tr('discord_syncError_' + bucket)`)).toEqual([]);
  });

  it('skips a concatenated key with a double-quoted fragment and later whitespace before +', () => {
    expect(extractStaticTrKeys(`tr("prefix_"   + suffix)`)).toEqual([]);
  });

  it('does not let a concatenation in one call suppress a genuine literal call elsewhere', () => {
    const content = `tr('discord_connect_retry');\ntr('prefix_' + x);\ntr('discord_connect_skip')`;
    expect(extractStaticTrKeys(content).map((m) => m.key)).toEqual([
      'discord_connect_retry',
      'discord_connect_skip',
    ]);
  });
});

describe('static tr() call sites resolve against the i18n catalogue', () => {
  const knownKeys = new Set(messageKeys);
  const files = collectSourceFiles(SRC_DIR);

  it('found at least a plausible number of static call sites (regex sanity check)', () => {
    const total = files.reduce(
      (sum, file) => sum + extractStaticTrKeys(readFileSync(file, 'utf8')).length,
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
      for (const { key, index } of extractStaticTrKeys(content)) {
        if (!knownKeys.has(key)) {
          const line = content.slice(0, index).split('\n').length;
          unresolved.push(`${relative(SRC_DIR, file)}:${line} — "${key}"`);
        }
      }
    }
    expect(unresolved).toEqual([]);
  });
});

// Should-fix 4, gap 2: the enumerable key families the regex sweep above can never see, because
// the `tr(...)` call site itself never holds the literal — it holds a variable or a template
// literal built from a finite union. Each entry here is the FULL set of keys that family's source
// can produce today; if a future edit deletes one of these keys from the catalogue while a
// dynamic call site is the only remaining reference, this is what catches it.
describe('known dynamic tr() key families resolve against the i18n catalogue', () => {
  const knownKeys = new Set(messageKeys);

  const families: ReadonlyArray<{ readonly name: string; readonly keys: ReadonlyArray<string> }> = [
    {
      // SyncRolesButton.tsx's errorCopyKey: `discord_syncError_${code === 'captain_action' ?
      // 'captainAction' : code === 'user_action' ? 'userAction' : code}` over
      // 'retryable' | 'captain_action' | 'user_action' | 'unknown'.
      name: 'SyncRolesButton discord_syncError_*',
      keys: [
        'discord_syncError_retryable',
        'discord_syncError_captainAction',
        'discord_syncError_userAction',
        'discord_syncError_unknown',
      ],
    },
    {
      // ConnectDiscordPage.tsx's errorCopyKey: every branch of the Option.match over
      // Invite.JoinStatusErrorCode plus the None case.
      name: 'ConnectDiscordPage discord_connect_error_*',
      keys: [
        'discord_connect_error_generic',
        'discord_connect_error_captainAction',
        'discord_connect_error_botPerms',
        'discord_connect_error_rateLimited',
      ],
    },
    {
      // AccessLevelSelect.tsx's labelMap/helpMap over TeamChannelAccess.AccessLevel
      // ('VIEW' | 'EDIT' | 'ADMIN').
      name: 'AccessLevelSelect channels_accessLevel_*',
      keys: [
        'channels_accessLevel_view',
        'channels_accessLevel_edit',
        'channels_accessLevel_admin',
        'channels_accessLevel_view_help',
        'channels_accessLevel_edit_help',
        'channels_accessLevel_admin_help',
      ],
    },
    {
      // DashboardCustomizer.tsx's WIDGET_LABELS.
      name: 'DashboardCustomizer dashboard_widget_*',
      keys: [
        'dashboard_widget_awaitingRsvp',
        'dashboard_widget_outstandingPayments',
        'dashboard_widget_stats',
        'dashboard_widget_upcomingEvents',
        'dashboard_widget_activity',
        'dashboard_widget_teamManagement',
      ],
    },
    {
      // PaymentStatusBadge.tsx's `tr(\`finance_status_${status}\`)` over
      // FeeAssignment.FeeAssignmentStatus.
      name: 'PaymentStatusBadge finance_status_*',
      keys: [
        'finance_status_pending',
        'finance_status_partial',
        'finance_status_paid',
        'finance_status_overdue',
        'finance_status_waived',
      ],
    },
  ];

  for (const family of families) {
    it(`${family.name} — every key the source can produce exists in the catalogue`, () => {
      const missing = family.keys.filter((key) => !knownKeys.has(key));
      expect(missing).toEqual([]);
    });
  }

  it('every family lists at least one key (guards against an empty, always-passing fixture)', () => {
    for (const family of families) {
      expect(family.keys.length).toBeGreaterThan(0);
    }
  });
});
