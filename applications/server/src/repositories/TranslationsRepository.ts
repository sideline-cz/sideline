import { Translations, User } from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class TranslationOverrideRow extends Schema.Class<TranslationOverrideRow>('TranslationOverrideRow')(
  {
    translation_key: Translations.TranslationKey,
    locale: Translations.Locale,
    value: Translations.TranslationValue,
    updated_at: Schemas.DateTimeFromDate,
    updated_by: Schema.OptionFromNullOr(User.UserId),
  },
) {}

const toOverride = (row: TranslationOverrideRow): Translations.TranslationOverride =>
  new Translations.TranslationOverride({
    key: row.translation_key,
    locale: row.locale,
    value: row.value,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  });

const CacheVersionRow = Schema.Struct({
  version: Schema.NumberFromString,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findAllQuery = SqlSchema.findAll({
    Request: Schema.Void,
    Result: TranslationOverrideRow,
    execute: () =>
      sql`SELECT translation_key, locale, value, updated_at, updated_by FROM translation_overrides ORDER BY translation_key, locale`,
  });

  const getVersionQuery = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: CacheVersionRow,
    execute: () => sql`SELECT version FROM translation_cache_version WHERE id = 1`,
  });

  const bumpVersionQuery = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: CacheVersionRow,
    execute: () =>
      sql`
        INSERT INTO translation_cache_version (id, version)
        VALUES (1, 2)
        ON CONFLICT (id) DO UPDATE
          SET version = translation_cache_version.version + 1,
              updated_at = now()
        RETURNING version
      `,
  });

  const findAll = () =>
    findAllQuery(undefined).pipe(
      catchSqlErrors,
      Effect.map((rows) => rows.map(toOverride)),
    );

  const getVersion = () =>
    getVersionQuery(undefined).pipe(
      catchSqlErrors,
      Effect.flatMap((opt) =>
        Option.match(opt, {
          onNone: () => Effect.succeed(1),
          onSome: (row) => Effect.succeed(row.version),
        }),
      ),
    );

  const bumpVersionAndNotify = () =>
    bumpVersionQuery(undefined).pipe(
      catchSqlErrors,
      Effect.flatMap((opt) =>
        Option.match(opt, {
          onNone: () => Effect.succeed(1),
          onSome: (row) => Effect.succeed(row.version),
        }),
      ),
      Effect.tap((version) =>
        sql
          .unsafe(`NOTIFY translation_cache_invalidate, '${String(version)}'`)
          .pipe(catchSqlErrors),
      ),
    );

  const upsert = (args: {
    key: Translations.TranslationKey;
    locale: Translations.Locale;
    value: Translations.TranslationValue;
    updatedBy: User.UserId | null;
  }) =>
    sql
      .withTransaction(
        Effect.Do.pipe(
          Effect.tap(() =>
            sql`
              INSERT INTO translation_overrides (translation_key, locale, value, updated_by)
              VALUES (${args.key}, ${args.locale}, ${args.value}, ${args.updatedBy})
              ON CONFLICT (translation_key, locale) DO UPDATE
                SET value = EXCLUDED.value,
                    updated_at = now(),
                    updated_by = EXCLUDED.updated_by
            `.pipe(catchSqlErrors),
          ),
          Effect.flatMap(() => bumpVersionAndNotify()),
        ),
      )
      .pipe(catchSqlErrors);

  const delete_ = (args: { key: Translations.TranslationKey; locale: Translations.Locale }) =>
    sql
      .withTransaction(
        Effect.Do.pipe(
          Effect.tap(() =>
            sql`
              DELETE FROM translation_overrides
              WHERE translation_key = ${args.key} AND locale = ${args.locale}
            `.pipe(catchSqlErrors),
          ),
          Effect.flatMap(() => bumpVersionAndNotify()),
        ),
      )
      .pipe(catchSqlErrors);

  const importMerge = (args: {
    entries: ReadonlyArray<{
      key: Translations.TranslationKey;
      locale: Translations.Locale;
      value: Translations.TranslationValue;
    }>;
    updatedBy: User.UserId | null;
  }) =>
    sql
      .withTransaction(
        Effect.Do.pipe(
          Effect.tap(() =>
            Effect.all(
              args.entries.map((entry) =>
                sql`
                  INSERT INTO translation_overrides (translation_key, locale, value, updated_by)
                  VALUES (${entry.key}, ${entry.locale}, ${entry.value}, ${args.updatedBy})
                  ON CONFLICT (translation_key, locale) DO UPDATE
                    SET value = EXCLUDED.value,
                        updated_at = now(),
                        updated_by = EXCLUDED.updated_by
                `.pipe(catchSqlErrors),
              ),
              { concurrency: 1 },
            ),
          ),
          Effect.flatMap(() => bumpVersionAndNotify()),
        ),
      )
      .pipe(catchSqlErrors);

  return {
    findAll,
    getVersion,
    upsert,
    delete_,
    importMerge,
  };
});

export class TranslationsRepository extends ServiceMap.Service<
  TranslationsRepository,
  Effect.Success<typeof make>
>()('api/TranslationsRepository') {
  static readonly Default = Layer.effect(TranslationsRepository, make);
}
