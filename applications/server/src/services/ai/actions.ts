/**
 * The AI write path's action registry — plan `.work-plans/ai-app-interaction.md` §3/§16.
 *
 * `ActionDefinition` is a CLOSED existential — no type parameters. `ActionDefinition<Args extends
 * Schema.Top, Payload extends Schema.Top>` does not compile: `Schema.Top['Type']` is `unknown`
 * (`Top extends Bottom<unknown, unknown, …>`), so under `strictFunctionTypes` a
 * `(payload: CreateEventPayload) => …`-shaped member is not assignable to the generic member's
 * `(payload: unknown) => …` shape, and the `as never` that would silence that error would also
 * let `propose`/`confirm` drift from their own schema on both sides — precisely what the closed,
 * per-entry-concrete design exists to prevent. Each registry entry decodes with its own concrete
 * schema INSIDE its own closure; `propose`/`confirm` meet the outside world at `string` (the
 * persisted, opaque payload JSON), which is concrete and needs no cast. `Record<AiActionName,
 * ActionDefinition>` is genuinely exhaustive — adding a literal to `AiActionName` is a compile
 * error here until this record grows a matching entry.
 *
 * `payloadSchema`/`renderSummary` are deliberately NOT registry members — the summary is built
 * once, in `propose`, and ships in the same chat response; `confirm` never re-renders it, and
 * nothing persists card state across a reload, so nothing ever needs to re-derive a summary from
 * a stored payload.
 */
import {
  type AiActionProposal,
  AiChatApi,
  Event,
  type EventApi,
  GroupModel,
  type Role,
  type Team,
  TrainingType,
} from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { DateTime, Effect, Option, type Result, Schema, type ServiceMap } from 'effect';
import type { EventRow, EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import type { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import type { ToolContext } from '~/services/ai/toolTypes.js';
import { createEventForMemberTx, resolveEventGroups } from '~/services/EventCreation.js';

// ---------------------------------------------------------------------------
// `create_event`'s args schema — plan §3.
// ---------------------------------------------------------------------------

const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 2000;
const LOCATION_MAX_LENGTH = 200;

const DateOnly = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  // Regex alone accepts 2025-02-30, and `DateTime.makeUnsafe` would then DIE on it.
  Schema.check(
    Schema.makeFilter<string>(
      (s) =>
        new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s || 'not a real calendar date',
    ),
  ),
);

// This probes as a bare `{"type":"string"}` — no format, no pattern, no hint — and there is no
// fixing that here: `Schema.toJsonSchemaDocument` in `effect@4.0.0-beta.40` DROPS a
// `Schema.annotate({ description })` placed on a transform schema (it survives on a leaf one),
// so an annotation would be dead weight that reads as if it works. `DateOnly` above is a leaf
// and therefore keeps its pattern; this one cannot. The format hint lives in the tool
// description instead, which the model reads either way — see `ACTION_REGISTRY.create_event`.
const Instant = Schemas.DateTimeFromIsoString;

const ProposeCreateEventArgsStruct = Schema.Struct({
  title: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(TITLE_MAX_LENGTH)),
  ),
  eventType: Event.EventType,
  trainingTypeId: Schema.optionalKey(TrainingType.TrainingTypeId),
  description: Schema.optionalKey(
    Schema.String.pipe(Schema.check(Schema.isMaxLength(DESCRIPTION_MAX_LENGTH))),
  ),
  allDay: Schema.optionalKey(Schema.Boolean),
  // Timed only.
  startAt: Schema.optionalKey(Instant),
  endAt: Schema.optionalKey(Instant),
  // All-day only — team-local `YYYY-MM-DD`, never parsed into a `Date` client-side.
  startDate: Schema.optionalKey(DateOnly),
  endDate: Schema.optionalKey(DateOnly),
  location: Schema.optionalKey(
    Schema.String.pipe(Schema.check(Schema.isMaxLength(LOCATION_MAX_LENGTH))),
  ),
  ownerGroupId: Schema.optionalKey(GroupModel.GroupId),
  memberGroupId: Schema.optionalKey(GroupModel.GroupId),
  // Deliberately no `locationUrl`, no `imageUrl`, no `teamId` — `registry.ts` forbids `teamId` on
  // any tool schema, and the `EventLocationUrl` SSRF guard does not apply to a field the tool
  // schema never accepts.
});

type ProposeCreateEventArgsDecoded = Schema.Schema.Type<typeof ProposeCreateEventArgsStruct>;

/**
 * Root filter (plan §3): `allDay === true` implies `startDate` present, `startAt`/`endAt`
 * absent, and `endDate >= startDate` if present (lexicographic is correct for `YYYY-MM-DD`).
 * `allDay !== true` implies `startAt` present, `startDate`/`endDate` absent, and `endAt >=
 * startAt` if present.
 */
const validateProposeCreateEventArgs = (args: ProposeCreateEventArgsDecoded): boolean | string => {
  const allDay = args.allDay ?? false;
  if (allDay) {
    if (args.startDate === undefined) return 'startDate is required when allDay is true';
    if (args.startAt !== undefined || args.endAt !== undefined) {
      return 'startAt/endAt must not be set when allDay is true';
    }
    if (args.endDate !== undefined && args.endDate < args.startDate) {
      return 'endDate must not be before startDate';
    }
    return true;
  }
  if (args.startAt === undefined) return 'startAt is required unless allDay is true';
  if (args.startDate !== undefined || args.endDate !== undefined) {
    return 'startDate/endDate must not be set unless allDay is true';
  }
  if (args.endAt !== undefined && DateTime.isLessThan(args.endAt, args.startAt)) {
    return 'endAt must not be before startAt';
  }
  return true;
};

export const ProposeCreateEventArgs = ProposeCreateEventArgsStruct.pipe(
  Schema.check(Schema.makeFilter(validateProposeCreateEventArgs)),
);
export type ProposeCreateEventArgs = Schema.Schema.Type<typeof ProposeCreateEventArgs>;

// ---------------------------------------------------------------------------
// `toCreateEventRequest` — blocker 1: the all-day wire convention.
// ---------------------------------------------------------------------------

/** Guaranteed present by `validateProposeCreateEventArgs` — a throw here means that filter has a
 * bug, not that the caller can retry into a different outcome. */
const requireField = <A>(value: A | undefined, label: string): A => {
  if (value === undefined) {
    throw new Error(`create_event: ${label} missing after schema validation — invariant violated`);
  }
  return value;
};

/**
 * A date-only `YYYY-MM-DD` crosses the wire at noon UTC, exactly like the web's own all-day
 * convention (`applications/web/src/lib/datetime.ts`) — `anchorAllDay`
 * (`applications/server/src/api/event.ts`) re-anchors it to the team's local midnight by reading
 * the instant's UTC calendar date. Converting a team-local midnight to UTC FIRST would shift the
 * date for every non-zero offset; noon-UTC is offset-proof both east and west of UTC.
 */
const dateOnlyToUtcNoon = (d: string): DateTime.Utc => DateTime.makeUnsafe(`${d}T12:00:00Z`);

export const toCreateEventRequest = (args: ProposeCreateEventArgs): EventApi.CreateEventRequest => {
  const allDay = args.allDay ?? false;
  return {
    title: args.title,
    // `CreateEventRequest` now takes the kind as an Option alongside an optional
    // `eventTypeId` (the per-team `event_types` row). The tool deliberately accepts only the
    // kind: the model picking a team's custom type row is a separate decision, and the
    // `events_sync_event_type` trigger resolves the kind to that team's row for us anyway.
    eventType: Option.some(args.eventType),
    eventTypeId: Option.none(),
    trainingTypeId: Option.fromUndefinedOr(args.trainingTypeId),
    description: Option.fromUndefinedOr(args.description),
    imageUrl: Option.none(),
    startAt: allDay
      ? dateOnlyToUtcNoon(requireField(args.startDate, 'startDate'))
      : requireField(args.startAt, 'startAt'),
    endAt: allDay
      ? Option.map(Option.fromUndefinedOr(args.endDate), dateOnlyToUtcNoon)
      : Option.fromUndefinedOr(args.endAt),
    allDay,
    location: Option.fromUndefinedOr(args.location),
    locationUrl: Option.none(),
    ownerGroupId: Option.fromUndefinedOr(args.ownerGroupId),
    memberGroupId: Option.fromUndefinedOr(args.memberGroupId),
  };
};

// ---------------------------------------------------------------------------
// `buildCreateEventSummary` — always all nine `ProposalFieldKey`s, fixed order.
// ---------------------------------------------------------------------------

const noneField = (key: AiChatApi.ProposalFieldKey): AiChatApi.ProposalField =>
  new AiChatApi.ProposalField({ key, value: { type: 'none' } });

const textField = (key: AiChatApi.ProposalFieldKey, value: string): AiChatApi.ProposalField =>
  new AiChatApi.ProposalField({ key, value: { type: 'text', value } });

const optionalTextField = (
  key: AiChatApi.ProposalFieldKey,
  value: Option.Option<string>,
): AiChatApi.ProposalField =>
  Option.match(value, { onNone: () => noneField(key), onSome: (v) => textField(key, v) });

export interface ResolvedCreateEventNames {
  readonly trainingTypeName: Option.Option<string>;
  readonly ownerGroupName: Option.Option<string>;
  readonly memberGroupName: Option.Option<string>;
}

/**
 * Every field the action writes is emitted, every time — `{ type: 'none' }` when absent, never
 * skipped. `start`/`end` carry `{ type: 'date' }` when all-day and `{ type: 'instant' }` when
 * timed — that IS the all-day signal on the wire; there is no `allDay` key in the summary.
 */
export const buildCreateEventSummary = (
  args: ProposeCreateEventArgs,
  resolved: ResolvedCreateEventNames,
): ReadonlyArray<AiChatApi.ProposalField> => {
  const allDay = args.allDay ?? false;
  const start = allDay
    ? new AiChatApi.ProposalField({
        key: 'start',
        value: { type: 'date', value: requireField(args.startDate, 'startDate') },
      })
    : new AiChatApi.ProposalField({
        key: 'start',
        value: { type: 'instant', value: requireField(args.startAt, 'startAt') },
      });
  const end = allDay
    ? args.endDate === undefined
      ? noneField('end')
      : new AiChatApi.ProposalField({ key: 'end', value: { type: 'date', value: args.endDate } })
    : args.endAt === undefined
      ? noneField('end')
      : new AiChatApi.ProposalField({ key: 'end', value: { type: 'instant', value: args.endAt } });

  return [
    textField('title', args.title),
    new AiChatApi.ProposalField({
      key: 'eventType',
      value: { type: 'eventType', value: args.eventType },
    }),
    start,
    end,
    optionalTextField('trainingType', resolved.trainingTypeName),
    optionalTextField('ownerGroup', resolved.ownerGroupName),
    optionalTextField('memberGroup', resolved.memberGroupName),
    optionalTextField('location', Option.fromUndefinedOr(args.location)),
    optionalTextField('description', Option.fromUndefinedOr(args.description)),
  ];
};

// ---------------------------------------------------------------------------
// `create_event.propose` — decode, validate every referenced id in-team, resolve inheritance +
// display names, render the summary, hand back the encoded payload. `E = never`, `Result<…,
// string>` carries the failure instead (plan §3).
// ---------------------------------------------------------------------------

type TrainingTypeForGroups = {
  readonly team_id: Team.TeamId;
  readonly name: string;
  readonly owner_group_id: Option.Option<GroupModel.GroupId>;
  readonly member_group_id: Option.Option<GroupModel.GroupId>;
};

/** A foreign id and a nonexistent id get the IDENTICAL failure message (plan §3) — never
 * distinguish "not found" from "not yours", which would confirm existence. */
const validateGroupId = (
  groups: ServiceMap.Service.Shape<typeof GroupsRepository>,
  teamId: Team.TeamId,
  fieldName: string,
  id: Option.Option<GroupModel.GroupId>,
): Effect.Effect<Option.Option<string>, string> =>
  Option.match(id, {
    onNone: (): Effect.Effect<Option.Option<string>, string> => Effect.succeed(Option.none()),
    onSome: (groupId): Effect.Effect<Option.Option<string>, string> =>
      groups
        .findGroupById(groupId)
        .pipe(
          Effect.flatMap((found) =>
            Option.isNone(found) || found.value.team_id !== teamId
              ? Effect.fail(`${fieldName}: no such group in this team`)
              : Effect.succeed(Option.some(found.value.name)),
          ),
        ),
  });

/** Display-name-only lookup for a group id that was already validated (or inherited from an
 * already-validated training type) — never fails; a not-found here would only mean the row was
 * deleted between validation and rendering, in which case the field simply renders unset. */
const lookupGroupName = (
  groups: ServiceMap.Service.Shape<typeof GroupsRepository>,
  id: Option.Option<GroupModel.GroupId>,
): Effect.Effect<Option.Option<string>> =>
  Option.match(id, {
    onNone: (): Effect.Effect<Option.Option<string>> => Effect.succeed(Option.none()),
    onSome: (groupId): Effect.Effect<Option.Option<string>> =>
      groups
        .findGroupById(groupId)
        .pipe(Effect.map((found) => Option.flatMap(found, (g) => Option.some(g.name)))),
  });

const findTrainingTypeInTeam = (
  trainingTypes: ServiceMap.Service.Shape<typeof TrainingTypesRepository>,
  teamId: Team.TeamId,
  id: Option.Option<TrainingType.TrainingTypeId>,
): Effect.Effect<Option.Option<TrainingTypeForGroups>, string> =>
  Option.match(id, {
    onNone: (): Effect.Effect<Option.Option<TrainingTypeForGroups>, string> =>
      Effect.succeed(Option.none()),
    onSome: (trainingTypeId): Effect.Effect<Option.Option<TrainingTypeForGroups>, string> =>
      trainingTypes
        .findTrainingTypeById(trainingTypeId)
        .pipe(
          Effect.flatMap((found) =>
            Option.isNone(found) || found.value.team_id !== teamId
              ? Effect.fail('trainingTypeId: no such training type in this team')
              : Effect.succeed(Option.some(found.value)),
          ),
        ),
  });

const proposeCreateEvent = (
  rawArgs: unknown,
  ctx: ToolContext,
): Effect.Effect<
  Result.Result<
    { readonly payloadJson: string; readonly summary: ReadonlyArray<AiChatApi.ProposalField> },
    string
  >,
  never,
  GroupsRepository | TrainingTypesRepository
> =>
  Effect.Do.pipe(
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('trainingTypes', () => TrainingTypesRepository.asEffect()),
    Effect.bind('args', () =>
      Schema.decodeUnknownEffect(ProposeCreateEventArgs)(rawArgs).pipe(
        Effect.mapError((e) => (Schema.isSchemaError(e) ? e.message : String(e))),
      ),
    ),
    Effect.bind('trainingTypeRow', ({ args, trainingTypes }) =>
      findTrainingTypeInTeam(
        trainingTypes,
        ctx.teamId,
        Option.fromUndefinedOr(args.trainingTypeId),
      ),
    ),
    Effect.bind('explicitOwnerGroupName', ({ args, groups }) =>
      validateGroupId(
        groups,
        ctx.teamId,
        'ownerGroupId',
        Option.fromUndefinedOr(args.ownerGroupId),
      ),
    ),
    Effect.bind('explicitMemberGroupName', ({ args, groups }) =>
      validateGroupId(
        groups,
        ctx.teamId,
        'memberGroupId',
        Option.fromUndefinedOr(args.memberGroupId),
      ),
    ),
    Effect.let('resolvedGroups', ({ args, trainingTypeRow }) =>
      resolveEventGroups({
        payloadOwnerGroupId: Option.fromUndefinedOr(args.ownerGroupId),
        payloadMemberGroupId: Option.fromUndefinedOr(args.memberGroupId),
        trainingType: trainingTypeRow,
      }),
    ),
    // amendment 6: the inheritance path needs the NAMES of the resolved groups too — two more
    // `groups.findGroupById` calls validation never made, paid only when resolution actually
    // came from the training type.
    Effect.bind('ownerGroupName', ({ args, groups, resolvedGroups, explicitOwnerGroupName }) =>
      args.ownerGroupId !== undefined
        ? Effect.succeed(explicitOwnerGroupName)
        : lookupGroupName(groups, resolvedGroups.ownerGroupId),
    ),
    Effect.bind('memberGroupName', ({ args, groups, resolvedGroups, explicitMemberGroupName }) =>
      args.memberGroupId !== undefined
        ? Effect.succeed(explicitMemberGroupName)
        : lookupGroupName(groups, resolvedGroups.memberGroupId),
    ),
    Effect.let('trainingTypeName', ({ trainingTypeRow }) =>
      Option.map(trainingTypeRow, (tt) => tt.name),
    ),
    Effect.let('summary', ({ args, trainingTypeName, ownerGroupName, memberGroupName }) =>
      buildCreateEventSummary(args, { trainingTypeName, ownerGroupName, memberGroupName }),
    ),
    Effect.let('payloadJson', ({ args }) =>
      JSON.stringify(Schema.encodeSync(ProposeCreateEventArgs)(args)),
    ),
    Effect.map(({ payloadJson, summary }) => ({ payloadJson, summary })),
    Effect.result,
  );

// ---------------------------------------------------------------------------
// `create_event.confirm` — runs INSIDE the caller's transaction.
// ---------------------------------------------------------------------------

const confirmCreateEvent = (
  payloadJson: string,
  ctx: { readonly teamId: Team.TeamId; readonly membership: MembershipWithRole },
): Effect.Effect<
  EventRow,
  EventApi.Forbidden | AiChatApi.AiProposalNotFound,
  EventsRepository | GroupsRepository | TrainingTypesRepository | TeamSettingsRepository
> =>
  Effect.try({ try: () => JSON.parse(payloadJson) as unknown, catch: (e) => e }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ProposeCreateEventArgs)),
    // Only realistic cause: the payload schema changed mid-deploy inside the 15-minute window.
    // A 404 + logged error beats a 500 — the transaction rolls back and the row just expires.
    Effect.catchCause((cause) =>
      Effect.logError('ai proposal payload undecodable', cause).pipe(
        Effect.andThen(Effect.fail(new AiChatApi.AiProposalNotFound())),
      ),
    ),
    Effect.flatMap((args) =>
      createEventForMemberTx({
        teamId: ctx.teamId,
        membership: ctx.membership,
        payload: toCreateEventRequest(args),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

export interface ActionDefinition {
  readonly permission: Role.Permission;
  readonly description: string;
  /** For `toToolParameters` ONLY — never decoded with its `Type`. */
  readonly argsSchema: Schema.Top;
  /** Propose-time: decode, validate every referenced id in team, resolve inheritance + names,
   *  render the summary, hand back the encoded payload. */
  readonly propose: (
    rawArgs: unknown,
    ctx: ToolContext,
  ) => Effect.Effect<
    Result.Result<
      { readonly payloadJson: string; readonly summary: ReadonlyArray<AiChatApi.ProposalField> },
      string
    >,
    never,
    GroupsRepository | TrainingTypesRepository
  >;
  /** Confirm-time. Runs INSIDE the caller's transaction — must not swallow a cause. Returns the
   *  RAW ROW, not a view model: `emitEventCreatedSideEffects` needs `owner_group_id`, which
   *  `EventApi.EventInfo` does not carry. */
  readonly confirm: (
    payloadJson: string,
    ctx: { readonly teamId: Team.TeamId; readonly membership: MembershipWithRole },
  ) => Effect.Effect<
    EventRow,
    EventApi.Forbidden | AiChatApi.AiProposalNotFound,
    EventsRepository | GroupsRepository | TrainingTypesRepository | TeamSettingsRepository
  >;
}

export const ACTION_REGISTRY: Record<AiActionProposal.AiActionName, ActionDefinition> = {
  create_event: {
    permission: 'event:create',
    description:
      'Proposes creating a new event (training, match, tournament, meeting or social). This ' +
      'does NOT create anything by itself — it stages the write and returns a card the user ' +
      'must confirm. For a timed event set `startAt` (and optionally `endAt`) as an ISO-8601 ' +
      'instant with offset, e.g. `2026-05-12T17:00:00Z`; for an all-day event set ' +
      '`allDay: true` and `startDate` (and optionally `endDate`) as a team-local `YYYY-MM-DD`. ' +
      'Only one may be proposed per reply.',
    argsSchema: ProposeCreateEventArgs,
    propose: proposeCreateEvent,
    confirm: confirmCreateEvent,
  },
};
