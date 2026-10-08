import * as React from 'react';

/**
 * One selectable filter chip. `predicate` decides membership; the chip whose `value` is
 * `initialFilter` (or the first chip) starts selected.
 */
export interface ListFilterOption<T> {
  readonly value: string;
  readonly labelKey: string;
  readonly predicate: (item: T) => boolean;
}

/** One entry in the sort `<select>`. `compare` is a plain `Array.prototype.sort` comparator. */
export interface ListSortOption<T> {
  readonly value: string;
  readonly labelKey: string;
  readonly compare: (a: T, b: T) => number;
}

interface UseListFilterConfig<T> {
  /**
   * The text a row is searched by. Returning several fields lets one query match a display name
   * OR a username; matching is case-insensitive substring over the joined result.
   */
  readonly searchOf: (item: T) => ReadonlyArray<string | undefined>;
  readonly filters?: ReadonlyArray<ListFilterOption<T>>;
  readonly sorts?: ReadonlyArray<ListSortOption<T>>;
}

/**
 * Search + filter + sort over an in-memory list, which is all these pages need: the largest real
 * list in production is a 129-member roster, and every one of them already loads in full. Nothing
 * here paginates or touches the server — if a list ever outgrows that, the fix is a server query,
 * not a bigger hook.
 */
export function useListFilter<T>(
  items: ReadonlyArray<T>,
  { searchOf, filters, sorts }: UseListFilterConfig<T>,
) {
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState(filters?.[0]?.value ?? '');
  const [sort, setSort] = React.useState(sorts?.[0]?.value ?? '');

  const filtered = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    const active = filters?.find((f) => f.value === filter);
    const comparator = sorts?.find((s) => s.value === sort)?.compare;

    const matched = items.filter((item) => {
      if (active !== undefined && !active.predicate(item)) return false;
      if (needle === '') return true;
      return searchOf(item).some((field) => field?.toLowerCase().includes(needle) === true);
    });

    // `toSorted` would copy a second time; `matched` is already a fresh array from `filter`.
    return comparator === undefined ? matched : matched.sort(comparator);
  }, [items, search, filter, sort, searchOf, filters, sorts]);

  return { search, setSearch, filter, setFilter, sort, setSort, filtered };
}
