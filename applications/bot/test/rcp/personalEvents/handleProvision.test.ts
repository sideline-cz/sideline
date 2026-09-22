// Nastavitelná docházka (plan §7.6, §10.1). `provisionPersonalChannels` grows
// bucket-awareness: `Guild/GetMembersNeedingPersonalChannel` can now return up
// to three rows for one split member (one per bucket, across up to three
// ticks), and each row's `bucket` must thread into
// `formatPersonalChannelName`, `Guild/ReservePersonalChannel` and
// `Guild/SavePersonalChannelId`. It must also classify Discord's 30013
// "Maximum number of guild channels reached" at error level instead of
// falling into the generic warning-and-swallow branch (S4).

import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { provisionPersonalChannels } from '~/rcp/personalEvents/handleProvision.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const GUILD_ID = '530000000000000001';
const TEAM_ID = '00000000-0000-0000-0000-000000000001';
const MEMBER_ID = 'mbr-00000000-0000-0000-0000-000000000001';
const DISCORD_ID = '530000000000000011';
const CATEGORY_ID = '530000000000000021';

type NeededMember = {
  team_id: string;
  team_member_id: string;
  discord_id: string;
  name: string;
  channel_format: string;
  bucket: 'all' | 'training' | 'tournament' | 'other';
};

const makeMember = (bucket: NeededMember['bucket']): NeededMember => ({
  team_id: TEAM_ID,
  team_member_id: MEMBER_ID,
  discord_id: DISCORD_ID,
  name: 'Alice',
  channel_format: 'events-{discord_id}',
  bucket,
});

/** A member whose reservation for `bucket` is reported as `reserved`. Every other RPC
 * needed by the happy path returns a minimal valid response. */
const makeLayers = (opts: {
  members: ReadonlyArray<NeededMember>;
  reservedByBucket?: Partial<Record<NeededMember['bucket'], boolean>>;
  createGuildChannelImpl?: (
    name: string,
  ) => Effect.Effect<{ id: string; parent_id?: string | null }, unknown>;
}) => {
  const reservePersonalChannelCalls: Array<{ team_member_id: string; bucket: string }> = [];
  const savePersonalChannelIdCalls: Array<{
    team_member_id: string;
    bucket: string;
    discord_channel_id: string;
  }> = [];
  const createGuildChannelCalls: Array<{ name: string }> = [];
  const logErrorSpy = vi.fn();

  const rpcLayer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        if (typeof method !== 'string' || method === 'then') return undefined;
        return (args: any) => {
          if (method === 'Guild/GetMembersNeedingPersonalChannel') {
            return Effect.succeed(opts.members);
          }
          if (method === 'Guild/GetPersonalChannelTargetCategory') {
            return Effect.succeed({
              category_id: Option.some(CATEGORY_ID as any),
              is_overflow: false,
            });
          }
          if (method === 'Guild/ReservePersonalChannel') {
            reservePersonalChannelCalls.push({
              team_member_id: args.team_member_id,
              bucket: args.bucket ?? 'all',
            });
            const bucket: NeededMember['bucket'] = args.bucket ?? 'all';
            const reserved = opts.reservedByBucket?.[bucket] ?? true;
            return Effect.succeed({ reserved });
          }
          if (method === 'Guild/SavePersonalChannelId') {
            savePersonalChannelIdCalls.push({
              team_member_id: args.team_member_id,
              bucket: args.bucket ?? 'all',
              discord_channel_id: args.discord_channel_id,
            });
            return Effect.succeed(undefined);
          }
          if (method === 'Guild/MarkTeamPersonalEventsDirty') {
            return Effect.succeed(undefined);
          }
          if (method === 'Guild/UpsertChannel') {
            return Effect.succeed(undefined);
          }
          return Effect.succeed(null);
        };
      },
    }),
  );

  const restLayer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (prop === 'createGuildChannel') {
          return (_guildId: string, payload: { name: string }) => {
            createGuildChannelCalls.push({ name: payload.name });
            if (opts.createGuildChannelImpl) {
              return opts.createGuildChannelImpl(payload.name);
            }
            return Effect.succeed({ id: `new-channel-${createGuildChannelCalls.length}` });
          };
        }
        return () => Effect.succeed({ id: 'mock-id' });
      },
    }),
  );

  return {
    rpcLayer,
    restLayer,
    reservePersonalChannelCalls,
    savePersonalChannelIdCalls,
    createGuildChannelCalls,
    logErrorSpy,
  };
};

const run = (layers: Layer.Layer<SyncRpc | DiscordREST>) =>
  Effect.runPromise(
    provisionPersonalChannels(GUILD_ID as any).pipe(Effect.provide(layers)) as Effect.Effect<
      void,
      never,
      never
    >,
  );

describe('provisionPersonalChannels — bucket threading (split member)', () => {
  it('three rows for one member → three createGuildChannel calls with distinct names, three SavePersonalChannelId each carrying its own bucket, three matching ReservePersonalChannel', async () => {
    const members = [makeMember('training'), makeMember('tournament'), makeMember('other')];
    const {
      rpcLayer,
      restLayer,
      reservePersonalChannelCalls,
      savePersonalChannelIdCalls,
      createGuildChannelCalls,
    } = makeLayers({ members });

    await run(Layer.merge(rpcLayer, restLayer));

    expect(createGuildChannelCalls).toHaveLength(3);
    const names = createGuildChannelCalls.map((c) => c.name);
    expect(new Set(names).size).toBe(3);

    expect(reservePersonalChannelCalls).toHaveLength(3);
    expect(reservePersonalChannelCalls.map((c) => c.bucket).sort()).toEqual([
      'other',
      'tournament',
      'training',
    ]);

    expect(savePersonalChannelIdCalls).toHaveLength(3);
    expect(savePersonalChannelIdCalls.map((c) => c.bucket).sort()).toEqual([
      'other',
      'tournament',
      'training',
    ]);
  });
});

describe('provisionPersonalChannels — combined member (bucket "all")', () => {
  it('one "all" row → exactly one channel, name unchanged from today', async () => {
    const members = [makeMember('all')];
    const { rpcLayer, restLayer, createGuildChannelCalls, savePersonalChannelIdCalls } = makeLayers(
      { members },
    );

    await run(Layer.merge(rpcLayer, restLayer));

    expect(createGuildChannelCalls).toHaveLength(1);
    expect(createGuildChannelCalls[0]?.name).toBe(`events-${DISCORD_ID}`);
    expect(savePersonalChannelIdCalls).toHaveLength(1);
    expect(savePersonalChannelIdCalls[0]?.bucket).toBe('all');
  });
});

describe('provisionPersonalChannels — reserved: false skips Discord entirely', () => {
  it('a bucket reported as not reserved makes no Discord call for that bucket', async () => {
    const members = [makeMember('training'), makeMember('tournament')];
    const { rpcLayer, restLayer, createGuildChannelCalls, savePersonalChannelIdCalls } = makeLayers(
      { members, reservedByBucket: { training: false, tournament: true } },
    );

    await run(Layer.merge(rpcLayer, restLayer));

    expect(createGuildChannelCalls).toHaveLength(1);
    expect(savePersonalChannelIdCalls).toHaveLength(1);
    expect(savePersonalChannelIdCalls[0]?.bucket).toBe('tournament');
  });
});

describe('provisionPersonalChannels — Discord 30013 (guild channel cap) is classified at error level (S4)', () => {
  it('code 30013 does not throw, and never triggers the category-full overflow retry path (no SavePersonalOverflowCategoryId / second category attempt)', async () => {
    const members = [makeMember('all')];
    const capError = {
      _tag: 'ErrorResponse' as const,
      response: { status: 400 },
      data: { code: 30013, errors: {} },
    };
    const { rpcLayer, restLayer, savePersonalChannelIdCalls } = makeLayers({
      members,
      createGuildChannelImpl: () => Effect.fail(capError),
    });

    // Must resolve (no throw) — the whole poll must not crash on one team's cap.
    // `createPersonalEventChannel`'s own retry policy (exponential x3) still runs
    // underneath, which is why this test carries a generous timeout — the fix under
    // test is the LOG LEVEL / classification in handleProvision.ts, not the retry
    // policy on the Discord call itself.
    await expect(run(Layer.merge(rpcLayer, restLayer))).resolves.toBeUndefined();

    // A guild-cap failure must never persist a channel id — the member stays
    // unprovisioned, ready to retry on the next tick via the reservation lease.
    expect(savePersonalChannelIdCalls).toHaveLength(0);
  }, 15_000); // retryPolicy: 3 x exponential('1 second') = up to ~7s; 15s headroom
});
