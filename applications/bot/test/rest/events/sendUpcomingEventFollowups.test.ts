// Nastavitelná docházka (plan §7.10, §10.1). `sendUpcomingEventFollowups`
// (the /event list ephemeral-cards path — buildUpcomingEventEmbed's SECOND
// caller) must also honour show_attendee_list. Wiring only the
// personal-channel caller (buildPersonalEventMessage) would leave a member
// who hid the attendee list still seeing every name the moment they run
// /event list.

import { EventRpcModels } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { sendUpcomingEventFollowups } from '~/rest/events/sendUpcomingEventFollowups.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const FUTURE_START = DateTime.makeUnsafe('2099-06-01T18:00:00Z');

const makeEntry = (
  overrides: Partial<
    ConstructorParameters<typeof EventRpcModels.UpcomingEventForUserEntry>[0]
  > = {},
): EventRpcModels.UpcomingEventForUserEntry =>
  new EventRpcModels.UpcomingEventForUserEntry({
    event_id: 'event-1',
    team_id: 'team-1',
    title: 'Training Session',
    description: Option.none(),
    image_url: Option.none(),
    start_at: FUTURE_START,
    end_at: Option.none(),
    location: Option.none(),
    location_url: Option.none(),
    event_type: 'training',
    yes_count: 2,
    no_count: 0,
    maybe_count: 0,
    coming_later_count: 0,
    my_response: Option.some('yes'),
    my_message: Option.none(),
    all_day: false,
    status: 'active',
    event_type_name: Option.none(),
    event_type_color: Option.none(),
    start_date: Option.none(),
    end_date: Option.none(),
    rsvp_closes_at: Option.none(),
    ...overrides,
  });

const makeRpcLayer = () =>
  Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        if (typeof method !== 'string' || method === 'then') return undefined;
        return () => {
          if (method === 'Event/GetYesAttendeesForEmbed') {
            return Effect.succeed([
              {
                discord_id: Option.none(),
                name: Option.some('Alice'),
                nickname: Option.none(),
                username: Option.none(),
                display_name: Option.none(),
                response: 'yes',
                message: Option.none(),
              },
            ]);
          }
          return Effect.succeed(null);
        };
      },
    }),
  );

const makeRest = () => {
  const executeWebhookCalls: Array<{ payload: unknown }> = [];
  const rest: any = {
    executeWebhook: (_appId: string, _token: string, opts: { payload: unknown }) => {
      executeWebhookCalls.push({ payload: opts.payload });
      return Effect.succeed({ id: `msg-${executeWebhookCalls.length}` });
    },
    updateWebhookMessage: () => Effect.succeed({}),
  };
  return { rest, executeWebhookCalls };
};

const run = (effect: Effect.Effect<void, any, SyncRpc>, layer: Layer.Layer<SyncRpc>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<void, never, never>);

describe('sendUpcomingEventFollowups — showAttendeeList: false hides the Going field', () => {
  it('every ephemeral card sent via executeWebhook lacks the bot_embed_going field, even though GetYesAttendeesForEmbed returned names', async () => {
    const rpcLayer = makeRpcLayer();
    const { rest, executeWebhookCalls } = makeRest();

    await run(
      sendUpcomingEventFollowups({
        rest,
        applicationId: 'app-1',
        interactionToken: 'token-1',
        events: [makeEntry()],
        total: 1,
        locale: 'en',
        showAttendeeList: false,
      } as any),
      rpcLayer,
    );

    expect(executeWebhookCalls).toHaveLength(1);
    const json = JSON.stringify(executeWebhookCalls[0]?.payload);
    expect(json).not.toContain('Alice');
  });
});

describe('sendUpcomingEventFollowups — showAttendeeList: true keeps the Going field', () => {
  it('the field is present — this is the /event list half of Setting 1', async () => {
    const rpcLayer = makeRpcLayer();
    const { rest, executeWebhookCalls } = makeRest();

    await run(
      sendUpcomingEventFollowups({
        rest,
        applicationId: 'app-1',
        interactionToken: 'token-1',
        events: [makeEntry()],
        total: 1,
        locale: 'en',
        showAttendeeList: true,
      } as any),
      rpcLayer,
    );

    expect(executeWebhookCalls).toHaveLength(1);
    const json = JSON.stringify(executeWebhookCalls[0]?.payload);
    expect(json).toContain('Alice');
  });
});
