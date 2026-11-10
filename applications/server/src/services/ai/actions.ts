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
 * Actions: `create_event`, and three Discord actions that only QUEUE a change for the bot
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
  Event,
  type EventApi,
  GroupModel,
  type Role,
  type Team,
  TeamChannel,
  type TeamChannelAccess,
  TrainingType,
} from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { DateTime, Effect, Option, type Result, Schema, type ServiceMap } from 'effect';
import type { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import type { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import type { EventRow, EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamChannelAccessRepository } from '~/repositories/TeamChannelAccessRepository.js';
import { TeamChannelsRepository } from '~/repositories/TeamChannelsRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import type { ToolContext } from '~/services/ai/toolTypes.js';
import { createEventForMemberTx, resolveEventGroups } from '~/services/EventCreation.js';
import {
  archiveManagedChannelTx,
  createManagedChannel,
  setManagedChannelAccessTx,
} from '~/services/ManagedChannels.js';
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
const matchByName = <T extends { readonly name: string }>(
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

const proposeCreateDiscordChannel = (rawArgs: unknown, ctx: ToolContext) =>
  Effect.Do.pipe(
    Effect.bind('args', () => decodeArgs(CreateDiscordChannelArgs, rawArgs)),
    Effect.bind('existing', () =>
      TeamChannelsRepository.asEffect().pipe(
        Effect.flatMap((channels) => channels.findAllByTeam(ctx.teamId)),
      ),
    ),
    // Case-insensitive on purpose: stricter than the unique index.
    Effect.tap(({ args, existing }) =>
      existing.some((c) => !c.archived && c.name.toLowerCase() === args.name.toLowerCase())
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
// The registry.
// ---------------------------------------------------------------------------

/** What `confirm` did. `ai-chat.ts` switches on `kind` for the after-commit work and the
 *  response: an event needs side effects and an `EventInfo`; a Discord change is only queued. */
export type ConfirmResult =
  | { readonly kind: 'event_created'; readonly event: EventRow }
  | { readonly kind: 'discord_queued' };

export type ProposeR =
  | GroupsRepository
  | TrainingTypesRepository
  | TeamChannelsRepository
  | TeamChannelAccessRepository
  | TeamSettingsRepository
  | TeamsRepository
  | DiscordChannelsRepository;

type ConfirmR =
  | EventsRepository
  | GroupsRepository
  | TrainingTypesRepository
  | TeamSettingsRepository
  | TeamChannelsRepository
  | TeamChannelAccessRepository
  | ChannelSyncEventsRepository
  | DiscordChannelMappingRepository
  | TeamsRepository
  | DiscordChannelsRepository;

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
  ) => Effect.Effect<ConfirmResult, EventApi.Forbidden | AiChatApi.AiProposalNotFound, ConfirmR>;
}

const DISCORD_PERMISSIONS: ReadonlyArray<Role.Permission> = ['ai:manage_discord', 'group:manage'];

const DISCORD_COMMON =
  'This does NOT change anything by itself — it shows the user a card they must confirm. After ' +
  'they confirm, the change is only QUEUED for the Sideline bot and shows in Discord shortly: ' +
  'never say it is done. Only Sideline-managed channels (`managedBySideline: true` in ' +
  '`list_discord_channels`) can be changed. Name channels and groups exactly as ' +
  '`list_discord_channels` and `list_groups` show them; when a name matches several channels or ' +
  'groups, ask the user which one they mean. Only one may be proposed per reply.';

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
};
