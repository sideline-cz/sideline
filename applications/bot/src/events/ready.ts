import { Discord } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array as Arr, Effect, Schema, type ServiceMap } from 'effect';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeSync(Discord.Snowflake);

const PAGE_LIMIT = 200;
const CHUNK_SIZE = 500;

type Rest = ServiceMap.Service.Shape<typeof DiscordREST>;
type Guild = Effect.Success<ReturnType<Rest['listMyGuilds']>>[number];

const fetchOnePage = (
  rest: Rest,
  after: string | undefined,
  acc: ReadonlyArray<Guild>,
): Effect.Effect<ReadonlyArray<Guild>> => {
  const onError = (error: unknown) =>
    Effect.logError('Failed to fetch guilds page, aborting pagination', error).pipe(Effect.as(acc));
  return rest.listMyGuilds({ limit: PAGE_LIMIT, ...(after !== undefined ? { after } : {}) }).pipe(
    Effect.catchTags({
      HttpClientError: onError,
      RatelimitedResponse: onError,
      ErrorResponse: onError,
    }),
  );
};

const paginateGuilds = (
  rest: Rest,
  after: string | undefined,
  acc: ReadonlyArray<Guild>,
): Effect.Effect<ReadonlyArray<Guild>> =>
  fetchOnePage(rest, after, acc).pipe(
    Effect.flatMap((page) => {
      if (page === acc) return Effect.succeed(acc);
      const combined = [...acc, ...page];
      if (page.length < PAGE_LIMIT) return Effect.succeed(combined);
      const lastId = page[page.length - 1]?.id;
      return paginateGuilds(rest, lastId, combined);
    }),
  );

export const handleReady = (): Effect.Effect<void, never, SyncRpc | DiscordREST> =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.flatMap(({ rpc, rest }) =>
      paginateGuilds(rest, undefined, []).pipe(
        Effect.flatMap((guilds) => {
          if (guilds.length === 0) return Effect.void;

          const mapped = Arr.map(guilds, (g) => ({
            guild_id: decodeSnowflake(g.id),
            is_community_enabled: g.features.some((f) => f === 'COMMUNITY'),
          }));

          return Effect.all(
            Arr.map(Arr.chunksOf(mapped, CHUNK_SIZE), (chunk) =>
              rpc['Guild/SyncCommunityFlags']({ guilds: chunk }).pipe(
                Effect.catchTag('RpcClientError', (error) =>
                  Effect.logWarning('Failed to sync community flags chunk', error),
                ),
              ),
            ),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
        }),
      ),
    ),
  );
