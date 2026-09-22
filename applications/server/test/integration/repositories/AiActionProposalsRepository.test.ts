// Spec for `AiActionProposalsRepository` (`src/repositories/AiActionProposalsRepository.ts`) —
// plan `.work-plans/ai-app-interaction.md` §5/§16, `applications/server/AGENTS.md`
// "Claim-Then-Act Transactions Are Testable Without A Production Seam" (lines ~2338-2366)
// applied verbatim.
//
// Docker-backed (testcontainers) — the `FOR UPDATE` row lock, the real transaction-boundary
// commit/rollback semantics, and the `now()`/`transaction_timestamp()` claim arithmetic are all
// real-Postgres facts a mocked `SqlClient` cannot exercise (see `ai-chat.test.ts`'s own header
// comment: its `MockGenericSqlClientLayer.withTransaction` is a passthrough, so it explicitly
// cannot test rollback — that is this file's job).
//
// The previous `{ concurrency: 2 }` shape would have proven nothing: two fibers sharing ONE
// `SqlClient` share one Postgres SESSION and can never observe a row-lock wait between them. Both
// the deterministic two-session race and the rollback test below follow the AGENTS.md rules:
// override only the repository that owns the ACT half (never the one that owns the claim), and
// provide that override INSIDE the effect, over the real `TestLayer`.

import { describe, expect, it } from '@effect/vitest';
import type { AiActionProposal, Discord, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Deferred, Effect, Fiber, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { AiActionProposalsRepository } from '~/repositories/AiActionProposalsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, secondTestPgClient, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  AiActionProposalsRepository.Default,
  EventsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers (mirrors EventsRepository.allDayAnchored.test.ts's seeding pattern)
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId as Discord.Snowflake,
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Test Team',
        guild_id: guildId,
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
    Effect.map((t) => t.id),
  );

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
    Effect.map((m) => m.id),
  );

let userSeq = 0;
const nextDiscordId = (): string => {
  userSeq += 1;
  return `600000000000${String(userSeq).padStart(6, '0')}`;
};

/** Builds a fresh team + owning user + one team member in one call — every test below needs
 * exactly this, and only the proposal's `team_id`/`user_id` scoping varies per case. */
const seedTeamAndUser = () =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(nextDiscordId(), 'proposer')),
    Effect.bind('teamId', ({ userId }) => createTeam(nextDiscordId() as Discord.Snowflake, userId)),
    Effect.bind('memberId', ({ teamId, userId }) => addTeamMember(teamId, userId)),
  );

const insertProposal = (
  teamId: Team.TeamId,
  userId: User.UserId,
  payloadJson = '{"title":"AI Practice"}',
) =>
  AiActionProposalsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        user_id: userId,
        action: 'create_event' as AiActionProposal.AiActionName,
        payload_json: payloadJson,
      }),
    ),
  );

const readRawRow = (id: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe<{
        created_at: Date;
        expires_at: Date;
        consumed_at: Date | null;
        payload: string;
      }>(
        `SELECT created_at, expires_at, consumed_at, payload::text AS payload
         FROM ai_action_proposals WHERE id = '${id}'`,
      ),
    ),
    Effect.map((rows) => rows.at(0)),
  );

/** The claim-then-act composition this file drives directly — a minimal stand-in for
 * `confirmProposal`'s real transaction body (`ai-chat.ts`), using `EventsRepository.insertEvent`
 * as the "act" (the same role `createEventForMemberTx` plays for real, without pulling in
 * `GroupsRepository`/`TrainingTypesRepository`/`TeamSettingsRepository` this file has no other use
 * for). Never added to `src/` — this is test-file-only orchestration over real repositories,
 * exactly what the AGENTS.md section this file follows calls for. */
const claimAndInsertEvent = (params: {
  readonly id: string;
  readonly teamId: Team.TeamId;
  readonly userId: User.UserId;
  readonly memberId: TeamMember.TeamMemberId;
}) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.withTransaction(
        Effect.Do.pipe(
          Effect.bind('proposals', () => AiActionProposalsRepository.asEffect()),
          Effect.bind('events', () => EventsRepository.asEffect()),
          Effect.tap(({ proposals }) =>
            proposals.claim({
              id: params.id as never,
              team_id: params.teamId,
              user_id: params.userId,
            }),
          ),
          Effect.flatMap(({ events }) =>
            events.insertEvent({
              teamId: params.teamId,
              eventType: 'tournament',
              title: 'AI Event',
              description: Option.none(),
              startAt: DateTime.makeUnsafe('2026-07-15T12:00:00Z'),
              endAt: Option.none(),
              location: Option.none(),
              ownerGroupId: Option.none(),
              memberGroupId: Option.none(),
              trainingTypeId: Option.none(),
              seriesId: Option.none(),
              createdBy: params.memberId,
              allDay: false,
            }),
          ),
        ),
      ),
    ),
  );

const countEventsForTeam = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM events WHERE team_id = '${teamId}'`,
      ),
    ),
    Effect.map((rows) => Number(rows.at(0)?.count ?? '0')),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AiActionProposalsRepository — insert', () => {
  it.effect('sets expires_at - created_at to ~15 minutes (14-16), on the DB clock', () =>
    Effect.Do.pipe(
      Effect.bind('fixtures', () => seedTeamAndUser()),
      Effect.bind('proposal', ({ fixtures }) => insertProposal(fixtures.teamId, fixtures.userId)),
      Effect.bind('raw', ({ proposal }) => readRawRow(proposal.id)),
      Effect.tap(({ raw }) =>
        Effect.sync(() => {
          if (!raw) throw new Error('row not found');
          const diffMinutes = (raw.expires_at.getTime() - raw.created_at.getTime()) / 60000;
          expect(diffMinutes).toBeGreaterThanOrEqual(14);
          expect(diffMinutes).toBeLessThanOrEqual(16);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'payload::text round-trips a payload containing `"` and non-ASCII bytes — every character survives, jsonb reformatting (a space after `:`) aside',
    () =>
      Effect.Do.pipe(
        Effect.bind('fixtures', () => seedTeamAndUser()),
        Effect.let('payloadJson', () => '{"title":"Nazdar \\" č ř ž 🎉"}'),
        Effect.bind('proposal', ({ fixtures, payloadJson }) =>
          insertProposal(fixtures.teamId, fixtures.userId, payloadJson),
        ),
        Effect.bind('locked', ({ fixtures, proposal }) =>
          AiActionProposalsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.lockForConfirm({
                id: proposal.id,
                team_id: fixtures.teamId,
                user_id: fixtures.userId,
              }),
            ),
          ),
        ),
        Effect.tap(({ locked, payloadJson }) =>
          Effect.sync(() => {
            expect(Option.isSome(locked)).toBe(true);
            if (Option.isSome(locked)) {
              // `jsonb` (not `json`) re-serializes on write — it does NOT preserve
              // insignificant whitespace (Postgres always emits a space after `:`), so a
              // byte-for-byte comparison of the RAW text would be comparing an implementation
              // detail, not this round trip's actual property. Parse both sides and compare
              // structurally instead — the exotic content (an embedded `"`, non-ASCII letters,
              // an emoji outside the BMP) is what must survive, and does.
              expect(JSON.parse(locked.value.payload)).toEqual(JSON.parse(payloadJson));
              expect(locked.value.payload).toContain('Nazdar \\" č ř ž 🎉');
            }
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

describe('AiActionProposalsRepository — lockForConfirm / claim scoping', () => {
  it.effect('right id, WRONG team_id -> None', () =>
    Effect.Do.pipe(
      Effect.bind('fixtures', () => seedTeamAndUser()),
      Effect.bind('other', () => seedTeamAndUser()),
      Effect.bind('proposal', ({ fixtures }) => insertProposal(fixtures.teamId, fixtures.userId)),
      Effect.bind('locked', ({ proposal, fixtures, other }) =>
        AiActionProposalsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.lockForConfirm({
              id: proposal.id,
              team_id: other.teamId,
              user_id: fixtures.userId,
            }),
          ),
        ),
      ),
      Effect.tap(({ locked }) => Effect.sync(() => expect(Option.isNone(locked)).toBe(true))),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('right id, WRONG user_id -> None', () =>
    Effect.Do.pipe(
      Effect.bind('fixtures', () => seedTeamAndUser()),
      Effect.bind('other', () => seedTeamAndUser()),
      Effect.bind('proposal', ({ fixtures }) => insertProposal(fixtures.teamId, fixtures.userId)),
      Effect.bind('locked', ({ proposal, fixtures, other }) =>
        AiActionProposalsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.lockForConfirm({
              id: proposal.id,
              team_id: fixtures.teamId,
              user_id: other.userId,
            }),
          ),
        ),
      ),
      Effect.tap(({ locked }) => Effect.sync(() => expect(Option.isNone(locked)).toBe(true))),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'an expired row: lockForConfirm reports expired:true, and claim (forced) returns None',
    () =>
      Effect.Do.pipe(
        Effect.bind('fixtures', () => seedTeamAndUser()),
        Effect.bind('proposal', ({ fixtures }) => insertProposal(fixtures.teamId, fixtures.userId)),
        Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
        Effect.tap(({ sql, proposal }) =>
          sql.unsafe(
            // `ai_action_proposals_ttl_positive` requires `expires_at > created_at` — back-date
            // BOTH together so the row is expired (relative to `now()`) without violating it.
            `UPDATE ai_action_proposals
           SET created_at = now() - INTERVAL '20 minutes', expires_at = now() - INTERVAL '1 minute'
           WHERE id = '${proposal.id}'`,
          ),
        ),
        Effect.bind('locked', ({ fixtures, proposal }) =>
          AiActionProposalsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.lockForConfirm({
                id: proposal.id,
                team_id: fixtures.teamId,
                user_id: fixtures.userId,
              }),
            ),
          ),
        ),
        Effect.tap(({ locked }) =>
          Effect.sync(() => {
            expect(Option.isSome(locked)).toBe(true);
            if (Option.isSome(locked)) {
              expect(locked.value.expired).toBe(true);
              expect(locked.value.consumed).toBe(false);
            }
          }),
        ),
        Effect.bind('claimed', ({ fixtures, proposal }) =>
          AiActionProposalsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.claim({ id: proposal.id, team_id: fixtures.teamId, user_id: fixtures.userId }),
            ),
          ),
        ),
        Effect.tap(({ claimed }) => Effect.sync(() => expect(Option.isNone(claimed)).toBe(true))),
        Effect.provide(TestLayer),
      ),
  );
});

describe('AiActionProposalsRepository — schema constraints', () => {
  it.effect("CHECK (action IN ('create_event')) rejects an unknown action string", () =>
    Effect.Do.pipe(
      Effect.bind('fixtures', () => seedTeamAndUser()),
      Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
      Effect.flatMap(({ sql, fixtures }) =>
        Effect.exit(
          sql.unsafe(
            `INSERT INTO ai_action_proposals (team_id, user_id, action, payload, expires_at)
             VALUES ('${fixtures.teamId}', '${fixtures.userId}', 'delete_everything', '{}'::jsonb, now() + INTERVAL '15 minutes')`,
          ),
        ),
      ),
      Effect.tap((exit) => Effect.sync(() => expect(exit._tag).toBe('Failure'))),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('DELETE FROM teams cascades the proposal away', () =>
    Effect.Do.pipe(
      Effect.bind('fixtures', () => seedTeamAndUser()),
      Effect.bind('proposal', ({ fixtures }) => insertProposal(fixtures.teamId, fixtures.userId)),
      Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
      Effect.tap(({ sql, fixtures }) =>
        sql.unsafe(`DELETE FROM teams WHERE id = '${fixtures.teamId}'`),
      ),
      Effect.bind('raw', ({ proposal }) => readRawRow(proposal.id)),
      Effect.tap(({ raw }) => Effect.sync(() => expect(raw).toBeUndefined())),
      Effect.provide(TestLayer),
    ),
  );
});

describe('AiActionProposalsRepository — a failure after the claim rolls the claim back', () => {
  it.effect(
    'insertEvent fails -> consumed_at stays NULL and zero events rows; the SAME confirm re-run unmodified then creates exactly one event and consumed_at becomes non-null',
    () =>
      Effect.Do.pipe(
        Effect.bind('fixtures', () => seedTeamAndUser()),
        Effect.bind('proposal', ({ fixtures }) => insertProposal(fixtures.teamId, fixtures.userId)),
        // Override ONLY the ACT half, provided INSIDE the effect, over the real `TestLayer`.
        Effect.tap(({ fixtures, proposal }) =>
          claimAndInsertEvent({
            id: proposal.id,
            teamId: fixtures.teamId,
            userId: fixtures.userId,
            memberId: fixtures.memberId,
          }).pipe(
            Effect.provide(
              Layer.succeed(EventsRepository, {
                insertEvent: () => Effect.fail(new Error('injected insertEvent failure')),
              } as never),
            ),
            Effect.exit,
          ),
        ),
        Effect.bind('rawAfterFailure', ({ proposal }) => readRawRow(proposal.id)),
        Effect.bind('eventsAfterFailure', ({ fixtures }) => countEventsForTeam(fixtures.teamId)),
        Effect.tap(({ rawAfterFailure, eventsAfterFailure }) =>
          Effect.sync(() => {
            expect(rawAfterFailure?.consumed_at).toBeNull();
            expect(eventsAfterFailure).toBe(0);
          }),
        ),
        // The SECOND run — real `EventsRepository`, unmodified — is what distinguishes "rolled
        // back" from "never ran".
        Effect.tap(({ fixtures, proposal }) =>
          claimAndInsertEvent({
            id: proposal.id,
            teamId: fixtures.teamId,
            userId: fixtures.userId,
            memberId: fixtures.memberId,
          }),
        ),
        Effect.bind('rawAfterRetry', ({ proposal }) => readRawRow(proposal.id)),
        Effect.bind('eventsAfterRetry', ({ fixtures }) => countEventsForTeam(fixtures.teamId)),
        Effect.tap(({ rawAfterRetry, eventsAfterRetry }) =>
          Effect.sync(() => {
            expect(rawAfterRetry?.consumed_at).not.toBeNull();
            expect(eventsAfterRetry).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// `Effect.gen` rather than this file's usual `Effect.Do.pipe` — both cases below choreograph
// forked fibers, which reads as a sequence, not as a pipeline (same convention as
// `EventStartCron.deferred.test.ts`'s C1/C2).
describe('AiActionProposalsRepository — two sessions racing the same row', () => {
  it.effect(
    'DETERMINISTIC: session A holds the FOR UPDATE lock and claims; session B blocks, then observes consumed:true — B writes nothing, consumed_at is set exactly once',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { teamId, userId } = yield* seedTeamAndUser();
          const proposal = yield* insertProposal(teamId, userId);

          const sql = yield* SqlClient.SqlClient.asEffect();
          const proposalsA = yield* AiActionProposalsRepository.asEffect();
          const sql2 = yield* secondTestPgClient;
          const proposalsB = yield* AiActionProposalsRepository.asEffect().pipe(
            Effect.provide(AiActionProposalsRepository.Default),
            Effect.provideService(SqlClient.SqlClient, sql2),
          );

          const claimedA = yield* Deferred.make<void>();
          const releaseA = yield* Deferred.make<void>();

          // Session A: claims the FOR UPDATE lock and parks INSIDE its transaction — exactly the
          // window `confirmProposal` spends resolving permission + the registry action.
          const fiberA = yield* Effect.forkChild(
            sql.withTransaction(
              proposalsA.lockForConfirm({ id: proposal.id, team_id: teamId, user_id: userId }).pipe(
                Effect.tap(() => Deferred.succeed(claimedA, undefined)),
                Effect.tap(() => Deferred.await(releaseA)),
                Effect.tap(() =>
                  proposalsA.claim({ id: proposal.id, team_id: teamId, user_id: userId }),
                ),
              ),
            ),
          );
          yield* Deferred.await(claimedA);

          // Session B: its own `SELECT ... FOR UPDATE` blocks on A's held row lock until A
          // commits, then re-reads and sees the now-committed `consumed_at`.
          const fiberB = yield* Effect.forkChild(
            proposalsB.lockForConfirm({ id: proposal.id, team_id: teamId, user_id: userId }),
          );
          yield* Deferred.succeed(releaseA, undefined);

          const resultB = yield* Fiber.join(fiberB);
          yield* Fiber.join(fiberA);

          expect(Option.isSome(resultB)).toBe(true);
          if (Option.isSome(resultB)) {
            expect(resultB.value.consumed).toBe(true);
          }

          // B never called `claim` — `consumed_at` was set exactly once, by A.
          const raw = yield* readRawRow(proposal.id);
          expect(raw?.consumed_at).not.toBeNull();
          const claimedAgain = yield* proposalsA.claim({
            id: proposal.id,
            team_id: teamId,
            user_id: userId,
          });
          expect(Option.isNone(claimedAgain)).toBe(true); // already consumed — a second claim is a no-op
        }),
      ).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'SMOKE (non-deterministic, NOT sufficient on its own): two full claim cycles on two sessions racing the same row -> exactly one wins',
    () =>
      Effect.gen(function* () {
        const { teamId, userId } = yield* seedTeamAndUser();
        const proposal = yield* insertProposal(teamId, userId);

        const sql = yield* SqlClient.SqlClient.asEffect();
        const proposalsA = yield* AiActionProposalsRepository.asEffect();
        const sql2 = yield* secondTestPgClient;
        const proposalsB = yield* AiActionProposalsRepository.asEffect().pipe(
          Effect.provide(AiActionProposalsRepository.Default),
          Effect.provideService(SqlClient.SqlClient, sql2),
        );

        const runOnce = (proposals: typeof proposalsA, runSql: typeof sql) =>
          runSql.withTransaction(
            proposals
              .lockForConfirm({ id: proposal.id, team_id: teamId, user_id: userId })
              .pipe(
                Effect.flatMap(() =>
                  proposals.claim({ id: proposal.id, team_id: teamId, user_id: userId }),
                ),
              ),
          );

        const [resultA, resultB] = yield* Effect.all(
          [runOnce(proposalsA, sql), runOnce(proposalsB, sql2)],
          {
            concurrency: 'unbounded',
          },
        );

        const wins = [resultA, resultB].filter(Option.isSome).length;
        expect(wins).toBe(1);
      }).pipe(Effect.provide(TestLayer)),
  );
});
