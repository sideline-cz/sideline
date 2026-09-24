// Shared fixture builders for the Fio bank-sync integration suite (plan
// `.work-plans/fio-transaction-matching.md` §7.2). Kept separate from `helpers.ts` (which is
// generic to the whole integration suite) because these are specific to the team/member/fee/
// bank-sync-config graph that every bank-sync test needs to stand up.
//
// Every function here is a plain `Effect` built on top of the real repositories where one
// exists (`TeamsRepository`, `UsersRepository`, `TeamMembersRepository`, `FeesRepository`) and
// raw SQL for tables that have no repository yet in this codebase (`team_settings`,
// `bank_sync_config`, `bank_transactions`) — this file will start compiling incrementally as the
// developer adds each repository, rather than being blocked on all of them at once.

import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Effect, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { makeWithKey as makeFioSecretCryptoWithKey } from '~/services/FioSecretCrypto.js';

/**
 * A fixed 32-byte test key for `FioSecretCrypto`, distinct from `EmailSecretCrypto.test.ts`'s key
 * byte pattern (which uses `Buffer.alloc(32, 7)`) so cross-key-confusion bugs surface as failures
 * rather than accidental passes. `FIO_TOKEN_ENCRYPTION_KEY` is NOT set in either vitest env block
 * (mirroring `EMAIL_IMAP_ENCRYPTION_KEY`'s deliberate absence — the "fails on use, not on boot"
 * pattern, D2), so any test that needs the poller/matcher pipeline to actually DECRYPT a token
 * must build its own `FioSecretCrypto` layer from `makeWithKey` with this key, and encrypt fixture
 * tokens with `encryptFioTestToken` below rather than relying on the env-driven `Default` layer.
 */
export const FIO_TEST_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 21).toString('base64');

export const encryptFioTestToken = (plaintext: string) =>
  makeFioSecretCryptoWithKey(Option.some(FIO_TEST_ENCRYPTION_KEY_B64)).pipe(
    Effect.flatMap((svc) => svc.encrypt(plaintext)),
  );

let discordIdCounter = 900_100_000_000_000_000n;
export const nextDiscordId = (): string => (discordIdCounter++).toString();

export const createUser = (username: string, discordId?: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId ?? nextDiscordId(),
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
  );

export const createTeam = (guildId: string, createdBy: User.UserId, name = 'Test Team') =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name,
        guild_id: guildId as Discord.Snowflake,
        created_by: createdBy,
        description: Option.none(),
        sport: Option.none(),
        logo_url: Option.none(),
        created_at: undefined,
        updated_at: undefined,
        welcome_channel_id: Option.none(),
        system_log_channel_id: Option.none(),
        welcome_message_template: Option.none(),
        rules_channel_id: Option.none(),
        achievement_channel_id: Option.none(),
        onboarding_rules_role_id: Option.none(),
        onboarding_rules_prompt_id: Option.none(),
        onboarding_locale: 'en',
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
  );

/** Inserts a minimal `team_settings` row (every other column defaults). */
export const setTeamTimezone = (teamId: Team.TeamId, timezone: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        INSERT INTO team_settings (team_id, timezone)
        VALUES (${teamId}, ${timezone})
        ON CONFLICT (team_id) DO UPDATE SET timezone = EXCLUDED.timezone
      `,
    ),
  );

// D3/D10c — the matcher's VS-recycling guard (`booked_on >= joined_at - 30d`) compares against
// the REAL `team_members.joined_at`, which `TeamMembersRepository.addMember`'s own INSERT never
// sets explicitly (the DB's `DEFAULT now()` always wins — the repository's SQL does not include
// the column at all, even though `TeamMember.TeamMember.insert` accepts it). Every bank-sync
// fixture in this suite books transactions on a fixed historical date (e.g. '2024-03-01'), which
// is "before" a member who joins at TEST-RUN time — so this fixture follows up with a raw SQL
// UPDATE (the same bypass pattern as `setMemberVariableSymbol` below) to back `joined_at` well
// before any fixture's `bookedOn`, unless a test (e.g. the guard's own test) passes an explicit
// `joinedAt` to exercise the guard on purpose.
const DEFAULT_FIXTURE_JOINED_AT = DateTime.makeUnsafe('2020-01-01T00:00:00.000Z');

export const createTeamMember = (
  teamId: Team.TeamId,
  userId: User.UserId,
  options: { readonly joinedAt?: DateTime.Utc } = {},
) =>
  Effect.Do.pipe(
    Effect.bind('repo', () => TeamMembersRepository.asEffect()),
    Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
    Effect.bind('member', ({ repo }) =>
      repo.addMember({
        team_id: teamId,
        user_id: userId,
        active: true,
      } as never),
    ),
    Effect.tap(
      ({ sql, member }) =>
        sql`UPDATE team_members SET joined_at = ${options.joinedAt ?? DEFAULT_FIXTURE_JOINED_AT} WHERE id = ${member.id}`,
    ),
    Effect.map(({ member }) => member),
  );

/** Sets `variable_symbol` directly via SQL — `setVariableSymbol` is part of the T2 roster
 * implementation this plan requires but is not itself in this file's testing scope. */
export const setMemberVariableSymbol = (memberId: TeamMember.TeamMemberId, vs: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`UPDATE team_members SET variable_symbol = ${vs} WHERE id = ${memberId}`,
    ),
  );

export const createFeeAndAssignment = (
  teamId: Team.TeamId,
  memberId: TeamMember.TeamMemberId,
  amountMinor: number,
  options: {
    readonly currency?: string;
    readonly name?: string;
    readonly dueAt?: DateTime.Utc;
  } = {},
) =>
  FeesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo
        .insert({
          team_id: teamId,
          name: options.name ?? 'Členský příspěvek',
          description: Option.none(),
          amount_minor: amountMinor,
          currency: options.currency ?? 'CZK',
          due_at: Option.fromNullishOr(options.dueAt),
        })
        .pipe(
          Effect.flatMap((fee) =>
            repo
              .insertAssignmentForTest(fee.id, memberId, amountMinor)
              .pipe(Effect.map((assignment) => ({ fee, assignment }))),
          ),
        ),
    ),
  );

/**
 * Minimal `bank_sync_config` row for a team, via raw SQL (no repository exists yet).
 *
 * `fioTokenEncrypted` defaults to `Option.none()` — no token at all, matching most tests
 * (matcher/repository tests never call `FioApiClient`, so an absent token is the cheaper and more
 * honest default). Pass a value produced by `encryptFioTestToken(...)` for any test that needs
 * the poller to actually decrypt and use a token (e.g. `BankSyncPoller.test.ts`).
 *
 * `fioTokenCreatedAt` — needed by `BankTokenExpiryCron` fixtures to place a token at an exact
 * distance from its 180-day expiry. Defaults to `now()` (the DB's own clock) when omitted.
 */
export const enableBankSync = (
  teamId: Team.TeamId,
  configuredByUserId: User.UserId,
  options: {
    readonly enabled?: boolean;
    readonly autoMatchEnabled?: boolean;
    readonly autoCreditEnabled?: boolean;
    readonly accountNumber?: string;
    readonly bankCode?: string;
    readonly recipientName?: string;
    readonly fioTokenEncrypted?: Option.Option<string>;
    readonly fioTokenCreatedAt?: Date;
  } = {},
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        INSERT INTO bank_sync_config (
          team_id, enabled, auto_match_enabled, auto_credit_enabled,
          account_number, bank_code, recipient_name,
          fio_token_encrypted, fio_token_created_at, configured_by_user_id
        ) VALUES (
          ${teamId}, ${options.enabled ?? true}, ${options.autoMatchEnabled ?? true},
          ${options.autoCreditEnabled ?? false},
          ${options.accountNumber ?? '2703474850'}, ${options.bankCode ?? '2010'},
          ${options.recipientName ?? 'Test Club, z.s.'},
          ${Option.getOrNull(options.fioTokenEncrypted ?? Option.none())},
          COALESCE(${options.fioTokenCreatedAt ?? null}, now()),
          ${configuredByUserId}
        )
        ON CONFLICT (team_id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          auto_match_enabled = EXCLUDED.auto_match_enabled,
          account_number = EXCLUDED.account_number,
          bank_code = EXCLUDED.bank_code,
          recipient_name = EXCLUDED.recipient_name,
          fio_token_encrypted = COALESCE(EXCLUDED.fio_token_encrypted, bank_sync_config.fio_token_encrypted),
          fio_token_created_at = EXCLUDED.fio_token_created_at,
          configured_by_user_id = EXCLUDED.configured_by_user_id
      `,
    ),
  );

interface InsertedBankTransactionRow {
  readonly id: string;
}

/** Inserts a raw `bank_transactions` row (no repository exists yet) and returns its id. */
export const insertBankTransaction = (
  teamId: Team.TeamId,
  input: {
    readonly fioMovementId: number;
    readonly bookedOn: string; // 'YYYY-MM-DD'
    readonly amountMinor: number; // signed
    readonly currency?: string;
    readonly variableSymbol?: string | null;
    readonly matchState?: string;
  },
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<InsertedBankTransactionRow>`
        INSERT INTO bank_transactions (
          team_id, fio_movement_id, booked_on, amount_minor, currency, variable_symbol,
          match_state, raw
        ) VALUES (
          ${teamId}, ${input.fioMovementId}, ${input.bookedOn}, ${input.amountMinor},
          ${input.currency ?? 'CZK'}, ${input.variableSymbol ?? null},
          ${input.matchState ?? (input.amountMinor < 0 ? 'not_applicable' : 'unmatched')},
          '{}'::jsonb
        )
        RETURNING id
      `,
    ),
    Effect.map((rows) => rows[0]?.id),
  );

export type CreatedFee = Effect.Success<ReturnType<typeof createFeeAndAssignment>>['fee'];
