# Cmd/Ctrl+K command palette with app-wide search

Base: `origin/main` @ `9ea7ce97`. The read-only AI assistant is live in production; nothing here
may change its wire format or behaviour.

**Scope: full.** All five entity kinds plus the assistant hand-off. 3.5–4 days (§G). No cuts.

---

## 0. The one-paragraph summary

A new `GET /teams/:teamId/search?q=` endpoint answers by **calling the five existing AI read-tool
executors** (`applications/server/src/services/ai/readTools.ts`) and returning their entity
payloads. The permission gates are therefore not "shared" — they are *the same function calls*.
The five payload shapes move out of `AiChatApi.EntityRef` into a sibling union `SearchHit`
(= `EntityRef` minus the per-turn `ref` token); `EntityRef` is redefined as `SearchHit`'s field
records plus `ref`, so the chat wire format keeps **the same keys and the same values**. The web
adds `cmdk` + the shadcn `Command` component, mounts one palette from `AuthenticatedLayout`
(trigger in the header), and renders hits with the **shipped `AssistantResultCard`** through a new
`renderWrapper` prop. "Ask the assistant" navigates to `/teams/$teamId/assistant?ask=<question>`;
the assistant route clamps and consumes the param once, strips it with `replace: true`, and hands
the conversation a `{ text, id }` pair so a repeat of the same question still sends.

---

## A. The endpoint

### Shape

```
GET /teams/:teamId/search?q=<string>
```

| Item | Decision |
|------|----------|
| Group | new `HttpApiGroup.make('search')` in `packages/domain/src/api/SearchApi.ts` |
| Endpoint id | `search` → client call is `api.search.search({ params: { teamId }, query: { q } })` |
| Params | `teamId: TeamId` |
| Query | `q: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(100)))` — **required**, not `OptionFromOptional`. Precedent for a required query param: `AchievementApi.ts:121`, `NotificationApi.ts:30`. |
| Middleware | `AuthMiddleware` (same as every team-scoped group) |
| Success | `Schema.Array(SearchHit)` — a bare array, like `GroupApi.listGroups`. No `{ hits, total, truncated }` wrapper until a second field actually exists. |
| Error | `SearchForbidden` (`Schema.TaggedErrorClass`, no fields) `.pipe(HttpApiSchema.status(403))`, mirroring `AiChatApi.AiChatForbidden` |
| Rate limit | none. The endpoint exposes nothing the caller cannot already fetch unlimited from the five list endpoints; `ChatRateLimiter` exists because LLM turns cost money, and search does not. |

**No `limit` query param.** The caps are server constants (`PER_KIND_LIMIT = 5`,
`TOTAL_LIMIT = 25`). A client-tunable limit is a knob nobody asked for. **The client does not
re-slice** — the server's caps are the contract, and a second slice on the client is a second
place to disagree (§C.4).

**The 100-char cap is enforced on both sides, deliberately, and they are the same number.** The
server schema rejects >100 with a 400; the palette input carries `maxLength={100}` so the 101st
keystroke is simply not accepted instead of turning the palette into a generic error line. Two
enforcements of *the same* bound at a trust boundary and a UI affordance is not duplication —
duplication would be two different bounds (which is why the 2-character floor lives only in the
palette, see below).

**No minimum-length rule on the server beyond the schema's `isMinLength(1)`.** The 2-character
threshold lives only in the palette (it decides whether to issue a request at all).

### Handler algorithm (`applications/server/src/api/search.ts`)

```
1. currentUser  <- Auth.CurrentUserContext
2. membership   <- requireMembership(members, teamId, currentUser.id, new SearchApi.SearchForbidden())
3. ctx: EntityReadContext = { teamId, membership, canSeeGroup: makeCanSeeGroup(groups, membership.id) }
4. run the five executors sequentially ({ concurrency: 1 } — see below):
     readTools.listEvents({ query: q }, ctx)          // NOTE: no `includeAllGroups` — see gates
     readTools.listMembers({ query: q }, ctx)
     readTools.listGroups({ query: q }, ctx)
     readTools.listRosters({ query: q }, ctx)
     readTools.listTrainingTypes({ query: q }, ctx)
5. take `.hits` from each result (a gate failure yields `hits: []` — see below)
6. rankAndCap(allHits, q, todayIso)   // signature is (hits, query, todayIso): prefix ranking needs `query`
7. return the flat array
```

**Why this and not a new query layer:** every gate is one line inside the executor
(`hasPermission(ctx.membership, 'member:view')`, …) plus the `canSeeGroup` filter for events. If
search re-derived them, a future change to one copy is a silent data leak. Calling the same
function is the only sharing that cannot drift. The cost is that each call also builds the
model-facing `items` array that search throws away — a few object literals, not a query.

#### `{ concurrency: 1 }` — decided, with its cost stated

Only `listEvents` touches `ctx.canSeeGroup`, whose memo is a plain `Map` with no `Ref`;
`toolTypes.ts` states that this is safe *only* because every call site passes `{ concurrency: 1 }`.
So in principle the other four could run concurrently and the blanket rule costs four avoidable
round trips per keystroke.

**Take the blanket `{ concurrency: 1 }` anyway** (five `Effect.bind`s in one `Effect.Do.pipe`),
for three reasons:

1. Each of the five is one indexed, team-scoped `SELECT` — single-digit milliseconds. The saving
   is a few ms; the palette already waits 250 ms for the debounce.
2. Concurrent effects each check a connection out of the shared `PgClient` pool. Five concurrent
   reads per keystroke, per user, against the pool every other request also uses, is a worse
   tail-latency trade than four serial round trips.
3. The safe-vs-unsafe split is *which executor you happen to be in*. A blanket rule survives
   someone reordering the binds; a selective one turns a reorder into a silent data race in a
   memo that gates visibility.

```ts
// ponytail: five serial round trips per keystroke, because only `listEvents` is
// concurrency-unsafe and a blanket rule survives reordering. If p95 search latency shows it,
// split into `listEvents` (serial) + `Effect.all([the other four], { concurrency: 4 })`.
```

### Permission gates — what a caller without one sees

| Kind | Gate on the path search uses | Enforced in | Caller without it |
|------|------------------------------|-------------|-------------------|
| event | team membership + `ctx.canSeeGroup(member_group_id)` for **every** caller | `readTools.listEvents` → `listAllEvents` (`readTools.ts:161-178`), mirroring `api/event.ts:173-181` | events in groups they are not in are **absent from the array**; other events still returned |
| trainingType | membership only | `readTools.listTrainingTypes` | n/a |
| group | `group:manage` | `readTools.listGroups` | zero `kind: 'group'` hits, **HTTP 200** |
| member | `member:view` | `readTools.listMembers` | zero `kind: 'member'` hits, **HTTP 200** |
| roster | `roster:view` | `readTools.listRosters` | zero `kind: 'roster'` hits, **HTTP 200** |

#### The event gate: admins are filtered too, and that is the decision

`listEvents` has two paths. The **single-id** path (`readTools.ts:150`) short-circuits
`canSeeGroup` for `team:manage`, mirroring `getEvent` (`api/event.ts:348-356`). Search never takes
that path. The **list** path is `readTools.ts:161-178`:

```ts
const wantsAll = args.includeAllGroups ?? false;
const canViewAll = hasPermission(ctx.membership, 'team:manage');
return wantsAll && canViewAll ? Effect.succeed(list) : Effect.filter(list, …canSeeGroup…);
```

Search passes `{ query: q }` only, so `wantsAll === false` and **a `team:manage` caller is
group-filtered exactly like everyone else.** This matches the HTTP list endpoint
(`api/event.ts:173-181`), where an admin also needs an explicit `?all=1` to see other groups'
events.

**Decision: search does not pass `includeAllGroups`.** Admins get the same group-filtered set the
events page gives by default. Search is deliberately **narrower than `/events?all=1`**, and that
is the conservative direction.

> **Do not "fix" this later by passing `includeAllGroups: true`.** It would hand every
> `team:manage` caller a cross-group event list from a surface that has no opt-in, when the UI
> only ever produces that list on an explicit `?all=1`. If cross-group search for admins is ever
> wanted, it needs its own query param on `/search` and its own test pair — not a default flip.

**A missing per-kind gate is never a 403 for the whole query.** `forbiddenResult(permission)`
already returns empty hits (`toolTypes.ts:133-136`), so the handler needs no branch at all: it
concatenates and the kind simply is not there. The only 403 is `requireMembership` failing — a
non-member of the team, which includes every cross-team probe.

This is also why the palette must not render "you don't have permission to search members" — the
response carries no signal that a kind was gated, deliberately (same reasoning as
`notFoundResult`: never confirm the existence of what the caller may not see).

### Ranking and limits

```ts
// applications/server/src/api/search.ts — exported for the unit test
export const rankAndCap = (
  hits: ReadonlyArray<AiChatApi.SearchHit>,
  query: string,        // prefix ranking needs it
  todayIso: string,     // injected, never read from a clock inside
): ReadonlyArray<AiChatApi.SearchHit>
```

1. **Kind order** in the output array: `event`, `member`, `group`, `roster`, `trainingType`. The UI
   groups by `kind` in encounter order, so ordering is part of the contract.
2. **Within `event`:** upcoming/today first, ascending by date; then past, descending.
   The date is `hit.event.startDate`, which is **always `Some`**: `readTools.ts` imports
   `toEventInfo` from `~/api/event.js`, and `api/event.ts:50` sets
   `startDate: Option.some(e.start_date)` unconditionally. Use
   `Option.getOrElse(hit.event.startDate, () => DateTime.formatIsoDateUtc(hit.event.startAt))` as a
   total function, but **do not write a test for the `None` branch** — it is unreachable.
   **`start_date` is team-local wall clock; `todayIso` is UTC.** Between 00:00 and ~02:00
   team-local, a UTC `todayIso` can still be *yesterday*, which would bucket today's training as
   past and sink it to the bottom — exactly what this rule exists to prevent. Fix with a one-line
   grace band:
   ```ts
   // ponytail: `start_date` is team-local, `todayIso` is UTC, so a one-day grace band replaces a
   // per-keystroke TeamSettingsRepository lookup. Upgrade: pass the team timezone if ordering
   // around midnight ever matters more than a query does.
   const upcomingFrom = addDaysIso(todayIso, -1);
   const isUpcoming = (d: string) => d >= upcomingFrom;
   ```
   The worst case is that yesterday's event sorts one bucket high for a couple of hours. The
   unacceptable case — today's event sorting *low* — is gone.
   Without the rule at all the palette would show the **oldest** matching events first:
   `EventsRepository.findEventsByTeamId` orders by `eventDayOrder` = team-local date **ASC** over
   the team's entire history.
3. **Within every other kind:** prefix matches (`label.toLowerCase().startsWith(query.toLowerCase())`)
   first, everything else after, stable within each bucket (repo order is already `name ASC` for
   groups/training types, `created_at DESC` for rosters).
4. **Cap 5 per kind**, applied after ranking, then **25 total** (which the per-kind cap already
   implies with five kinds; the total is a belt for when a sixth kind is added).

**Do not pass `limit` to the executors.** `applyLimit` (`readTools.ts:60`) slices *in memory* after
the repository has already returned every row, so a limit arg saves nothing at the database and
would truncate the oldest-first event list before ranking could see it. Cap-after-rank is the only
correct order.

`label` comes from `SearchApi.searchHitLabel(hit)` (§B) — the same function the web renders.

### Known ceiling

Each debounced keystroke runs five unbounded team-wide `SELECT`s plus in-memory substring
filtering. That is exactly what one assistant turn already costs, so it is not a new class of load,
but it is per-keystroke now. Mark it in the handler:

```ts
// ponytail: five unbounded team-wide SELECTs + in-memory substring match per keystroke, reusing
// the AI read tools so the permission gates cannot drift. Move to per-kind SQL `ILIKE … LIMIT`
// (or a pg_trgm index) if p95 search latency or DB load becomes visible.
```

### What the server actually matches on

`matchesQuery` is `haystack.toLowerCase().includes(query.toLowerCase())` (`readTools.ts:46-47`) —
no SQL, no regex, so no `q` can return a foreign row. The haystack is:

| Kind | Matched field | **Not** matched |
|------|---------------|-----------------|
| event | `title` only (`readTools.ts:120`) | location, description, training type name |
| member | display name only (`readTools.ts:351`, via `displayNameOf`) | jersey number, email, role names |
| group / roster / trainingType | `name` | — |

**No UI copy may imply otherwise.** `search_hint` and `search_description` list the *kinds* that
are searchable, never the fields. If "search by jersey number" is ever wanted it is a server
change, not a copy change.

---

## B. The domain contract

### The `ref` question — resolved

`AiChatApi.EntityRef.ref` is a per-turn `RefToken`. For search it is meaningless. It is also, today,
**already meaningless inside the executors**: `toolTypes.ts#buildListResult` stamps a fixed
placeholder `'----'` and `ChatAgent.remapCallReferences` (`ChatAgent.ts:364-383`) overwrites every
one with `{ ...entityRef, ref: token }` before anything reaches the model or the client.

So the fix is a deletion, not an addition:

1. In `AiChatApi.ts`, hoist the five variants' fields into plain `const` field records.
2. `SearchHit` = `Schema.Union` of `Schema.Struct(<record>)`. **No `ref` field, at all** — a hit's
   identity is `"<kind>:<id>"` (`searchHitId`), which is what the palette uses for React keys and
   the cmdk `value`.
3. `EntityRef` = `Schema.Union` of `Schema.Struct({ ...<record>, ref: RefToken })`.
4. Executors emit `SearchHit`; `ChatAgent` keeps doing `{ ...hit, ref: token }`, which now
   *constructs* the `EntityRef` instead of overwriting a placeholder. `PENDING_REF` is deleted.

```ts
// packages/domain/src/api/AiChatApi.ts
const eventFields = { kind: Schema.Literal('event'), event: EventApi.EventInfo } as const;
const memberFields = {
  kind: Schema.Literal('member'),
  memberId: TeamMemberId,
  displayName: Schema.String,
  avatarUrl: Schema.OptionFromNullOr(Schema.String),
  jerseyNumber: Schema.OptionFromNullOr(Schema.Number),
  roleNames: Schema.Array(Schema.String),
  effectiveRoles: Schema.Array(Roster.EffectiveRole),
  active: Schema.Boolean,
} as const;
const groupFields = { kind: Schema.Literal('group'), group: GroupApi.GroupInfo } as const;
const rosterFields = { kind: Schema.Literal('roster'), roster: Roster.RosterInfo } as const;
const trainingTypeFields = {
  kind: Schema.Literal('trainingType'),
  trainingType: TrainingTypeApi.TrainingTypeInfo,
} as const;

/** Every variant of `EntityRef` minus the per-turn `ref` token. What search returns, and what a
 * read tool emits before `ChatAgent` mints the turn's token. Identity is `searchHitId(hit)`. */
export const SearchHit = Schema.Union([
  Schema.Struct(eventFields),
  Schema.Struct(memberFields),
  Schema.Struct(groupFields),
  Schema.Struct(rosterFields),
  Schema.Struct(trainingTypeFields),
]);
export type SearchHit = typeof SearchHit.Type;

export const EntityRef = Schema.Union([
  Schema.Struct({ ...eventFields, ref: RefToken }),
  Schema.Struct({ ...memberFields, ref: RefToken }),
  Schema.Struct({ ...groupFields, ref: RefToken }),
  Schema.Struct({ ...rosterFields, ref: RefToken }),
  Schema.Struct({ ...trainingTypeFields, ref: RefToken }),
]);
```

Plain object spread of field records — no schema-combinator API needed, works in
`effect@4.0.0-beta.40` as-is.

#### "Same keys and values" — **not** byte-identical, and the difference matters for the test

Spreading the field record first puts `ref` **last**. The encoded event variant goes from
`{ kind, ref, event }` to `{ kind, event, ref }`: same keys, same values, `toEqual` equal,
`JSON.stringify` **unequal**.

That is fine on the wire (JSON object key order is not semantic, and the client decodes by schema),
but it dictates how the guard test is written:

- **Pin the encoded shape with `expect(encoded).toEqual({ … })`.**
- **Never a snapshot, never `JSON.stringify` comparison, never `Object.keys(...)` order.** Any of
  those goes red on a change that is provably harmless, and the next person deletes the guard
  instead of reading it.

Rejected alternatives, briefly: making `ref` optional on `EntityRef` (weakens the chat contract and
`parseAnswer`'s token map for a field chat always has); a duplicate `SearchHit` union spelled out
twice (two things to keep in step); returning `EntityRef` with the `'----'` placeholder (ships a
fake token to the browser).

**Where it lives:** `SearchHit` stays in `AiChatApi.ts` and `SearchApi.ts` re-exports it —
the documented convention (`packages/domain/AGENTS.md` → "Shared Schemas Across API Contracts",
precedent `HexColor`: defined in `GroupApi.ts`, re-exported from `Roster.ts`). Add the row to that
table.

### `SearchApi.ts`

```ts
export { SearchHit } from '~/api/AiChatApi.js';

/** The one label per hit — used by the server for prefix ranking and by the palette where a
 * plain string is needed (cmdk `value` fallback, the live-region text), so the two can never
 * disagree about what "matches" means. Pure, no i18n. */
export const searchHitLabel = (hit: AiChatApi.SearchHit): string => { switch … };

/** Stable identity for a hit: `"<kind>:<id>"`. The palette's React key and cmdk item `value`.
 * `SearchHit` has no `ref`; this is the only identity there is. */
export const searchHitId = (hit: AiChatApi.SearchHit): string => { switch … };

export class SearchForbidden extends Schema.TaggedErrorClass<SearchForbidden>()('SearchForbidden', {}) {}

export class SearchApiGroup extends HttpApiGroup.make('search').add(
  HttpApiEndpoint.get('search', '/teams/:teamId/search', {
    success: Schema.Array(SearchHit),
    error: SearchForbidden.pipe(HttpApiSchema.status(403)),
    params: { teamId: TeamId },
    query: { q: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(100))) },
  }).middleware(AuthMiddleware),
) {}
```

Two tiny switches co-located with the schema, `isPublicHttpsUrl`-in-`EventApi.ts` style. Optional
follow-up: `refTokens.entityKeyOf` becomes a one-line delegate to `searchHitId` (same string, one
switch). Not required; do it only if touching that file anyway.

### The `Schema.Class` nominal-membership trap

`EventInfo`, `GroupInfo`, `RosterInfo`, `TrainingTypeInfo` and `EffectiveRole` are all
`Schema.Class`es. Membership is **nominal**: a plain object matching field-for-field fails to
encode with `Expected EventInfo`, and for a request payload that failure happens before any HTTP
request is made — which is exactly how the assistant shipped unable to send a message
(`applications/web/src/lib/assistant/chatMessages.ts` and its test document the incident).

Where it can bite this feature:

1. **The client constructs nothing for search.** The palette sends a query string; it only
   *decodes* `SearchHit`. The encode trap does not apply on the request path.
2. **The one client-constructed schema value on this feature's path is `AiChatApi.ChatMessage`,
   on the assistant hand-off — and it is a *validating* constructor, not just a nominal one.**
   `new AiChatApi.ChatMessage({ content })` **throws synchronously** on `content.length > 2000`
   (`Expected a value with a length of at most 2000`) and on an empty string. See §D for why that
   is a blocker on the auto-send path and how it is clamped.
3. **Server-side mocks in the new test files must build real instances** —
   `new EventApi.EventInfo({ … })`, not a camelCase literal (`applications/server/AGENTS.md` →
   mock rule 5). A literal typechecks and then fails the response encode at runtime.
4. **The domain test pins the trap directly** (§F.1).

---

## C. Web wiring

### The dependency

```bash
pnpm -C ./applications/web dlx shadcn@latest add command
```

This writes `src/components/ui/command.tsx` and adds `cmdk` to `dependencies`. Notes:

- **It may offer to overwrite `src/components/ui/dialog.tsx`** (the `Command` component imports
  `Dialog`). **Decline** — the existing dialog is in use everywhere and declining is safe; the
  generated `CommandDialog` only imports from it.
- `cmdk@^1.1.x` depends on `@radix-ui/react-dialog` / `react-id` / `react-primitive`. This repo
  uses the unified `radix-ui@1.6.7` package, so a second copy of those primitives lands in the
  lockfile. Acceptable (tiny, version-compatible), but name it in the PR body.
- `src/components/ui/*` is excluded from biome lint/format and must never be hand-edited.
- **Run `pnpm install` before `pnpm format`/`pnpm lint`** (root `AGENTS.md`: stale `node_modules`
  runs the old biome and silently reformats unrelated files).

### Ownership: the layout owns `open`, the palette owns the query

`AuthenticatedLayout` is rendered **only** by `src/routes/(authenticated)/teams/$teamId/route.tsx`,
i.e. exactly the authenticated, team-scoped routes — the palette's scope — and it already has
`activeTeam`.

| Concern | Owner | Why |
|---|---|---|
| `open` state | `AuthenticatedLayoutContent` | Any number of triggers can raise it; the header button is one, the hotkey is another. |
| Header trigger button | `AuthenticatedLayoutContent` (in the header markup) | It renders in place; the dialog portals to `body`. |
| Hotkey listener | `CommandPalette` (props `open` / `onOpenChange`) | One listener, one component, mounted once. |
| Query, debounce, fetch, rendering, states | `CommandPalette` | Organism responsibilities. |
| `useNavigate` + the per-kind switch | `AuthenticatedLayoutContent` | **Organisms must not use TanStack Router hooks** (`applications/web/AGENTS.md:26`); the six existing violators are documented debt, not licence. The layout already owns a 60-line route switch (`useBreadcrumbs`). |

```tsx
interface CommandPaletteProps {
  teamId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectHit: (hit: AiChatApi.SearchHit) => void;   // parent navigates
  onAskAssistant: (question: string) => void;        // parent navigates
}
```

### The trigger: a header ghost `Button`, not a sidebar item

The sidebar is behind a `Sheet` on mobile — a `SidebarMenuButton` would be two taps away on
exactly the device that has no `Cmd+K`. The trigger goes in the header, present at every width
(it is also how the shortcut gets discovered):

```tsx
<Button variant='ghost' size='sm' className='ml-auto mr-2' onClick={() => setSearchOpen(true)}>
  <Search className='size-4' aria-hidden='true' />
  <span className='sr-only'>{tr('search_title')}</span>
  <kbd className='hidden rounded border bg-muted px-1.5 text-[10px] text-muted-foreground sm:inline'>
    {isMac ? '⌘K' : 'Ctrl K'}
  </kbd>
</Button>
```

- Goes inside the existing `<header>` (`AuthenticatedLayout.tsx:131`), after the breadcrumb `div`.
  That `div` (`:132`) gains `flex-1 min-w-0` so breadcrumbs truncate instead of shoving the button
  off-screen.
- `isMac = navigator.userAgent.includes('Mac')`, computed once. The `kbd` hides below `sm` — on a
  phone it is a lie.
- No FAB. The shipped assistant design already rejected a floating launcher for this shell.

### The hotkey listener (inside `CommandPalette`)

```tsx
React.useEffect(() => {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    if (event.isComposing) return;                                       // IME owns the keystroke
    if (!open && document.body.hasAttribute('data-scroll-locked')) return; // another modal owns the screen
    event.preventDefault();
    onOpenChange(!open);
  };
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [open, onOpenChange]);
```

- `'k'` does not collide with the sidebar's `'b'` (`src/components/ui/sidebar.tsx:33,95-110`, the
  idiom this copies).
- **The `data-scroll-locked` guard is required, not optional.** `react-remove-scroll` sets it on
  `<body>` for every Radix overlay in this app; without the guard, `Cmd+K` opens the palette on top
  of a confirmation `AlertDialog` or the mobile nav `Sheet`.
  *Ceiling:* an attribute sniff, not an overlay registry. Correct for every Radix overlay today;
  a future non-Radix overlay would let the palette open over it, recoverable with Escape.
- It fires while an input is focused, deliberately: `Cmd/Ctrl+K` is a modifier chord no text
  control consumes, and `Cmd+B` already behaves this way.
- Toggle, not open-only.
- Escape / overlay close is `CommandDialog`'s own (Radix `Dialog`) behaviour — **do not add a
  second handler**, and no `onCloseAutoFocus` override.

### Internals of `CommandPalette`

1. **State and reset-on-open.** The dialog is always mounted (`applications/web/AGENTS.md:1008`),
   so reset is an effect — and it must reset **both** pieces of state:
   ```tsx
   const [query, setQuery] = React.useState('');
   const [debounced, setDebounced] = React.useState('');
   React.useEffect(() => {
     if (!open) return;
     setQuery('');
     setDebounced('');   // ← without this, reopening re-runs the previous search
   }, [open]);
   ```
   **Resetting only `query` is a bug, not a nit:** for the 250 ms before the debounce timer fires,
   `debounced` still holds the old term and `enabled` is still true, so React Query serves the
   previous result set from cache *instantly* on reopen. Reset both. (Equivalent and also
   acceptable: gate `enabled` on `debounced === query.trim()`. Do one, not neither.)
2. **Debounce, inline** — no new hook, no new dependency:
   ```tsx
   React.useEffect(() => {
     const t = setTimeout(() => setDebounced(query.trim()), 250);
     return () => clearTimeout(t);
   }, [query]);
   ```
3. **Fetch with Pattern C** (`applications/web/AGENTS.md` → "Per-Row Lazy Fetch With `useQuery` +
   `useRun`") — on-demand data, not a loader payload:
   ```tsx
   const { data, isFetching, isError } = useQuery<ReadonlyArray<AiChatApi.SearchHit>>({
     queryKey: ['search', teamId, debounced],
     enabled: open && debounced.length >= 2,
     queryFn: async () => { …ApiClient.asEffect() → api.search.search({ params: { teamId: teamIdBranded }, query: { q: debounced } })… },
     retry: false,
     throwOnError: false,
     placeholderData: (prev) => prev,   // no flash of "no results" between keystrokes
   });
   ```
   `Schema.decodeSync(Team.TeamId)(teamId)` at the top of the component, not inside `queryFn`
   (Pattern C rule 6). The effect fails with `SilentClientError` so `useRun`'s automatic toast
   stays off — the error line inside the palette is the single report.
   React Query's per-term cache makes a backspace to a previous term instant, which is also why
   the reset in (1) matters.
   **No stale-response guard is needed** — React Query keys by `debounced`, so a late response for
   an old term cannot overwrite a newer one. (The design's `requestIdRef` solves a problem
   `useQuery` already solves.)
4. **No client-side slicing or re-grouping by count.** The server caps at 5/kind and 25 total. The
   client groups by `kind` in the order the array arrives and renders everything it is given.
5. **`<Command shouldFilter={false}>` — required, and the reason is not what it looks like.**
   Both documents give every item an explicit `value={searchHitId(hit)}` (i.e. `"member:uuid"`),
   because cmdk deduplicates items by `value` and two members can share a display name. cmdk's
   default filter scores **that `value` string**, not the rendered text — so left at the default it
   would drop essentially every row, whatever the query. (Secondarily, re-filtering server results
   client-side would be wrong anyway.)
6. **`maxLength={100}` on `CommandInput`** — the same bound the server enforces (§A). Without it
   the 101st character turns the palette into a generic error line.

### The seven render states — all plain `<div>`s except results and the Ask row

> **`CommandEmpty` cannot be used here.** With `shouldFilter={false}` cmdk's filtered count equals
> the total item count, so `CommandEmpty` renders only at literally **zero** `CommandItem`s — and
> the Ask row is an item whenever the query is non-empty. Every non-actionable state is therefore
> a plain `<div>` inside `CommandList`, which is also the correct semantics: a non-actionable row
> must never be arrow-selectable.

| State | When | What renders |
|---|---|---|
| **Idle** | `query.trim().length < 2` | `<div>` with `search_hint`. **No Ask row** (there is no question yet). |
| **Offline** | `navigator.onLine === false` | `<div>` with the existing `error_offline`. No request attempted, and the **Ask row is hidden** — the assistant needs the network too. |
| **Loading** | in flight, no prior rows | `<div>`: `Loader2 animate-spin` + `search_loading`, centred, `py-6` |
| **Loading over results** | in flight, previous rows on screen | Rows stay put; the input's leading `Search` icon swaps to `Loader2 animate-spin`. No skeletons. |
| **Results** | ≥1 hit | §"Rows" below, plus the Ask row last |
| **No matches** | settled, 0 hits | `<div>` with `search_noResults` ("No matches for “{query}”"), **plus the Ask row**, which is then the only item and therefore auto-highlighted: Enter asks the assistant. |
| **Error** | request failed | `<div>` with `search_error` in `text-destructive`, plus the Ask row. **No retry button** — editing the query retries automatically. |

Nothing before typing: no recents, no suggestions.

### Rows: reuse `AssistantResultCard`, widened to `SearchHit`

**Do not write a second row component.** `AssistantResultRow` is `h-12` (48px) — above the 44px
touch floor, which is what a palette row needs on a phone at the side of a pitch. A "denser
palette row" would look the same and duplicate five per-kind anatomies (`Option` handling, colour
bars, role-badge limits, status badges).

The seam already exists: `AssistantResultRow` takes a `renderLink(children, className)` render
prop. `AssistantResultCard` builds a `<Link>` per kind and passes it in. The palette needs a
`CommandItem` instead (`role='option'` may not contain an anchor, and cmdk's Enter fires
`onSelect`, not a click).

**Two changes to `AssistantResultCard`, both small:**

```ts
interface AssistantResultCardProps {
  reference: AiChatApi.SearchHit;   // ← WIDENED from AiChatApi.EntityRef
  teamId: string;
  colorMap: TrainingTypeColorMap;
  /** Overrides the default per-kind `<Link>` wrapper. The command palette passes a `CommandItem`. */
  renderWrapper?: (children: React.ReactNode, className: string) => React.ReactElement;
}
```

- **Widening the prop is what makes the reuse typecheck.** A `SearchHit` is *not* assignable to
  `EntityRef` (it lacks `ref`), so the design's "pass a hit to the card" only works after this
  change. The card **never reads `.ref`** — verified across all five branches — and `EntityRef`
  *is* assignable to `SearchHit`, so **the chat call site is untouched and cannot regress.**
- Each of the five branches becomes
  `renderLink={renderWrapper ?? ((children, className) => <Link to={ENTITY_ROUTE.x} params={…}>…)}`.
  The default path is unchanged.
- `AssistantResultRow` is **not touched at all.**

The palette's wrapper:

```tsx
renderWrapper={(children, className) => (
  <CommandItem
    value={searchHitId(hit)}
    onSelect={() => { onOpenChange(false); onSelectHit(hit); }}
    className={cn(className, 'border-transparent cursor-default',
                  'data-[selected=true]:bg-accent data-[selected=true]:border-accent-foreground/20')}
  >
    {children}
  </CommandItem>
)}
```

`border-transparent` over the row's `border`: tailwind-merge keeps both (different properties), so
the 1px box stays for layout and forced-colors mode while the visible card outline disappears.

**`colorMap`:** the card needs a `TrainingTypeColorMap`. Build it exactly the way
`AssistantConversation.tsx:409-421` does — collect `hit.event.trainingTypeName` from the `event`
hits and feed `buildTrainingTypeColorMap(names)`, memoised on the hit array.

**The one thing lost** by not being an anchor: ⌘-click to open in a new tab. Accepted —
`role='option'` forbids the nested link that would restore it.

### Grouping, headings, keyboard

One `CommandGroup` per kind present, in the order the server returned, headings from keys that
already exist — **plural forms, not `entityKindLabels`' singular `assistant_result_*` keys**
(those read as "Event", "Member" — wrong for a group heading):

| # | Group | Existing key |
|---|---|---|
| 1 | Events | `event_events` |
| 2 | Members | `team_members` |
| 3 | Groups | `team_groups` |
| 4 | Rosters | `team_rosters` |
| 5 | Training types | `team_trainingTypes` |

`entityKindLabels` is still used for each row's `sr-only` kind label — that is what its singular
forms are for.

**A group with no hits is not rendered.** No empty headings, ever: to the user, "gated" and "no
matches" are indistinguishable, and that is deliberate (§A gates).

`CommandList` is `max-h-[400px] overflow-y-auto` on desktop, `max-h-[50dvh]` below `md`.
↑/↓ cross group boundaries and wrap (cmdk); Enter activates via `onSelect`; Escape closes (Radix);
Tab stays inside the focus trap and does **not** move the highlight. The first row is
auto-highlighted (cmdk default).

### The "Ask the assistant" row

- **Last block**, after a `CommandSeparator`, in a heading-less `CommandGroup` with one item.
  Last, not first, so blind `Cmd+K → type → Enter` opens the top hit rather than firing a slow,
  rate-limited LLM turn. With no matches it is last *and* first, which is exactly when it should
  be the default.
- **Rendered once `query.trim().length > 0`** — including while loading, on error, and on zero
  results. Hidden when idle and when offline.
- **Two strings, chosen by a locale-independent heuristic:**
  ```ts
  const q = query.trim();
  const looksLikeQuestion = q.endsWith('?') || q.split(/\s+/).length >= 4;
  ```
  | Shape | Key | en |
  |---|---|---|
  | Question (`?` or ≥4 words) | `search_askAssistant` | Ask the assistant: “{query}” |
  | Name-like (1–3 words, no `?`) | `search_askAssistantAbout` | Ask the assistant about “{query}” |

  "Ask the assistant: “Novák”" reads like a broken sentence. One ternary over two **literal** keys
  (never a computed key — `staticTrKeys.test.ts` sweeps literals).
  *Ceiling:* word count plus `?`. No interrogative word lists — per-locale data that rots, and
  Czech questions often start with the verb. Worst case is a slightly stiff label.
- Icon: `Sparkles`.
- `onSelect` → `onOpenChange(false); onAskAssistant(q)`.
- **Not gated on `aiChat.getCapabilities`** — that is a request per palette open for a server-wide
  env flag. The sidebar's Assistant nav item is unconditional for the same reason, and the
  assistant page's disabled state is already written.
- **It wraps on mobile:** `whitespace-normal text-left`, so a long quoted query becomes two lines
  rather than truncating the user's own words.

### Accessibility

Given by cmdk + Radix, do not re-implement: `role='combobox'` + `aria-expanded`/`aria-controls`/
`aria-activedescendant` on the input; `role='listbox'` + `role='option'` + `aria-selected`;
`role='group'` + `aria-labelledby` per group; `role='dialog' aria-modal`, focus trap, Escape,
scroll lock, focus restore.

What we add:

1. **`DialogTitle` + `DialogDescription`, both `sr-only`.** Radix logs an accessibility error
   without a title; shadcn's `CommandDialog` takes `title` / `description` props for exactly this.
   `search_title` and `search_description`. **These two strings are a11y-required, not decoration
   — they are two of the ten i18n keys (§E).**
2. **The `sr-only` kind label on every row** — kept (the shipped card already renders it).
3. **Exactly one live region, as a *sibling* of `CommandList`, never inside it:**
   ```tsx
   <div aria-live='polite' aria-atomic='true' className='sr-only'>{announcement}</div>
   ```
   - Permanently mounted inside the dialog content. Most SR/browser pairs only announce mutations
     in a region that already existed.
   - **Never inside `CommandList`:** a live region inside `role='listbox'` fights
     `aria-activedescendant`, which already announces every highlight change — the user would hear
     the row *and* the count on every arrow press.
   - `aria-live` + `aria-atomic`, **not `role='status'`** — identical announcement, and a second
     `status` element is how `getByRole('status')` became ambiguous and broke two E2E specs
     (`e94d8425`, `FioBankCard.tsx`).
   - One string at a time: `search_resultCount` on a settled result set, or the no-matches / error
     / offline copy. Fed from the same debounced settle as the list, so it cannot chatter.
4. Nothing interactive inside a row. Selection is carried by `aria-selected` /
   `aria-activedescendant`, never colour alone.

### Mobile (< 768px, the `useIsMobile()` breakpoint)

- Entry is the header button. No chord, no FAB.
- **It stays a `Dialog`, not a `Sheet`** — a bottom sheet is covered by the soft keyboard the
  instant the input autofocuses, and its animation fights the mobile nav `Sheet`.
- Positioning at the call site: **`top-4 translate-y-0 max-h-[85dvh]`** so the dialog pins near the
  top with the keyboard open; `dvh` so the collapsing URL bar does not clip it.
- `CommandList` is `max-h-[50dvh]` below `md` — roughly 5–6 rows, one full group.
- Autofocus is kept. The user tapped a search button; the keyboard appearing is the point.
- Rows need no mobile variant (`h-12` ≥ 44px; the card's own `useIsMobile()` already drops the
  role-badge limit to 1).

### Navigation per result kind (in `AuthenticatedLayoutContent`)

```tsx
const navigate = useNavigate();
const onSelectHit = (hit: AiChatApi.SearchHit) => {
  switch (hit.kind) {
    case 'event':  return void navigate({ to: ENTITY_ROUTE.event,  params: { teamId, eventId: hit.event.eventId } });
    case 'member': return void navigate({ to: ENTITY_ROUTE.member, params: { teamId, memberId: hit.memberId } });
    case 'group':  return void navigate({ to: ENTITY_ROUTE.group,  params: { teamId, groupId: hit.group.groupId } });
    case 'roster': return void navigate({ to: ENTITY_ROUTE.roster, params: { teamId, rosterId: hit.roster.rosterId } });
    case 'trainingType':
      return void navigate({ to: ENTITY_ROUTE.trainingType, params: { teamId, trainingTypeId: hit.trainingType.trainingTypeId } });
  }
};
const onAskAssistant = (question: string) =>
  void navigate({ to: '/teams/$teamId/assistant', params: { teamId }, search: { ask: question } });
```

`ENTITY_ROUTE` (`src/lib/assistant/entityRoutes.ts`) is `as const satisfies Record<kind, string>`
precisely so these stay typed — reuse it, do not inline route strings.

### Out of scope

Non-entity **commands** ("go to Settings", "create event", theme toggle). This is a search palette.
If it is ever wanted, `getTeamNavGroups` in `AppSidebar.tsx` is already the permission-filtered
list of destinations and slots in as one more `CommandGroup`.

---

## D. The assistant hand-off

**URL:** `/teams/$teamId/assistant?ask=<url-encoded question>`. **After consumption:**
`/teams/$teamId/assistant` — the param is stripped with `replace: true`, so the history entry never
contains it, refresh does not resend, and Back goes to wherever the palette was opened from.

### The 2000-character clamp is a blocker fix, not a nicety

`new AiChatApi.ChatMessage({ … })` is a **validating** constructor: >2000 chars throws
`Expected a value with a length of at most 2000`; an empty string throws too.
`AssistantComposer.tsx:31,117` enforces `maxLength={2000}` on the textarea, and **the auto-send is
the first path in the app that bypasses the composer.**

Trace of an unclamped `?ask=` with 3000 characters:

1. `handleSend` pushes the optimistic user bubble (`AssistantConversation.tsx:260`).
2. → `runExchange` → `toChatMessages(built.messages)` at `:191` **throws**.
3. That is **before** `setSubmitting(true)` at `:193` and **outside** the `try` at `:246`.
4. The promise rejects into `void handleSend(...)`: **no error turn, no toast, no request, no
   server log.** The user's bubble sits there forever and the page is dead until reload.

**Fix: clamp at the trust boundary, in the route effect.**

```ts
const text = ask?.trim().slice(0, 2000);
if (text === undefined || text.length === 0) return;
```

> **Do not put `Schema.check(isMaxLength(2000))` in `validateSearch`.** A `validateSearch` failure
> rejects into the **route error boundary** — the whole assistant page becomes an error screen
> instead of answering a slightly truncated question. `validateSearch` keeps plain
> `Schema.optional(Schema.String)`; the clamp is `.slice`.

Truncating at 2000 is the right behaviour: the palette caps input at 100 characters, so the only
way to get here is a hand-crafted or shared URL, and a truncated answer beats a dead page.

### `src/routes/(authenticated)/teams/$teamId/assistant.tsx`

```tsx
const AssistantSearchSchema = Schema.Struct({ ask: Schema.optional(Schema.String) });
// `Schema.optional` is the local convention for validateSearch (events.index.tsx:8) —
// TanStack owns this shape, not the wire. No length check here: see the clamp note above.

export const Route = createFileRoute('/(authenticated)/teams/$teamId/assistant')({
  ssr: false,
  validateSearch: Schema.toStandardSchemaV1(AssistantSearchSchema),
  // loaderDeps deliberately NOT extended — `ask` must not re-run the capabilities loader.
  component: AssistantRoute,
  loader: /* unchanged */,
});

function AssistantRoute() {
  const { teamId } = Route.useParams();
  const { enabled } = Route.useLoaderData();
  const { ask } = Route.useSearch();
  const navigate = useNavigate();

  const [pending, setPending] = React.useState<{ text: string; id: number } | undefined>();
  const idRef = React.useRef(0);

  React.useEffect(() => {
    const text = ask?.trim().slice(0, 2000);          // ← the clamp
    if (text === undefined || text.length === 0) return;
    idRef.current += 1;
    setPending({ text, id: idRef.current });
    void navigate({ search: {}, replace: true });     // ← exact form: no `to`
  }, [ask, navigate]);

  return <AssistantPage teamId={teamId} enabled={enabled} pendingQuestion={pending} />;
}
```

**Pin the strip form: `navigate({ search: {}, replace: true })`, with no `to` and no `params`.**
There is no `replace: true` precedent anywhere in `applications/web/src`, so there is nothing to
copy from and every variant "looks fine". Omitting `to` keeps the navigation on the current route
(so no params are needed); `search: {}` clears every param; `replace: true` is what keeps `?ask=`
out of history. If this ends up spelled differently, verify by hand that Back does not return to
the `?ask=` URL.

The `{ text, id }` pair, not a bare string, is what makes "ask the same question twice from the
palette" work: a value-only guard would swallow the second one.

### `AssistantPage`

Pure pass-through: `pendingQuestion?: { text: string; id: number }` → `AssistantConversation`.

**When `enabled === false` the question is silently discarded.** The route still strips `?ask=`,
and the page renders the disabled state (`assistant_disabled_title/_body`) instead of the
conversation, so nothing consumes the prop. That is acceptable — the user lands on a page that
explains why — but it is a real behaviour and it is stated here rather than discovered.

### `AssistantConversation` — auto-send exactly once

```tsx
const sentIdRef = React.useRef(0);
React.useEffect(() => {
  if (pendingQuestion === undefined || sentIdRef.current >= pendingQuestion.id) return;
  sentIdRef.current = pendingQuestion.id;   // set BEFORE the async call
  void handleSend(pendingQuestion.text);
}, [pendingQuestion, handleSend]);
```

Why this is once and only once:

- `handleSend`'s identity changes on every `turns` update (`AssistantConversation.tsx:253-268`
  closes over `turns`), so this effect re-runs on every turn — **the ref guard, not the dependency
  array, is what makes it safe.** Do not try to fix it by trimming deps; that is how the next
  person breaks it.
- The ref is assigned **synchronously before** `handleSend`, so a double-invoked effect sends once.
  (There is no `<StrictMode>` anywhere in `applications/web/src` on React 19.2.8 — the guard is
  correct regardless, but do not justify it with StrictMode.)
- The route strips `ask` immediately, so a remount from Back/refresh sees no param.
- A monotonic `id` means a genuinely new question — even an identical string — has a higher id and
  does send.

The message itself goes through the existing `runExchange` → `toChatMessages` path.
**No second send path, no hand-built `ChatMessage`.**

---

## E. File-by-file change list

### `packages/domain`
| File | Change |
|------|--------|
| `src/api/AiChatApi.ts` | hoist the 5 variants into field records; add `SearchHit`; redefine `EntityRef` as records + `ref`. Same keys and values on the wire; **key order changes** (`ref` moves last). |
| `src/api/SearchApi.ts` | **new** — re-export `SearchHit`; `searchHitLabel`, `searchHitId`; `SearchForbidden`; `SearchApiGroup`. |
| `src/index.ts` | `export * as SearchApi from './api/SearchApi.js';` |
| `AGENTS.md` | add `SearchHit` row to the shared-schema table. |
| `test/SearchApi.test.ts` | **new** — §F.1. |

### `applications/server`
| File | Change |
|------|--------|
| `src/services/ai/toolTypes.ts` | split `EntityReadContext` (`teamId`, `membership`, `canSeeGroup`) out of `ToolContext` (which now `extends` it and adds `teamTimezone`); `buildListResult(rows, toHit, toItem)` — `toHit(row) => SearchHit`, no token param; `ToolExecutionResult.references` → `hits: ReadonlyArray<SearchHit>`; delete `PENDING_REF`. |
| `src/services/ai/readTools.ts` | 5× `toXRef(row, ref)` → `toXHit(row)` (drop the `ref` field); the 5 list executors take `EntityReadContext`; `listEventById` and `currentDatetime` keep `ToolContext`. |
| `src/services/ai/refTokens.ts` | `entityKeyOf(hit: AiChatApi.SearchHit)` (body unchanged). |
| `src/services/ChatAgent.ts` | `remapCallReferences(state, hits, items)` (`:364-383`); `{ ...hit, ref: token }` now *constructs* the `EntityRef`. `execResult.references` → `execResult.hits`. `ChatAgentResult.references` is **not** renamed — the response contract is untouched. |
| `src/api/search.ts` | **new** — `SearchApiLive` + exported pure `rankAndCap`. |
| `src/api/api.ts` | `.add(SearchApi.SearchApiGroup)`. |
| `src/api/index.ts` | `Layer.provide(SearchApiLive)`. |
| `AGENTS.md` | one paragraph: the search endpoint enforces its gates by *calling* the read tools; never reimplement them; and it deliberately does not pass `includeAllGroups`. |
| `test/services/aiTools.test.ts` | **mechanical rename** `outcome.references` → `outcome.hits`, plus **one real assertion fix** (§F.5). |
| `test/api/search.test.ts` | **new** |
| `test/integration/api/search.test.ts` | **new** |
| `test/unit/searchRanking.test.ts` | **new** |

### `applications/web`
| File | Change |
|------|--------|
| `package.json` | `cmdk` in `dependencies` (added by the shadcn CLI). |
| `src/components/ui/command.tsx` | **new**, generated. Do not hand-edit. Decline the `dialog.tsx` overwrite. |
| `src/lib/client.ts` | `.add(SearchApi.SearchApiGroup)` on `ClientApi` — the web mirrors the server's `HttpApi` by hand; forgetting this means `api.search` does not exist. |
| `src/components/organisms/CommandPalette.tsx` | **new** |
| `src/components/layouts/AuthenticatedLayout.tsx` | `searchOpen` state, `useNavigate`, the per-kind switch, `onAskAssistant`, the header ghost `Button` trigger, `flex-1 min-w-0` on the breadcrumb `div` (`:132`), mount `<CommandPalette>`. |
| `src/components/layouts/AuthenticatedLayout.test.tsx` | **must be updated or it goes red** — see below. |
| `src/components/molecules/assistant/AssistantResultCard.tsx` | widen `reference` to `AiChatApi.SearchHit`; add optional `renderWrapper`; five `renderLink={renderWrapper ?? …}` edits. |
| `src/routes/(authenticated)/teams/$teamId/assistant.tsx` | `validateSearch` for `ask`, one-shot capture with the **`.slice(0, 2000)` clamp**, strip with `navigate({ search: {}, replace: true })`. |
| `src/components/pages/AssistantPage.tsx` | `pendingQuestion` pass-through. |
| `src/components/organisms/assistant/AssistantConversation.tsx` | `pendingQuestion` prop + the auto-send effect. |
| `test/CommandPalette.test.tsx` | **new** |
| `test/AssistantResultCard.test.tsx` | extend: the `renderWrapper` branch and a `SearchHit` (no `ref`) input. |
| `test/AssistantConversation.test.tsx` | extend with the auto-send cases. |

> **`src/components/layouts/AuthenticatedLayout.test.tsx` is a guaranteed red test.** (Note the
> path — it lives next to the component, not in `applications/web/test/`.) Its
> `vi.mock('@tanstack/react-router', …)` at `:10-17` exports exactly `Link`, `Outlet`, `useMatches`
> and `useRouter`. This change adds `useNavigate()` to the layout and mounts a `useQuery` consumer
> with no `QueryClientProvider` in that test. Two one-line additions fix it:
> - `useNavigate: () => vi.fn()` in the existing router mock.
> - `vi.mock('~/components/organisms/CommandPalette', () => ({ CommandPalette: () => null }))` —
>   the layout test is not the palette's test, and mocking it out avoids dragging a query client
>   and cmdk into a shell smoke test.

### `packages/i18n`

**10 new keys**, all `search_*`, all literal (never computed — `src/lib/staticTrKeys.test.ts`
sweeps literal `tr('…')` call sites, so a typo fails CI):

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

- `search_title` and `search_description` are **a11y-required** (the `sr-only` `DialogTitle` /
  `DialogDescription`; Radix logs an error without a title). `search_title` does double duty as the
  header trigger's `sr-only` label.
- `search_resultCount` is `sr-only`, so Czech takes the plural-safe "Počet výsledků: {count}" form
  rather than fighting the 1 / 2–4 / 5+ declension.
- Quotation marks are baked into the strings so Czech gets „…“ and English “…”.
- Czech keeps the app's **vykání** register.
- **No new per-kind strings.** Group headings reuse the existing plural keys `event_events`,
  `team_members`, `team_groups`, `team_rosters`, `team_trainingTypes`; the offline line reuses
  `error_offline`; row internals reuse whatever `AssistantResultCard` already calls
  (`assistant_result_*`, `group_memberCount`, `roster_memberCount`, `roster_active/_inactive`,
  `trainingType_noGroup`, `event_allDayLabel`, `event_status_*`, `event_type_*`).
- Then `pnpm codegen && pnpm build` in `packages/i18n`.

---

## F. Test specification

### F.1 Domain — `packages/domain/test/SearchApi.test.ts` (plain `vitest`, pure schema)

1. **`SearchHit` round-trips for all five kinds.** Build one hit per kind with real constructors
   (`new EventApi.EventInfo({…})`, `new GroupApi.GroupInfo({…})`, `new Roster.RosterInfo({…})`,
   `new TrainingTypeApi.TrainingTypeInfo({…})`, and the member struct). Encode
   `Schema.Array(SearchHit)`, then decode the encoded value back. Expect `Success` and
   deep-equality on the decoded value.
2. **The nominal trap, pinned.** Encoding `{ kind: 'event', event: { eventId: …, title: …, … } }`
   — a plain object matching `EventInfo` field-for-field — **fails**, and the message contains
   `EventInfo`. This is the `chatMessages.test.ts` guard, one layer down.
3. **`EntityRef` is `SearchHit` + `ref`.** For each kind: take an encoded `EntityRef`, delete `ref`,
   assert it decodes as a `SearchHit`; and assert an encoded `SearchHit` plus `{ ref: 'ab23' }`
   decodes as an `EntityRef`. This is what stops the two unions drifting.
4. **`EntityRef`'s encoded shape is unchanged — asserted with `toEqual`.** Pin one full encoded
   event-kind `EntityRef` against a literal object.
   **Use `expect(encoded).toEqual({ kind: 'event', ref: '…', event: { … } })` and nothing else.**
   Not `toMatchSnapshot`, not `JSON.stringify(...) === '…'`, not `Object.keys(encoded)`. The field
   records move `ref` to the end of the object, so key order genuinely changes while the keys and
   values do not; an order-sensitive assertion goes red on a harmless change and gets deleted
   instead of read.
5. **`searchHitLabel` / `searchHitId`** return the expected string for each of the five kinds
   (exhaustiveness is a compile-time switch; this pins the values). `searchHitId` is `"<kind>:<id>"`.
6. **Type-level: a `SearchHit` has no `ref`.** One line, no runtime assertion:
   ```ts
   // @ts-expect-error — SearchHit carries no per-turn token; identity is searchHitId(hit).
   const _noRef: string = (hit as AiChatApi.SearchHit).ref;
   ```
   This replaces a runtime "no hit carries a `ref` key" check, which **cannot work**:
   `Schema.Array(SearchHit)` silently drops an unknown `ref` on encode, so such a test passes even
   if the handler is leaking raw `EntityRef`s internally. The compiler is the only place this is
   actually enforceable.

### F.2 Server — `applications/server/test/unit/searchRanking.test.ts` (plain `vitest`, pure)

`rankAndCap(hits, query, todayIso)` with `todayIso` fixed and injected, never a clock (root
`AGENTS.md`'s "a cron's fixtures and the cron must share ONE instant", generalised):

1. **Kind order:** a shuffled input returns event → member → group → roster → trainingType.
2. **Prefix before substring:** query `'ann'`, members `['Joanna', 'Anna']` → `Anna` first.
3. **Event bucketing:** `todayIso = '2026-06-15'`, events `2026-06-20`, `2026-06-15`, `2026-01-02`,
   `2025-11-30` → `['2026-06-15', '2026-06-20', '2026-01-02', '2025-11-30']` (today, then upcoming
   ascending, then past descending).
4. **The midnight grace band:** `todayIso = '2026-06-15'` with an event on `2026-06-16` (the
   team-local "today" when UTC is a day behind) → it sorts in the **upcoming** bucket, not the past
   one. And an event on `2026-06-13` still sorts as past. This is the case the band exists for.
   *(There is no `startDate: None` case to test — `toEventInfo` (`api/event.ts:50`) sets
   `Option.some` unconditionally, so that branch is unreachable. Do not write a test for it.)*
5. **Per-kind cap:** 9 matching members → exactly 5 member hits, and the other kinds are untouched.
6. **Total cap:** more than 25 hits across kinds → exactly 25, with the kind order preserved.
7. **Stability:** two members with equal ranking keep input order.

### F.3 Server — `applications/server/test/api/search.test.ts` (plain `vitest`, full `ApiLive` harness)

Model on `test/api/ai-chat.test.ts` / `test/api/eventList.test.ts`: full `ApiLive` +
`AuthMiddlewareLive` + mock repositories, real HTTP via `HttpRouter.toWebHandler`. Plain `vitest`,
not `it.effect` — every `test/api/*.test.ts` does this because the harness deals in
`Promise<Response>`.

**The harness is the point.** A real round-trip means the response goes through the real
`Schema.Array(SearchHit)` **encode**. Mocked repositories therefore return rows whose mappers
produce real `Schema.Class` instances. An `expect(response.status).toBe(200)` on every request is
mandatory — an encode failure surfaces as a 500 and every later field read is `undefined`.

Fixtures: one team, one entity of each kind whose name matches the single query `'alpha'`; plus a
second team with an identically-named entity for the scoping test.

| # | Case | Expect |
|---|------|--------|
| 1 | non-member of the team | `403`, body `_tag === 'SearchForbidden'` |
| 2 | member of team A queries team B's id, where team B has a matching entity of every kind | `403`, and the body contains none of team B's names |
| 3 | admin (all permissions), `q=alpha` | 200; at least one hit of each of the five kinds (the admin's events are in groups they are in — see 11) |
| 4 | caller **with** `member:view` | 200; the matching member hit is present |
| 5 | caller **without** `member:view`, **same query, same fixtures** | 200 (not 403); **zero** `kind: 'member'` hits; the event/trainingType hits are still present |
| 6 | caller **with** `group:manage` | group hit present |
| 7 | caller **without** `group:manage`, same query | 200; zero group hits; other kinds present |
| 8 | caller **with** `roster:view` | roster hit present |
| 9 | caller **without** `roster:view`, same query | 200; zero roster hits; other kinds present |
| 10 | plain member; an `alpha` event in a group they are **not** in (`canSeeGroup` false) and one with no group | **only the ungrouped event** is returned |
| 11 | **`team:manage` caller, same fixtures as 10** | **only the ungrouped event** — identical to 10. Search never passes `includeAllGroups`, so `readTools.ts:161-178` takes the `Effect.filter(…canSeeGroup…)` branch for admins too, exactly as `api/event.ts:173-181` does without `?all=1`. Add a comment on this case saying that a future change making admins see both events is a **contract change**, not a bug fix. |
| 12 | `q` omitted | 400 from the schema |
| 13 | `q` = 101 chars | 400 |
| 14 | `q` matching nothing | 200, `[]` |
| 15 | no member hit carries `discordId`, `userId`, `username`, `email`, `birthDate`, `gender` or `permissions` | the allow-list, re-asserted on this surface |
| 16 | caps: 9 matching members, 7 matching events | ≤5 of each, ≤25 total |

*(There is deliberately no "no hit carries a `ref` key" HTTP case — see F.1 case 6 for why it would
be vacuous.)*

**The trap to avoid, explicitly.** Each "without permission" case (5, 7, 9) must use *the same
query and the same fixtures* as its "with permission" twin, and the twin must be asserted to
return the entity. A negative test whose query matches nothing for anyone passes forever and proves
nothing. Write the pairs adjacently so a future edit cannot break one without the other going red.

Cases 10/11 use a mocked `GroupsRepository.getDescendantMemberIds`, which is a flat lookup, not the
real recursive CTE. Per `applications/server/AGENTS.md` mock rule 4, the mock carries a comment
saying it does not model the ancestor walk, and points at F.4 for the real semantics.

### F.4 Server — `applications/server/test/integration/api/search.test.ts` (real Postgres)

Use the **"SmallApi" harness** (`test/integration/api/bankSync.test.ts:1-9`,
`teamSettingsReanchor.test.ts`): an `HttpApi` containing only `SearchApi.SearchApiGroup`, real
repositories over `TestPgClient`, hand-rolled `SessionsRepository` mock for auth. No `ApiLive`.

1. Nested group visibility: an event in a grandchild group is visible to a member of the parent
   group and invisible to an unrelated member — the real `getDescendantMemberIds` recursion.
2. Archived group in the chain behaves as the group endpoints do.
3. Cross-team isolation against real SQL: identical names in two teams, each caller sees only their
   own team's rows, for all five kinds.
4. A caller with `member:view` but no `roster:view` gets members and no rosters, against real rows.
5. A `team:manage` caller does **not** see an event in a group they are not in (the real-SQL
   counterpart of F.3 case 11 — this is the one that would catch someone adding
   `includeAllGroups: true` later).

(The suite is serial — do not run overlapping integration runs.)

### F.5 Server — the regression bar for the `ref` refactor

**Unchanged, genuinely:** `test/services/ChatAgent.test.ts` and `test/api/ai-chat.test.ts`. Both
assert only on `ChatAgentResult.references` and the response body, neither of which this change
renames or reshapes. **If either needs an assertion edit, the chat wire format moved and the
refactor must be re-examined.** That is the bar.

**Not unchanged, and do not pretend otherwise:** `test/services/aiTools.test.ts` asserts directly
on `ToolExecutionResult`, whose field is being renamed. It is a **mechanical rename**
(`outcome.references` → `outcome.hits`) — plus one real fix:

```ts
// applications/server/test/services/aiTools.test.ts:572 — today
expect(item?.ref).toBe(reference.ref);
```

This assertion is **vacuous**: both sides are the `'----'` placeholder, so it passes even if `toRef`
and `toItem` were fed different rows. It also stops compiling once hits lose `ref`. Replace it with
the pairing it was trying to express — the **positional** invariant that
`remapCallReferences` (`ChatAgent.ts:364-383`) actually relies on, checked by an identity the rows
really carry:

```ts
// `hits[i]` and `items[i]` must describe the SAME row — that positional pairing is what
// `remapCallReferences` assumes when it stamps token i onto both.
expect(item?.title).toBe(hit.event.title);
expect(item?.eventId ?? hit.event.eventId).toBe(hit.event.eventId);
```

Add one assertion to `ChatAgent.test.ts` if it is not already there: every `references[i].ref` in
the final response is a 4-char token from the mint alphabet, and never `'----'`.

### F.6 Web — `applications/web/test/CommandPalette.test.tsx`

Mock preamble follows `AssistantConversation.test.tsx`: an explicit finite `tr` map (never an
identity function — that hides computed-key bugs), `~/lib/runtime` with a stable `mockRun` that
really runs the piped Effect, `@tanstack/react-router` minimal, and dynamic `await import` after
the mocks. Additionally:

- **`Element.prototype.scrollIntoView = vi.fn()`** in the file's setup — cmdk scrolls the selected
  item into view and jsdom does not implement it. Without this every keyboard test throws.
- A `QueryClientProvider` wrapper (the palette uses `useQuery`).
- `vi.useFakeTimers()` for the debounce cases; advance with `vi.advanceTimersByTimeAsync`.
- The palette is rendered with `open` / `onOpenChange` driven by the test (the layout owns them in
  production), plus spy `onSelectHit` / `onAskAssistant`.

| # | Case | Expect |
|---|------|--------|
| 1 | `fireEvent.keyDown(window, { key: 'k', metaKey: true })` | `onOpenChange(true)` |
| 2 | same with `ctrlKey` | `onOpenChange(true)` |
| 3 | `key: 'k'` with no modifier, and `key: 'k'` with `metaKey` + `shiftKey` | nothing |
| 4 | `metaKey` + `k` while `document.body` has `data-scroll-locked` and `open === false` | **nothing** — another modal owns the screen |
| 5 | same, but `open === true` | `onOpenChange(false)` — the guard must not block closing |
| 6 | `Escape` while open | dialog closes (Radix) |
| 7 | type `'a'`, advance 250 ms | **no** request issued; `search_hint` rendered |
| 8 | type `'alpha'` one character at a time, advance 250 ms once at the end | the search mock called **exactly once**, with `q: 'alpha'` |
| 9 | pending request | `search_loading` rendered |
| 10 | resolve with `[]` | `search_noResults` rendered, **and the Ask row is present** |
| 11 | resolve with hits of all five kinds | five **plural** group headings (assert against the real `event_events` / `team_members` / … keys), rows rendered by `AssistantResultCard` |
| 12 | a result set with **no group hits** | no "Groups" heading anywhere in the DOM |
| 13 | a hit whose visible text does **not** contain the query (e.g. the server matched a title the row truncates) | the row still renders — the `shouldFilter={false}` guard. **This is the regression test for cmdk's default filter scoring the explicit `value={kind:id}` and dropping every row.** |
| 14 | `ArrowDown` ×1 then `Enter` | `onSelectHit` called with the first hit |
| 15 | one test **per kind** selecting that kind's hit, then asserting at the layout level | `navigate` called with that kind's `ENTITY_ROUTE` and the right params (assert against the real `ENTITY_ROUTE` import, not a copied string) |
| 16 | type `'alpha'`, select the Ask row | `onAskAssistant('alpha')`; at the layout level, `navigate({ to: '/teams/$teamId/assistant', params: { teamId }, search: { ask: 'alpha' } })` |
| 17 | type `'who is on the roster?'` vs type `'Novák'` | `search_askAssistant` vs `search_askAssistantAbout` — the `?`/word-count heuristic |
| 18 | `query === ''` | **no** Ask row |
| 19 | `navigator.onLine === false`, type `'alpha'`, advance 250 ms | `error_offline` rendered, **no request issued**, **no Ask row** |
| 20 | search, close, reopen | the input is empty **and no stale rows render** (this fails if only `query` is reset — the 250 ms window serves the old `debounced` key from cache) |
| 21 | request rejects | `search_error` rendered, dialog stays open, Ask row present |
| 22 | type 120 characters into the input | the value is capped at 100 and no 400-triggering request is issued (`maxLength={100}`) |
| 23 | the live region | exactly one `[aria-live]` node in the dialog, it is **not** a descendant of the `role='listbox'` element, and there is no `role='status'` |

**The mocked-client blind spot.** The result tests mock `api.search.search`, so no real decode
runs — the same hole that shipped the assistant unable to send. Close it in the fixtures, not with
more mocks: build the fixture array with real constructors, pass it through
`Schema.encodeUnknownSync(Schema.Array(SearchApi.SearchHit))` and back through
`Schema.decodeUnknownSync`, then hand *that* to the mock.

### F.7 Web — `applications/web/test/AssistantResultCard.test.tsx` (extend)

1. **The widened prop:** pass a `SearchHit` (constructed with no `ref` field at all) for each of the
   five kinds → renders the same content as today's `EntityRef` fixtures. This is what proves the
   widening is real and not just a type annotation.
2. **`renderWrapper` is used when provided:** pass `(children, className) => <li data-testid='wrap'
   className={className}>{children}</li>` → the row's content is inside `[data-testid=wrap]` and
   there is **no `<a>`** in the output.
3. **`renderWrapper` omitted → the default `<Link>` is unchanged**, for at least the `event` and
   `member` branches (the two with the most per-kind logic). This is the "chat surface cannot
   regress" guard.

### F.8 Web — auto-send, added to `applications/web/test/AssistantConversation.test.tsx`

1. `pendingQuestion={{ text: 'hi', id: 1 }}` on mount → `mockChat` called **exactly once**, with a
   payload whose `messages[0]` is a real `AiChatApi.ChatMessage` instance.
2. Re-render with the **same** `{ text, id }` object and then with an equal-valued new object →
   still exactly one call.
3. Force additional renders (send a second message manually, which changes `turns` and therefore
   `handleSend`'s identity) → still exactly one auto-send.
4. `pendingQuestion={{ text: 'hi', id: 2 }}` after id 1 was consumed → a second call (the
   repeat-the-same-question case).
5. `pendingQuestion={undefined}` → no call.

### F.9 Web — the route's clamp and strip (`assistant.tsx`)

Test the route component directly with its loader data and `useSearch`/`useNavigate` mocked — the
effect is eight lines and a mocked `useNavigate` is enough.

1. **`ask` of 3000 characters → exactly one send, with `text.length === 2000`, and no throw.**
   This is the blocker case: unclamped, `toChatMessages` throws inside `runExchange` at
   `AssistantConversation.tsx:191`, *before* `setSubmitting(true)` at `:193` and *outside* the
   `try` at `:246`, so the rejection lands in `void handleSend(...)` with no error turn, no toast
   and no request. Assert the send happened and the page still renders.
2. **`ask=''` and `ask='   '` → no send at all**, and no throw (`new ChatMessage({ content: '' })`
   would throw too).
3. `ask='hello'` → `pendingQuestion.text === 'hello'`, and `navigate` called with exactly
   `{ search: {}, replace: true }` (no `to`, no `params`).
4. `ask` absent → `navigate` not called, `pendingQuestion` undefined.
5. `enabled === false` with `ask='hello'` → the disabled state renders, `navigate` is still called
   with the strip (the param must not survive), and nothing sends.

### F.10 Not in scope

No e2e test. The keyboard flow, the five navigations and every gate are covered above; an e2e for
this would mostly re-test cmdk.

---

## G. Effort

| Slice | Estimate |
|-------|----------|
| Domain (`SearchHit`/`EntityRef` split, `SearchApi.ts`, index, AGENTS row, F.1) | 0.5 d |
| Server refactor (`toolTypes`, `readTools`, `refTokens`, `ChatAgent`, `aiTools.test.ts`) + keeping the assistant suite green | 0.5 d |
| Server endpoint + ranking + F.2/F.3/F.4 | 1.0–1.5 d |
| Web palette (cmdk, `Command`, organism, header trigger, `AssistantResultCard` widening, i18n) + F.6/F.7 | 1.0–1.5 d |
| Assistant hand-off + F.8/F.9 | 0.5 d |
| **Total** | **3.5–4 days** |

**This is materially bigger than "a nice little search"** — that phrase describes about half a day.
The gap is the five permission gates (16 HTTP cases, half of which must be written in pairs to be
non-vacuous), the contract split needed to avoid shipping a fake `ref` field, and the assistant
hand-off, which is a second feature wearing the first one's coat.

**Full scope is approved; no cuts are being taken.** Recorded only so nobody re-derives it: if the
budget ever shrinks, the order is (1) drop the hand-off (§D, −0.5 d), (2) ship events + members
only (−1.0 d). Never cut ranking (§A) or the `SearchHit` split — the first is visibly bad for any
team older than a season, and the second is a net deletion.

---

## Risks

- **`packages/domain` changes need `pnpm build` before the server/web typecheck sees them.** Build
  first, then `pnpm check`.
- **The assistant is live.** The `EntityRef` redefinition must keep the same keys and values.
  F.1 case 4 (a `toEqual` literal) is the guard; do not skip it, and do not write it as a snapshot.
- **`ToolExecutionResult.references` → `hits`** touches a production code path. It is a pure
  type/field rename with `{ ...hit, ref: token }` doing what it already did. Bar: `ChatAgent.test.ts`
  and `api/ai-chat.test.ts` unchanged; `aiTools.test.ts` mechanically renamed (§F.5).
- **`cmdk` drags in a second copy of three `@radix-ui/react-*` packages** alongside the unified
  `radix-ui`. Name it in the PR.
- **Lockfile/toolchain order:** `pnpm install` before `pnpm format`/`pnpm lint`, or biome reformats
  unrelated files (root `AGENTS.md`).
- **`src/lib/client.ts` is a hand-maintained mirror** of the server's `HttpApi`. Forgetting the
  `.add(SearchApi.SearchApiGroup)` there produces "property 'search' does not exist", not a routing
  error — easy to misdiagnose.
- **`AuthenticatedLayout.test.tsx` will go red** on the `useNavigate` + `useQuery` additions unless
  its mocks are extended (§E).
- **Web tests + cmdk + jsdom:** `scrollIntoView` is missing; budget an hour for the first keyboard
  test.
- **Per-keystroke DB cost and five serial round trips**, documented above with `ponytail:` comments
  and upgrade paths.
- **The unclamped `?ask=` failure mode is silent** — no toast, no log, no request. If the clamp is
  ever removed, nothing will report it. F.9 case 1 is the only thing standing between that and
  production.

---

## The `ApiLive` mock-layer cascade — verified answer

**No cascade.**

`grep -rl ApiLive applications/server/test` returns 60 files. Of those, 16 never compose the real
`ApiLive` (the `*ApiLive` single-group harnesses like `health.test.ts` and `api/version.test.ts`,
the three `test/mocks/*.ts` modules, and the "SmallApi"/integration files). **44 files compose the
real `ApiLive`.**

**The reason none of them need a change is not that they happen to provide the five repositories —
it is that `ApiLive` already requires all five transitively.** `EventsRepository`,
`TeamMembersRepository`, `GroupsRepository`, `RostersRepository` and `TrainingTypesRepository` are
already in `ApiLive`'s requirement set via the existing event/member/group/roster/training-type
groups, so **`SearchApiLive` adds nothing to it.** Any file that constructs `ApiLive` today already
satisfies everything `SearchApiLive` asks for, by construction rather than by coincidence.

**What the `EntityReadContext` split actually buys** is therefore not "avoiding a cascade" — it is
avoiding a **per-keystroke `TeamSettingsRepository` query**. `ToolContext` carries `teamTimezone`,
which is resolved by a settings lookup that search never reads. Splitting the context out means the
handler builds only what it uses.

**The condition that would break this: `SearchApiLive` introducing a genuinely new
`ServiceMap.Service`** (a cache, a rate limiter, a config service) that `ApiLive` does not already
require. That fires as a *runtime* missing-service error at layer construction, not a compile
error, in all 44 suites at once. The 43-file AI-assistant precedent is in
`applications/server/AGENTS.md`. Before merging, re-run:

```bash
grep -rl ApiLive applications/server/test
```

and confirm `SearchApiLive`'s requirement set is a subset of what `ApiLive` already needs.
