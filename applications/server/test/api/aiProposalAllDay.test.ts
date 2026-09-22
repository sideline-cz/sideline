// Spec for the AI write path's all-day anchoring — `confirmProposal`
// (`applications/server/src/api/ai-chat.ts`) driving `createEventForMemberTx`'s
// `args.payload.allDay ? anchorAllDay(...) : args.payload.startAt` branch
// (`applications/server/src/services/EventCreation.ts`) via `toCreateEventRequest`'s
// `dateOnlyToUtcNoon` convention (`applications/server/src/services/ai/actions.ts`) — plan
// `.work-plans/ai-app-interaction.md` §3 (blocker 1) / §7 (this file's spec).
//
// Minimal-API harness per `eventAllDayAnchor.test.ts:53-70`: a `SmallApi` containing ONLY
// `AiChatApi.AiChatApiGroup`, `AiChatApiLive` (`HttpApiBuilder.group(Api, 'aiChat', ...)`, built
// against the FULL production `Api`) reused under it — `HttpApiGroup.key` is derived solely from
// the group's own `identifier`, not from whichever `HttpApi` it was `.add`ed to
// (`effect@4.0.0-beta.40` `HttpApiGroup.js:82`), the same trick `eventAllDayAnchor.test.ts` uses
// for `EventApiLive`. This keeps the harness to the handful of repositories the AI write path
// actually touches instead of the ~40 a full `ApiLive` boot would need.
//
// The proposal row is SEEDED DIRECTLY into a real in-memory `AiActionProposalsRepository` mock
// (bypassing `propose_create_event` — this file is not testing the propose step, only what
// `confirm` writes) with a raw `payload` JSON string matching `ProposeCreateEventArgs`'s wire
// shape exactly, mirroring how `aiTools.test.ts`/`ai-chat.test.ts` construct their fixtures.
//
// **Assert the EXACT instant AND the derived `startDate`** — mirroring `eventAllDayAnchor.
// test.ts:449` and `:520-521`. Landing on the previous UTC calendar day east of UTC is CORRECT
// for a team whose local midnight, expressed in UTC, falls on the prior UTC date (a positive
// UTC offset moves local midnight EARLIER in UTC clock time) — do NOT "fix" it; `startDate` (what
// a user actually sees) is the invariant that must read `2026-07-04` in every one of the four
// zones below regardless of which UTC instant that midnight is.

import type { Auth, Event, Role, Team, TeamMember } from '@sideline/domain';
import { AiChatApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiChatApiLive } from '~/api/ai-chat.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { AiActionProposalsRepository } from '~/repositories/AiActionProposalsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AiChatEnabledConfig } from '~/services/AiChatEnabledConfig.js';
import { ChatAgent } from '~/services/ChatAgent.js';
import { ChatRateLimiter } from '~/services/ChatRateLimiter.js';
import { LlmClient } from '~/services/LlmClient.js';
import { MockGenericSqlClientLayer } from '../mocks/bankSyncMocks.js';

// ---------------------------------------------------------------------------
// A minimal HttpApi containing ONLY the `aiChat` group.
// ---------------------------------------------------------------------------
const SmallApi = HttpApi.make('api').add(AiChatApi.AiChatApiGroup);

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const ADMIN_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;

const ADMIN_PERMISSIONS: readonly Role.Permission[] = ['team:manage', 'event:create'];

// ---------------------------------------------------------------------------
// Mutable in-memory stores, reset in beforeEach
// ---------------------------------------------------------------------------

type EventRecord = {
  id: Event.EventId;
  team_id: Team.TeamId;
  training_type_id: Option.Option<string>;
  event_type: Event.EventType;
  event_type_id: Option.Option<string>;
  title: string;
  description: Option.Option<string>;
  image_url: Option.Option<string>;
  start_at: DateTime.Utc;
  end_at: Option.Option<DateTime.Utc>;
  location: Option.Option<string>;
  location_url: Option.Option<string>;
  status: Event.EventStatus;
  all_day: boolean;
  created_by: TeamMember.TeamMemberId;
  series_id: Option.Option<string>;
  series_modified: boolean;
  owner_group_id: Option.Option<string>;
  member_group_id: Option.Option<string>;
  start_date: string;
  end_date: string;
};

interface ProposalStoreRow {
  team_id: Team.TeamId;
  user_id: Auth.UserId;
  action: 'create_event';
  payload: string;
  consumed: boolean;
  expired: boolean;
}

let eventsStore: Map<Event.EventId, EventRecord>;
let teamTimezoneStore: Map<Team.TeamId, string>;
let sessionsStore: Map<string, Auth.UserId>;
let proposalsStore: Map<string, ProposalStoreRow>;
let proposalSeq: number;

const resetStores = () => {
  eventsStore = new Map();
  teamTimezoneStore = new Map([[TEAM_ID, 'Europe/Prague']]);
  sessionsStore = new Map([['admin-token', ADMIN_USER_ID]]);
  proposalsStore = new Map();
  proposalSeq = 0;
};

/** Mirrors the real `(start_at AT TIME ZONE tz)::date` projection
 * (`eventAllDayAnchor.test.ts`'s own `toLocalDateOnly` helper, verbatim). */
const toLocalDateOnly = (dt: DateTime.Utc, timezone: string): string => {
  const zone = Option.getOrElse(DateTime.zoneMakeNamed(timezone), () =>
    DateTime.zoneMakeNamedUnsafe('Europe/Prague'),
  );
  return DateTime.formatIsoDate(DateTime.setZone(dt, zone));
};

const zoneFor = (teamId: Team.TeamId): string => {
  const tz = teamTimezoneStore.get(teamId);
  if (tz === undefined) return 'Europe/Prague';
  return Option.isSome(DateTime.zoneMakeNamed(tz)) ? tz : 'Europe/Prague';
};

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  findByToken: (token: string) => {
    const userId = sessionsStore.get(token);
    if (!userId) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        id: 'session-1',
        user_id: userId,
        token,
        expires_at: DateTime.nowUnsafe(),
        created_at: DateTime.nowUnsafe(),
      }),
    );
  },
  create: () => Effect.die(new Error('Not implemented')),
  deleteByToken: () => Effect.void,
} as never);

const MockUsersRepositoryLayer = Layer.succeed(UsersRepository, {
  findById: (id: Auth.UserId) =>
    Effect.succeed(
      id === ADMIN_USER_ID
        ? Option.some({
            id: ADMIN_USER_ID,
            discord_id: '67890',
            username: 'adminuser',
            avatar: Option.none<string>(),
            is_profile_complete: true,
            name: Option.some('Admin User'),
            birth_date: Option.none(),
            gender: Option.none<'male' | 'female' | 'other'>(),
            locale: 'en' as const,
            discord_display_name: Option.none<string>(),
            discord_nickname: Option.none<string>(),
            created_at: DateTime.nowUnsafe(),
            updated_at: DateTime.nowUnsafe(),
          })
        : Option.none(),
    ),
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.die(new Error('Not implemented')),
  completeProfile: () => Effect.die(new Error('Not implemented')),
  updateLocale: () => Effect.die(new Error('Not implemented')),
  updateAdminProfile: () => Effect.die(new Error('Not implemented')),
} as never);

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
    if (teamId === TEAM_ID && userId === ADMIN_USER_ID) {
      const membership: MembershipWithRole = {
        id: ADMIN_MEMBER_ID,
        team_id: TEAM_ID,
        user_id: ADMIN_USER_ID,
        active: true,
        role_names: ['Admin'],
        permissions: ADMIN_PERMISSIONS,
        is_profile_complete: true,
        require_complete_profile: Option.none(),
      } as never;
      return Effect.succeed(Option.some(membership));
    }
    return Effect.succeed(Option.none());
  },
} as never);

const MockTeamSettingsRepositoryLayer = Layer.succeed(TeamSettingsRepository, {
  findByTeamId: (teamId: Team.TeamId) => {
    const tz = teamTimezoneStore.get(teamId);
    if (tz === undefined) return Effect.succeed(Option.none());
    return Effect.succeed(Option.some({ timezone: tz } as never));
  },
} as never);

// The admin membership bypasses `checkCoachScoping`/`checkTrainingTypeOwnerGroup`, and no fixture
// here sets `trainingTypeId`/`ownerGroupId`/`memberGroupId` — so, exactly like
// `eventAllDayAnchor.test.ts`'s own reasoning, these are never actually invoked.
const MockGroupsRepositoryLayer = Layer.succeed(
  GroupsRepository,
  new Proxy({}, { get: () => () => Effect.void }) as never,
);
const MockTrainingTypesRepositoryLayer = Layer.succeed(
  TrainingTypesRepository,
  new Proxy({}, { get: () => () => Effect.void }) as never,
);
// Every fixture uses `eventType: 'match'` or `'tournament'` — never `'training'` — so
// `emitTrainingClaimRequestIfApplicable` short-circuits on its own `eventType !== 'training'`
// guard before either of these is ever consulted.
const MockDiscordChannelMappingRepositoryLayer = Layer.succeed(
  DiscordChannelMappingRepository,
  new Proxy({}, { get: () => () => Effect.void }) as never,
);
const MockEventSyncEventsRepositoryLayer = Layer.succeed(
  EventSyncEventsRepository,
  new Proxy({}, { get: () => () => Effect.void }) as never,
);

const MockEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  insertEvent: (input: {
    teamId: Team.TeamId;
    trainingTypeId: Option.Option<string>;
    eventType: string;
    title: string;
    description: Option.Option<string>;
    imageUrl?: Option.Option<string>;
    startAt: DateTime.Utc;
    endAt: Option.Option<DateTime.Utc>;
    location: Option.Option<string>;
    locationUrl?: Option.Option<string>;
    createdBy: TeamMember.TeamMemberId;
    ownerGroupId?: Option.Option<string>;
    memberGroupId?: Option.Option<string>;
    allDay?: boolean;
  }) => {
    const id = crypto.randomUUID() as Event.EventId;
    const tz = zoneFor(input.teamId);
    const record: EventRecord = {
      id,
      team_id: input.teamId,
      training_type_id: input.trainingTypeId,
      event_type: input.eventType as Event.EventType,
      // Trigger-resolved in real Postgres (`events_sync_event_type`); the mock has no trigger,
      // and `None` is exactly what the handler forwards for a row it did not join.
      event_type_id: Option.none(),
      title: input.title,
      description: input.description,
      image_url: input.imageUrl ?? Option.none(),
      start_at: input.startAt,
      end_at: input.endAt,
      location: input.location,
      location_url: input.locationUrl ?? Option.none(),
      status: 'active',
      all_day: input.allDay ?? false,
      created_by: input.createdBy,
      series_id: Option.none(),
      series_modified: false,
      owner_group_id: input.ownerGroupId ?? Option.none(),
      member_group_id: input.memberGroupId ?? Option.none(),
      start_date: toLocalDateOnly(input.startAt, tz),
      end_date: toLocalDateOnly(
        Option.getOrElse(input.endAt, () => input.startAt),
        tz,
      ),
    };
    eventsStore.set(id, record);
    return Effect.succeed(record);
  },
  markEventPersonalMessagesDirty: () => Effect.void,
  getScopedTrainingTypeIds: () => Effect.succeed([]),
} as never);

// `AiActionProposalsRepository` — a real in-memory store. Seeded directly (bypassing
// `propose_create_event`, which is not this file's SUT) via `seedProposal` below.
const MockAiActionProposalsRepositoryLayer = Layer.succeed(AiActionProposalsRepository, {
  lockForConfirm: (params: { id: string; team_id: Team.TeamId; user_id: Auth.UserId }) => {
    const row = proposalsStore.get(params.id);
    if (row === undefined || row.team_id !== params.team_id || row.user_id !== params.user_id) {
      return Effect.succeed(Option.none());
    }
    return Effect.succeed(
      Option.some({
        action: row.action,
        payload: row.payload,
        consumed: row.consumed,
        expired: row.expired,
      }),
    );
  },
  claim: (params: { id: string; team_id: Team.TeamId; user_id: Auth.UserId }) => {
    const row = proposalsStore.get(params.id);
    if (
      row === undefined ||
      row.team_id !== params.team_id ||
      row.user_id !== params.user_id ||
      row.consumed ||
      row.expired
    ) {
      return Effect.succeed(Option.none());
    }
    row.consumed = true;
    return Effect.succeed(Option.some({ id: params.id }));
  },
  insert: () => Effect.die(new Error('unused — proposals are seeded directly in this file')),
  deleteForUser: () => Effect.die(new Error('unused in this file')),
} as never);

// `ChatAgent`/`ChatRateLimiter`/`LlmClient` are ambiently bound by `AiChatApiLive`'s group
// construction regardless of which handler is called — never invoked by `confirmProposal`.
const MockChatAgentLayer = Layer.succeed(ChatAgent, {
  respond: () => Effect.die(new Error('unused in this file')),
} as never);
const MockChatRateLimiterLayer = Layer.succeed(ChatRateLimiter, {
  check: () => Effect.die(new Error('unused in this file')),
} as never);
const MockLlmClientLayer = Layer.succeed(LlmClient, {
  configured: false,
  chatWithTools: () => Effect.die(new Error('unused in this file')),
} as never);
const MockAiChatEnabledConfigLayer = Layer.succeed(AiChatEnabledConfig, {
  asEffect: Effect.succeed(true),
} as never);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(AiChatApiLive),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(MockUsersRepositoryLayer),
  Layer.provide(MockTeamMembersRepositoryLayer),
  Layer.provide(MockTeamSettingsRepositoryLayer),
  Layer.provide(MockGroupsRepositoryLayer),
  Layer.provide(MockTrainingTypesRepositoryLayer),
  Layer.provide(MockDiscordChannelMappingRepositoryLayer),
  Layer.provide(MockEventSyncEventsRepositoryLayer),
  Layer.provide(MockEventsRepositoryLayer),
  Layer.provide(MockAiActionProposalsRepositoryLayer),
  Layer.provide(MockChatAgentLayer),
  Layer.provide(MockChatRateLimiterLayer),
  Layer.provide(MockLlmClientLayer),
  Layer.provide(MockAiChatEnabledConfigLayer),
  Layer.provide(MockGenericSqlClientLayer),
);

let handler: (...args: any) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const app = HttpRouter.toWebHandler(TestLayer);
  handler = app.handler;
  dispose = app.dispose;
});

afterAll(async () => {
  await dispose();
});

beforeEach(() => {
  resetStores();
});

const seedProposal = (payload: Record<string, unknown>): string => {
  proposalSeq += 1;
  const id = `00000000-0000-1000-8000-${String(proposalSeq).padStart(12, '0')}`;
  proposalsStore.set(id, {
    team_id: TEAM_ID,
    user_id: ADMIN_USER_ID,
    action: 'create_event',
    payload: JSON.stringify(payload),
    consumed: false,
    expired: false,
  });
  return id;
};

const confirm = (proposalId: string) =>
  handler(
    new Request(`http://localhost/teams/${TEAM_ID}/ai/proposals/${proposalId}/confirm`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
    }),
  );

const allDayPayload = (overrides: Record<string, unknown> = {}) => ({
  title: 'All-day tournament',
  eventType: 'tournament',
  allDay: true,
  startDate: '2026-07-04',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests — plan §7, mirroring `eventAllDayAnchor.test.ts:449`/`:520-521`.
// ---------------------------------------------------------------------------

describe('AI write path — all-day anchor on confirm', () => {
  it("America/New_York: startAt anchors to 2026-07-04T04:00:00.000Z, startDate reads '2026-07-04'", async () => {
    teamTimezoneStore.set(TEAM_ID, 'America/New_York');
    const id = seedProposal(allDayPayload());
    const response = await confirm(id);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.startAt).toBe('2026-07-04T04:00:00.000Z');
    expect(body.startDate).toBe('2026-07-04');
  });

  it("Pacific/Kiritimati: startAt anchors to 2026-07-03T10:00:00.000Z (previous UTC day — correct, east of UTC), startDate STILL reads '2026-07-04'", async () => {
    teamTimezoneStore.set(TEAM_ID, 'Pacific/Kiritimati');
    const id = seedProposal(allDayPayload());
    const response = await confirm(id);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.startAt).toBe('2026-07-03T10:00:00.000Z');
    expect(body.startDate).toBe('2026-07-04');
  });

  it("Pacific/Niue: startAt anchors to 2026-07-04T11:00:00.000Z, startDate reads '2026-07-04'", async () => {
    teamTimezoneStore.set(TEAM_ID, 'Pacific/Niue');
    const id = seedProposal(allDayPayload());
    const response = await confirm(id);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.startAt).toBe('2026-07-04T11:00:00.000Z');
    expect(body.startDate).toBe('2026-07-04');
  });

  it("Europe/Prague: startAt anchors to 2026-07-03T22:00:00.000Z (previous UTC day — correct), startDate STILL reads '2026-07-04'", async () => {
    teamTimezoneStore.set(TEAM_ID, 'Europe/Prague');
    const id = seedProposal(allDayPayload());
    const response = await confirm(id);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.startAt).toBe('2026-07-03T22:00:00.000Z');
    expect(body.startDate).toBe('2026-07-04');
  });

  it('an endDate two days later anchors to ITS OWN date, not startDate + a fixed offset', async () => {
    teamTimezoneStore.set(TEAM_ID, 'Europe/Prague');
    const id = seedProposal(allDayPayload({ startDate: '2026-07-04', endDate: '2026-07-06' }));
    const response = await confirm(id);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.startAt).toBe('2026-07-03T22:00:00.000Z');
    expect(body.endAt).toBe('2026-07-05T22:00:00.000Z');
    expect(body.endDate).toBe('2026-07-06');
  });

  it('a TIMED event (allDay absent): startAt is byte-identical to the submitted instant, no anchoring applied', async () => {
    teamTimezoneStore.set(TEAM_ID, 'Europe/Prague');
    const id = seedProposal({
      title: 'Timed match',
      eventType: 'match',
      startAt: '2026-07-04T18:30:00.000Z',
    });
    const response = await confirm(id);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.startAt).toBe('2026-07-04T18:30:00.000Z');
    expect(body.allDay).toBe(false);
  });

  it('no team_settings row: falls back to Europe/Prague, still 201, no defect', async () => {
    teamTimezoneStore.delete(TEAM_ID);
    const id = seedProposal(allDayPayload({ startDate: '2026-07-04' }));
    const response = await confirm(id);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.startAt).toBe('2026-07-03T22:00:00.000Z');
    expect(body.startDate).toBe('2026-07-04');
  });

  it('an invalid stored IANA timezone string: falls back to Europe/Prague, still 201, no defect', async () => {
    teamTimezoneStore.set(TEAM_ID, 'Not/A_Real_Zone');
    const id = seedProposal(allDayPayload({ startDate: '2026-07-04' }));
    const response = await confirm(id);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.startAt).toBe('2026-07-03T22:00:00.000Z');
    expect(body.startDate).toBe('2026-07-04');
  });
});
