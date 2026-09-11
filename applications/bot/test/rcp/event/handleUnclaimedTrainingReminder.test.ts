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
const ALL_DAY_START_AT = DateTime.makeUnsafe('2026-07-15T12:00:00Z');
const ALL_DAY_EPOCH = 1784116800;

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
      handleUnclaimedTrainingReminder(makeEvent({ all_day: true, start_at: ALL_DAY_START_AT })),
      layer,
    );

    expect(createMessageCalls).toHaveLength(1);
    const [, payload] = createMessageCalls[0];
    const expectedWhen = `<t:${ALL_DAY_EPOCH}:D> (<t:${ALL_DAY_EPOCH}:R>)`;
    const expectedDescription = m.bot_claim_unclaimed_reminder_description_all_day(
      { when: expectedWhen },
      { locale: 'en' },
    );
    expect(payload.embeds?.[0]?.description).toBe(expectedDescription);
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
          claim_discord_channel_id: Option.some(CLAIM_CHANNEL_ID as any),
          claim_discord_message_id: Option.some(CLAIM_MESSAGE_ID as any),
        }),
      ),
      layer,
    );

    expect(createMessageCalls).toHaveLength(1);
    const [, payload] = createMessageCalls[0];
    const expectedWhen = `<t:${ALL_DAY_EPOCH}:D> (<t:${ALL_DAY_EPOCH}:R>)`;
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
