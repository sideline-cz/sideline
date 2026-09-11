// NOTE: The shared events board (and its in-place "started" embed edit +
// recreate-on-10008 recovery) has been removed (remove-global-events-board,
// Release A). `handleStarted` now only posts the "Starting now" message
// (reminders channel / system-channel fallback) and deletes the training
// claim message. Tests below cover only that remaining behavior.

import type { EventRpcEvents } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import type { MessageCreateRequest } from 'dfx/types';

type CreateMessageCall = [string, MessageCreateRequest];

import { DateTime, Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { ChannelReorderSemaphore } from '~/rcp/event/ChannelReorderSemaphore.js';
import { handleStarted } from '~/rcp/event/handleStarted.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000010';
const GUILD_ID = '111111111111111111';
const EVENT_ID = '00000000-0000-0000-0000-000000000001';
const CHANNEL_ID = '222222222222222222';
const SYSTEM_CHANNEL_ID = '333333333333333333';
const ROLE_ID = '555555555555555555';

// Coach / claim constants
const COACH_ID = '666666666666666666';
const OWNERS_ROLE = '777777777777777777';
const CLAIM_THREAD_ID = '888888888888888888';
const CLAIM_MSG_ID = '999999999999999999';

const makeEvent = (
  overrides: Partial<EventRpcEvents.EventStartedEvent> = {},
): EventRpcEvents.EventStartedEvent =>
  ({
    _tag: 'event_started' as const,
    id: 'sync-1',
    team_id: TEAM_ID as any,
    guild_id: GUILD_ID as any,
    event_id: EVENT_ID as any,
    title: 'Saturday Match',
    start_at: DateTime.makeUnsafe('2026-05-01T16:00:00Z'),
    end_at: Option.none(),
    location: Option.none(),
    event_type: 'match',
    all_day: false,
    member_group_id: Option.none(),
    discord_channel_id: Option.some(CHANNEL_ID as any),
    discord_role_id: Option.none(),
    claimed_by_discord_id: Option.none(),
    start_date: Option.none(),
    end_date: Option.none(),
    ...overrides,
  }) as any;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type SyncRpcCalls = {
  GetYesAttendeesForEmbed: unknown[];
  GetClaimInfo: unknown[];
};

const makeRecordingSyncRpc = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
) => {
  const calls: SyncRpcCalls = {
    GetYesAttendeesForEmbed: [],
    GetClaimInfo: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    'Event/GetYesAttendeesForEmbed': (_args: any) => {
      calls.GetYesAttendeesForEmbed.push(_args);
      return Effect.succeed([]);
    },
    // Default: no stored claim info (no claim to delete)
    'Event/GetClaimInfo': (_args: any) => {
      calls.GetClaimInfo.push(_args);
      return Effect.succeed(
        Option.some({
          event_id: EVENT_ID,
          event_type: 'training',
          status: 'active',
          claimed_by_member_id: Option.none(),
          claimed_by_display_name: Option.none(),
          claim_discord_channel_id: Option.none(),
          claim_discord_message_id: Option.none(),
          claim_thread_id: Option.none(),
        }),
      );
    },
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        const fn = overrides[method] ?? defaults[method];
        return fn ?? (() => Effect.succeed(null));
      },
    }),
  );

  return { calls, layer };
};

type RestCalls = {
  createMessage: CreateMessageCall[];
  deleteMessage: unknown[][];
};

const makeRecordingDiscordREST = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
) => {
  const calls: RestCalls = { createMessage: [], deleteMessage: [] };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    createMessage: (...args: any[]) => {
      calls.createMessage.push(args as CreateMessageCall);
      return Effect.succeed({ id: 'new-msg-id' });
    },
    deleteMessage: (...args: any[]) => {
      calls.deleteMessage.push(args);
      return Effect.succeed(undefined);
    },
    getGuild: (_guildId: any) =>
      Effect.succeed({
        preferred_locale: 'en-US',
        system_channel_id: SYSTEM_CHANNEL_ID,
      }),
  };

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        const fn = overrides[method] ?? defaults[method];
        return fn ?? (() => Effect.succeed(null));
      },
    }),
  );

  return { calls, layer };
};

const run = (
  effect: Effect.Effect<void, any, SyncRpc | DiscordREST | ChannelReorderSemaphore>,
  layers: Layer.Layer<SyncRpc | DiscordREST>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.merge(layers, ChannelReorderSemaphore.Live))) as Effect.Effect<
      void,
      never,
      never
    >,
  );

describe('handleStarted', () => {
  // T11.1 — posts "Starting now" message to the event channel
  it('posts "Starting now" message to the event channel', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(makeEvent({ discord_channel_id: Option.some(CHANNEL_ID as any) })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.createMessage).toHaveLength(1);
    const [createChannelArg] = restCalls.createMessage[0] as [string, unknown];
    expect(createChannelArg).toBe(CHANNEL_ID);
  });

  // T11.4 — role mention rendered when discord_role_id is Some
  it('includes <@&roleId> mention prefix in content when discord_role_id is Some', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(makeEvent({ discord_role_id: Option.some(ROLE_ID as any) })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.createMessage).toHaveLength(1);
    const [_channelId, payload] = restCalls.createMessage[0] as [string, MessageCreateRequest];
    // The content field should include the role mention
    expect(typeof payload.content).toBe('string');
    expect(payload.content).toContain(`<@&${ROLE_ID}>`);
  });

  // T11.5 — role mention omitted when discord_role_id is None
  it('does NOT include role mention in content when discord_role_id is None', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(makeEvent({ discord_role_id: Option.none() })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.createMessage).toHaveLength(1);
    const [_channelId, payload] = restCalls.createMessage[0] as [string, MessageCreateRequest];
    // content should be absent or not contain a role mention
    const content = payload.content ?? '';
    expect(content).not.toContain('<@&');
  });

  // T11.6 — system_channel fallback when discord_channel_id is None
  it('falls back to system_channel_id when event discord_channel_id is None', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(makeEvent({ discord_channel_id: Option.none() })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.createMessage).toHaveLength(1);
    const [createChannelArg] = restCalls.createMessage[0] as [string, unknown];
    // Should have fallen back to the system channel
    expect(createChannelArg).toBe(SYSTEM_CHANNEL_ID);
  });

  // T11.7 — both channels None → no createMessage call
  it('does NOT call createMessage when both discord_channel_id and system_channel_id are absent', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST({
      getGuild: (_guildId: any) =>
        Effect.succeed({
          preferred_locale: 'en-US',
          system_channel_id: null,
        }),
    });

    await run(
      handleStarted(makeEvent({ discord_channel_id: Option.none() })),
      Layer.merge(rpcLayer, restLayer),
    );

    // No channel available → no message posted
    expect(restCalls.createMessage).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // T12.A — coach mention in "Starting now" post
  // -------------------------------------------------------------------------

  // T12.A.1 — Coach assigned → content contains <@COACH_ID>, NOT <@&, NOT warning text
  it('T12.A.1: training with coach → content mentions coach user, not role, not warning', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(
        makeEvent({
          event_type: 'training',
          discord_role_id: Option.some(OWNERS_ROLE as any),
          claimed_by_discord_id: Option.some(COACH_ID as any),
        }),
      ),
      Layer.merge(rpcLayer, restLayer),
    );

    const createCalls = restCalls.createMessage.filter(([channelId]) => channelId === CHANNEL_ID);
    expect(createCalls).toHaveLength(1);
    const [, payload] = createCalls[0] as [string, MessageCreateRequest];
    const content = payload.content ?? '';
    expect(content).toContain(`<@${COACH_ID}>`);
    expect(content).not.toContain('<@&');
    expect(payload.allowed_mentions?.users).toEqual([COACH_ID]);
    expect(
      Array.isArray(payload.allowed_mentions?.roles) ? payload.allowed_mentions.roles.length : 0,
    ).toBe(0);
  });

  // T12.A.2 — No coach, owners role present → content contains <@&OWNERS_ROLE> AND warning text
  it('T12.A.2: training with no coach + owners role → content mentions owners role + warning', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(
        makeEvent({
          event_type: 'training',
          discord_role_id: Option.some(OWNERS_ROLE as any),
          claimed_by_discord_id: Option.none(),
        }),
      ),
      Layer.merge(rpcLayer, restLayer),
    );

    const createCalls = restCalls.createMessage.filter(([channelId]) => channelId === CHANNEL_ID);
    expect(createCalls).toHaveLength(1);
    const [, payload] = createCalls[0] as [string, MessageCreateRequest];
    const content = payload.content ?? '';
    // Must ping owners role
    expect(content).toContain(`<@&${OWNERS_ROLE}>`);
    // Must contain the no-coach warning
    expect(content).toContain('coach');
    // Must NOT be a user ping
    expect(content).not.toMatch(/<@[^&]/);
    expect(payload.allowed_mentions?.roles).toEqual([OWNERS_ROLE]);
  });

  // T12.A.3 — No coach, no owners role → content is warning text only; no <@ mention
  it('T12.A.3: training with no coach and no owners role → warning text only, no mentions', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(
        makeEvent({
          event_type: 'training',
          discord_role_id: Option.none(),
          claimed_by_discord_id: Option.none(),
        }),
      ),
      Layer.merge(rpcLayer, restLayer),
    );

    const createCalls = restCalls.createMessage.filter(([channelId]) => channelId === CHANNEL_ID);
    expect(createCalls).toHaveLength(1);
    const [, payload] = createCalls[0] as [string, MessageCreateRequest];
    const content = payload.content ?? '';
    // Warning text present
    expect(content.length).toBeGreaterThan(0);
    // No Discord mention of any kind
    expect(content).not.toContain('<@');
    const allowedMentions = payload.allowed_mentions;
    expect(
      !allowedMentions ||
        ((!allowedMentions.roles || allowedMentions.roles.length === 0) &&
          (!allowedMentions.users || allowedMentions.users.length === 0)),
    ).toBe(true);
  });

  // T12.A.4 — Non-training event → member-group ping (existing behavior preserved)
  it('T12.A.4: non-training event (match) → member-group role ping, no warning text', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(
        makeEvent({
          event_type: 'match',
          discord_role_id: Option.some(ROLE_ID as any),
          claimed_by_discord_id: Option.none(),
        }),
      ),
      Layer.merge(rpcLayer, restLayer),
    );

    const createCalls = restCalls.createMessage.filter(([channelId]) => channelId === CHANNEL_ID);
    expect(createCalls).toHaveLength(1);
    const [, payload] = createCalls[0] as [string, MessageCreateRequest];
    const content = payload.content ?? '';
    // Must ping the member-group role, not an owners role
    expect(content).toContain(`<@&${ROLE_ID}>`);
    // Must NOT contain the no-coach warning text
    expect(content.toLowerCase()).not.toContain('coach');
  });

  // -------------------------------------------------------------------------
  // T12.B — delete-on-start (safeDeleteClaim branch)
  // -------------------------------------------------------------------------

  // T12.B.1 — Training with claim stored → deleteMessage called once with correct ids
  it('T12.B.1: training with stored claim → deleteMessage called once', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({
      'Event/GetClaimInfo': (_args: any) =>
        Effect.succeed(
          Option.some({
            event_id: EVENT_ID,
            event_type: 'training',
            status: 'active',
            claimed_by_member_id: Option.none(),
            claimed_by_display_name: Option.none(),
            claim_discord_channel_id: Option.some(CLAIM_THREAD_ID as any),
            claim_discord_message_id: Option.some(CLAIM_MSG_ID as any),
            claim_thread_id: Option.none(),
          }),
        ),
    });
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(makeEvent({ event_type: 'training' })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.deleteMessage).toHaveLength(1);
    const [threadId, msgId] = restCalls.deleteMessage[0] as [string, string];
    expect(threadId).toBe(CLAIM_THREAD_ID);
    expect(msgId).toBe(CLAIM_MSG_ID);
  });

  // T12.B.2 — Training with no stored claim → deleteMessage NOT called
  it('T12.B.2: training with no stored claim → deleteMessage not called', async () => {
    // Default mock returns claim_discord_channel_id: Option.none()
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(makeEvent({ event_type: 'training' })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.deleteMessage).toHaveLength(0);
  });

  // T12.B.3 — deleteMessage returns 10008 Unknown Message → swallowed, handler resolves
  it('T12.B.3: deleteMessage returns 10008 → error swallowed, handler succeeds', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({
      'Event/GetClaimInfo': (_args: any) =>
        Effect.succeed(
          Option.some({
            event_id: EVENT_ID,
            event_type: 'training',
            status: 'active',
            claimed_by_member_id: Option.none(),
            claimed_by_display_name: Option.none(),
            claim_discord_channel_id: Option.some(CLAIM_THREAD_ID as any),
            claim_discord_message_id: Option.some(CLAIM_MSG_ID as any),
            claim_thread_id: Option.none(),
          }),
        ),
    });
    const { layer: restLayer } = makeRecordingDiscordREST({
      deleteMessage: (..._args: any[]) =>
        // Simulate Discord "Unknown Message" error
        Effect.fail({
          _tag: 'ErrorResponse',
          data: { code: 10008 },
        }) as unknown as Effect.Effect<any>,
    });

    // Must resolve without throwing
    await expect(
      run(handleStarted(makeEvent({ event_type: 'training' })), Layer.merge(rpcLayer, restLayer)),
    ).resolves.not.toThrow();
  });

  // T12.B.4 — Non-training → GetClaimInfo and deleteMessage NOT called
  it('T12.B.4: non-training (match) → GetClaimInfo not called, deleteMessage not called', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(handleStarted(makeEvent({ event_type: 'match' })), Layer.merge(rpcLayer, restLayer));

    expect(rpcCalls.GetClaimInfo).toHaveLength(0);
    expect(restCalls.deleteMessage).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PR 1 — all-day events render a date, not a fake noon clock time.
// Plan: all-day-discord-start-time-plan.md §7.3 (Part I spec) + §18 §7.3 (v4 delta).
//
// NOTE on case 4a (all-day title): deferred to PR 4b, NOT part of PR 1.
// §18's delta asserts the all-day title switches to `bot_event_started_post_title_all_day`
// ("Dnes: {title}"). Per §15/§16 that key ships with the deferred team-local morning post
// (PR 4 / PR 4b), not with PR 1's §5 file list. The case was written here first, then moved
// out: referencing an i18n key that does not exist yet is a COMPILE error (TS2551), not a
// failing assertion, so leaving it in place would make PR 1 unmergeable on its own.
// The case is parked at scratchpad/deferred-case-4a.txt — re-add it with PR 4b.
// Case 4b (the timed sibling) stays here: it guards byte-identity of the unchanged path.
// ---------------------------------------------------------------------------
describe('handleStarted — all-day events (PR 1: render as a date, not a fake clock time)', () => {
  it('case 1: timed baseline is unchanged — description starts with exactly <t:1777651200:F>', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(
        makeEvent({
          all_day: false,
          start_at: DateTime.makeUnsafe('2026-05-01T16:00:00Z'),
          end_at: Option.some(DateTime.makeUnsafe('2026-05-01T18:00:00Z')),
        }),
      ),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.createMessage).toHaveLength(1);
    const [, payload] = restCalls.createMessage[0] as [string, MessageCreateRequest];
    const description = payload.embeds?.[0]?.description ?? '';
    expect(description.startsWith('<t:1777651200:F>')).toBe(true);
  });

  it('case 2: all-day, no end — description starts with exactly <t:1777636800:D> · All day, no F/f/R/t/d style', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(
        makeEvent({
          all_day: true,
          // Team-local midnight anchor (a Prague event on 2026-05-01 is stored at
          // 2026-04-30T22:00:00Z), NOT the retired noon-UTC sentinel. The byte-exact
          // assertion below (<t:1777636800:D>, noon UTC of 1 May) only passes if the
          // code reads `start_date`, not a UTC read of this instant (which would
          // yield 2026-04-30 — one day early).
          start_at: DateTime.makeUnsafe('2026-04-30T22:00:00Z'),
          start_date: Option.some('2026-05-01'),
          end_at: Option.none(),
        }),
      ),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.createMessage).toHaveLength(1);
    const [, payload] = restCalls.createMessage[0] as [string, MessageCreateRequest];
    const description = payload.embeds?.[0]?.description ?? '';
    expect(description.startsWith('<t:1777636800:D> · All day')).toBe(true);
    expect(description).not.toMatch(/<t:\d+:[FfRtd]>/);
  });

  it('case 3: all-day, multi-day — description starts with exactly <t:1777636800:D> — <t:1777809600:D> · All day', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(
        makeEvent({
          all_day: true,
          // Team-local midnight anchor, same reasoning as case 2.
          start_at: DateTime.makeUnsafe('2026-04-30T22:00:00Z'),
          start_date: Option.some('2026-05-01'),
          end_at: Option.some(DateTime.makeUnsafe('2026-05-02T22:00:00Z')),
          end_date: Option.some('2026-05-03'),
        }),
      ),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.createMessage).toHaveLength(1);
    const [, payload] = restCalls.createMessage[0] as [string, MessageCreateRequest];
    const description = payload.embeds?.[0]?.description ?? '';
    expect(description.startsWith('<t:1777636800:D> — <t:1777809600:D> · All day')).toBe(true);
  });

  it('case 2b (regression): reads start_date, not the UTC date of the team-local-midnight instant — proves B1 is fixed', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(
        makeEvent({
          all_day: true,
          // A Prague all-day event on 2026-09-16, stored at team-local midnight.
          // A UTC read of this instant yields 2026-09-15 — one day early. Reading
          // `start_date` (which the server derives in the team's own timezone)
          // yields the correct 2026-09-16.
          start_at: DateTime.makeUnsafe('2026-09-15T22:00:00Z'),
          start_date: Option.some('2026-09-16'),
          end_at: Option.none(),
        }),
      ),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.createMessage).toHaveLength(1);
    const [, payload] = restCalls.createMessage[0] as [string, MessageCreateRequest];
    const description = payload.embeds?.[0]?.description ?? '';
    // 2026-09-16T12:00:00Z === 1789560000
    expect(description.startsWith('<t:1789560000:D>')).toBe(true);
    // NOT the UTC date of start_at (2026-09-15T12:00:00Z === 1789473600)
    expect(description).not.toContain('<t:1789473600:D>');
  });

  // NOTE on case 4a: re-added here per PR 4 (§18 §15.5/§15.6 of the plan). It was
  // deliberately parked out of PR 1 (see the header note above) because the i18n key
  // `bot_event_started_post_title_all_day` did not exist yet and referencing a
  // non-existent named export from `@sideline/i18n/messages` would either be a
  // TS2551 compile error or (at vitest's esbuild-only runtime) a thrown
  // "m.bot_event_started_post_title_all_day is not a function" — both acceptable
  // RED states for TDD, but neither should be allowed to block PR 1 merging on its
  // own. PR 4 revives the key (§15.6: `Dnes: {title}` / `Today: {title}`) and the
  // `handleStarted.ts` all-day branch (§15.5) that selects it.
  it('case 4a: all-day → title switches to bot_event_started_post_title_all_day', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(handleStarted(makeEvent({ all_day: true })), Layer.merge(rpcLayer, restLayer));

    expect(restCalls.createMessage).toHaveLength(1);
    const [, payload] = restCalls.createMessage[0] as [string, MessageCreateRequest];
    expect(payload.embeds?.[0]?.title).toBe(
      m.bot_event_started_post_title_all_day({ title: 'Saturday Match' }, { locale: 'en' }),
    );
  });

  it('case 4b (sibling): timed → title stays bot_event_started_post_title, byte-identical to today', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(handleStarted(makeEvent({ all_day: false })), Layer.merge(rpcLayer, restLayer));

    expect(restCalls.createMessage).toHaveLength(1);
    const [, payload] = restCalls.createMessage[0] as [string, MessageCreateRequest];
    expect(payload.embeds?.[0]?.title).toBe(
      m.bot_event_started_post_title({ title: 'Saturday Match' }, { locale: 'en' }),
    );
  });

  it('case 5: the post still fires for all-day — exactly one createMessage call', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(handleStarted(makeEvent({ all_day: true })), Layer.merge(rpcLayer, restLayer));

    expect(restCalls.createMessage).toHaveLength(1);
  });

  it('case 6: routing undisturbed — role mention content/allowed_mentions unchanged for all-day', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(makeEvent({ all_day: true, discord_role_id: Option.some(ROLE_ID as any) })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.createMessage).toHaveLength(1);
    const [, payload] = restCalls.createMessage[0] as [string, MessageCreateRequest];
    expect(payload.content).toBe(`<@&${ROLE_ID}>`);
    expect(payload.allowed_mentions?.roles).toEqual([ROLE_ID]);
  });

  it('case 8: claim deletion still runs for all-day training events', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({
      'Event/GetClaimInfo': (_args: any) =>
        Effect.succeed(
          Option.some({
            event_id: EVENT_ID,
            event_type: 'training',
            status: 'active',
            claimed_by_member_id: Option.none(),
            claimed_by_display_name: Option.none(),
            claim_discord_channel_id: Option.some(CLAIM_THREAD_ID as any),
            claim_discord_message_id: Option.some(CLAIM_MSG_ID as any),
            claim_thread_id: Option.none(),
          }),
        ),
    });
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(makeEvent({ all_day: true, event_type: 'training' })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.deleteMessage).toHaveLength(1);
    const [threadId, msgId] = restCalls.deleteMessage[0] as [string, string];
    expect(threadId).toBe(CLAIM_THREAD_ID);
    expect(msgId).toBe(CLAIM_MSG_ID);
  });
});
