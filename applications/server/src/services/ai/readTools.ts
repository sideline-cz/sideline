/**
 * The six read-only AI tool executors — plan `.work-plans/ai-app-interaction.md`
 * §8. Every executor is `(args, ctx) => Effect<ToolExecutionResult>` with
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
import { EventsRepository, type EventWithDetails } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
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

const listAllEvents = (
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
