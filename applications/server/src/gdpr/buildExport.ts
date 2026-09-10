import { Array as Arr, Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { EXPORT_MANIFEST, NEVER_EXPORT_COLUMNS } from './exportManifest.js';

/**
 * Assembles a person's Art. 15 data export straight from `EXPORT_MANIFEST`.
 *
 * Generated rather than hand-written, on purpose. A hand-written export drifts
 * from the schema the moment a table is added, and drift is the failure mode
 * that makes an export dishonest — it still calls itself "your data" while
 * quietly missing some. The manifest is the single list, the integration test
 * pins it to `information_schema`, and this reads it.
 *
 * **Redaction is structural.** Redacted columns are removed from the SELECT
 * list, so a credential is not fetched and then stripped — it never leaves
 * Postgres. There is no code path that could forget the stripping step,
 * because there is no stripping step.
 *
 * Results are keyed by `table.column` rather than by table. A row can be
 * yours through more than one relationship (`expenses.created_by_user_id` and
 * `expenses.updated_by_user_id`), and keying by the relationship says *why*
 * each row is in the export instead of silently merging or de-duplicating
 * them.
 */

/** Postgres identifiers this module is willing to interpolate. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const quote = (identifier: string): string => {
  if (!SAFE_IDENTIFIER.test(identifier)) {
    throw new Error(`Refusing to interpolate identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};

export interface ExportBundle {
  readonly generatedAt: string;
  readonly subjectUserId: string;
  /** `table.column` → the rows reached through that relationship. */
  readonly data: Record<string, ReadonlyArray<Record<string, unknown>>>;
  /**
   * Reported in the export itself: someone receiving it can see what was held
   * back and argue with the reasoning, rather than having to infer the gaps.
   */
  readonly excluded: ReadonlyArray<{ readonly table: string; readonly reason: string }>;
  readonly redactedColumns: ReadonlyArray<string>;
}

interface ColumnRow {
  readonly table_name: string;
  readonly column_name: string;
}

interface IdRow {
  readonly id: string;
}

export const buildExport = (
  userId: string,
): Effect.Effect<ExportBundle, unknown, SqlClient.SqlClient> =>
  Effect.Do.pipe(
    Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),

    // One round trip for the whole column catalogue; the alternative is a
    // query per table just to discover what to select.
    Effect.bind(
      'columns',
      ({ sql }) =>
        sql<ColumnRow>`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
      `,
    ),

    // Team-scoped tables hang off `team_members`, not `users`.
    Effect.bind('memberIds', ({ sql }) =>
      sql<IdRow>`SELECT id FROM team_members WHERE user_id = ${userId}`.pipe(
        Effect.map(Arr.map((row) => row.id)),
      ),
    ),

    Effect.bind('data', ({ sql, columns, memberIds }) => {
      const columnsFor = (table: string) =>
        columns.filter((c) => c.table_name === table).map((c) => c.column_name);

      const queries = EXPORT_MANIFEST.flatMap((entry) => {
        if (entry.disposition.kind !== 'export') return [];
        const redacted = new Set(entry.disposition.redact ?? []);
        const selectable = columnsFor(entry.table).filter((c) => !redacted.has(c));

        // A table in the manifest that the schema does not have; the
        // integration test already fails on this, so treat it as nothing to
        // export rather than crashing someone's download.
        if (selectable.length === 0) return [];

        const selectList = selectable.map(quote).join(', ');
        const ids = entry.subject === 'users' ? [userId] : memberIds;

        return entry.via.map((column) => ({
          key: `${entry.table}.${column}`,
          run:
            ids.length === 0
              ? Effect.succeed([] as ReadonlyArray<Record<string, unknown>>)
              : sql<Record<string, unknown>>`
                  SELECT ${sql.unsafe(selectList)}
                  FROM ${sql.unsafe(quote(entry.table))}
                  WHERE ${sql.unsafe(quote(column))} IN ${sql.in(ids)}
                `.pipe(Effect.map((rows) => rows as ReadonlyArray<Record<string, unknown>>)),
        }));
      });

      return Effect.forEach(
        queries,
        ({ key, run }) => run.pipe(Effect.map((rows) => [key, rows] as const)),
        {
          concurrency: 4,
        },
      ).pipe(Effect.map((pairs) => Object.fromEntries(pairs)));
    }),

    Effect.map(({ data }) => ({
      generatedAt: new Date().toISOString(),
      subjectUserId: userId,
      data,
      excluded: EXPORT_MANIFEST.flatMap((entry) =>
        entry.disposition.kind === 'exclude'
          ? [{ table: entry.table, reason: entry.disposition.reason }]
          : [],
      ),
      redactedColumns: NEVER_EXPORT_COLUMNS,
    })),
  );
