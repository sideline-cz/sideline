import type { ChannelRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Exit, Option, Ref } from 'effect';
import { clearStaleRoleOnUnknownRole } from '~/rcp/channel/channelUtils.js';
import { isPermanentError } from '~/rcp/channel/ProcessorService.js';
import { createChannelOnly } from '~/rest/channels/createChannelOnly.js';
import { createRoleForChannel } from '~/rest/channels/createRoleForChannel.js';
import { createRoleOnly } from '~/rest/channels/createRoleOnly.js';
import { isUnknownRoleError } from '~/rest/discordErrors.js';
import { retryPolicy } from '~/rest/utils.js';
import { SyncRpc, type SyncRpcClient } from '~/services/SyncRpc.js';

// Shared helper for the role-only path when no mapping exists (or mapping has no role and no
// channel). Creates the role and persists the role-only mapping. Used for both the "no mapping"
// and "mapping with both ids None" cases — they are identical.
const provisionRoleOnly = (
  rpc: SyncRpcClient,
  event: ChannelRpcEvents.GroupChannelCreatedEvent,
  roleColor: number | undefined,
) =>
  Effect.Do.pipe(
    Effect.bind('roleResult', () =>
      createRoleOnly(event.guild_id, event.discord_role_name, roleColor),
    ),
    Effect.tap(({ roleResult }) =>
      rpc['Channel/UpsertMappingRoleOnly']({
        team_id: event.team_id,
        group_id: event.group_id,
        discord_role_id: roleResult.discord_role_id,
      }),
    ),
    Effect.map(({ roleResult }) => roleResult.discord_role_id),
  );

export const handleCreated = (event: ChannelRpcEvents.GroupChannelCreatedEvent) => {
  const roleColor = Option.getOrUndefined(event.discord_role_color);

  return Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('roleId', ({ rpc }) =>
      Option.match(event.existing_channel_id, {
        // Branch 1: existing channel supplied → create role for it, upsert mapping, yield role id
        onSome: (channelId) =>
          Effect.Do.pipe(
            Effect.bind('result', () =>
              createRoleForChannel(event.guild_id, channelId, event.discord_role_name, roleColor),
            ),
            Effect.tap(({ result }) =>
              rpc['Channel/UpsertMapping']({
                team_id: event.team_id,
                group_id: event.group_id,
                discord_channel_id: result.discord_channel_id,
                discord_role_id: result.discord_role_id,
              }),
            ),
            Effect.map(({ result }) => result.discord_role_id),
          ),
        onNone: () =>
          Option.match(event.discord_channel_name, {
            // Branch 2: new channel + role → create channel, persist channel id BEFORE role to
            // avoid orphans on retry, then create role, upsert full mapping, yield role id
            onSome: (channelName) =>
              Effect.Do.pipe(
                Effect.bind('channelResult', () => createChannelOnly(event.guild_id, channelName)),
                // Persist the channel ID immediately before role creation to avoid orphan channels on retry
                Effect.tap(({ channelResult }) =>
                  rpc['Channel/UpsertGroupChannel']({
                    team_id: event.team_id,
                    group_id: event.group_id,
                    discord_channel_id: channelResult.discord_channel_id,
                  }),
                ),
                Effect.bind('roleResult', ({ channelResult }) =>
                  createRoleForChannel(
                    event.guild_id,
                    channelResult.discord_channel_id,
                    event.discord_role_name,
                    roleColor,
                  ),
                ),
                Effect.tap(({ roleResult }) =>
                  rpc['Channel/UpsertMapping']({
                    team_id: event.team_id,
                    group_id: event.group_id,
                    discord_channel_id: roleResult.discord_channel_id,
                    discord_role_id: roleResult.discord_role_id,
                  }),
                ),
                Effect.map(({ roleResult }) => roleResult.discord_role_id),
              ),
            // Branch 3–5: role-only path — GetMapping-first for idempotency
            onNone: () =>
              Effect.Do.pipe(
                Effect.bind('cached', () =>
                  rpc['Channel/GetMapping']({ team_id: event.team_id, group_id: event.group_id }),
                ),
                Effect.flatMap(({ cached }) =>
                  Option.match(cached, {
                    onSome: (mapping) =>
                      Option.match(mapping.discord_role_id, {
                        // Branch 3: mapping already has role → reuse it, no creation, no upsert
                        onSome: (existingRoleId) => Effect.succeed(existingRoleId),
                        onNone: () =>
                          Option.match(mapping.discord_channel_id, {
                            // Branch 4: mapping has channel but no role → create role for that channel
                            onSome: (channelId) =>
                              Effect.Do.pipe(
                                Effect.bind('roleResult', () =>
                                  createRoleForChannel(
                                    event.guild_id,
                                    channelId,
                                    event.discord_role_name,
                                    roleColor,
                                  ),
                                ),
                                Effect.tap(({ roleResult }) =>
                                  rpc['Channel/UpsertMapping']({
                                    team_id: event.team_id,
                                    group_id: event.group_id,
                                    discord_channel_id: roleResult.discord_channel_id,
                                    discord_role_id: roleResult.discord_role_id,
                                  }),
                                ),
                                Effect.map(({ roleResult }) => roleResult.discord_role_id),
                              ),
                            // Branch 5a: mapping has no channel and no role → provision role only
                            onNone: () => provisionRoleOnly(rpc, event, roleColor),
                          }),
                      }),
                    // Branch 5b: no mapping at all → provision role only
                    onNone: () => provisionRoleOnly(rpc, event, roleColor),
                  }),
                ),
              ),
          }),
      }),
    ),
    // Shared backfill step: read group members and assign the resolved role to each
    Effect.bind('members', ({ rpc }) =>
      rpc['Channel/GetGroupMembers']({ team_id: event.team_id, group_id: event.group_id }),
    ),
    // `roleGone` short-circuits the loop the moment a member returns Unknown Role (10011): the
    // mapped role no longer exists in the guild, so every remaining grant is a guaranteed
    // failure. It also caps `Channel/ClearMappingRole` at one call per event instead of one per
    // failing member — with `concurrency: 1` only the first member to hit 10011 can ever flip it,
    // so no extra guarding is needed around the clear itself.
    Effect.bind('roleGone', () => Ref.make(false)),
    // Counts members whose grant failed with a permanent Discord error (e.g. 50013 / 403 — the
    // bot lacks permission or sits below the role in the hierarchy). Used below to detect the
    // "every member failed" case, which is worth one alertable `logError` instead of N scattered
    // `logWarning`s.
    Effect.bind('permanentFailureCount', () => Ref.make(0)),
    Effect.tap(({ rest, roleId, members, roleGone, permanentFailureCount }) =>
      Effect.forEach(
        members,
        (member) =>
          Ref.get(roleGone).pipe(
            Effect.flatMap((alreadyGone) =>
              alreadyGone
                ? Effect.void
                : rest.addGuildMemberRole(event.guild_id, member.discord_user_id, roleId).pipe(
                    Effect.retry({ schedule: retryPolicy, while: (e) => !isPermanentError(e) }),
                    Effect.tapError((error) =>
                      isUnknownRoleError(error)
                        ? Ref.set(roleGone, true).pipe(
                            Effect.andThen(clearStaleRoleOnUnknownRole(event, error)),
                          )
                        : Effect.void,
                    ),
                    Effect.tapError((error) =>
                      isPermanentError(error)
                        ? Ref.update(permanentFailureCount, (count) => count + 1)
                        : Effect.void,
                    ),
                    Effect.exit,
                    Effect.flatMap((exit) =>
                      Exit.match(exit, {
                        onSuccess: () => Effect.void,
                        onFailure: (cause) =>
                          Effect.logWarning(
                            `Failed to add role ${roleId} to member ${member.team_member_id} (discord user ${member.discord_user_id}): ${String(cause)}`,
                          ),
                      }),
                    ),
                  ),
            ),
          ),
        { concurrency: 1 },
      ),
    ),
    // If every attempted member failed with a permanent error (and the loop wasn't short-circuited
    // by a stale/deleted role, which already logged its own distinct warning above), the whole
    // team silently got nothing — that's alertable. Guarded on `members.length > 0` so an empty
    // group never misfires this on vacuous truth.
    Effect.tap(({ roleId, members, roleGone, permanentFailureCount }) =>
      Effect.Do.pipe(
        Effect.bind('gone', () => Ref.get(roleGone)),
        Effect.bind('failures', () => Ref.get(permanentFailureCount)),
        Effect.flatMap(({ gone, failures }) =>
          !gone && members.length > 0 && failures === members.length
            ? Effect.logError(
                `All ${members.length} member role grant(s) for group ${event.group_id} in guild ${event.guild_id} failed permanently (role ${roleId}) — the bot likely lacks Manage Roles permission or its role sits below the target role in the Discord hierarchy`,
              )
            : Effect.void,
        ),
      ),
    ),
    Effect.tap(({ roleId }) =>
      Effect.logInfo(
        `Synced group_channel_created: group ${event.group_id} → role ${roleId} in guild ${event.guild_id}`,
      ),
    ),
    Effect.asVoid,
  );
};
