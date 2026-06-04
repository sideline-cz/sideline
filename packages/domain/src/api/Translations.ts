import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { UserId } from '~/models/User.js';

export const TranslationKey = Schema.NonEmptyString;
export type TranslationKey = Schema.Schema.Type<typeof TranslationKey>;

export const Locale = Schema.Literals(['en', 'cs']);
export type Locale = Schema.Schema.Type<typeof Locale>;

export const TranslationValue = Schema.String;
export type TranslationValue = Schema.Schema.Type<typeof TranslationValue>;

export class TranslationOverride extends Schema.Class<TranslationOverride>('TranslationOverride')({
  key: TranslationKey,
  locale: Locale,
  value: TranslationValue,
  updatedAt: Schemas.DateTimeFromDate,
  updatedBy: Schema.OptionFromNullOr(UserId),
}) {}

export class TranslationsResponse extends Schema.Class<TranslationsResponse>(
  'TranslationsResponse',
)({
  version: Schema.Number,
  overrides: Schema.Array(TranslationOverride),
}) {}

export const UpsertTranslationPayload = Schema.Struct({
  en: Schema.OptionFromOptional(Schema.NullOr(TranslationValue)),
  cs: Schema.OptionFromOptional(Schema.NullOr(TranslationValue)),
});
export type UpsertTranslationPayload = Schema.Schema.Type<typeof UpsertTranslationPayload>;

export const ImportTranslationsPayload = Schema.Struct({
  overrides: Schema.Array(
    Schema.Struct({
      key: TranslationKey,
      locale: Locale,
      value: TranslationValue,
    }),
  ),
});
export type ImportTranslationsPayload = Schema.Schema.Type<typeof ImportTranslationsPayload>;

export class UnknownTranslationKeys extends Schema.TaggedErrorClass<UnknownTranslationKeys>()(
  'UnknownTranslationKeys',
  { keys: Schema.Array(Schema.String) },
) {}

export class TranslationForbidden extends Schema.TaggedErrorClass<TranslationForbidden>()(
  'TranslationForbidden',
  {},
) {}

export class TranslationsApiGroup extends HttpApiGroup.make('translations')
  .add(
    HttpApiEndpoint.get('list', '/translations', {
      success: TranslationsResponse,
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('upsert', '/translations/:key', {
      success: TranslationsResponse,
      error: TranslationForbidden.pipe(HttpApiSchema.status(403)),
      payload: UpsertTranslationPayload,
      params: { key: TranslationKey },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('import_', '/translations/import', {
      success: TranslationsResponse,
      error: [
        TranslationForbidden.pipe(HttpApiSchema.status(403)),
        UnknownTranslationKeys.pipe(HttpApiSchema.status(400)),
      ],
      payload: ImportTranslationsPayload,
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('exportJson', '/translations/export.json', {
      success: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
      error: TranslationForbidden.pipe(HttpApiSchema.status(403)),
    }).middleware(AuthMiddleware),
  ) {}
