import { Carpool, type CarpoolRpcModels, Discord as DiscordSchemas } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction, ModalSubmitData } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Array as Arr, Effect, Metric, Option, Schema } from 'effect';
import { guildLocale, type Locale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { buildCarpoolEmbed } from '~/rest/carpool/buildCarpoolEmbed.js';
import { DISCORD_REST_ERROR_TAGS, failAsDiscordError } from '~/rest/discordErrors.js';
import { isRecord } from '~/rest/recordProbe.js';
import { formatName, formatNamePlain } from '~/rest/utils.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const stringProp = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === 'string' ? v : undefined;
};

const stringArrayProp = (value: unknown, key: string): ReadonlyArray<string> => {
  if (!isRecord(value)) return [];
  const v = value[key];
  return Array.isArray(v) ? v.filter((item): item is string => typeof item === 'string') : [];
};

/** Extract custom_id and values from interaction data (avoids MessageComponentData service dependency in tests). */
const getComponentData = (
  interaction: DiscordTypes.APIInteraction,
): { custom_id: string; values: ReadonlyArray<string> } => ({
  custom_id: stringProp(interaction.data, 'custom_id') ?? '',
  values: stringArrayProp(interaction.data, 'values'),
});

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);
const decodeCarId = Schema.decodeUnknownSync(Carpool.CarpoolCarId);

/** 1-based index of the car within the view (0 when not found). */
const carIndexInView = (view: CarpoolRpcModels.CarpoolView, carId: Carpool.CarpoolCarId): number =>
  Arr.findFirstIndex(view.cars, (c) => c.car_id === carId).pipe(
    Option.map((i) => i + 1),
    Option.getOrElse(() => 0),
  );

const ephemeralDeferred: DiscordTypes.CreateMessageInteractionCallbackRequest = {
  type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  data: { flags: DiscordTypes.MessageFlags.Ephemeral },
};

/** The error union shared by every dfx DiscordREST call. */
type RestError = Effect.Error<ReturnType<DiscordRestService['updateOriginalWebhookMessage']>>;

/** Log and swallow the three Discord REST failure tags. */
const logRestErrors =
  (context: string) =>
  <A, R>(effect: Effect.Effect<A, RestError, R>) =>
    effect.pipe(
      Effect.catchTag(['ErrorResponse', 'HttpClientError', 'RatelimitedResponse'], (e) =>
        Effect.logError(context, e),
      ),
    );

type WebhookUpdatePayload = Parameters<
  DiscordRestService['updateOriginalWebhookMessage']
>[2]['payload'];

/** Update the deferred ephemeral webhook reply, swallowing REST failures. */
const replyWebhook = (
  rest: DiscordRestService,
  interaction: DiscordTypes.APIInteraction,
  payload: WebhookUpdatePayload,
  context = 'webhook update',
) =>
  rest
    .updateOriginalWebhookMessage(interaction.application_id, interaction.token, { payload })
    .pipe(logRestErrors(context));

/** Rebuild a carpool board message at an explicit channel/message, swallowing REST failures. */
const rebuildBoardMessage = (
  rest: DiscordRestService,
  channelId: DiscordSchemas.Snowflake,
  messageId: DiscordSchemas.Snowflake,
  view: CarpoolRpcModels.CarpoolView,
  embedLocale: Locale,
) => {
  const { embeds, components } = buildCarpoolEmbed(view, embedLocale);
  return rest
    .updateMessage(channelId, messageId, { embeds, components, allowed_mentions: { parse: [] } })
    .pipe(Effect.asVoid, logRestErrors('Failed to rebuild carpool embed'));
};

/**
 * Rebuild the public carpool board from a view, using the channel/message id stored on the view.
 * Used by the reserve/leave/assign/remove handlers. Swallows REST failures.
 */
const rebuildBoard = (
  rest: DiscordRestService,
  view: CarpoolRpcModels.CarpoolView,
  embedLocale: Locale,
) =>
  Option.match(view.discord_message_id, {
    onNone: () => Effect.logWarning('Carpool board message id not set — skipping board update'),
    onSome: (boardMessageId) =>
      rebuildBoardMessage(rest, view.discord_channel_id, boardMessageId, view, embedLocale),
  });

/** Try to add a user to a thread, handling errors as non-fatal. Returns true on success. */
const tryAddThreadMember = (rest: DiscordRestService, threadId: string, userId: string) =>
  rest.addThreadMember(decodeSnowflake(threadId), decodeSnowflake(userId)).pipe(
    Effect.as(true),
    Effect.catchTag(DISCORD_REST_ERROR_TAGS, failAsDiscordError),
    Effect.catchTag('DiscordPermissionError', (error) =>
      Effect.logWarning('Cannot add user to thread (permissions)', error.cause).pipe(
        Effect.as(false),
      ),
    ),
    Effect.catchTag(
      ['DiscordNotFoundError', 'DiscordPermanentError', 'DiscordTransientError'],
      (error) =>
        Effect.logWarning('Failed to add user to thread', error.cause).pipe(Effect.as(false)),
    ),
  );

// ---------------------------------------------------------------------------
// carpool-add button
// ---------------------------------------------------------------------------

export const CarpoolAddButton = Effect.Do.pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'button' }),
      1,
    ),
  ),
  Effect.bind('interaction', () => Interaction.asEffect()),
  Effect.let('data', ({ interaction }) => getComponentData(interaction)),
  Effect.map(({ data, interaction }) => {
    const locale = userLocale(interaction);
    const messageId = interaction.message?.id;
    const channelId = interaction.channel_id;

    // Extract carpool_id from custom_id: carpool-add:<carpool_id>
    const addParts = data.custom_id.split(':');
    const carpoolId = addParts[1];

    if (messageId === undefined || channelId === undefined || !carpoolId) {
      // Deferred ephemeral as fallback
      return {
        type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: DiscordTypes.MessageFlags.Ephemeral },
      };
    }

    // Respond with a MODAL to collect capacity
    return {
      type: DiscordTypes.InteractionCallbackTypes.MODAL,
      data: {
        custom_id: `carpool-add-modal:${channelId}:${messageId}:${carpoolId}`,
        title: m.bot_carpool_btn_add({}, { locale }),
        components: [
          UI.row([
            UI.textInput({
              custom_id: 'carpool_capacity',
              label: m.bot_carpool_capacity_placeholder({}, { locale }),
              style: DiscordTypes.TextInputStyleTypes.SHORT,
              required: true,
              min_length: 1,
              max_length: 1,
              placeholder: '2',
            }),
          ]),
        ],
      },
    };
  }),
  Effect.withSpan('interaction/carpool-add-button'),
);

const _CarpoolAddButtonReg = Ix.messageComponent(Ix.idStartsWith('carpool-add:'), CarpoolAddButton);

// ---------------------------------------------------------------------------
// carpool-add-modal submit — capacity collected, create the car + thread
// ---------------------------------------------------------------------------

const modalFieldValue = (
  data: DiscordTypes.APIModalSubmission,
  customId: string,
): string | undefined => {
  for (const row of data.components ?? []) {
    if (row.type !== 1) continue;
    for (const comp of row.components) {
      if (comp.custom_id === customId && comp.value && comp.value.trim().length > 0) {
        return comp.value.trim();
      }
    }
  }
  return undefined;
};

export const CarpoolAddModal = Ix.modalSubmit(
  Ix.idStartsWith('carpool-add-modal:'),
  Effect.Do.pipe(
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
      const locale = userLocale(interaction);
      const embedLocale = guildLocale(interaction);
      const guildId = interaction.guild_id;
      const discordUserIdOption = interactionUserId(interaction);

      // custom_id format: carpool-add-modal:<channelId>:<messageId>:<carpoolId>
      // CarpoolAddButton encodes all four segments when opening this modal.
      const modalParts = data.custom_id.split(':');
      const mainChannelId = modalParts[1];
      const mainMessageId = modalParts[2];
      const carpoolIdRaw = modalParts[3];

      if (Option.isNone(discordUserIdOption)) {
        return Effect.as(
          Effect.forkDetach(
            replyWebhook(rest, interaction, { content: m.bot_carpool_err_user({}, { locale }) }),
          ),
          ephemeralDeferred,
        );
      }

      const discordUserId = discordUserIdOption.value;

      // Extract capacity from modal; default to 4 on parse failure
      const capacityRaw = modalFieldValue(data, 'carpool_capacity');
      const capacity = capacityRaw !== undefined ? parseInt(capacityRaw, 10) : 4;
      const capacityInt =
        Number.isFinite(capacity) && capacity >= 1 && capacity <= 8 ? capacity : 4;

      if (!carpoolIdRaw || !mainChannelId || !mainMessageId) {
        return Effect.as(
          Effect.forkDetach(
            replyWebhook(rest, interaction, { content: m.bot_carpool_err_generic({}, { locale }) }),
          ),
          ephemeralDeferred,
        );
      }

      const carpoolId = Schema.decodeUnknownSync(Carpool.CarpoolId)(carpoolIdRaw);

      const addCarAndFollowUp = rpc['Carpool/AddCar']({
        guild_id: decodeSnowflake(guildId ?? ''),
        discord_user_id: discordUserId,
        carpool_id: carpoolId,
        capacity: capacityInt,
        note: Option.none(),
      }).pipe(
        Effect.flatMap((addResult) => {
          const carId = addResult.car_id;
          const carIndex = carIndexInView(addResult.view, carId);
          const newCar = Arr.findFirst(addResult.view.cars, (c) => c.car_id === carId);
          const ownerName = Option.match(newCar, {
            onNone: () => 'Unknown',
            onSome: (car) => formatName(car.owner),
          });
          const ownerNamePlain = Option.match(newCar, {
            onNone: () => 'Unknown',
            onSome: (car) => formatNamePlain(car.owner),
          });

          // 1. Create the private thread
          const createThread = rest
            .createThread(decodeSnowflake(mainChannelId), {
              name: m.bot_carpool_thread_name(
                { n: carIndex > 0 ? carIndex : 1, owner: ownerNamePlain },
                { locale },
              ),
              type: 12 as const, // PRIVATE_THREAD
              invitable: false,
            })
            .pipe(
              Effect.asSome,
              Effect.catchTag('ErrorResponse', (e) =>
                Effect.logWarning('Failed to create car thread', e).pipe(Effect.as(Option.none())),
              ),
              Effect.catchTag('HttpClientError', (e) =>
                Effect.logWarning('Failed to create car thread (http)', e).pipe(
                  Effect.as(Option.none()),
                ),
              ),
              Effect.catchTag('RatelimitedResponse', (e) =>
                Effect.logWarning('Failed to create car thread (rate limited)', e).pipe(
                  Effect.as(Option.none()),
                ),
              ),
            );

          return createThread.pipe(
            Effect.flatMap((threadOption) => {
              if (Option.isNone(threadOption)) {
                // Thread creation failed — still rebuild the embed using AddCar view
                return rebuildBoardMessage(
                  rest,
                  decodeSnowflake(mainChannelId),
                  decodeSnowflake(mainMessageId),
                  addResult.view,
                  embedLocale,
                ).pipe(
                  Effect.flatMap(() =>
                    replyWebhook(rest, interaction, {
                      content: m.bot_carpool_car_added(
                        { n: carIndex > 0 ? carIndex : 1 },
                        { locale },
                      ),
                    }),
                  ),
                );
              }

              const threadId = threadOption.value.id;

              // 2. Persist the thread id
              const saveThreadId = rpc['Carpool/SaveCarThreadId']({
                car_id: carId,
                thread_id: decodeSnowflake(threadId),
              }).pipe(
                Effect.catchTag('RpcClientError', (e) =>
                  Effect.logWarning('Failed to save car thread id', e),
                ),
              );

              // 3. Post thread welcome message
              const postWelcome = rest
                .createMessage(decodeSnowflake(threadId), {
                  embeds: [
                    {
                      title: m.bot_carpool_thread_welcome_title({}, { locale }),
                      description: m.bot_carpool_thread_welcome(
                        { n: carIndex > 0 ? carIndex : 1, owner: ownerName },
                        { locale },
                      ),
                    },
                  ],
                  components: [
                    UI.row([
                      UI.button({
                        style: DiscordTypes.ButtonStyleTypes.PRIMARY,
                        label: m.bot_carpool_btn_assign({}, { locale }),
                        custom_id: `carpool-assign:${carId}`,
                      }),
                      UI.button({
                        style: DiscordTypes.ButtonStyleTypes.SECONDARY,
                        label: m.bot_carpool_btn_leave({}, { locale }),
                        custom_id: `carpool-leave:${carId}`,
                      }),
                      UI.button({
                        style: DiscordTypes.ButtonStyleTypes.DANGER,
                        label: m.bot_carpool_btn_remove({}, { locale }),
                        custom_id: `carpool-remove:${carId}`,
                      }),
                    ]),
                  ],
                })
                .pipe(
                  Effect.asVoid,
                  Effect.catchTag('ErrorResponse', (e) =>
                    Effect.logWarning('Failed to post thread welcome', e),
                  ),
                  Effect.catchTag('HttpClientError', (e) =>
                    Effect.logWarning('Failed to post thread welcome (http)', e),
                  ),
                  Effect.catchTag('RatelimitedResponse', (e) =>
                    Effect.logWarning('Failed to post thread welcome (rate limited)', e),
                  ),
                );

              // 4. Add the owner to the thread
              const addOwner = tryAddThreadMember(rest, threadId, discordUserId).pipe(
                Effect.asVoid,
              );

              // 5. Re-fetch the view so the embed reflects the saved thread_id
              const rebuildEmbed = rpc['Carpool/GetCarpoolView']({ carpool_id: carpoolId }).pipe(
                Effect.flatMap((viewOption) =>
                  rebuildBoardMessage(
                    rest,
                    decodeSnowflake(mainChannelId),
                    decodeSnowflake(mainMessageId),
                    Option.getOrElse(viewOption, () => addResult.view),
                    embedLocale,
                  ),
                ),
                Effect.catchTag('RpcClientError', (e) =>
                  Effect.logWarning('Failed to fetch carpool view for rebuild', e),
                ),
              );

              return saveThreadId.pipe(
                Effect.flatMap(() =>
                  Effect.all([postWelcome, addOwner, rebuildEmbed], {
                    concurrency: 'unbounded',
                  }),
                ),
                Effect.flatMap(() =>
                  replyWebhook(rest, interaction, {
                    content: m.bot_carpool_car_added(
                      { n: carIndex > 0 ? carIndex : 1 },
                      { locale },
                    ),
                  }),
                ),
              );
            }),
          );
        }),
        Effect.catchTag('CarpoolGuildNotFound', () =>
          replyWebhook(rest, interaction, { content: m.bot_carpool_no_guild({}, { locale }) }),
        ),
        Effect.catchTag('CarpoolNotMember', () =>
          replyWebhook(rest, interaction, {
            content: m.bot_carpool_err_not_member({}, { locale }),
          }),
        ),
        Effect.catchTag('CarpoolNotFound', () =>
          replyWebhook(rest, interaction, {
            content: m.bot_carpool_err_carpool_not_found({}, { locale }),
          }),
        ),
        Effect.catchTag('CarpoolAlreadyOwnsCar', () =>
          replyWebhook(rest, interaction, {
            content: m.bot_carpool_err_already_owns_car({}, { locale }),
          }),
        ),
        Effect.catchTag('CarpoolAlreadyInAnotherCar', () =>
          replyWebhook(rest, interaction, {
            content: m.bot_carpool_err_already_in_other({}, { locale }),
          }),
        ),
      );

      return Effect.as(Effect.forkDetach(addCarAndFollowUp), ephemeralDeferred);
    }),
    Effect.withSpan('interaction/carpool-add-modal'),
  ),
);

// ---------------------------------------------------------------------------
// carpool-reserve:<car_id> button
// ---------------------------------------------------------------------------

export const CarpoolReserveButton = Effect.Do.pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'button' }),
      1,
    ),
  ),
  Effect.bind('interaction', () => Interaction.asEffect()),
  Effect.let('data', ({ interaction }) => getComponentData(interaction)),
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('rest', () => DiscordREST.asEffect()),
  Effect.flatMap(({ data, interaction, rpc, rest }) => {
    const parts = data.custom_id.split(':');
    const carId = decodeCarId(parts[1]);
    const locale = userLocale(interaction);
    const guildId = interaction.guild_id;
    const discordUserIdOption = interactionUserId(interaction);
    const embedLocale = guildLocale(interaction);

    if (Option.isNone(discordUserIdOption)) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(
            rest,
            interaction,
            { content: m.bot_carpool_err_user({}, { locale }) },
            'Failed to update webhook',
          ),
        ),
        ephemeralDeferred,
      );
    }

    const discordUserId = discordUserIdOption.value;

    const reserveAndFollowUp = rpc['Carpool/ReserveSeat']({
      guild_id: decodeSnowflake(guildId ?? ''),
      discord_user_id: discordUserId,
      car_id: carId,
    }).pipe(
      Effect.flatMap((result) => {
        const carIndex = carIndexInView(result.view, carId);

        const addToThread = Option.match(result.thread_id, {
          onNone: () => Effect.succeed(true),
          onSome: (threadId) => tryAddThreadMember(rest, threadId, discordUserId),
        });

        const updateMain = rebuildBoard(rest, result.view, embedLocale);

        return Effect.all([addToThread, updateMain], {
          concurrency: 'unbounded',
        }).pipe(
          Effect.flatMap(([addedToThread]) => {
            const successContent = m.bot_carpool_joined(
              { n: carIndex > 0 ? carIndex : 1 },
              { locale },
            );
            const threadWarning = !addedToThread
              ? `\n${m.bot_carpool_err_thread_add_failed({}, { locale })}`
              : '';

            return replyWebhook(
              rest,
              interaction,
              {
                content: successContent + threadWarning,
                components: [
                  UI.row([
                    UI.button({
                      style: DiscordTypes.ButtonStyleTypes.DANGER,
                      label: m.bot_carpool_btn_leave({}, { locale }),
                      custom_id: `carpool-leave:${carId}`,
                    }),
                  ]),
                ],
              },
              'Failed to update reserve response',
            );
          }),
        );
      }),
      Effect.catchTag('CarpoolFull', () =>
        replyWebhook(rest, interaction, { content: m.bot_carpool_err_car_full({}, { locale }) }),
      ),
      Effect.catchTag('CarpoolAlreadyInThisCar', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_already_in_this({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolAlreadyInAnotherCar', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_already_in_other({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolOwnerCannotReserve', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_owner_cannot_reserve({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolCarNotFound', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_car_not_found({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolNotMember', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_not_member({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolGuildNotFound', () =>
        replyWebhook(rest, interaction, { content: m.bot_carpool_no_guild({}, { locale }) }),
      ),
    );

    return Effect.as(Effect.forkDetach(reserveAndFollowUp), ephemeralDeferred);
  }),
  Effect.withSpan('interaction/carpool-reserve-button'),
);

const _CarpoolReserveButtonReg = Ix.messageComponent(
  Ix.idStartsWith('carpool-reserve:'),
  CarpoolReserveButton,
);

// ---------------------------------------------------------------------------
// carpool-leave:<car_id> button
// ---------------------------------------------------------------------------

export const CarpoolLeaveButton = Effect.Do.pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'button' }),
      1,
    ),
  ),
  Effect.bind('interaction', () => Interaction.asEffect()),
  Effect.let('data', ({ interaction }) => getComponentData(interaction)),
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('rest', () => DiscordREST.asEffect()),
  Effect.flatMap(({ data, interaction, rpc, rest }) => {
    const parts = data.custom_id.split(':');
    const carId = decodeCarId(parts[1]);
    const locale = userLocale(interaction);
    const guildId = interaction.guild_id;
    const discordUserIdOption = interactionUserId(interaction);
    const embedLocale = guildLocale(interaction);

    if (Option.isNone(discordUserIdOption)) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(rest, interaction, { content: m.bot_carpool_err_user({}, { locale }) }),
        ),
        ephemeralDeferred,
      );
    }

    const discordUserId = discordUserIdOption.value;

    const leaveAndFollowUp = rpc['Carpool/LeaveSeat']({
      guild_id: decodeSnowflake(guildId ?? ''),
      discord_user_id: discordUserId,
      car_id: carId,
    }).pipe(
      Effect.flatMap((view) => {
        const carIndex = carIndexInView(view, carId);

        // Look up the thread_id from the returned view's car entry.
        // The leave button may be clicked from the ephemeral success message so
        // interaction.channel_id is unreliable — use the persisted thread_id.
        const carThreadId = Arr.findFirst(view.cars, (c) => c.car_id === carId).pipe(
          Option.flatMap((c) => c.thread_id),
        );

        const removeFromThread = Option.match(carThreadId, {
          onNone: () => Effect.void,
          onSome: (threadId) =>
            rest.deleteThreadMember(decodeSnowflake(threadId), decodeSnowflake(discordUserId)).pipe(
              Effect.asVoid,
              Effect.catchTag('ErrorResponse', (e) =>
                Effect.logWarning('Failed to remove user from thread', e),
              ),
              Effect.catchTag('HttpClientError', (e) =>
                Effect.logWarning('Failed to remove user from thread', e),
              ),
              Effect.catchTag('RatelimitedResponse', (e) =>
                Effect.logWarning('Failed to remove user from thread', e),
              ),
            ),
        });

        const updateMain = rebuildBoard(rest, view, embedLocale);

        return Effect.all([removeFromThread, updateMain], {
          concurrency: 'unbounded',
        }).pipe(
          Effect.flatMap(() =>
            replyWebhook(rest, interaction, {
              content: m.bot_carpool_left({ n: carIndex > 0 ? carIndex : 1 }, { locale }),
            }),
          ),
        );
      }),
      Effect.catchTag('CarpoolOwnerCannotLeave', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_owner_cannot_leave({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolNotInCar', () =>
        replyWebhook(rest, interaction, { content: m.bot_carpool_err_not_in_car({}, { locale }) }),
      ),
      Effect.catchTag('CarpoolCarNotFound', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_car_not_found({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolNotMember', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_not_member({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolGuildNotFound', () =>
        replyWebhook(rest, interaction, { content: m.bot_carpool_no_guild({}, { locale }) }),
      ),
    );

    return Effect.as(Effect.forkDetach(leaveAndFollowUp), ephemeralDeferred);
  }),
  Effect.withSpan('interaction/carpool-leave-button'),
);

const _CarpoolLeaveButtonReg = Ix.messageComponent(
  Ix.idStartsWith('carpool-leave:'),
  CarpoolLeaveButton,
);

// ---------------------------------------------------------------------------
// carpool-leave-mine:<carpool_id> button (board, leave from whichever car)
// ---------------------------------------------------------------------------

export const CarpoolLeaveMineButton = Effect.Do.pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'button' }),
      1,
    ),
  ),
  Effect.bind('interaction', () => Interaction.asEffect()),
  Effect.let('data', ({ interaction }) => getComponentData(interaction)),
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('rest', () => DiscordREST.asEffect()),
  Effect.flatMap(({ data, interaction, rpc, rest }) => {
    const parts = data.custom_id.split(':');
    const carpool_id = Schema.decodeUnknownSync(Carpool.CarpoolId)(parts[1]);
    const locale = userLocale(interaction);
    const guildId = interaction.guild_id;
    const discordUserIdOption = interactionUserId(interaction);
    const embedLocale = guildLocale(interaction);

    if (Option.isNone(discordUserIdOption)) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(rest, interaction, { content: m.bot_carpool_err_user({}, { locale }) }),
        ),
        ephemeralDeferred,
      );
    }

    const discordUserId = discordUserIdOption.value;

    const leaveAndFollowUp = rpc['Carpool/LeaveCarpool']({
      guild_id: decodeSnowflake(guildId ?? ''),
      discord_user_id: discordUserId,
      carpool_id,
    }).pipe(
      Effect.flatMap((result) => {
        const { car_id, view } = result;
        const carIndex = carIndexInView(view, car_id);

        const foundCar = Arr.findFirst(view.cars, (c) => c.car_id === car_id);
        const carThreadId = Option.flatMap(foundCar, (c) => c.thread_id);

        const removeFromThread = Option.match(carThreadId, {
          onNone: () => Effect.void,
          onSome: (threadId) =>
            rest.deleteThreadMember(decodeSnowflake(threadId), decodeSnowflake(discordUserId)).pipe(
              Effect.asVoid,
              Effect.catchTag('ErrorResponse', (e) =>
                Effect.logWarning('Failed to remove user from thread', e),
              ),
              Effect.catchTag('HttpClientError', (e) =>
                Effect.logWarning('Failed to remove user from thread', e),
              ),
              Effect.catchTag('RatelimitedResponse', (e) =>
                Effect.logWarning('Failed to remove user from thread', e),
              ),
            ),
        });

        const updateMain = rebuildBoard(rest, view, embedLocale);

        return Effect.all([removeFromThread, updateMain], {
          concurrency: 'unbounded',
        }).pipe(
          Effect.flatMap(() =>
            replyWebhook(rest, interaction, {
              content: m.bot_carpool_left({ n: carIndex > 0 ? carIndex : 1 }, { locale }),
            }),
          ),
        );
      }),
      Effect.catchTag('CarpoolOwnerCannotLeave', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_owner_cannot_leave({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolNotInCar', () =>
        replyWebhook(rest, interaction, { content: m.bot_carpool_err_not_in_car({}, { locale }) }),
      ),
      Effect.catchTag('CarpoolNotMember', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_not_member({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolGuildNotFound', () =>
        replyWebhook(rest, interaction, { content: m.bot_carpool_no_guild({}, { locale }) }),
      ),
    );

    return Effect.as(Effect.forkDetach(leaveAndFollowUp), ephemeralDeferred);
  }),
  Effect.withSpan('interaction/carpool-leave-mine-button'),
);

const _CarpoolLeaveMineButtonReg = Ix.messageComponent(
  Ix.idStartsWith('carpool-leave-mine:'),
  CarpoolLeaveMineButton,
);

// ---------------------------------------------------------------------------
// carpool-remove:<car_id> button (owner only)
// ---------------------------------------------------------------------------

export const CarpoolRemoveButton = Effect.Do.pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'button' }),
      1,
    ),
  ),
  Effect.bind('interaction', () => Interaction.asEffect()),
  Effect.let('data', ({ interaction }) => getComponentData(interaction)),
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('rest', () => DiscordREST.asEffect()),
  Effect.flatMap(({ data, interaction, rpc, rest }) => {
    const parts = data.custom_id.split(':');
    const carId = decodeCarId(parts[1]);
    const locale = userLocale(interaction);
    const guildId = interaction.guild_id;
    const discordUserIdOption = interactionUserId(interaction);
    const embedLocale = guildLocale(interaction);

    if (Option.isNone(discordUserIdOption)) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(rest, interaction, { content: m.bot_carpool_err_user({}, { locale }) }),
        ),
        ephemeralDeferred,
      );
    }

    const discordUserId = discordUserIdOption.value;

    const removeAndFollowUp = rpc['Carpool/RemoveCar']({
      guild_id: decodeSnowflake(guildId ?? ''),
      discord_user_id: discordUserId,
      car_id: carId,
    }).pipe(
      Effect.flatMap((result) => {
        const archiveThread = Option.match(result.thread_id, {
          onNone: () => Effect.void,
          onSome: (threadId) =>
            rest.updateChannel(decodeSnowflake(threadId), { archived: true, locked: true }).pipe(
              Effect.asVoid,
              Effect.catchTag('ErrorResponse', (e) =>
                Effect.logWarning('Failed to archive car thread', e),
              ),
              Effect.catchTag('HttpClientError', (e) =>
                Effect.logWarning('Failed to archive car thread', e),
              ),
              Effect.catchTag('RatelimitedResponse', (e) =>
                Effect.logWarning('Failed to archive car thread', e),
              ),
            ),
        });

        const updateMain = rebuildBoard(rest, result.view, embedLocale);

        return Effect.all([archiveThread, updateMain], {
          concurrency: 'unbounded',
        }).pipe(
          Effect.flatMap(() =>
            replyWebhook(rest, interaction, { content: m.bot_carpool_car_removed({}, { locale }) }),
          ),
        );
      }),
      Effect.catchTag('CarpoolNotCarOwner', () =>
        replyWebhook(rest, interaction, { content: m.bot_carpool_err_not_owner({}, { locale }) }),
      ),
      Effect.catchTag('CarpoolCarNotFound', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_car_not_found({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolNotMember', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_not_member({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolGuildNotFound', () =>
        replyWebhook(rest, interaction, { content: m.bot_carpool_no_guild({}, { locale }) }),
      ),
    );

    return Effect.as(Effect.forkDetach(removeAndFollowUp), ephemeralDeferred);
  }),
  Effect.withSpan('interaction/carpool-remove-button'),
);

const _CarpoolRemoveButtonReg = Ix.messageComponent(
  Ix.idStartsWith('carpool-remove:'),
  CarpoolRemoveButton,
);

// ---------------------------------------------------------------------------
// carpool-assign:<car_id> button (thread, owner)
// ---------------------------------------------------------------------------

const _CarpoolAssignButtonEffect = Effect.Do.pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'button' }),
      1,
    ),
  ),
  Effect.bind('interaction', () => Interaction.asEffect()),
  Effect.let('data', ({ interaction }) => getComponentData(interaction)),
  Effect.map(({ data, interaction }) => {
    const parts = data.custom_id.split(':');
    const carId = parts[1];
    const locale = userLocale(interaction);

    return {
      type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: DiscordTypes.MessageFlags.Ephemeral,
        content: m.bot_carpool_assign_placeholder({}, { locale }),
        components: [
          UI.row([
            UI.userSelect({
              custom_id: `carpool-assign-pick:${carId}`,
              placeholder: m.bot_carpool_assign_placeholder({}, { locale }),
            }),
          ]),
        ],
      },
    };
  }),
  Effect.withSpan('interaction/carpool-assign-button'),
);

export const CarpoolAssignButton = Ix.messageComponent(
  Ix.idStartsWith('carpool-assign:'),
  _CarpoolAssignButtonEffect,
);

// ---------------------------------------------------------------------------
// carpool-assign-pick:<car_id> user select submission
// ---------------------------------------------------------------------------

const _CarpoolAssignPickSelectEffect = Effect.Do.pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'select' }),
      1,
    ),
  ),
  Effect.bind('interaction', () => Interaction.asEffect()),
  Effect.let('data', ({ interaction }) => getComponentData(interaction)),
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('rest', () => DiscordREST.asEffect()),
  Effect.flatMap(({ data, interaction, rpc, rest }) => {
    const parts = data.custom_id.split(':');
    const carId = decodeCarId(parts[1]);
    const locale = userLocale(interaction);
    const guildId = interaction.guild_id;
    const discordUserIdOption = interactionUserId(interaction);
    const embedLocale = guildLocale(interaction);

    if (Option.isNone(discordUserIdOption)) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(rest, interaction, { content: m.bot_carpool_err_user({}, { locale }) }),
        ),
        ephemeralDeferred,
      );
    }

    const discordUserId = discordUserIdOption.value;

    const targetUserIdOption = Arr.head(data.values);

    if (Option.isNone(targetUserIdOption)) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(rest, interaction, { content: m.bot_carpool_err_generic({}, { locale }) }),
        ),
        ephemeralDeferred,
      );
    }

    const targetUserId = targetUserIdOption.value;

    const assignAndFollowUp = rpc['Carpool/AssignSeat']({
      guild_id: decodeSnowflake(guildId ?? ''),
      discord_user_id: discordUserId,
      car_id: carId,
      target_discord_user_id: decodeSnowflake(targetUserId),
    }).pipe(
      Effect.flatMap((result) => {
        const carIndex = carIndexInView(result.view, carId);

        const addToThread = Option.match(result.thread_id, {
          onNone: () => Effect.void,
          onSome: (threadId) =>
            tryAddThreadMember(rest, threadId, targetUserId).pipe(Effect.asVoid),
        });

        const updateMain = rebuildBoard(rest, result.view, embedLocale);

        return Effect.all([addToThread, updateMain], {
          concurrency: 'unbounded',
        }).pipe(
          Effect.flatMap(() =>
            replyWebhook(rest, interaction, {
              content: m.bot_carpool_assigned(
                { userId: targetUserId, n: carIndex > 0 ? carIndex : 1 },
                { locale },
              ),
              allowed_mentions: { parse: [] },
            }),
          ),
        );
      }),
      Effect.catchTag('CarpoolFull', () =>
        replyWebhook(rest, interaction, { content: m.bot_carpool_err_car_full({}, { locale }) }),
      ),
      Effect.catchTag('CarpoolAlreadyInThisCar', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_already_in_this({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolAlreadyInAnotherCar', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_already_in_other({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolOwnerCannotReserve', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_owner_cannot_reserve({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolNotCarOwner', () =>
        replyWebhook(rest, interaction, { content: m.bot_carpool_err_not_owner({}, { locale }) }),
      ),
      Effect.catchTag('CarpoolTargetNotMember', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_target_not_member({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolCarNotFound', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_car_not_found({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolNotMember', () =>
        replyWebhook(rest, interaction, {
          content: m.bot_carpool_err_not_member({}, { locale }),
        }),
      ),
      Effect.catchTag('CarpoolGuildNotFound', () =>
        replyWebhook(rest, interaction, { content: m.bot_carpool_no_guild({}, { locale }) }),
      ),
    );

    return Effect.as(Effect.forkDetach(assignAndFollowUp), ephemeralDeferred);
  }),
  Effect.withSpan('interaction/carpool-assign-pick-select'),
);

export const CarpoolAssignPickSelect = Ix.messageComponent(
  Ix.idStartsWith('carpool-assign-pick:'),
  _CarpoolAssignPickSelectEffect,
);

// Registration exports for interaction builder
export const CarpoolAddButtonReg = _CarpoolAddButtonReg;
export const CarpoolReserveButtonReg = _CarpoolReserveButtonReg;
export const CarpoolLeaveButtonReg = _CarpoolLeaveButtonReg;
export const CarpoolLeaveMineButtonReg = _CarpoolLeaveMineButtonReg;
export const CarpoolRemoveButtonReg = _CarpoolRemoveButtonReg;
