import { Array as Arr, Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { EXPORT_MANIFEST, SUBJECT_ERASURE } from './exportManifest.js';

/**
 * Erases a person, driven by the same manifest the export reads.
 *
 * **Anonymise in place.** The identity lives on `users`; scrubbing it there
 * turns the id in all 49 referencing tables into a pseudonym, which is why
 * most tables need no statement at all. Rows are not deleted wholesale
 * because doing so would cascade away records belonging to other people — the
 * events someone organised, the polls they created, the ratings they
 * submitted about teammates.
 *
 * **Everything happens in one transaction.** A half-erased person is worse
 * than an un-erased one: it fails the request, leaves rows in a state no code
 * expects, and gives no clean point to retry from. If any statement fails,
 * nothing is written.
 *
 * **Idempotent.** Running it twice is a no-op the second time — the scrubbed
 * columns are already null, the deleted rows are already gone, and the
 * placeholder is derived from the row id rather than randomly, so it does not
 * churn. That matters because a person handling a GDPR request may well run
 * it again to check it worked.
 *
 * Deliberately **not** wired to a self-service endpoint. §6 of the privacy
 * policy says deletion is handled by a person, and this is the tool that
 * person uses; making it a button is a separate decision with its own
 * confirmation-flow and recovery questions.
 */

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const quote = (identifier: string): string => {
  if (!SAFE_IDENTIFIER.test(identifier)) {
    throw new Error(`Refusing to interpolate identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};

export interface ErasureStep {
  readonly table: string;
  readonly action: 'delete' | 'scrub' | 'null' | 'placeholder';
  readonly detail: string;
  readonly rows: number;
}

export interface ErasureReport {
  readonly subjectUserId: string;
  readonly dryRun: boolean;
  readonly steps: ReadonlyArray<ErasureStep>;
  /** Tables the manifest deliberately leaves alone, and why. */
  readonly kept: ReadonlyArray<{ readonly table: string; readonly reason: string }>;
}

export interface EraseOptions {
  /**
   * Report what would change without writing anything. The transaction is
   * still opened and still rolled back, so a dry run exercises the same SQL
   * the real thing does rather than a hopeful approximation of it.
   */
  readonly dryRun: boolean;
}

class DryRunRollback {
  readonly _tag = 'DryRunRollback';
  constructor(readonly steps: ReadonlyArray<ErasureStep>) {}
}

export const eraseUser = (
  userId: string,
  options: EraseOptions,
): Effect.Effect<ErasureReport, unknown, SqlClient.SqlClient> =>
  Effect.Do.pipe(
    Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
    Effect.bind('steps', ({ sql }) => {
      const body = Effect.Do.pipe(
        Effect.bind('memberIds', () =>
          sql<{ id: string }>`SELECT id FROM team_members WHERE user_id = ${userId}`.pipe(
            Effect.map(Arr.map((row) => row.id)),
          ),
        ),
        Effect.bind('collected', ({ memberIds }) => {
          const statements = EXPORT_MANIFEST.flatMap((entry) => {
            const ids = entry.subject === 'users' ? [userId] : memberIds;
            if (ids.length === 0) return [];

            // Hoisted so the union narrows inside the closure below; reading
            // `entry.erasure` there keeps the full union.
            const erasure = entry.erasure;
            if (erasure.kind === 'keep') return [];

            return entry.via.flatMap((column) => {
              if (erasure.kind === 'delete') {
                return [
                  sql`
                    DELETE FROM ${sql.unsafe(quote(entry.table))}
                    WHERE ${sql.unsafe(quote(column))} IN ${sql.in(ids)}
                  `.pipe(
                    Effect.map(
                      (r): ErasureStep => ({
                        table: entry.table,
                        action: 'delete',
                        detail: `via ${column}`,
                        rows: Array.isArray(r) ? r.length : 0,
                      }),
                    ),
                  ),
                ];
              }

              // scrub: null the free-text columns, keep the row.
              const assignments = erasure.columns.map((c) => `${quote(c)} = NULL`).join(', ');
              return [
                sql`
                  UPDATE ${sql.unsafe(quote(entry.table))}
                  SET ${sql.unsafe(assignments)}
                  WHERE ${sql.unsafe(quote(column))} IN ${sql.in(ids)}
                `.pipe(
                  Effect.map(
                    (r): ErasureStep => ({
                      table: entry.table,
                      action: 'scrub',
                      detail: erasure.columns.join(', '),
                      rows: Array.isArray(r) ? r.length : 0,
                    }),
                  ),
                ),
              ];
            });
          });

          // The subject tables last: scrubbing `users` is what pseudonymises
          // everything above, so doing it first would make the id lookups
          // above read a row that no longer describes anyone.
          const subjects = SUBJECT_ERASURE.flatMap((subject) => {
            const ids = subject.table === 'users' ? [userId] : memberIds;
            if (ids.length === 0) return [];
            const key = subject.table === 'users' ? 'id' : 'id';

            const sets = [
              ...subject.nullColumns.map((c) => `${quote(c)} = NULL`),
              // Derived from the row id, not random: rerunning must not churn,
              // and the column is NOT NULL and usually UNIQUE.
              ...subject.placeholderColumns.map(
                (c) => `${quote(c)} = 'erased-' || ${quote(key)}::text`,
              ),
            ];
            if (sets.length === 0) return [];

            return [
              sql`
                UPDATE ${sql.unsafe(quote(subject.table))}
                SET ${sql.unsafe(sets.join(', '))}
                WHERE ${sql.unsafe(quote(key))} IN ${sql.in(ids)}
              `.pipe(
                Effect.map(
                  (r): ErasureStep => ({
                    table: subject.table,
                    action: subject.placeholderColumns.length > 0 ? 'placeholder' : 'null',
                    detail: [...subject.nullColumns, ...subject.placeholderColumns].join(', '),
                    rows: Array.isArray(r) ? r.length : 0,
                  }),
                ),
              ),
            ];
          });

          return Effect.all([...statements, ...subjects], { concurrency: 1 });
        }),
        Effect.flatMap(({ collected }) =>
          // Rolling back is how a dry run stays honest: it runs the real
          // statements against the real rows and then throws the work away.
          options.dryRun ? Effect.fail(new DryRunRollback(collected)) : Effect.succeed(collected),
        ),
      );

      return sql.withTransaction(body).pipe(
        Effect.catchIf(
          (e): e is DryRunRollback => e instanceof DryRunRollback,
          (e) => Effect.succeed(e.steps),
        ),
      );
    }),
    Effect.map(({ steps }) => ({
      subjectUserId: userId,
      dryRun: options.dryRun,
      steps,
      kept: EXPORT_MANIFEST.flatMap((entry) =>
        entry.erasure.kind === 'keep' ? [{ table: entry.table, reason: entry.erasure.reason }] : [],
      ),
    })),
  );
