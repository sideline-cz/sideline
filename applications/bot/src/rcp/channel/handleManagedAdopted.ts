import type { ChannelRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx';
import * as Discord from 'dfx/types';
import { Effect } from 'effect';
import { HIDDEN } from '~/rest/permissions.js';
import { deny, retryPolicy } from '~/rest/utils.js';

export const handleManagedAdopted = (event: ChannelRpcEvents.ManagedChannelAdoptedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.tap(({ rest }) =>
      // Full-replace to [@everyone deny ViewChannel] is safe: the bot retains channel access via
      // its guild-level bot role (same pattern as createChannelOnly for Sideline-created channels).
      // It does not rely on a per-channel overwrite, so this replace does not lock the bot out of
      // the follow-up setAccess grants.
      rest
        .updateChannel(event.discord_channel_id, {
          permission_overwrites: [
            {
              id: event.guild_id,
              type: Discord.ChannelPermissionOverwrites.ROLE,
              deny: deny(HIDDEN),
            },
          ],
        })
        .pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(() =>
      Effect.logInfo(
        `Adopted managed Discord channel ${event.discord_channel_id} for team channel ${event.team_channel_id}: set @everyone deny ViewChannel`,
      ),
    ),
    Effect.asVoid,
  );
