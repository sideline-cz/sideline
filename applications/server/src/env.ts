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
    EMAIL_IMAP_ENCRYPTION_KEY: Schema.toStandardSchemaV1(
      Schema.OptionFromNullishOr(Schema.RedactedFromValue(Schema.NonEmptyString)),
    ),
    LLM_MODEL: Schema.String.pipe(
      Schemas.Optional(() => 'gpt-4o-mini'),
      Schema.toStandardSchemaV1,
    ),
    // Blocker D (whole-series review of `fix/discord-onboarding-webapp`) — the kill switch the
    // PR-9 rollout plan requires before the Discord-join enforcement redirect goes live: this
    // flag, not the redirect logic itself, is the rollback. Defaults to `'false'` (enforcement
    // OFF) so the redirect does not go live on deploy — see `discordJoinEnforcementEnabled`
    // below and `auth.myTeams`, its only consumer.
    DISCORD_JOIN_ENFORCEMENT_ENABLED: Schema.Literals(['true', 'false']).pipe(
      Schemas.Optional<'true' | 'false'>(() => 'false'),
      Schema.toStandardSchemaV1,
    ),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

const SNOWFLAKE_RE = /^\d{17,20}$/;

export const globalAdminDiscordIds: ReadonlySet<string> = new Set(
  (process.env.APP_GLOBAL_ADMIN_DISCORD_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => SNOWFLAKE_RE.test(id)),
);

// Blocker D: OFF by default. When OFF, `auth.myTeams` forces `discordJoined` to `'unknown'` for
// EVERY team regardless of `discord_joined_at` / `members_backfilled_at` — `'unknown'` already
// renders nothing on the client, so this one flag removes the redirect, the card, and the badge
// in one move (the designed rollback). Flip to `'true'` only once the PR-9 rollout plan's other
// preconditions are met.
export const discordJoinEnforcementEnabled = env.DISCORD_JOIN_ENFORCEMENT_ENABLED === 'true';
