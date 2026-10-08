/**
 * The read-only AI tool executors — plan `.work-plans/ai-app-interaction.md`
 * §8 (the original six) and `.dev-loop/plan.md` half 2 (the six database read
 * tools below them). Every executor is `(args, ctx) => Effect<ToolExecutionResult>` with
 * `E = never`: permission and not-found outcomes are ENCODED as `result`
 * (`{ error: 'forbidden', permission: '<perm>' }` / `{ error: 'not_found' }`),
 * never thrown. `args` is the already-decoded, plain-optional args object —
 * decoding raw tool-call JSON against each tool's `Schema` is the
 * registry/`ChatAgent`'s job, not the executor's.
 *
 * Reuses the mappers extracted in step 1/1b so an assistant card and the
 * entity's own list page cannot drift: `toEventInfo` (`src/api/event.ts`),
 * `toGroupInfo` (`src/api/group.ts`), `toTrainingTypeInfo`
 * (`src/api/training-type.ts`), `toEffectiveRoles`/`toRosterInfo`
 * (`src/api/roster.ts`).
 */
import {
  type AiChatApi,
  type Discord,
  DisplayName,
  type Event,
  type GroupModel,
  type RosterModel,
  type Team,
  type TrainingType,
} from '@sideline/domain';
import { DateTime, Effect, Option } from 'effect';
import { toEventInfo } from '~/api/event.js';
import { toGroupInfo } from '~/api/group.js';
import { hasPermission } from '~/api/permissions.js';
import { toEffectiveRoles, toRosterInfo } from '~/api/roster.js';
import { toTrainingTypeInfo } from '~/api/training-type.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { EventAttendanceRepository } from '~/repositories/EventAttendanceRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventsRepository, type EventWithDetails } from '~/repositories/EventsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { FinanceOverviewRepository } from '~/repositories/FinanceOverviewRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { MembershipPlansRepository } from '~/repositories/MembershipPlansRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { type RosterEntry, TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { computeCurrentDatetime } from '~/services/ai/currentDatetime.js';
import {
  buildListResult,
  type EntityReadContext,
  forbiddenResult,
  notFoundResult,
  type ToolContext,
  type ToolExecutionResult,
} from '~/services/ai/toolTypes.js';

const matchesQuery = (haystack: string, query: string): boolean =>
  haystack.toLowerCase().includes(query.toLowerCase());

const applyQueryFilter = <Row>(
  rows: ReadonlyArray<Row>,
  query: string | undefined,
  getText: (row: Row) => string,
): ReadonlyArray<Row> =>
  query === undefined ? rows : rows.filter((row) => matchesQuery(getText(row), query));

/** Caps a filtered row set at `limit` (validated 1..50 by the tool's own `Schema` — see
 * `registry.ts`), applied last, after every other filter. `list_events` already had this; MAJOR
 * finding 1 extends it to `list_members`/`list_rosters`/`list_groups`/`list_training_types`,
 * which were previously unbounded and fed straight into `truncateForBudget` (`ChatAgent.ts`). */
const applyLimit = <Row>(
  rows: ReadonlyArray<Row>,
  limit: number | undefined,
): ReadonlyArray<Row> => (limit === undefined ? rows : rows.slice(0, limit));

// ---------------------------------------------------------------------------
// current_datetime — membership only, no references.
// ---------------------------------------------------------------------------

export type CurrentDatetimeArgs = Record<string, never>;

export const currentDatetime = (
  _args: CurrentDatetimeArgs,
  ctx: ToolContext,
): Effect.Effect<ToolExecutionResult> =>
  computeCurrentDatetime(ctx.teamTimezone).pipe(Effect.map((result) => ({ result, hits: [] })));

// ---------------------------------------------------------------------------
// list_events — membership; group-visibility mirrors event.ts's list endpoint
// (`listAllEvents` below) EXACTLY. `eventId` folds `get_event` in: at most
// one row, every other filter ignored, and the same `isAdmin` short-circuit
// `getEvent` itself applies (`api/event.ts:348-356`) — a caller who can
// manage the team sees any group's event, `ctx.canSeeGroup` only gates
// everyone else (`listEventById` below).
// ---------------------------------------------------------------------------

export interface ListEventsArgs {
  readonly eventId?: Event.EventId;
  readonly from?: string;
  readonly to?: string;
  readonly status?: Event.EventStatus;
  readonly query?: string;
  readonly limit?: number;
  readonly includeAllGroups?: boolean;
}

const toEventHit = (row: EventWithDetails): AiChatApi.SearchHit => ({
  kind: 'event',
  event: toEventInfo(row),
});

const toEventItem = (row: EventWithDetails): Record<string, unknown> => ({
  title: row.title,
  status: row.status,
  startAt: DateTime.formatIso(row.start_at),
});

const filterEventRows = (
  rows: ReadonlyArray<EventWithDetails>,
  args: ListEventsArgs,
): ReadonlyArray<EventWithDetails> => {
  const { from, to, status, query, limit } = args;
  const filtered = rows
    .filter((r) => from === undefined || r.start_date >= from)
    .filter((r) => to === undefined || r.start_date <= to)
    .filter((r) => status === undefined || r.status === status)
    .filter((r) => query === undefined || matchesQuery(r.title, query));
  return limit === undefined ? filtered : filtered.slice(0, limit);
};

const listEventsResult = (rows: ReadonlyArray<EventWithDetails>): ToolExecutionResult =>
  buildListResult(rows, toEventHit, toEventItem);

/** Single-row `eventId` path: not found if the row does not exist, belongs to
 * another team, or is in a group this caller cannot see — a foreign id must
 * never distinguish "does not exist" from "exists but invisible" (plan §8).
 * `isAdmin` mirrors `getEvent` EXACTLY (`api/event.ts:348-356`, `348: Effect.let('isAdmin', …)`,
 * `349-356`'s `Effect.tap`): a caller who can manage the team skips `ctx.canSeeGroup` entirely
 * and sees the event regardless of its group. A previous draft applied `ctx.canSeeGroup`
 * unconditionally here, which was STRICTER than the real `getEvent` endpoint for admins — the
 * same narrowing bug class the plan warns against, just in the opposite direction (over-gating
 * instead of under-gating). */
const listEventById = (
  eventId: Event.EventId,
  ctx: ToolContext,
): Effect.Effect<ToolExecutionResult, never, EventsRepository> =>
  Effect.Do.pipe(
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.bind('row', ({ events }) => events.findEventByIdWithDetails(eventId)),
    Effect.flatMap(({ row }) =>
      Option.match(row, {
        onNone: () => Effect.succeed(notFoundResult),
        onSome: (event) => {
          if (event.team_id !== ctx.teamId) {
            return Effect.succeed(notFoundResult);
          }
          if (hasPermission(ctx.membership, 'team:manage')) {
            return Effect.succeed(listEventsResult([event]));
          }
          return ctx
            .canSeeGroup(event.member_group_id)
            .pipe(Effect.map((visible) => (visible ? listEventsResult([event]) : notFoundResult)));
        },
      }),
    ),
  );

export const listAllEvents = (
  args: ListEventsArgs,
  ctx: EntityReadContext,
): Effect.Effect<ToolExecutionResult, never, EventsRepository> =>
  Effect.Do.pipe(
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.bind('list', ({ events }) => events.findEventsByTeamId(ctx.teamId)),
    Effect.bind('visible', ({ list }) => {
      const wantsAll = args.includeAllGroups ?? false;
      const canViewAll = hasPermission(ctx.membership, 'team:manage');
      return wantsAll && canViewAll
        ? Effect.succeed(list)
        : // `{ concurrency: 1 }` is REQUIRED, not incidental: it is what makes the
          // plain `Map` behind `ctx.canSeeGroup` safe without a `Ref` (toolTypes.ts).
          Effect.filter(list, (e) => ctx.canSeeGroup(e.member_group_id), { concurrency: 1 });
    }),
    Effect.map(({ visible }) => listEventsResult(filterEventRows(visible, args))),
  );

export const listEvents = (
  args: ListEventsArgs,
  ctx: ToolContext,
): Effect.Effect<ToolExecutionResult, never, EventsRepository> =>
  args.eventId === undefined ? listAllEvents(args, ctx) : listEventById(args.eventId, ctx);

// ---------------------------------------------------------------------------
// list_training_types — membership only.
// ---------------------------------------------------------------------------

export interface ListTrainingTypesArgs {
  readonly query?: string;
  readonly limit?: number;
}

interface TrainingTypeListRow {
  readonly id: TrainingType.TrainingTypeId;
  readonly team_id: Team.TeamId;
  readonly name: string;
  readonly owner_group_name: Option.Option<string>;
  readonly member_group_name: Option.Option<string>;
}

const toTrainingTypeHit = (row: TrainingTypeListRow): AiChatApi.SearchHit => ({
  kind: 'trainingType',
  trainingType: toTrainingTypeInfo(row, row.owner_group_name, row.member_group_name),
});

const toTrainingTypeItem = (row: TrainingTypeListRow): Record<string, unknown> => ({
  name: row.name,
});

export const listTrainingTypes = (
  args: ListTrainingTypesArgs,
  ctx: EntityReadContext,
): Effect.Effect<ToolExecutionResult, never, TrainingTypesRepository> =>
  Effect.Do.pipe(
    Effect.bind('trainingTypes', () => TrainingTypesRepository.asEffect()),
    Effect.bind('list', ({ trainingTypes }) => trainingTypes.findTrainingTypesByTeamId(ctx.teamId)),
    Effect.map(({ list }) => {
      const filtered = applyLimit(
        applyQueryFilter(list, args.query, (t) => t.name),
        args.limit,
      );
      return buildListResult(filtered, toTrainingTypeHit, toTrainingTypeItem);
    }),
  );

// ---------------------------------------------------------------------------
// list_groups — gated on `group:manage` (group.ts:60-62), NOT bare membership.
// A real data leak in a previous draft: gating on membership would let a plain
// player who gets a 403 from GET /teams/:id/groups ask the assistant instead.
// ---------------------------------------------------------------------------

export interface ListGroupsArgs {
  readonly query?: string;
  readonly limit?: number;
}

interface GroupListRow {
  readonly id: GroupModel.GroupId;
  readonly team_id: Team.TeamId;
  readonly parent_id: Option.Option<GroupModel.GroupId>;
  readonly name: string;
  readonly emoji: Option.Option<string>;
  readonly color: Option.Option<string>;
  readonly member_count: number;
}

const toGroupHit = (row: GroupListRow): AiChatApi.SearchHit => ({
  kind: 'group',
  // Not wired to `ChannelSyncEventsRepository` (the plan's backing-call table
  // for `list_groups` lists only `GroupsRepository.findGroupsByTeamId`), so
  // provisioning is reported as `false` rather than pulling in an
  // undocumented repository dependency for a field the model never reads.
  group: toGroupInfo(row, row.member_count, false),
});

const toGroupItem = (row: GroupListRow): Record<string, unknown> => ({
  name: row.name,
  emoji: Option.getOrNull(row.emoji),
  color: Option.getOrNull(row.color),
  memberCount: row.member_count,
});

export const listGroups = (
  args: ListGroupsArgs,
  ctx: EntityReadContext,
): Effect.Effect<ToolExecutionResult, never, GroupsRepository> =>
  hasPermission(ctx.membership, 'group:manage')
    ? Effect.Do.pipe(
        Effect.bind('groups', () => GroupsRepository.asEffect()),
        Effect.bind('list', ({ groups }) => groups.findGroupsByTeamId(ctx.teamId)),
        Effect.map(({ list }) => {
          const filtered = applyLimit(
            applyQueryFilter(list, args.query, (g) => g.name),
            args.limit,
          );
          return buildListResult(filtered, toGroupHit, toGroupItem);
        }),
      )
    : Effect.succeed(forbiddenResult('group:manage'));

// ---------------------------------------------------------------------------
// list_members — gated on `member:view` (roster.ts:301-303). Allow-listed
// projection: NEVER discordId, birthDate, gender, email, username, userId or
// permissions. The raw `discordId` field is not itself a wire field — but it
// remains DERIVABLE from `avatarUrl` (`avatarUrlOf` below embeds the
// snowflake in the CDN URL path), at parity with `PlayerCard.tsx` under the
// same `member:view` gate. Not a new exposure this surface introduces, just
// not the hard guarantee an earlier draft of this comment claimed.
// ---------------------------------------------------------------------------

export interface ListMembersArgs {
  readonly query?: string;
  readonly activeOnly?: boolean;
  readonly limit?: number;
}

const displayNameOf = (entry: RosterEntry): string =>
  Option.getOrElse(
    DisplayName.pickDisplayName({
      name: entry.name,
      nickname: entry.discord_nickname,
      displayName: entry.discord_display_name,
      username: Option.some(entry.username),
    }),
    () => entry.username,
  );

const avatarUrlOf = (entry: RosterEntry): Option.Option<string> =>
  Option.map(
    entry.avatar,
    (avatar) => `https://cdn.discordapp.com/avatars/${entry.discord_id}/${avatar}.png?size=32`,
  );

const toMemberHit = (row: RosterEntry): AiChatApi.SearchHit => ({
  kind: 'member',
  memberId: row.member_id,
  displayName: displayNameOf(row),
  avatarUrl: avatarUrlOf(row),
  jerseyNumber: row.jersey_number,
  roleNames: row.role_names,
  effectiveRoles: toEffectiveRoles(row),
  active: row.active,
});

const toMemberItem = (row: RosterEntry): Record<string, unknown> => ({
  displayName: displayNameOf(row),
  jerseyNumber: Option.getOrNull(row.jersey_number),
  roleNames: row.role_names,
  active: row.active,
});

export const listMembers = (
  args: ListMembersArgs,
  ctx: EntityReadContext,
): Effect.Effect<ToolExecutionResult, never, TeamMembersRepository> =>
  hasPermission(ctx.membership, 'member:view')
    ? Effect.Do.pipe(
        Effect.bind('members', () => TeamMembersRepository.asEffect()),
        Effect.bind('list', ({ members }) => members.findRosterByTeam(ctx.teamId)),
        Effect.map(({ list }) => {
          const activeFiltered = args.activeOnly ? list.filter((m) => m.active) : list;
          const filtered = applyLimit(
            applyQueryFilter(activeFiltered, args.query, displayNameOf),
            args.limit,
          );
          return buildListResult(filtered, toMemberHit, toMemberItem);
        }),
      )
    : Effect.succeed(forbiddenResult('member:view'));

// ---------------------------------------------------------------------------
// list_rosters — gated on `roster:view` (roster.ts:573-575).
// ---------------------------------------------------------------------------

export interface ListRostersArgs {
  readonly query?: string;
  readonly limit?: number;
}

interface RosterListRow {
  readonly id: RosterModel.RosterId;
  readonly team_id: Team.TeamId;
  readonly name: string;
  readonly active: boolean;
  readonly color: Option.Option<string>;
  readonly emoji: Option.Option<string>;
  readonly member_count: number;
  readonly created_at: DateTime.Utc;
  readonly discord_channel_id: Option.Option<Discord.Snowflake>;
}

const toRosterHit = (row: RosterListRow): AiChatApi.SearchHit => ({
  kind: 'roster',
  // No live Discord channel-name resolution: the model-facing allow-list has
  // no use for it, and the plan's backing-call table for `list_rosters` lists
  // only `RostersRepository.findByTeamId`.
  roster: toRosterInfo(row, row.member_count, [], false),
});

const toRosterItem = (row: RosterListRow): Record<string, unknown> => ({
  name: row.name,
  memberCount: row.member_count,
  active: row.active,
});

export const listRosters = (
  args: ListRostersArgs,
  ctx: EntityReadContext,
): Effect.Effect<ToolExecutionResult, never, RostersRepository> =>
  hasPermission(ctx.membership, 'roster:view')
    ? Effect.Do.pipe(
        Effect.bind('rosters', () => RostersRepository.asEffect()),
        Effect.bind('list', ({ rosters }) => rosters.findByTeamId(ctx.teamId)),
        Effect.map(({ list }) => {
          const filtered = applyLimit(
            applyQueryFilter(list, args.query, (r) => r.name),
            args.limit,
          );
          return buildListResult(filtered, toRosterHit, toRosterItem);
        }),
      )
    : Effect.succeed(forbiddenResult('roster:view'));

// ===========================================================================
// The six database read tools — `.dev-loop/plan.md` half 2 / `.dev-loop/spec.md`.
//
// None of them mints a reference card: `AiChatApi.SearchHit` has no `fee`/`rsvp`/`attendance`
// kind and this ticket does not add one (`.dev-loop/spec.md`), so every row below is
// model-facing text only. The model still cites events and members via `list_events` /
// `list_members` in the same turn.
// ===========================================================================

/** `buildListResult` without the `SearchHit` half — these tools emit `hits: []` by design. */
const itemsResult = (items: ReadonlyArray<Record<string, unknown>>): ToolExecutionResult => ({
  result: { items },
  hits: [],
});

/** Every name slot is nullable on these joins (a member whose user row has no name, nickname,
 *  display name or username). `displayNameOf` above cannot be reused: it takes a `RosterEntry`,
 *  whose `username` is a plain string, not an `Option`. */
const displayNameOfParts = (row: {
  readonly member_name: Option.Option<string>;
  readonly nickname: Option.Option<string>;
  readonly display_name: Option.Option<string>;
  readonly username: Option.Option<string>;
}): string =>
  Option.getOrElse(
    DisplayName.pickDisplayName({
      name: row.member_name,
      nickname: row.nickname,
      displayName: row.display_name,
      username: row.username,
    }),
    () => 'Unknown member',
  );

const isoOrNull = (instant: Option.Option<DateTime.Utc>): string | null =>
  Option.getOrNull(Option.map(instant, DateTime.formatIso));

// ---------------------------------------------------------------------------
// list_fees — `finance:view` (api/finance.ts:184).
// ---------------------------------------------------------------------------

export interface ListFeesArgs {
  readonly query?: string;
  readonly limit?: number;
}

export const listFees = (
  args: ListFeesArgs,
  ctx: EntityReadContext,
): Effect.Effect<ToolExecutionResult, never, FeesRepository> =>
  hasPermission(ctx.membership, 'finance:view')
    ? Effect.Do.pipe(
        Effect.bind('fees', () => FeesRepository.asEffect()),
        Effect.bind('list', ({ fees }) => fees.listByTeam(ctx.teamId)),
        Effect.map(({ list }) =>
          itemsResult(
            applyLimit(
              applyQueryFilter(list, args.query, (fee) => fee.name),
              args.limit,
            ).map((fee) => ({
              name: fee.name,
              description: Option.getOrNull(fee.description),
              amountMinor: fee.amount_minor,
              currency: fee.currency,
              dueAt: isoOrNull(fee.due_at),
              archived: Option.isSome(fee.archived_at),
            })),
          ),
        ),
      )
    : Effect.succeed(forbiddenResult('finance:view'));

// ---------------------------------------------------------------------------
// get_finance_overview — `finance:view` (api/finance.ts:376). `overviewByTeam`, never
// `myStatus`: the latter is the self-service endpoint's read and answers a different question.
// ---------------------------------------------------------------------------

export interface GetFinanceOverviewArgs {
  readonly limit?: number;
}

export const getFinanceOverview = (
  args: GetFinanceOverviewArgs,
  ctx: EntityReadContext,
): Effect.Effect<ToolExecutionResult, never, FinanceOverviewRepository> =>
  hasPermission(ctx.membership, 'finance:view')
    ? Effect.Do.pipe(
        Effect.bind('finance', () => FinanceOverviewRepository.asEffect()),
        Effect.bind('list', ({ finance }) => finance.overviewByTeam(ctx.teamId)),
        Effect.map(({ list }) =>
          itemsResult(
            applyLimit(list, args.limit).map((row) => ({
              memberName: Option.getOrNull(row.memberName),
              currency: row.currency,
              totalDueMinor: row.totalDueMinor,
              totalPaidMinor: row.totalPaidMinor,
              overdueCount: row.overdueCount,
              pendingCount: row.pendingCount,
              paidCount: row.paidCount,
              creditMinor: row.creditMinor,
            })),
          ),
        ),
      )
    : Effect.succeed(forbiddenResult('finance:view'));

// ---------------------------------------------------------------------------
// list_event_rsvps / list_event_attendance — membership + group visibility.
//
// TENANCY: `EventRsvpsRepository.findRsvpsByEventId` and
// `EventAttendanceRepository.findAttendanceForEvent` both take an eventId ALONE and are NOT
// team-scoped. Resolving the event through `EventsRepository` against `ctx.teamId` is the only
// thing between a model-supplied id and another club's rows — so it runs FIRST, and a miss
// returns `notFoundResult` without the downstream repository ever being asked.
//
// The gate column DIFFERS between the two tools (RSVP: `member_group_id`, as
// `api/event-rsvp.ts:154`; attendance: `owner_group_id`, as `api/event-attendance.ts:61`), which
// is why the resolver takes the accessor rather than picking a column itself.
// ---------------------------------------------------------------------------

const resolveVisibleEvent = (
  eventId: Event.EventId,
  ctx: EntityReadContext,
  gateGroup: (event: EventWithDetails) => Option.Option<GroupModel.GroupId>,
): Effect.Effect<Option.Option<EventWithDetails>, never, EventsRepository> =>
  Effect.Do.pipe(
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.bind('row', ({ events }) => events.findEventByIdWithDetails(eventId)),
    Effect.flatMap(({ row }) =>
      Option.match(row, {
        onNone: () => Effect.succeed(Option.none<EventWithDetails>()),
        onSome: (event) =>
          event.team_id !== ctx.teamId
            ? Effect.succeed(Option.none<EventWithDetails>())
            : ctx
                .canSeeGroup(gateGroup(event))
                .pipe(Effect.map((visible) => (visible ? Option.some(event) : Option.none()))),
      }),
    ),
  );

export interface ListEventRsvpsArgs {
  readonly eventId: Event.EventId;
  readonly limit?: number;
}

export const listEventRsvps = (
  args: ListEventRsvpsArgs,
  ctx: EntityReadContext,
): Effect.Effect<ToolExecutionResult, never, EventsRepository | EventRsvpsRepository> =>
  resolveVisibleEvent(args.eventId, ctx, (event) => event.member_group_id).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(notFoundResult),
        onSome: () =>
          Effect.Do.pipe(
            Effect.bind('rsvps', () => EventRsvpsRepository.asEffect()),
            Effect.bind('list', ({ rsvps }) => rsvps.findRsvpsByEventId(args.eventId)),
            Effect.map(({ list }) =>
              itemsResult(
                applyLimit(list, args.limit).map((row) => ({
                  displayName: displayNameOfParts(row),
                  response: row.response,
                  message: Option.getOrNull(row.message),
                })),
              ),
            ),
          ),
      }),
    ),
  );

export interface ListEventAttendanceArgs {
  readonly eventId: Event.EventId;
  readonly limit?: number;
}

/**
 * The attendance ROW gate, mirroring `api/event-attendance.ts:63-78` exactly:
 * `canConfirm || finance:view`, where `canConfirm = event:edit && (team:manage || owner-group
 * member)`. Separate from `resolveVisibleEvent`'s group check, which only decides whether the
 * EVENT is visible — RSVP has no second gate, attendance does.
 */
const attendanceRowGate = (
  event: EventWithDetails,
  ctx: EntityReadContext,
): Effect.Effect<boolean> =>
  hasPermission(ctx.membership, 'finance:view')
    ? Effect.succeed(true)
    : hasPermission(ctx.membership, 'event:edit')
      ? hasPermission(ctx.membership, 'team:manage')
        ? Effect.succeed(true)
        : ctx.canSeeGroup(event.owner_group_id)
      : Effect.succeed(false);

export const listEventAttendance = (
  args: ListEventAttendanceArgs,
  ctx: EntityReadContext,
): Effect.Effect<ToolExecutionResult, never, EventsRepository | EventAttendanceRepository> =>
  resolveVisibleEvent(args.eventId, ctx, (event) => event.owner_group_id).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(notFoundResult),
        onSome: (event) =>
          // Seeing the EVENT is not seeing its attendance. `api/event-attendance.ts:75-78` gates
          // the ROWS a second time on `canConfirm || finance:view`, and returns `[]` rather than
          // 403 for everyone else — a built-in Player (`roster:view`, `member:view`) gets nothing
          // on the web. Gating on `canSeeGroup` alone handed them the whole list, and because
          // `makeCanSeeGroup` answers `true` for `Option.none()`, an event with no owner group
          // had no gate left at all beyond team membership.
          event.event_type !== 'training'
            ? // Attendance exists only for trainings; the endpoint answers `notTraining` with no
              // entries rather than an error, so an empty list is the honest mirror.
              Effect.succeed(itemsResult([]))
            : attendanceRowGate(event, ctx).pipe(
                Effect.flatMap((allowed) =>
                  allowed
                    ? Effect.Do.pipe(
                        Effect.bind('attendance', () => EventAttendanceRepository.asEffect()),
                        Effect.bind('list', ({ attendance }) =>
                          attendance.findAttendanceForEvent(args.eventId),
                        ),
                        Effect.map(({ list }) =>
                          itemsResult(
                            applyLimit(list, args.limit).map((row) => ({
                              displayName: displayNameOfParts(row),
                              // `present` is NOT a record of who turned up until a captain has
                              // confirmed: the repository COALESCEs the stored value with the
                              // member's RSVP intention and then `false`
                              // (`EventAttendanceRepository.ts:113`). `confirmed` is the only
                              // thing separating "was marked present" from "said they would
                              // come", so the model gets both or it will state the second as
                              // the first.
                              present: row.present,
                              confirmed: Option.isSome(row.confirmed_at),
                            })),
                          ),
                        ),
                      )
                    : // The disjunction has no single permission to name; `finance:view` is its
                      // only static arm (the other depends on this event's owner group), so it is
                      // the one actionable thing to report.
                      Effect.succeed(forbiddenResult('finance:view')),
                ),
              ),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// list_activity_logs — SELF-ONLY (api/activity-logs.ts:37-41).
//
// The endpoint's real gate is `membership.id === memberId`, four lines BELOW the
// `requireMembership` bind an earlier version of this comment cited. There is no admin branch:
// nobody can read another member's training log over HTTP, so this tool must not offer one
// either. A training note is free text a person wrote about their own body ("knee rehab, still
// painful") — same-team is nowhere near enough.
//
// `memberId` is therefore not a parameter at all. The caller's own membership is the only
// subject, which also removes the id the model had no way to obtain (see `registry.ts`).
//
// TENANCY: `ActivityLogsRepository.findByMember` is scoped by member id alone; the membership is
// resolved through `TeamMembersRepository` against `ctx.teamId` first — same guard as the two
// event tools. `findByMember`, not `findByTeamMember`: the latter returns a stats row with no
// `note`.
// ---------------------------------------------------------------------------

export interface ListActivityLogsArgs {
  readonly limit?: number;
}

export const listActivityLogs = (
  args: ListActivityLogsArgs,
  ctx: EntityReadContext,
): Effect.Effect<ToolExecutionResult, never, ActivityLogsRepository | TeamMembersRepository> =>
  Effect.Do.pipe(
    Effect.let('memberId', () => ctx.membership.id),
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('member', ({ members, memberId }) =>
      members.findRosterMemberByIds(ctx.teamId, memberId),
    ),
    Effect.flatMap(({ member, memberId }) =>
      Option.match(member, {
        onNone: () => Effect.succeed(notFoundResult),
        onSome: (entry) =>
          Effect.Do.pipe(
            Effect.bind('logs', () => ActivityLogsRepository.asEffect()),
            Effect.bind('list', ({ logs }) => logs.findByMember(memberId)),
            Effect.map(({ list }) =>
              itemsResult(
                applyLimit(list, args.limit).map((row) => ({
                  displayName: displayNameOf(entry),
                  activityTypeName: row.activity_type_name,
                  loggedAt: row.logged_at,
                  durationMinutes: Option.getOrNull(row.duration_minutes),
                  note: Option.getOrNull(row.note),
                })),
              ),
            ),
          ),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// list_membership_plans — membership only (api/membership-plan.ts:108).
//
// PRIVACY: that endpoint returns the per-member tier roster only to `finance:manage_fees`. This
// tool PROJECTS IT AWAY ENTIRELY — `findPlanAssignments` is never called, so there is no rule
// here to re-derive and get wrong. Season dates ride along (`findSeasons`), which is what covers
// the approved "team settings & season" domain.
// ---------------------------------------------------------------------------

export interface ListMembershipPlansArgs {
  readonly limit?: number;
}

const toSeasonInfo = (
  season: Option.Option<{
    readonly starts_at: DateTime.Utc;
    readonly selection_deadline: Option.Option<DateTime.Utc>;
    readonly expires_at: Option.Option<DateTime.Utc>;
  }>,
): Record<string, unknown> | null =>
  Option.getOrNull(
    Option.map(season, (row) => ({
      startsAt: DateTime.formatIso(row.starts_at),
      selectionDeadline: isoOrNull(row.selection_deadline),
      expiresAt: isoOrNull(row.expires_at),
    })),
  );

export const listMembershipPlans = (
  args: ListMembershipPlansArgs,
  ctx: EntityReadContext,
): Effect.Effect<ToolExecutionResult, never, MembershipPlansRepository> =>
  Effect.Do.pipe(
    Effect.bind('plans', () => MembershipPlansRepository.asEffect()),
    Effect.bind('list', ({ plans }) => plans.findMembershipPlansByTeamId(ctx.teamId)),
    Effect.bind('seasons', ({ plans }) => plans.findSeasons(ctx.teamId)),
    Effect.map(({ list, seasons }) => ({
      result: {
        items: applyLimit(list, args.limit).map((plan) => ({
          // `None` = the seeded default plan, whose label is translated client-side.
          name: Option.getOrNull(plan.name),
          priceMinor: plan.price_minor,
          currency: plan.currency,
          pricePerTrainingMinor: plan.price_per_training_minor,
          freeTrainingsIncluded: plan.free_trainings_included,
          isDefault: plan.is_default,
        })),
        seasons: {
          current: toSeasonInfo(seasons.current_season),
          next: toSeasonInfo(seasons.next_season),
        },
      },
      hits: [],
    })),
  );
