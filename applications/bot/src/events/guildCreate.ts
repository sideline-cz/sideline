import { Discord } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import type * as DiscordTypes from 'dfx/types';
import { Array as Arr, Effect, Option, Schema, type ServiceMap } from 'effect';
import { DfxGuildMember, DfxSyncableChannel } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeSync(Discord.Snowflake);
const decodeSyncableChannel = Schema.decodeUnknownOption(DfxSyncableChannel);
const decodeGuildMember = Schema.decodeUnknownOption(DfxGuildMember);

// PR-8 (CC-10 S6). One page (`limit: 1000`, no `after` cursor) silently truncates any guild over
// 1000 members — the unseen members are then indistinguishable from "confirmed absent" (a false
// `not_connected`). Paginate with `after` until a page returns fewer than `MEMBER_PAGE_LIMIT` rows
// or `MEMBER_PAGE_CAP` pages have been fetched (10 000 members), whichever comes first.
export const MEMBER_PAGE_LIMIT = 1000;
export const MEMBER_PAGE_CAP = 10;

type Rest = ServiceMap.Service.Shape<typeof DiscordREST>;
type RawGuildMember = Effect.Success<ReturnType<Rest['listGuildMembers']>>[number];

type MembersPageResult = {
  readonly members: ReadonlyArray<RawGuildMember>;
  readonly complete: boolean;
};

/**
 * Fetches every page of guild members, up to `MEMBER_PAGE_CAP` pages. `complete` is `true` only
 * when the loop terminated because a page came back shorter than `MEMBER_PAGE_LIMIT` — i.e. the
 * listing is provably exhaustive. A page-cap exit or a transport failure both report
 * `complete: false`, conservatively treating the listing as possibly-truncated (mirrors the
 * conservative decoding default on `Guild/ReconcileMembers.complete`).
 *
 * dfx types `ListGuildMembersParams.after` as `number`, which is wrong for every snowflake, not
 * just large ones: a Discord snowflake is ~1.4e18 and `Number.MAX_SAFE_INTEGER` is ~9.0e15, so
 * `Number(after)` truncates the low-order digits of *any* cursor. IEEE754 rounds to nearest, so
 * the cursor can round **up** and skip members — the members then look confirmed-absent, which is
 * the exact false `not_connected` this pagination exists to prevent.
 *
 * The runtime does not need a number. dfx builds the request with
 * `HttpClientRequest.setUrlParams({ after })`, which stringifies whatever it is given, so the
 * snowflake string is passed through verbatim. Only the generated type is inaccurate, hence the
 * single narrow cast below rather than a `Number()` conversion that would silently corrupt it.
 */
const paginateMembers = (
  rest: Rest,
  guildId: string,
  after: string | undefined,
  acc: ReadonlyArray<RawGuildMember>,
  pagesFetched: number,
): Effect.Effect<MembersPageResult> => {
  const onError = (error: unknown) =>
    Effect.logError(
      `Failed to fetch guild members page for guild ${guildId}, aborting pagination`,
      error,
    ).pipe(Effect.as(Option.none<ReadonlyArray<RawGuildMember>>()));

  return rest
    .listGuildMembers(guildId, {
      limit: MEMBER_PAGE_LIMIT,
      // See the note above: dfx's generated type says `number`, the wire wants the snowflake
      // string, and `setUrlParams` stringifies it. Converting to a number loses precision.
      ...(after !== undefined ? { after: after as unknown as number } : {}),
    })
    .pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        HttpClientError: onError,
        RatelimitedResponse: onError,
        ErrorResponse: onError,
      }),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed<MembersPageResult>({ members: acc, complete: false }),
          onSome: (page) => {
            const combined = [...acc, ...page];
            if (page.length < MEMBER_PAGE_LIMIT) {
              return Effect.succeed<MembersPageResult>({ members: combined, complete: true });
            }
            if (pagesFetched + 1 >= MEMBER_PAGE_CAP) {
              return Effect.succeed<MembersPageResult>({ members: combined, complete: false });
            }
            return Option.match(Arr.last(page), {
              onNone: () =>
                Effect.succeed<MembersPageResult>({ members: combined, complete: true }),
              onSome: (lastMember) =>
                paginateMembers(rest, guildId, lastMember.user.id, combined, pagesFetched + 1),
            });
          },
        }),
      ),
    );
};

export const handleGuildCreate = (
  guild: DiscordTypes.GatewayGuildCreateDispatchData,
): Effect.Effect<void, never, SyncRpc | DiscordREST> =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.tap(({ rpc }) =>
      rpc['Guild/RegisterGuild']({
        guild_id: decodeSnowflake(guild.id),
        guild_name: guild.name,
        is_community_enabled: guild.features.some((f) => f === 'COMMUNITY'),
      }),
    ),
    Effect.tap(({ rpc, rest }) =>
      rest.listGuildChannels(guild.id).pipe(
        Effect.map((channels) =>
          Arr.getSomes(
            Arr.map(channels, (ch) =>
              Option.map(decodeSyncableChannel(ch), (decoded) => ({
                channel_id: decoded.id,
                name: decoded.name,
                type: decoded.type,
                parent_id: decoded.parent_id,
              })),
            ),
          ),
        ),
        Effect.tap((channels) =>
          rpc['Guild/SyncGuildChannels']({
            guild_id: decodeSnowflake(guild.id),
            channels,
          }),
        ),
        Effect.catchTag(
          ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse', 'RpcClientError'],
          (error) => Effect.logError(`Failed to sync channels for guild ${guild.id}`, error),
        ),
      ),
    ),
    Effect.tap(({ rpc }) => {
      const roles = guild.roles ?? [];
      if (roles.length === 0) {
        return Effect.logWarning(
          `Guild ${guild.id} sent an empty roles payload on GUILD_CREATE; skipping role sync`,
        );
      }
      return rpc['Guild/SyncGuildRoles']({
        guild_id: decodeSnowflake(guild.id),
        roles: Arr.map(roles, (r) => ({
          role_id: decodeSnowflake(r.id),
          name: r.name,
          color: r.color,
          position: r.position,
          managed: r.managed,
        })),
      }).pipe(
        Effect.catchTag('RpcClientError', (error) =>
          Effect.logError(`Failed to sync roles for guild ${guild.id}`, error),
        ),
      );
    }),
    Effect.tap(({ rpc, rest }) =>
      paginateMembers(rest, guild.id, undefined, [], 0).pipe(
        Effect.flatMap(({ members: rawMembers, complete }) => {
          const members = Arr.getSomes(
            Arr.map(rawMembers, (m) =>
              Option.flatMap(
                Option.filter(decodeGuildMember(m), (decoded) => !decoded.user.bot),
                (decoded) =>
                  Option.some({
                    discord_id: decoded.user.id,
                    username: decoded.user.username,
                    avatar: decoded.user.avatar,
                    roles: decoded.roles,
                    nickname: decoded.nick,
                    display_name: decoded.user.global_name,
                  }),
              ),
            ),
          );
          return rpc['Guild/ReconcileMembers']({
            guild_id: decodeSnowflake(guild.id),
            members,
            complete,
          });
        }),
        Effect.catchTag('RpcClientError', (error) =>
          Effect.logError(`Failed to reconcile members for guild ${guild.id}`, error),
        ),
      ),
    ),
    Effect.catchTag('RpcClientError', (error) =>
      Effect.logError(`Failed to register guild ${guild.id}`, error),
    ),
    Effect.asVoid,
  );
