import { Schemas } from '@sideline/effect-lib';
import { createEnv } from '@t3-oss/env-core';
import { Schema } from 'effect';

export const env = createEnv({
  server: {
    NODE_ENV: Schema.toStandardSchemaV1(Schemas.NodeEnv),
    PORT: Schema.NumberFromString.pipe(
      Schemas.Optional(() => 80),
      Schema.toStandardSchemaV1,
    ),
    HEALTH_PORT: Schema.NumberFromString.pipe(
      Schemas.Optional(() => 9000),
      Schema.toStandardSchemaV1,
    ),
    API_PREFIX: Schema.String.pipe(
      Schemas.Optional(() => ''),
      Schema.toStandardSchemaV1,
    ),
    RPC_PREFIX: Schema.String.pipe(
      Schemas.Optional(() => ''),
      Schema.toStandardSchemaV1,
    ),
    SERVER_URL: Schema.URLFromString.pipe(Schema.toStandardSchemaV1),
    DATABASE_HOST: Schema.NonEmptyString.pipe(Schema.toStandardSchemaV1),
    DATABASE_PORT: Schema.NumberFromString.pipe(
      Schemas.Optional(() => 5432),
      Schema.toStandardSchemaV1,
    ),
    DATABASE_MAIN: Schema.NonEmptyString.pipe(Schema.toStandardSchemaV1),
    DATABASE_NAME: Schema.NonEmptyString.pipe(Schema.toStandardSchemaV1),
    DATABASE_USER: Schema.NonEmptyString.pipe(Schema.toStandardSchemaV1),
    DATABASE_PASS: Schema.toStandardSchemaV1(Schema.RedactedFromValue(Schema.NonEmptyString)),
    DISCORD_CLIENT_ID: Schema.NonEmptyString.pipe(Schema.toStandardSchemaV1),
    DISCORD_CLIENT_SECRET: Schema.toStandardSchemaV1(
      Schema.RedactedFromValue(Schema.NonEmptyString),
    ),
    DISCORD_REDIRECT: Schema.URLFromString.pipe(Schema.toStandardSchemaV1),
    FRONTEND_URL: Schema.URLFromString.pipe(Schema.toStandardSchemaV1),
    LOG_LEVEL: Schema.toStandardSchemaV1(Schema.OptionFromNullishOr(Schemas.LogLevelFromString)),
    APP_ENV: Schema.NonEmptyString.pipe(Schema.toStandardSchemaV1),
    APP_ORIGIN: Schema.NonEmptyString.pipe(Schema.toStandardSchemaV1),
    OTEL_EXPORTER_OTLP_ENDPOINT: Schema.NonEmptyString.pipe(Schema.toStandardSchemaV1),
    OTEL_SERVICE_NAME: Schema.NonEmptyString.pipe(Schema.toStandardSchemaV1),
    APP_GLOBAL_ADMIN_DISCORD_IDS: Schema.String.pipe(
      Schemas.Optional(() => ''),
      Schema.toStandardSchemaV1,
    ),
    EMAIL_WEBHOOK_SIGNING_SECRET: Schema.toStandardSchemaV1(
      Schema.RedactedFromValue(Schema.NonEmptyString),
    ),
    LLM_API_URL: Schema.String.pipe(
      Schemas.Optional(() => ''),
      Schema.toStandardSchemaV1,
    ),
    LLM_API_KEY: Schema.toStandardSchemaV1(
      Schema.OptionFromNullishOr(Schema.RedactedFromValue(Schema.NonEmptyString)),
    ),
    LLM_MODEL: Schema.String.pipe(
      Schemas.Optional(() => 'gpt-4o-mini'),
      Schema.toStandardSchemaV1,
    ),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

export const globalAdminDiscordIds: ReadonlySet<string> = new Set(
  (process.env.APP_GLOBAL_ADMIN_DISCORD_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
);
