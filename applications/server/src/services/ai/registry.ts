/**
 * The tool registry — plan `.work-plans/ai-app-interaction.md` §8 / §13.3.
 *
 * `ALL_TOOLS` is the single catalogue of the six read tools: name,
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
import { Event, type Role } from '@sideline/domain';
import { Option, Schema } from 'effect';
import { hasPermission } from '~/api/permissions.js';
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
