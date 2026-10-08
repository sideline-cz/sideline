import * as React from 'react';
import { tr } from '~/lib/translations.js';
import type { ListFilterOption, ListSortOption } from '~/lib/useListFilter.js';
import { cn } from '~/lib/utils';

/**
 * Wrapper for a list table. `overflow-x-auto` is load-bearing and predates this component — a
 * bare `<table>` sizes from max-content, so without it a long name widens the table past a
 * 360px viewport and parks the row actions off-screen (PR 723).
 *
 * The vertical scroller is `sm:`-gated on purpose. Nesting a fixed-height scroll box inside a
 * page that already scrolls is worse on a phone than just letting the page run, and search plus
 * the filter chips are the real answer to a long list at these row counts.
 */
export const listScrollClass = 'overflow-x-auto sm:max-h-[60vh] sm:overflow-y-auto';

/**
 * Pairs with `listScrollClass` on the table's `<thead>`. Needs an opaque background: rows scroll
 * *under* a sticky header, and a transparent one would let them show through.
 */
export const listHeaderClass = 'sm:sticky sm:top-0 sm:z-10 bg-background';

interface ListToolbarProps<T> {
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholderKey: string;
  filters?: ReadonlyArray<ListFilterOption<T>>;
  filter?: string;
  onFilterChange?: (value: string) => void;
  sorts?: ReadonlyArray<ListSortOption<T>>;
  sort?: string;
  onSortChange?: (value: string) => void;
  /** Extra controls rendered after the filter chips (e.g. the members "missing VS" chip). */
  children?: React.ReactNode;
  className?: string;
}

/**
 * Search box + filter chips + sort select for a list page. Lifted from `FinancesOverviewPage`'s
 * `ByMemberContent`, whose filter semantics were already agreed — that page now renders through
 * this component rather than keeping its own copy.
 */
export function ListToolbar<T>({
  search,
  onSearchChange,
  searchPlaceholderKey,
  filters,
  filter,
  onFilterChange,
  sorts,
  sort,
  onSortChange,
  children,
  className,
}: ListToolbarProps<T>) {
  const sortId = React.useId();

  return (
    <div className={cn('flex flex-wrap items-center gap-3', className)}>
      <input
        type='search'
        placeholder={tr(searchPlaceholderKey)}
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className='h-9 rounded-md border bg-background px-3 text-sm w-full sm:max-w-xs'
      />

      {filters !== undefined && filters.length > 0 && (
        <div className='flex gap-1 flex-wrap'>
          {filters.map((f) => (
            <button
              key={f.value}
              type='button'
              aria-pressed={filter === f.value}
              onClick={() => onFilterChange?.(f.value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                filter === f.value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-muted-foreground hover:bg-muted'
              }`}
            >
              {tr(f.labelKey)}
            </button>
          ))}
        </div>
      )}

      {children}

      {sorts !== undefined && sorts.length > 0 && (
        <div className='flex items-center gap-2 sm:ml-auto'>
          <label htmlFor={sortId} className='text-xs text-muted-foreground'>
            {tr('list_sortLabel')}
          </label>
          <select
            id={sortId}
            value={sort}
            onChange={(e) => onSortChange?.(e.target.value)}
            className='h-9 rounded-md border bg-background px-2 text-sm'
          >
            {sorts.map((s) => (
              <option key={s.value} value={s.value}>
                {tr(s.labelKey)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
