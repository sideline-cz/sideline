import React from 'react';
import { Button } from '~/components/ui/button';
import { tr } from '~/lib/translations.js';

/** One row of the shared save bar. Registered by `useSaveBarEntry`. */
export interface SaveBarEntry {
  readonly id: string;
  readonly label: string;
  readonly tab: string;
  readonly saving: boolean;
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly onSave: () => Promise<boolean>;
  readonly onDiscard: () => void;
}

/**
 * Render order for the bar's rows. Effects run child-first, so a shared
 * page-level entry (`settings`) would always register last if the bar
 * relied on insertion order — reordering rows under the user's cursor every
 * time a dirty/saving flag flips. Fixed order sidesteps that entirely.
 */
const ENTRY_ORDER: ReadonlyArray<string> = [
  'settings',
  'profile',
  'welcome',
  'onboarding',
  'email',
  'fio',
  'weights',
];

interface SaveBarRegistry {
  readonly register: (id: string, entry: SaveBarEntry | null) => void;
}

const noopRegistry: SaveBarRegistry = { register: () => {} };
const SaveBarRegistryContext = React.createContext<SaveBarRegistry>(noopRegistry);
const SaveBarEntriesContext = React.createContext<ReadonlyArray<SaveBarEntry>>([]);

export function SaveBarProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = React.useState<ReadonlyMap<string, SaveBarEntry>>(new Map());

  const register = React.useCallback((id: string, entry: SaveBarEntry | null) => {
    setEntries((prev) => {
      if (entry === null) {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      }
      const next = new Map(prev);
      next.set(id, entry);
      return next;
    });
  }, []);

  const registry = React.useMemo(() => ({ register }), [register]);

  const sortedEntries = React.useMemo(
    () =>
      [...entries.values()].sort((a, b) => ENTRY_ORDER.indexOf(a.id) - ENTRY_ORDER.indexOf(b.id)),
    [entries],
  );

  return (
    <SaveBarRegistryContext.Provider value={registry}>
      <SaveBarEntriesContext.Provider value={sortedEntries}>
        {children}
      </SaveBarEntriesContext.Provider>
    </SaveBarRegistryContext.Provider>
  );
}

/** Gives the page the current entry list, e.g. to compute a navigation blocker's `blocked` flag. */
export function useSaveBarEntries(): ReadonlyArray<SaveBarEntry> {
  return React.useContext(SaveBarEntriesContext);
}

interface UseSaveBarEntryOptions {
  readonly id: string;
  readonly label: string;
  readonly tab: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly onSave: () => Promise<boolean>;
  readonly onDiscard: () => void;
}

/**
 * Registers one card's save state with the bar. Only mounts a row while
 * `dirty` is true; a clean card is invisible to the bar.
 */
export function useSaveBarEntry({
  id,
  label,
  tab,
  dirty,
  saving,
  disabled = false,
  disabledReason,
  onSave,
  onDiscard,
}: UseSaveBarEntryOptions): void {
  const { register } = React.useContext(SaveBarRegistryContext);

  // Reassigned every render so the stable callbacks below always call the
  // latest closure, without needing to appear in the effect's deps.
  const handlers = React.useRef({ onSave, onDiscard });
  handlers.current = { onSave, onDiscard };

  const stableOnSave = React.useCallback(() => handlers.current.onSave(), []);
  const stableOnDiscard = React.useCallback(() => handlers.current.onDiscard(), []);

  React.useEffect(() => {
    if (!dirty) {
      register(id, null);
      return;
    }
    register(id, {
      id,
      label,
      tab,
      saving,
      disabled,
      disabledReason,
      onSave: stableOnSave,
      onDiscard: stableOnDiscard,
    });
    return () => register(id, null);
    // `register`, the primitive props, and the two STABLE wrapper callbacks
    // (identity never changes — see the `useCallback([])`s above) only.
    // Putting the raw `onSave`/`onDiscard` props or the entry object here
    // causes a setState-per-render loop, because a fresh object/closure is a
    // new reference every render — see AGENTS.md.
  }, [
    register,
    id,
    label,
    tab,
    dirty,
    saving,
    disabled,
    disabledReason,
    stableOnSave,
    stableOnDiscard,
  ]);
}

interface SaveBarRowProps {
  readonly entry: SaveBarEntry;
  readonly onInvalid: (tab: string) => void;
}

function SaveBarRow({ entry, onInvalid }: SaveBarRowProps) {
  const handleSave = async () => {
    const succeeded = await entry.onSave();
    if (!succeeded) onInvalid(entry.tab);
  };

  return (
    <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
      <div className='min-w-0'>
        <p className='min-w-0 truncate text-sm'>
          {tr('teamSettings_saveBar_dirtyIn', { form: entry.label })}
        </p>
        {entry.disabledReason && (
          <p className='text-xs text-muted-foreground'>{entry.disabledReason}</p>
        )}
      </div>
      <div className='flex gap-2 sm:flex-none'>
        <Button
          type='button'
          variant='outline'
          size='sm'
          className='flex-1 sm:flex-none'
          onClick={entry.onDiscard}
          aria-label={tr('teamSettings_saveBar_discardAria', { form: entry.label })}
        >
          {tr('teamSettings_saveBar_discard')}
        </Button>
        <Button
          type='button'
          size='sm'
          className='flex-1 sm:flex-none'
          onClick={() => void handleSave()}
          disabled={entry.saving || entry.disabled}
          aria-label={tr('teamSettings_saveBar_saveAria', { form: entry.label })}
        >
          {entry.saving ? tr('profile_saving') : tr('profile_saveChanges')}
        </Button>
      </div>
    </div>
  );
}

interface SaveBarProps {
  readonly onInvalid: (tab: string) => void;
}

/**
 * The single save bar for the whole page. Always mounted (empty when clean)
 * so a live region never gets inserted at the same moment its content
 * appears — that combination announces unreliably. `role=region` (from
 * `<section aria-label>`), never `role='status'`: `OnboardingCard` already
 * owns a `role='status'` live region on this page, and a second one makes
 * `getByRole('status')` ambiguous in the onboarding-settings e2e spec.
 */
export function SaveBar({ onInvalid }: SaveBarProps) {
  const entries = useSaveBarEntries();

  return (
    <section
      aria-label={tr('teamSettings_saveBar_regionLabel')}
      aria-live='polite'
      className='sticky bottom-0 z-20 mt-auto -mx-4 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]'
    >
      {entries.length > 0 && (
        <div className='mx-auto flex max-w-2xl flex-col gap-2 rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/60 animate-in fade-in-0 slide-in-from-bottom-2 duration-200'>
          <div className='flex max-h-[40vh] flex-col gap-2 overflow-y-auto'>
            {entries.map((entry) => (
              <SaveBarRow key={entry.id} entry={entry} onInvalid={onInvalid} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
