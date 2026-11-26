// Which RSVP answers feed an event roster (event_rosters.rsvp_answers), against a real DB:
//   - auto-approve backfill only adds responders whose answer is in the set;
//   - the column default (yes + coming_later) keeps the pre-existing behaviour;
//   - an answer moving OUT of the set withdraws the member exactly like yes -> no;
//   - the DB refuses 'no' and an empty set.
//
// Integration test — requires Docker + PostgreSQL (globalSetup.ts). Run with: pnpm test:integration

import { describe, expect, it } from '@effect/vitest';
import type { Discord, EventRosterModel, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { EventRosterRequestsRepository } from '~/repositories/EventRosterRequestsRepository.js';
import { EventRostersRepository } from '~/repositories/EventRostersRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

// ---------------------------------------------------------------------------
// Test layer — all real repositories + service, wired to the test DB
// ---------------------------------------------------------------------------

// Build all repository layers (all depend only on SqlClient)
const RepoLayer = Layer.mergeAll(
  ChannelSyncEventsRepository.Default,
  EventRostersRepository.Default,
  EventRosterRequestsRepository.Default,
  EventSyncEventsRepository.Default,
  EventsRepository.Default,
  GroupsRepository.Default,
  RostersRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
  NotificationsRepository.Default,
);

// Service layer is provided the repos, repos are provided SqlClient
const TestLayer = EventRosterProvisioningService.Default.pipe(
  Layer.provideMerge(RepoLayer),
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: Discord.Snowflake, username: string) =>
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
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Roster Test Team',
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
        title: 'Roster Discord ID Test Event',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(new Date('2099-09-01T10:00:00Z')),
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

const rosterMemberIds = (rosterId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{ team_member_id: string }>`
        SELECT team_member_id FROM roster_members WHERE roster_id = ${rosterId}
      `,
    ),
    Effect.map((rows) => rows.map((r) => r.team_member_id).sort()),
  );

const link = (
  eventId: Parameters<EventRostersRepository['Service']['link']>[0]['eventId'],
  rosterId: Parameters<EventRostersRepository['Service']['link']>[0]['rosterId'],
  rsvpAnswers?: ReadonlyArray<EventRosterModel.RosterRsvpAnswer>,
) =>
  EventRostersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.link({ eventId, rosterId, autoApprove: true, rsvpAnswers })),
  );

// One team, one event, one roster, and three members (each with its own Discord user).
const seed = (guild: string) =>
  Effect.Do.pipe(
    Effect.bind('u1', () => createUser(`${guild}1` as Discord.Snowflake, 'm1')),
    Effect.bind('u2', () => createUser(`${guild}2` as Discord.Snowflake, 'm2')),
    Effect.bind('u3', () => createUser(`${guild}3` as Discord.Snowflake, 'm3')),
    Effect.bind('team', ({ u1 }) => createTeam(`${guild}0` as Discord.Snowflake, u1.id)),
    Effect.bind('m1', ({ team, u1 }) => addTeamMember(team.id, u1.id)),
    Effect.bind('m2', ({ team, u2 }) => addTeamMember(team.id, u2.id)),
    Effect.bind('m3', ({ team, u3 }) => addTeamMember(team.id, u3.id)),
    Effect.bind('event', ({ team, m1 }) => createEvent(team.id, m1.id)),
    Effect.bind('roster', ({ team }) => createRoster(team.id)),
  );

const responder = (id: TeamMember.TeamMemberId, response: string) => ({
  team_member_id: id,
  response,
  discord_user_id: Option.none<Discord.Snowflake>(),
  display_name: Option.none<string>(),
});

const rsvp = (
  teamId: Team.TeamId,
  eventId: Parameters<EventRostersRepository['Service']['findByEventId']>[0],
  memberId: TeamMember.TeamMemberId,
  priorResponse: Option.Option<string>,
  newResponse: string,
) =>
  EventRosterProvisioningService.asEffect().pipe(
    Effect.andThen((svc) =>
      svc.onRsvp({
        teamId,
        event: {
          id: eventId,
          owner_group_id: Option.none(),
          member_group_id: Option.none(),
          title: 'Roster Discord ID Test Event',
          start_at: DateTime.fromDateUnsafe(new Date('2099-09-01T10:00:00Z')) as DateTime.Utc,
          all_day: false,
        },
        memberId,
        discordUserId: Option.none(),
        priorResponse,
        newResponse,
        displayName: Option.none(),
      }),
    ),
  );

describe('event roster RSVP answer set', () => {
  it.effect('backfill adds only responders whose answer is in the set', () =>
    Effect.Do.pipe(
      Effect.bind('s', () => seed('8200000000000000')),
      Effect.tap(({ s }) => link(s.event.id, s.roster.id, ['yes', 'maybe'])),
      Effect.bind('result', ({ s }) =>
        EventRosterProvisioningService.asEffect().pipe(
          Effect.andThen((svc) =>
            svc.backfill({
              eventId: s.event.id,
              teamId: s.team.id,
              rosterId: s.roster.id,
              responders: [
                responder(s.m1.id, 'yes'),
                responder(s.m2.id, 'maybe'),
                responder(s.m3.id, 'coming_later'),
              ],
            }),
          ),
        ),
      ),
      Effect.bind('members', ({ s }) => rosterMemberIds(s.roster.id)),
      Effect.tap(({ s, result, members }) =>
        Effect.sync(() => {
          expect(result.added).toBe(2);
          expect(members).toEqual([s.m1.id, s.m2.id].sort());
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('the default set is yes + coming later, not maybe', () =>
    Effect.Do.pipe(
      Effect.bind('s', () => seed('8210000000000000')),
      Effect.bind('row', ({ s }) => link(s.event.id, s.roster.id)),
      Effect.tap(({ s }) =>
        EventRosterProvisioningService.asEffect().pipe(
          Effect.andThen((svc) =>
            svc.backfill({
              eventId: s.event.id,
              teamId: s.team.id,
              rosterId: s.roster.id,
              responders: [
                responder(s.m1.id, 'yes'),
                responder(s.m2.id, 'maybe'),
                responder(s.m3.id, 'coming_later'),
              ],
            }),
          ),
        ),
      ),
      Effect.bind('members', ({ s }) => rosterMemberIds(s.roster.id)),
      Effect.tap(({ s, row, members }) =>
        Effect.sync(() => {
          expect(row.rsvp_answers).toEqual(['yes', 'coming_later']);
          expect(members).toEqual([s.m1.id, s.m3.id].sort());
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('an answer moving out of the set withdraws the member like yes -> no', () =>
    Effect.Do.pipe(
      Effect.bind('s', () => seed('8220000000000000')),
      Effect.tap(({ s }) => link(s.event.id, s.roster.id, ['yes'])),
      Effect.tap(({ s }) => rsvp(s.team.id, s.event.id, s.m1.id, Option.none(), 'yes')),
      Effect.bind('afterYes', ({ s }) => rosterMemberIds(s.roster.id)),
      // coming_later is NOT in this set, so yes -> coming_later is a withdrawal here
      Effect.tap(({ s }) =>
        rsvp(s.team.id, s.event.id, s.m1.id, Option.some('yes'), 'coming_later'),
      ),
      Effect.bind('afterMove', ({ s }) => rosterMemberIds(s.roster.id)),
      Effect.tap(({ s, afterYes, afterMove }) =>
        Effect.sync(() => {
          expect(afterYes).toEqual([s.m1.id]);
          expect(afterMove).toEqual([]);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('narrowing the set, then answering no, still withdraws the member', () =>
    Effect.Do.pipe(
      Effect.bind('s', () => seed('8250000000000000')),
      Effect.tap(({ s }) => link(s.event.id, s.roster.id, ['yes', 'maybe'])),
      Effect.tap(({ s }) => rsvp(s.team.id, s.event.id, s.m1.id, Option.none(), 'maybe')),
      Effect.bind('afterMaybe', ({ s }) => rosterMemberIds(s.roster.id)),
      Effect.tap(({ s }) =>
        EventRostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.setRsvpAnswers(s.event.id, ['yes'])),
        ),
      ),
      // Neither maybe nor no is in the set any more — the active request still gets withdrawn.
      Effect.tap(({ s }) => rsvp(s.team.id, s.event.id, s.m1.id, Option.some('maybe'), 'no')),
      Effect.bind('afterNo', ({ s }) => rosterMemberIds(s.roster.id)),
      Effect.tap(({ s, afterMaybe, afterNo }) =>
        Effect.sync(() => {
          expect(afterMaybe).toEqual([s.m1.id]);
          expect(afterNo).toEqual([]);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('an answer in the set feeds the roster, one outside it does not', () =>
    Effect.Do.pipe(
      Effect.bind('s', () => seed('8230000000000000')),
      Effect.tap(({ s }) => link(s.event.id, s.roster.id, ['maybe'])),
      Effect.tap(({ s }) => rsvp(s.team.id, s.event.id, s.m1.id, Option.none(), 'maybe')),
      Effect.tap(({ s }) => rsvp(s.team.id, s.event.id, s.m2.id, Option.none(), 'yes')),
      Effect.bind('members', ({ s }) => rosterMemberIds(s.roster.id)),
      Effect.tap(({ s, members }) => Effect.sync(() => expect(members).toEqual([s.m1.id]))),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('setRsvpAnswers persists, and the DB refuses no and an empty set', () =>
    Effect.Do.pipe(
      Effect.bind('s', () => seed('8240000000000000')),
      Effect.tap(({ s }) => link(s.event.id, s.roster.id)),
      Effect.tap(({ s }) =>
        EventRostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.setRsvpAnswers(s.event.id, ['maybe', 'yes'])),
        ),
      ),
      Effect.bind('row', ({ s }) =>
        EventRostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByEventId(s.event.id)),
        ),
      ),
      Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
      Effect.bind('badNo', ({ s, sql }) =>
        sql`UPDATE event_rosters SET rsvp_answers = ARRAY['no']::text[] WHERE event_id = ${s.event.id}`.pipe(
          Effect.flip,
        ),
      ),
      Effect.bind('badEmpty', ({ s, sql }) =>
        sql`UPDATE event_rosters SET rsvp_answers = ARRAY[]::text[] WHERE event_id = ${s.event.id}`.pipe(
          Effect.flip,
        ),
      ),
      Effect.tap(({ row, badNo, badEmpty }) =>
        Effect.sync(() => {
          expect(Option.map(row, (r) => r.rsvp_answers)).toEqual(Option.some(['maybe', 'yes']));
          expect(String(badNo)).toMatch(/ConstraintError/);
          expect(String(badEmpty)).toMatch(/ConstraintError/);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
