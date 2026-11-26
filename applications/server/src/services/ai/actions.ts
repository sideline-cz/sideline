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
 * Actions: `create_event`; `update_event`, `cancel_event` and `mark_attendance`, whose guards
 * live in `services/EventWrites.ts` next to the HTTP handlers'; `set_my_rsvp`, the caller's own
 * RSVP only (`services/RsvpWrites.ts`); six group and roster actions
 * (`services/GroupRosterWrites.ts`), which queue a Discord sync event; three finance actions
 * (`record_payment`, `create_expense`, `assign_membership_plan`, `services/FinanceWrites.ts`); and three Discord actions that only QUEUE a change for the bot
 * (`create_discord_channel`, `set_discord_channel_access`, `archive_discord_channel`). The
 * Discord tools take NAMES, not ids: no read tool gives the model a channel or group id.
 *
 * `payloadSchema`/`renderSummary` are deliberately NOT registry members — the summary is built
 * once, in `propose`, and ships in the same chat response; `confirm` never re-renders it, and
 * nothing persists card state across a reload, so nothing ever needs to re-derive a summary from
 * a stored payload.
 */
import {
  type AiActionProposal,
  AiChatApi,
  type Discord,
  DisplayName,
  Event,
  type EventApi,
  type EventAttendanceApi,
  EventRsvp,
  Expense,
  Fee,
  FeeAssignment,
  GroupModel,
  MembershipPlan,
  Payment,
  type Role,
  RosterModel,
  type Team,
  TeamChannel,
  type TeamChannelAccess,
  TeamMember,
  TrainingType,
} from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { DateTime, Effect, Option, Result, Schema, type ServiceMap } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import type { BankTransactionsRepository } from '~/repositories/BankTransactionsRepository.js';
import type { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import type { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { EventAttendanceRepository } from '~/repositories/EventAttendanceRepository.js';
import type { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import type {
  EventRow,
  EventsRepository,
  EventWithDetails,
} from '~/repositories/EventsRepository.js';
import type { ExpensesRepository } from '~/repositories/ExpensesRepository.js';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { MembershipPlansRepository } from '~/repositories/MembershipPlansRepository.js';
import type { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { TeamChannelAccessRepository } from '~/repositories/TeamChannelAccessRepository.js';
import { TeamChannelsRepository } from '~/repositories/TeamChannelsRepository.js';
import {
  type MembershipWithRole,
  TeamMembersRepository,
} from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import type { UsersRepository } from '~/repositories/UsersRepository.js';
import { type ToolContext, UUID_PATTERN } from '~/services/ai/toolTypes.js';
import { createEventForMemberTx, resolveEventGroups } from '~/services/EventCreation.js';
import {
  cancelEventForMemberTx,
  checkAttendanceConfirmable,
  checkEventCancellable,
  checkEventUpdatable,
  confirmAttendanceForMember,
  updateEventForMemberTx,
} from '~/services/EventWrites.js';
import {
  assignMembershipPlanForMemberTx,
  createExpenseForMemberTx,
  recordPaymentForMemberTx,
} from '~/services/FinanceWrites.js';
import {
  addGroupMemberForMemberTx,
  addRosterMemberForMemberTx,
  createGroupForMemberTx,
  createRosterForMemberTx,
  removeGroupMemberForMemberTx,
  removeRosterMemberForMemberTx,
} from '~/services/GroupRosterWrites.js';
import {
  archiveManagedChannelTx,
  createManagedChannel,
  setManagedChannelAccessTx,
} from '~/services/ManagedChannels.js';
import { checkRsvpSubmittable, submitRsvpTx } from '~/services/RsvpWrites.js';
import { applyDiscordFormat, DEFAULT_CHANNEL_FORMAT } from '~/utils/applyDiscordFormat.js';

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
// `buildCreateEventSummary` — the nine event `ProposalFieldKey`s, fixed order.
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

/** Decodes a stored payload. Only realistic failure: the payload schema changed mid-deploy
 *  inside the 15-minute window. A 404 + logged error beats a 500 — the transaction rolls back
 *  and the row just expires. */
const decodeStoredPayload = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  payloadJson: string,
): Effect.Effect<S['Type'], AiChatApi.AiProposalNotFound> =>
  Effect.try({ try: (): unknown => JSON.parse(payloadJson), catch: (e) => e }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.catchCause((cause) =>
      Effect.logError('ai proposal payload undecodable', cause).pipe(
        Effect.andThen(Effect.fail(new AiChatApi.AiProposalNotFound())),
      ),
    ),
  );

const confirmCreateEvent = (
  payloadJson: string,
  ctx: { readonly teamId: Team.TeamId; readonly membership: MembershipWithRole },
): Effect.Effect<
  ConfirmResult,
  EventApi.Forbidden | AiChatApi.AiProposalNotFound,
  EventsRepository | GroupsRepository | TrainingTypesRepository | TeamSettingsRepository
> =>
  decodeStoredPayload(ProposeCreateEventArgs, payloadJson).pipe(
    Effect.flatMap((args) =>
      createEventForMemberTx({
        teamId: ctx.teamId,
        membership: ctx.membership,
        payload: toCreateEventRequest(args),
      }),
    ),
    Effect.map((event): ConfirmResult => ({ kind: 'event_created', event })),
  );

// ---------------------------------------------------------------------------
// The three Discord actions. Propose writes nothing; confirm only QUEUES a sync event for the
// bot. Every refusal is a `string` failure (the model sees `invalid_arguments`); every state
// drift at confirm is `AiProposalNotFound` (`stale`), so the transaction rolls back unclaimed.
// ---------------------------------------------------------------------------

const DISCORD_NAME_MAX_LENGTH = 100;

const NameParam = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(DISCORD_NAME_MAX_LENGTH)),
);

const decodeArgs = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  rawArgs: unknown,
): Effect.Effect<S['Type'], string> =>
  Schema.decodeUnknownEffect(schema)(rawArgs).pipe(
    Effect.mapError((e) => (Schema.isSchemaError(e) ? e.message : String(e))),
  );

const stale = (reason: string): Effect.Effect<never, AiChatApi.AiProposalNotFound> =>
  Effect.logWarning('ai proposal stale at confirm', reason).pipe(
    Effect.andThen(Effect.fail(new AiChatApi.AiProposalNotFound())),
  );

const someOr = <A, E>(option: Option.Option<A>, onNone: () => Effect.Effect<never, E>) =>
  Option.match(option, {
    onNone,
    onSome: (a): Effect.Effect<A, E> => Effect.succeed(a),
  });

/** Exact (case-sensitive) match first; only when there is none, a case-insensitive one. Both
 *  unique indexes are case-sensitive, so "U12" and "u12" can both exist: the exact step keeps
 *  each one reachable. */
export const matchByName = <T extends { readonly name: string }>(
  rows: ReadonlyArray<T>,
  name: string,
): ReadonlyArray<T> => {
  const exact = rows.filter((r) => r.name === name);
  return exact.length > 0 ? exact : rows.filter((r) => r.name.toLowerCase() === name.toLowerCase());
};

const exactlyOne = <T>(
  matches: ReadonlyArray<T>,
  noneMessage: string,
  severalMessage: string,
): Effect.Effect<T, string> => {
  const [only, ...rest] = matches;
  if (only === undefined) return Effect.fail(noneMessage);
  return rest.length > 0 ? Effect.fail(severalMessage) : Effect.succeed(only);
};

const resolveActiveManagedChannel = (teamId: Team.TeamId, name: string) =>
  TeamChannelsRepository.asEffect().pipe(
    Effect.flatMap((channels) => channels.findAllByTeam(teamId)),
    Effect.flatMap((rows) =>
      exactlyOne(
        matchByName(
          rows.filter((r) => !r.archived),
          name,
        ),
        'channel: no active Sideline-managed channel with that name',
        'channel: several channels match that name; ask the user which one they mean',
      ),
    ),
  );

const resolveGroupByName = (teamId: Team.TeamId, name: string) =>
  GroupsRepository.asEffect().pipe(
    Effect.flatMap((groups) => groups.findGroupsByTeamId(teamId)),
    Effect.flatMap((rows) =>
      exactlyOne(
        matchByName(rows, name),
        'group: no active group with that name',
        'group: several groups match that name; ask the user which one they mean',
      ),
    ),
  );

/** The team's archive category, only when it still exists in the Discord mirror as a category.
 *  Without one the bot cannot move the channel: with no category the HTTP path queues nothing,
 *  and with a deleted one the bot falls back to DELETING the channel. */
const resolveArchiveCategory = (
  teamId: Team.TeamId,
): Effect.Effect<
  { readonly id: Discord.Snowflake; readonly name: string },
  string,
  TeamSettingsRepository | TeamsRepository | DiscordChannelsRepository
> =>
  Effect.Do.pipe(
    Effect.bind('settings', () =>
      TeamSettingsRepository.asEffect().pipe(Effect.flatMap((r) => r.findByTeamId(teamId))),
    ),
    Effect.bind('categoryId', ({ settings }) =>
      someOr(
        Option.flatMap(settings, (s) => s.discord_archive_category_id),
        () =>
          Effect.fail(
            'archive: no archive category is set for this team; tell the user to set one in Team settings',
          ),
      ),
    ),
    Effect.bind('team', () =>
      TeamsRepository.asEffect().pipe(Effect.flatMap((r) => r.findById(teamId))),
    ),
    Effect.bind('category', ({ team, categoryId }) =>
      Option.match(team, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: (t) =>
          DiscordChannelsRepository.asEffect().pipe(
            Effect.flatMap((r) => r.findByChannelId(t.guild_id, categoryId)),
          ),
      }),
    ),
    Effect.flatMap(({ category }) =>
      someOr(
        Option.filter(category, (c) => c.type === 4),
        () =>
          Effect.fail(
            'archive: the archive category no longer exists in Discord; tell the user to set a new one in Team settings',
          ),
      ),
    ),
    Effect.map((category) => ({ id: category.channel_id, name: category.name })),
  );

/** The channel row by stored id, only while it is still in the team and active. */
const findActiveChannelForConfirm = (
  teamId: Team.TeamId,
  teamChannelId: TeamChannel.TeamChannelId,
) =>
  TeamChannelsRepository.asEffect().pipe(
    Effect.flatMap((channels) => channels.findById(teamChannelId)),
    Effect.flatMap((found) =>
      someOr(
        Option.filter(found, (c) => c.team_id === teamId && !c.archived),
        () => stale('channel gone, moved or archived'),
      ),
    ),
  );

const accessLevelField = (
  key: AiChatApi.ProposalFieldKey,
  value: AiChatApi.ProposalAccessLevel,
): AiChatApi.ProposalField =>
  new AiChatApi.ProposalField({ key, value: { type: 'accessLevel', value } });

// --- create_discord_channel ------------------------------------------------

// No `category`: the bot creates the channel with no Discord parent, and
// `team_channels.category` is a Sideline-only label — a "Category" row would be a false claim.
const CreateDiscordChannelArgs = Schema.Struct({
  name: NameParam,
  emoji: Schema.optionalKey(
    Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(32))),
  ),
});

// Case-insensitive on purpose: stricter than the unique index. Propose and confirm share it.
const isNameTaken = (
  existing: ReadonlyArray<{ readonly name: string; readonly archived: boolean }>,
  name: string,
) => existing.some((c) => !c.archived && c.name.toLowerCase() === name.toLowerCase());

const proposeCreateDiscordChannel = (rawArgs: unknown, ctx: ToolContext) =>
  Effect.Do.pipe(
    Effect.bind('args', () => decodeArgs(CreateDiscordChannelArgs, rawArgs)),
    Effect.bind('existing', () =>
      TeamChannelsRepository.asEffect().pipe(
        Effect.flatMap((channels) => channels.findAllByTeam(ctx.teamId)),
      ),
    ),
    Effect.tap(({ args, existing }) =>
      isNameTaken(existing, args.name)
        ? Effect.fail('name: a channel with that name already exists')
        : Effect.void,
    ),
    Effect.bind('settings', () =>
      TeamSettingsRepository.asEffect().pipe(Effect.flatMap((r) => r.findByTeamId(ctx.teamId))),
    ),
    // Same inputs as the HTTP `createChannel`, so the preview is the name the bot will use.
    Effect.let('discordName', ({ args, settings }) =>
      applyDiscordFormat(
        Option.match(settings, {
          onNone: () => DEFAULT_CHANNEL_FORMAT,
          onSome: (s) => s.discord_channel_format,
        }),
        args.name,
        Option.fromUndefinedOr(args.emoji),
      ),
    ),
    Effect.tap(({ discordName }) =>
      discordName.length > DISCORD_NAME_MAX_LENGTH
        ? Effect.fail(
            'name: the Discord name would be longer than 100 characters; use a shorter name or no emoji',
          )
        : Effect.void,
    ),
    Effect.map(({ args, discordName }) => ({
      payloadJson: JSON.stringify(Schema.encodeSync(CreateDiscordChannelArgs)(args)),
      summary: [
        textField('channel', args.name),
        optionalTextField('emoji', Option.fromUndefinedOr(args.emoji)),
        textField('discordName', discordName),
      ],
    })),
    Effect.result,
  );

const confirmCreateDiscordChannel = (payloadJson: string, ctx: { readonly teamId: Team.TeamId }) =>
  decodeStoredPayload(CreateDiscordChannelArgs, payloadJson).pipe(
    Effect.tap((args) =>
      TeamChannelsRepository.asEffect().pipe(
        Effect.flatMap((channels) => channels.findAllByTeam(ctx.teamId)),
        Effect.flatMap((existing) =>
          isNameTaken(existing, args.name) ? stale('name taken') : Effect.void,
        ),
      ),
    ),
    Effect.flatMap((args) =>
      createManagedChannel({
        teamId: ctx.teamId,
        name: args.name,
        category: Option.none(),
        emoji: Option.fromUndefinedOr(args.emoji),
      }),
    ),
    Effect.catchTag('ChannelNameAlreadyTakenError', () => stale('name taken')),
    Effect.as<ConfirmResult>({ kind: 'discord_queued' }),
  );

// --- set_discord_channel_access --------------------------------------------

const SetDiscordChannelAccessArgs = Schema.Struct({
  channel: NameParam,
  group: NameParam,
  access: AiChatApi.ProposalAccessLevel,
});

const SetDiscordChannelAccessPayload = Schema.Struct({
  teamChannelId: TeamChannel.TeamChannelId,
  groupId: GroupModel.GroupId,
  access: AiChatApi.ProposalAccessLevel,
});

const proposeSetDiscordChannelAccess = (rawArgs: unknown, ctx: ToolContext) =>
  Effect.Do.pipe(
    Effect.bind('args', () => decodeArgs(SetDiscordChannelAccessArgs, rawArgs)),
    Effect.bind('channel', ({ args }) => resolveActiveManagedChannel(ctx.teamId, args.channel)),
    Effect.bind('group', ({ args }) => resolveGroupByName(ctx.teamId, args.group)),
    Effect.bind('current', ({ channel, group }) =>
      TeamChannelAccessRepository.asEffect().pipe(
        Effect.flatMap((access) => access.findByChannel(channel.id)),
        Effect.map(
          (grants): AiChatApi.ProposalAccessLevel =>
            grants.find((g) => g.group_id === group.id)?.access_level ?? 'NONE',
        ),
      ),
    ),
    Effect.tap(({ args, current }) =>
      current === args.access
        ? Effect.fail('access: the group already has that access')
        : Effect.void,
    ),
    Effect.map(({ args, channel, group, current }) => ({
      payloadJson: JSON.stringify(
        Schema.encodeSync(SetDiscordChannelAccessPayload)({
          teamChannelId: channel.id,
          groupId: group.id,
          access: args.access,
        }),
      ),
      summary: [
        textField('channel', channel.name),
        textField('group', group.name),
        accessLevelField('currentAccess', current),
        accessLevelField('access', args.access),
      ],
    })),
    Effect.result,
  );

const confirmSetDiscordChannelAccess = (
  payloadJson: string,
  ctx: { readonly teamId: Team.TeamId },
) =>
  Effect.Do.pipe(
    Effect.bind('payload', () => decodeStoredPayload(SetDiscordChannelAccessPayload, payloadJson)),
    Effect.bind('channel', ({ payload }) =>
      findActiveChannelForConfirm(ctx.teamId, payload.teamChannelId),
    ),
    Effect.tap(({ payload }) =>
      GroupsRepository.asEffect().pipe(
        // `findGroupById` already skips archived groups.
        Effect.flatMap((groups) => groups.findGroupById(payload.groupId)),
        Effect.flatMap((found) =>
          someOr(
            Option.filter(found, (g) => g.team_id === ctx.teamId),
            () => stale('group gone or archived'),
          ),
        ),
      ),
    ),
    Effect.flatMap(({ payload: { groupId, access }, channel }) =>
      setManagedChannelAccessTx({
        teamId: ctx.teamId,
        channel,
        toRequested: (current) => {
          const requested = new Map<GroupModel.GroupId, TeamChannelAccess.AccessLevel>(
            current.map((g) => [g.group_id, g.access_level] as const),
          );
          if (access === 'NONE') requested.delete(groupId);
          else requested.set(groupId, access);
          return requested;
        },
      }),
    ),
    Effect.as<ConfirmResult>({ kind: 'discord_queued' }),
  );

// --- archive_discord_channel -----------------------------------------------

const ArchiveDiscordChannelArgs = Schema.Struct({ channel: NameParam });

const ArchiveDiscordChannelPayload = Schema.Struct({ teamChannelId: TeamChannel.TeamChannelId });

const NOT_IN_DISCORD_YET =
  'channel: this channel is not in Discord yet; tell the user to wait until the Sideline bot creates it';

const proposeArchiveDiscordChannel = (rawArgs: unknown, ctx: ToolContext) =>
  Effect.Do.pipe(
    Effect.bind('args', () => decodeArgs(ArchiveDiscordChannelArgs, rawArgs)),
    Effect.bind('channel', ({ args }) => resolveActiveManagedChannel(ctx.teamId, args.channel)),
    // Archiving a channel the bot has not created yet queues a move the bot skips, and the
    // pending create later makes a live channel for an archived row.
    Effect.tap(({ channel }) =>
      Option.isNone(channel.discord_channel_id) ? Effect.fail(NOT_IN_DISCORD_YET) : Effect.void,
    ),
    Effect.bind('category', () => resolveArchiveCategory(ctx.teamId)),
    Effect.map(({ channel, category }) => ({
      payloadJson: JSON.stringify(
        Schema.encodeSync(ArchiveDiscordChannelPayload)({ teamChannelId: channel.id }),
      ),
      summary: [textField('channel', channel.name), textField('archiveCategory', category.name)],
    })),
    Effect.result,
  );

const confirmArchiveDiscordChannel = (payloadJson: string, ctx: { readonly teamId: Team.TeamId }) =>
  Effect.Do.pipe(
    Effect.bind('payload', () => decodeStoredPayload(ArchiveDiscordChannelPayload, payloadJson)),
    Effect.bind('channel', ({ payload }) =>
      findActiveChannelForConfirm(ctx.teamId, payload.teamChannelId),
    ),
    Effect.tap(({ channel }) =>
      Option.isNone(channel.discord_channel_id) ? stale('channel not in Discord') : Effect.void,
    ),
    Effect.bind('category', () =>
      resolveArchiveCategory(ctx.teamId).pipe(Effect.catch((reason) => stale(reason))),
    ),
    Effect.flatMap(({ channel, category }) =>
      archiveManagedChannelTx({
        teamId: ctx.teamId,
        channel,
        archiveCategoryId: Option.some(category.id),
      }),
    ),
    Effect.as<ConfirmResult>({ kind: 'discord_queued' }),
  );

// ---------------------------------------------------------------------------
// The three event actions. Every guard lives in `services/EventWrites.ts`, shared with the HTTP
// handlers: propose runs the guards without the write, confirm runs them again with it.
// ---------------------------------------------------------------------------

const EventIdParam = Event.EventId.pipe(Schema.check(Schema.isPattern(UUID_PATTERN)));

const EVENT_NOT_FOUND = 'eventId: no such event in this team';

/** A propose refusal as the string the model sees. */
const eventRefusal = (
  e:
    | EventApi.Forbidden
    | EventApi.EventNotFound
    | EventApi.EventNotActive
    | EventAttendanceApi.Forbidden
    | EventAttendanceApi.EventNotFound,
): string => {
  switch (e._tag) {
    case 'EventNotFound':
    case 'EventAttendanceEventNotFound':
      return EVENT_NOT_FOUND;
    case 'EventNotActive':
      return 'event: it has started, ended or been cancelled, so it can no longer be changed';
    case 'EventForbidden':
    case 'EventAttendanceForbidden':
      return 'forbidden: the user may not change this event; it belongs to a group or training type they do not manage';
  }
};

/** Confirm-time: a lost permission is a 403, any other drift is `stale`. */
const eventConfirmFailure = (
  e:
    | EventApi.Forbidden
    | EventApi.EventNotFound
    | EventApi.EventNotActive
    | EventAttendanceApi.Forbidden
    | EventAttendanceApi.EventNotFound
    | EventAttendanceApi.AttendanceNotConfirmable,
): Effect.Effect<never, AiChatApi.AiProposalNotFound | AiChatApi.AiProposalActionForbidden> =>
  e._tag === 'EventForbidden' || e._tag === 'EventAttendanceForbidden'
    ? Effect.fail(new AiChatApi.AiProposalActionForbidden())
    : stale(e._tag);

const eventLabel = (e: EventWithDetails): string => `${e.title} (${e.start_date})`;

const eventStartField = (e: EventWithDetails): AiChatApi.ProposalField =>
  new AiChatApi.ProposalField({
    key: 'start',
    value: e.all_day
      ? { type: 'date', value: e.start_date }
      : { type: 'instant', value: e.start_at },
  });

// --- update_event ----------------------------------------------------------

const UpdateEventFields = {
  eventId: EventIdParam,
  title: Schema.optionalKey(ProposeCreateEventArgsStruct.fields.title),
  description: ProposeCreateEventArgsStruct.fields.description,
  location: ProposeCreateEventArgsStruct.fields.location,
  // Timed events only.
  startAt: Schema.optionalKey(Instant),
  endAt: Schema.optionalKey(Instant),
  // All-day events only — team-local `YYYY-MM-DD`.
  startDate: Schema.optionalKey(DateOnly),
  endDate: Schema.optionalKey(DateOnly),
};

const UpdateEventArgsStruct = Schema.Struct(UpdateEventFields);
type UpdateEventArgsDecoded = Schema.Schema.Type<typeof UpdateEventArgsStruct>;

const validateUpdateEventArgs = (a: UpdateEventArgsDecoded): boolean | string => {
  const timed = a.startAt !== undefined || a.endAt !== undefined;
  const dated = a.startDate !== undefined || a.endDate !== undefined;
  if (timed && dated)
    return 'use startAt/endAt for a timed event or startDate/endDate for an all-day one, not both';
  const changes = [a.title, a.description, a.location, a.startAt, a.endAt, a.startDate, a.endDate];
  return changes.some((v) => v !== undefined) || 'nothing to change';
};

export const UpdateEventArgs = UpdateEventArgsStruct.pipe(
  Schema.check(Schema.makeFilter(validateUpdateEventArgs)),
);

// `allDay` is the event's kind AT PROPOSE: the stored instants mean something else for the
// other kind, so confirm refuses if it changed since.
const UpdateEventPayload = Schema.Struct({ ...UpdateEventFields, allDay: Schema.Boolean });

export const toUpdateEventRequest = (a: UpdateEventArgsDecoded): EventApi.UpdateEventRequest => ({
  title: Option.fromUndefinedOr(a.title),
  eventType: Option.none(),
  eventTypeId: Option.none(),
  trainingTypeId: Option.none(),
  description: Option.map(Option.fromUndefinedOr(a.description), Option.some),
  imageUrl: Option.none(),
  // An all-day date crosses as noon UTC, exactly like `create_event` and the web.
  startAt:
    a.startDate !== undefined
      ? Option.some(dateOnlyToUtcNoon(a.startDate))
      : Option.fromUndefinedOr(a.startAt),
  endAt:
    a.endDate !== undefined
      ? Option.some(Option.some(dateOnlyToUtcNoon(a.endDate)))
      : Option.map(Option.fromUndefinedOr(a.endAt), Option.some),
  allDay: Option.none(),
  location: Option.map(Option.fromUndefinedOr(a.location), Option.some),
  locationUrl: Option.none(),
  ownerGroupId: Option.none(),
  memberGroupId: Option.none(),
});

/** The event's start and end after the update, or a refusal when the end would precede it. */
const mergedSchedule = (
  a: UpdateEventArgsDecoded,
  e: EventWithDetails,
): Result.Result<readonly [AiChatApi.ProposalField, AiChatApi.ProposalField], string> => {
  if (e.all_day) {
    const start = a.startDate ?? e.start_date;
    const end =
      a.endDate ?? (a.startDate !== undefined && Option.isNone(e.end_at) ? start : e.end_date);
    return end < start
      ? Result.fail('endDate: the event would end before it starts')
      : Result.succeed([
          new AiChatApi.ProposalField({ key: 'start', value: { type: 'date', value: start } }),
          new AiChatApi.ProposalField({ key: 'end', value: { type: 'date', value: end } }),
        ]);
  }
  const start = a.startAt ?? e.start_at;
  const end = a.endAt !== undefined ? Option.some(a.endAt) : e.end_at;
  return Option.isSome(end) && DateTime.isLessThan(end.value, start)
    ? Result.fail('endAt: the event would end before it starts')
    : Result.succeed([
        new AiChatApi.ProposalField({ key: 'start', value: { type: 'instant', value: start } }),
        Option.match(end, {
          onNone: () => noneField('end'),
          onSome: (v) =>
            new AiChatApi.ProposalField({ key: 'end', value: { type: 'instant', value: v } }),
        }),
      ]);
};

const proposeUpdateEvent = (rawArgs: unknown, ctx: ToolContext) =>
  Effect.Do.pipe(
    Effect.bind('args', () => decodeArgs(UpdateEventArgs, rawArgs)),
    Effect.bind('existing', ({ args }) =>
      checkEventUpdatable({
        teamId: ctx.teamId,
        membership: ctx.membership,
        eventId: args.eventId,
        payload: toUpdateEventRequest(args),
      }).pipe(Effect.mapError(eventRefusal)),
    ),
    Effect.tap(({ args, existing }) =>
      existing.all_day && (args.startAt !== undefined || args.endAt !== undefined)
        ? Effect.fail('startAt/endAt: this is an all-day event; use startDate/endDate')
        : !existing.all_day && (args.startDate !== undefined || args.endDate !== undefined)
          ? Effect.fail('startDate/endDate: this is a timed event; use startAt/endAt')
          : Effect.void,
    ),
    Effect.bind('schedule', ({ args, existing }) =>
      Effect.fromResult(mergedSchedule(args, existing)),
    ),
    Effect.map(({ args, existing, schedule }) => ({
      payloadJson: JSON.stringify(
        Schema.encodeSync(UpdateEventPayload)({ ...args, allDay: existing.all_day }),
      ),
      summary: [
        textField('event', eventLabel(existing)),
        textField('title', args.title ?? existing.title),
        ...schedule,
        optionalTextField(
          'location',
          Option.orElse(Option.fromUndefinedOr(args.location), () => existing.location),
        ),
        optionalTextField(
          'description',
          Option.orElse(Option.fromUndefinedOr(args.description), () => existing.description),
        ),
      ],
    })),
    Effect.result,
  );

const confirmUpdateEvent = (payloadJson: string, ctx: ConfirmContext) =>
  Effect.Do.pipe(
    Effect.bind('payload', () => decodeStoredPayload(UpdateEventPayload, payloadJson)),
    Effect.let('args', ({ payload: { allDay: _allDay, ...args } }) => args),
    Effect.bind('event', ({ payload, args }) =>
      checkEventUpdatable({
        ...ctx,
        eventId: args.eventId,
        payload: toUpdateEventRequest(args),
      }).pipe(
        Effect.tap((existing) =>
          existing.all_day !== payload.allDay ? stale('event switched timed/all-day') : Effect.void,
        ),
        Effect.andThen(
          updateEventForMemberTx({
            ...ctx,
            eventId: args.eventId,
            payload: toUpdateEventRequest(args),
          }),
        ),
      ),
    ),
    Effect.map(({ event }): ConfirmResult => ({ kind: 'event_updated', event })),
    Effect.catchTags({
      EventForbidden: eventConfirmFailure,
      EventNotFound: eventConfirmFailure,
      EventNotActive: eventConfirmFailure,
    }),
  );

// --- cancel_event ----------------------------------------------------------

const CancelEventArgs = Schema.Struct({ eventId: EventIdParam });

const proposeCancelEvent = (rawArgs: unknown, ctx: ToolContext) =>
  Effect.Do.pipe(
    Effect.bind('args', () => decodeArgs(CancelEventArgs, rawArgs)),
    Effect.bind('existing', ({ args }) =>
      checkEventCancellable({
        teamId: ctx.teamId,
        membership: ctx.membership,
        eventId: args.eventId,
      }).pipe(Effect.mapError(eventRefusal)),
    ),
    Effect.map(({ args, existing }) => ({
      payloadJson: JSON.stringify(Schema.encodeSync(CancelEventArgs)(args)),
      summary: [textField('event', existing.title), eventStartField(existing)],
    })),
    Effect.result,
  );

const confirmCancelEvent = (payloadJson: string, ctx: ConfirmContext) =>
  decodeStoredPayload(CancelEventArgs, payloadJson).pipe(
    Effect.flatMap((args) => cancelEventForMemberTx({ ...ctx, eventId: args.eventId })),
    Effect.map((event): ConfirmResult => ({ kind: 'event_cancelled', event })),
    Effect.catchTags({
      EventForbidden: eventConfirmFailure,
      EventNotFound: eventConfirmFailure,
      EventNotActive: eventConfirmFailure,
    }),
  );

// --- mark_attendance -------------------------------------------------------

const NameList = Schema.Array(NameParam).pipe(Schema.check(Schema.isMaxLength(100)));

const MarkAttendanceArgs = Schema.Struct({
  eventId: EventIdParam,
  present: Schema.optionalKey(NameList),
  absent: Schema.optionalKey(NameList),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (a: { readonly present?: ReadonlyArray<string>; readonly absent?: ReadonlyArray<string> }) =>
        (a.present?.length ?? 0) + (a.absent?.length ?? 0) > 0 || 'name at least one member',
    ),
  ),
);

/** The full list, as the attendance page sends it: confirming is all-or-nothing. */
const MarkAttendancePayload = Schema.Struct({
  eventId: Event.EventId,
  entries: Schema.Array(
    Schema.Struct({ teamMemberId: TeamMember.TeamMemberId, present: Schema.Boolean }),
  ),
});

const namesField = (key: AiChatApi.ProposalFieldKey, names: ReadonlyArray<string>) =>
  names.length === 0 ? noneField(key) : textField(key, names.join(', '));

const proposeMarkAttendance = (rawArgs: unknown, ctx: ToolContext) =>
  Effect.Do.pipe(
    Effect.bind('args', () => decodeArgs(MarkAttendanceArgs, rawArgs)),
    Effect.bind('event', ({ args }) =>
      checkAttendanceConfirmable({
        teamId: ctx.teamId,
        membership: ctx.membership,
        eventId: args.eventId,
      }).pipe(Effect.mapError(eventRefusal)),
    ),
    // The same three guards the repository folds into its INSERT.
    Effect.tap(({ event }) =>
      event.event_type !== 'training'
        ? Effect.fail('event: attendance is only taken for trainings')
        : event.status === 'cancelled'
          ? Effect.fail('event: it was cancelled')
          : DateTime.isGreaterThan(event.start_at, DateTime.nowUnsafe())
            ? Effect.fail(
                'event: it has not started yet; attendance can be confirmed once it starts',
              )
            : Effect.void,
    ),
    Effect.bind('rows', ({ args }) =>
      EventAttendanceRepository.asEffect().pipe(
        Effect.flatMap((attendance) => attendance.findAttendanceForEvent(args.eventId)),
        Effect.map((rows) =>
          rows.map((row) => ({
            ...row,
            name: Option.getOrElse(
              DisplayName.pickDisplayName({
                name: row.member_name,
                nickname: row.nickname,
                displayName: row.display_name,
                username: row.username,
              }),
              () => '—',
            ),
          })),
        ),
      ),
    ),
    Effect.bind('marks', ({ args, rows }) =>
      Effect.forEach(
        [
          ...(args.present ?? []).map((name) => [name, true] as const),
          ...(args.absent ?? []).map((name) => [name, false] as const),
        ],
        ([name, present]) =>
          exactlyOne(
            matchByName(rows, name),
            `${name}: no member with that name on this training's attendance list`,
            `${name}: several members match that name; ask the user which one they mean`,
          ).pipe(Effect.map((row) => [row.team_member_id, present] as const)),
      ),
    ),
    Effect.bind('overrides', ({ marks }) => {
      const overrides = new Map<TeamMember.TeamMemberId, boolean>();
      for (const [id, present] of marks) {
        if (overrides.get(id) === !present) {
          return Effect.fail('present/absent: the same member is in both lists');
        }
        overrides.set(id, present);
      }
      return Effect.succeed(overrides);
    }),
    Effect.let('entries', ({ rows, overrides }) =>
      rows.map((row) => ({
        name: row.name,
        teamMemberId: row.team_member_id,
        present: overrides.get(row.team_member_id) ?? row.present,
      })),
    ),
    Effect.map(({ args, event, entries }) => ({
      payloadJson: JSON.stringify(
        Schema.encodeSync(MarkAttendancePayload)({
          eventId: args.eventId,
          entries: entries.map(({ teamMemberId, present }) => ({ teamMemberId, present })),
        }),
      ),
      summary: [
        textField('event', eventLabel(event)),
        namesField(
          'present',
          entries.filter((e) => e.present).map((e) => e.name),
        ),
        namesField(
          'absent',
          entries.filter((e) => !e.present).map((e) => e.name),
        ),
      ],
    })),
    Effect.result,
  );

const confirmMarkAttendance = (payloadJson: string, ctx: ConfirmContext) =>
  decodeStoredPayload(MarkAttendancePayload, payloadJson).pipe(
    Effect.flatMap((payload) => confirmAttendanceForMember({ ...ctx, ...payload })),
    Effect.as<ConfirmResult>({ kind: 'attendance_confirmed' }),
    Effect.catchTags({
      EventAttendanceForbidden: eventConfirmFailure,
      EventAttendanceEventNotFound: eventConfirmFailure,
      EventAttendanceNotConfirmable: eventConfirmFailure,
    }),
  );

// --- set_my_rsvp -------------------------------------------------------------
// The CALLER's own RSVP only — there is no member parameter, so no way to answer for anyone
// else. Every rule (profile completeness, deadline, member group, required note) lives in
// `services/RsvpWrites.ts`, shared with the web `submitRsvp`.

const SetMyRsvpArgs = Schema.Struct({
  eventId: EventIdParam,
  response: EventRsvp.RsvpResponse,
  // Empty string clears the stored note; omitted keeps it — same as the web.
  message: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))),
});
type SetMyRsvpArgs = Schema.Schema.Type<typeof SetMyRsvpArgs>;

const rsvpRefusal = (e: { readonly _tag: string }): string => {
  switch (e._tag) {
    case 'EventRsvpEventNotFound':
      return 'eventId: no such event in this team, or it was cancelled';
    case 'RsvpDeadlinePassed':
      return 'event: RSVPs for this event are closed';
    case 'EventRsvpForbidden':
      return 'event: the user is not invited to this event (it is for a group they are not in)';
    case 'EventRsvpMessageRequired':
      return 'message: this answer needs a note (for "coming later" when they arrive, for "maybe" what it depends on); ask the user for it';
    case 'EventRsvpProfileIncomplete':
      return 'profile: the team requires a complete profile before answering; tell the user to complete their profile';
    default:
      return e._tag;
  }
};

const rsvpArgsFor = (a: SetMyRsvpArgs, ctx: ConfirmContext) => ({
  teamId: ctx.teamId,
  membership: ctx.membership,
  isProfileComplete: ctx.membership.is_profile_complete,
  eventId: a.eventId,
  response: a.response,
  message: Option.fromUndefinedOr(a.message),
});

const proposeSetMyRsvp = (rawArgs: unknown, ctx: ToolContext) =>
  Effect.Do.pipe(
    Effect.bind('args', () => decodeArgs(SetMyRsvpArgs, rawArgs)),
    Effect.bind('checked', ({ args }) =>
      checkRsvpSubmittable(rsvpArgsFor(args, ctx)).pipe(Effect.mapError(rsvpRefusal)),
    ),
    Effect.map(({ args, checked }) => ({
      payloadJson: JSON.stringify(Schema.encodeSync(SetMyRsvpArgs)(args)),
      summary: [
        textField('event', eventLabel(checked.event)),
        new AiChatApi.ProposalField({
          key: 'response',
          value: { type: 'rsvpResponse', value: args.response },
        }),
        // The note the RSVP will carry after the write: the new one, or the kept one.
        optionalTextField(
          'message',
          checked.effectiveClear
            ? checked.note
            : Option.orElse(checked.note, () =>
                Option.flatMap(checked.priorRsvp, (r) => r.message),
              ),
        ),
      ],
    })),
    Effect.result,
  );

const confirmSetMyRsvp = (payloadJson: string, ctx: ConfirmContext) =>
  decodeStoredPayload(SetMyRsvpArgs, payloadJson).pipe(
    Effect.flatMap((args) => submitRsvpTx(rsvpArgsFor(args, ctx))),
    Effect.map((submitted): ConfirmResult => ({ kind: 'rsvp_submitted', submitted })),
    Effect.catchTags({
      EventRsvpForbidden: () => Effect.fail(new AiChatApi.AiProposalActionForbidden()),
      EventRsvpEventNotFound: (e) => stale(e._tag),
      RsvpDeadlinePassed: (e) => stale(e._tag),
      EventRsvpMessageRequired: (e) => stale(e._tag),
      EventRsvpProfileIncomplete: (e) => stale(e._tag),
    }),
  );

// ---------------------------------------------------------------------------
// Group and roster actions. Every write lives in `services/GroupRosterWrites.ts`, shared with the
// HTTP handlers, and queues its Discord sync event in the same transaction — so confirm answers
// `discord_queued`. Tools take names, like the Discord actions; members by the display name
// `list_members` shows.
// ---------------------------------------------------------------------------

const memberDisplayName = (row: {
  readonly name: Option.Option<string>;
  readonly discord_nickname: Option.Option<string>;
  readonly discord_display_name: Option.Option<string>;
  readonly username: string;
}): string =>
  Option.getOrElse(
    DisplayName.pickDisplayName({
      name: row.name,
      nickname: row.discord_nickname,
      displayName: row.discord_display_name,
      username: Option.some(row.username),
    }),
    () => row.username,
  );

/** Inactive members count only for a removal: a deactivated member can still sit in a group. */
const resolveMemberByName = (teamId: Team.TeamId, name: string, includeInactive: boolean) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.flatMap((members) => members.findRosterByTeam(teamId, includeInactive)),
    Effect.map((rows) => rows.map((r) => ({ id: r.member_id, name: memberDisplayName(r) }))),
    Effect.flatMap((rows) =>
      exactlyOne(
        matchByName(rows, name),
        'member: no team member with that name',
        'member: several members match that name; ask the user which one they mean',
      ),
    ),
  );

const resolveRosterByName = (teamId: Team.TeamId, name: string) =>
  RostersRepository.asEffect().pipe(
    Effect.flatMap((rosters) => rosters.findByTeamId(teamId)),
    Effect.flatMap((rows) =>
      exactlyOne(
        matchByName(rows, name),
        'roster: no roster with that name',
        'roster: several rosters match that name; ask the user which one they mean',
      ),
    ),
  );

/** Confirm-time: a lost permission is a 403, any other drift (row gone, name taken) is `stale`. */
const groupRosterConfirmFailure = (e: {
  readonly _tag: string;
}): Effect.Effect<never, AiChatApi.AiProposalNotFound | AiChatApi.AiProposalActionForbidden> =>
  e._tag === 'GroupForbidden' || e._tag === 'Forbidden'
    ? Effect.fail(new AiChatApi.AiProposalActionForbidden())
    : stale(e._tag);

const EmojiParam = Schema.optionalKey(
  Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(32))),
);

const CreateNamedArgs = Schema.Struct({ name: NameParam, emoji: EmojiParam });

const nameTaken = (rows: ReadonlyArray<{ readonly name: string }>, name: string) =>
  rows.some((r) => r.name.toLowerCase() === name.toLowerCase());

// --- create_group ------------------------------------------------------------

const proposeCreateGroup = (rawArgs: unknown, ctx: ToolContext) =>
  Effect.Do.pipe(
    Effect.bind('args', () => decodeArgs(CreateNamedArgs, rawArgs)),
    Effect.tap(({ args }) =>
      GroupsRepository.asEffect().pipe(
        Effect.flatMap((groups) => groups.findGroupsByTeamId(ctx.teamId)),
        Effect.flatMap((rows) =>
          nameTaken(rows, args.name)
            ? Effect.fail('name: a group with that name already exists')
            : Effect.void,
        ),
      ),
    ),
    Effect.map(({ args }) => ({
      payloadJson: JSON.stringify(Schema.encodeSync(CreateNamedArgs)(args)),
      summary: [
        textField('group', args.name),
        optionalTextField('emoji', Option.fromUndefinedOr(args.emoji)),
      ],
    })),
    Effect.result,
  );

const confirmCreateGroup = (payloadJson: string, ctx: ConfirmContext) =>
  decodeStoredPayload(CreateNamedArgs, payloadJson).pipe(
    Effect.flatMap((args) =>
      createGroupForMemberTx({
        ...ctx,
        name: args.name,
        parentId: Option.none(),
        emoji: Option.fromUndefinedOr(args.emoji),
        color: Option.none(),
      }),
    ),
    Effect.as<ConfirmResult>({ kind: 'discord_queued' }),
    Effect.catchTags({
      GroupForbidden: groupRosterConfirmFailure,
      GroupNameAlreadyTaken: groupRosterConfirmFailure,
    }),
  );

// --- add_group_member / remove_group_member ------------------------------------

const GroupMemberArgs = Schema.Struct({ group: NameParam, member: NameParam });

const GroupMemberPayload = Schema.Struct({
  groupId: GroupModel.GroupId,
  memberId: TeamMember.TeamMemberId,
});

const proposeGroupMember = (adding: boolean) => (rawArgs: unknown, ctx: ToolContext) =>
  Effect.Do.pipe(
    Effect.bind('args', () => decodeArgs(GroupMemberArgs, rawArgs)),
    Effect.bind('group', ({ args }) => resolveGroupByName(ctx.teamId, args.group)),
    Effect.bind('member', ({ args }) => resolveMemberByName(ctx.teamId, args.member, !adding)),
    Effect.tap(({ group, member }) =>
      GroupsRepository.asEffect().pipe(
        Effect.flatMap((groups) => groups.findMembersByGroupId(group.id)),
        Effect.flatMap((rows) => {
          const isIn = rows.some((r) => r.member_id === member.id);
          return isIn === adding
            ? Effect.fail(
                adding
                  ? 'member: already in that group'
                  : 'member: not in that group directly (they may be in a subgroup)',
              )
            : Effect.void;
        }),
      ),
    ),
    Effect.map(({ group, member }) => ({
      payloadJson: JSON.stringify(
        Schema.encodeSync(GroupMemberPayload)({ groupId: group.id, memberId: member.id }),
      ),
      summary: [textField('group', group.name), textField('member', member.name)],
    })),
    Effect.result,
  );

const confirmGroupMember = (adding: boolean) => (payloadJson: string, ctx: ConfirmContext) =>
  decodeStoredPayload(GroupMemberPayload, payloadJson).pipe(
    Effect.flatMap((payload) =>
      adding
        ? addGroupMemberForMemberTx({ ...ctx, ...payload })
        : removeGroupMemberForMemberTx({ ...ctx, ...payload }),
    ),
    Effect.as<ConfirmResult>({ kind: 'discord_queued' }),
    Effect.catchTags({
      GroupForbidden: groupRosterConfirmFailure,
      GroupNotFound: groupRosterConfirmFailure,
      GroupMemberNotFound: groupRosterConfirmFailure,
    }),
  );

// --- create_roster -------------------------------------------------------------

const proposeCreateRoster = (rawArgs: unknown, ctx: ToolContext) =>
  Effect.Do.pipe(
    Effect.bind('args', () => decodeArgs(CreateNamedArgs, rawArgs)),
    Effect.tap(({ args }) =>
      RostersRepository.asEffect().pipe(
        Effect.flatMap((rosters) => rosters.findByTeamId(ctx.teamId)),
        Effect.flatMap((rows) =>
          nameTaken(rows, args.name)
            ? Effect.fail('name: a roster with that name already exists')
            : Effect.void,
        ),
      ),
    ),
    Effect.map(({ args }) => ({
      payloadJson: JSON.stringify(Schema.encodeSync(CreateNamedArgs)(args)),
      summary: [
        textField('roster', args.name),
        optionalTextField('emoji', Option.fromUndefinedOr(args.emoji)),
      ],
    })),
    Effect.result,
  );

const confirmCreateRoster = (payloadJson: string, ctx: ConfirmContext) =>
  decodeStoredPayload(CreateNamedArgs, payloadJson).pipe(
    Effect.flatMap((args) =>
      createRosterForMemberTx({
        ...ctx,
        name: args.name,
        color: Option.none(),
        emoji: Option.fromUndefinedOr(args.emoji),
      }),
    ),
    // The team can turn off channel creation for rosters; then nothing is queued.
    Effect.map(
      ({ discordQueued }): ConfirmResult => ({
        kind: discordQueued ? 'discord_queued' : 'applied',
      }),
    ),
    Effect.catchTag('Forbidden', groupRosterConfirmFailure),
  );

// --- add_roster_member / remove_roster_member ----------------------------------

const RosterMemberArgs = Schema.Struct({ roster: NameParam, member: NameParam });

const RosterMemberPayload = Schema.Struct({
  rosterId: RosterModel.RosterId,
  memberId: TeamMember.TeamMemberId,
});

const proposeRosterMember = (adding: boolean) => (rawArgs: unknown, ctx: ToolContext) =>
  Effect.Do.pipe(
    Effect.bind('args', () => decodeArgs(RosterMemberArgs, rawArgs)),
    Effect.bind('roster', ({ args }) => resolveRosterByName(ctx.teamId, args.roster)),
    Effect.bind('member', ({ args }) => resolveMemberByName(ctx.teamId, args.member, !adding)),
    Effect.tap(({ roster, member }) =>
      RostersRepository.asEffect().pipe(
        Effect.flatMap((rosters) => rosters.findMemberEntriesById(roster.id)),
        Effect.flatMap((rows) => {
          const isIn = rows.some((r) => r.member_id === member.id);
          return isIn === adding
            ? Effect.fail(adding ? 'member: already on that roster' : 'member: not on that roster')
            : Effect.void;
        }),
      ),
    ),
    Effect.map(({ roster, member }) => ({
      payloadJson: JSON.stringify(
        Schema.encodeSync(RosterMemberPayload)({ rosterId: roster.id, memberId: member.id }),
      ),
      summary: [textField('roster', roster.name), textField('member', member.name)],
    })),
    Effect.result,
  );

const confirmRosterMember = (adding: boolean) => (payloadJson: string, ctx: ConfirmContext) =>
  decodeStoredPayload(RosterMemberPayload, payloadJson).pipe(
    Effect.flatMap((payload) =>
      adding
        ? addRosterMemberForMemberTx({ ...ctx, ...payload })
        : removeRosterMemberForMemberTx({ ...ctx, ...payload }),
    ),
    Effect.as<ConfirmResult>({ kind: 'discord_queued' }),
    Effect.catchTags({
      Forbidden: groupRosterConfirmFailure,
      RosterNotFound: groupRosterConfirmFailure,
      PlayerNotFound: groupRosterConfirmFailure,
    }),
  );

// ---------------------------------------------------------------------------
// Finance actions. Every write lives in `services/FinanceWrites.ts`, shared with the HTTP
// handlers. The stored payload carries the exact amount, currency and date the card showed —
// confirm writes those, never a re-derived value, and the model never sees the payload. Confirm is
// idempotent through the proposal claim: `ai-chat.ts` claims the row under `FOR UPDATE` in the
// same transaction as the write, so a second Accept answers 409 and writes nothing.
// ---------------------------------------------------------------------------

const AmountMinorParam = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000_000 })),
);
const CurrencyParam = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Z]{3}$/)));
const FeeNameParam = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
);
const NoteParam = Schema.String.pipe(Schema.check(Schema.isMaxLength(500)));

const moneyField = (amountMinor: number, currency: string): AiChatApi.ProposalField =>
  new AiChatApi.ProposalField({
    key: 'amount',
    value: { type: 'money', value: { amountMinor, currency } },
  });

const dateField = (value: string): AiChatApi.ProposalField =>
  new AiChatApi.ProposalField({ key: 'date', value: { type: 'date', value } });

/** Confirm-time: a lost permission is a 403, any other drift (row gone, fee archived) is `stale`. */
const financeConfirmFailure = (e: {
  readonly _tag: string;
}): Effect.Effect<never, AiChatApi.AiProposalNotFound | AiChatApi.AiProposalActionForbidden> =>
  e._tag === 'FinanceForbidden' ||
  e._tag === 'ExpenseForbidden' ||
  e._tag === 'MembershipPlanForbidden'
    ? Effect.fail(new AiChatApi.AiProposalActionForbidden())
    : stale(e._tag);

// --- record_payment ------------------------------------------------------------

const RecordPaymentArgs = Schema.Struct({
  member: NameParam,
  fee: FeeNameParam,
  amountMinor: AmountMinorParam,
  method: Payment.ManualPaymentMethod,
  paidOn: DateOnly,
  note: Schema.optionalKey(NoteParam),
});

const RecordPaymentPayload = Schema.Struct({
  feeId: Fee.FeeId,
  assignmentId: FeeAssignment.FeeAssignmentId,
  amountMinor: Schema.Int,
  currency: Schema.String,
  method: Payment.ManualPaymentMethod,
  paidOn: Schema.String,
  note: Schema.optionalKey(Schema.String),
});

const proposeRecordPayment = (rawArgs: unknown, ctx: ToolContext) =>
  Effect.Do.pipe(
    Effect.bind('args', () => decodeArgs(RecordPaymentArgs, rawArgs)),
    // Inactive members still owe what they owe.
    Effect.bind('member', ({ args }) => resolveMemberByName(ctx.teamId, args.member, true)),
    Effect.bind('fee', ({ args }) =>
      FeesRepository.asEffect().pipe(
        // Active fees only: the write refuses an archived one.
        Effect.flatMap((fees) => fees.listByTeam(ctx.teamId)),
        Effect.flatMap((rows) =>
          exactlyOne(
            matchByName(rows, args.fee),
            'fee: no active fee with that name',
            'fee: several fees match that name; ask the user which one they mean',
          ),
        ),
      ),
    ),
    Effect.bind('assignment', ({ fee, member }) =>
      FeeAssignmentsRepository.asEffect().pipe(
        Effect.flatMap((assignments) => assignments.findByFeeAndMember(fee.id, member.id)),
        Effect.flatMap((found) =>
          someOr(found, () => Effect.fail('member: that fee is not assigned to this member')),
        ),
      ),
    ),
    Effect.map(({ args, member, fee, assignment }) => ({
      payloadJson: JSON.stringify(
        Schema.encodeSync(RecordPaymentPayload)({
          feeId: fee.id,
          assignmentId: assignment.id,
          amountMinor: args.amountMinor,
          currency: fee.currency,
          method: args.method,
          paidOn: args.paidOn,
          ...(args.note === undefined ? {} : { note: args.note }),
        }),
      ),
      summary: [
        textField('member', member.name),
        textField('fee', fee.name),
        moneyField(args.amountMinor, fee.currency),
        dateField(args.paidOn),
        new AiChatApi.ProposalField({
          key: 'method',
          value: { type: 'paymentMethod', value: args.method },
        }),
        optionalTextField('note', Option.fromUndefinedOr(args.note)),
      ],
    })),
    Effect.result,
  );

const confirmRecordPayment = (payloadJson: string, ctx: ConfirmContext) =>
  decodeStoredPayload(RecordPaymentPayload, payloadJson).pipe(
    // The card promised this currency. A fee whose currency was edited since would book the same
    // number in another currency: refuse instead. `FOR SHARE` holds the edit off until commit;
    // `fees` is the outermost leg of the money lock order (AGENTS.md "Bank Sync"), and the payment
    // insert below only takes `fee_assignments` after it.
    Effect.tap((payload) =>
      SqlClient.SqlClient.asEffect().pipe(
        Effect.flatMap(
          (sql) => sql<{ readonly currency: string }>`
            SELECT currency FROM fees WHERE id = ${payload.feeId} FOR SHARE
          `,
        ),
        catchSqlErrors,
        Effect.flatMap(([fee]) =>
          fee?.currency === payload.currency ? Effect.void : stale('fee currency changed'),
        ),
      ),
    ),
    Effect.flatMap((payload) =>
      recordPaymentForMemberTx({
        ...ctx,
        feeId: payload.feeId,
        assignmentId: payload.assignmentId,
        payload: {
          amountMinor: Schema.decodeSync(Fee.AmountMinor)(payload.amountMinor),
          method: payload.method,
          paidAt: dateOnlyToUtcNoon(payload.paidOn),
          note: Option.fromUndefinedOr(payload.note),
        },
      }),
    ),
    Effect.as<ConfirmResult>({ kind: 'applied' }),
    Effect.catchTags({
      FinanceForbidden: financeConfirmFailure,
      FeeNotFound: financeConfirmFailure,
      FeeArchived: financeConfirmFailure,
      AssignmentNotFound: financeConfirmFailure,
      InvalidAmount: financeConfirmFailure,
    }),
  );

// --- create_expense ------------------------------------------------------------

const CreateExpenseArgs = Schema.Struct({
  amountMinor: AmountMinorParam,
  currency: CurrencyParam,
  spentOn: DateOnly,
  category: Expense.ExpenseCategory,
  description: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(500)),
  ),
});

const proposeCreateExpense = (rawArgs: unknown, _ctx: ToolContext) =>
  decodeArgs(CreateExpenseArgs, rawArgs).pipe(
    Effect.map((args) => ({
      payloadJson: JSON.stringify(Schema.encodeSync(CreateExpenseArgs)(args)),
      summary: [
        moneyField(args.amountMinor, args.currency),
        dateField(args.spentOn),
        new AiChatApi.ProposalField({
          key: 'category',
          value: { type: 'expenseCategory', value: args.category },
        }),
        textField('description', args.description),
      ],
    })),
    Effect.result,
  );

const confirmCreateExpense = (payloadJson: string, ctx: ConfirmContext) =>
  decodeStoredPayload(CreateExpenseArgs, payloadJson).pipe(
    Effect.flatMap((args) =>
      createExpenseForMemberTx({
        ...ctx,
        payload: {
          amountMinor: Schema.decodeSync(Fee.AmountMinor)(args.amountMinor),
          currency: Schema.decodeSync(Fee.CurrencyCode)(args.currency),
          spentAt: dateOnlyToUtcNoon(args.spentOn),
          category: args.category,
          description: args.description,
          bankTransactionId: Option.none(),
        },
      }),
    ),
    Effect.as<ConfirmResult>({ kind: 'applied' }),
    Effect.catchTags({
      ExpenseForbidden: financeConfirmFailure,
      InvalidExpenseAmount: financeConfirmFailure,
      InvalidBankTransactionForExpense: financeConfirmFailure,
      BankTransactionAlreadyExpensed: financeConfirmFailure,
    }),
  );

// --- assign_membership_plan ------------------------------------------------------

const AssignPlanArgs = Schema.Struct({ member: NameParam, plan: NameParam });

// The prices are what the card showed; confirm refuses if the plan was repriced since.
const AssignPlanPayload = Schema.Struct({
  memberId: TeamMember.TeamMemberId,
  planId: MembershipPlan.MembershipPlanId,
  priceMinor: Schema.Int,
  pricePerTrainingMinor: Schema.Int,
  currency: Schema.String,
});

/** The seeded default plan has no name (the web labels it); the model passes `default` for it. */
const resolvePlanByName = (teamId: Team.TeamId, name: string) =>
  MembershipPlansRepository.asEffect().pipe(
    Effect.flatMap((plans) => plans.findMembershipPlansByTeamId(teamId)),
    Effect.flatMap((rows) => {
      const named = rows.flatMap((row) =>
        Option.isSome(row.name) ? [{ row, name: row.name.value }] : [],
      );
      const matches = matchByName(named, name).map((m) => m.row);
      const unnamedDefault = rows.filter((r) => Option.isNone(r.name) && r.is_default);
      return exactlyOne(
        matches.length === 0 && name.toLowerCase() === 'default' ? unnamedDefault : matches,
        'plan: no active membership plan with that name',
        'plan: several plans match that name; ask the user which one they mean',
      );
    }),
  );

const proposeAssignPlan = (rawArgs: unknown, ctx: ToolContext) =>
  Effect.Do.pipe(
    Effect.bind('args', () => decodeArgs(AssignPlanArgs, rawArgs)),
    // The write only reaches active members.
    Effect.bind('member', ({ args }) => resolveMemberByName(ctx.teamId, args.member, false)),
    Effect.bind('plan', ({ args }) => resolvePlanByName(ctx.teamId, args.plan)),
    Effect.map(({ member, plan }) => ({
      payloadJson: JSON.stringify(
        Schema.encodeSync(AssignPlanPayload)({
          memberId: member.id,
          planId: plan.id,
          priceMinor: plan.price_minor,
          pricePerTrainingMinor: plan.price_per_training_minor,
          currency: plan.currency,
        }),
      ),
      summary: [
        textField('member', member.name),
        new AiChatApi.ProposalField({
          key: 'plan',
          value: { type: 'planName', value: Option.getOrNull(plan.name) },
        }),
        moneyField(plan.price_minor, plan.currency),
        new AiChatApi.ProposalField({
          key: 'pricePerTraining',
          value: {
            type: 'money',
            value: { amountMinor: plan.price_per_training_minor, currency: plan.currency },
          },
        }),
      ],
    })),
    Effect.result,
  );

const confirmAssignPlan = (payloadJson: string, ctx: ConfirmContext) =>
  decodeStoredPayload(AssignPlanPayload, payloadJson).pipe(
    // `FOR SHARE` holds a repricing off until commit. `membership_plans` before `fees` (reached
    // through the plan-change trigger) is the order `setDefaultMembershipPlan` already uses.
    Effect.tap((payload) =>
      SqlClient.SqlClient.asEffect().pipe(
        Effect.flatMap(
          (sql) => sql<{
            readonly price_minor: number;
            readonly price_per_training_minor: number;
            readonly currency: string;
          }>`
            SELECT price_minor::int AS price_minor,
                   price_per_training_minor::int AS price_per_training_minor, currency
            FROM membership_plans
            WHERE id = ${payload.planId} AND team_id = ${ctx.teamId} AND archived_at IS NULL
            FOR SHARE
          `,
        ),
        catchSqlErrors,
        Effect.flatMap(([plan]) =>
          plan !== undefined &&
          plan.price_minor === payload.priceMinor &&
          plan.price_per_training_minor === payload.pricePerTrainingMinor &&
          plan.currency === payload.currency
            ? Effect.void
            : stale('plan changed'),
        ),
      ),
    ),
    Effect.flatMap((payload) =>
      assignMembershipPlanForMemberTx({
        ...ctx,
        memberId: payload.memberId,
        membershipPlanId: Option.some(payload.planId),
      }),
    ),
    Effect.as<ConfirmResult>({ kind: 'applied' }),
    Effect.catchTags({
      MembershipPlanForbidden: financeConfirmFailure,
      MembershipPlanNotFound: financeConfirmFailure,
      MembershipPlanCurrencyHasPayments: financeConfirmFailure,
    }),
  );

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

/** What `confirm` did. `ai-chat.ts` switches on `kind` for the after-commit work and the
 *  response: an event needs side effects and an `EventInfo`; a Discord change is only queued. */
export type ConfirmResult =
  | { readonly kind: 'event_created'; readonly event: EventRow }
  | { readonly kind: 'discord_queued' }
  | { readonly kind: 'event_updated'; readonly event: EventWithDetails }
  | { readonly kind: 'event_cancelled'; readonly event: EventWithDetails }
  | { readonly kind: 'attendance_confirmed' }
  | {
      readonly kind: 'rsvp_submitted';
      readonly submitted: Effect.Success<ReturnType<typeof submitRsvpTx>>;
    }
  // Changed in place with no Discord side effect (a roster when the team creates no channels).
  | { readonly kind: 'applied' };

type ConfirmContext = { readonly teamId: Team.TeamId; readonly membership: MembershipWithRole };

export type ProposeR =
  | FeesRepository
  | FeeAssignmentsRepository
  | MembershipPlansRepository
  | EventRsvpsRepository
  | TeamMembersRepository
  | RostersRepository
  | EventsRepository
  | EventAttendanceRepository
  | GroupsRepository
  | TrainingTypesRepository
  | TeamChannelsRepository
  | TeamChannelAccessRepository
  | TeamSettingsRepository
  | TeamsRepository
  | DiscordChannelsRepository;

type ConfirmR =
  | FeesRepository
  | FeeAssignmentsRepository
  | PaymentsRepository
  | ExpensesRepository
  | BankTransactionsRepository
  | MembershipPlansRepository
  | EventRsvpsRepository
  | TeamMembersRepository
  | RostersRepository
  | UsersRepository
  | EventsRepository
  | EventAttendanceRepository
  | GroupsRepository
  | TrainingTypesRepository
  | TeamSettingsRepository
  | TeamChannelsRepository
  | TeamChannelAccessRepository
  | ChannelSyncEventsRepository
  | DiscordChannelMappingRepository
  | TeamsRepository
  | DiscordChannelsRepository
  | SqlClient.SqlClient;

export interface ActionDefinition {
  /** Every one is required. A write action includes the permission of the HTTP endpoint it
   *  mirrors, so the assistant is never a way around it. */
  readonly permissions: ReadonlyArray<Role.Permission>;
  /** `true` = refuse to propose when the Sideline bot is not in the team's guild: the queued
   *  change would wait for a bot that may never come. */
  readonly requiresDiscord: boolean;
  readonly description: string;
  /** For `toToolParameters` ONLY — never decoded with its `Type`. */
  readonly argsSchema: Schema.Top;
  /** Propose-time: decode, validate every reference in team, resolve names, render the summary,
   *  hand back the encoded payload. Writes nothing. */
  readonly propose: (
    rawArgs: unknown,
    ctx: ToolContext,
  ) => Effect.Effect<
    Result.Result<
      { readonly payloadJson: string; readonly summary: ReadonlyArray<AiChatApi.ProposalField> },
      string
    >,
    never,
    ProposeR
  >;
  /** Confirm-time. Runs INSIDE the caller's transaction — must not swallow a cause. An event
   *  comes back as the RAW ROW, not a view model: `emitEventCreatedSideEffects` needs
   *  `owner_group_id`, which `EventApi.EventInfo` does not carry. */
  readonly confirm: (
    payloadJson: string,
    ctx: { readonly teamId: Team.TeamId; readonly membership: MembershipWithRole },
  ) => Effect.Effect<
    ConfirmResult,
    EventApi.Forbidden | AiChatApi.AiProposalNotFound | AiChatApi.AiProposalActionForbidden,
    ConfirmR
  >;
}

const DISCORD_PERMISSIONS: ReadonlyArray<Role.Permission> = ['ai:manage_discord', 'group:manage'];

const DISCORD_COMMON =
  'This does NOT change anything by itself — it shows the user a card they must confirm. After ' +
  'they confirm, the change is only QUEUED for the Sideline bot and shows in Discord shortly: ' +
  'never say it is done. Only channels in the channel manager (`managedVia: ' +
  '"channel_manager"` in `list_discord_channels`) can be changed; a group or roster channel ' +
  'follows its group or roster and cannot be changed here. Name channels and groups exactly as ' +
  '`list_discord_channels` and `list_groups` show them; when a name matches several channels or ' +
  'groups, ask the user which one they mean. Only one may be proposed per reply.';

const EVENT_COMMON =
  'This does NOT change anything by itself — it shows the user a card they must confirm. Only ' +
  'one may be proposed per reply.';

const FINANCE_COMMON =
  'This does NOT change anything by itself — it shows the user a card with the exact amount, ' +
  'currency and date, which they must confirm; what they confirm is what is written. Amounts ' +
  'are integer MINOR units (`amountMinor`, e.g. 150000 = 1500.00), as the finance read tools ' +
  'show them; dates are team-local `YYYY-MM-DD`. Never guess an amount: ask the user. Only one ' +
  'may be proposed per reply.';

const GROUP_ROSTER_COMMON =
  'This does NOT change anything by itself — it shows the user a card they must confirm. After ' +
  'they confirm, the matching Discord role or channel change is QUEUED for the Sideline bot: ' +
  'say the Discord side updates shortly, never that it is already done. When a name matches ' +
  'several groups, rosters or members, ask the user which one they mean. Only one may be ' +
  'proposed per reply.';

export const ACTION_REGISTRY: Record<AiActionProposal.AiActionName, ActionDefinition> = {
  create_event: {
    permissions: ['event:create'],
    requiresDiscord: false,
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
  create_discord_channel: {
    permissions: DISCORD_PERMISSIONS,
    requiresDiscord: true,
    description:
      'Proposes creating a new Sideline-managed text channel in the team Discord server. ' +
      '`name` is the clean channel name; `emoji` is optional. The new channel is hidden: only ' +
      'admins see it until a group gets access, so offer `propose_set_discord_channel_access` ' +
      `next. ${DISCORD_COMMON}`,
    argsSchema: CreateDiscordChannelArgs,
    propose: proposeCreateDiscordChannel,
    confirm: confirmCreateDiscordChannel,
  },
  set_discord_channel_access: {
    permissions: DISCORD_PERMISSIONS,
    requiresDiscord: true,
    description:
      "Proposes changing ONE group's access to a Sideline-managed Discord channel: grant, " +
      'change the level, or remove it. `access` is VIEW (can view), EDIT (can post), ADMIN (can ' +
      `moderate) or NONE (remove access). ${DISCORD_COMMON}`,
    argsSchema: SetDiscordChannelAccessArgs,
    propose: proposeSetDiscordChannelAccess,
    confirm: confirmSetDiscordChannelAccess,
  },
  archive_discord_channel: {
    permissions: DISCORD_PERMISSIONS,
    requiresDiscord: true,
    description:
      'Proposes archiving a Sideline-managed Discord channel. The bot moves the channel into ' +
      "the team's archive category; if the move fails, the bot deletes the channel and its " +
      'messages are lost. Only channels that already exist in Discord can be archived. ' +
      DISCORD_COMMON,
    argsSchema: ArchiveDiscordChannelArgs,
    propose: proposeArchiveDiscordChannel,
    confirm: confirmArchiveDiscordChannel,
  },
  update_event: {
    permissions: ['event:edit'],
    requiresDiscord: false,
    description:
      'Proposes changing ONE existing event: its title, description, location or time. Pass ' +
      'the `eventId` from `list_events` and only the fields that change. For a timed event set ' +
      '`startAt`/`endAt` as ISO-8601 instants with offset; for an all-day event set ' +
      '`startDate`/`endDate` as team-local `YYYY-MM-DD`. A recurring event changes only this ' +
      `occurrence. ${EVENT_COMMON}`,
    argsSchema: UpdateEventArgs,
    propose: proposeUpdateEvent,
    confirm: confirmUpdateEvent,
  },
  cancel_event: {
    permissions: ['event:cancel'],
    requiresDiscord: false,
    description:
      'Proposes cancelling ONE event, by the `eventId` from `list_events`. Members who said they ' +
      'are coming are notified. A recurring event cancels only this occurrence. ' +
      EVENT_COMMON,
    argsSchema: CancelEventArgs,
    propose: proposeCancelEvent,
    confirm: confirmCancelEvent,
  },
  mark_attendance: {
    permissions: ['event:edit'],
    requiresDiscord: false,
    description:
      'Proposes confirming attendance for a training that has started, by the `eventId` from ' +
      '`list_events`. List who was there in `present` and who was not in `absent`, by the names ' +
      '`list_event_attendance` shows; everyone else keeps what `list_event_attendance` shows for ' +
      'them. Confirming saves the whole list, which may charge per-training fees. ' +
      EVENT_COMMON,
    argsSchema: MarkAttendanceArgs,
    propose: proposeMarkAttendance,
    confirm: confirmMarkAttendance,
  },
  set_my_rsvp: {
    // Same as the web RSVP buttons: any member, for events they are invited to.
    permissions: [],
    requiresDiscord: false,
    description:
      "Proposes setting the USER'S OWN answer to an event invitation, by the `eventId` from " +
      '`list_events`. `response` is yes, no, maybe or coming_later; `maybe` and `coming_later` ' +
      'need a `message` (when they arrive, or what it depends on) unless one is already saved. ' +
      "It can never answer for another member: if the user asks to set someone else's RSVP, say " +
      `that each member answers for themselves. ${EVENT_COMMON}`,
    argsSchema: SetMyRsvpArgs,
    propose: proposeSetMyRsvp,
    confirm: confirmSetMyRsvp,
  },
  create_group: {
    permissions: ['group:manage'],
    requiresDiscord: false,
    description:
      'Proposes creating a new top-level group. `name` is the group name; `emoji` is optional. ' +
      `Sideline also creates its Discord role (and channel, if the team has that on). ${GROUP_ROSTER_COMMON}`,
    argsSchema: CreateNamedArgs,
    propose: proposeCreateGroup,
    confirm: confirmCreateGroup,
  },
  add_group_member: {
    permissions: ['group:manage'],
    requiresDiscord: false,
    description:
      'Proposes adding ONE member to a group, by the group name `list_groups` shows and the ' +
      `member name \`list_members\` shows. ${GROUP_ROSTER_COMMON}`,
    argsSchema: GroupMemberArgs,
    propose: proposeGroupMember(true),
    confirm: confirmGroupMember(true),
  },
  remove_group_member: {
    permissions: ['group:manage'],
    requiresDiscord: false,
    description:
      'Proposes removing ONE member from a group they are directly in (not a subgroup), by the ' +
      `group name \`list_groups\` shows and the member name \`list_members\` shows. ${GROUP_ROSTER_COMMON}`,
    argsSchema: GroupMemberArgs,
    propose: proposeGroupMember(false),
    confirm: confirmGroupMember(false),
  },
  create_roster: {
    permissions: ['roster:manage'],
    requiresDiscord: false,
    description:
      'Proposes creating a new roster. `name` is the roster name; `emoji` is optional. Sideline ' +
      `also creates its Discord channel and role unless the team turned that off. ${GROUP_ROSTER_COMMON}`,
    argsSchema: CreateNamedArgs,
    propose: proposeCreateRoster,
    confirm: confirmCreateRoster,
  },
  add_roster_member: {
    permissions: ['roster:manage'],
    requiresDiscord: false,
    description:
      'Proposes adding ONE member to a roster, by the roster name `list_rosters` shows and the ' +
      `member name \`list_members\` shows. ${GROUP_ROSTER_COMMON}`,
    argsSchema: RosterMemberArgs,
    propose: proposeRosterMember(true),
    confirm: confirmRosterMember(true),
  },
  remove_roster_member: {
    permissions: ['roster:manage'],
    requiresDiscord: false,
    description:
      'Proposes removing ONE member from a roster, by the roster name `list_rosters` shows and ' +
      `the member name \`list_members\` shows. ${GROUP_ROSTER_COMMON}`,
    argsSchema: RosterMemberArgs,
    propose: proposeRosterMember(false),
    confirm: confirmRosterMember(false),
  },
  record_payment: {
    permissions: ['finance:record_payments'],
    requiresDiscord: false,
    description:
      'Proposes recording ONE manual payment (cash or bank transfer) a member made towards a fee ' +
      'assigned to them, by the member name `list_members` shows and the fee name `list_fees` ' +
      `shows. The currency is the fee's. ${FINANCE_COMMON}`,
    argsSchema: RecordPaymentArgs,
    propose: proposeRecordPayment,
    confirm: confirmRecordPayment,
  },
  create_expense: {
    permissions: ['finance:manage_fees'],
    requiresDiscord: false,
    description:
      'Proposes adding ONE team expense: what was spent (`amountMinor` + ISO `currency`, e.g. ' +
      `CZK), when (\`spentOn\`), its \`category\` and a short \`description\`. ${FINANCE_COMMON}`,
    argsSchema: CreateExpenseArgs,
    propose: proposeCreateExpense,
    confirm: confirmCreateExpense,
  },
  assign_membership_plan: {
    permissions: ['finance:manage_fees'],
    requiresDiscord: false,
    description:
      'Proposes moving ONE active member onto a membership plan, by the member name `list_members` ' +
      'shows and the plan name `list_membership_plans` shows; pass `default` for the default plan ' +
      'whose name is null. This can change what the member owes for the running season. ' +
      'This does NOT change anything by itself — it shows the user a card they must confirm. ' +
      'Only one may be proposed per reply.',
    argsSchema: AssignPlanArgs,
    propose: proposeAssignPlan,
    confirm: confirmAssignPlan,
  },
};
