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
import { EXPORT_MANIFEST, NEVER_EXPORT_COLUMNS } from '~/gdpr/exportManifest.js';
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
});
