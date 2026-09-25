// Slice 3a of "Setup memberships" — EventAttendanceRepository against real Postgres.
// Pattern: `EventRsvpsRepository.missed-rsvps.test.ts` (same candidate-population shape: team +
// built-in roles + groups + events) and `membershipPlansRepository.test.ts` (repository-level
// `it.effect` structure).

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Event, GroupModel, Role, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventAttendanceRepository } from '~/repositories/EventAttendanceRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventAttendanceRepository.Default,
  EventRsvpsRepository.Default,
  EventsRepository.Default,
  GroupsRepository.Default,
  RolesRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers — copied/adapted from EventRsvpsRepository.missed-rsvps.test.ts
// ---------------------------------------------------------------------------

let discordIdCounter = 870_000_000_000_000_000n;
const nextDiscordId = (): Discord.Snowflake => (discordIdCounter++).toString() as Discord.Snowflake;

const createUser = (username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: nextDiscordId(),
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Attendance Test Team',
        guild_id: nextDiscordId(),
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

const seedRoles = (teamId: Team.TeamId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(teamId)),
  );

const getPlayerRoleId = (teamId: Team.TeamId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findRoleByTeamAndName(teamId, 'Player')),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new Error('Player role not found')),
        onSome: (r) => Effect.succeed(r.id),
      }),
    ),
  );

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

const deactivateMember = (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.deactivateMemberByIds(teamId, memberId)),
  );

const assignRole = (memberId: TeamMember.TeamMemberId, roleId: Role.RoleId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignRole(memberId, roleId)),
  );

const insertRoleWithPermissions = (teamId: Team.TeamId, name: string) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.insertRole(teamId, name)),
    Effect.map((role) => role.id),
  );

const setDefaultRole = (roleId: Role.RoleId) =>
  RolesRepository.asEffect().pipe(Effect.andThen((repo) => repo.setDefaultRole(roleId)));

const createGroup = (
  teamId: Team.TeamId,
  name: string,
  parentId: Option.Option<GroupModel.GroupId> = Option.none(),
) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertGroup(teamId, name, parentId, Option.none(), Option.none()),
    ),
  );

const addGroupMember = (groupId: GroupModel.GroupId, teamMemberId: TeamMember.TeamMemberId) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.addMemberById(groupId, teamMemberId)),
  );

const archiveGroup = (groupId: GroupModel.GroupId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.archiveGroupById(groupId)));

const PAST = DateTime.makeUnsafe('2024-01-01T18:00:00.000Z');
const FUTURE = DateTime.makeUnsafe('2099-12-31T18:00:00.000Z');

const createEvent = (
  teamId: Team.TeamId,
  createdBy: TeamMember.TeamMemberId,
  options: {
    readonly memberGroupId?: Option.Option<GroupModel.GroupId>;
    readonly startAt?: DateTime.Utc;
    readonly eventType?: string;
  } = {},
) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: options.eventType ?? 'training',
        title: 'Attendance Test Event',
        description: Option.none(),
        startAt: options.startAt ?? PAST,
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: options.memberGroupId ?? Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy,
      }),
    ),
  );

const cancelEvent = (eventId: Event.EventId) =>
  EventsRepository.asEffect().pipe(Effect.andThen((repo) => repo.cancelEvent(eventId)));

const submitRsvp = (
  eventId: Event.EventId,
  memberId: TeamMember.TeamMemberId,
  response: 'yes' | 'no' | 'maybe' | 'coming_later' = 'yes',
) =>
  EventRsvpsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.upsertRsvp(eventId, memberId, response, Option.none())),
  );

/** Inserts a stored attendance row directly via SQL — used to set up READ fixtures without
 * going through the guarded `confirmAttendance` write (which requires a startable training
 * event). */
const insertAttendanceRow = (
  eventId: Event.EventId,
  memberId: TeamMember.TeamMemberId,
  present: boolean,
  confirmed = false,
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      confirmed
        ? sql`INSERT INTO event_attendance (event_id, team_member_id, present, confirmed_at)
              VALUES (${eventId}, ${memberId}, ${present}, now())`
        : sql`INSERT INTO event_attendance (event_id, team_member_id, present)
              VALUES (${eventId}, ${memberId}, ${present})`,
    ),
  );

const findAttendance = (eventId: Event.EventId) =>
  EventAttendanceRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findAttendanceForEvent(eventId)),
  );

const confirm = (input: {
  event_id: Event.EventId;
  team_id: Team.TeamId;
  confirmed_by: TeamMember.TeamMemberId;
  entries: ReadonlyArray<{ team_member_id: TeamMember.TeamMemberId; present: boolean }>;
}) =>
  EventAttendanceRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.confirmAttendance(input)),
  );

const rawAttendanceRows = (eventId: Event.EventId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{
        team_member_id: string;
        present: boolean;
        confirmed_at: Date | null;
        confirmed_by: string | null;
        updated_at: Date;
      }>`SELECT team_member_id, present, confirmed_at, confirmed_by, updated_at
         FROM event_attendance WHERE event_id = ${eventId}`,
    ),
  );

/** Team + built-in roles + a captain (used as event creator/confirmer). */
const seedTeam = (suffix: string) =>
  Effect.Do.pipe(
    Effect.bind('ownerId', () => createUser(`att-owner-${suffix}`)),
    Effect.bind('team', ({ ownerId }) => createTeam(ownerId)),
    Effect.tap(({ team }) => seedRoles(team.id)),
    Effect.bind('playerRoleId', ({ team }) => getPlayerRoleId(team.id)),
    Effect.bind('captainUserId', () => createUser(`att-captain-${suffix}`)),
    Effect.bind('captainMember', ({ team, captainUserId }) =>
      addTeamMember(team.id, captainUserId),
    ),
  );

/** A team plus one additional member (`subject`), NOT yet given a role/RSVP. */
const seedSubject = (suffix: string) =>
  seedTeam(suffix).pipe(
    Effect.bind('subjectUserId', () => createUser(`att-subject-${suffix}`)),
    Effect.bind('subject', ({ team, subjectUserId }) => addTeamMember(team.id, subjectUserId)),
  );

/** `seedSubject` plus the Player role assigned to the subject, so they pass the
 * role-eligibility half of the candidate predicate on their own. */
const seedEligibleSubject = (suffix: string) =>
  seedSubject(suffix).pipe(
    Effect.tap(({ subject, playerRoleId }) => assignRole(subject.id, playerRoleId)),
  );

// ---------------------------------------------------------------------------
// findAttendanceForEvent — candidate population
// ---------------------------------------------------------------------------

describe('EventAttendanceRepository.findAttendanceForEvent — candidate population', () => {
  it.effect("RSVP'd yes, no attendance row -> listed, present true", () =>
    seedEligibleSubject('1').pipe(
      Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
      Effect.tap(({ event, subject }) => submitRsvp(event.id, subject.id, 'yes')),
      Effect.bind('rows', ({ event }) => findAttendance(event.id)),
      Effect.tap(({ rows, subject }) =>
        Effect.sync(() => {
          const row = rows.find((r) => r.team_member_id === subject.id);
          expect(row).toBeDefined();
          expect(row?.present).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect("RSVP'd coming_later -> present true", () =>
    seedEligibleSubject('2').pipe(
      Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
      Effect.tap(({ event, subject }) => submitRsvp(event.id, subject.id, 'coming_later')),
      Effect.bind('rows', ({ event }) => findAttendance(event.id)),
      Effect.tap(({ rows, subject }) =>
        Effect.sync(() => {
          const row = rows.find((r) => r.team_member_id === subject.id);
          expect(row?.present).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect("RSVP'd maybe -> listed, present false", () =>
    seedEligibleSubject('3a').pipe(
      Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
      Effect.tap(({ event, subject }) => submitRsvp(event.id, subject.id, 'maybe')),
      Effect.bind('rows', ({ event }) => findAttendance(event.id)),
      Effect.tap(({ rows, subject }) =>
        Effect.sync(() => {
          const row = rows.find((r) => r.team_member_id === subject.id);
          expect(row).toBeDefined();
          expect(row?.present).toBe(false);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect("RSVP'd no -> listed, present false", () =>
    seedEligibleSubject('3b').pipe(
      Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
      Effect.tap(({ event, subject }) => submitRsvp(event.id, subject.id, 'no')),
      Effect.bind('rows', ({ event }) => findAttendance(event.id)),
      Effect.tap(({ rows, subject }) =>
        Effect.sync(() => {
          const row = rows.find((r) => r.team_member_id === subject.id);
          expect(row).toBeDefined();
          expect(row?.present).toBe(false);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('no RSVP row at all -> listed, present false (the walk-in case)', () =>
    seedEligibleSubject('4').pipe(
      Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
      Effect.bind('rows', ({ event }) => findAttendance(event.id)),
      Effect.tap(({ rows, subject }) =>
        Effect.sync(() => {
          const row = rows.find((r) => r.team_member_id === subject.id);
          expect(row).toBeDefined();
          expect(row?.present).toBe(false);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect("a stored attendance row present=false OVERRIDES a 'yes' RSVP", () =>
    seedEligibleSubject('5').pipe(
      Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
      Effect.tap(({ event, subject }) => submitRsvp(event.id, subject.id, 'yes')),
      Effect.tap(({ event, subject }) => insertAttendanceRow(event.id, subject.id, false)),
      Effect.bind('rows', ({ event }) => findAttendance(event.id)),
      Effect.tap(({ rows, subject }) =>
        Effect.sync(() => {
          const row = rows.find((r) => r.team_member_id === subject.id);
          expect(row?.present).toBe(false);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'member outside member_group_id -> NOT listed; a DESCENDANT group member -> listed',
    () =>
      seedEligibleSubject('6').pipe(
        Effect.bind('groupA', ({ team }) => createGroup(team.id, 'Group A')),
        Effect.bind('groupB', ({ team, groupA }) =>
          createGroup(team.id, 'Group B (child)', Option.some(groupA.id)),
        ),
        Effect.tap(({ groupB, subject }) => addGroupMember(groupB.id, subject.id)),
        // A second, eligible member OUTSIDE any group.
        Effect.bind('outsideUserId', () => createUser('att-outside-6')),
        Effect.bind('outsideMember', ({ team, outsideUserId }) =>
          addTeamMember(team.id, outsideUserId),
        ),
        Effect.tap(({ outsideMember, playerRoleId }) => assignRole(outsideMember.id, playerRoleId)),
        Effect.bind('event', ({ team, captainMember, groupA }) =>
          createEvent(team.id, captainMember.id, { memberGroupId: Option.some(groupA.id) }),
        ),
        Effect.bind('rows', ({ event }) => findAttendance(event.id)),
        Effect.tap(({ rows, subject, outsideMember }) =>
          Effect.sync(() => {
            const ids = rows.map((r) => r.team_member_id);
            expect(ids).toContain(subject.id); // descendant group -> listed
            expect(ids).not.toContain(outsideMember.id); // outside -> not listed
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('member whose ONLY group is an ARCHIVED subgroup -> NOT listed', () =>
    seedEligibleSubject('7').pipe(
      Effect.bind('groupA', ({ team }) => createGroup(team.id, 'Group A')),
      Effect.bind('groupB', ({ team, groupA }) =>
        createGroup(team.id, 'Group B (archived child)', Option.some(groupA.id)),
      ),
      Effect.tap(({ groupB, subject }) => addGroupMember(groupB.id, subject.id)),
      Effect.tap(({ groupB }) => archiveGroup(groupB.id)),
      Effect.bind('event', ({ team, captainMember, groupA }) =>
        createEvent(team.id, captainMember.id, { memberGroupId: Option.some(groupA.id) }),
      ),
      Effect.bind('rows', ({ event }) => findAttendance(event.id)),
      Effect.tap(({ rows, subject }) =>
        Effect.sync(() => {
          expect(rows.map((r) => r.team_member_id)).not.toContain(subject.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'member holding only a SUPERSEDED ex-default role (was_default true, is_default false) -> LISTED',
    () =>
      seedSubject('8').pipe(
        Effect.bind('coachRoleId', ({ team }) => insertRoleWithPermissions(team.id, 'Coach')),
        Effect.tap(({ coachRoleId }) => setDefaultRole(coachRoleId)),
        Effect.bind('assistantRoleId', ({ team }) =>
          insertRoleWithPermissions(team.id, 'Assistant Coach'),
        ),
        // Promoting Assistant Coach supersedes Coach: Coach becomes is_default=false but its
        // was_default flag is never cleared.
        Effect.tap(({ assistantRoleId }) => setDefaultRole(assistantRoleId)),
        Effect.tap(({ subject, coachRoleId }) => assignRole(subject.id, coachRoleId)),
        Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
        Effect.bind('rows', ({ event }) => findAttendance(event.id)),
        Effect.tap(({ rows, subject }) =>
          Effect.sync(() => {
            expect(rows.map((r) => r.team_member_id)).toContain(subject.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'member with missed_rsvps at/above the reminder cutoff -> LISTED (no missed_rsvps ' +
      'targeting filter here, unlike findNonResponders)',
    () =>
      seedEligibleSubject('9').pipe(
        Effect.tap(({ subject }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen(
              (sql) => sql`UPDATE team_members SET missed_rsvps = 100 WHERE id = ${subject.id}`,
            ),
          ),
        ),
        Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
        Effect.bind('rows', ({ event }) => findAttendance(event.id)),
        Effect.tap(({ rows, subject }) =>
          Effect.sync(() => {
            expect(rows.map((r) => r.team_member_id)).toContain(subject.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'inactive member with an existing attendance row -> listed; inactive with no RSVP and ' +
      'no row -> not listed',
    () =>
      seedEligibleSubject('10').pipe(
        Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
        Effect.tap(({ event, subject }) => insertAttendanceRow(event.id, subject.id, true, true)),
        Effect.tap(({ team, subject }) => deactivateMember(team.id, subject.id)),
        // A second inactive member with no RSVP and no attendance row.
        Effect.bind('otherUserId', () => createUser('att-inactive-other-10')),
        Effect.bind('other', ({ team, otherUserId }) => addTeamMember(team.id, otherUserId)),
        Effect.tap(({ other, playerRoleId }) => assignRole(other.id, playerRoleId)),
        Effect.tap(({ team, other }) => deactivateMember(team.id, other.id)),
        Effect.bind('rows', ({ event }) => findAttendance(event.id)),
        Effect.tap(({ rows, subject, other }) =>
          Effect.sync(() => {
            const ids = rows.map((r) => r.team_member_id);
            expect(ids).toContain(subject.id);
            expect(ids).not.toContain(other.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// confirmAttendance
// ---------------------------------------------------------------------------

describe('EventAttendanceRepository.confirmAttendance', () => {
  it.effect('first call writes rows with confirmed_at set and confirmed_by = actor', () =>
    seedEligibleSubject('11').pipe(
      Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
      Effect.bind('rowsAffected', ({ event, team, captainMember, subject }) =>
        confirm({
          event_id: event.id,
          team_id: team.id,
          confirmed_by: captainMember.id,
          entries: [{ team_member_id: subject.id, present: true }],
        }),
      ),
      Effect.bind('rows', ({ event }) => rawAttendanceRows(event.id)),
      Effect.tap(({ rowsAffected, rows, captainMember }) =>
        Effect.sync(() => {
          expect(rowsAffected).toBe(1);
          expect(rows).toHaveLength(1);
          expect(rows[0]?.confirmed_at).not.toBeNull();
          expect(rows[0]?.confirmed_by).toBe(captainMember.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'second call with a flipped present updates in place: row count unchanged, ' +
      'confirmed_at advanced, updated_at advanced',
    () =>
      seedEligibleSubject('12').pipe(
        Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
        Effect.bind('first', ({ event, team, captainMember, subject }) =>
          confirm({
            event_id: event.id,
            team_id: team.id,
            confirmed_by: captainMember.id,
            entries: [{ team_member_id: subject.id, present: true }],
          }),
        ),
        Effect.bind('rowsBefore', ({ event }) => rawAttendanceRows(event.id)),
        Effect.bind('second', ({ event, team, captainMember, subject }) =>
          confirm({
            event_id: event.id,
            team_id: team.id,
            confirmed_by: captainMember.id,
            entries: [{ team_member_id: subject.id, present: false }],
          }),
        ),
        Effect.bind('rowsAfter', ({ event }) => rawAttendanceRows(event.id)),
        Effect.tap(({ second, rowsBefore, rowsAfter }) =>
          Effect.sync(() => {
            expect(second).toBe(1);
            expect(rowsAfter).toHaveLength(1);
            expect(rowsAfter[0]?.present).toBe(false);
            expect(rowsAfter[0]?.confirmed_at?.getTime()).toBeGreaterThanOrEqual(
              rowsBefore[0]?.confirmed_at?.getTime() ?? 0,
            );
            expect(rowsAfter[0]?.updated_at.getTime()).toBeGreaterThanOrEqual(
              rowsBefore[0]?.updated_at.getTime() ?? 0,
            );
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('an entry naming a member of ANOTHER team is silently dropped: no error, no row', () =>
    seedEligibleSubject('13').pipe(
      Effect.bind('otherTeamOwnerId', () => createUser('att-other-team-owner-13')),
      Effect.bind('otherTeam', ({ otherTeamOwnerId }) => createTeam(otherTeamOwnerId)),
      Effect.bind('otherTeamUserId', () => createUser('att-other-team-member-13')),
      Effect.bind('otherTeamMember', ({ otherTeam, otherTeamUserId }) =>
        addTeamMember(otherTeam.id, otherTeamUserId),
      ),
      Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
      Effect.bind('rowsAffected', ({ event, team, captainMember, otherTeamMember }) =>
        confirm({
          event_id: event.id,
          team_id: team.id,
          confirmed_by: captainMember.id,
          entries: [{ team_member_id: otherTeamMember.id, present: true }],
        }),
      ),
      Effect.bind('rows', ({ event }) => rawAttendanceRows(event.id)),
      Effect.tap(({ rowsAffected, rows }) =>
        Effect.sync(() => {
          expect(rowsAffected).toBe(0);
          expect(rows).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'a member of the event team but NOT in the candidate list (no RSVP, no group) IS written ' +
      '— a captain can tick a walk-in',
    () =>
      seedTeam('14').pipe(
        // A member with NO role at all — not even in the candidate query's role/group path.
        Effect.bind('walkInUserId', () => createUser('att-walkin-14')),
        Effect.bind('walkIn', ({ team, walkInUserId }) => addTeamMember(team.id, walkInUserId)),
        Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
        Effect.bind('rowsAffected', ({ event, team, captainMember, walkIn }) =>
          confirm({
            event_id: event.id,
            team_id: team.id,
            confirmed_by: captainMember.id,
            entries: [{ team_member_id: walkIn.id, present: true }],
          }),
        ),
        Effect.bind('rows', ({ event }) => rawAttendanceRows(event.id)),
        Effect.tap(({ rowsAffected, rows, walkIn }) =>
          Effect.sync(() => {
            expect(rowsAffected).toBe(1);
            expect(rows.map((r) => r.team_member_id)).toContain(walkIn.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('a DUPLICATE member id in one payload -> no 21000 error; last entry wins', () =>
    seedEligibleSubject('15').pipe(
      Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
      Effect.bind('result', ({ event, team, captainMember, subject }) =>
        confirm({
          event_id: event.id,
          team_id: team.id,
          confirmed_by: captainMember.id,
          entries: [
            { team_member_id: subject.id, present: true },
            { team_member_id: subject.id, present: false },
          ],
        }).pipe(Effect.result),
      ),
      Effect.bind('rows', ({ event }) => rawAttendanceRows(event.id)),
      Effect.tap(({ result, rows, subject }) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Success');
          const row = rows.find((r) => r.team_member_id === subject.id);
          expect(row).toBeDefined();
          // Last entry in the payload (present: false) wins.
          expect(row?.present).toBe(false);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('a NON-TRAINING event -> 0 rows written', () =>
    seedEligibleSubject('16a').pipe(
      Effect.bind('event', ({ team, captainMember }) =>
        createEvent(team.id, captainMember.id, { eventType: 'match' }),
      ),
      Effect.bind('rowsAffected', ({ event, team, captainMember, subject }) =>
        confirm({
          event_id: event.id,
          team_id: team.id,
          confirmed_by: captainMember.id,
          entries: [{ team_member_id: subject.id, present: true }],
        }),
      ),
      Effect.tap(({ rowsAffected }) =>
        Effect.sync(() => {
          expect(rowsAffected).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('a CANCELLED event -> 0 rows written', () =>
    seedEligibleSubject('16b').pipe(
      Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
      Effect.tap(({ event }) => cancelEvent(event.id)),
      Effect.bind('rowsAffected', ({ event, team, captainMember, subject }) =>
        confirm({
          event_id: event.id,
          team_id: team.id,
          confirmed_by: captainMember.id,
          entries: [{ team_member_id: subject.id, present: true }],
        }),
      ),
      Effect.tap(({ rowsAffected }) =>
        Effect.sync(() => {
          expect(rowsAffected).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('an event with start_at in the FUTURE -> 0 rows written', () =>
    seedEligibleSubject('16c').pipe(
      Effect.bind('event', ({ team, captainMember }) =>
        createEvent(team.id, captainMember.id, { startAt: FUTURE }),
      ),
      Effect.bind('rowsAffected', ({ event, team, captainMember, subject }) =>
        confirm({
          event_id: event.id,
          team_id: team.id,
          confirmed_by: captainMember.id,
          entries: [{ team_member_id: subject.id, present: true }],
        }),
      ),
      Effect.tap(({ rowsAffected }) =>
        Effect.sync(() => {
          expect(rowsAffected).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('a cross-team event id -> 0 rows written', () =>
    seedEligibleSubject('17').pipe(
      Effect.bind('otherTeamOwnerId', () => createUser('att-cross-team-owner-17')),
      Effect.bind('otherTeam', ({ otherTeamOwnerId }) => createTeam(otherTeamOwnerId)),
      Effect.bind('event', ({ team, captainMember }) => createEvent(team.id, captainMember.id)),
      Effect.bind('rowsAffected', ({ event, otherTeam, captainMember, subject }) =>
        confirm({
          event_id: event.id,
          team_id: otherTeam.id,
          confirmed_by: captainMember.id,
          entries: [{ team_member_id: subject.id, present: true }],
        }),
      ),
      Effect.bind('rows', ({ event }) => rawAttendanceRows(event.id)),
      Effect.tap(({ rowsAffected, rows }) =>
        Effect.sync(() => {
          expect(rowsAffected).toBe(0);
          expect(rows).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
