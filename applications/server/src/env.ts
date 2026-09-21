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
    // D2 — a SEPARATE key from EMAIL_IMAP_ENCRYPTION_KEY, exact same "Optional Secret That Fails
    // On Use, Not On Boot" pattern: a missing/absent key never fails boot, only `FioSecretCrypto`
    // use (`FioSecretKeyMissing`). Sharing a key with the email secret would mean a compromise of
    // one is a compromise of both and neither ever gets rotated independently.
    FIO_TOKEN_ENCRYPTION_KEY: Schema.toStandardSchemaV1(
      Schema.OptionFromNullishOr(Schema.RedactedFromValue(Schema.NonEmptyString)),
    ),
    LLM_MODEL: Schema.String.pipe(
      Schemas.Optional(() => 'gpt-4o-mini'),
      Schema.toStandardSchemaV1,
    ),
    // Blocker D (whole-series review of `fix/discord-onboarding-webapp`) — the kill switch the
    // PR-9 rollout plan requires before the Discord-join enforcement redirect goes live: this
    // flag, not the redirect logic itself, is the rollback. Defaults to `''` (enforcement OFF —
    // see `parseDiscordJoinEnforcementEnabled` below) so the redirect does not go live on deploy
    // — see `discordJoinEnforcementEnabled` below and `auth.myTeams`, its only consumer.
    //
    // Should-fix 6 (whole-series review of commit 46806427): a RAW `Schema.String`, not
    // `Schema.Literals(['true', 'false'])` — this is the incident lever for the enforcement
    // redirect, and `Schema.Literals` made `createEnv` FAIL BOOT for `1`, `TRUE`, `yes`, or any
    // other ordinary boolean-ish spelling, which is the worst possible failure mode for a flag
    // whose entire purpose is "flip this fast during an incident". `parseDiscordJoinEnforcementEnabled`
    // does the real parsing, permissively, outside schema validation — see its doc comment.
    DISCORD_JOIN_ENFORCEMENT_ENABLED: Schema.String.pipe(
      Schemas.Optional(() => ''),
      Schema.toStandardSchemaV1,
    ),
    // Kill switch for the read-only in-app AI assistant (plan `.work-plans/ai-app-interaction.md`
    // §10). Same reasoning as `DISCORD_JOIN_ENFORCEMENT_ENABLED` above: a RAW `Schema.String`, not
    // `Schema.Literals`, because a value this flag doesn't recognise must degrade the flag to
    // "disabled" and log a warning, never fail server boot — a `Schema.Literals` env value that
    // fails boot is the worst possible property for an incident lever.
    // `parseAiChatEnabled` does the real parsing, permissively, outside schema validation.
    AI_CHAT_ENABLED: Schema.String.pipe(
      Schemas.Optional(() => ''),
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

const DISCORD_JOIN_ENFORCEMENT_TRUTHY = new Set(['true', '1', 'yes', 'on']);
const DISCORD_JOIN_ENFORCEMENT_FALSY = new Set(['false', '0', 'no', 'off', '']);

/**
 * Should-fix 6 (whole-series review of commit 46806427): permissive, case-insensitive parsing
 * for the `DISCORD_JOIN_ENFORCEMENT_ENABLED` incident lever — deliberately outside `createEnv`'s
 * schema validation (see `env.ts`'s `DISCORD_JOIN_ENFORCEMENT_ENABLED` field), because an
 * unrecognised value here must never crash the boot of the FLAG THAT EXISTS TO BE FLIPPED DURING
 * AN INCIDENT. An unrecognised value defaults to disabled (the safe direction — enforcement OFF,
 * same as the flag's own documented default) and logs a warning rather than throwing, so a typo
 * degrades to "the redirect stays off" instead of "the server does not start".
 */
export const parseDiscordJoinEnforcementEnabled = (raw: string): boolean => {
  const normalized = raw.trim().toLowerCase();
  if (DISCORD_JOIN_ENFORCEMENT_TRUTHY.has(normalized)) return true;
  if (DISCORD_JOIN_ENFORCEMENT_FALSY.has(normalized)) return false;
  console.warn(
    `DISCORD_JOIN_ENFORCEMENT_ENABLED=${JSON.stringify(raw)} is not a recognised boolean value ` +
      '(expected one of true/false/1/0/yes/no/on/off, case-insensitive) — defaulting to disabled.',
  );
  return false;
};

// Blocker D: OFF by default. When OFF, `auth.myTeams` forces `discordJoined` to `'unknown'` for
// EVERY team regardless of `discord_joined_at` / `members_backfilled_at` — `'unknown'` already
// renders nothing on the client, so this one flag removes the redirect, the card, and the badge
// in one move (the designed rollback). Flip to `'true'` only once the PR-9 rollout plan's other
// preconditions are met.
export const discordJoinEnforcementEnabled = parseDiscordJoinEnforcementEnabled(
  env.DISCORD_JOIN_ENFORCEMENT_ENABLED,
);

const AI_CHAT_ENABLED_TRUTHY = new Set(['true', '1', 'yes', 'on']);
const AI_CHAT_ENABLED_FALSY = new Set(['false', '0', 'no', 'off', '']);

/**
 * Permissive, case-insensitive parsing for the `AI_CHAT_ENABLED` incident lever — deliberately
 * outside `createEnv`'s schema validation (see `env.ts`'s `AI_CHAT_ENABLED` field), modelled
 * verbatim on `parseDiscordJoinEnforcementEnabled` above. An unrecognised value defaults to
 * disabled (the safe direction) and logs a warning rather than throwing, so a typo degrades to
 * "the assistant stays off" instead of "the server does not start".
 */
export const parseAiChatEnabled = (raw: string): boolean => {
  const normalized = raw.trim().toLowerCase();
  if (AI_CHAT_ENABLED_TRUTHY.has(normalized)) return true;
  if (AI_CHAT_ENABLED_FALSY.has(normalized)) return false;
  console.warn(
    `AI_CHAT_ENABLED=${JSON.stringify(raw)} is not a recognised boolean value ` +
      '(expected one of true/false/1/0/yes/no/on/off, case-insensitive) — defaulting to disabled.',
  );
  return false;
};

// Default `''` = disabled, so the assistant does not go live on deploy. See
// `AiChatEnabledConfig` (the injectable wrapper `capabilities`/`chat` handlers consume) and
// `ChatAgent.respond`'s `degradedReason: 'disabled'` short-circuit.
export const aiChatEnabled = parseAiChatEnabled(env.AI_CHAT_ENABLED);
