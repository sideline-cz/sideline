import { rankItem, rankings } from '@tanstack/match-sorter-utils';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

interface SearchableSelectOption {
  readonly value: string;
  readonly label: string;
}

interface SearchableSelectProps {
  readonly options: ReadonlyArray<SearchableSelectOption>;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly size?: 'sm' | 'default';
  readonly pinnedValues?: ReadonlyArray<string>;
  readonly id?: string;
  readonly ref?: React.Ref<HTMLButtonElement>;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean | 'true' | 'false';
}

const EMPTY_PINNED: ReadonlyArray<string> = [];

const filterOptions = (opts: ReadonlyArray<SearchableSelectOption>, query: string) => {
  if (!query) return opts;
  return opts.filter((opt) => {
    const { passed } = rankItem(opt.label, query, { threshold: rankings.CONTAINS });
    return passed;
  });
};

const sortAndPinOptions = (
  options: ReadonlyArray<SearchableSelectOption>,
  pinnedValues: ReadonlyArray<string>,
) => {
  const pinnedSet = new Set(pinnedValues);
  const pinned = pinnedValues
    .map((v) => options.find((o) => o.value === v))
    .filter((o): o is SearchableSelectOption => o !== undefined);
  const rest = [...options.filter((o) => !pinnedSet.has(o.value))].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  );
  return [...pinned, ...rest];
};

export function SearchableSelect({
  options,
  value,
  onValueChange,
  placeholder,
  disabled,
  className,
  size = 'default',
  pinnedValues,
  id,
  ref,
  'aria-describedby': ariaDescribedby,
  'aria-invalid': ariaInvalid,
}: SearchableSelectProps) {
  const resolvedPinnedValues = pinnedValues ?? EMPTY_PINNED;
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const listboxRef = React.useRef<HTMLDivElement>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setQuery('');
      setHighlightedIndex(0);
    }
    setOpen(nextOpen);
  };

  const sortedOptions = React.useMemo(
    () => sortAndPinOptions(options, resolvedPinnedValues),
    [options, resolvedPinnedValues],
  );

  const filteredOptions = React.useMemo(
    () => filterOptions(sortedOptions, query),
    [sortedOptions, query],
  );

  const selectedOption = options.find((o) => o.value === value);

  const handleSelect = (optionValue: string) => {
    onValueChange(optionValue);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filteredOptions.length === 0) return;
      setHighlightedIndex((prev) => Math.min(prev + 1, filteredOptions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filteredOptions.length === 0) return;
      setHighlightedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const highlighted = filteredOptions[highlightedIndex];
      if (highlighted) {
        handleSelect(highlighted.value);
      }
    }
  };

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setHighlightedIndex(0);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: highlightedIndex changes trigger re-render before effect, DOM query finds updated element
  React.useEffect(() => {
    if (!open) return;
    const listbox = listboxRef.current;
    if (!listbox) return;
    const highlighted = listbox.querySelector<HTMLElement>('[data-highlighted="true"]');
    if (highlighted) {
      highlighted.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex, open]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          ref={ref}
          id={id}
          type='button'
          role='combobox'
          aria-expanded={open}
          aria-haspopup='listbox'
          aria-describedby={ariaDescribedby}
          aria-invalid={ariaInvalid}
          disabled={disabled}
          data-slot='searchable-select-trigger'
          data-placeholder={selectedOption ? undefined : ''}
          className={cn(
            'border-input data-[placeholder]:text-muted-foreground [&>span]:line-clamp-1 flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&>span]:min-w-0',
            size === 'sm' && 'h-8',
            className,
          )}
        >
          <span>{selectedOption ? selectedOption.label : placeholder}</span>
          <ChevronDown className='size-4 opacity-50' />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className='w-auto min-w-[var(--radix-popover-trigger-width)] p-0'
        align='start'
        sideOffset={4}
      >
        <div className='sticky top-0 flex items-center border-b px-2 bg-popover'>
          <Search className='size-4 shrink-0 text-muted-foreground' />
          <input
            type='text'
            value={query}
            onChange={handleQueryChange}
            onKeyDown={handleKeyDown}
            placeholder={tr('searchable_select_search')}
            aria-autocomplete='list'
            className='flex-1 bg-transparent px-2 py-2 text-sm outline-none'
          />
          {query && (
            <button
              type='button'
              aria-label='Clear search'
              onClick={() => {
                setQuery('');
                setHighlightedIndex(0);
              }}
              className='text-muted-foreground hover:text-foreground'
            >
              <X className='size-4' />
            </button>
          )}
        </div>
        <div ref={listboxRef} role='listbox' className='max-h-60 overflow-y-auto'>
          {filteredOptions.length === 0 ? (
            <div className='px-3 py-6 text-center text-sm text-muted-foreground'>
              {tr('searchable_select_noResults')}
            </div>
          ) : (
            filteredOptions.map((option, index) => {
              const isSelected = option.value === value;
              const isHighlighted = index === highlightedIndex;
              return (
                <div
                  key={option.value}
                  role='option'
                  aria-selected={isSelected}
                  data-value={option.value}
                  data-highlighted={isHighlighted ? 'true' : undefined}
                  tabIndex={-1}
                  onClick={() => handleSelect(option.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleSelect(option.value);
                    }
                  }}
                  className={cn(
                    'flex cursor-default items-center gap-2 px-3 py-1.5 text-sm',
                    isHighlighted && 'bg-accent',
                  )}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  <span className='flex-1'>{option.label}</span>
                  {isSelected && <Check className='size-4' />}
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
