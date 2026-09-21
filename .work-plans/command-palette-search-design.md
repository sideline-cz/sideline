# Design: Cmd/Ctrl+K command palette with app-wide search

UI/UX specification for a global search palette in `applications/web`. Cmd/Ctrl+K (or a header
button) opens a dialog, the user types, the server returns the team's matching **events, members,
groups, rosters and training types**, and selecting one navigates to it. One extra row — **Ask the
assistant** — hands the typed text to the shipped assistant page, prefilled and already sent.

Scope: `applications/web` + `packages/i18n`. The endpoint, the `SearchHit`/`EntityRef` domain split
and the server-side ranking live in the sibling plan `.work-plans/command-palette-search.md`; §2
here states only what the palette *consumes* and designs none of it. Where the two documents
overlap, **the plan is authoritative on the contract and this document is authoritative on the
surface**.

The read-only assistant (`.work-plans/ai-app-interaction-design.md`, shipped as `cb833d73`) is the
baseline. Where that document and the merged code disagree, **the code is authoritative** and this
spec follows the code.

**Effort: 3.5–4 days**, full scope — all five entity kinds plus the assistant hand-off. The palette
itself is small. What is not small: five permission gates that each have to be right, the
`SearchHit`/`EntityRef` contract split rippling through `toolTypes` / `refTokens` / `ChatAgent`, and
a hand-off that mutates URL state and fires an LLM turn. Sizing this as "a nice little search" was
wrong and is withdrawn.

---

## 0. Baseline facts (verified against the worktree, not assumed)

- **Cmd/Ctrl+K is free.** The only global chord is `SIDEBAR_KEYBOARD_SHORTCUT = 'b'`
  (`components/ui/sidebar.tsx:33`), whose handler is a plain unconditional `window` `keydown`
  listener (`:95-110`). The assistant design's "no global hotkey" non-goal was justified *solely*
  by `Cmd+B` being taken; it does not apply to `Cmd+K`.
- **No `cmdk`, no `ui/command.tsx`.** `applications/web/package.json` has neither. Both are added
  by this slice: `pnpm -C ./applications/web dlx shadcn@latest add command`, which pulls `cmdk` and
  generates `Command*` + `CommandDialog`. `ui/` is never hand-edited, so anything the generated file
  does not give us is done at the call site.
- **`AuthenticatedLayout` is team-scoped.** It is rendered only by
  `routes/(authenticated)/teams/$teamId/route.tsx`, always with a resolved `activeTeam`. `/profile`
  and `/no-team` render a bare `<Outlet/>`. So the palette lives in the team shell and needs no
  "which team?" logic and no null-team branch.
- **The header has free space.** `AuthenticatedLayout`'s sticky `h-16` header (`:131`) contains one
  `div.flex.items-center.gap-2.px-4` (`:132` — trigger + separator + breadcrumbs) and nothing else;
  the right-hand side is empty at every width.
- **`ENTITY_ROUTE` and `entityKindLabels`** ship in `lib/assistant/entityRoutes.ts` for all five
  kinds and are reused verbatim. `entityKindLabels` is **singular** (`assistant_result_event` =
  "Event") and stays the per-row `sr-only` label; group headings are the **plural** team/event keys
  (§5).
- **`AssistantResultCard`** (`molecules/assistant/AssistantResultCard.tsx:31-35`) takes
  `{ reference: AiChatApi.EntityRef; teamId: string; colorMap: TrainingTypeColorMap }` — all three
  required. It owns the five per-kind anatomies and builds its own `<Link>` inside each branch.
  **It never reads `reference.ref`** (verified, all five branches).
- **`AssistantResultRow`** already takes a `renderLink(children, className)` **render prop**, so the
  wrapper element is a seam that exists today.
- **`buildTrainingTypeColorMap(names)`** (`lib/event-colors.ts:110`) is how callers build the
  `colorMap`; `AssistantConversation.tsx:409-421` is the reference usage.
- Organisms **must not** use TanStack Router hooks (`applications/web/AGENTS.md:26`); importing
  `<Link>` is allowed. `AssistantConversation` already follows this — the palette matches it.
- **Dialogs are always-mounted and `open`-driven**, with a reset-on-open effect (`AGENTS.md:1008`).
- **Live regions:** put `aria-live` on an always-mounted parent, never nest one live region inside
  another (`AGENTS.md:61`), and prefer `aria-live='polite' aria-atomic='true'` over `role='status'`
  — a second `status` element in the tree makes Playwright's `getByRole('status')` ambiguous
  (`e94d8425`, `FioBankCard.tsx`).
- **No `<StrictMode>` anywhere in `applications/web/src`** (React 19.2.8). Ref guards in this spec
  are justified by re-running effects, not by double-invocation.

### Explicitly out of scope

Non-entity **commands** ("go to Settings", "create event", theme toggle). This is a search palette,
not an action palette. If it is ever wanted, `getTeamNavGroups` in `AppSidebar.tsx` is already the
permission-filtered list of destinations to feed it, and it slots in as one more `CommandGroup`.

---

## 1. User flow

1. User hits **Cmd/Ctrl+K** anywhere under `/teams/$teamId/*` (or taps the search button in the
   header — the only affordance on a phone).
2. A centred dialog opens with an empty input, focused. Below it: one hint line, plus the Ask row
   as soon as a single character is typed.
3. User types ≥2 characters. After 250 ms of quiet the palette queries the server.
4. Results appear grouped by kind, in a fixed order, rendered by the **shipped assistant result
   card** (§4).
5. ↑/↓ moves the highlight across all rows; **Enter** opens the highlighted entity and closes the
   palette; **Escape** closes it and restores focus to wherever it was.
6. The last row is always **Ask the assistant “…”**. Selecting it navigates to
   `/teams/$teamId/assistant?ask=<query>`, where the question is prefilled **and already sent**.

---

## 2. What the palette consumes from the search endpoint

Designed *against*, not designed. Fixed by the sibling plan:

| Contract point | Consequence for this surface |
|---|---|
| `GET /teams/:teamId/search?q=…`, `q` required, `isMinLength(1)` … `isMaxLength(100)` | The palette sends what was typed, verbatim, with no client-side parsing. §3.7 enforces the 100-char ceiling in the input itself. |
| Success is a **bare `Schema.Array(SearchHit)`** — no `{ hits, total, truncated }` wrapper | Nothing to unwrap; `data` is the row list. |
| Rows are **`AiChatApi.SearchHit`** — the five payload records **without** the per-turn `ref` token | §4's whole reuse argument. `AssistantResultCard`'s prop widens from `EntityRef` to `SearchHit` and loses nothing, because it never read `.ref`. |
| Stable identity is **`kind` + the per-kind id**, surfaced by `SearchApi.searchHitId(hit)` | React keys and the cmdk `value` (§4). There is **no `ref` field** on a `SearchHit`; an earlier draft of this doc said there was and was wrong. |
| Per-kind permission filtering is done **server-side** | §7. The client renders what it is given and never asks "may I see groups?". |
| **Caps are server constants** — 5 per kind, 25 total, applied after ranking | The client does **not** slice. A second cap on the client is dead code that silently diverges the day the server's changes. |
| Kind order in the array is `event, member, group, roster, trainingType`; within-kind order is already ranked | The client groups by kind in that same fixed order (§5) and **never re-sorts**. |

**Not needed:** a `total`, a relevance score in the payload, a cursor, highlight/snippet markup.
The palette shows at most 25 rows and the remedy for "too many matches" is a better query (§5).

If the endpoint's error channel carries typed tags (forbidden / rate-limited), the palette collapses
all of them into one error line (§3.6) — the recovery is identical in every case: retype, or ask the
assistant.

**What the server actually matches, so no copy over-promises it:** events on **title only**
(`applications/server/src/services/ai/readTools.ts:120` — `matchesQuery(r.title, query)`) and
members on **display name only** (`:351` — `applyQueryFilter(…, displayNameOf)`). Never location,
never jersey number, never a member's username. `search_hint` and `search_description` (§11)
therefore say "search events, members, groups, rosters and training types" and name no field.

---

## 3. Opening, closing, and the states in between

### 3.1 The shortcut

The `open` state lives in **`AuthenticatedLayoutContent`** (§10), not in the palette — so that any
number of triggers can raise it. The listener itself lives in `CommandPalette`, one component
mounted once by the team shell, matching `sidebar.tsx`'s idiom:

```ts
if (e.key !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
if (e.isComposing) return;                                    // IME composition owns the keystroke
if (!open && document.body.hasAttribute('data-scroll-locked')) return;  // another modal owns the screen
e.preventDefault();
onOpenChange(!open);
```

**It fires while the user is typing in an input — deliberately.** Three reasons:

1. `Cmd/Ctrl+K` is a **modifier chord that no text control consumes**. The suppress-while-typing
   rule exists for bare-character hotkeys (`/`, `j`/`k`), where firing would eat the user's
   character. Nothing is eaten here.
2. The only default it overrides is the browser's "focus the search bar" (Firefox, Chrome). Opening
   an in-app search on that chord is the *same intent*, not a hijack — and `preventDefault()` is
   what makes it ours.
3. The app's one existing chord (`Cmd+B`) already fires unconditionally from any focused element. A
   second chord with a different rule is an inconsistency the user feels and cannot explain.

The one carve-out is `data-scroll-locked` (set on `<body>` by `react-remove-scroll`, which every
Radix modal in this app uses). Opening a second overlay on top of a confirmation `AlertDialog` or
the mobile nav `Sheet` is never what the user meant.
*Ceiling:* this is an attribute sniff, not a registry of open overlays. It is one line, it is
correct for every Radix overlay in the app today, and the failure mode if a future non-Radix overlay
appears is a palette opening on top of it — recoverable with Escape. Upgrade path if that ever
happens: a tiny overlay-count context.

**Toggle, not open-only.** `Cmd+K` while the palette is open closes it, exactly like `Cmd+B`.
Predictable, and it costs nothing.

### 3.2 The touch affordance

There is no `Cmd+K` on a phone, so there **is** a visible trigger. It goes in the **header**, not in
the sidebar: below `md` the sidebar is behind a `Sheet`, so a sidebar search item would be two taps
(open nav, tap search) on exactly the device that has no keyboard shortcut. The header is visible at
every width. It is present at every width, because it is also how the shortcut gets discovered.

```tsx
<Button variant='ghost' size='sm' className='ml-auto mr-2' onClick={() => onOpenChange(true)}>
  <Search className='size-4' aria-hidden='true' />
  <span className='sr-only'>{tr('search_title')}</span>
  <kbd className='hidden rounded border bg-muted px-1.5 text-[10px] text-muted-foreground sm:inline'>
    {isMac ? '⌘K' : 'Ctrl K'}
  </kbd>
</Button>
```

- Sits in the header, after the breadcrumbs, pushed right with `ml-auto`. This requires one edit to
  `AuthenticatedLayout`: the existing `div` at `:132` becomes `flex-1 min-w-0` so the breadcrumbs
  truncate instead of shoving the button off-screen.
- `isMac` is `navigator.userAgent.includes('Mac')`, computed once. The `kbd` hides below `sm` — on a
  phone it is a lie.
- **No FAB.** The shipped assistant design rejected a floating launcher for this shell (Sonner
  top-right, `PwaInstallPrompt` under the header, mobile sidebar `Sheet`); nothing here reopens
  that. A header icon is the app's existing chrome pattern.

### 3.3 On the assistant page

**No special case: the palette opens the same way, and the Ask row behaves the same way.** Because
the ask target is the route we are already on, TanStack updates `search.ask` without remounting, the
route effect mints a new `pendingQuestion` with a **higher id**, and the question is **appended to
the running conversation** rather than starting a new one — which is the right behaviour, and it is
free (§6.3).

While the palette is open, Radix traps focus, so the composer cannot receive the keystrokes. On
close, Radix restores focus to the composer if that is where it was.

### 3.4 Focus

Everything comes from Radix `Dialog` + cmdk and **must not be overridden**:

| Moment | Behaviour | Source |
|---|---|---|
| Open | Focus moves into the dialog and lands on `CommandInput` | cmdk autofocus inside the Radix focus scope |
| While open | Focus is trapped; the list is navigated with `aria-activedescendant`, so focus never leaves the input | cmdk combobox model |
| Escape / select / outside click | Dialog closes, focus returns to the previously focused element | Radix `Dialog` |

No `onCloseAutoFocus` override, no manual `.focus()` calls, no `tabIndex` on rows.

### 3.5 Reset

Reset-on-open (`AGENTS.md:1008` rule 3 — the dialog is always mounted and never re-mounts). With
`useQuery` there is exactly one thing to reset:

```ts
React.useEffect(() => { if (open) setQuery(''); }, [open]);
```

The debounce effect follows `query` to `''`, `enabled` goes false, and the list falls back to the
idle state. React Query's cache still holds the last term, so re-typing it is instant — which is the
one good half of "recents", for free and with no store.

A palette that reopens showing last week's query and stale rows is worse than one that starts clean;
"repeat my last search" as a *listed* feature is deliberately not built (§3.6).

### 3.6 The states

All render **inside `CommandList`**, and every non-result one is a plain `<div>`, **not** a
`CommandItem` — a non-actionable row must never be arrow-selectable, and `CommandEmpty` is a
`CommandItem` in disguise for our purposes (see below).

> **cmdk gotcha, stated once because it will otherwise be re-discovered in review:**
> `<Command shouldFilter={false}>` is mandatory. Not because of unsearchable fields — the server
> matches events on title and members on display name only (§2), so "a member matched on jersey
> number" is not a case that exists. The actual reason: **every item carries an explicit
> `value={`${kind}:${id}`}`** (§4), and cmdk's default filter scores *that string*, not the rendered
> text. Left at its default, cmdk would score `"member:0f3a…"` against `"novák"`, get zero, and drop
> essentially every row in the list. `shouldFilter={false}` is the only correct setting here.
>
> A consequence: `CommandEmpty` renders only when cmdk's filtered count is 0, and the Ask row is
> always an item, so `CommandEmpty` would never fire. **The no-matches state is our own `div`.**

Drive the states off `useQuery`'s flags (§3.7), in this order:

| State | When | What renders |
|---|---|---|
| **Idle** | `debounced.length < 2` | One muted line: `search_hint`. **Plus the Ask row as soon as `query.trim().length > 0`** — a single-character query is still a question you can ask, and gating it at 2 would make the row appear, vanish and reappear as the user types. Only a genuinely empty input shows the hint alone. |
| **Loading** | `isFetching && data === undefined` | `Loader2 animate-spin` + `search_loading` ("Searching…"), centred, `py-6`. Plus the Ask row. |
| **Loading over results** | `isFetching && data !== undefined` (React Query's `placeholderData: (prev) => prev`) | Rows stay put; the input's leading `Search` icon swaps to `Loader2 animate-spin`. No skeletons, no flash — the list never empties between keystrokes. |
| **Results** | `data.length > 0` | §5 |
| **No matches** | settled, `data.length === 0` | `search_noResults` — "No matches for “{query}”", muted, centred — **plus the Ask row**, which is then the only item and therefore auto-highlighted: Enter asks the assistant. |
| **Error** | `isError` | `search_error` — "Search isn't working right now." in `text-destructive`, plus the Ask row. **No retry button:** editing the query retries automatically (a new `queryKey`), and the assistant is the real escape hatch. One dead-looking button fewer. |
| **Offline** | `navigator.onLine === false` | Reuses the existing `error_offline` ("You're offline"). The query is `enabled: false` and the **Ask row is hidden** — the assistant needs the network too, and offering it would be a dead click. |

**Nothing before typing — no recents list, no suggestions.** A listed recents feature needs per-team
persistence, eviction and a "clear recents" affordance (a privacy question on a shared device), all
for a palette whose median session is "type three letters, press Enter". Suggested *entities* would
need a second endpoint. The hint line does the one job the empty state has: telling the user what is
searchable. *Add recents when* someone reports re-searching the same member daily; `localStorage`
keyed by `teamId`, last 5, is the shape.

### 3.7 Querying — `useQuery`, Pattern C

Not `useRun` + `useState` + a hand-rolled stale guard. This is on-demand data keyed by a string,
which is the exact shape `applications/web/AGENTS.md:831` ("Pattern C: Per-Row Lazy Fetch With
`useQuery` + `useRun`") exists for, and it deletes three problems rather than solving them:

- **Staleness:** React Query keys by `['search', teamId, debounced]`. A late response for `"jan"`
  lands in `"jan"`'s cache entry and is never rendered while the input reads `"jana"`. The
  `requestIdRef` counter an earlier draft specified is unnecessary — delete it.
- **Flicker between keystrokes:** `placeholderData: (prev) => prev` keeps the previous term's rows
  on screen, which is exactly the "loading over results" state above, for one line.
- **Backspace:** returning to a previously typed term renders from cache with no request.

```tsx
const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);   // top of component, Pattern C rule 6

const [debounced, setDebounced] = React.useState('');
React.useEffect(() => {
  const t = setTimeout(() => setDebounced(query.trim()), 250);
  return () => clearTimeout(t);
}, [query]);

const { data, isFetching, isError } = useQuery<ReadonlyArray<AiChatApi.SearchHit>>({
  queryKey: ['search', teamId, debounced],
  enabled: open && online && debounced.length >= 2,
  queryFn: async () => { /* ApiClient → api.search.search, Effect.mapError(() => ClientError.make(tr('search_error'))), Option.getOrThrow(await run()(effect)) */ },
  retry: false,
  throwOnError: false,
  placeholderData: (prev) => prev,
});
```

- **Min length 2.** One character matches nearly everything and burns a round trip per keystroke.
  (The *Ask* row is not gated on this — §6.1.)
- **250 ms debounce**, one `setTimeout` in an effect, cleared on change and unmount. No
  `useDebouncedValue` hook.
- **`maxLength={100}` on `CommandInput`.** The endpoint's `q` is
  `isMaxLength(100)`; without the attribute the 101st character turns a working search into a
  generic error line with no explanation and no way for the user to connect cause to effect. The
  input simply stops accepting characters instead — the standard, wordless, native behaviour. No
  counter, no warning copy.
- `run()` is called with no `RunOptions`, so `useRun`'s automatic toast stays off (Pattern C rule 3)
  — the error line inside the palette is the single report, exactly as the assistant does per-turn.

---

## 4. Result rows: reuse the shipped card, do not write a denser one

**Decision: the palette renders `AssistantResultCard`, through a widened `reference` prop and a new
optional `renderWrapper`.** Not a second row component.

The density objection does not survive contact with the numbers. `AssistantResultRow` is `h-12`
(48px) with a two-line text column. A palette row wants to be **at least** 44px on touch — that is
the accessibility floor, and this app is used at the side of a pitch. VS Code's 22px rows are a
desktop-only, monospace-label convention that would be actively worse here. Spotlight, Raycast and
Linear all sit at 40–50px. So the "denser palette row" would differ from the shipped row by roughly
nothing visual — and would cost a second renderer for the same five kinds, each with its own
`Option` handling, colour-bar maths, role-badge limit and status badge. That is the drift risk, paid
for a difference no user can see.

What genuinely differs is **the wrapper element**, and that seam already exists:

- Chat: the row is one `<a>` (`<Link>`), built per kind inside `AssistantResultCard`.
- Palette: the row must be a cmdk `CommandItem` (`role='option'`). An anchor inside `role='option'`
  is a nested-interactive control — the exact hazard `AssistantResultCard` already avoids with
  `EffectiveRolesList` — and it breaks cmdk's Enter handling, which fires `onSelect`, not a click.

### The change to `AssistantResultCard` (one widened prop, one new prop, five one-line edits)

```ts
interface AssistantResultCardProps {
  /** Widened from `EntityRef` to `SearchHit`: the card reads only the payload records, never
   *  `.ref`, so chat (which passes an `EntityRef`) still satisfies this — `EntityRef` is
   *  `SearchHit` plus `ref`. */
  reference: AiChatApi.SearchHit;
  teamId: string;
  colorMap: TrainingTypeColorMap;
  /** Overrides the default per-kind `<Link>` wrapper. The command palette passes a `CommandItem`. */
  renderWrapper?: (children: React.ReactNode, className: string) => React.ReactElement;
}
```

Each of the five branches becomes
`renderLink={renderWrapper ?? ((children, className) => <Link to={ENTITY_ROUTE.x} params={…}>…)}`.
The default is byte-identical to today, so the chat surface cannot regress. `AssistantResultRow` is
**not touched at all** — its `renderLink` render prop was already the right abstraction.

### The palette's call site — all three required props, not just the hit

An earlier draft of this document showed only `renderWrapper` and would not have typechecked:
`teamId` and `colorMap` are required. The palette builds the colour map the same way
`AssistantConversation.tsx:409-421` does, over the hits it has:

```tsx
const colorMap = React.useMemo(
  () =>
    buildTrainingTypeColorMap(
      (data ?? []).flatMap((hit) =>
        hit.kind === 'event' && Option.isSome(hit.event.trainingTypeName)
          ? [hit.event.trainingTypeName.value]
          : [],
      ),
    ),
  [data],
);

// per hit:
<AssistantResultCard
  key={`${hit.kind}:${searchHitId(hit)}`}
  reference={hit}
  teamId={teamId}
  colorMap={colorMap}
  renderWrapper={(children, className) => (
    <CommandItem
      value={`${hit.kind}:${searchHitId(hit)}`}
      onSelect={() => { onOpenChange(false); onSelectHit(hit); }}
      className={cn(className, 'border-transparent cursor-default',
                    'data-[selected=true]:bg-accent data-[selected=true]:border-accent-foreground/20')}
    >
      {children}
    </CommandItem>
  )}
/>
```

- `searchHitId` is `SearchApi.searchHitId` from the plan's §B — the same function the server ranks
  with. `kind:` is prefixed because ids are only unique *within* a kind.
- `border-transparent` over the row's `border`: tailwind-merge keeps both (different properties), so
  the 1px box stays for layout and forced-colors mode while the visible card outline disappears —
  a bordered card inside a palette list reads as heavy chrome.
- `value` is explicit and unique; cmdk deduplicates items by `value`, and two members can share a
  display name. It is also why `shouldFilter={false}` is mandatory (§3.6).
- Hover/focus-ring classes from `ROW_CLASSNAME` are inert here (cmdk drives `data-selected`), which
  is why they are simply left alone rather than stripped.
- The `colorMap` is scoped to the current result set, so an event's colour can differ between the
  palette and the calendar. It already differs between chat turns today — `buildTrainingTypeColorMap`
  hashes the *name*, so a given training type is stable per name; only the palette's set of names
  varies, and the hash does not depend on the set.

**What each row shows per kind** is therefore *whatever `AssistantResultCard` shows* — that is the
point. For review convenience, as shipped:

| Kind | Leading | Primary | Secondary | Trailing |
|---|---|---|---|---|
| `event` | colour bar (`getEventColor`) + `Calendar` | `title` | date range · `event_allDayLabel` · type · location, `·`-joined, empty parts dropped | status `Badge` + `eventStatusClasses` |
| `member` | `Avatar size-8` (URL or initials) | `displayName` | `#jersey` + up to 2 `RoleBadge` (1 on mobile) + `+n` | `roster_inactive` when inactive |
| `group` | `UserCog` | `{emoji} {name}` | `group_memberCount` | `ColorDot` |
| `roster` | `UsersRound` | `{emoji} {name}` | `roster_memberCount` | `ColorDot` + active/inactive badge |
| `trainingType` | `Dumbbell` | `name` | `owner / member` group names | — |

Note that a row *displays* location and jersey number but is not *matched* on them (§2). That is a
normal and unremarkable property of a result row; it is called out only so nobody writes copy that
promises otherwise.

Each row keeps its `sr-only` kind label (§8). The mobile role-badge limit comes free — the card
already calls `useIsMobile()` internally.

**The one thing lost** by not being an anchor: middle-click / ⌘-click to open in a new tab. Accepted
— a palette is a keyboard accelerator, the entity's own page is one click away from anywhere else in
the app, and `role='option'` forbids the nested link that would restore it.

---

## 5. Presentation and the keyboard model

### Grouping and order

One `CommandGroup` per kind, **fixed order**, with **plural** headings taken from keys that already
exist:

| # | Group | Heading key (existing) |
|---|---|---|
| 1 | Events | `event_events` |
| 2 | Members | `team_members` |
| 3 | Groups | `team_groups` |
| 4 | Rosters | `team_rosters` |
| 5 | Training types | `team_trainingTypes` |

Plural, not `entityKindLabels` — those are singular ("Event", "Member") because they are the
per-row `sr-only` kind label, and a heading over five rows reading "Event" is wrong in both locales.
Both sets already ship in `en` and `cs`; no new key either way.

Order is **fixed, not relevance-sorted across kinds**. It matches the sidebar, the `SearchHit`
union, *and* the server's guaranteed array order, so "group by kind in a fixed order" and "render in
encounter order" produce the same list — the client just does not depend on the server for it. A
palette is used dozens of times a week by the same people; a stable spatial layout is worth more
than a marginally better first row, and reordering groups per query makes the list feel like it is
moving under the user's hand. **Within** a group the client never re-sorts: the server already
ranked (upcoming events first, prefix matches first elsewhere).

**A group with no results is not rendered** — no empty headings, ever (§7).

**No client-side slicing.** The server caps at 5 per kind and 25 total, after ranking. A
`.slice(0, 5)` here would be invisible today and wrong the day the server's cap changes. There is no
"show more" row either: a "see all matching events" link would need list routes that accept a search
param — they do not have one, so the link would be a lie. *Add when* the entity list pages grow real
server-side search.

`CommandList` is `max-h-[400px] overflow-y-auto` on desktop (`max-h-[50dvh]` on mobile, §9); cmdk
scrolls the highlighted row into view.

### Keyboard

| Key | Behaviour | Owner |
|---|---|---|
| ↑ / ↓ | Move the highlight across **all** rows, crossing group boundaries; wraps at the ends | cmdk |
| Enter | Activate the highlighted row: close + `onSelectHit` | our `onSelect` |
| Escape | Close (one press — it does **not** first clear the query; one gesture, one meaning) | Radix |
| Tab | Cycles focusable elements *inside the trap* — i.e. back to the input. It does **not** move the highlight. `role='listbox'` is arrow-navigated by definition, and making Tab a second arrow key breaks the one thing screen-reader users can rely on | Radix |
| Typing | Filters via the server (§3.7); the highlight resets to the first row on each settle | cmdk |

**The first row is auto-highlighted** (cmdk default). Two consequences worth naming because they are
the design: with results, blind `Cmd+K → type → Enter` opens the top hit; with no results, the Ask
row is the only item, is therefore first, and the same muscle memory asks the assistant.

---

## 6. The "Ask the assistant" row

### 6.1 Placement

**Always present once `query.trim().length > 0`** — including below the 2-character search floor,
including while loading, including on error. Hidden only when the input is empty and when offline.
It renders as the **last block**: a `CommandSeparator` followed by a heading-less `CommandGroup`
with one item.

It is keyed off the **live** `query`, not the debounced value, so it tracks the input with no lag.
(§3.6's Idle row said "no Ask row" in an earlier draft; that contradicted this section and is
resolved in favour of showing it. A one-character query is a perfectly askable question, and a row
that appears, disappears and reappears while the user types is worse than one that is simply there.)

Last, not first — because the common case is "find the thing", and a first-position Ask row would
make the default Enter fire a slow, rate-limited LLM turn instead of opening the top hit. When there
are no matches it is last *and* first, which is exactly when it should be the default.

Always present, not only on zero results — "I can see three Jan Nováks and I want to know which one
is on Thursday's roster" is the highest-value moment for the assistant, and it happens when the
search **succeeded**.

### 6.2 Copy

Two phrasings, chosen by a locale-independent heuristic:

```ts
const looksLikeQuestion = q.endsWith('?') || q.split(/\s+/).length >= 4;
```

| Shape | Key | en |
|---|---|---|
| Question (`?` or ≥4 words) | `search_askAssistant` | Ask the assistant: “{query}” |
| Name-like (1–3 words, no `?`) | `search_askAssistantAbout` | Ask the assistant about “{query}” |

"Ask the assistant: “Novák”" reads like a broken sentence; "Ask the assistant about “Novák”" reads
like an offer. One ternary over two literal keys, no computed key names.
*Ceiling:* word count plus `?`. No interrogative word lists — those are per-locale data that rot,
and Czech questions frequently start with the verb. The failure mode is a slightly stiff label, not
a wrong action.

Icon: `Sparkles` — the assistant's glyph everywhere else in the app.

**The row is shown even when the assistant is disabled for the team,** and §6.4 says what happens
then. The palette has no capabilities data, and fetching `/ai/capabilities` on every palette open to
hide one row is a request per open for nothing. This is the shipped precedent, verbatim: the
sidebar's Assistant nav item is unconditional too, because "a nav item that silently disappears
per-team is more confusing than a page that says why it is unavailable".

### 6.3 Prefilled and already sent

Selecting it closes the palette and calls `onAskAssistant(query.trim())`; the **layout** navigates
(§10):

```ts
void navigate({ to: '/teams/$teamId/assistant', params: { teamId }, search: { ask: question } });
```

The param is **`ask`**, not `q` — `q` is the search endpoint's query param and reusing the letter
across two unrelated meanings in the same feature is how someone later wires the wrong one.

Three edits carry it from there:

1. **`routes/(authenticated)/teams/$teamId/assistant.tsx`** — `validateSearch` for
   `Schema.Struct({ ask: Schema.optional(Schema.String) })` (the `events.index.tsx:8` idiom), then
   an effect that mints a `pendingQuestion` and strips the param:

   ```tsx
   const [pending, setPending] = React.useState<{ text: string; id: number } | undefined>();
   const idRef = React.useRef(0);
   React.useEffect(() => {
     const text = ask?.trim().slice(0, 2000);          // clamp, do not reject — see below
     if (text === undefined || text.length === 0) return;
     idRef.current += 1;
     setPending({ text, id: idRef.current });
     void navigate({ to: '.', params: { teamId }, search: {}, replace: true });
   }, [ask, teamId, navigate]);
   ```

   **Clamp with `.slice(0, 2000)`. Do not validate with `Schema.check(isMaxLength(2000))`** — and
   this is not a stylistic preference. A schema check on `validateSearch` *rejects into the route
   error boundary*; it does not clamp. But the worse failure is the one that happens if neither is
   done, because it is silent:

   - `handleSend` optimistically appends the user's turn (`AssistantConversation.tsx:255-268`), then
     calls `runExchange`.
   - `runExchange` calls `toChatMessages` at `:191`, which constructs
     `new AiChatApi.ChatMessage({ role, content })`. `ChatMessage.content` is
     `isMinLength(1)` + `isMaxLength(2000)` (`AiChatApi.ts:21-27`), so a 2001-character question
     **throws synchronously**.
   - That line is **before `setSubmitting(true)` (`:193`) and outside the `try` (`:249`)**. Nothing
     catches it, no error turn is committed, no request is made, nothing is logged.

   The user sees their own question appear and then nothing at all, permanently, with no way to tell
   whether it is still thinking. Slicing at the route boundary makes a hand-crafted URL produce a
   truncated question instead of a dead page. Truncation is silent too, but it is 2000 characters of
   silent, which no human pastes into a palette by accident.

   Stripping matters independently: without it, a refresh re-sends the question and burns another
   LLM turn against the user's rate limit.

2. **`AssistantPage`** — one pass-through prop, no logic:
   `pendingQuestion?: { text: string; id: number }`.

3. **`AssistantConversation`** — auto-send once per id:

   ```ts
   const sentIdRef = React.useRef(0);
   React.useEffect(() => {
     if (pendingQuestion === undefined || sentIdRef.current >= pendingQuestion.id) return;
     sentIdRef.current = pendingQuestion.id;    // set BEFORE the async call
     void handleSend(pendingQuestion.text);
   }, [pendingQuestion, handleSend]);
   ```

   `{ text, id }` rather than a bare `string` is the whole point: the route strips `ask` immediately,
   so asking the **same** question twice in a row would be swallowed by a value-equality guard. A
   monotonic id makes the second ask a genuinely new event. `handleSend`'s identity changes with
   `turns`, so this effect re-runs on every turn — the ref guard, not the dependency array, is what
   makes it fire once. (Do not "fix" it by trimming deps; that is how the next person breaks it.)

Everything else is already built: the optimistic user bubble, the thinking indicator, the 429
countdown and the `generated: false` alert all apply unchanged to an auto-sent turn.

**Why not an inline chat in the palette** — settled by the user, and the code agrees: result cards
are `h-12` rows with a status badge and up to two role badges, laid out against the assistant page's
`max-w-3xl` column. A 640px dialog with a 400px list is not that surface, and building a second,
narrower answer renderer is the same drift this spec refuses in §4.

### 6.4 When the assistant is disabled

`AssistantPage` renders the disabled panel when `enabled === false` (`AssistantPage.tsx:29-36`) and
`AssistantConversation` never mounts, so **`pendingQuestion` is silently discarded**. That is the
correct outcome — there is nothing to send it to — but "silently" needs to be a designed outcome,
not an accident. What the user sees:

- They select "Ask the assistant about “Novák”". The palette closes.
- They land on `/teams/$teamId/assistant` (the `ask` param is stripped by the same effect, which
  runs regardless of `enabled`, so a refresh does not retry and the URL is clean).
- The page shows the existing `assistant_disabled_title` / `assistant_disabled_body` panel: "The
  assistant isn't available" / "The assistant isn't available for this team right now. Your team
  admin can tell you more."

Their question is not echoed back to them. That is deliberate: showing "Novák" above a panel saying
the assistant is unavailable stages a conversation that cannot happen and invites a second attempt.
An unavailable feature should look unavailable, not broken-mid-thought. The navigation itself is the
answer to "what happened to my question" — they are on the assistant page, and the assistant page
says why.

**No new key.** The two existing ones are already correct for this landing.

---

## 7. Permissions: partial results are the normal case

The server filters per entity kind, and the asymmetry is unavoidable: a member without
`group:manage` gets **no group results at all**, for any query. "Absent because forbidden" is
therefore deliberately **indistinguishable** from "absent because nothing matched" — that is a
security property (never confirm the existence of what the caller cannot see), not an oversight.

The design's job is to make sure the indistinguishable case reads as *normal*, never as breakage:

- **No empty group headings.** A group renders only when it has ≥1 row, so a member simply never
  sees a "Groups" heading. There is no gap, no greyed section, no lock icon, nothing to notice.
- **The no-matches copy is kind-agnostic.** "No matches for “x”" — never "no matches in the kinds
  you can see", which invites "what am I missing?" and answers a question nobody asked.
- **No count, anywhere in the visible UI.** "3 of 5 sections" or "showing 12 results in 2
  categories" would turn an invisible gap into a visible one. The only count in the feature is
  `search_resultCount`, which is `sr-only` and states a plain total (§8) — a screen-reader user
  hears "7 results", the same thing a sighted user sees, not "7 of a possible 5 kinds".
- **No explanatory banner, ever.** Telling a player that groups exist but are hidden leaks the
  existence of data they cannot open and turns a normal search into a permissions lecture.
- The `search_hint` idle line lists all five kinds regardless of role. It describes the feature, not
  the caller's grants; it is one static string, and per-role variants would need permission data the
  palette does not have. Two users on the same team can get different results for the same query and
  neither has been told anything is missing — which matches every other list in this app (the
  sidebar, the events page) and is what those users already expect.

The failure mode this avoids is a user reading a partial result set as a bug. They read "here is
what matched", which is the truth from where they stand.

---

## 8. Accessibility

### What cmdk + Radix give us (do not re-implement)

| Semantics | Where from |
|---|---|
| `role='combobox'` on the input, with `aria-expanded`, `aria-controls`, `aria-activedescendant` | cmdk `CommandInput` |
| `role='listbox'` on the list; `role='option'` + `aria-selected` on items | cmdk |
| `role='group'` + `aria-labelledby` linking each group to its heading | cmdk `CommandGroup` |
| `role='dialog' aria-modal='true'`, focus trap, Escape, scroll lock, focus restore | Radix `Dialog` |

### What we must add

1. **`DialogTitle` + `DialogDescription`, both `sr-only`.** Radix logs an accessibility error
   without a title. shadcn's `CommandDialog` takes `title` / `description` props for exactly this:
   `search_title` and `search_description`.
2. **The `sr-only` kind label on every row** — kept, even though each row sits in a labelled group.
   Group-name announcement on entering a group is inconsistent across SR/browser pairs; the label is
   one `<span>` the shipped row already renders (`entityKindLabels`, singular), and the cost of
   keeping it is one extra word.
3. **One result-count live region**, and only one:

   ```tsx
   <div aria-live='polite' aria-atomic='true' className='sr-only'>{announcement}</div>
   ```

   - **Permanently mounted** inside the dialog content, as a **sibling of `CommandList`, never
     inside it.** Most SR/browser pairs only announce mutations inside a region that already
     existed, and a live region *inside* `role='listbox'` fights `aria-activedescendant`, which is
     already announcing every highlight change — the user would hear the row and the count on every
     arrow press.
   - **`aria-live` + `aria-atomic`, not `role='status'`.** Identical announcement; avoids
     registering a second `status` element, which is how `getByRole('status')` became ambiguous and
     broke two E2E specs in `e94d8425`.
   - It holds exactly one string at a time — `search_resultCount` on a settled result set, or the
     no-matches / error / offline copy — and updates only when the query settles, never per
     keystroke. It is derived from `data` / `isError`, both of which only change on settle, so it
     cannot chatter.
   - **This is the nested-live-region bug not being repeated.** The assistant's `role='log'`
     `aria-live='polite'` container is on the *page*, outside this dialog; the palette's region is
     the only live region inside the dialog; no component inside the palette carries an `aria-live`
     of its own, and the loading line is a plain `<div>`, not a `role='status'`.

4. **Nothing interactive inside a row** (§4) — `role='option'` containing a link or button is
   invalid and unnavigable. This is the same constraint that keeps `EffectiveRolesList` out of
   `AssistantResultCard`.
5. **Hit targets and contrast:** rows stay `h-12` (48px). Selection is `bg-accent` /
   `text-accent-foreground` theme tokens, and is *also* carried by `aria-selected` and
   `aria-activedescendant` — never by colour alone. The header trigger is a standard `Button` with
   its shared `focus-visible:ring-[3px]`.
6. **Reduced motion:** the only animations are the dialog's existing shadcn enter/exit and the
   `animate-spin` loader, both already used app-wide.

---

## 9. Mobile (< 768px, the `useIsMobile()` breakpoint the sidebar uses)

- **Entry is the header button** (§3.2) — not a sidebar item (the sidebar is behind a `Sheet` here),
  no chord, no FAB.
- **It stays a `Dialog`, not a `Sheet`.** A bottom sheet would be covered by the soft keyboard the
  instant the input autofocuses, and the animation fights the mobile nav `Sheet` the shell already
  owns. Positioning at the call site: `top-4 translate-y-0 max-h-[85dvh]` so the dialog is pinned
  near the top with the keyboard open, `dvh` so the collapsing URL bar does not clip it.
- **`CommandList` is `max-h-[50dvh]`** below `md` — roughly 5–6 rows visible above the keyboard,
  which is one full group.
- **Autofocus is kept.** The user tapped a search button; the keyboard appearing is the point.
- **Rows need no mobile variant**: `h-12` is already above the 44px guideline, `truncate` +
  `min-w-0` keep every row to one line, and the member role-badge limit already drops to 1 via the
  card's own `useIsMobile()`.
- **The Ask row wraps** — `whitespace-normal text-left` so a long quoted query becomes two lines
  rather than truncating the user's own words, which is the one string they need to recognise.
- Escape has no equivalent; tapping the overlay closes (Radix default) and the header button regains
  focus.

---

## 10. Component inventory (web slice only)

**2 new components, 6 modified source files, 2 modified message catalogues, 1 new test file,
2 modified test files, 1 new dependency, 0 new hooks, 0 new lib modules.**

### New (2 components + 1 test)

| File | Layer | Contents | Reuses |
|---|---|---|---|
| `applications/web/src/components/ui/command.tsx` | `ui/` | **Generated**, never hand-edited: `pnpm -C ./applications/web dlx shadcn@latest add command`. Brings `cmdk`. | — |
| `applications/web/src/components/organisms/CommandPalette.tsx` | `organisms/` | Hotkey listener, header trigger button, query + 250 ms debounce, the `useQuery` search (Pattern C), grouping, all seven states, the Ask row, the live region. | `ui/command`, `ui/button`, `AssistantResultCard`, `buildTrainingTypeColorMap`, `SearchApi.searchHitId`, `useRun`, `tr` |
| `applications/web/test/CommandPalette.test.tsx` | test | See below. | — |

```ts
interface CommandPaletteProps {
  teamId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectHit: (hit: AiChatApi.SearchHit) => void;
  onAskAssistant: (question: string) => void;
}
```

**The organism owns no `open` state and imports no router hook.** Both are the layout's, for the
same reason `AssistantConversation` takes its navigation concerns as props: organisms may not use
TanStack Router hooks (`AGENTS.md:26`), and a cmdk `onSelect` cannot be a `<Link>` (§4). Hoisting
`open` also means the header button, the hotkey and any future trigger all raise the same dialog
without a context or a ref.

### Modified (6 source + 2 catalogues + 2 tests)

| File | Change |
|---|---|
| `components/layouts/AuthenticatedLayout.tsx` | Own `const [searchOpen, setSearchOpen] = React.useState(false)`. Mount `<CommandPalette>` inside the header (the dialog portals to `body`; only the trigger renders in place). Existing header `div` at `:132` gains `flex-1 min-w-0`. Add `useNavigate()` plus the five-branch exhaustive `onSelectHit` switch over `ENTITY_ROUTE`, and a one-line `onAskAssistant` (`search: { ask: question }`). |
| `components/molecules/assistant/AssistantResultCard.tsx` | `reference` widens `EntityRef` → `SearchHit`; one optional `renderWrapper` prop; five `renderLink={renderWrapper ?? …}` edits. Default behaviour byte-identical. |
| `routes/(authenticated)/teams/$teamId/assistant.tsx` | `validateSearch` for `ask`; the `pendingQuestion` effect with `.slice(0, 2000)` and `replace: true` strip. `loaderDeps` deliberately **not** extended — `ask` must not re-run the capabilities loader. |
| `components/pages/AssistantPage.tsx` | Pass-through `pendingQuestion?: { text: string; id: number }`. |
| `components/organisms/assistant/AssistantConversation.tsx` | Same prop + the auto-send-once-per-id effect (§6.3). |
| `applications/web/package.json` | `cmdk` (added by the shadcn generator). |
| `packages/i18n/messages/{en,cs}.json` | §11 keys, then `pnpm codegen && pnpm build`. |
| `applications/web/test/AssistantResultCard.test.tsx` | The widened `SearchHit` prop and the `renderWrapper` branch — both are new surface on a shipped component and neither is covered today. Assert: a hit **without** a `ref` field renders every kind identically to an `EntityRef` (the widening is behaviour-free), and `renderWrapper` replaces the `<a>` while the row's inner content is unchanged. |
| `applications/web/test/AssistantConversation.test.tsx` | `pendingQuestion` sends exactly once per id, and a second `{ text, id: 2 }` with the **same text** does send. |

### Explicitly not built

- No `useDebouncedValue` hook — one effect + `setTimeout`.
- No `lib/search/*` module — grouping is one `filter` per kind over `data`.
- No `requestIdRef` stale guard — `queryKey` is the guard (§3.7).
- No client-side cap — the server caps (§5).
- No palette-specific row component (§4).
- No recents store (§3.6).
- No `AssistantResultList` reuse: its 5-row + "show more" behaviour and `<ul>` markup are wrong
  inside a `listbox`. The palette maps `AssistantResultCard` directly.

### `CommandPalette.test.tsx`

Beyond the plan's §F.6 matrix, this surface needs four assertions the contract tests cannot make:

1. **`shouldFilter={false}` holds** — a hit whose rendered text does not contain the query still
   renders (the `value={kind:id}` scoring trap, §3.6).
2. **The Ask row appears at one character**, below the search floor, with no request issued.
3. **The permission case reads as normal** — a result set with no `group` hits renders no "Groups"
   heading, no placeholder, and the announcement is a plain total.
4. **Reopen is clean** — empty input, no stale rows (§3.5), while a re-typed previous term renders
   from cache without a second request.

Setup notes carried from the plan: `Element.prototype.scrollIntoView = vi.fn()` (cmdk calls it,
jsdom does not implement it), a `QueryClientProvider` wrapper, and `vi.useFakeTimers()` with
`vi.advanceTimersByTimeAsync` for the debounce.

---

## 11. Translation keys

**10 new keys.** Recounted against the catalogue, not against the previous draft: `en.json` holds
**2787** keys today, of which **44** are `assistant_*` (an earlier note in this document said 62;
that figure was stale and is corrected). A grep for `"search_` returns **zero** existing keys — the
six near-misses (`assign_fee_dialog_searchPlaceholder`, `assignments_tab_searchPlaceholder`,
`finance_searchPlaceholder`, `members_searchPlaceholder`, `bank_searchPlaceholder`,
`searchable_select_search`) are all per-surface placeholders for other inputs. So all ten below are
genuinely new, and none of the 44 `assistant_*` keys fits a palette string well enough to bend its
meaning.

No computed key names anywhere (the `staticTrKeys.test.ts` rule); the two Ask variants are a plain
ternary over two literal keys, not a template.

| # | Key | en | cs |
|---|---|---|---|
| 1 | `search_title` | Search | Hledat |
| 2 | `search_description` | Search your team's events, members, groups, rosters and training types, or ask the assistant. | Prohledejte události, členy, skupiny, soupisky a typy tréninků svého týmu, nebo se zeptejte asistenta. |
| 3 | `search_placeholder` | Search or ask a question… | Hledejte nebo se zeptejte… |
| 4 | `search_hint` | Type to search events, members, groups, rosters and training types. | Začněte psát a prohledejte události, členy, skupiny, soupisky a typy tréninků. |
| 5 | `search_loading` | Searching… | Hledám… |
| 6 | `search_noResults` | No matches for “{query}” | Nic nenalezeno pro „{query}“ |
| 7 | `search_error` | Search isn't working right now. | Vyhledávání teď nefunguje. |
| 8 | `search_resultCount` | {count} results | Počet výsledků: {count} |
| 9 | `search_askAssistant` | Ask the assistant: “{query}” | Zeptat se asistenta: „{query}“ |
| 10 | `search_askAssistantAbout` | Ask the assistant about “{query}” | Zeptat se asistenta na „{query}“ |

**Count: 10.** (Ten rows, ten distinct keys, none pre-existing.)

Notes on the copy:

- Neither `search_hint` nor `search_description` names a searchable *field* — no "search by name or
  location", no "find a member by jersey number". The server matches titles and display names only
  (§2), and copy that promises more generates bug reports that are actually feature requests.
- `search_title` does double duty: the `sr-only` label on the header trigger **and** the dialog's
  `sr-only` `DialogTitle`. Same word, same meaning, one key.
- `search_loading` is the one key with a live alternative: the catalogue already has
  `loading_text` ("Loading…"). Kept separate because "Searching…" is the specific verb and this is
  the one state a user stares at. Collapse it to `loading_text` for 9 keys if a reviewer prefers —
  nothing else depends on it.
- `search_resultCount` is `sr-only`, so Czech takes the plural-safe "Počet výsledků: {count}" form
  rather than fighting the 1 / 2–4 / 5+ declension — the catalogue has no plural machinery
  (`group_memberCount` is "{count} members" flat).
- Quotation marks are baked into the message strings so Czech gets „…“ and English “…”.
- Czech keeps the app's **vykání** register.

### Reused, not re-minted (6 direct)

| Key | Value (en) | Used for |
|---|---|---|
| `event_events` | Events | group heading (plural) |
| `team_members` | Members | group heading (plural) |
| `team_groups` | Groups | group heading (plural) |
| `team_rosters` | Rosters | group heading (plural) |
| `team_trainingTypes` | Training Types | group heading (plural) |
| `error_offline` | You're offline | offline state |

Plus, for the disabled-assistant landing (§6.4), `assistant_disabled_title` /
`assistant_disabled_body` — already shipped, already correct, not re-minted.

Plus everything `AssistantResultCard` already calls, transitively and for free: `assistant_result_*`
(5, the singular per-row `sr-only` labels), `group_memberCount`, `roster_memberCount`,
`roster_active`, `roster_inactive`, `trainingType_noGroup`, `event_allDayLabel`, and the
`event_status_*` / `event_type_*` families. Reusing the shipped card means **zero** new per-kind
strings — the same argument as §4, arriving a second time from the translation side.
