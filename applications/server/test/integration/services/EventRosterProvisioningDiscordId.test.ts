// These tests assert the emitted `channel_sync_events` rows carry a real
// `discord_user_id` (resolved from the team member record) at both emit sites
// in EventRosterProvisioningService — the onRsvp auto-approve / withdraw paths
// and the backfill loop — even when the caller supplies `Option.none()`.
//
// NOTE: This is an integration test — requires Docker + a running PostgreSQL
// container (started by globalSetup.ts). Run with: pnpm test:integration

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Event, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { EventRosterRequestsRepository } from '~/repositories/EventRosterRequestsRepository.js';
import { EventRostersRepository } from '~/repositories/EventRostersRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
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

const KNOWN_DISCORD_ID = '700000000000000001' as Discord.Snowflake;

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

// Returns all roster `member_added` rows for the given team
const queryRosterMemberAddedRows = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql<{
          discord_user_id: string | null;
          team_member_id: string | null;
          entity_type: string;
          event_type: string;
        }>`
        SELECT discord_user_id, team_member_id, entity_type, event_type
        FROM channel_sync_events
        WHERE team_id = ${teamId}
          AND entity_type = 'roster'
          AND event_type = 'member_added'
      `,
    ),
  );

// Returns all roster `member_removed` rows for the given team
const queryRosterMemberRemovedRows = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql<{
          discord_user_id: string | null;
          team_member_id: string | null;
          entity_type: string;
          event_type: string;
        }>`
        SELECT discord_user_id, team_member_id, entity_type, event_type
        FROM channel_sync_events
        WHERE team_id = ${teamId}
          AND entity_type = 'roster'
          AND event_type = 'member_removed'
      `,
    ),
  );

// Base event fixture for onRsvp
const makeOnRsvpParams = (
  teamId: Team.TeamId,
  memberId: TeamMember.TeamMemberId,
  eventId: Event.EventId,
  discordUserId: Option.Option<Discord.Snowflake>,
) =>
  ({
    teamId,
    event: {
      id: eventId,
      owner_group_id: Option.none(),
      member_group_id: Option.none(),
      title: 'Roster Discord ID Test Event',
      start_at: DateTime.fromDateUnsafe(new Date('2099-09-01T10:00:00Z')) as DateTime.Utc,
    },
    memberId,
    discordUserId,
    priorResponse: Option.none<string>(),
    newResponse: 'yes',
    displayName: Option.none<string>(),
  }) as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventRosterProvisioningService — roster member_added discord_user_id invariant', () => {
  // Case A: auto-approve onRsvp path
  it.effect(
    'A) onRsvp with auto_approve ON → member_added row has discord_user_id = seeded discord_id',
    () =>
      Effect.Do.pipe(
        Effect.bind('user', () => createUser(KNOWN_DISCORD_ID, 'rsvp-user-a')),
        Effect.bind('team', ({ user }) =>
          createTeam('810000000000000001' as Discord.Snowflake, user.id),
        ),
        Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
        Effect.bind('event', ({ team, tm }) => createEvent(team.id, tm.id)),
        Effect.bind('roster', ({ team }) => createRoster(team.id)),
        // Link event → roster with auto_approve ON
        Effect.tap(({ event, roster }) =>
          EventRostersRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.link({ eventId: event.id, rosterId: roster.id, autoApprove: true }),
            ),
          ),
        ),
        // Fire onRsvp — discordUserId is Option.none() to simulate the buggy caller path
        Effect.tap(({ team, tm, event }) =>
          EventRosterProvisioningService.asEffect().pipe(
            Effect.andThen((svc) =>
              svc.onRsvp(makeOnRsvpParams(team.id, tm.id, event.id, Option.none())),
            ),
          ),
        ),
        Effect.bind('rows', ({ team }) => queryRosterMemberAddedRows(team.id)),
        Effect.tap(({ rows }) =>
          Effect.sync(() => {
            expect(rows).toHaveLength(1);
            // The row must carry a REAL discord_user_id — never NULL
            expect(rows[0]?.discord_user_id).toBe(KNOWN_DISCORD_ID);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // Case B: backfill path — yes-responder not yet a roster member
  it.effect(
    'B) backfill with yes-responder not yet in roster → member_added row has real discord_user_id',
    () =>
      Effect.Do.pipe(
        Effect.bind('user', () => createUser(KNOWN_DISCORD_ID, 'backfill-user-b')),
        Effect.bind('team', ({ user }) =>
          createTeam('810000000000000002' as Discord.Snowflake, user.id),
        ),
        Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
        Effect.bind('event', ({ team, tm }) => createEvent(team.id, tm.id)),
        Effect.bind('roster', ({ team }) => createRoster(team.id)),
        Effect.tap(({ event, roster }) =>
          EventRostersRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.link({ eventId: event.id, rosterId: roster.id, autoApprove: true }),
            ),
          ),
        ),
        Effect.tap(({ team, tm, event, roster }) =>
          EventRosterProvisioningService.asEffect().pipe(
            Effect.andThen((svc) =>
              svc.backfill({
                eventId: event.id,
                teamId: team.id,
                rosterId: roster.id,
                // discord_user_id is Option.none() — simulating the bug: caller never resolved it
                yesResponders: [
                  {
                    team_member_id: tm.id,
                    discord_user_id: Option.none(),
                    display_name: Option.none(),
                  },
                ],
              }),
            ),
          ),
        ),
        Effect.bind('rows', ({ team }) => queryRosterMemberAddedRows(team.id)),
        Effect.tap(({ rows }) =>
          Effect.sync(() => {
            expect(rows).toHaveLength(1);
            expect(rows[0]?.discord_user_id).toBe(KNOWN_DISCORD_ID);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // Case C: responder already a roster member — no new member_added row
  it.effect('C) responder already a roster member → no new member_added row', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser(KNOWN_DISCORD_ID, 'already-member-c')),
      Effect.bind('team', ({ user }) =>
        createTeam('810000000000000003' as Discord.Snowflake, user.id),
      ),
      Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
      Effect.bind('event', ({ team, tm }) => createEvent(team.id, tm.id)),
      Effect.bind('roster', ({ team }) => createRoster(team.id)),
      Effect.tap(({ event, roster }) =>
        EventRostersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.link({ eventId: event.id, rosterId: roster.id, autoApprove: true }),
          ),
        ),
      ),
      // Pre-add member to roster directly so they are already a member
      Effect.tap(({ roster, tm }) =>
        RostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.addMemberById(roster.id, tm.id)),
        ),
      ),
      Effect.tap(({ team, tm, event }) =>
        EventRosterProvisioningService.asEffect().pipe(
          Effect.andThen((svc) =>
            svc.onRsvp(makeOnRsvpParams(team.id, tm.id, event.id, Option.none())),
          ),
        ),
      ),
      Effect.bind('rows', ({ team }) => queryRosterMemberAddedRows(team.id)),
      Effect.tap(({ rows }) =>
        Effect.sync(() => {
          // No new member_added event — member was already in the roster
          expect(rows).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // Case D: team has a guild_id → _emitIfGuildLinked fires and the member_added row
  // carries the real discord_user_id (not null). This guards the invariant that the
  // guild-linked path also resolves discord_id correctly.
  it.effect('D) team has linked guild → member_added row has real discord_user_id', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser(KNOWN_DISCORD_ID, 'guild-linked-d')),
      Effect.bind('team', ({ user }) =>
        createTeam('819999999999999999' as Discord.Snowflake, user.id),
      ),
      Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
      Effect.bind('event', ({ team, tm }) => createEvent(team.id, tm.id)),
      Effect.bind('roster', ({ team }) => createRoster(team.id)),
      Effect.tap(({ event, roster }) =>
        EventRostersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.link({ eventId: event.id, rosterId: roster.id, autoApprove: true }),
          ),
        ),
      ),
      Effect.tap(({ team, tm, event }) =>
        EventRosterProvisioningService.asEffect().pipe(
          Effect.andThen((svc) =>
            svc.onRsvp(makeOnRsvpParams(team.id, tm.id, event.id, Option.none())),
          ),
        ),
      ),
      Effect.bind('rows', ({ team }) => queryRosterMemberAddedRows(team.id)),
      Effect.tap(({ rows }) =>
        Effect.sync(() => {
          // The team has a guild_id so _emitIfGuildLinked fires; the row must carry
          // the real discord_user_id resolved from the member record, never null.
          expect(rows).toHaveLength(1);
          expect(rows[0]?.discord_user_id).toBe(KNOWN_DISCORD_ID);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // Case E: RSVP yes (auto-approve, member added), then withdraw via onRsvp with
  // discordUserId: Option.none() — mirrors the REST RSVP endpoint path.
  // The member_removed row must carry the real discord_user_id, NOT null.
  it.effect(
    'E) withdraw via onRsvp with discordUserId=none → member_removed row has real discord_user_id',
    () =>
      Effect.Do.pipe(
        Effect.bind('user', () => createUser(KNOWN_DISCORD_ID, 'withdraw-user-e')),
        Effect.bind('team', ({ user }) =>
          createTeam('810000000000000011' as Discord.Snowflake, user.id),
        ),
        Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
        Effect.bind('event', ({ team, tm }) => createEvent(team.id, tm.id)),
        Effect.bind('roster', ({ team }) => createRoster(team.id)),
        // Link event → roster with auto_approve ON
        Effect.tap(({ event, roster }) =>
          EventRostersRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.link({ eventId: event.id, rosterId: roster.id, autoApprove: true }),
            ),
          ),
        ),
        // Step 1: RSVP yes → auto-approve → member added to roster
        Effect.tap(({ team, tm, event }) =>
          EventRosterProvisioningService.asEffect().pipe(
            Effect.andThen((svc) =>
              svc.onRsvp(makeOnRsvpParams(team.id, tm.id, event.id, Option.none())),
            ),
          ),
        ),
        // Step 2: withdraw (yes → no) with discordUserId = Option.none() — simulating REST path
        Effect.tap(({ team, tm, event }) =>
          EventRosterProvisioningService.asEffect().pipe(
            Effect.andThen((svc) =>
              svc.onRsvp({
                teamId: team.id,
                event: {
                  id: event.id,
                  owner_group_id: Option.none(),
                  member_group_id: Option.none(),
                  title: 'Roster Discord ID Test Event',
                  start_at: DateTime.fromDateUnsafe(
                    new Date('2099-09-01T10:00:00Z'),
                  ) as DateTime.Utc,
                },
                memberId: tm.id,
                discordUserId: Option.none(),
                priorResponse: Option.some('yes'),
                newResponse: 'no',
                displayName: Option.none(),
              }),
            ),
          ),
        ),
        Effect.bind('removedRows', ({ team }) => queryRosterMemberRemovedRows(team.id)),
        Effect.tap(({ removedRows }) =>
          Effect.sync(() => {
            expect(removedRows).toHaveLength(1);
            // The row must carry a REAL discord_user_id — never NULL
            expect(removedRows[0]?.discord_user_id).toBe(KNOWN_DISCORD_ID);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // Regression guard: NO member_added row with discord_user_id IS NULL
  // Extended: also guards that no member_removed row has discord_user_id IS NULL
  it.effect('Regression: no member_added or member_removed row with discord_user_id = NULL', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser(KNOWN_DISCORD_ID, 'regression-user')),
      Effect.bind('team', ({ user }) =>
        createTeam('810000000000000099' as Discord.Snowflake, user.id),
      ),
      Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
      Effect.bind('event', ({ team, tm }) => createEvent(team.id, tm.id)),
      Effect.bind('roster', ({ team }) => createRoster(team.id)),
      Effect.tap(({ event, roster }) =>
        EventRostersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.link({ eventId: event.id, rosterId: roster.id, autoApprove: true }),
          ),
        ),
      ),
      // RSVP yes → auto-approve → member added
      Effect.tap(({ team, tm, event }) =>
        EventRosterProvisioningService.asEffect().pipe(
          Effect.andThen((svc) =>
            svc.onRsvp(makeOnRsvpParams(team.id, tm.id, event.id, Option.none())),
          ),
        ),
      ),
      // Withdraw (yes → no) with discordUserId = none → member removed
      Effect.tap(({ team, tm, event }) =>
        EventRosterProvisioningService.asEffect().pipe(
          Effect.andThen((svc) =>
            svc.onRsvp({
              teamId: team.id,
              event: {
                id: event.id,
                owner_group_id: Option.none(),
                member_group_id: Option.none(),
                title: 'Roster Discord ID Test Event',
                start_at: DateTime.fromDateUnsafe(new Date('2099-09-01T10:00:00Z')) as DateTime.Utc,
              },
              memberId: tm.id,
              discordUserId: Option.none(),
              priorResponse: Option.some('yes'),
              newResponse: 'no',
              displayName: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('addedRows', ({ team }) => queryRosterMemberAddedRows(team.id)),
      Effect.bind('removedRows', ({ team }) => queryRosterMemberRemovedRows(team.id)),
      Effect.tap(({ addedRows, removedRows }) =>
        Effect.sync(() => {
          // No member_added row may have a null discord_user_id
          const nullAdded = addedRows.filter((r) => r.discord_user_id === null);
          expect(nullAdded).toHaveLength(0);
          // No member_removed row may have a null discord_user_id
          const nullRemoved = removedRows.filter((r) => r.discord_user_id === null);
          expect(nullRemoved).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
