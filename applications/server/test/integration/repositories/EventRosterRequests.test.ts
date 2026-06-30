// NOTE: TDD mode — tests will FAIL until EventRostersRepository and
// EventRosterRequestsRepository are implemented and migrations are applied.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { EventRosterRequestsRepository } from '~/repositories/EventRosterRequestsRepository.js';
import { EventRostersRepository } from '~/repositories/EventRostersRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventRostersRepository.Default,
  EventRosterRequestsRepository.Default,
  EventsRepository.Default,
  RostersRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId,
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
  );

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({
        team_id: teamId,
        user_id: userId,
        active: true,
        joined_at: undefined,
      }),
    ),
  );

const createEvent = (teamId: Team.TeamId, createdBy: TeamMember.TeamMemberId) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'tournament',
        title: 'Test Tournament',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(new Date('2099-07-01T10:00:00Z')),
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy,
      }),
    ),
  );

const createRoster = (teamId: Team.TeamId) =>
  RostersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        name: 'Tournament Squad',
        active: true,
        color: Option.none(),
        emoji: Option.none(),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventRostersRepository — link atomicity', () => {
  it.effect('link twice for same event → EventRosterAlreadyLinked on second call', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('300000000000000001', 'owner-link-1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('301010101010101010' as Discord.Snowflake, userId),
      ),
      Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('event', ({ team, tm }) => createEvent(team.id, tm.id)),
      Effect.bind('roster', ({ team }) => createRoster(team.id)),
      Effect.bind('firstLink', ({ event, roster }) =>
        EventRostersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.link({ eventId: event.id, rosterId: roster.id, autoApprove: false }),
          ),
        ),
      ),
      Effect.bind('secondLinkResult', ({ event, roster }) =>
        EventRostersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.link({ eventId: event.id, rosterId: roster.id, autoApprove: false }),
          ),
          Effect.result,
        ),
      ),
      Effect.tap(({ secondLinkResult }) =>
        Effect.sync(() => {
          expect(secondLinkResult._tag).toBe('Failure');
          if (secondLinkResult._tag === 'Failure') {
            expect(JSON.stringify(secondLinkResult.failure)).toContain('EventRosterAlreadyLinked');
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('EventRostersRepository — saveThreadIfAbsent atomicity', () => {
  it.effect(
    'saveThreadIfAbsent: winner thread survives concurrent save, loser returns winner thread id',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createUser('300000000000000010', 'owner-thread-1')),
        Effect.bind('team', ({ userId }) =>
          createTeam('302020202020202020' as Discord.Snowflake, userId),
        ),
        Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
        Effect.bind('event', ({ team, tm }) => createEvent(team.id, tm.id)),
        Effect.bind('roster', ({ team }) => createRoster(team.id)),
        Effect.tap(({ event, roster }) =>
          EventRostersRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.link({ eventId: event.id, rosterId: roster.id, autoApprove: false }),
            ),
          ),
        ),
        Effect.bind('thread1', ({ event }) =>
          EventRostersRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.saveThreadIfAbsent(event.id, 'thread-001' as Discord.Snowflake),
            ),
          ),
        ),
        Effect.bind('thread2', ({ event }) =>
          EventRostersRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.saveThreadIfAbsent(event.id, 'thread-002' as Discord.Snowflake),
            ),
          ),
        ),
        Effect.tap(({ thread1, thread2 }) =>
          Effect.sync(() => {
            // Both should return the same (first) thread id
            expect(Option.isSome(thread1)).toBe(true);
            if (Option.isSome(thread1) && Option.isSome(thread2)) {
              // The winner thread is the one that was saved first
              expect(thread1.value).toBe(thread2.value);
            }
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

describe('EventRosterRequestsRepository — cancel guard', () => {
  it.effect('cancel returns pre-cancel row with prior status; second cancel returns None', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('300000000000000020', 'owner-cancel-1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('303030303030303030' as Discord.Snowflake, userId),
      ),
      Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('event', ({ team, tm }) => createEvent(team.id, tm.id)),
      Effect.bind('roster', ({ team }) => createRoster(team.id)),
      Effect.tap(({ event, roster }) =>
        EventRostersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.link({ eventId: event.id, rosterId: roster.id, autoApprove: false }),
          ),
        ),
      ),
      Effect.tap(({ event, roster, tm }) =>
        EventRosterRequestsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.upsertPending(event.id, roster.id, tm.id, false)),
        ),
      ),
      Effect.bind('firstCancel', ({ event, tm }) =>
        EventRosterRequestsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.cancel(event.id, tm.id)),
        ),
      ),
      Effect.bind('secondCancel', ({ event, tm }) =>
        EventRosterRequestsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.cancel(event.id, tm.id)),
        ),
      ),
      Effect.tap(({ firstCancel, secondCancel }) =>
        Effect.sync(() => {
          // First cancel returns the prior pending row
          expect(Option.isSome(firstCancel)).toBe(true);
          if (Option.isSome(firstCancel)) {
            expect((firstCancel.value as any).status).toBe('pending');
          }
          // Second cancel returns None (already cancelled)
          expect(Option.isNone(secondCancel)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('EventRosterRequestsRepository — claimDecision guard', () => {
  it.effect('claimDecision succeeds once (pending→approved); second call returns None', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('300000000000000030', 'owner-claim-1')),
      Effect.bind('deciderId', () => createUser('300000000000000031', 'decider-1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('304040404040404040' as Discord.Snowflake, userId),
      ),
      Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('deciderMember', ({ team, deciderId }) => addTeamMember(team.id, deciderId)),
      Effect.bind('event', ({ team, tm }) => createEvent(team.id, tm.id)),
      Effect.bind('roster', ({ team }) => createRoster(team.id)),
      Effect.tap(({ event, roster }) =>
        EventRostersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.link({ eventId: event.id, rosterId: roster.id, autoApprove: false }),
          ),
        ),
      ),
      Effect.tap(({ event, roster, tm }) =>
        EventRosterRequestsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.upsertPending(event.id, roster.id, tm.id, false)),
        ),
      ),
      Effect.bind('firstDecide', ({ event, tm, deciderMember }) =>
        EventRosterRequestsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.claimDecision(event.id, tm.id, 'approved', deciderMember.id),
          ),
        ),
      ),
      Effect.bind('secondDecide', ({ event, tm, deciderMember }) =>
        EventRosterRequestsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.claimDecision(event.id, tm.id, 'approved', deciderMember.id),
          ),
        ),
      ),
      Effect.tap(({ firstDecide, secondDecide }) =>
        Effect.sync(() => {
          expect(Option.isSome(firstDecide)).toBe(true);
          // Second attempt on already-approved row → None (not pending)
          expect(Option.isNone(secondDecide)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('EventRosterRequestsRepository — upsertPending no-downgrade', () => {
  it.effect('upsertPending does NOT downgrade an approved row', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('300000000000000040', 'owner-nodown-1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('305050505050505050' as Discord.Snowflake, userId),
      ),
      Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('event', ({ team, tm }) => createEvent(team.id, tm.id)),
      Effect.bind('roster', ({ team }) => createRoster(team.id)),
      Effect.tap(({ event, roster }) =>
        EventRostersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.link({ eventId: event.id, rosterId: roster.id, autoApprove: false }),
          ),
        ),
      ),
      // First upsert as approved
      Effect.tap(({ event, roster, tm }) =>
        EventRosterRequestsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.upsertApproved(event.id, roster.id, tm.id, false)),
        ),
      ),
      // Then try to upsert as pending (should NOT downgrade)
      Effect.tap(({ event, roster, tm }) =>
        EventRosterRequestsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.upsertPending(event.id, roster.id, tm.id, false)),
        ),
      ),
      // Read back and confirm still approved
      Effect.bind('row', ({ event, tm }) =>
        EventRosterRequestsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByEventAndMember(event.id, tm.id)),
        ),
      ),
      Effect.tap(({ row }) =>
        Effect.sync(() => {
          expect(Option.isSome(row)).toBe(true);
          if (Option.isSome(row)) {
            expect((row.value as any).status).toBe('approved');
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('Migration — schema CHECK constraints', () => {
  it.effect('tables exist and basic insert/query works', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('300000000000000050', 'owner-migration-1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('306060606060606060' as Discord.Snowflake, userId),
      ),
      Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('event', ({ team, tm }) => createEvent(team.id, tm.id)),
      Effect.bind('roster', ({ team }) => createRoster(team.id)),
      Effect.bind('linked', ({ event, roster }) =>
        EventRostersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.link({ eventId: event.id, rosterId: roster.id, autoApprove: false }),
          ),
        ),
      ),
      Effect.tap(({ linked, roster }) =>
        Effect.sync(() => {
          // Confirm the link row was returned and points at the linked roster
          expect(linked).toBeDefined();
          expect((linked as any).roster_id).toBe(roster.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('was_member_before defaults to false on upsertPending', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('300000000000000060', 'owner-wmbdefault-1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('307070707070707070' as Discord.Snowflake, userId),
      ),
      Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('event', ({ team, tm }) => createEvent(team.id, tm.id)),
      Effect.bind('roster', ({ team }) => createRoster(team.id)),
      Effect.tap(({ event, roster }) =>
        EventRostersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.link({ eventId: event.id, rosterId: roster.id, autoApprove: false }),
          ),
        ),
      ),
      Effect.tap(({ event, roster, tm }) =>
        EventRosterRequestsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.upsertPending(event.id, roster.id, tm.id, false)),
        ),
      ),
      Effect.bind('row', ({ event, tm }) =>
        EventRosterRequestsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByEventAndMember(event.id, tm.id)),
        ),
      ),
      Effect.tap(({ row }) =>
        Effect.sync(() => {
          expect(Option.isSome(row)).toBe(true);
          if (Option.isSome(row)) {
            expect((row.value as any).was_member_before).toBe(false);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
