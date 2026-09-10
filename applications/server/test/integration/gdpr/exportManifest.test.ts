// The manifest is only trustworthy if it cannot drift from the schema.
//
// A GDPR Art. 15 export has to be complete; one that silently omits a table is
// worse than none, because it presents itself as "your data". There are 51
// foreign keys into `users` and `team_members`, and the set grows — relying on
// whoever adds a table to also remember the export is exactly the discipline
// that let a guard test go ungeneralised twice this week.
//
// So this reads the real foreign keys out of `information_schema` and asserts
// the manifest matches exactly. Add a table that references a person and this
// fails until someone records a decision: export it, or exclude it and say why.

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { EXPORT_MANIFEST, NEVER_EXPORT_COLUMNS, SUBJECT_ERASURE } from '~/gdpr/exportManifest.js';
import { TestPgClient } from '../helpers.js';

interface ForeignKey {
  readonly table_name: string;
  readonly column_name: string;
  readonly refs: string;
}

const personForeignKeys = SqlClient.SqlClient.asEffect().pipe(
  Effect.flatMap((sql) =>
    sql.unsafe<ForeignKey>(`
      SELECT tc.table_name, kcu.column_name, ccu.table_name AS refs
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name IN ('users', 'team_members')
      ORDER BY ccu.table_name, tc.table_name, kcu.column_name
    `),
  ),
);

/** `table.column` for every way a row can point at a person. */
const manifestPairs = new Set(
  EXPORT_MANIFEST.flatMap((e) => e.via.map((c) => `${e.subject}:${e.table}.${c}`)),
);

describe('GDPR export manifest', () => {
  it.effect('covers every foreign key into users or team_members', () =>
    Effect.gen(function* () {
      const keys = yield* personForeignKeys;
      const actual = new Set(keys.map((k) => `${k.refs}:${k.table_name}.${k.column_name}`));

      const missing = [...actual].filter((k) => !manifestPairs.has(k)).sort();
      const stale = [...manifestPairs].filter((k) => !actual.has(k)).sort();

      expect(
        missing,
        'These reference a person but the manifest says nothing about them. ' +
          'Add them to EXPORT_MANIFEST — export them, or exclude them with a reason.',
      ).toEqual([]);
      expect(
        stale,
        'The manifest names these but the schema does not. Drop them from EXPORT_MANIFEST.',
      ).toEqual([]);
    }).pipe(Effect.provide(TestPgClient)),
  );

  it.effect('names only columns that exist', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql.unsafe<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
      );
      const existing = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));

      const bogus = NEVER_EXPORT_COLUMNS.filter((c) => !existing.has(c)).sort();

      // A redaction naming a column that no longer exists protects nothing,
      // and reads as though it does.
      expect(bogus, 'Redacted columns that do not exist — the redaction is a no-op.').toEqual([]);
    }).pipe(Effect.provide(TestPgClient)),
  );

  it('redacts every credential the schema holds for a person', () => {
    // Checked as a literal list rather than by pattern: a new secret column
    // should have to be thought about, not silently matched by a regex.
    expect([...NEVER_EXPORT_COLUMNS].sort()).toEqual([
      'ical_tokens.token',
      'oauth_connections.access_token',
      'oauth_connections.refresh_token',
      'sessions.token',
      'team_onboarding_tokens.token_hash',
    ]);
  });

  it('gives every exclusion a reason someone can argue with', () => {
    for (const entry of EXPORT_MANIFEST) {
      if (entry.disposition.kind === 'exclude') {
        expect(
          entry.disposition.reason.length,
          `${entry.table} needs a real reason`,
        ).toBeGreaterThan(40);
      }
    }
  });

  // Erasure decisions get the same treatment as export decisions: the manifest
  // is one list, so adding a table forces both answers at once. A second list
  // would drift from the first, which is the failure this file exists to stop.
  it('gives every table an erasure decision with a reason', () => {
    for (const entry of EXPORT_MANIFEST) {
      expect(
        entry.erasure.reason.length,
        `${entry.table}.${entry.via.join('/')} needs a real erasure reason`,
      ).toBeGreaterThan(40);
      if (entry.erasure.kind === 'scrub') {
        expect(entry.erasure.columns.length, `${entry.table} scrubs nothing`).toBeGreaterThan(0);
      }
    }
  });

  it.effect('scrubs and nulls only columns that exist', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql.unsafe<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
      );
      const existing = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));

      const named = [
        ...EXPORT_MANIFEST.flatMap((e) =>
          e.erasure.kind === 'scrub' ? e.erasure.columns.map((c) => `${e.table}.${c}`) : [],
        ),
        ...SUBJECT_ERASURE.flatMap((s) =>
          [...s.nullColumns, ...s.placeholderColumns].map((c) => `${s.table}.${c}`),
        ),
      ];

      // A scrub naming a column that no longer exists erases nothing while
      // reading as though it does — the same trap as a stale redaction.
      expect(named.filter((c) => !existing.has(c)).sort()).toEqual([]);
    }).pipe(Effect.provide(TestPgClient)),
  );

  it.effect('never nulls a NOT NULL column — those need a placeholder', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql.unsafe<{
        table_name: string;
        column_name: string;
        is_nullable: string;
      }>(
        `SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public'`,
      );
      const notNull = new Set(
        cols.filter((c) => c.is_nullable === 'NO').map((c) => `${c.table_name}.${c.column_name}`),
      );

      const nulled = [
        ...EXPORT_MANIFEST.flatMap((e) =>
          e.erasure.kind === 'scrub' ? e.erasure.columns.map((c) => `${e.table}.${c}`) : [],
        ),
        ...SUBJECT_ERASURE.flatMap((s) => s.nullColumns.map((c) => `${s.table}.${c}`)),
      ];

      // Erasure that throws at runtime is worse than erasure that is merely
      // incomplete: the request fails halfway and leaves a half-scrubbed row.
      expect(
        nulled.filter((c) => notNull.has(c)).sort(),
        'These are NOT NULL — move them to placeholderColumns.',
      ).toEqual([]);
    }).pipe(Effect.provide(TestPgClient)),
  );

  it.effect('replaces every NOT NULL identity column with a placeholder', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql.unsafe<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users'`,
      );
      const notNull = new Set(cols.filter((c) => c.is_nullable === 'NO').map((c) => c.column_name));
      const users = SUBJECT_ERASURE.find((s) => s.table === 'users');

      // `discord_id` and `username` identify a person and cannot be nulled.
      for (const column of ['discord_id', 'username']) {
        expect(notNull.has(column), `${column} is expected to be NOT NULL`).toBe(true);
        expect(users?.placeholderColumns).toContain(column);
      }
    }).pipe(Effect.provide(TestPgClient)),
  );
});
