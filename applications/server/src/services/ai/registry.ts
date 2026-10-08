/**
 * The tool registry — plan `.work-plans/ai-app-interaction.md` §8 / §13.3.
 *
 * `ALL_TOOLS` is the single catalogue of every read tool: name,
 * model-facing description, the derived JSON Schema (`parameters`, built
 * once, eagerly, via `toToolParameters`) and the Effect `schema` it was
 * derived from (kept alongside `parameters` so the no-drift test can
 * recompute and compare independently), plus the permission gate (if any).
 *
 * `visibleTools(ctx)` is the UX half of the two-layer permission check
 * described in the plan: it omits tools the caller cannot use from the array
 * sent to the model, so the model never learns they exist. It is NOT the
 * security boundary — every executor in `readTools.ts` re-checks the same
 * gate independently, because the PROVIDER, not a client, can emit a tool
 * call the caller was never offered: a name outside `visibleTools(ctx)`'s
 * filtered array, or even one outside `ALL_TOOLS` entirely. `dispatchOneCall`
 * (`ChatAgent.ts`) resolves every call against the full `ALL_TOOLS`
 * catalogue regardless of what this turn's `tools` array contained, so the
 * permission gate has to be re-checked where the call is actually executed.
 *
 * No tool parameter schema may contain a `teamId` field — the team, the
 * caller's permissions and the team's timezone all come from `ToolContext`,
 * resolved before the model is ever called (see `toolTypes.ts`).
 */
import { Event, type Role, TeamMember } from '@sideline/domain';
import { Option, Schema } from 'effect';
import { hasPermission } from '~/api/permissions.js';
import { ACTION_REGISTRY } from '~/services/ai/actions.js';
import { toToolParameters } from '~/services/ai/jsonSchema.js';
import type { ToolContext } from '~/services/ai/toolTypes.js';
import type { LlmToolDefinition } from '~/services/LlmClient.js';

const QUERY_MAX_LENGTH = 200;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const QueryParam = Schema.String.pipe(Schema.check(Schema.isMaxLength(QUERY_MAX_LENGTH)));
const DateParam = Schema.String.pipe(Schema.check(Schema.isPattern(DATE_PATTERN)));
/** The row cap every list tool accepts, verbatim-identical across all five — `readTools.ts`'s
 * `applyLimit`/`filterEventRows` rely on it having been validated to 1..50 before they slice. */
const LimitParam = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 })));

// ---------------------------------------------------------------------------
// Parameter schemas — one per tool, the single source `toToolParameters`
// derives `parameters` from (plan §7). Flat, `Schema.Int`/`Schema.Finite` for
// numbers (never `Schema.Number`), `Schema.optionalKey` for optional params,
// no `teamId`.
// ---------------------------------------------------------------------------

// Exported so `ChatAgent.ts` can decode a tool call's arguments against the
// EXACT schema each executor accepts, without losing the decoded type to
// `Schema.Top` (the widened type carried by `ToolDefinition.schema`, used
// only for JSON Schema derivation and the no-drift test) and without a cast.
export const CurrentDatetimeSchema = Schema.Struct({});

export const ListEventsSchema = Schema.Struct({
  eventId: Schema.optionalKey(Event.EventId),
  from: Schema.optionalKey(DateParam),
  to: Schema.optionalKey(DateParam),
  status: Schema.optionalKey(Event.EventStatus),
  query: Schema.optionalKey(QueryParam),
  limit: Schema.optionalKey(LimitParam),
  includeAllGroups: Schema.optionalKey(Schema.Boolean),
});

export const ListTrainingTypesSchema = Schema.Struct({
  query: Schema.optionalKey(QueryParam),
  limit: Schema.optionalKey(LimitParam),
});

export const ListGroupsSchema = Schema.Struct({
  query: Schema.optionalKey(QueryParam),
  limit: Schema.optionalKey(LimitParam),
});

export const ListMembersSchema = Schema.Struct({
  query: Schema.optionalKey(QueryParam),
  activeOnly: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(LimitParam),
});

export const ListRostersSchema = Schema.Struct({
  query: Schema.optionalKey(QueryParam),
  limit: Schema.optionalKey(LimitParam),
});

// --- the six database read tools + search_docs (`.dev-loop/plan.md`) -------

export const ListFeesSchema = Schema.Struct({
  query: Schema.optionalKey(QueryParam),
  limit: Schema.optionalKey(LimitParam),
});

export const GetFinanceOverviewSchema = Schema.Struct({
  limit: Schema.optionalKey(LimitParam),
});

export const ListEventRsvpsSchema = Schema.Struct({
  eventId: Event.EventId,
  limit: Schema.optionalKey(LimitParam),
});

export const ListEventAttendanceSchema = Schema.Struct({
  eventId: Event.EventId,
  limit: Schema.optionalKey(LimitParam),
});

export const ListActivityLogsSchema = Schema.Struct({
  memberId: Schema.optionalKey(TeamMember.TeamMemberId),
  limit: Schema.optionalKey(LimitParam),
});

export const ListMembershipPlansSchema = Schema.Struct({
  limit: Schema.optionalKey(LimitParam),
});

/** `query` is REQUIRED here, unlike every list tool's optional free-text filter: a docs search
 *  with no query has nothing to rank and would return the first N sections of the corpus. */
export const SearchDocsSchema = Schema.Struct({
  query: QueryParam,
  limit: Schema.optionalKey(LimitParam),
});

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schema: Schema.Top;
  readonly parameters: Record<string, unknown>;
  /** `None` = every team member may call it; `Some(p)` = requires permission `p`. */
  readonly requiredPermission: Option.Option<Role.Permission>;
}

const define = (
  name: string,
  description: string,
  schema: Schema.Top,
  requiredPermission: Option.Option<Role.Permission> = Option.none(),
): ToolDefinition => ({
  name,
  description,
  schema,
  parameters: toToolParameters(schema),
  requiredPermission,
});

export const ALL_TOOLS: ReadonlyArray<ToolDefinition> = [
  define(
    'current_datetime',
    "Returns the current date/time, both in UTC and in the team's own timezone. " +
      "Call this before reasoning about relative dates ('today', 'this week', 'next training') " +
      'so date math is anchored to the real current time rather than guessed.',
    CurrentDatetimeSchema,
  ),
  define(
    'list_events',
    'Lists the team events (trainings, matches, etc.) visible to the caller. Pass `eventId` to ' +
      'fetch a single event by id — every other parameter is ignored in that case. Filter with ' +
      '`from`/`to` (YYYY-MM-DD), `status`, or a free-text `query` matched against the title. Only ' +
      'set `includeAllGroups` when the user explicitly asks for events across every group — it has ' +
      'no effect unless the caller can manage the team.',
    ListEventsSchema,
  ),
  define(
    'list_training_types',
    'Lists the team training types. Filter with a free-text `query` matched against the name, ' +
      'and/or cap the number of rows returned with `limit` (1-50).',
    ListTrainingTypesSchema,
  ),
  define(
    'list_groups',
    'Lists the team groups (name, emoji, colour, member count). Filter with a free-text `query` ' +
      'matched against the name, and/or cap the number of rows returned with `limit` (1-50). ' +
      "Only available to callers who can manage the team's groups.",
    ListGroupsSchema,
    Option.some('group:manage'),
  ),
  define(
    'list_members',
    'Lists the team members (display name, jersey number, roles, active status — no personal ' +
      'data). Filter with a free-text `query` matched against the display name, `activeOnly` to ' +
      'exclude inactive members, and/or cap the number of rows returned with `limit` (1-50).',
    ListMembersSchema,
    Option.some('member:view'),
  ),
  define(
    'list_rosters',
    'Lists the team rosters (name, member count, active status). Filter with a free-text `query` ' +
      'matched against the name, and/or cap the number of rows returned with `limit` (1-50).',
    ListRostersSchema,
    Option.some('roster:view'),
  ),
  define(
    'list_fees',
    'Lists the team fees (name, description, amount in minor units, currency, due date, whether ' +
      'archived). Filter with a free-text `query` matched against the fee name, and/or cap the ' +
      'number of rows with `limit` (1-50). Only available to callers who can see finances.',
    ListFeesSchema,
    Option.some('finance:view'),
  ),
  define(
    'get_finance_overview',
    "Returns the team's finance overview: one row per member and currency with the total due, " +
      'the total paid, any credit, and how many of their fees are overdue, pending or paid. Use ' +
      'it for "who still owes money" questions. Only available to callers who can see finances.',
    GetFinanceOverviewSchema,
    Option.some('finance:view'),
  ),
  define(
    'list_event_rsvps',
    'Lists who answered an event invitation and how (yes/no/maybe) plus any message they left. ' +
      'Requires the `eventId` of an event you can already see — get it from `list_events`.',
    ListEventRsvpsSchema,
  ),
  define(
    'list_event_attendance',
    'Lists who was actually present at an event, once attendance has been taken. Requires the ' +
      '`eventId` of an event you can already see — get it from `list_events`. This is the ' +
      'recorded attendance, not the RSVPs (use `list_event_rsvps` for those).',
    ListEventAttendanceSchema,
  ),
  define(
    'list_activity_logs',
    'Lists logged training activities (activity type, when, duration in minutes, note). With no ' +
      "`memberId` it returns the caller's OWN logs; pass a `memberId` from `list_members` for " +
      "another member's. Cap the number of rows with `limit` (1-50).",
    ListActivityLogsSchema,
  ),
  define(
    'list_membership_plans',
    "Lists the team's membership plans (name, price in minor units, currency, per-training " +
      "price, included free trainings, which one is the default) together with the team's " +
      'current and next season dates. Use it for questions about plans, prices and season dates.',
    ListMembershipPlansSchema,
  ),
  define(
    'search_docs',
    'Searches the Sideline product documentation (how-to guides, FAQ, concepts) and returns the ' +
      'most relevant sections. This is the right tool for "how do I…" and "what does X mean" ' +
      "questions about the app itself. Do NOT use it for questions about the team's own data — " +
      'events, members, fees and everything else live in the other tools.',
    SearchDocsSchema,
  ),
  // Built FROM the action registry (`services/ai/actions.ts`) so a `propose_<action>` tool
  // cannot drift from its entry — adding an action there is enough to offer it here too.
  ...Object.entries(ACTION_REGISTRY).map(([name, def]) =>
    define(`propose_${name}`, def.description, def.argsSchema, Option.some(def.permission)),
  ),
];

/**
 * The UX half of the two-layer permission check (plan §8): tools the caller
 * cannot use are omitted from the array sent to the model, so the model
 * never learns they exist. Each executor in `readTools.ts` re-checks the
 * same gate independently — THAT is the boundary, not this filter.
 */
export const visibleTools = (ctx: ToolContext): ReadonlyArray<LlmToolDefinition> =>
  ALL_TOOLS.filter((tool) =>
    Option.match(tool.requiredPermission, {
      onNone: () => true,
      onSome: (permission) => hasPermission(ctx.membership, permission),
    }),
  ).map(({ name, description, parameters }) => ({ name, description, parameters }));
