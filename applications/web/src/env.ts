import { createEnv } from '@t3-oss/env-core';
import { createServerFn } from '@tanstack/react-start';
import { Schema } from 'effect';

export const fetchEnv = createServerFn().handler(() =>
  createEnv({
    server: {
      SERVER_URL: Schema.NonEmptyString.pipe(Schema.toStandardSchemaV1),
      DISCORD_CLIENT_ID: Schema.NonEmptyString.pipe(Schema.toStandardSchemaV1),
      WEB_URL: Schema.UndefinedOr(Schema.NonEmptyString).pipe(Schema.toStandardSchemaV1),
      OTEL_EXPORTER_OTLP_ENDPOINT: Schema.UndefinedOr(Schema.NonEmptyString).pipe(
        Schema.toStandardSchemaV1,
      ),
      OTEL_SERVICE_NAME: Schema.UndefinedOr(Schema.NonEmptyString).pipe(Schema.toStandardSchemaV1),
      APP_ENV: Schema.UndefinedOr(Schema.NonEmptyString).pipe(Schema.toStandardSchemaV1),
      APP_ORIGIN: Schema.UndefinedOr(Schema.NonEmptyString).pipe(Schema.toStandardSchemaV1),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
  }),
);
