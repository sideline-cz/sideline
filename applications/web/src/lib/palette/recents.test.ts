// The round trip is the point: an entry is stored ENCODED, so a `SearchHit` read back out must
// still carry real `Option`s and `DateTime.Utc`s. `JSON.parse(JSON.stringify(hit))` hands back
// plain objects that `AssistantResultCard`'s `Option.isSome` calls would misread — that is the
// bug these tests pin, not the list mechanics.

import { type AiChatApi, EventApi } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearRecents, pushRecent, RECENTS_LIMIT, readRecents } from './recents.js';

const TEAM = 'team-1';
const OTHER_TEAM = 'team-2';

const eventHit = (title: string, eventId: string): AiChatApi.SearchHit => ({
  kind: 'event',
  event: new EventApi.EventInfo({
    eventId: eventId as never,
    teamId: TEAM as never,
    title,
    eventType: 'training',
    trainingTypeName: Option.none(),
    eventTypeId: Option.none() as never,
    eventTypeName: Option.none<Option.Option<string>>(),
    eventTypeColor: Option.none() as never,
    description: Option.none(),
    imageUrl: Option.none(),
    startAt: DateTime.makeUnsafe('2026-05-12T18:00:00.000Z'),
    endAt: Option.some(DateTime.makeUnsafe('2026-05-12T19:30:00.000Z')),
    location: Option.some('Hall 2'),
    locationUrl: Option.none(),
    status: 'active',
    allDay: false,
    seriesId: Option.none(),
    startDate: Option.some('2026-05-12'),
    endDate: Option.some('2026-05-12'),
  }),
});

beforeEach(() => {
  window.localStorage.clear();
});

describe('palette recents', () => {
  it('round-trips a hit back to real Options and DateTimes, not plain objects', () => {
    pushRecent(TEAM, { type: 'hit', hit: eventHit('Tuesday training', 'e1') });

    const [entry] = readRecents(TEAM);
    expect(entry?.type).toBe('hit');
    if (entry?.type !== 'hit' || entry.hit.kind !== 'event') throw new Error('wrong entry');

    // `Option.isSome` on a `JSON.parse`d plain object is exactly what this guards.
    expect(Option.isSome(entry.hit.event.location)).toBe(true);
    expect(Option.getOrNull(entry.hit.event.location)).toBe('Hall 2');
    expect(Option.isNone(entry.hit.event.description)).toBe(true);
    expect(DateTime.formatIso(entry.hit.event.startAt)).toBe('2026-05-12T18:00:00.000Z');
  });

  it('puts the newest first and drops an earlier visit to the same destination', () => {
    pushRecent(TEAM, { type: 'nav', to: '/a' });
    pushRecent(TEAM, { type: 'nav', to: '/b' });
    pushRecent(TEAM, { type: 'nav', to: '/a' });

    expect(readRecents(TEAM).map((e) => (e.type === 'nav' ? e.to : ''))).toEqual(['/a', '/b']);
  });

  it('caps the list at RECENTS_LIMIT', () => {
    for (let i = 0; i < RECENTS_LIMIT + 3; i += 1) pushRecent(TEAM, { type: 'nav', to: `/${i}` });

    expect(readRecents(TEAM)).toHaveLength(RECENTS_LIMIT);
  });

  it('keeps every team on its own list', () => {
    pushRecent(TEAM, { type: 'nav', to: '/a' });

    expect(readRecents(OTHER_TEAM)).toEqual([]);
  });

  it('clearRecents wipes every team, not just the active one', () => {
    pushRecent(TEAM, { type: 'nav', to: '/a' });
    pushRecent(OTHER_TEAM, { type: 'nav', to: '/b' });

    clearRecents();

    expect(readRecents(TEAM)).toEqual([]);
    expect(readRecents(OTHER_TEAM)).toEqual([]);
  });

  it('drops a corrupt or stale stored value instead of throwing', () => {
    window.localStorage.setItem('sideline:palette-recents:team-1', '{"not":"an array"}');

    expect(readRecents(TEAM)).toEqual([]);
  });
});
