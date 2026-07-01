import type { Discord as DiscordSchemas } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Discord from 'dfx/types';
import { Array as Arr, Effect, Option } from 'effect';
import { createPersonalEventChannel } from '~/rest/channels/createPersonalEventChannel.js';
import { formatPersonalChannelName } from '~/rest/channels/formatPersonalChannelName.js';
import { POLL_BATCH_SIZE, retryPolicy } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';

/**
 * Discord returns HTTP 400 code 50035 (Invalid Form Body) with a nested
 * `parent_id` error `CHANNEL_PARENT_MAX_CHANNELS` when a guild category hits
 * the 50-channel limit. The top-level 50035 code alone is not specific enough
 * (it covers any form-body validation failure), so we also require the nested
 * sub-code before treating it as "category full".
 */
const INVALID_FORM_BODY = 50035;

const isCategoryFullError = (data: { readonly code: number; readonly errors?: unknown }): boolean =>
  data.code === INVALID_FORM_BODY &&
  JSON.stringify(data.errors ?? {}).includes('CHANNEL_PARENT_MAX_CHANNELS');

/**
 * Idempotent provisioner: for each guild, find members without a personal
 * channel and create one for them.
 *
 * Algorithm per member:
 *   1. GetPersonalChannelTargetCategory → resolves base or overflow category
 *   2. ReservePersonalChannel (INSERT ON CONFLICT DO NOTHING) → if reserved=true, proceed
 *   3. createPersonalEventChannel (Discord API call)
 *      - On HTTP 400 / code 50035 CHANNEL_PARENT_MAX_CHANNELS (category full):
 *        a. AllocatePersonalOverflowCategory → get sequence
 *        b. createGuildChannel(GUILD_CATEGORY) → new Discord category
 *        c. SavePersonalOverflowCategoryId
 *        d. retry createPersonalEventChannel in new category
 *   4. SavePersonalChannelId
 *
 * Serialized per guild (concurrency 1) to avoid Discord rate limits.
 */
export const provisionPersonalChannels = (guildId: DiscordSchemas.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    // Fetch members who still need a channel
    Effect.bind('members', ({ rpc }) =>
      rpc['Guild/GetMembersNeedingPersonalChannel']({
        guild_id: guildId,
        limit: POLL_BATCH_SIZE,
      }),
    ),
    Effect.tap(({ members }) =>
      members.length > 0
        ? Effect.logDebug(
            `Guild ${guildId}: ${members.length} member(s) need a personal events channel`,
          )
        : Effect.void,
    ),
    Effect.flatMap(({ rpc, members }) =>
      Effect.all(
        Arr.map(members, (member) =>
          Effect.Do.pipe(
            // Resolve which category (base or overflow) to use for this team
            Effect.bind('target', () =>
              rpc['Guild/GetPersonalChannelTargetCategory']({ team_id: member.team_id }),
            ),
            Effect.flatMap(({ target }) =>
              Option.match(target.category_id, {
                onNone: () =>
                  Effect.logDebug(
                    `No personal events category configured for team ${member.team_id}, skipping`,
                  ),
                onSome: (categoryId) =>
                  Effect.Do.pipe(
                    // Reserve a row first (idempotent)
                    Effect.bind('reservation', () =>
                      rpc['Guild/ReservePersonalChannel']({
                        team_id: member.team_id,
                        team_member_id: member.team_member_id,
                      }),
                    ),
                    Effect.flatMap(({ reservation }) => {
                      if (!reservation.reserved) {
                        // Another bot replica or previous run already reserved
                        return Effect.void;
                      }

                      const channelName = formatPersonalChannelName(
                        member.channel_format,
                        member.name,
                        member.discord_id,
                      );

                      const createAndSave = (catId: DiscordSchemas.Snowflake) =>
                        createPersonalEventChannel(
                          guildId,
                          member.discord_id,
                          catId,
                          channelName,
                        ).pipe(
                          Effect.flatMap(({ discord_channel_id }) =>
                            rpc['Guild/SavePersonalChannelId']({
                              team_id: member.team_id,
                              team_member_id: member.team_member_id,
                              discord_channel_id,
                              channel_format: member.channel_format,
                            }),
                          ),
                          // Populate the new channel with the member's existing events: mark the
                          // team's upcoming events dirty so the reconcile pass renders them here.
                          Effect.tap(() =>
                            rpc['Guild/MarkTeamPersonalEventsDirty']({
                              team_id: member.team_id,
                            }).pipe(
                              Effect.catchTag('RpcClientError', (e) =>
                                Effect.logWarning(
                                  `Failed to mark events dirty after provisioning member ${member.team_member_id}`,
                                  e,
                                ),
                              ),
                            ),
                          ),
                        );

                      // Try with the resolved category; on HTTP 400 / code 50035
                      // (max channels in category), allocate and CREATE an overflow
                      // Discord category, persist its ID, then retry once.
                      return createAndSave(categoryId).pipe(
                        Effect.catchTag('ErrorResponse', (e) => {
                          // Only handle the category-full condition (50035 with a
                          // nested CHANNEL_PARENT_MAX_CHANNELS). Any other error
                          // (e.g. 403 Missing Access = 50013) must propagate so
                          // callers can observe the real failure.
                          if (!isCategoryFullError(e.data)) {
                            return Effect.fail(e);
                          }
                          // Category is full — allocate an overflow row, create the
                          // Discord category, persist its ID, then create the channel.
                          return Effect.Do.pipe(
                            Effect.bind('rest', () => DiscordREST.asEffect()),
                            Effect.bind('allocation', () =>
                              rpc['Guild/AllocatePersonalOverflowCategory']({
                                team_id: member.team_id,
                              }),
                            ),
                            // Fetch the base category name so the overflow category
                            // gets a consistent label (e.g. "personal-events (2)").
                            Effect.let('baseCategoryName', () => 'personal-events' as string),
                            Effect.bind('resolvedBaseName', ({ rest, baseCategoryName }) =>
                              rest.getChannel(categoryId).pipe(
                                Effect.map((ch) =>
                                  'name' in ch && typeof ch.name === 'string' && ch.name.length > 0
                                    ? ch.name
                                    : baseCategoryName,
                                ),
                                Effect.catchTag(
                                  ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'],
                                  () => Effect.succeed(baseCategoryName),
                                ),
                              ),
                            ),
                            Effect.bind(
                              'overflowCategory',
                              ({ rest, allocation, resolvedBaseName }) => {
                                const overflowName = `${resolvedBaseName} (${allocation.sequence + 1})`;
                                return rest
                                  .createGuildChannel(guildId, {
                                    name: overflowName,
                                    type: Discord.ChannelTypes.GUILD_CATEGORY,
                                  })
                                  .pipe(Effect.retry(retryPolicy));
                              },
                            ),
                            Effect.tap(({ allocation, overflowCategory }) =>
                              rpc['Guild/SavePersonalOverflowCategoryId']({
                                team_id: member.team_id,
                                sequence: allocation.sequence,
                                discord_category_id:
                                  overflowCategory.id as DiscordSchemas.Snowflake,
                              }),
                            ),
                            Effect.flatMap(({ overflowCategory }) =>
                              createAndSave(overflowCategory.id as DiscordSchemas.Snowflake),
                            ),
                          );
                        }),
                        Effect.tapError((e) =>
                          Effect.logWarning(
                            `Failed to provision personal channel for member ${member.team_member_id} in guild ${guildId}`,
                            e,
                          ),
                        ),
                        Effect.catch(() => Effect.void),
                      );
                    }),
                    Effect.catchTag('RpcClientError', (e) =>
                      Effect.logWarning(
                        `RPC error provisioning personal channel for member ${member.team_member_id}`,
                        e,
                      ),
                    ),
                  ),
              }),
            ),
          ),
        ),
        { concurrency: 1 },
      ),
    ),
    Effect.asVoid,
  );
