import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useListFilter } from '~/lib/useListFilter.js';

interface Row {
  name: string;
  owner?: string;
  active: boolean;
  rank: number;
}

const ROWS: ReadonlyArray<Row> = [
  { name: 'Zebra', owner: 'alice', active: true, rank: 1 },
  { name: 'Alpha', owner: 'bob', active: false, rank: 3 },
  { name: 'Mango', active: true, rank: 2 },
];

const FILTERS = [
  { value: 'active', labelKey: 'f.active', predicate: (r: Row) => r.active },
  { value: 'all', labelKey: 'f.all', predicate: () => true },
];

const SORTS = [
  { value: 'name', labelKey: 's.name', compare: (a: Row, b: Row) => a.name.localeCompare(b.name) },
  { value: 'rank', labelKey: 's.rank', compare: (a: Row, b: Row) => a.rank - b.rank },
];

const setup = () =>
  renderHook(() =>
    useListFilter(ROWS, {
      searchOf: (r: Row) => [r.name, r.owner],
      filters: FILTERS,
      sorts: SORTS,
    }),
  );

describe('useListFilter', () => {
  it('starts on the first filter and the first sort', () => {
    const { result } = setup();
    expect(result.current.filter).toBe('active');
    expect(result.current.sort).toBe('name');
    // "active" filter + "name" sort: Alpha is inactive and drops out.
    expect(result.current.filtered.map((r) => r.name)).toEqual(['Mango', 'Zebra']);
  });

  it('composes search, filter and sort rather than applying only the last one', () => {
    const { result } = setup();
    act(() => {
      result.current.setFilter('all');
      result.current.setSort('rank');
    });
    expect(result.current.filtered.map((r) => r.name)).toEqual(['Zebra', 'Mango', 'Alpha']);

    act(() => result.current.setSearch('a'));
    // Still sorted by rank, still unfiltered -- and 'Mango' matches on name while 'Zebra'
    // matches only via its `owner` field, proving every field from `searchOf` is searched.
    expect(result.current.filtered.map((r) => r.name)).toEqual(['Zebra', 'Mango', 'Alpha']);

    act(() => result.current.setFilter('active'));
    expect(result.current.filtered.map((r) => r.name)).toEqual(['Zebra', 'Mango']);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const { result } = setup();
    act(() => {
      result.current.setFilter('all');
      result.current.setSearch('  ZEB  ');
    });
    expect(result.current.filtered.map((r) => r.name)).toEqual(['Zebra']);
  });

  it('treats a blank query as no query', () => {
    const { result } = setup();
    act(() => {
      result.current.setFilter('all');
      result.current.setSearch('   ');
    });
    expect(result.current.filtered).toHaveLength(ROWS.length);
  });

  it('skips undefined search fields instead of throwing on them', () => {
    const { result } = setup();
    act(() => {
      result.current.setFilter('all');
      // Only Zebra has owner 'alice'; Mango has no owner at all.
      result.current.setSearch('alice');
    });
    expect(result.current.filtered.map((r) => r.name)).toEqual(['Zebra']);
  });

  it('does not mutate the caller-supplied array when sorting', () => {
    const { result } = setup();
    act(() => {
      result.current.setFilter('all');
      result.current.setSort('rank');
    });
    expect(ROWS.map((r) => r.name)).toEqual(['Zebra', 'Alpha', 'Mango']);
  });
});
