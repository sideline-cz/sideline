/**
 * The Cmd/Ctrl+K search palette (design `.work-plans/command-palette-search-design.md`,
 * plan `.work-plans/command-palette-search.md` §C). Owns the hotkey listener, the query +
 * 250ms debounce, the `useQuery` search (Pattern C, `applications/web/AGENTS.md:831`),
 * grouping, all seven render states and the "Ask the assistant" row.
 *
 * Takes no router hooks (organisms must not, `applications/web/AGENTS.md:26`) and owns no
 * `open` state — both are `AuthenticatedLayoutContent`'s, the same split
 * `AssistantConversation` uses for its own navigation concerns.
 *
 * Rows are rendered through the shipped `AssistantResultCard`, widened to `AiChatApi.SearchHit`
 * and wrapped in a cmdk `CommandItem` via its `renderWrapper` prop — `role='option'` may not
 * contain an anchor, and cmdk's Enter fires `onSelect`, not a click (design §4).
 *
 * `CommandDialog` (the shadcn-generated wrapper) is deliberately NOT used: it hardcodes
 * `<Command>` internally with no way to pass `shouldFilter`, which this palette requires
 * (design §3.6 — cmdk's default filter scores the explicit `value={kind:id}`, not the
 * rendered text, and would drop almost every row). `Dialog`/`DialogContent`/`DialogHeader` are
 * composed by hand instead. UNLIKE `CommandDialog` (whose `sr-only` `DialogHeader` sits as a
 * sibling of `DialogContent` — fine there, since that whole tree only exists while `open`), the
 * `sr-only` header here is nested INSIDE `DialogContent`, same as every other dialog in this repo
 * (`CreateChannelDialog.tsx`): this palette is always mounted (see reset-on-open below), so a
 * sibling header would leave a permanent `<h2 class="sr-only">` in the DOM of every authenticated
 * page, outside Radix's portal, even while closed.
 *
 * ponytail: the input's leading icon does not swap to a spinner during "loading over results"
 * (design §3.6) — that icon is hardcoded inside the generated, never-hand-edited
 * `ui/command.tsx`. Rows staying on screen during a refetch (the part that matters) still
 * works, since `placeholderData` keeps the previous result set live. Add the icon swap by
 * forking `CommandInput` locally if reviewers want the polish.
 */
import { type AiChatApi, SearchApi, Team } from '@sideline/domain';
import { useQuery } from '@tanstack/react-query';
import { Effect, Option, Schema } from 'effect';
import { Loader2, Sparkles } from 'lucide-react';
import React from 'react';
import { AssistantResultCard } from '~/components/molecules/assistant/AssistantResultCard.js';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '~/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { ApiClient, SilentClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

interface CommandPaletteProps {
  teamId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectHit: (hit: AiChatApi.SearchHit) => void;
  onAskAssistant: (question: string) => void;
}

type SearchHitKind = AiChatApi.SearchHit['kind'];

// Fixed order (design §5): matches the sidebar, the `SearchHit` union and the server's
// guaranteed array order. Never re-sorted client-side.
const KIND_ORDER: ReadonlyArray<SearchHitKind> = [
  'event',
  'member',
  'group',
  'roster',
  'trainingType',
];

// Plural headings (existing keys) — NOT `entityKindLabels`, whose singular forms are the
// per-row `sr-only` kind label instead (design §5).
const KIND_HEADING: Record<SearchHitKind, () => string> = {
  event: () => tr('event_events'),
  member: () => tr('team_members'),
  group: () => tr('team_groups'),
  roster: () => tr('team_rosters'),
  trainingType: () => tr('team_trainingTypes'),
};

function useOnlineStatus(): boolean {
  const [online, setOnline] = React.useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  React.useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);
  return online;
}

type Phase = 'offline' | 'idle' | 'loading' | 'error' | 'noResults' | 'results';

export function CommandPalette({
  teamId,
  open,
  onOpenChange,
  onSelectHit,
  onAskAssistant,
}: CommandPaletteProps) {
  const run = useRun();
  const teamIdBranded = React.useMemo(() => Schema.decodeSync(Team.TeamId)(teamId), [teamId]);
  const online = useOnlineStatus();

  const [query, setQuery] = React.useState('');
  const [debounced, setDebounced] = React.useState('');

  // Reset-on-open (`applications/web/AGENTS.md:1008`) — the dialog is always mounted. BOTH
  // pieces of state must reset: leaving `debounced` behind would keep `enabled` true for up to
  // 250ms, serving the previous term's results from the React Query cache instantly (design
  // §3.5).
  React.useEffect(() => {
    if (!open) return;
    setQuery('');
    setDebounced('');
  }, [open]);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  // The hotkey (design §3.1 / plan §C). Fires while an input is focused, deliberately — a
  // modifier chord no text control consumes. The `data-scroll-locked` guard (set on `<body>` by
  // every Radix overlay's `react-remove-scroll`) stops the palette opening on top of another
  // modal; it must not block CLOSING an already-open palette.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'k' ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      if (event.isComposing) return;
      if (!open && document.body.hasAttribute('data-scroll-locked')) return;
      event.preventDefault();
      onOpenChange(!open);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onOpenChange]);

  const isIdle = debounced.length < 2;
  const searchEnabled = open && online && !isIdle;

  const { data, isFetching, isError } = useQuery<ReadonlyArray<AiChatApi.SearchHit>>({
    queryKey: ['search', teamId, debounced],
    enabled: searchEnabled,
    queryFn: async () => {
      const effect = ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.search.search({ params: { teamId: teamIdBranded }, query: { q: debounced } }),
        ),
        Effect.mapError(() => new SilentClientError({ message: tr('search_error') })),
      );
      const result = await run()(effect);
      return Option.getOrThrow(result);
    },
    retry: false,
    throwOnError: false,
    // Keeps the previous term's rows on screen while a new one is in flight — the "loading over
    // results" state (design §3.6) — ONLY for incremental typing/backspacing over the same term
    // (design §3.6 describes no other case). A prefix relationship between the previous and next
    // debounced query is the signal: unrelated terms (including a fresh query after the dialog
    // was reopened) must fall through to the real `loading` phase instead of rendering a stale,
    // unrelated result set with no loading indicator (design §3.5).
    placeholderData: (previous, previousQuery) => {
      const prev = previousQuery?.queryKey[2];
      return typeof prev === 'string' &&
        prev.length > 0 &&
        (debounced.startsWith(prev) || prev.startsWith(debounced))
        ? previous
        : undefined;
    },
  });

  const phase: Phase = !online
    ? 'offline'
    : isIdle
      ? 'idle'
      : isFetching && data === undefined
        ? 'loading'
        : isError
          ? 'error'
          : data !== undefined && data.length === 0
            ? 'noResults'
            : data !== undefined && data.length > 0
              ? 'results'
              : 'idle';

  const trimmedQuery = query.trim();
  const showAskRow = online && trimmedQuery.length > 0;
  const looksLikeQuestion = trimmedQuery.endsWith('?') || trimmedQuery.split(/\s+/).length >= 4;
  const askLabel = looksLikeQuestion
    ? tr('search_askAssistant', { query: trimmedQuery })
    : tr('search_askAssistantAbout', { query: trimmedQuery });

  const hitsByKind = React.useMemo(() => {
    const map = new Map<SearchHitKind, Array<AiChatApi.SearchHit>>();
    for (const hit of data ?? []) {
      const list = map.get(hit.kind);
      if (list) list.push(hit);
      else map.set(hit.kind, [hit]);
    }
    return map;
  }, [data]);

  // cmdk's highlight must be controlled, not left to cmdk. While the query is still being
  // typed the Ask row is the only item, so cmdk highlights it — and it KEEPS that highlight
  // when results arrive. A blind Enter would then fire a rate-limited LLM turn instead of
  // opening the top result, which is the exact outcome putting the Ask row last is meant to
  // prevent. Re-point the highlight at the first rendered hit whenever the hit set changes.
  const firstHitValue = React.useMemo(() => {
    for (const kind of KIND_ORDER) {
      const hits = hitsByKind.get(kind);
      if (hits !== undefined && hits.length > 0 && hits[0] !== undefined) {
        return SearchApi.searchHitId(hits[0]);
      }
    }
    return undefined;
  }, [hitsByKind]);

  const [selected, setSelected] = React.useState<string>('');

  React.useEffect(() => {
    if (firstHitValue !== undefined) setSelected(firstHitValue);
  }, [firstHitValue]);

  // Deliberately NOT the same string as the visible offline/error copy (design §8 point 3
  // reads as if it should be verbatim the same). A visible `<div>` and this live region both
  // carrying the identical text produces two DOM nodes with identical accessible text, which
  // makes any `getByText(that copy)` lookup ambiguous — precisely the "second element with the
  // same content" hazard `AGENTS.md:61` warns about for live regions, just via text instead of
  // role. Offline/error already have zero informative COUNT to add, so the live region stays
  // silent for those two phases; the visible copy is still a `<div>` that changes and most
  // SR/browser pairs pick up the composite change. `noResults` and `results` both announce
  // through `search_resultCount` (0 in the no-matches case) — genuinely new information (a
  // number) no visible node states, so it never collides.
  const announcement =
    phase === 'noResults'
      ? tr('search_resultCount', { count: 0 })
      : phase === 'results' && data !== undefined
        ? tr('search_resultCount', { count: data.length })
        : '';

  const handleSelectHit = (hit: AiChatApi.SearchHit) => {
    onOpenChange(false);
    onSelectHit(hit);
  };

  const handleAskAssistant = () => {
    onOpenChange(false);
    onAskAssistant(trimmedQuery);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'overflow-hidden p-0',
          'top-4 translate-y-0 max-h-[85dvh]',
          'md:top-[50%] md:translate-y-[-50%] md:max-h-none',
        )}
      >
        <DialogHeader className='sr-only'>
          <DialogTitle>{tr('search_title')}</DialogTitle>
          <DialogDescription>{tr('search_description')}</DialogDescription>
        </DialogHeader>
        <Command loop shouldFilter={false} value={selected} onValueChange={setSelected}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={tr('search_placeholder')}
            maxLength={100}
          />
          <CommandList className='max-h-[50dvh] md:max-h-[400px]'>
            {phase === 'offline' && (
              <div className='py-6 text-center text-sm text-muted-foreground'>
                {tr('error_offline')}
              </div>
            )}
            {phase === 'idle' && (
              <div className='py-6 text-center text-sm text-muted-foreground'>
                {tr('search_hint')}
              </div>
            )}
            {phase === 'loading' && (
              <div className='flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground'>
                <Loader2 className='size-4 animate-spin' aria-hidden='true' />
                {tr('search_loading')}
              </div>
            )}
            {phase === 'error' && (
              <div className='py-6 text-center text-sm text-destructive'>{tr('search_error')}</div>
            )}
            {phase === 'noResults' && (
              <div className='py-6 text-center text-sm text-muted-foreground'>
                {tr('search_noResults', { query: debounced })}
              </div>
            )}
            {phase === 'results' &&
              KIND_ORDER.map((kind) => {
                const hits = hitsByKind.get(kind);
                if (hits === undefined || hits.length === 0) return null;
                return (
                  <CommandGroup key={kind} heading={KIND_HEADING[kind]()}>
                    {hits.map((hit) => (
                      <AssistantResultCard
                        key={SearchApi.searchHitId(hit)}
                        reference={hit}
                        teamId={teamId}
                        renderWrapper={(children, className) => (
                          <CommandItem
                            value={SearchApi.searchHitId(hit)}
                            onSelect={() => handleSelectHit(hit)}
                            className={cn(
                              className,
                              'border-transparent cursor-default',
                              'data-[selected=true]:bg-accent data-[selected=true]:border-accent-foreground/20',
                            )}
                          >
                            {children}
                          </CommandItem>
                        )}
                      />
                    ))}
                  </CommandGroup>
                );
              })}
            {showAskRow && (
              <>
                <CommandSeparator alwaysRender />
                <CommandGroup>
                  <CommandItem
                    value={`ask:${trimmedQuery}`}
                    onSelect={handleAskAssistant}
                    className='whitespace-normal text-left'
                  >
                    <Sparkles className='size-4 shrink-0 text-primary' aria-hidden='true' />
                    {askLabel}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
          <div aria-live='polite' aria-atomic='true' className='sr-only'>
            {announcement}
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
