import { describe, expect, it } from '@effect/vitest';
import { Option, Schema } from 'effect';
import {
  EventCreatedEvent,
  EventRosterApprovalRequestEvent,
  RsvpReminderEvent,
  TrainingClaimRequestEvent,
  TrainingClaimUpdateEvent,
  UnclaimedTrainingReminderEvent,
  UnprocessedEventSyncEvent,
} from '~/rpc/event/EventRpcEvents.js';

// Release A expand/contract invariant (remove-global-events-board): the
// server no longer syncs a global events channel, so it stops populating
// `discord_channel_id`, but pre-Release-A pending sync rows may still carry
// an explicit null. These tests pin the wire shape until the field + this
// class are deleted in Release B.
describe('EventCreatedEvent discord_channel_id (transitional)', () => {
  const base = {
    _tag: 'event_created' as const,
    id: 'evt-1',
    team_id: '11111111-1111-1111-1111-111111111111',
    guild_id: '123456789012345678',
    event_id: '22222222-2222-2222-2222-222222222222',
    title: 'Match',
    description: null,
    image_url: null,
    start_at: '2026-05-01T16:00:00.000Z',
    end_at: null,
    location: null,
    location_url: null,
    event_type: 'match',
    all_day: false,
  };

  it('decodes a missing key to None (Release A server emission)', () => {
    const decoded = Schema.decodeUnknownSync(EventCreatedEvent)(base);
    expect(Option.isNone(decoded.discord_channel_id)).toBe(true);
  });

  it('decodes an explicit null to None (pre-Release-A pending rows)', () => {
    const decoded = Schema.decodeUnknownSync(EventCreatedEvent)({
      ...base,
      discord_channel_id: null,
    });
    expect(Option.isNone(decoded.discord_channel_id)).toBe(true);
  });

  it('encodes None as an explicit null key, never omitted (old-consumer compat)', () => {
    const decoded = Schema.decodeUnknownSync(EventCreatedEvent)(base);
    const encoded = Schema.encodeSync(EventCreatedEvent)(decoded);
    expect(Object.hasOwn(encoded, 'discord_channel_id')).toBe(true);
    expect(encoded.discord_channel_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PR 2 — `all_day` skew guard on the five remaining event-sync payloads.
//
// A not-yet-upgraded server omits `all_day` entirely. Without
// `withDecodingDefaultKey`, ONE such row fails the whole batch decode of
// `Event/GetUnprocessedEvents` and stops the entire Discord event sync — see
// applications/bot/src/rcp/event/ProcessorService.ts:96-108 and §8.2 of the
// plan. `withDecodingDefaultKey` tolerates a MISSING key, not an explicit
// `null` — a server that sends `all_day: null` is sending a different kind
// of malformed payload and must still fail loudly.
// ---------------------------------------------------------------------------

const TEAM_ID = '11111111-1111-1111-1111-111111111111';
const GUILD_ID = '123456789012345678';
const EVENT_ID = '22222222-2222-2222-2222-222222222222';

type AllDayFixture = {
  readonly name: string;
  readonly schema: Schema.Codec<any, any>;
  readonly base: Record<string, unknown>;
};

const fixtures: ReadonlyArray<AllDayFixture> = [
  {
    name: 'RsvpReminderEvent',
    schema: RsvpReminderEvent,
    base: {
      _tag: 'rsvp_reminder',
      id: 'sync-rsvp-1',
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      event_id: EVENT_ID,
      title: 'Training',
      start_at: '2026-05-01T16:00:00.000Z',
      discord_channel_id: null,
      member_group_id: null,
      discord_role_id: null,
    },
  },
  {
    name: 'TrainingClaimRequestEvent',
    schema: TrainingClaimRequestEvent,
    base: {
      _tag: 'training_claim_request',
      id: 'sync-claim-req-1',
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      event_id: EVENT_ID,
      title: 'Training',
      start_at: '2026-05-01T16:00:00.000Z',
      end_at: null,
      location: null,
      location_url: null,
      description: null,
      discord_target_channel_id: null,
      discord_role_id: null,
      owner_group_id: null,
    },
  },
  {
    name: 'TrainingClaimUpdateEvent',
    schema: TrainingClaimUpdateEvent,
    base: {
      _tag: 'training_claim_update',
      id: 'sync-claim-upd-1',
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      event_id: EVENT_ID,
      title: 'Training',
      start_at: '2026-05-01T16:00:00.000Z',
      end_at: null,
      location: null,
      location_url: null,
      description: null,
      claim_discord_channel_id: null,
      claim_discord_message_id: null,
      claimed_by_member_id: null,
      claimed_by_discord_id: null,
      claimed_by_name: null,
      claimed_by_nickname: null,
      claimed_by_display_name: null,
      claimed_by_username: null,
      event_status: 'active',
    },
  },
  {
    name: 'UnclaimedTrainingReminderEvent',
    schema: UnclaimedTrainingReminderEvent,
    base: {
      _tag: 'unclaimed_training_reminder',
      id: 'sync-unclaimed-1',
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      event_id: EVENT_ID,
      title: 'Training',
      start_at: '2026-05-01T16:00:00.000Z',
      end_at: null,
      location: null,
      location_url: null,
      discord_target_channel_id: null,
      discord_role_id: null,
      claim_discord_channel_id: null,
      claim_discord_message_id: null,
    },
  },
  {
    name: 'EventRosterApprovalRequestEvent',
    schema: EventRosterApprovalRequestEvent,
    base: {
      _tag: 'event_roster_approval_request',
      id: 'sync-roster-1',
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      event_id: EVENT_ID,
      event_roster_id: 'roster-evt-1',
      roster_id: 'roster-1',
      team_member_id: 'member-1',
      candidate_discord_id: null,
      candidate_display_name: null,
      title: 'Summer Tournament',
      start_at: '2026-05-01T16:00:00.000Z',
      owners_thread_id: null,
      owner_channel_id: null,
      roster_name: null,
    },
  },
];

describe('PR 2 — all_day skew guard on the five remaining event-sync payloads', () => {
  for (const { name, schema, base } of fixtures) {
    describe(name, () => {
      it('decodes with the all_day key entirely absent to all_day === false', () => {
        expect(Object.hasOwn(base, 'all_day')).toBe(false);
        const decoded: any = Schema.decodeUnknownSync(schema)(base);
        expect(decoded.all_day).toBe(false);
      });

      it('decodes all_day: true to true', () => {
        const decoded: any = Schema.decodeUnknownSync(schema)({ ...base, all_day: true });
        expect(decoded.all_day).toBe(true);
      });

      it('decodes all_day: false to false', () => {
        const decoded: any = Schema.decodeUnknownSync(schema)({ ...base, all_day: false });
        expect(decoded.all_day).toBe(false);
      });

      it('rejects all_day: null — withDecodingDefaultKey tolerates absence, not null', () => {
        expect(() => Schema.decodeUnknownSync(schema)({ ...base, all_day: null })).toThrow();
      });

      it('round-trips encode -> decode preserving all_day: true', () => {
        const decoded: any = Schema.decodeUnknownSync(schema)({ ...base, all_day: true });
        const encoded: any = Schema.encodeSync(schema)(decoded);
        const redecoded: any = Schema.decodeUnknownSync(schema)(encoded);
        expect(redecoded.all_day).toBe(true);
      });

      it('round-trips encode -> decode preserving all_day: false', () => {
        const decoded: any = Schema.decodeUnknownSync(schema)({ ...base, all_day: false });
        const encoded: any = Schema.encodeSync(schema)(decoded);
        const redecoded: any = Schema.decodeUnknownSync(schema)(encoded);
        expect(redecoded.all_day).toBe(false);
      });
    });
  }

  it('batch guard: a 3-row array with the middle row missing all_day decodes to 3 elements without throwing — reproduces the full-sync outage (§8.2) in CI instead of in production', () => {
    const rows = [
      { ...fixtures[0].base, all_day: true },
      fixtures[1].base, // all_day key entirely absent — the exact wire shape an older server produces
      { ...fixtures[2].base, all_day: false },
    ];

    const decoded = Schema.decodeUnknownSync(Schema.Array(UnprocessedEventSyncEvent))(rows);

    expect(decoded).toHaveLength(3);
    expect((decoded[0] as any).all_day).toBe(true);
    expect((decoded[1] as any).all_day).toBe(false);
    expect((decoded[2] as any).all_day).toBe(false);
  });
});
