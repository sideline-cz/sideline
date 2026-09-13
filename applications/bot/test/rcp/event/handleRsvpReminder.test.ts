import type { EventRpcEvents } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import type { MessageCreateRequest } from 'dfx/types';
import { DateTime, Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { handleRsvpReminder } from '~/rcp/event/handleRsvpReminder.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000010';
const GUILD_ID = '111111111111111111';
const EVENT_ID = '00000000-0000-0000-0000-000000000001';
const CHANNEL_ID = '222222222222222222';
const SYSTEM_CHANNEL_ID = '333333333333333333';
const ROLE_ID = '555555555555555555';

const NON_RESPONDER_WITH_CHANNEL_ID = '600000000000000001';
const NON_RESPONDER_WITHOUT_CHANNEL_ID = '600000000000000002';
const PERSONAL_CHANNEL_ID = '700000000000000001';

// A single seeded non-responder — used whenever a test needs the DM path to fire.
// The channel-summary post (`postChannel`) is gone; the per-non-responder DM is the
// only reminder that reaches Discord (see Task 2 of the training-notifications-fix plan).
//
// Note: no personal channel is seeded alongside this member (`personalChannels`
// defaults to `[]`), so its DM link falls through to the reminders-channel /
// guild-level fallback rather than the personal-channel branch.
const ONE_NON_RESPONDER_SEED = [
  {
    discord_id: Option.some(NON_RESPONDER_WITH_CHANNEL_ID as any),
    name: Option.some('Alice'),
    nickname: Option.none(),
    username: Option.none(),
    display_name: Option.none(),
  },
];

const makeEvent = (
  overrides: Partial<EventRpcEvents.RsvpReminderEvent> = {},
): EventRpcEvents.RsvpReminderEvent =>
  ({
    _tag: 'rsvp_reminder' as const,
    id: 'sync-2',
    team_id: TEAM_ID as any,
    guild_id: GUILD_ID as any,
    event_id: EVENT_ID as any,
    title: 'Training Session',
    start_at: DateTime.makeUnsafe('2026-05-02T14:00:00Z'),
    discord_channel_id: Option.some(CHANNEL_ID as any),
    member_group_id: Option.none(),
    discord_role_id: Option.none(),
    all_day: false,
    start_date: Option.none(),
    ...overrides,
  }) as any;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type CreateMessageCall = [string, MessageCreateRequest];

const makeRecordingSyncRpc = (
  overrides: {
    nonResponders?: ReadonlyArray<{
      discord_id: Option.Option<string>;
      name: Option.Option<string>;
      nickname: Option.Option<string>;
      username: Option.Option<string>;
      display_name: Option.Option<string>;
    }>;
    personalChannels?: ReadonlyArray<{
      team_member_id: string;
      discord_id: string;
      personal_channel_id: string;
    }>;
  } = {},
) => {
  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        if (method === 'Event/GetRsvpReminderSummary') {
          return () =>
            Effect.succeed({
              yesCount: 2,
              noCount: 1,
              maybeCount: 0,
              nonResponders: overrides.nonResponders ?? [],
              yesAttendees: [],
            });
        }
        if (method === 'Guild/ListPersonalChannelsForEvent') {
          return () => Effect.succeed(overrides.personalChannels ?? []);
        }
        return () => Effect.succeed(null);
      },
    }),
  );
  return { layer };
};

const makeRecordingDiscordREST = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
) => {
  const createMessageCalls: CreateMessageCall[] = [];
  const createDmCalls: Array<{ recipient_id: string }> = [];

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    createMessage: (...args: any[]) => {
      createMessageCalls.push(args as CreateMessageCall);
      return Effect.succeed({ id: 'new-msg-id' });
    },
    getGuild: (_guildId: any) =>
      Effect.succeed({
        preferred_locale: 'en-US',
        system_channel_id: SYSTEM_CHANNEL_ID,
      }),
    createDm: (...args: any[]) => {
      createDmCalls.push(args[0]);
      return Effect.succeed({ id: 'dm-channel-id' });
    },
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

  return { createMessageCalls, createDmCalls, layer };
};

const run = (
  effect: Effect.Effect<void, any, SyncRpc | DiscordREST>,
  layers: Layer.Layer<SyncRpc | DiscordREST>,
) => Effect.runPromise(effect.pipe(Effect.provide(layers)) as Effect.Effect<void, never, never>);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleRsvpReminder — no member-group role mention', () => {
  it('does NOT include role mention in the DM content when discord_role_id is Some', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({ nonResponders: ONE_NON_RESPONDER_SEED });
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleRsvpReminder(makeEvent({ discord_role_id: Option.some(ROLE_ID as any) })),
      Layer.merge(rpcLayer, restLayer),
    );

    const dmCall = createMessageCalls.find(([channelId]) => channelId === 'dm-channel-id');
    expect(dmCall).toBeDefined();
    const content = dmCall?.[1].content ?? '';
    expect(content).not.toContain('<@&');
  });

  it('does NOT include role mention in the DM content when discord_role_id is None', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({ nonResponders: ONE_NON_RESPONDER_SEED });
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleRsvpReminder(makeEvent({ discord_role_id: Option.none() })),
      Layer.merge(rpcLayer, restLayer),
    );

    const dmCall = createMessageCalls.find(([channelId]) => channelId === 'dm-channel-id');
    expect(dmCall).toBeDefined();
    const content = dmCall?.[1].content ?? '';
    expect(content).not.toContain('<@&');
  });

  it('does NOT set allowed_mentions.roles on the DM when discord_role_id is Some', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({ nonResponders: ONE_NON_RESPONDER_SEED });
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleRsvpReminder(makeEvent({ discord_role_id: Option.some(ROLE_ID as any) })),
      Layer.merge(rpcLayer, restLayer),
    );

    const dmCall = createMessageCalls.find(([channelId]) => channelId === 'dm-channel-id');
    expect(dmCall).toBeDefined();
    const roles = dmCall?.[1].allowed_mentions?.roles ?? [];
    expect(roles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Per-member personal channel link (remove-global-events-board, Release A):
// each non-responder's DM should link to THEIR OWN personal events channel,
// falling back to the reminder-channel link when they don't have one.
// ---------------------------------------------------------------------------

describe('handleRsvpReminder — per-member personal channel link', () => {
  it('links a non-responder with a personal channel to their own personal channel', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({
      nonResponders: [
        {
          discord_id: Option.some(NON_RESPONDER_WITH_CHANNEL_ID as any),
          name: Option.some('Alice'),
          nickname: Option.none(),
          username: Option.none(),
          display_name: Option.none(),
        },
      ],
      personalChannels: [
        {
          team_member_id: 'member-1' as any,
          discord_id: NON_RESPONDER_WITH_CHANNEL_ID as any,
          personal_channel_id: PERSONAL_CHANNEL_ID as any,
        },
      ],
    });
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(handleRsvpReminder(makeEvent()), Layer.merge(rpcLayer, restLayer));

    // One createMessage for the reminder-channel post, one for the DM.
    const dmCall = createMessageCalls.find(([channelId]) => channelId === 'dm-channel-id');
    expect(dmCall).toBeDefined();
    const description = dmCall?.[1].embeds?.[0]?.description ?? '';
    expect(description).toContain(
      `https://discord.com/channels/${GUILD_ID}/${PERSONAL_CHANNEL_ID}`,
    );
  });

  it('falls back to the reminder-channel link for a non-responder without a personal channel', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({
      nonResponders: [
        {
          discord_id: Option.some(NON_RESPONDER_WITHOUT_CHANNEL_ID as any),
          name: Option.some('Bob'),
          nickname: Option.none(),
          username: Option.none(),
          display_name: Option.none(),
        },
      ],
      personalChannels: [],
    });
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(handleRsvpReminder(makeEvent()), Layer.merge(rpcLayer, restLayer));

    const dmCall = createMessageCalls.find(([channelId]) => channelId === 'dm-channel-id');
    expect(dmCall).toBeDefined();
    const description = dmCall?.[1].embeds?.[0]?.description ?? '';
    expect(description).toContain(`https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}`);
    expect(description).not.toContain(PERSONAL_CHANNEL_ID);
  });
});

// ---------------------------------------------------------------------------
// PR 2 — event.all_day rendering (channel embed field + DM sentence).
//
// handleRsvpReminder.ts:54 must compose `formatEventWhen(...) (<t:S:R>)` for
// the channel embed field, and branch the DM key on event.all_day between
// bot_rsvp_reminder_dm and bot_rsvp_reminder_dm_all_day — the latter must NOT
// carry the " · All day" marker inside its {when} (A1b). The `(<t:S:R>)`
// relative suffix must survive for timed events either way.
// ---------------------------------------------------------------------------

describe('handleRsvpReminder — all_day rendering (PR 2)', () => {
  // Team-local midnight anchor (a Prague event on 2026-07-15 is stored at
  // 2026-07-14T22:00:00Z, CEST +02:00), NOT the retired noon-UTC sentinel. `ALL_DAY_EPOCH`
  // (noon UTC of 15 July) only matches if the code reads `start_date`, not a UTC read of
  // `ALL_DAY_START_AT` (which would yield 2026-07-14 — one day early).
  const ALL_DAY_START_AT = DateTime.makeUnsafe('2026-07-14T22:00:00Z');
  const ALL_DAY_START_DATE = Option.some('2026-07-15');
  const ALL_DAY_EPOCH = 1784116800; // :D> uses discordDateInstant(start_date) = noon UTC of 15 July
  const ALL_DAY_START_AT_EPOCH = 1784066400; // :R> uses the raw start_at instant, unchanged
  const TIMED_START_AT = DateTime.makeUnsafe('2026-05-02T14:00:00Z');
  const TIMED_EPOCH = 1777730400;

  const ONE_NON_RESPONDER = [
    {
      discord_id: Option.some(NON_RESPONDER_WITH_CHANNEL_ID as any),
      name: Option.some('Alice'),
      nickname: Option.none(),
      username: Option.none(),
      display_name: Option.none(),
    },
  ];

  it('all-day: DM uses bot_rsvp_reminder_dm_all_day with {when} = <t:S:D> (<t:S:R>) — no marker', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({ nonResponders: ONE_NON_RESPONDER });
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleRsvpReminder(
        makeEvent({ all_day: true, start_at: ALL_DAY_START_AT, start_date: ALL_DAY_START_DATE }),
      ),
      Layer.merge(rpcLayer, restLayer),
    );

    const dmCall = createMessageCalls.find(([channelId]) => channelId === 'dm-channel-id');
    expect(dmCall).toBeDefined();
    const expectedWhen = `<t:${ALL_DAY_EPOCH}:D> (<t:${ALL_DAY_START_AT_EPOCH}:R>)`;
    const expectedDescription = m.bot_rsvp_reminder_dm_all_day(
      {
        title: 'Training Session',
        when: expectedWhen,
        link: `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}`,
      },
      { locale: 'en' },
    );
    expect(dmCall?.[1].embeds?.[0]?.description).toBe(expectedDescription);
  });

  it('all-day regression (B1): DM sentence reads start_date, not a UTC read of start_at', async () => {
    // A Prague all-day event on 2026-09-16, stored at team-local midnight. A UTC read of
    // this instant yields 2026-09-15 — one day early, for every viewer east of UTC (the
    // entire default fleet). Reading `start_date` yields the correct 2026-09-16.
    const startAt = DateTime.makeUnsafe('2026-09-15T22:00:00Z');
    const startDate = Option.some('2026-09-16');
    const correctEpoch = 1789560000; // 2026-09-16T12:00:00Z
    const wrongEpoch = 1789473600; // 2026-09-15T12:00:00Z (the bug's output)

    const { layer: rpcLayer } = makeRecordingSyncRpc({ nonResponders: ONE_NON_RESPONDER });
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleRsvpReminder(makeEvent({ all_day: true, start_at: startAt, start_date: startDate })),
      Layer.merge(rpcLayer, restLayer),
    );

    const dmCall = createMessageCalls.find(([channelId]) => channelId === 'dm-channel-id');
    const description = dmCall?.[1].embeds?.[0]?.description ?? '';
    expect(description).toContain(`<t:${correctEpoch}:D>`);
    expect(description).not.toContain(`<t:${wrongEpoch}:D>`);
  });

  it('timed: DM uses bot_rsvp_reminder_dm with the same {when} as the channel field', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({ nonResponders: ONE_NON_RESPONDER });
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleRsvpReminder(makeEvent({ all_day: false, start_at: TIMED_START_AT })),
      Layer.merge(rpcLayer, restLayer),
    );

    const dmCall = createMessageCalls.find(([channelId]) => channelId === 'dm-channel-id');
    expect(dmCall).toBeDefined();
    const expectedWhen = `<t:${TIMED_EPOCH}:f> (<t:${TIMED_EPOCH}:R>)`;
    const expectedDescription = m.bot_rsvp_reminder_dm(
      {
        title: 'Training Session',
        when: expectedWhen,
        link: `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}`,
      },
      { locale: 'en' },
    );
    expect(dmCall?.[1].embeds?.[0]?.description).toBe(expectedDescription);
  });

  it('payload without all_day (decoding default) renders as timed and does not throw', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({ nonResponders: ONE_NON_RESPONDER });
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();

    const event = makeEvent({ start_at: TIMED_START_AT }) as any;
    delete event.all_day;

    await run(handleRsvpReminder(event), Layer.merge(rpcLayer, restLayer));

    const dmCall = createMessageCalls.find(([channelId]) => channelId === 'dm-channel-id');
    expect(dmCall).toBeDefined();
    const expectedWhen = `<t:${TIMED_EPOCH}:f> (<t:${TIMED_EPOCH}:R>)`;
    const expectedDescription = m.bot_rsvp_reminder_dm(
      {
        title: 'Training Session',
        when: expectedWhen,
        link: `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}`,
      },
      { locale: 'en' },
    );
    expect(dmCall?.[1].embeds?.[0]?.description).toBe(expectedDescription);
  });
});

// ---------------------------------------------------------------------------
// The reminder-dispatch summary post is gone (Task 2 of the
// training-notifications-fix plan): the per-non-responder DM is now the only
// reminder that reaches Discord. Nothing should ever be posted to the
// reminder channel (`event.discord_channel_id` / the guild system channel).
// ---------------------------------------------------------------------------

describe('handleRsvpReminder — no reminder-channel summary post', () => {
  it('posts nothing to the reminder channel; exactly one DM goes out for one non-responder', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({ nonResponders: ONE_NON_RESPONDER_SEED });
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(handleRsvpReminder(makeEvent()), Layer.merge(rpcLayer, restLayer));

    expect(createMessageCalls.find(([channelId]) => channelId === CHANNEL_ID)).toBeUndefined();
    expect(
      createMessageCalls.find(([channelId]) => channelId === SYSTEM_CHANNEL_ID),
    ).toBeUndefined();
    const dmCalls = createMessageCalls.filter(([channelId]) => channelId === 'dm-channel-id');
    expect(dmCalls).toHaveLength(1);
  });

  it('sends zero Discord messages when there are no non-responders', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({ nonResponders: [] });
    const { createMessageCalls, createDmCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(handleRsvpReminder(makeEvent()), Layer.merge(rpcLayer, restLayer));

    expect(createMessageCalls).toHaveLength(0);
    expect(createDmCalls).toHaveLength(0);
  });

  it('still sends DMs when no channel is resolvable (no discord_channel_id, no guild system channel), using the guild-level link', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({ nonResponders: ONE_NON_RESPONDER_SEED });
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST({
      getGuild: (_guildId: any) =>
        Effect.succeed({
          preferred_locale: 'en-US',
          system_channel_id: null,
        }),
    });

    await run(
      handleRsvpReminder(makeEvent({ discord_channel_id: Option.none() })),
      Layer.merge(rpcLayer, restLayer),
    );

    const dmCall = createMessageCalls.find(([channelId]) => channelId === 'dm-channel-id');
    expect(dmCall).toBeDefined();
    const description = dmCall?.[1].embeds?.[0]?.description ?? '';
    // Pin the bare guild form. A plain `toContain` of the guild id would also match the
    // channel-link form (`.../{guild}/{channel}`), so match the closing paren of the
    // markdown link to prove the fallback really bottomed out at the guild level.
    expect(description).toContain(`(https://discord.com/channels/${GUILD_ID})`);
  });

  it('sends exactly one DM per non-responder that has a linked discord_id', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({
      nonResponders: [
        {
          discord_id: Option.some(NON_RESPONDER_WITH_CHANNEL_ID as any),
          name: Option.some('Alice'),
          nickname: Option.none(),
          username: Option.none(),
          display_name: Option.none(),
        },
        {
          discord_id: Option.none(),
          name: Option.some('No Discord Link'),
          nickname: Option.none(),
          username: Option.none(),
          display_name: Option.none(),
        },
      ],
    });
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(handleRsvpReminder(makeEvent()), Layer.merge(rpcLayer, restLayer));

    const dmCalls = createMessageCalls.filter(([channelId]) => channelId === 'dm-channel-id');
    expect(dmCalls).toHaveLength(1);
  });
});
