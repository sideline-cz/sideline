import type { EventRpcEvents } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import type { MessageCreateRequest } from 'dfx/types';
import { DateTime, Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { handleUnclaimedTrainingReminder } from '~/rcp/event/handleUnclaimedTrainingReminder.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '111111111111111111';
const EVENT_ID = '00000000-0000-0000-0000-000000000001';
const CHANNEL_ID = '222222222222222222';
const CLAIM_CHANNEL_ID = '333333333333333333';
const CLAIM_MESSAGE_ID = '444444444444444444';

const TIMED_START_AT = DateTime.makeUnsafe('2026-05-02T14:00:00Z');
const TIMED_EPOCH = 1777730400;
// Team-local midnight anchor (a Prague event on 2026-07-15 is stored at
// 2026-07-14T22:00:00Z, CEST +02:00), NOT the retired noon-UTC sentinel. `ALL_DAY_EPOCH`
// (noon UTC of 15 July) only matches if the code reads `start_date`, not a UTC read of
// `ALL_DAY_START_AT` (which would yield 2026-07-14 — one day early).
const ALL_DAY_START_AT = DateTime.makeUnsafe('2026-07-14T22:00:00Z');
const ALL_DAY_START_DATE = Option.some('2026-07-15');
const ALL_DAY_EPOCH = 1784116800; // :D> uses discordDateInstant(start_date) = noon UTC of 15 July
const ALL_DAY_START_AT_EPOCH = 1784066400; // :R> uses the raw start_at instant, unchanged

const makeEvent = (
  overrides: Partial<EventRpcEvents.UnclaimedTrainingReminderEvent> = {},
): EventRpcEvents.UnclaimedTrainingReminderEvent =>
  ({
    _tag: 'unclaimed_training_reminder' as const,
    id: 'sync-unclaimed-1',
    team_id: '00000000-0000-0000-0000-000000000010' as any,
    guild_id: GUILD_ID as any,
    event_id: EVENT_ID as any,
    title: 'Monday Training',
    start_at: TIMED_START_AT,
    end_at: Option.none(),
    location: Option.none(),
    location_url: Option.none(),
    discord_target_channel_id: Option.some(CHANNEL_ID as any),
    discord_role_id: Option.none(),
    claim_discord_channel_id: Option.none(),
    claim_discord_message_id: Option.none(),
    all_day: false,
    start_date: Option.none(),
    end_date: Option.none(),
    ...overrides,
  }) as any;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type CreateMessageCall = [string, MessageCreateRequest];

const makeRecordingDiscordREST = () => {
  const createMessageCalls: CreateMessageCall[] = [];

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        if (method === 'createMessage') {
          return (...args: any[]) => {
            createMessageCalls.push(args as CreateMessageCall);
            return Effect.succeed({ id: 'new-msg-id' });
          };
        }
        if (method === 'getGuild') {
          return () => Effect.succeed({ preferred_locale: 'en-US', system_channel_id: null });
        }
        return () => Effect.succeed(null);
      },
    }),
  );

  return { createMessageCalls, layer };
};

const run = (effect: Effect.Effect<void, any, DiscordREST>, layer: Layer.Layer<DiscordREST>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<void, never, never>);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleUnclaimedTrainingReminder', () => {
  it('timed baseline: description is bot_claim_unclaimed_reminder_description with {when} = <t:S:f> (<t:S:R>)', async () => {
    const { createMessageCalls, layer } = makeRecordingDiscordREST();

    await run(handleUnclaimedTrainingReminder(makeEvent()), layer);

    expect(createMessageCalls).toHaveLength(1);
    const [, payload] = createMessageCalls[0];
    const expectedWhen = `<t:${TIMED_EPOCH}:f> (<t:${TIMED_EPOCH}:R>)`;
    const expectedDescription = m.bot_claim_unclaimed_reminder_description(
      { when: expectedWhen },
      { locale: 'en' },
    );
    expect(payload.embeds?.[0]?.description).toBe(expectedDescription);
  });

  it('all-day: description is bot_claim_unclaimed_reminder_description_all_day with {when} = <t:S:D> (<t:S:R>) — no marker', async () => {
    const { createMessageCalls, layer } = makeRecordingDiscordREST();

    await run(
      handleUnclaimedTrainingReminder(
        makeEvent({ all_day: true, start_at: ALL_DAY_START_AT, start_date: ALL_DAY_START_DATE }),
      ),
      layer,
    );

    expect(createMessageCalls).toHaveLength(1);
    const [, payload] = createMessageCalls[0];
    const expectedWhen = `<t:${ALL_DAY_EPOCH}:D> (<t:${ALL_DAY_START_AT_EPOCH}:R>)`;
    const expectedDescription = m.bot_claim_unclaimed_reminder_description_all_day(
      { when: expectedWhen },
      { locale: 'en' },
    );
    expect(payload.embeds?.[0]?.description).toBe(expectedDescription);
  });

  it('all-day regression (B1): description reads start_date, not a UTC read of start_at', async () => {
    // A Prague all-day event on 2026-09-16, stored at team-local midnight. A UTC read of
    // this instant yields 2026-09-15 — one day early, for every viewer east of UTC (the
    // entire default fleet). Reading `start_date` yields the correct 2026-09-16.
    const startAt = DateTime.makeUnsafe('2026-09-15T22:00:00Z');
    const startDate = Option.some('2026-09-16');
    const correctEpoch = 1789560000; // 2026-09-16T12:00:00Z
    const wrongEpoch = 1789473600; // 2026-09-15T12:00:00Z (the bug's output)

    const { createMessageCalls, layer } = makeRecordingDiscordREST();

    await run(
      handleUnclaimedTrainingReminder(
        makeEvent({ all_day: true, start_at: startAt, start_date: startDate }),
      ),
      layer,
    );

    expect(createMessageCalls).toHaveLength(1);
    const [, payload] = createMessageCalls[0];
    const description = payload.embeds?.[0]?.description ?? '';
    expect(description).toContain(`<t:${correctEpoch}:D>`);
    expect(description).not.toContain(`<t:${wrongEpoch}:D>`);
  });

  it('timed: jump-link concatenation is appended verbatim when claim message ids are present', async () => {
    const { createMessageCalls, layer } = makeRecordingDiscordREST();

    await run(
      handleUnclaimedTrainingReminder(
        makeEvent({
          claim_discord_channel_id: Option.some(CLAIM_CHANNEL_ID as any),
          claim_discord_message_id: Option.some(CLAIM_MESSAGE_ID as any),
        }),
      ),
      layer,
    );

    expect(createMessageCalls).toHaveLength(1);
    const [, payload] = createMessageCalls[0];
    const expectedWhen = `<t:${TIMED_EPOCH}:f> (<t:${TIMED_EPOCH}:R>)`;
    const expectedJumpLink = `https://discord.com/channels/${GUILD_ID}/${CLAIM_CHANNEL_ID}/${CLAIM_MESSAGE_ID}`;
    const expectedDescription = `${m.bot_claim_unclaimed_reminder_description({ when: expectedWhen }, { locale: 'en' })}\n[${m.bot_claim_unclaimed_reminder_jump({}, { locale: 'en' })}](${expectedJumpLink})`;
    expect(payload.embeds?.[0]?.description).toBe(expectedDescription);
  });

  it('all-day: jump-link concatenation is byte-identical in shape to the timed case', async () => {
    const { createMessageCalls, layer } = makeRecordingDiscordREST();

    await run(
      handleUnclaimedTrainingReminder(
        makeEvent({
          all_day: true,
          start_at: ALL_DAY_START_AT,
          start_date: ALL_DAY_START_DATE,
          claim_discord_channel_id: Option.some(CLAIM_CHANNEL_ID as any),
          claim_discord_message_id: Option.some(CLAIM_MESSAGE_ID as any),
        }),
      ),
      layer,
    );

    expect(createMessageCalls).toHaveLength(1);
    const [, payload] = createMessageCalls[0];
    const expectedWhen = `<t:${ALL_DAY_EPOCH}:D> (<t:${ALL_DAY_START_AT_EPOCH}:R>)`;
    const expectedJumpLink = `https://discord.com/channels/${GUILD_ID}/${CLAIM_CHANNEL_ID}/${CLAIM_MESSAGE_ID}`;
    const expectedDescription = `${m.bot_claim_unclaimed_reminder_description_all_day({ when: expectedWhen }, { locale: 'en' })}\n[${m.bot_claim_unclaimed_reminder_jump({}, { locale: 'en' })}](${expectedJumpLink})`;
    expect(payload.embeds?.[0]?.description).toBe(expectedDescription);
  });

  it('payload without all_day (decoding default) renders as timed and does not throw', async () => {
    const { createMessageCalls, layer } = makeRecordingDiscordREST();

    const event = makeEvent() as any;
    delete event.all_day;

    await run(handleUnclaimedTrainingReminder(event), layer);

    expect(createMessageCalls).toHaveLength(1);
    const [, payload] = createMessageCalls[0];
    const expectedWhen = `<t:${TIMED_EPOCH}:f> (<t:${TIMED_EPOCH}:R>)`;
    const expectedDescription = m.bot_claim_unclaimed_reminder_description(
      { when: expectedWhen },
      { locale: 'en' },
    );
    expect(payload.embeds?.[0]?.description).toBe(expectedDescription);
  });
});
