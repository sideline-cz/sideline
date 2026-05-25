import { Schemas } from '@sideline/effect-lib';
import { createEnv } from '@t3-oss/env-core';
import { Discord } from 'dfx';
import { Schema } from 'effect';

export const env = createEnv({
  server: {
    NODE_ENV: Schema.toStandardSchemaV1(Schemas.NodeEnv),
    DISCORD_BOT_TOKEN: Schema.toStandardSchemaV1(Schema.RedactedFromValue(Schema.NonEmptyString)),
    HEALTH_PORT: Schema.NumberFromString.pipe(
      Schemas.Optional(() => 9000),
      Schema.toStandardSchemaV1,
    ),
    DISCORD_GATEWAY_INTENTS: Schema.NumberFromString.pipe(
      Schemas.Optional(
        () =>
          Discord.GatewayIntentBits.Guilds |
          Discord.GatewayIntentBits.GuildMembers |
          Discord.GatewayIntentBits.GuildInvites,
      ),
      Schema.toStandardSchemaV1,
    ),
    RPC_PREFIX: Schema.String.pipe(
      Schemas.Optional(() => ''),
      Schema.toStandardSchemaV1,
    ),
    SERVER_URL: Schema.NonEmptyString.pipe(Schema.toStandardSchemaV1),
    LOG_LEVEL: Schema.toStandardSchemaV1(Schema.OptionFromNullishOr(Schemas.LogLevelFromString)),
    WEB_URL: Schema.toStandardSchemaV1(Schema.OptionFromNullishOr(Schema.NonEmptyString)),
    APP_ENV: Schema.NonEmptyString.pipe(Schema.toStandardSchemaV1),
    APP_ORIGIN: Schema.NonEmptyString.pipe(Schema.toStandardSchemaV1),
    OTEL_EXPORTER_OTLP_ENDPOINT: Schema.NonEmptyString.pipe(Schema.toStandardSchemaV1),
    OTEL_SERVICE_NAME: Schema.NonEmptyString.pipe(Schema.toStandardSchemaV1),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
