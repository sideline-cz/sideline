// The domain contract for the command-palette search endpoint
// (`.work-plans/command-palette-search.md` §B, §F.1). `SearchHit` is `EntityRef` minus the
// per-turn `ref` token, hoisted from the same field records — these tests pin the two unions
// against each other so they cannot drift apart, and pin the ONE nominal-membership trap that
// shipped a production bug before (`chatMessages.test.ts`, one layer up in `applications/web`).
import { describe, expect, it } from '@effect/vitest';
import { DateTime, Effect, Option, Schema } from 'effect';
import * as AiChatApi from '~/api/AiChatApi.js';
import * as EventApi from '~/api/EventApi.js';
import * as GroupApi from '~/api/GroupApi.js';
import * as Roster from '~/api/Roster.js';
import * as SearchApi from '~/api/SearchApi.js';
import * as TrainingTypeApi from '~/api/TrainingTypeApi.js';
import type { EventId } from '~/models/Event.js';
import type { GroupId } from '~/models/GroupModel.js';
import type { RoleId } from '~/models/Role.js';
import type { RosterId } from '~/models/RosterModel.js';
import type { TeamId } from '~/models/Team.js';
import type { TeamMemberId } from '~/models/TeamMember.js';
import type { TrainingTypeId } from '~/models/TrainingType.js';

const TEAM_ID = 'aaaaaaaa-0000-0000-0000-000000000001' as TeamId;
const START_AT_ISO = '2026-06-01T10:00:00.000Z';

const eventHit = (): AiChatApi.SearchHit => ({
  kind: 'event',
  event: new EventApi.EventInfo({
    eventId: 'bbbbbbbb-0000-0000-0000-000000000001' as EventId,
    teamId: TEAM_ID,
    title: 'Practice',
    eventType: 'training',
    trainingTypeName: Option.none(),
    eventTypeId: Option.none(),
    eventTypeName: Option.none(),
    eventTypeColor: Option.none(),
    description: Option.none(),
    imageUrl: Option.none(),
    startAt: DateTime.makeUnsafe(START_AT_ISO),
    endAt: Option.none(),
    location: Option.none(),
    locationUrl: Option.none(),
    status: 'active',
    allDay: false,
    seriesId: Option.none(),
    startDate: Option.some('2026-06-01'),
    endDate: Option.some('2026-06-01'),
  }),
});

const memberHit = (): AiChatApi.SearchHit => ({
  kind: 'member',
  memberId: 'cccccccc-0000-0000-0000-000000000001' as TeamMemberId,
  displayName: 'Anna Nováková',
  avatarUrl: Option.none(),
  jerseyNumber: Option.some(7),
  roleNames: ['Player'],
  effectiveRoles: [
    new Roster.EffectiveRole({
      roleId: 'dddddddd-0000-0000-0000-000000000001' as RoleId,
      name: 'Player',
      isBuiltIn: true,
      source: 'direct',
      groupNames: [],
    }),
  ],
  active: true,
});

const groupHit = (): AiChatApi.SearchHit => ({
  kind: 'group',
  group: new GroupApi.GroupInfo({
    groupId: 'eeeeeeee-0000-0000-0000-000000000001' as GroupId,
    teamId: TEAM_ID,
    parentId: Option.none(),
    name: 'U15',
    emoji: Option.none(),
    color: Option.none(),
    memberCount: 12,
    discordChannelProvisioning: false,
  }),
});

const rosterHit = (): AiChatApi.SearchHit => ({
  kind: 'roster',
  roster: new Roster.RosterInfo({
    rosterId: 'ffffffff-0000-0000-0000-000000000001' as RosterId,
    teamId: TEAM_ID,
    name: 'First team',
    active: true,
    memberCount: 20,
    createdAt: '2026-01-01T00:00:00.000Z',
    color: Option.none(),
    emoji: Option.none(),
    discordChannelId: Option.none(),
    discordChannelName: Option.none(),
    discordChannelProvisioning: false,
  }),
});

const trainingTypeHit = (): AiChatApi.SearchHit => ({
  kind: 'trainingType',
  trainingType: new TrainingTypeApi.TrainingTypeInfo({
    trainingTypeId: '11111111-0000-0000-0000-000000000001' as TrainingTypeId,
    teamId: TEAM_ID,
    name: 'Fitness',
    ownerGroupName: Option.none(),
    memberGroupName: Option.none(),
  }),
});

const ALL_HITS: ReadonlyArray<AiChatApi.SearchHit> = [
  eventHit(),
  memberHit(),
  groupHit(),
  rosterHit(),
  trainingTypeHit(),
];

describe('SearchHit', () => {
  it('round-trips for all five kinds', () => {
    const encoded = Schema.encodeSync(Schema.Array(AiChatApi.SearchHit))(ALL_HITS);
    const decoded = Schema.decodeUnknownSync(Schema.Array(AiChatApi.SearchHit))(encoded);
    expect(decoded).toEqual(ALL_HITS);
  });

  // The nominal-membership trap, pinned one layer down from
  // `applications/web/src/lib/assistant/chatMessages.test.ts` — a plain object matching
  // `EventInfo` field-for-field still fails to encode, because `Schema.Class` membership is
  // nominal, not structural.
  it('rejects a plain object matching EventInfo field-for-field', async () => {
    const plainHit = {
      kind: 'event' as const,
      event: {
        eventId: 'bbbbbbbb-0000-0000-0000-000000000001',
        teamId: TEAM_ID,
        title: 'Practice',
        eventType: 'training',
        trainingTypeName: Option.none(),
        description: Option.none(),
        imageUrl: Option.none(),
        startAt: DateTime.makeUnsafe(START_AT_ISO),
        endAt: Option.none(),
        location: Option.none(),
        locationUrl: Option.none(),
        status: 'active',
        allDay: false,
        seriesId: Option.none(),
        startDate: Option.some('2026-06-01'),
        endDate: Option.some('2026-06-01'),
      },
    };

    const result = await Effect.runPromise(
      Effect.result(Schema.encodeUnknownEffect(AiChatApi.SearchHit)(plainHit)),
    );

    expect(result._tag).toBe('Failure');
    expect(String(result._tag === 'Failure' ? result.failure : '')).toContain('EventInfo');
  });
});

describe('EntityRef is SearchHit + ref', () => {
  const REF = 'ab23';

  for (const hit of ALL_HITS) {
    it(`${hit.kind}: an encoded EntityRef minus \`ref\` decodes as a SearchHit`, () => {
      const entityRef: AiChatApi.EntityRef = { ...hit, ref: REF };
      const encoded = Schema.encodeSync(AiChatApi.EntityRef)(entityRef);
      const { ref: _ref, ...withoutRef } = encoded;
      const decodedHit = Schema.decodeUnknownSync(AiChatApi.SearchHit)(withoutRef);
      expect(decodedHit).toEqual(hit);
    });

    it(`${hit.kind}: an encoded SearchHit plus { ref } decodes as an EntityRef`, () => {
      const encodedHit = Schema.encodeSync(AiChatApi.SearchHit)(hit);
      const decodedRef = Schema.decodeUnknownSync(AiChatApi.EntityRef)({
        ...encodedHit,
        ref: REF,
      });
      expect(decodedRef).toEqual({ ...hit, ref: REF });
    });
  }

  // Same keys and values as before `SearchHit` was split out — but NOT byte-identical: spreading
  // the field record first puts `ref` LAST. Pinned with `toEqual`, never a snapshot / stringify /
  // key-order assertion — see `AiChatApi.ts`'s doc comment on `EntityRef`.
  it("pins the event kind's full encoded shape", () => {
    const entityRef: AiChatApi.EntityRef = { ...eventHit(), ref: REF };
    const encoded = Schema.encodeSync(AiChatApi.EntityRef)(entityRef);

    expect(encoded).toEqual({
      kind: 'event',
      event: {
        eventId: 'bbbbbbbb-0000-0000-0000-000000000001',
        teamId: TEAM_ID,
        title: 'Practice',
        eventType: 'training',
        trainingTypeName: null,
        description: null,
        imageUrl: null,
        startAt: START_AT_ISO,
        endAt: null,
        location: null,
        locationUrl: null,
        status: 'active',
        allDay: false,
        seriesId: null,
        startDate: '2026-06-01',
        endDate: '2026-06-01',
      },
      ref: REF,
    });
  });
});

describe('searchHitLabel / searchHitId', () => {
  it('event', () => {
    const hit = eventHit();
    expect(SearchApi.searchHitLabel(hit)).toBe('Practice');
    expect(SearchApi.searchHitId(hit)).toBe('event:bbbbbbbb-0000-0000-0000-000000000001');
  });

  it('member', () => {
    const hit = memberHit();
    expect(SearchApi.searchHitLabel(hit)).toBe('Anna Nováková');
    expect(SearchApi.searchHitId(hit)).toBe('member:cccccccc-0000-0000-0000-000000000001');
  });

  it('group', () => {
    const hit = groupHit();
    expect(SearchApi.searchHitLabel(hit)).toBe('U15');
    expect(SearchApi.searchHitId(hit)).toBe('group:eeeeeeee-0000-0000-0000-000000000001');
  });

  it('roster', () => {
    const hit = rosterHit();
    expect(SearchApi.searchHitLabel(hit)).toBe('First team');
    expect(SearchApi.searchHitId(hit)).toBe('roster:ffffffff-0000-0000-0000-000000000001');
  });

  it('trainingType', () => {
    const hit = trainingTypeHit();
    expect(SearchApi.searchHitLabel(hit)).toBe('Fitness');
    expect(SearchApi.searchHitId(hit)).toBe('trainingType:11111111-0000-0000-0000-000000000001');
  });
});

describe('SearchHit — no `ref`', () => {
  it('type-level: a SearchHit carries no per-turn token', () => {
    const hit = eventHit();
    // @ts-expect-error — SearchHit carries no per-turn token; identity is searchHitId(hit).
    const noRef: string = hit.ref;
    expect(noRef).toBeUndefined();
  });
});
