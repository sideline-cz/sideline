// TDD — written BEFORE `applications/server/src/api/search.ts` exists
// (`.work-plans/command-palette-search.md` §F.2). `rankAndCap` does not exist yet, so every
// test in this file currently fails at IMPORT time (`Cannot find module '~/api/search.js'`),
// not at an individual assertion — that is the expected TDD-mode failure. Do not add a stub to
// make this pass; the developer implements `rankAndCap` against this spec.
//
// Plain `vitest` (not `@effect/vitest`), per plan §F.2 — `rankAndCap` is a pure function, no
// `Effect` involved.
//
// `todayIso` is ALWAYS an explicit literal passed into `rankAndCap`, never read from a clock —
// this is a pure-function ranking test, so there is no "expires" risk here (root `AGENTS.md`'s
// now-gated-fixture rule does not apply: nothing in this file reads `DateTime.nowUnsafe()` or
// `Date.now()`, and `rankAndCap`'s only notion of "today" is the `todayIso` parameter each test
// supplies directly).
//
// No `startDate: None` case: `api/event.ts:50` sets `startDate: Option.some(e.start_date)`
// unconditionally via `toEventInfo`, so that branch is unreachable — per the plan's explicit
// instruction, this file does not test it.

import type {
  AiChatApi,
  Event,
  GroupModel,
  RosterModel,
  Team,
  TeamMember,
  TrainingType,
} from '@sideline/domain';
import { EventApi, GroupApi, Roster, TrainingTypeApi } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { rankAndCap, TOTAL_LIMIT } from '~/api/search.js';

// ---------------------------------------------------------------------------
// Fixture builders — one per `SearchHit` kind. Event/group/roster/trainingType use the real
// `Schema.Class` constructors (nominal membership — a plain object would be a different bug
// class, but `rankAndCap` never encodes, so this is belt-and-suspenders consistency with the
// rest of the suite, not a requirement `rankAndCap` itself enforces). The member variant is a
// `Schema.Struct`, not a `Schema.Class` — membership there is structural, so a plain object is
// legitimate.
// ---------------------------------------------------------------------------

let eventSeq = 0;
const nextEventId = () =>
  `00000000-0000-0000-0000-0000000e${String(eventSeq++).padStart(4, '0')}` as Event.EventId;

const makeEventHit = (title: string, startDate: string): AiChatApiSearchHit => ({
  kind: 'event',
  event: new EventApi.EventInfo({
    eventId: nextEventId(),
    teamId: 'team-a' as Team.TeamId,
    title,
    eventType: 'training',
    trainingTypeName: Option.none(),
    eventTypeId: Option.none(),
    eventTypeName: Option.none(),
    eventTypeColor: Option.none(),
    description: Option.none(),
    imageUrl: Option.none(),
    startAt: DateTime.makeUnsafe(`${startDate}T10:00:00.000Z`),
    endAt: Option.none(),
    location: Option.none(),
    locationUrl: Option.none(),
    status: 'active',
    allDay: false,
    seriesId: Option.none(),
    startDate: Option.some(startDate),
    endDate: Option.some(startDate),
  }),
});

let memberSeq = 0;
const nextMemberId = () =>
  `00000000-0000-0000-0000-0000000m${String(memberSeq++).padStart(
    4,
    '0',
  )}` as TeamMember.TeamMemberId;

const makeMemberHit = (displayName: string): AiChatApiSearchHit => ({
  kind: 'member',
  memberId: nextMemberId(),
  displayName,
  avatarUrl: Option.none(),
  jerseyNumber: Option.none(),
  roleNames: [],
  effectiveRoles: [],
  active: true,
});

let groupSeq = 0;
const nextGroupId = () =>
  `00000000-0000-0000-0000-0000000g${String(groupSeq++).padStart(4, '0')}` as GroupModel.GroupId;

const makeGroupHit = (name: string): AiChatApiSearchHit => ({
  kind: 'group',
  group: new GroupApi.GroupInfo({
    groupId: nextGroupId(),
    teamId: 'team-a' as Team.TeamId,
    parentId: Option.none(),
    name,
    emoji: Option.none(),
    color: Option.none(),
    memberCount: 0,
    discordChannelProvisioning: false,
  }),
});

let rosterSeq = 0;
const nextRosterId = () =>
  `00000000-0000-0000-0000-0000000r${String(rosterSeq++).padStart(4, '0')}` as RosterModel.RosterId;

const makeRosterHit = (name: string): AiChatApiSearchHit => ({
  kind: 'roster',
  roster: new Roster.RosterInfo({
    rosterId: nextRosterId(),
    teamId: 'team-a' as Team.TeamId,
    name,
    active: true,
    memberCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    color: Option.none(),
    emoji: Option.none(),
    discordChannelId: Option.none(),
    discordChannelName: Option.none(),
    discordChannelProvisioning: false,
  }),
});

let trainingTypeSeq = 0;
const nextTrainingTypeId = () =>
  `00000000-0000-0000-0000-0000000t${String(trainingTypeSeq++).padStart(
    4,
    '0',
  )}` as TrainingType.TrainingTypeId;

const makeTrainingTypeHit = (name: string): AiChatApiSearchHit => ({
  kind: 'trainingType',
  trainingType: new TrainingTypeApi.TrainingTypeInfo({
    trainingTypeId: nextTrainingTypeId(),
    teamId: 'team-a' as Team.TeamId,
    name,
    ownerGroupName: Option.none(),
    memberGroupName: Option.none(),
  }),
});

// The fixture builders are typed against the real `AiChatApi.SearchHit` — importing it as a
// type only (`import type` above) has no runtime/circularity cost, so every fixture is checked
// against the actual contract `rankAndCap` (imported above) consumes.
type AiChatApiSearchHit = AiChatApi.SearchHit;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TODAY = '2026-06-15';

describe('rankAndCap — kind order', () => {
  it('returns event, member, group, roster, trainingType regardless of input order', () => {
    const shuffled = [
      makeTrainingTypeHit('Fitness'),
      makeRosterHit('First Team'),
      makeGroupHit('Alpha Squad'),
      makeMemberHit('Alice'),
      makeEventHit('Practice', TODAY),
    ];

    const result = rankAndCap(shuffled, 'a', TODAY);

    expect(result.map((h: any) => h.kind)).toEqual([
      'event',
      'member',
      'group',
      'roster',
      'trainingType',
    ]);
  });
});

describe('rankAndCap — prefix before substring', () => {
  it('ranks a prefix match ahead of a substring-only match for the same query', () => {
    const joanna = makeMemberHit('Joanna');
    const anna = makeMemberHit('Anna');

    // Input order deliberately puts the substring-only match FIRST, so a passing result proves
    // re-ranking happened rather than merely preserving input order.
    const result = rankAndCap([joanna, anna], 'ann', TODAY);

    expect(result.map((h: any) => h.displayName)).toEqual(['Anna', 'Joanna']);
  });
});

describe('rankAndCap — event bucketing', () => {
  it('orders upcoming/today ascending, then past descending', () => {
    const future = makeEventHit('Future', '2026-06-20');
    const today = makeEventHit('Today', '2026-06-15');
    const pastNear = makeEventHit('PastNear', '2026-01-02');
    const pastFar = makeEventHit('PastFar', '2025-11-30');

    // Shuffled input — a passing result proves re-ordering, not pass-through.
    const result = rankAndCap([pastFar, future, pastNear, today], 'e', TODAY);

    expect(result.map((h: any) => h.event.startDate)).toEqual([
      Option.some('2026-06-15'),
      Option.some('2026-06-20'),
      Option.some('2026-01-02'),
      Option.some('2025-11-30'),
    ]);
  });

  it('the midnight grace band: a team-local "today" one day BEHIND UTC todayIso still sorts upcoming', () => {
    // The band matters when the team is behind UTC: team-local `start_date` is `todayIso - 1`
    // ('2026-06-14' vs. `TODAY` = '2026-06-15'). Without the grace band, `isUpcoming` would test
    // `d >= todayIso`, and '2026-06-14' >= '2026-06-15' is false — the event would wrongly sink
    // into the past bucket even though it is happening today in the team's own timezone. With the
    // band (`upcomingFrom = todayIso - 1`), '2026-06-14' >= '2026-06-14' is true.
    const graceEvent = makeEventHit('GraceEvent', '2026-06-14');
    const clearlyUpcoming = makeEventHit('ClearlyUpcoming', '2026-06-20');
    const clearlyPast = makeEventHit('ClearlyPast', '2026-06-13');

    const result = rankAndCap([clearlyPast, clearlyUpcoming, graceEvent], 'e', TODAY);

    // Upcoming bucket (ascending) must contain the grace event ahead of the later
    // "clearly upcoming" event, and ahead of the past bucket.
    expect(result.map((h: any) => h.event.startDate)).toEqual([
      Option.some('2026-06-14'),
      Option.some('2026-06-20'),
      Option.some('2026-06-13'),
    ]);
  });
});

describe('rankAndCap — per-kind cap', () => {
  it('caps at 5 member hits and leaves the other kinds untouched', () => {
    const members = Array.from({ length: 9 }, (_, i) => makeMemberHit(`Member ${i}`));
    const event = makeEventHit('Practice', TODAY);
    const group = makeGroupHit('Alpha Squad');
    const roster = makeRosterHit('First Team');
    const trainingType = makeTrainingTypeHit('Fitness');

    const result = rankAndCap([...members, event, group, roster, trainingType], 'm', TODAY);

    const byKind = (kind: string) => result.filter((h: any) => h.kind === kind);
    expect(byKind('member')).toHaveLength(5);
    expect(byKind('event')).toHaveLength(1);
    expect(byKind('group')).toHaveLength(1);
    expect(byKind('roster')).toHaveLength(1);
    expect(byKind('trainingType')).toHaveLength(1);
  });
});

describe('rankAndCap — total cap', () => {
  it('TOTAL_LIMIT is exactly 25', () => {
    // With 5 kinds and PER_KIND_LIMIT 5, per-kind capping alone already bounds any input to
    // PER_KIND_LIMIT * 5 = 25 — so the behavioral test below cannot distinguish TOTAL_LIMIT=25
    // from any larger value (it would still observe exactly 25 either way). Pin the constant's
    // value directly here; the test below then only needs to prove the SLICE actually runs.
    expect(TOTAL_LIMIT).toBe(25);
  });

  it('caps the combined output at 25 with kind order preserved, applied AFTER per-kind ranking', () => {
    // 9 members pre-cap (> the per-kind cap of 5) plus 5 of every other kind: 29 raw hits in,
    // exactly 25 out — the per-kind cap alone already enforces this with 5 kinds today (the
    // plan's own "belt for a sixth kind" framing), so this pins that the combination still lands
    // on exactly 25, never 24 or 26, with the kind grouping intact.
    const members = Array.from({ length: 9 }, (_, i) => makeMemberHit(`Member ${i}`));
    const events = Array.from({ length: 5 }, (_, i) => makeEventHit(`Event ${i}`, TODAY));
    const groups = Array.from({ length: 5 }, (_, i) => makeGroupHit(`Group ${i}`));
    const rosters = Array.from({ length: 5 }, (_, i) => makeRosterHit(`Roster ${i}`));
    const trainingTypes = Array.from({ length: 5 }, (_, i) => makeTrainingTypeHit(`Type ${i}`));

    const result = rankAndCap(
      [...members, ...events, ...groups, ...rosters, ...trainingTypes],
      'e',
      TODAY,
    );

    expect(result).toHaveLength(25);
    expect(result.map((h: any) => h.kind)).toEqual([
      ...Array(5).fill('event'),
      ...Array(5).fill('member'),
      ...Array(5).fill('group'),
      ...Array(5).fill('roster'),
      ...Array(5).fill('trainingType'),
    ]);
  });
});

describe('rankAndCap — stability', () => {
  it('keeps input order for two hits with an equal ranking key', () => {
    // Both 'Zebra One' and 'Zebra Two' are prefix matches for 'z', so both land in the same
    // rank-0 bucket with an equal ranking key — a stable sort must preserve their relative
    // input order.
    const first = makeMemberHit('Zebra One');
    const second = makeMemberHit('Zebra Two');

    const result = rankAndCap([first, second], 'z', TODAY);

    expect(result.map((h: any) => h.displayName)).toEqual(['Zebra One', 'Zebra Two']);
  });
});
