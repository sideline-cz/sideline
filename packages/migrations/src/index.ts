import { fileURLToPath } from 'node:url';
import { Effect, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { fromFileSystem, MigrationError } from 'effect/unstable/sql/Migrator';

const makeMigrator = (table: string, directory: string) =>
  Effect.Do.pipe(
    Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
    Effect.tap(({ sql }) =>
      Effect.catch(
        sql`select ${table}::regclass`,
        () =>
          sql`CREATE TABLE ${sql(table)} (
  migration_id integer primary key,
  created_at timestamp with time zone not null default now(),
  name text not null
)`,
      ),
    ),
    Effect.tap(({ sql }) => sql`LOCK TABLE ${sql(table)} IN ACCESS EXCLUSIVE MODE`),
    Effect.bind('applied', ({ sql }) =>
      sql`SELECT migration_id FROM ${sql(table)}`.withoutTransform.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ migration_id: Schema.Number }))),
        ),
        Effect.map((rows) => new Set(rows.map((row) => row.migration_id))),
        Effect.mapError(
          () =>
            new MigrationError({
              kind: 'BadState',
              message: `Could not read applied migration ids from "${table}"`,
            }),
        ),
      ),
    ),
    Effect.bind('allMigrations', () => fromFileSystem(directory)),
    Effect.bind('pending', ({ applied, allMigrations }) =>
      Effect.succeed(allMigrations.filter(([id]) => !applied.has(id))),
    ),
    Effect.tap(({ sql, pending }) =>
      Effect.forEach(
        pending,
        ([id, name, load]) =>
          Effect.Do.pipe(
            Effect.bind('migrationEffect', () =>
              Effect.catchDefect(load, (defect) =>
                Effect.fail(
                  new MigrationError({
                    kind: 'ImportError',
                    message: `Could not import migration "${id}_${name}"\n\n${defect}`,
                  }),
                ),
              ).pipe(
                Effect.flatMap((mod) => {
                  if (Effect.isEffect(mod)) {
                    return Effect.succeed(
                      mod as Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
                    );
                  }
                  if (
                    mod !== null &&
                    mod !== undefined &&
                    typeof mod === 'object' &&
                    'default' in mod
                  ) {
                    const defaultExport = mod.default;
                    const resolved =
                      defaultExport !== null &&
                      defaultExport !== undefined &&
                      typeof defaultExport === 'object' &&
                      'default' in defaultExport
                        ? defaultExport.default
                        : defaultExport;
                    if (Effect.isEffect(resolved)) {
                      return Effect.succeed(
                        resolved as Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
                      );
                    }
                  }
                  return Effect.fail(
                    new MigrationError({
                      kind: 'ImportError',
                      message: `Default export not found or not an Effect for migration "${id}_${name}"`,
                    }),
                  );
                }),
              ),
            ),
            Effect.tap(({ migrationEffect }) =>
              sql.withTransaction(
                Effect.Do.pipe(
                  Effect.tap(() =>
                    Effect.catch(migrationEffect, (error) =>
                      Effect.die(
                        new MigrationError({
                          cause: error,
                          kind: 'Failed',
                          message: `Migration "${id}_${name}" failed`,
                        }),
                      ),
                    ),
                  ),
                  Effect.tap(
                    () =>
                      sql`INSERT INTO ${sql(table)} (migration_id, name) VALUES (${id}, ${name})`,
                  ),
                ),
              ),
            ),
            Effect.tap(() =>
              Effect.logDebug(`Migration applied`).pipe(
                Effect.annotateLogs('migration_id', String(id)),
                Effect.annotateLogs('migration_name', name),
              ),
            ),
          ),
        { discard: true },
      ),
    ),
    Effect.asVoid,
  );

export const BeforeMigrator = makeMigrator(
  'migrations_before',
  fileURLToPath(new URL('before', import.meta.url)),
);

export const AfterMigrator = makeMigrator(
  'migrations_after',
  fileURLToPath(new URL('after', import.meta.url)),
);
