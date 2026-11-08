import { ActivityLog, ActivityLogApi } from '@sideline/domain';
import { Option, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { isUnknownSeason, toSeasonSearch, validateSeasonSearch } from './activitySeason.js';

const id = Schema.decodeSync(ActivityLog.ActivitySeasonId);
const known = id('11111111-1111-4111-8111-111111111111');
const other = id('22222222-2222-4222-8222-222222222222');
const seasons = [
  new ActivityLogApi.ActivitySeason({
    id: known,
    startsAt: '2026-09-01T00:00:00Z',
    endsAt: Option.none(),
    isCurrent: true,
  }),
];

describe('validateSeasonSearch', () => {
  it('keeps a season id and earlier', () => {
    expect(validateSeasonSearch({ season: known })).toEqual({ season: known });
    expect(validateSeasonSearch({ season: 'earlier' })).toEqual({ season: 'earlier' });
  });

  it('drops a malformed value, so loader and page both see the default view', () => {
    expect(validateSeasonSearch({ season: 'foo' })).toEqual({});
    expect(validateSeasonSearch({ season: 42 })).toEqual({});
    expect(validateSeasonSearch({})).toEqual({});
    expect(toSeasonSearch('foo')).toBeUndefined();
  });
});

describe('isUnknownSeason', () => {
  it('flags a well-formed id that is not in the loaded seasons', () => {
    expect(isUnknownSeason(seasons, other)).toBe(true);
  });

  it('keeps known ids, earlier, the default, and anything before seasons load', () => {
    expect(isUnknownSeason(seasons, known)).toBe(false);
    expect(isUnknownSeason(seasons, 'earlier')).toBe(false);
    expect(isUnknownSeason(seasons, undefined)).toBe(false);
    expect(isUnknownSeason([], other)).toBe(false);
  });
});
