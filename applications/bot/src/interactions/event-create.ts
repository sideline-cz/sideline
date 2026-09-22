import { Discord as DiscordSchemas, Event, type EventType, TrainingType } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction, ModalSubmitData } from 'dfx/Interactions/index';
import * as Discord from 'dfx/types';
import { Array, Effect, Metric, Option, pipe, Schema } from 'effect';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);
const decodeTrainingTypeId = Schema.decodeUnknownSync(TrainingType.TrainingTypeId);

const modalValueOption = (
  submission: Discord.APIModalSubmission,
  customId: string,
): Option.Option<string> => {
  for (const row of submission.components ?? []) {
    if (row.type !== 1) continue;
    for (const comp of row.components) {
      if (comp.custom_id === customId) {
        return comp.value && comp.value.trim().length > 0
          ? Option.some(comp.value.trim())
          : Option.none();
      }
    }
  }
  return Option.none();
};

export const EventCreateModalSubmit = Effect.Do.pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'modal' }),
      1,
    ),
  ),
  Effect.bind('data', () => ModalSubmitData.asEffect()),
  Effect.bind('interaction', () => Interaction.asEffect()),
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('rest', () => DiscordREST.asEffect()),
  Effect.flatMap(({ data, interaction, rpc, rest }) => {
    const isValidUuid = (s: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

    const parts = data.custom_id.split(':');
    const raw = parts[1] ?? '';
    // A modal opened against the OLD bot carries `event-create:training:<uuid>` (a `kind`
    // literal); one opened against the CURRENT bot carries an event-type id instead. Across a
    // bot deploy both can arrive at this handler, so neither is trusted blindly — anything
    // that's neither is rejected outright rather than defaulted (B6).
    const selected: { kind: Event.EventType } | { id: string } | null = Schema.is(Event.EventType)(
      raw,
    )
      ? { kind: raw }
      : isValidUuid(raw)
        ? { id: raw }
        : null;
    const rawTrainingTypeIdInput =
      parts[2] && parts[2].length > 0 && isValidUuid(parts[2])
        ? Option.some(parts[2])
        : Option.none<string>();
    const locale = userLocale(interaction);

    const discordUserId = interactionUserId(interaction);
    const guildId = interaction.guild_id;

    if (!guildId) {
      return Effect.succeed(
        Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: m.bot_event_no_guild({}, { locale }),
            flags: Discord.MessageFlags.Ephemeral,
          },
        }),
      );
    }

    if (Option.isNone(discordUserId)) {
      return Effect.succeed(
        Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: m.bot_event_error({}, { locale }),
            flags: Discord.MessageFlags.Ephemeral,
          },
        }),
      );
    }

    const title = modalValueOption(data, 'event_title');
    const startAt = modalValueOption(data, 'event_start');
    const endAt = modalValueOption(data, 'event_end');
    const location = modalValueOption(data, 'event_location');
    const description = modalValueOption(data, 'event_description');

    if (Option.isNone(title) || Option.isNone(startAt)) {
      return Effect.succeed(
        Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: m.bot_event_invalid_date({}, { locale }),
            flags: Discord.MessageFlags.Ephemeral,
          },
        }),
      );
    }

    // One `event_type`/`event_type_id` pair, regardless of which branch of `selected`
    // resolved it — sending both is what keeps a new bot working against a not-yet-deployed
    // new server (rolling order is bot → server → web).
    const createEvent = (
      eventType: Event.EventType,
      eventTypeId: Option.Option<EventType.EventTypeId>,
    ) => {
      const training_type_id =
        eventType === 'training'
          ? Option.map(rawTrainingTypeIdInput, decodeTrainingTypeId)
          : Option.none<TrainingType.TrainingTypeId>();

      return rpc['Event/CreateEvent']({
        guild_id: decodeSnowflake(guildId),
        discord_user_id: decodeSnowflake(discordUserId.value),
        event_type: eventType,
        event_type_id: eventTypeId,
        title: title.value,
        start_at: startAt.value,
        end_at: endAt,
        location,
        location_url: Option.none(),
        description,
        training_type_id,
      }).pipe(
        Effect.map((result) => m.bot_event_created({ title: result.title }, { locale })),
        Effect.catchTag('CreateEventNotMember', () =>
          Effect.succeed(m.bot_event_not_member({}, { locale })),
        ),
        Effect.catchTag('CreateEventForbidden', () =>
          Effect.succeed(m.bot_event_no_permission({}, { locale })),
        ),
        Effect.catchTag('CreateEventInvalidDate', () =>
          Effect.succeed(m.bot_event_invalid_date({}, { locale })),
        ),
        Effect.catchTag('RpcClientError', () => Effect.succeed(m.bot_event_error({}, { locale }))),
      );
    };

    // Decode/resolve inside the effect (via `Effect.suspend`) rather than eagerly in
    // this handler body. `decodeUnknownSync` throws on malformed input; doing it
    // eagerly here would throw *before* the deferred reply is forked below,
    // killing the whole handler ("This interaction failed") and bypassing the
    // `catchCause` backstop. Suspending turns any decode throw into a defect on
    // the forked fiber, which the backstop resolves with `bot_event_error`.
    const work = Effect.suspend(() => {
      if (selected === null) {
        return Effect.succeed(m.bot_event_unknown_type({}, { locale }));
      }

      // Legacy modal: only `event_type` is known, the id is left for the migration
      // trigger to resolve.
      if ('kind' in selected) {
        return createEvent(selected.kind, Option.none());
      }

      // Current modal: the id is authoritative, but `event_type` is still required (an old
      // server may not know about `event_type_id` yet), so its `kind` has to be resolved via
      // one extra lookup. A miss (archived/deleted mid-flight, or simply bogus) is rejected
      // outright — never defaulted to a guessed kind.
      return rpc['Event/GetEventTypesByGuild']({ guild_id: decodeSnowflake(guildId) }).pipe(
        Effect.flatMap((types) =>
          pipe(
            types,
            Array.findFirst((t) => t.id === selected.id),
            Option.match({
              onNone: () => Effect.succeed(m.bot_event_unknown_type({}, { locale })),
              onSome: (found) => createEvent(found.kind, Option.some(found.id)),
            }),
          ),
        ),
        Effect.catchTag('RpcClientError', () => Effect.succeed(m.bot_event_error({}, { locale }))),
      );
    }).pipe(
      Effect.flatMap((content) =>
        rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
          payload: { content },
        }),
      ),
      Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
        Effect.logError('Failed to update event create response', error),
      ),
      // Defensive backstop: the RPC call (or anything above it) may surface a
      // server-side defect (e.g. a `LogicError.die` from `catchSqlErrors`, or a
      // died `NoSuchElementError`) instead of a tagged error. Without this, the
      // forked fiber below would die silently and the ephemeral defer would
      // never resolve, leaving the user stuck on "Sideline is thinking…"
      // forever. This must always resolve the deferred ephemeral response.
      Effect.catchCause((cause) =>
        Effect.logError('event-create: unexpected failure creating event', cause).pipe(
          Effect.andThen(
            rest
              .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
                payload: { content: m.bot_event_error({}, { locale }) },
              })
              .pipe(
                Effect.catchTag(
                  ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'],
                  (error) => Effect.logError('Failed to update event create response', error),
                ),
              ),
          ),
        ),
      ),
    );

    const deferred: Discord.CreateMessageInteractionCallbackRequest = {
      type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: Discord.MessageFlags.Ephemeral },
    };
    return Effect.as(Effect.forkDetach(work), deferred);
  }),
  Effect.withSpan('interaction/event-create-modal'),
);

export const EventCreateModal = Ix.modalSubmit(
  Ix.idStartsWith('event-create:'),
  EventCreateModalSubmit,
);
