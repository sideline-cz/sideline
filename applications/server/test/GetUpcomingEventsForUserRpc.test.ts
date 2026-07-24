/**
 * Tests for the GetUpcomingEventsForUser RPC handler logic.
 *
 * The handler is built on raw SQL via @effect/sql so we cannot inject mocks at
 * the SQL layer without a real database.  Instead we test the same data-flow
 * decisions the handler makes by exercising the repository abstractions
 * directly — the same pattern used by EventRpc.test.ts.
 */
import { describe, expect, it } from '@effect/vitest';
import type { Discord, Event, Team, TeamMember, User } from '@sideline/domain';
import { EventRpcModels } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';

// --- Test IDs ---
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_USER_ID = '00000000-0000-0000-0000-000000000030' as User.UserId;
const TEST_GUILD_ID = '999999999999999999' as Discord.Snowflake;
const TEST_EVENT_ID = '00000000-0000-0000-0000-000000000060' as Event.EventId;

const FUTURE_DATE = DateTime.makeUnsafe('2099-06-01T18:00:00Z');

// --- Minimal team record helper ---
const makeTeam = () => ({
  id: TEST_TEAM_ID,
  name: 'Test Team',
  guild_id: TEST_GUILD_ID,
  created_by: 'user-1',
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
});

// --- Mock layers ---
const MockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  findById: (id: Team.TeamId) =>
    id === TEST_TEAM_ID ? Effect.succeed(Option.some(makeTeam())) : Effect.succeed(Option.none()),
  findByGuildId: (guildId: string) =>
    guildId === TEST_GUILD_ID
      ? Effect.succeed(Option.some(makeTeam()))
      : Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
} as any);

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  findMembershipByIds: (_teamId: Team.TeamId, _userId: string) =>
    Effect.succeed(
      Option.some({
        id: TEST_MEMBER_ID,
        team_id: TEST_TEAM_ID,
        user_id: 'user-1',
        active: true,
        role_names: ['Player'],
        permissions: [] as string[],
      }),
    ),
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  addMember: () => Effect.die(new Error('Not implemented')),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getPlayerRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
} as any);

// In-memory events store for findUpcomingByGuildId / countUpcomingByGuildId
type UpcomingEventRecord = {
  id: Event.EventId;
  team_id: Team.TeamId;
  title: string;
  start_at: DateTime.Utc;
};
const upcomingEvents: UpcomingEventRecord[] = [];
const upcomingCount = 0;

const MockEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  findUpcomingByGuildId: () => Effect.succeed(upcomingEvents),
  countUpcomingByGuildId: () => Effect.succeed(upcomingCount),
  insertEvent: () => Effect.die(new Error('Not implemented')),
  findEventByIdWithDetails: () => Effect.succeed(Option.none()),
  findByTeamId: () => Effect.succeed([]),
  findEventsByTeamId: () => Effect.succeed([]),
  findByIdWithDetails: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  updateEvent: () => Effect.die(new Error('Not implemented')),
  cancel: () => Effect.void,
  cancelEvent: () => Effect.void,
  findScopedTrainingTypeIds: () => Effect.succeed([]),
  getScopedTrainingTypeIds: () => Effect.succeed([]),
  markModified: () => Effect.void,
  markEventSeriesModified: () => Effect.void,
  cancelFuture: () => Effect.void,
  cancelFutureInSeries: () => Effect.void,
  updateFutureUnmodified: () => Effect.void,
  updateFutureUnmodifiedInSeries: () => Effect.void,
  findEventsByChannelId: () => Effect.succeed([]),
  saveDiscordMessageId: () => Effect.void,
  getDiscordMessageId: () => Effect.succeed(Option.none()),
  findNonResponders: () => Effect.succeed([]),
} as any);

const MockProvideLayer = Layer.mergeAll(
  MockTeamsRepositoryLayer,
  MockTeamMembersRepositoryLayer,
  MockEventsRepositoryLayer,
);

// ---------------------------------------------------------------------------
// Tests for the guild-lookup step (mirrors what the handler does first)
// ---------------------------------------------------------------------------

describe('GetUpcomingEventsForUser handler — guild lookup', () => {
  it.effect('resolves team_id from a known guild_id', () =>
    Effect.Do.pipe(
      Effect.bind('teams', () => TeamsRepository.asEffect()),
      Effect.flatMap(({ teams }) => teams.findByGuildId(TEST_GUILD_ID)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new EventRpcModels.GuildNotFound()),
          onSome: (team) => Effect.succeed(team.id),
        }),
      ),
      Effect.tap((teamId) =>
        Effect.sync(() => {
          expect(teamId).toBe(TEST_TEAM_ID);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('fails with GuildNotFound when guild_id is unknown', () => {
    const unknownGuildId = '000000000000000001' as Discord.Snowflake;

    return Effect.Do.pipe(
      Effect.bind('teams', () => TeamsRepository.asEffect()),
      Effect.flatMap(({ teams }) => teams.findByGuildId(unknownGuildId)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new EventRpcModels.GuildNotFound()),
          onSome: (team) => Effect.succeed(team.id),
        }),
      ),
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('GuildNotFound');
          }
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests for the member-lookup step
// ---------------------------------------------------------------------------

describe('GetUpcomingEventsForUser handler — member lookup', () => {
  it.effect('resolves member when discord user is in team', () =>
    Effect.Do.pipe(
      Effect.bind('members', () => TeamMembersRepository.asEffect()),
      Effect.flatMap(({ members }) => members.findMembershipByIds(TEST_TEAM_ID, TEST_USER_ID)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new EventRpcModels.RsvpMemberNotFound()),
          onSome: (m) => Effect.succeed(m.id),
        }),
      ),
      Effect.tap((memberId) =>
        Effect.sync(() => {
          expect(memberId).toBe(TEST_MEMBER_ID);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('fails with RsvpMemberNotFound when member is not found', () => {
    const NoMemberLayer = Layer.succeed(TeamMembersRepository, {
      findMembershipByIds: () => Effect.succeed(Option.none()),
    } as any);

    return Effect.Do.pipe(
      Effect.bind('members', () => TeamMembersRepository.asEffect()),
      Effect.flatMap(({ members }) =>
        members.findMembershipByIds(TEST_TEAM_ID, 'unknown-user-id' as User.UserId),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new EventRpcModels.RsvpMemberNotFound()),
          onSome: (m) => Effect.succeed(m.id),
        }),
      ),
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('RsvpMemberNotFound');
          }
        }),
      ),
      Effect.provide(
        Layer.mergeAll(MockTeamsRepositoryLayer, NoMemberLayer, MockEventsRepositoryLayer),
      ),
      Effect.asVoid,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests for UpcomingEventsForUserResult construction
// ---------------------------------------------------------------------------

describe('GetUpcomingEventsForUser handler — result construction', () => {
  it.effect('builds UpcomingEventsForUserResult with correct shape', () =>
    Effect.Do.pipe(
      Effect.let(
        'entry',
        () =>
          new EventRpcModels.UpcomingEventForUserEntry({
            event_id: TEST_EVENT_ID,
            team_id: TEST_TEAM_ID,
            title: 'Test Event',
            description: Option.none(),
            image_url: Option.none(),
            start_at: FUTURE_DATE,
            end_at: Option.none(),
            location: Option.some('Sports Hall'),
            location_url: Option.none(),
            event_type: 'training',
            yes_count: 3,
            no_count: 1,
            maybe_count: 2,
            my_response: Option.some('yes'),
            my_response_actual: Option.some('yes'),
            my_message: Option.some('See you there'),
            all_day: false,
          }),
      ),
      Effect.let(
        'result',
        ({ entry }) =>
          new EventRpcModels.UpcomingEventsForUserResult({
            events: [entry],
            total: 1,
            team_id: TEST_TEAM_ID,
          }),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(result.total).toBe(1);
          expect(result.team_id).toBe(TEST_TEAM_ID);
          expect(result.events).toHaveLength(1);

          const ev = result.events[0];
          expect(ev.event_id).toBe(TEST_EVENT_ID);
          expect(ev.title).toBe('Test Event');
          expect(ev.event_type).toBe('training');
          expect(ev.yes_count).toBe(3);
          expect(ev.no_count).toBe(1);
          expect(ev.maybe_count).toBe(2);
          expect(Option.isSome(ev.my_response) && ev.my_response.value).toBe('yes');
          expect(Option.isSome(ev.my_message) && ev.my_message.value).toBe('See you there');
          expect(Option.isSome(ev.location) && ev.location.value).toBe('Sports Hall');
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('builds result with empty events list when total is 0', () =>
    Effect.Do.pipe(
      Effect.let(
        'result',
        () =>
          new EventRpcModels.UpcomingEventsForUserResult({
            events: [],
            total: 0,
            team_id: TEST_TEAM_ID,
          }),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(result.total).toBe(0);
          expect(result.events).toHaveLength(0);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('correctly represents optional fields as Option.none()', () =>
    Effect.Do.pipe(
      Effect.let(
        'entry',
        () =>
          new EventRpcModels.UpcomingEventForUserEntry({
            event_id: TEST_EVENT_ID,
            team_id: TEST_TEAM_ID,
            title: 'Minimal Event',
            description: Option.none(),
            image_url: Option.none(),
            start_at: FUTURE_DATE,
            end_at: Option.none(),
            location: Option.none(),
            location_url: Option.none(),
            event_type: 'other',
            yes_count: 0,
            no_count: 0,
            maybe_count: 0,
            my_response: Option.none(),
            my_response_actual: Option.none(),
            my_message: Option.none(),
            all_day: false,
          }),
      ),
      Effect.tap(({ entry }) =>
        Effect.sync(() => {
          expect(Option.isNone(entry.description)).toBe(true);
          expect(Option.isNone(entry.end_at)).toBe(true);
          expect(Option.isNone(entry.location)).toBe(true);
          expect(Option.isNone(entry.my_response)).toBe(true);
          expect(Option.isNone(entry.my_message)).toBe(true);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );
});
