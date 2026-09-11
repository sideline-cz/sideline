// TDD mode — PR 3 of the all-day-Discord-start-time plan (§12, §7.10).
//
// Authoritative spec: plan §12 (all six steps) plus §7.10's numbered case list.
//
// This file drives `applications/server/src/api/event.ts` through real HTTP
// requests, exactly the way a browser would, and asserts the *stored*
// `start_at`/`end_at` the server echoes back in the JSON response. It does
// NOT need Postgres — the anchoring decision (`anchorAllDay`/`reanchorFromLocal`
// /the five-row merge table) lives entirely in the HTTP handler, before it ever
// reaches `EventsRepository`. The mock `EventsRepository` below only has to
// faithfully store and echo back whatever instant the handler computed — it is
// deliberately NOT the SUT.
//
// ⚠ TDD note — which cases are supposed to go RED (plan §18, "NEW §7.10").
// Cases 1–8, 11 and 13 fail against pre-PR-3 code (today's server still snaps
// to `T12:00:00Z`, or does nothing at all) and turn green when §12 is
// implemented — they are the acceptance tests.
// Cases 9, 10 and 12 ALREADY PASS against pre-fix code — they assert
// byte-identity of an untouched `start_at`, which is trivially true today
// because no anchoring exists at all. They are regression guards against the
// REJECTED "merge the `allDay` first, then anchor the merged `startAt`" design
// (§12 step 4's box), not progress indicators. A green suite does NOT mean the
// anchor is implemented; only 1–8, 11, 13 flipping from red to green does.
//
// The `all_day_anchored` stamp (§12 step 6) and the migration itself (§13
// intro) are NOT testable here — neither is part of the wire response
// (§12 step 6: "Neither EventRow nor any SELECT needs the new column"). They
// are covered by the Docker-backed integration test
// `test/integration/repositories/EventsRepository.allDayAnchored.test.ts`.
// The timezone-change re-anchor (§12 step 5) is covered by the Docker-backed
// `test/integration/api/teamSettingsReanchor.test.ts`.

import type { Auth, Event, Role, Team, TeamMember } from '@sideline/domain';
import { EventApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventApiLive } from '~/api/event.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
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

// ---------------------------------------------------------------------------
// A minimal HttpApi containing ONLY the `event` group. `HttpApiGroup.key` is
// derived solely from the group's own `identifier` (effect@4.0.0-beta.40
// HttpApiGroup.js:82 — `${'effect/httpapi/HttpApiGroup/' + options.identifier}`),
// not from whichever `HttpApi` it happens to be `.add`ed to. `EventApiLive`
// (`HttpApiBuilder.group(Api, 'event', ...)`, built against the FULL production
// `Api`) registers its routes under that same key regardless, so
// `HttpApiBuilder.layer(SmallApi, ...)` — which only walks SmallApi's own
// groups — finds them and never asks about the other ~30 unrelated groups the
// real `Api` bundles. That is what keeps this harness to five mocked
// repositories instead of the ~40 a full `ApiLive` boot would need.
// ---------------------------------------------------------------------------
const SmallApi = HttpApi.make('api').add(EventApi.EventApiGroup);

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const ADMIN_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;

const ADMIN_PERMISSIONS: readonly Role.Permission[] = [
  'team:manage',
  'event:create',
  'event:edit',
  'event:cancel',
];

// ---------------------------------------------------------------------------
// Mutable in-memory stores, reset in beforeEach
// ---------------------------------------------------------------------------

type EventRecord = {
  id: Event.EventId;
  team_id: Team.TeamId;
  training_type_id: Option.Option<string>;
  event_type: Event.EventType;
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
  training_type_name: Option.Option<string>;
  created_by_name: Option.Option<string>;
  series_id: Option.Option<string>;
  series_modified: boolean;
  owner_group_id: Option.Option<string>;
  member_group_id: Option.Option<string>;
  owner_group_name: Option.Option<string>;
  member_group_name: Option.Option<string>;
  start_date: string;
  end_date: string;
};

let eventsStore: Map<Event.EventId, EventRecord>;
// team_id -> timezone. Absent key === "no team_settings row" (case 4).
let teamTimezoneStore: Map<Team.TeamId, string>;
let sessionsStore: Map<string, Auth.UserId>;

const resetStores = () => {
  eventsStore = new Map();
  teamTimezoneStore = new Map([[TEAM_ID, 'Europe/Prague']]);
  sessionsStore = new Map([['admin-token', ADMIN_USER_ID]]);
};

/** Mirrors the real `(start_at AT TIME ZONE tz)::date` projection (plan
 * §11.2/§12 step 3's `anchorAllDay` doc comment) — NOT the anchor-neutral
 * pure-UTC-format helper other mocked-repository tests use, because case 8
 * below specifically depends on this being timezone-aware. */
const toLocalDateOnly = (dt: DateTime.Utc, timezone: string): string => {
  const zone = Option.getOrElse(DateTime.zoneMakeNamed(timezone), () =>
    DateTime.zoneMakeNamedUnsafe('Europe/Prague'),
  );
  return DateTime.formatIsoDate(DateTime.setZone(dt, zone));
};

const zoneFor = (teamId: Team.TeamId): string => teamTimezoneStore.get(teamId) ?? 'Europe/Prague';

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
} as any);

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
            is_global_admin: false,
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
} as any);

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
      } as any;
      return Effect.succeed(Option.some(membership));
    }
    return Effect.succeed(Option.none());
  },
} as any);

const MockTeamSettingsRepositoryLayer = Layer.succeed(TeamSettingsRepository, {
  findByTeamId: (teamId: Team.TeamId) => {
    const tz = teamTimezoneStore.get(teamId);
    if (tz === undefined) return Effect.succeed(Option.none());
    return Effect.succeed(Option.some({ timezone: tz } as any));
  },
} as any);

// event:create/edit never touch groups/training-types for an admin (isAdmin
// short-circuits `checkCoachScoping`/`checkTrainingTypeOwnerGroup`/
// `checkGroupAccess`), and none of our fixtures set `trainingTypeId` or a
// member/owner group — so these are never actually invoked. A `Proxy`
// stub keeps that assumption honest: any *unexpected* call still returns an
// `Effect`, but there is nothing here to accidentally get right by accident.
const MockGroupsRepositoryLayer = Layer.succeed(
  GroupsRepository,
  new Proxy({}, { get: () => () => Effect.void }) as any,
);
const MockTrainingTypesRepositoryLayer = Layer.succeed(
  TrainingTypesRepository,
  new Proxy({}, { get: () => () => Effect.void }) as any,
);
const MockDiscordChannelMappingRepositoryLayer = Layer.succeed(
  DiscordChannelMappingRepository,
  new Proxy({}, { get: () => () => Effect.void }) as any,
);
const MockEventSyncEventsRepositoryLayer = Layer.succeed(
  EventSyncEventsRepository,
  new Proxy({}, { get: () => () => Effect.void }) as any,
);

const MockEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  findEventByIdWithDetails: (id: Event.EventId) => {
    const e = eventsStore.get(id);
    return Effect.succeed(e ? Option.some(e) : Option.none());
  },
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
    seriesId?: Option.Option<string>;
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
      training_type_name: Option.none(),
      created_by_name: Option.none(),
      series_id: input.seriesId ?? Option.none(),
      series_modified: false,
      owner_group_id: input.ownerGroupId ?? Option.none(),
      member_group_id: input.memberGroupId ?? Option.none(),
      owner_group_name: Option.none(),
      member_group_name: Option.none(),
      start_date: toLocalDateOnly(input.startAt, tz),
      end_date: toLocalDateOnly(
        Option.getOrElse(input.endAt, () => input.startAt),
        tz,
      ),
    };
    eventsStore.set(id, record);
    return Effect.succeed(record);
  },
  updateEvent: (input: {
    id: Event.EventId;
    title: string;
    eventType: string;
    trainingTypeId: Option.Option<string>;
    description: Option.Option<string>;
    imageUrl?: Option.Option<string>;
    startAt: DateTime.Utc;
    endAt: Option.Option<DateTime.Utc>;
    location: Option.Option<string>;
    locationUrl?: Option.Option<string>;
    ownerGroupId?: Option.Option<string>;
    memberGroupId?: Option.Option<string>;
    allDay?: boolean;
  }) => {
    const existing = eventsStore.get(input.id);
    if (!existing) return Effect.die(new Error('Not found'));
    const tz = zoneFor(existing.team_id);
    const updated: EventRecord = {
      ...existing,
      title: input.title,
      event_type: input.eventType as Event.EventType,
      training_type_id: input.trainingTypeId,
      description: input.description,
      image_url: input.imageUrl !== undefined ? input.imageUrl : existing.image_url,
      start_at: input.startAt,
      end_at: input.endAt,
      location: input.location,
      location_url: input.locationUrl !== undefined ? input.locationUrl : existing.location_url,
      owner_group_id: input.ownerGroupId ?? existing.owner_group_id,
      member_group_id: input.memberGroupId ?? existing.member_group_id,
      all_day: input.allDay ?? existing.all_day,
      start_date: toLocalDateOnly(input.startAt, tz),
      end_date: toLocalDateOnly(
        Option.getOrElse(input.endAt, () => input.startAt),
        tz,
      ),
    };
    eventsStore.set(input.id, updated);
    return Effect.succeed(updated);
  },
  cancelEvent: () => Effect.void,
  markEventSeriesModified: () => Effect.void,
  markEventPersonalMessagesDirty: () => Effect.void,
  getScopedTrainingTypeIds: () => Effect.succeed([]),
} as any);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(EventApiLive),
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

const BASE = `http://localhost/teams/${TEAM_ID}/events`;

const post = (body: Record<string, unknown>) =>
  handler(
    new Request(BASE, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const patch = (eventId: string, body: Record<string, unknown>) =>
  handler(
    new Request(`${BASE}/${eventId}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const createPayload = (overrides: Record<string, unknown> = {}) => ({
  title: 'All-day event',
  eventType: 'tournament',
  trainingTypeId: null,
  description: null,
  startAt: '2026-07-15T12:00:00Z',
  endAt: null,
  allDay: true,
  location: null,
  ownerGroupId: null,
  memberGroupId: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// §7.10 cases 1–13
// ---------------------------------------------------------------------------

describe('all-day anchor on write (PR 3, plan §12/§7.10)', () => {
  // Case 1
  it('1. create, Prague, July → local midnight (CEST, UTC+2)', async () => {
    const response = await post(createPayload({ startAt: '2026-07-15T12:00:00Z' }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.startAt).toBe('2026-07-14T22:00:00.000Z');
  });

  // Case 2
  it('2. create, Prague, January → local midnight (CET, UTC+1)', async () => {
    const response = await post(createPayload({ startAt: '2026-01-15T12:00:00Z' }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.startAt).toBe('2026-01-14T23:00:00.000Z');
  });

  // Case 3
  it('3. create, America/New_York, July → local midnight (EDT, UTC-4)', async () => {
    teamTimezoneStore.set(TEAM_ID, 'America/New_York');
    const response = await post(createPayload({ startAt: '2026-07-15T12:00:00Z' }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.startAt).toBe('2026-07-15T04:00:00.000Z');
  });

  // Case 4
  it('4. create, team with NO team_settings row → Prague fallback, as case 1', async () => {
    teamTimezoneStore.delete(TEAM_ID);
    const response = await post(createPayload({ startAt: '2026-07-15T12:00:00Z' }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.startAt).toBe('2026-07-14T22:00:00.000Z');
  });

  // Case 5
  it('5. create, invalid IANA timezone string → Prague fallback, no defect (still 201)', async () => {
    teamTimezoneStore.set(TEAM_ID, 'Not/AZone');
    const response = await post(createPayload({ startAt: '2026-07-15T12:00:00Z' }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.startAt).toBe('2026-07-14T22:00:00.000Z');
  });

  // Case 6 (= Part I §7.6 case 3, new expectation)
  it('6. PATCH { allDay: true } only, on a timed event → reanchorFromLocal, not anchorAllDay', async () => {
    const created = await post(
      createPayload({ allDay: false, startAt: '2026-07-15T18:00:00Z' }),
    ).then((r) => r.json());
    expect(created.allDay).toBe(false);
    expect(created.startAt).toBe('2026-07-15T18:00:00.000Z');

    const response = await patch(created.eventId, { allDay: true });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.allDay).toBe(true);
    // 18:00Z = 20:00 local (CEST) on 15 July — still 15 July local, so local
    // midnight of 15 July is the anchor: 2026-07-14T22:00:00Z.
    expect(body.startAt).toBe('2026-07-14T22:00:00.000Z');
  });

  // Case 7
  it('7. create with endAt on a different date → endAt anchored to ITS OWN date, inclusive', async () => {
    const response = await post(
      createPayload({ startAt: '2026-07-15T12:00:00Z', endAt: '2026-07-17T12:00:00Z' }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.startAt).toBe('2026-07-14T22:00:00.000Z');
    expect(body.endAt).toBe('2026-07-16T22:00:00.000Z');
  });

  // Case 8 — the silent date-walk guard
  it('8. round trip: startDate read back and resaved as noon-UTC is byte-identical', async () => {
    const created = await post(createPayload({ startAt: '2026-07-15T12:00:00Z' })).then((r) =>
      r.json(),
    );
    expect(created.startAt).toBe('2026-07-14T22:00:00.000Z');
    expect(created.startDate).toBe('2026-07-15');

    // Simulate the web edit form: it works off `startDate` (a plain calendar
    // date string), and on save reconstructs the wire value as noon UTC of
    // that date — it never resends the previously-returned anchored instant.
    const resavedStartAt = `${created.startDate}T12:00:00Z`;
    const response = await patch(created.eventId, {
      title: created.title,
      startAt: resavedStartAt,
      allDay: true,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.startAt).toBe(created.startAt);
  });

  // Case 9 — the §12 step 4 blocker: partial-PATCH idempotence.
  //
  // ⚠ Deliberately does NOT hard-code the create-time anchored literal
  // (2026-09-15T22:00:00.000Z, which case 1 already pins) — that would couple
  // this case to PR 3's create-path fix and make it red for the wrong reason.
  // Idempotence must hold regardless of what `start_at` is: whatever value the
  // event was stored with, a title-only PATCH must never move it. Under the
  // REJECTED "merge then anchor" design this fails by -1/-2/-3 days on each
  // call even once anchoring exists; today (pre-fix, no anchoring at all) it
  // already passes trivially, which is exactly why this is a regression
  // guard, not an acceptance test (plan §18 TDD box).
  it('9. PATCH { title } three times, no startAt/allDay → start_at stays byte-identical', async () => {
    const created = await post(
      createPayload({ title: 'Tournament', startAt: '2026-09-16T12:00:00Z' }),
    ).then((r) => r.json());
    const original = created.startAt;

    const r1 = await patch(created.eventId, { title: 'x' }).then((r) => r.json());
    expect(r1.startAt).toBe(original);

    const r2 = await patch(created.eventId, { title: 'y' }).then((r) => r.json());
    expect(r2.startAt).toBe(original);

    const r3 = await patch(created.eventId, { title: 'z' }).then((r) => r.json());
    expect(r3.startAt).toBe(original);
  });

  // Case 10 — regression guard: the fix must not touch timed events
  it('10. PATCH { title } on a TIMED event → start_at byte-identical', async () => {
    const created = await post(
      createPayload({ allDay: false, startAt: '2026-07-15T18:00:00Z' }),
    ).then((r) => r.json());
    expect(created.startAt).toBe('2026-07-15T18:00:00.000Z');

    const response = await patch(created.eventId, { title: 'Renamed' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.allDay).toBe(false);
    expect(body.startAt).toBe('2026-07-15T18:00:00.000Z');
  });

  // Case 11 — forces reanchorFromLocal's LOCAL date read, not anchorAllDay's UTC one
  it('11. PATCH { allDay: true }, timed event stored at 23:00Z (=01:00 next day local)', async () => {
    const created = await post(
      createPayload({ allDay: false, startAt: '2026-07-15T23:00:00Z' }),
    ).then((r) => r.json());
    expect(created.startAt).toBe('2026-07-15T23:00:00.000Z');

    const response = await patch(created.eventId, { allDay: true });
    expect(response.status).toBe(200);
    const body = await response.json();
    // 23:00Z = 01:00 CEST on 16 July local. Local midnight of 16 July is
    // 2026-07-15T22:00:00Z. Reading the UTC date (15 July) would be a day wrong.
    expect(body.startAt).toBe('2026-07-15T22:00:00.000Z');
  });

  // Case 12 — Option-of-Option: "explicitly cleared" must stay distinct from "absent"
  it('12. PATCH { endAt: null } clears end_at; start_at is untouched', async () => {
    const created = await post(
      createPayload({ startAt: '2026-07-15T12:00:00Z', endAt: '2026-07-16T12:00:00Z' }),
    ).then((r) => r.json());
    expect(created.endAt).not.toBeNull();

    const response = await patch(created.eventId, { endAt: null });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.endAt).toBeNull();
    expect(body.startAt).toBe(created.startAt);
  });

  // Case 13 — DST gap: local midnight does not exist that night in Santiago
  it('13. create, America/Santiago, DST spring-forward night → resolves to 01:00 local', async () => {
    teamTimezoneStore.set(TEAM_ID, 'America/Santiago');
    const response = await post(createPayload({ startAt: '2026-09-06T12:00:00Z' }));
    expect(response.status).toBe(201);
    const body = await response.json();
    // Santiago jumps 23:59 (5 Sep) → 01:00 (6 Sep); 2026-09-06T00:00 local does
    // not exist. Verified against effect@4.0.0-beta.40's DateTime.setParts.
    // The date component is still 6 September — that is the point of the case,
    // not the hour.
    expect(body.startAt).toBe('2026-09-06T04:00:00.000Z');
  });
});
