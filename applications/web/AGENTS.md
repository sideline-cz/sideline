# Web Application (`@sideline/web`)

TanStack Start frontend with React 19, Vite, and Nitro SSR.

## Component Structure — Atomic Design

Components live in `src/components/` following **Atomic Design**:

```
components/
├── ui/          — Shadcn/UI primitives (auto-generated, do not hand-edit)
├── atoms/       — Smallest self-contained components (e.g. DiscordChannelLink)
├── molecules/   — Combinations of atoms (e.g. FormField = Label + Input)
├── organisms/   — Complex, multi-responsibility sections (e.g. ProfileCompleteForm)
├── pages/       — Full page components, one per route (e.g. HomePage, DashboardPage)
└── layouts/     — Structural wrappers/shells (e.g. RootDocument)
```

### Layer Guidelines

| Layer | Rule |
|-------|------|
| `ui/` | Shadcn primitives only. Added via `pnpm -C ./applications/web dlx shadcn@latest add <component>`. Never hand-edited. |
| `atoms/` | Single responsibility, no business logic, no API calls. |
| `molecules/` | Compose atoms + ui. No route-level data fetching, no API calls. |
| `organisms/` | May own significant local state, form logic, or API calls via `useRun()`. No TanStack Router hooks — take an `onRefresh: () => void` prop instead (see below). |
| `pages/` | One file per route. Receives data from `Route.useLoaderData()` / `Route.useRouteContext()` via props. Contains navigation callbacks. |
| `layouts/` | Pure structural wrappers. Render `{children}` slots. No business logic. |

An organism that must refetch loader data after a mutation takes an `onRefresh: () => void` prop and the **page** supplies `() => { router.invalidate(); }` — never `useRouter()`/`useNavigate()`/`useSearch()`/`useParams()`/`useRouteContext()` inside the organism. Reference: `components/organisms/team-settings/*` + `components/pages/TeamSettingsPage.tsx`. Six organisms predate this rule and still call `useRouter()` directly — `AdoptChannelDialog.tsx`, `ArchiveChannelDialog.tsx`, `BulkArchiveDialog.tsx`, `ChannelAccessSheet.tsx`, `CreateChannelDialog.tsx`, `RenameChannelDialog.tsx`. They are known debt, not precedent: convert each to `onRefresh` the next time it is edited. Importing the `<Link>` component (not a hook) into an organism stays allowed.

`AuthenticatedLayout.tsx` is one exception to the `layouts/` row above: it owns `useNavigate()` and the command palette's five-branch per-kind navigation switch (`onSelectHit`/`onAskAssistant`). No page wraps every authenticated route the way `AuthenticatedLayout` does, so there is no page for an app-wide Cmd/Ctrl+K palette to hand navigation off to — this is the least-bad placement, not a precedent for other layout-level business logic.

## Shadcn Components

Use the latest version of Shadcn to install new components:

```bash
pnpm -C ./applications/web dlx shadcn@latest add button
```

**Always prefer Shadcn components over plain HTML tags:**
- `<button>` → `<Button>` from `components/ui/button`
- `<a href>` → `<Button asChild><a href={...}>...</a></Button>`
- `<input>` → `<Input>` from `components/ui/input`
- `<input type='date'>` → `<DatePicker>` from `components/ui/date-picker` (see "Date Inputs — `DatePicker`" below)
- `<select>` → `<Select>` from `components/ui/select` (fixed enums) or `<SearchableSelect>` from `components/atoms/SearchableSelect` (dynamic data)
- `<label>` (in forms) → `<FormLabel>` from `components/ui/form`

### Cancelling a Hardcoded `role` — Use a Real Role, Never `role={undefined}`

Several `components/ui/*` primitives hardcode an ARIA attribute **before** their `{...props}` spread — `alert.tsx` renders `<div data-slot='alert' role='alert' … {...props} />` — so passing the prop is the only way to override it, and `biome.json` excludes `applications/web/src/components/ui/*.tsx` from lint and format, which is why the hardcoded value never gets flagged there.

**Override with an explicit valid role. `role={undefined}` is silently deleted by `pnpm format`.** `pnpm format` is `biome check --write --unsafe .`, and `lint/a11y/useValidAriaRole`'s unsafe fix is "Remove the invalid role attribute" — `role={undefined}` reads as an invalid role, so the attribute vanishes from the file and the primitive's hardcoded `role='alert'` comes back. The edit survives `tsc` (`pnpm check`) and the running app, then disappears on the next format run with no diff you asked for; `aria-*={undefined}` is *not* affected, so the failure looks arbitrary.

```tsx
// ✗ Bad — `pnpm format` deletes this prop; the component is `role='alert'` again
<Alert role={undefined}>
// ✓ Good — a real role the a11y rule accepts, and the override is stable
<Alert variant='warning' role='presentation'>
```

Reference: `components/organisms/bank/FioTestResultAlert.tsx`. Its `role='presentation'` is load-bearing — the alert renders **inside** the permanently-mounted `aria-live='polite' aria-atomic='true'` region owned by `FioBankCard.tsx` (deliberately a bare `<div>` with no `role='status'` — see `SaveBar` rule 3 for why a second `status` element on this page is a test hazard), and leaving the default `role='alert'` nests an implicitly assertive live region inside a polite one, double-announcing a result the user explicitly asked for. When a component must be announced, put the `aria-live` region on the always-mounted parent and strip the child's role — most screen readers only announce mutations made inside a region that already existed.

### Interactive Triggers: `Badge` Is a `<span>`, Tooltips Do Not Open On Touch

Rules:

1. **Never attach a click/keyboard handler — or a Radix `asChild` trigger — to `<Badge>`.** `components/ui/badge.tsx` renders a bare `<span>`: not focusable, not in the tab order, not announced as a control. An interactive badge-shaped affordance (e.g. the `+n` overflow chip in `EffectiveRolesList.tsx`) MUST be a real `<Button>` styled to look like a badge, never a `Badge` with an `onClick`.
2. **A disclosure that must work on touch uses `<Popover>`, never `<Tooltip>`.** Radix tooltips open on hover/focus only and never open on a tap, so touch users get nothing. Use `<Tooltip>` only for supplementary text that is ALSO reachable another way (e.g. an `sr-only` label on the same control); use `<Popover>` whenever the disclosed content is the only route to the information or to an action. Reference: `EffectiveRolesList.tsx` (`+n` → `Popover`), `PlayerDetailPage.tsx` `InheritedRoleForwardControl` (one granting group → `Tooltip` beside an `sr-only` label on the link; 2+ groups → `Popover` listing one link per group).
3. **Encode a state distinction on a badge through at least two non-colour channels plus the accessible name.** Colour alone disappears under forced-colors mode, greyscale and screen readers. `RoleBadge.tsx` marks a group-inherited role with a dashed border (shape), a leading `Users` icon (`aria-hidden`) and an `aria-label` naming the granting group(s).

### Touch Targets Live in `src/styles.css` — Grow the Hit Area, Never the Box

`applications/web/src/styles.css` holds one `@media (pointer: coarse)` block that enforces the 44x44px minimum touch target app-wide. Radix primitives render as real `<button>` elements, so that block hits every one of them — including the ones that are deliberately tiny. `Switch` (`components/ui/switch.tsx`) is `<button role='switch'>` styled `h-[1.15rem] w-8 rounded-full`; the `min-width: 44px` introduced in `4a471dc4` turned it into a plain circle with the `size-4` thumb centred inside it and the checked/unchecked thumb translation invisible. It reached production as "the toggle on the phone is a circle with a dot in the middle".

**A control whose visual dimensions carry meaning MUST be excluded from the `min-height`/`min-width` inflation and given its 44px target through a transparent `::after` overlay instead.** Never shrink the target below 44px to fix the look — the target is an accessibility requirement, the painted box is not.

```css
button:not([role="switch"], [role="checkbox"]),
a[role="button"],
[role="radio"] { min-height: 44px; min-width: 44px; }

[role="switch"], [role="checkbox"] { position: relative; }
[role="switch"]::after, [role="checkbox"]::after {
  content: ""; position: absolute; top: 50%; left: 50%;
  width: max(100%, 44px); height: max(100%, 44px); transform: translate(-50%, -50%);
}
```

`[role="radio"]` stays inflated on purpose — `ToggleGroup` items are labelled text buttons meant to be large. When adding a new small control (a `RadioGroup` dot, an icon-only toggle), add its role to the `:not(...)` list **and** the `::after` selector list in the same edit; adding it to only one leaves it either deformed or untappable. Check the result under devtools touch emulation — with a mouse the whole block is inert and the breakage is invisible.

**There is no `collapsible` primitive in `components/ui/`. Build an inline disclosure as `useState` plus a `<Button aria-expanded={open} aria-controls='<id>'>` and render the panel with that `id` only while open — never `<details>`/`<summary>`.** The block above matches `button`, `a[role="button"]` and `[role="radio"]`; a `<summary>` matches none of them, so a native disclosure ships a sub-44px touch target that no lint rule and no desktop review will catch. Reference: `components/organisms/EventRsvpPanel.tsx` (`summaryOpen` → `aria-controls='rsvp-responses-panel'`).

### Date Inputs — `DatePicker`

For any user-editable calendar date (event date, activity-log date, fee due date, expense spent-at date), use `<DatePicker>` from `~/components/ui/date-picker` — never the native `<input type='date'>`. The component is a Popover + Calendar combo that uses `date-fns` for locale-aware display and emits a canonical `YYYY-MM-DD` string via `onChange`.

```typescript
import { DatePicker } from '~/components/ui/date-picker';
import { tr } from '~/lib/translations.js';

const [dateInput, setDateInput] = React.useState<string>('');

<DatePicker
  value={dateInput}
  onChange={setDateInput}
  placeholder={tr('activityLog_datePlaceholder')}
  fromYear={new Date().getFullYear() - 2}
  toYear={new Date().getFullYear() + 2}
/>
```

Reference: `applications/web/src/components/organisms/ActivityLogList.tsx` (create + edit sheet both render `<DatePicker>`).

Rules:

1. **`value` and `onChange` operate on `YYYY-MM-DD` strings, not `Date` objects.** The parent component holds a `string` in `useState`; the calendar internally decodes via `date-fns` `parse(value, 'yyyy-MM-dd', new Date())` and re-encodes via `format(date, 'yyyy-MM-dd')`. Do not convert to `Date` in the parent — keep the wire format end-to-end so it matches the `Schema.OptionFromNullOr(LoggedAtDate)`-style schemas on the API payload.
2. **Pass the empty string `''` (not `undefined`) as the "no value" state** to the controlled `value` prop. The component renders the `placeholder` when `value` is empty. Use `Option.some(dateInput)` only at the API-payload-construction boundary: `dateInput ? Option.some(dateInput) : Option.none<string>()`.
3. **Always pass `fromYear` and `toYear`** as `currentYear ± N` (typical: `±2` for activity logs, may differ per feature) so the year-dropdown caption-layout is enabled (`captionLayout: 'dropdown'`) instead of the default arrow-only nav. Users picking a date months/years away can jump directly via the dropdown.
4. **To forbid days beyond a bound, pass `toDate` — `toYear` alone never does it.** `toYear` only widens/narrows the year dropdown and the reachable month range; every day of that final year stays selectable. `toDate` is the day-granularity clamp: the component passes it to `endMonth` (so later months are unreachable) AND to react-day-picker's `disabled={{ after: toDate }}` matcher (so later days in the bound's own month are unselectable). Pass both when the bound is "today": `fromYear={currentYear - 1} toYear={currentYear} toDate={new Date()}`. Reference: `components/organisms/team-settings/FioBankCard.tsx` (`fio_token_created_at` must not be future-dated — see `applications/server/AGENTS.md` → "A Noon-Anchored Date-Only Column Is Not An Instant"). There is no `fromDate` counterpart yet; add one the same way if a lower day bound is ever needed.
5. **For edit forms, track a `dirty` flag** so the API call only sends the new date when the user actually picked one. Initialize `editDate` from `<Resource>Date.formatPragueDate(new Date(row.<field>))` and set `editDateDirty = true` only inside `onChange`. The submit handler then sends `editDateDirty ? Option.some(editDate) : Option.none<string>()` — pairs cleanly with the server's "missing key = do not update" PATCH contract (see `packages/domain/AGENTS.md` → `Schema.OptionFromOptional`).
6. **Never compute the displayed string with `date-fns` `format(...)` outside the component.** The component already calls `useDateFnsLocale()` internally; duplicating the locale wiring at the call site re-introduces the bug class that the central `useDateFnsLocale` hook exists to prevent (see "Date Formatting" below).

### SearchableSelect vs Select

| Component | When to use | Example data |
|-----------|------------|--------------|
| `Select` (Shadcn `components/ui/select`) | Fixed enums with fewer than 6 static items | Event type (`training`, `match`, ...), cleanup mode (`nothing`, `delete`, `archive`) |
| `SearchableSelect` (`components/atoms/SearchableSelect`) | Dynamic data, user-created lists, or any list that can grow | Groups, rosters, members, Discord channels, training types, roles |

`SearchableSelect` provides search filtering, alphabetical sorting, and optional pinned values. It accepts `{ value: string; label: string }[]` options.

```typescript
import { SearchableSelect } from '~/components/atoms/SearchableSelect';

<SearchableSelect
  value={field.value}
  onValueChange={field.onChange}
  placeholder={m.event_useDefault()}
  options={[
    { value: NONE_VALUE, label: m.event_useDefault() },
    ...items.map((item) => ({ value: item.id, label: item.name })),
  ]}
  pinnedValues={[NONE_VALUE]}
/>
```

**Key rules:**
- Always pass `pinnedValues` for sentinel values like `NONE_VALUE` or `__root__` or `__all__` so they stay at the top regardless of sort order.
- In forms, wrap `SearchableSelect` directly with `<FormControl>` — do **not** nest `SelectTrigger`/`SelectContent` inside it.
- Use shared helpers from `src/lib/group-options.ts` (`toGroupOptions`) when building options from `GroupApi.GroupInfo[]`.
- Use shared label maps from `src/lib/event-labels.ts` (`eventTypeLabels`, `dayShortLabels`, `dayFullLabels`, `DAY_ORDER`, `sortDays`) — never duplicate these inline.

## Route File Convention

Route files (`routes/**/*.tsx`) contain TanStack Router config (`createFileRoute`, `beforeLoad`, `loader`, `validateSearch`) plus a thin wrapper component that calls `Route.use*()` hooks and passes the results as props to the Page component. The Page component itself has no TanStack Router dependency.

```typescript
// routes/(authenticated)/dashboard.tsx
export const Route = createFileRoute('/(authenticated)/dashboard')({
  ssr: false, // Required: Effect Option types fail TanStack's serialization check
  component: DashboardRoute,
  beforeLoad: ...,
  loader: ...,
});

function DashboardRoute() {
  const { user } = Route.useRouteContext();
  const data = Route.useLoaderData();
  return <DashboardPage user={user} data={data} />;
}
```

```typescript
// components/pages/DashboardPage.tsx
export function DashboardPage({ user, data }: DashboardPageProps) {
  // No Route.use*() calls — pure component driven by props
}
```

### Route File Naming (TanStack Router)

Routes use a **hybrid directory + flat-file** layout. Top-level groupings (`profile/`, `teams/$teamId/`) are directories; sub-pages within them stay flat (dot-separated).

| File | Resolves to | Purpose |
|------|------------|---------|
| `profile/index.tsx` | `/profile` | **Index page** (has sibling sub-routes) |
| `profile/complete.tsx` | `/profile/complete` | **Page** |
| `teams/$teamId/members.index.tsx` | `/teams/:teamId/members` | **Index page** (has sibling `members.$memberId`) |
| `teams/$teamId/members.$memberId.tsx` | `/teams/:teamId/members/:memberId` | **Page** |
| `notifications.tsx` | `/notifications` | **Plain route** (no sub-routes, so no `.index`) |

**Key rules:**
- Use `.index.tsx` only when the route has sibling sub-routes sharing the same prefix
- When a route has sub-routes, the parent route file is a **layout** (wraps children via `<Outlet />`). The actual page at that path must be `index.tsx`.
- Always add `ssr: false` to `createFileRoute(...)({...})` options

### Current Route Structure

```
routes/(authenticated)/
├── route.tsx                      — layout wrapper (auth guard)
├── (no-team)/                     — authenticated-but-no-team-context pages
│   ├── no-team.tsx                — /no-team
│   ├── create-team.tsx            — /create-team
│   └── profile/
│       ├── index.tsx              — /profile
│       └── complete.tsx           — /profile/complete
└── teams/
    └── $teamId/                   — team-context pages (every route below requires membership)
        ├── route.tsx              — layout (redirects to /no-team on `NoSuchElementError`)
        ├── index.tsx              — /teams/:teamId
        ├── age-thresholds.tsx     — /teams/:teamId/age-thresholds
        ├── members.index.tsx      — /teams/:teamId/members
        └── ...                    — see directory listing for full list
```

### `(no-team)` Route Group Convention

The `(no-team)/` parenthesised group holds every authenticated route that **must not require an active team membership**. Any page reachable when the caller is logged in but has zero active memberships belongs here. Pages requiring a team context live under `teams/$teamId/`.

Current `(no-team)` members:

| Route | Purpose |
|-------|---------|
| `/no-team` | Landing page shown when the user has no active team. Renders a `justRemoved` banner when `?removed=1` is present (set by `teams/$teamId/route.tsx` after detecting the user was removed mid-session). |
| `/create-team` | Onboarding entry that provisions a new team. |
| `/profile`, `/profile/complete` | Per-user settings that have no team scope. |

Rules:

1. **A new authenticated route that has no `teamId` in its URL path belongs under `(no-team)/`.** Routes scoped to a team go under `teams/$teamId/`. The two groups never overlap.
2. **Both the root `/` loader and the `teams/$teamId/route.tsx` loader resolve their no-team redirect through the pure helper `resolveNoTeamRedirect` (`~/lib/auth/resolveNoTeamRedirect.ts`)** — never hand-roll the target inline. The helper applies this precedence: `hasOtherTeams` → `/`; else `isGlobalAdmin` → `/admin/onboarding-tokens`; else `/no-team` (with `search: { removed: 1 }` when `wasViewing` is `true`). A global admin with zero teams therefore lands on `/admin/onboarding-tokens`, not `/no-team`. Resolve the result to a single `Redirect` value before `Effect.fail` so TanStack's generic `Redirect.make` overloads don't widen the loader's error channel to `unknown`.
3. **`teams/$teamId/route.tsx` passes `wasViewing: getLastTeamId() === params.teamId`** so the removal banner (`?removed=1`) only shows when the user was actively viewing the team they were removed from. **The root `/` loader passes `hasOtherTeams: false, wasViewing: false`**, since it only reaches the helper after `findFirstTeam` returns `NoSuchElementError`. `/no-team` remains the single entry point for the non-admin "user has no team" UX; `/create-team` is reached only via an explicit CTA from `/no-team`.
4. **`clearLastTeamId()` (`~/lib/auth`) must be called before redirecting to `/no-team`.** Leaving the stale `lastTeamId` in localStorage would cause subsequent loads of `/` to redirect back to a team the user no longer belongs to, producing a redirect loop.

## Root Route: `shellComponent` vs `component`

The root route (`src/routes/__root.tsx`) defines BOTH a `shellComponent` (`RootDocumentRoute`) and a `component` (`RootComponent`). They are NOT interchangeable:

| Slot | Component | Renders | May call `Route.useRouteContext()`? |
|------|-----------|---------|-------------------------------------|
| `shellComponent` | `RootDocumentRoute` | The `<html>`/`<head>`/`<body>` document shell + `ThemeProvider` | **No** — renders ABOVE the root match's context provider; `Route.useRouteContext()` returns `undefined` |
| `component` | `RootComponent` | `RunProvider` + `TranslationOverridesProvider` + `<Outlet />` | **Yes** — renders INSIDE the root match's context provider |

Rules:

1. **Anything that depends on loaded route context (e.g. `serverUrl` from the root `beforeLoad`) MUST live in `RootComponent`, never in `RootDocumentRoute`.** The shell renders above the root match's context provider (see `@tanstack/react-router` `Match.js`), so `Route.useRouteContext()` is `undefined` there. Reading `serverUrl` in the shell silently yields `undefined`, which makes client API calls target the page origin instead of the API base URL.
2. **The shell receives only `{ children }`.** Do not add context-derived props (`run`, `serverUrl`) to `RootDocument` — it is a pure document wrapper. Context-dependent providers belong in `RootComponent`.
3. **Guard any `useQuery` that consumes `serverUrl` against the empty/unresolved base URL.** `TranslationOverridesProvider` sets `enabled: serverUrl.length > 0` and keys its query by `serverUrl` (`queryKey: ['translations', serverUrl]`) so it refetches against the correct base once resolved. An empty base URL would silently target the page origin.

## URL-Synced Tabs Via `validateSearch`

When a page renders a tab bar and the active tab must be deep-linkable (sharable URL, back/forward navigation, browser refresh preserves selection), sync the tab to a search param via TanStack Router's `validateSearch` instead of `React.useState`. The page component supports both modes (controlled URL-driven and uncontrolled local-state) via optional `activeTab` / `onTabChange` props so it stays testable in isolation.

Reference implementation: `applications/web/src/routes/(authenticated)/teams/$teamId/finances.tsx` (route) + `applications/web/src/components/pages/FinancesOverviewPage.tsx` (page). URL form: `/teams/:teamId/finances?tab=overview` | `?tab=by-member` | `?tab=by-assignment`.

Two tab-strip implementations exist and both obey the rules below. For a **new** page use the Radix primitive `components/ui/tabs.tsx` (`Tabs` / `TabsList` / `TabsTrigger` / `TabsContent`, reference `components/pages/TeamSettingsPage.tsx`) — never hand-roll a third. `FinancesOverviewPage.tsx` predates that primitive and builds its strip from `Button`s with `role='tab'`; leave it alone unless you are already editing it.

### Route File Shape

```typescript
type FinancesTab = 'overview' | 'by-member' | 'by-assignment';

const isFinancesTab = (value: unknown): value is FinancesTab =>
  value === 'overview' || value === 'by-member' || value === 'by-assignment';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/finances')({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { tab?: FinancesTab } =>
    isFinancesTab(search.tab) ? { tab: search.tab } : {},
  // ...
});

function FinancesRoute() {
  const { tab: searchTab } = useSearch({ from: Route.id });
  const navigate = useNavigate({ from: Route.fullPath });
  const activeTab = searchTab ?? defaultTab;
  const handleTabChange = (tab: FinancesTab) => navigate({ search: { tab } });
  return <FinancesOverviewPage activeTab={activeTab} onTabChange={handleTabChange} ... />;
}
```

### Rules

1. **The type guard MUST be a user-defined `(value: unknown) => value is T` predicate** (e.g. `isFinancesTab`) built from explicit `value === '<literal>'` comparisons. Do not use `Array.includes` on a `readonly` array of literals — its return type does not narrow `unknown` to the literal union.
2. **`validateSearch` MUST return `{}` (not `{ tab: undefined }`) when the value is invalid.** Returning `undefined` for an unknown key keeps the URL clean; returning the explicit key spreads into `navigate({ search: { tab } })` calls and can re-introduce stale params.
3. **The page component takes `activeTab?: ActiveTab` and `onTabChange?: (tab: ActiveTab) => void` as OPTIONAL props.** When both are provided the page is controlled (URL-driven); when omitted, it falls back to internal `React.useState`. The controlled-vs-uncontrolled branch lives in exactly one place: `const isControlled = controlledActiveTab !== undefined && onTabChange !== undefined;`. This keeps the page testable without mounting a router.
4. **Define the tab literal union ONCE in the page component file** (`type ActiveTab = ...`) and re-declare an identical alias in the route file. Do not import the type across the page/route boundary — the route owns URL serialization, the page owns rendering; both keep their copy of the literal union so a rename touches both files and is visible in PR diffs.
5. **The default tab is computed in the route, not in `validateSearch`.** `validateSearch` only narrows the parsed value; defaulting (`activeTab = searchTab ?? defaultTab`) happens in the component where `defaultTab` may depend on loader data (e.g. "show Overview tab only if `balanceSummaries` was fetched").
6. **When a panel holds unsaved form state, mount every panel with `forceMount` and hide inactive ones with an explicit `data-[state=inactive]:hidden` class — never let Radix unmount them.** `TabsContent`'s default behaviour (unmount when inactive) destroys any local `useState` the panel's cards own and re-seeds `useCardForm`'s baseline on remount, silently discarding whatever the user typed on a tab they merely clicked away from. `forceMount` makes Radix render `hidden={false}` on every panel regardless of selection, so the explicit class is what actually hides the inactive ones — hide with `display:none` (the `hidden` class), never `opacity-0` or `absolute`, or the invisible inputs stay in the tab order. Reference: `TeamSettingsPage.tsx`, all six `TabsContent` panels.
7. **A Radix tab strip's `handleTabChange` MUST navigate with `replace: true`.** `TabsList` defaults to `activationMode='automatic'`, so arrow-key travel across the strip selects each tab it passes; without `replace` that pushes one history entry per keypress and the browser Back button no longer leaves the page. This does not apply to the hand-rolled `role='tab'` Buttons in `FinancesOverviewPage.tsx`, which only change tabs on click. Reference: `routes/(authenticated)/teams/$teamId/settings.tsx`.

## Loader-Refetching Search Param Via `validateSearch` + `loaderDeps`

When a UI control changes **what the route loader fetches from the server** (not just what the already-loaded data renders), the control's state MUST live in a search param that is wired through `loaderDeps` into the `loader`, so toggling it re-runs the loader against the API. This is distinct from the "URL-Synced Tabs Via `validateSearch`" section above, which syncs a **client-only** selection and never touches the loader. Use this pattern only when the param feeds a fresh API call.

Reference implementations: `applications/web/src/routes/(authenticated)/teams/$teamId/events.index.tsx` (`all` → `listEvents` `query.all`) and `applications/web/src/routes/(authenticated)/teams/$teamId/workout.weekly.tsx` (`includeTeam` → `getWeeklySummary` `query.includeTeam`). Both pair with the server-side scope-gating convention in `applications/server/AGENTS.md` ("Permission-Gated Data-Scope Flags Are Re-Checked Server-Side").

```typescript
const EventsSearchSchema = Schema.Struct({
  all: Schema.optional(Schema.Boolean),
});

export const Route = createFileRoute('/(authenticated)/teams/$teamId/events/')({
  ssr: false,
  validateSearch: Schema.toStandardSchemaV1(EventsSearchSchema),
  loaderDeps: ({ search }) => ({ all: search.all }),
  loader: async ({ params, context, deps }) =>
    /* ...api.event.listEvents({ params, query: { all: deps.all ? Option.some(true) : Option.none() } })... */,
});
```

Rules:

1. **Define the search schema with `Schema.Struct` + `Schema.toStandardSchemaV1`** and `Schema.optional(Schema.Boolean)` for an optional boolean toggle. Do NOT hand-write a type-guard `validateSearch` here (that form is for the client-only tab pattern) — the loader needs the decoded value, so a Schema is the source of truth.
2. **`loaderDeps` MUST select exactly the params the loader reads** (`({ search }) => ({ all: search.all })`). A param that is only consumed by the component (not the loader) MUST NOT appear in `loaderDeps` — listing it there triggers needless loader refetches.
3. **Map the search value to the API `Option` query field inside the loader** using the domain `Schema.OptionFromOptional(BooleanFromString)` contract: `deps.all ? Option.some(true) : Option.none()`. Never send `Option.some(false)` for the "off" state — omit the param (`Option.none()`) so the wire request carries no key, matching the server default (see the Query-String Boolean Helper section in `packages/domain/AGENTS.md`).
4. **Write the param via `navigate({ search: (prev) => ({ ...prev, all: v ? true : undefined }) })`** — set the falsy/default value to `undefined` (not `false`) so it drops out of the URL, keeping the canonical URL clean and matching rule 3's omit-when-off contract.
5. **Surface the in-flight refetch with `useRouterState({ select: (s) => s.status === 'pending' })`** and dim the affected region (`opacity-60 pointer-events-none transition-opacity` + `aria-busy`). The toggle stays interactive during the refetch; only the data region shows the pending state. Reference: `EventsListPage` (`isPending`).
6. **Gate the control's visibility on the server-supplied capability flag** from the loader response (e.g. `canViewAll`), never on a locally-inferred role. The server owns whether the scope expansion is allowed (see the server-side rule); the web only renders the control when the flag is `true`.

## Forms — React Hook Form + Effect Schema

**Always use Shadcn Form (`components/ui/form`) with React Hook Form and Effect Schema** for any form that collects user input. The single exception is a page whose cards each own an independent save state — see "Pages With Several Independent Save Buttons — `useCardForm`" below; nothing else may opt out. (Those save states need not each render their own inline Save button: on `TeamSettingsPage` they are collected into one shared `SaveBar`.)

```typescript
import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { Effect, Option, Schema } from 'effect';
import { useForm } from 'react-hook-form';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '../ui/form';
import { ApiClient, ClientError, useRun } from '../../lib/runtime';

const MyFormSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  age: Schema.NumberFromString,
  role: Schema.Literal('admin', 'member'),
  jerseyNumber: Schema.NumberFromString.pipe(Schema.optionalWith({ as: 'Option' })),
});
type MyFormValues = Schema.Schema.Type<typeof MyFormSchema>;

function MyForm({ onSuccess }: { onSuccess: () => void }) {
  const run = useRun();
  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(MyFormSchema)),
    mode: 'onChange',
    defaultValues: { name: '' },
  });

  const onSubmit = async (values: MyFormValues) => {
    const result = await ApiClient.pipe(
      Effect.flatMap((api) => api.something.create({ payload: values })),
      Effect.catchAll(() => ClientError.make('Failed to save')),
      run,
    );
    if (Option.isSome(result)) onSuccess();
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className='flex flex-col gap-4'>
        <FormField
          {...form.register('name')}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          {...form.register('role')}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Role</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger className='w-full'><SelectValue /></SelectTrigger>
                </FormControl>
                <SelectContent>...</SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type='submit' disabled={form.formState.isSubmitting}>Submit</Button>
      </form>
    </Form>
  );
}
```

### Form Key Rules

- Use `standardSchemaResolver(Schema.toStandardSchemaV1(MySchema))` from `@hookform/resolvers/standard-schema` — **not** zod, not yup, and **not** `effectTsResolver` from `@hookform/resolvers/effect-ts`. All 22 `resolver:` call sites in `applications/web/src` use `standardSchemaResolver`; `@hookform/resolvers/effect-ts` has **zero** usages in this repo. (This bullet previously mandated `effectTsResolver` and was wrong.)
- Always wrap the schema in `Schema.toStandardSchemaV1(...)` — `standardSchemaResolver` takes a Standard Schema v1 value, not a raw Effect `Schema`
- Use transforming schemas (`NumberFromString`, `optionalWith({ as: 'Option' })`, `NonEmptyString`)
- `type FormValues = Schema.Schema.Type<typeof MySchema>` is the decoded/transformed type
- Do **not** pass explicit generics to `useForm<MyFormValues>(...)` — let `standardSchemaResolver` infer
- Spread `{...form.register('fieldName')}` on `<FormField>` — do **not** use `control={form.control} name='fieldName'`
- Use `form.formState.isSubmitting` for loading state — no manual `submitting` state
- For `<Select>`, use `onValueChange={field.onChange}` and `value={field.value}` — do **not** spread `{...field}` directly
- For `<SearchableSelect>` in forms, wrap with `<FormControl>` directly:
  ```typescript
  <FormField
    {...form.register('groupId')}
    render={({ field }) => (
      <FormItem>
        <FormLabel>{m.group_groupName()}</FormLabel>
        <FormControl>
          <SearchableSelect
            value={field.value}
            onValueChange={field.onChange}
            placeholder={m.group_selectGroup()}
            options={groups.map((g) => ({ value: g.groupId, label: g.name }))}
          />
        </FormControl>
        <FormMessage />
      </FormItem>
    )}
  />
  ```

### Forms That Outlive a `router.invalidate()` — `values:` and the `resetOptions` Merge Trap

TanStack Router renders page components **without a `key`**, so `router.invalidate()` refetches loader data and re-renders the page with new props but never remounts it. `useForm`'s `defaultValues` are read once at mount, so after any invalidate they still hold the pre-refetch data.

**A form on a page that can be re-rendered by `router.invalidate()` while the form is open MUST use `values:`, never `defaultValues:`.** RHF deep-compares `values` on every render (`if (props.values && !deepEqual(props.values, _values.current)) control._reset(...)`) and only touches its internal defaults when they actually changed. Pair it with `resetOptions: { keepDirtyValues: true }` so a background refetch does not overwrite fields the user is currently editing. Build the object with `React.useMemo` keyed on the loader data and keep it in a variable — the discard handler resets to it explicitly. Reference: `components/pages/EventDetailPage.tsx` (`formValues` + `useForm`), whose own RSVP submit and three organism `onRefresh` callbacks each fire an invalidate.

**Every explicit `form.reset()` on a form that declares `resetOptions` MUST pass the inverse flags explicitly.** RHF's public `reset` merges the form-level options into every call — `reset = (formValues, keepStateOptions) => _reset(..., { ..._options.resetOptions, ...keepStateOptions })` (verified in `react-hook-form@7.86.0`). A bare `form.reset()` on a form declared with `resetOptions: { keepDirtyValues: true }` therefore **keeps** the dirty values, so a "Discard changes" button preserves the exact edits it exists to throw away and they reappear when the user reopens the form. It type-checks, it throws nothing, and the only symptom is the wrong values on screen.

```typescript
// ✓ Good — the override is REQUIRED, not redundant
const handleDiscard = React.useCallback(() => {
  form.reset(formValues, { keepDirtyValues: false });
  setEditing(false);
}, [form, formValues]);

// ✗ Bad — inherits `keepDirtyValues: true` from the form; Discard discards nothing
form.reset();
```

### Dirty-State UX for Edit Forms

An **edit** form (pre-filled from existing data, distinct from a create form) MUST surface dirty state from React Hook Form's `formState` rather than tracking a manual `changed` boolean. This gates the submit button, shows per-field "changed" markers, and resets the baseline on a confirmed save so the form returns to a clean state in place (no navigation away). Reference: `applications/web/src/components/pages/PlayerDetailPage.tsx` (member edit card + `DirtyFieldLabel`).

```typescript
const dirtyFieldCount = Object.keys(form.formState.dirtyFields).length;
const hasErrors = Object.keys(form.formState.errors).length > 0;

const handleSubmit = React.useCallback(
  async (values: PlayerEditValues) => {
    const submittedValues = form.getValues();
    const succeeded = await onSave(values); // onSave returns Promise<boolean>
    if (succeeded) form.reset(submittedValues); // re-baseline so the form is clean again
  },
  [onSave, form],
);

<Button type='submit' disabled={!form.formState.isDirty || hasErrors || form.formState.isSubmitting}>
  {form.formState.isSubmitting ? tr('members_saving') : tr('members_saveChanges')}
</Button>
```

Rules:

1. **Gate the submit button on `!form.formState.isDirty || hasErrors || form.formState.isSubmitting`.** A pristine, error-free, or in-flight edit form has a disabled Save button. Do not track a separate `submitting`/`changed` state — `formState` is the single source of truth.
2. **The page's `onSave` prop returns `Promise<boolean>` (`true` = persisted), and the form re-baselines only on `true` via `form.reset(form.getValues())`.** Capture the submitted values with `form.getValues()` BEFORE awaiting, then `form.reset(submittedValues)` after success so the dirty diff is recomputed against what was actually saved. Never navigate away on save — the cleaned form stays in place. The route-level handler returns `true` after a successful mutation and calls `router.invalidate()`; it returns `false` on failure (see `members.$memberId.tsx`).
3. **Mark each changed field at its label**, not just globally, via a small `DirtyFieldLabel({ label, dirty })` helper reading `Boolean(form.formState.dirtyFields.<field>)`. Render the visual dot with `aria-hidden='true'` and pair it with an `<span className='sr-only'>{tr('form_fieldChanged')}</span>` so the change is announced to screen readers.
4. **Show the dirty-field count + a Cancel (reset) control only while `form.formState.isDirty`.** Cancel is a `type='button'` that calls `form.reset()` (no args — reverts to the original `defaultValues`). If the form declares `resetOptions`, call `form.reset(values, { keepDirtyValues: false })` instead — see "Forms That Outlive a `router.invalidate()`" above for why the no-arg form silently keeps the edits. The count uses an ICU-pluralized key (`tr('members_unsavedChanges', { count: dirtyFieldCount })`).

### Pages With Several Independent Save Buttons — `useCardForm`

A settings page is not one form. `TeamSettingsPage` renders **ten cards
behind seven independent save states**, each posting its own payload — and
three of those seven PATCH the *same* endpoint (`updateTeamInfo`) over
disjoint field slices. React Hook Form assumes one form per submit, so these
cards use `components/organisms/team-settings/useCardForm.ts` instead — the
**only** sanctioned exception to the React Hook Form rule above, and it
applies solely to a page whose cards each have their own save state. (The
seven save states no longer render seven inline Save buttons — see
"`SaveBar` / `useSaveBarEntry`" below for how they surface today.)

The invariant it exists to enforce: **the dirty flag and the request payload
must be derived from the same object.** They used to be hand-written lists
that agreed only by discipline, and the page shipped two bugs because of it:

- The rules-quiz fields were compared in `hasWelcomeChanges` while
  `handleSaveSettings` was the handler that sent them. Editing them left the
  settings card's button **disabled** and lit up the *welcome* card's button,
  whose payload had no rules-quiz fields in it — so it succeeded, toasted
  "saved", and discarded the edit. Nothing in the type system objects.
- Seven bare `return`s guarded out-of-range fields in one save handler, so any
  single bad field made Save do nothing at all — no toast, no request, no clue.
  Clearing a number input to retype it (`''` → `NaN`) stopped the page saving
  *anything*.

Rules:

1. **One `SomethingFormValues` type per save state (one payload)**, holding
   primitive-typed fields only — `string | number | boolean`, string literal
   unions included (`ChannelSyncEvent.ChannelCleanupMode`,
   `Onboarding.OnboardingLocale`) — never an object, array or `Option`, because
   the dirty check is a shallow `!==` over `Object.keys(baseline)`
   (`isFormDirty`). Declare it as a `type`, not an `interface` — an interface
   has no implicit index signature and will not satisfy `useCardForm`'s
   `T extends Record<string, string | number | boolean>` constraint. Convert to
   the API's shapes at the form/payload boundary with the `shared.ts` helpers
   (`selectValue` in, `channelToOption` / `groupIdToOption` out), and use the
   `NONE_VALUE` sentinel — never `''` — for a `SearchableSelect`'s "nothing
   selected".
2. **Pure functions in a `*Form.ts` module beside the cards, one module per
   endpoint** (`settingsForm.ts` for `updateTeamSettings`, `teamInfoForm.ts`
   for all three `updateTeamInfo` cards): `xFormFrom(savedDto)` (saved values →
   form), `xRequestFrom(values)` (form → DTO), and — only when the form has a
   field that can be invalid — `findInvalidXField(values)`, returning the
   *translation key* of the first bad field or `undefined`.
   `welcomeRequestFrom` and `onboardingRequestFrom` have no validator because
   neither card has a rejectable field. Keeping them pure is what makes the
   invariant testable without rendering.
3. **Never bail out of a save silently.** When a `findInvalidXField` exists,
   the handler toasts `tr('teamSettings_fieldInvalid', { field: tr(invalidField) })`
   and returns — the key comes back untranslated so the toast reuses the
   field's own label. A blank numeric input must be invalid, not `0` —
   `Number('')` is `0`, so a cleared field otherwise saves a silent zero.
4. **Cards that only render fields take `CardForm` and own no dirty flag or
   handler.** `GeneralLimitsCard`, `RemindersCard`, `CoachAssignmentCard` and
   `DiscordDefaultsCard` take `form: CardForm<SettingsFormValues>` and read and
   write it; the one shared save state lives in `useTeamSettingsForm.ts` and is
   registered by `TeamSettingsPage` itself (via `useSaveBarEntry`) — not by any
   of the four cards. A presentational card physically cannot wire a field to
   a save action that does not send it. `useSaveBarEntry`'s `disabled` prop is
   for an extra reason the card cannot be saved at all (`OnboardingCard`
   passes `!isCommunityEnabled`) and never for dirty state.
5. **When several cards PATCH the same endpoint, spread a shared
   all-`Option.none()` constant** (`untouchedTeamInfo`) and name only the keys
   that card owns. A field added to the DTO then defaults to untouched
   everywhere instead of needing to be added to every handler's "don't touch"
   list.
6. **Test the invariant, not the source text.** `settingsForm.test.ts` holds a
   `BASE` and an `EDITED` object both typed `SettingsFormValues` — so a new
   field with no test value is a compile error — and asserts for every key of
   `BASE` that editing it both flips `isFormDirty` and changes the JSON of
   `settingsRequestFrom`. `teamInfoForm.test.ts` asserts each builder touches
   exactly its own keys and that the three slices together cover every key of
   `untouchedTeamInfo` exactly once. This replaces the deleted source-text
   guard `TeamSettingsPage.dirty.test.ts`.
7. **Reloading loader data stays the page's job.** These cards are organisms,
   so they hold no TanStack Router hooks: each takes an `onRefresh: () => void`
   and the page supplies a `router.invalidate()` callback. Call `onRefresh()`
   only when the save succeeded (`Option.isSome(result)`); the fresh props then
   recompute `useCardForm`'s baseline and the form goes clean with no reset
   call.

8. **`useCardForm` seeds its state ONCE, so a card must never mount against placeholder data.** The hook calls `useState(baseline)` and does not re-seed when the prop changes — that is deliberate (rule 7 relies on fresh props recomputing the baseline only because the component remounts or the values are already equal). It means a card rendered with fabricated defaults while its real data is missing keeps those defaults after a successful retry: the form reads dirty against a baseline that was never the member's, and Save is armed to overwrite their real settings. When a card's data can fail to load independently of the page, render a **separate component** for the failure state — never a branch inside the card, and never a `?? defaultValues` fallback on the prop. Reference: `components/organisms/EventPreferencesCard.tsx` exports `EventPreferencesCard` (prop `prefs: MemberEventPreferences`, non-nullable) and `EventPreferencesLoadFailed` (holds no form state, renders an alert plus a Retry button calling the same `onRefresh`); `MyProfilePage`'s `EventPreferencesSection` picks between them per team, so React remounts the card on the transition and it is always seeded from real data.
9. **`useCardForm` is generic despite living in `components/organisms/team-settings/`.** Import it in place — `import { useCardForm } from './team-settings/useCardForm'` — from any card on any page that needs the several-independent-Save-states pattern. Do NOT copy it, do NOT re-home it, and do NOT fork a second implementation because the consumer is not a team-settings card. First consumer outside that folder: `components/organisms/EventPreferencesCard.tsx`. Rules 1-8 apply in full to such a card; rule 2's separate `*Form.ts` module is required only when several cards share one endpoint or a field can be invalid — a card with one endpoint and only boolean/literal fields may keep its `valuesFrom<Dto>` converter inline. `EventPreferencesCard` keeps `SaveRow` (`components/organisms/team-settings/SaveRow.tsx`) for its own inline Save button — that component is unrelated to `SaveBar`/`useSaveBarEntry` below and is not used by any card in `team-settings/` anymore.

Six cards in that directory own a `useCardForm` plus one save-bar entry each
(`TeamProfileCard`, `WelcomeMessageCard`, `OnboardingCard`,
`EmailForwardingCard`, `FioBankCard`, `GenerationWeightsCard`); the seventh
save state is `useTeamSettingsForm.ts`, which is a hook, not a card, and the
remaining four cards are the rule-4 presentational ones. All seven follow
this pattern. One carries a documented exception rather than a deviation:
**`EmailForwardingCard`** keeps `monitoredAddresses` and `imapSecret` outside the form type, because neither survives a shallow compare: the first is an array (a new reference every render), and the second is write-only and three-state — whether a typed value counts as a change depends on `imapSecretSet` and `replacingSecret`, not on inequality, since the stored secret is never sent to the browser. The card ORs both into `hasChanges` explicitly, and that (not `form.isDirty`) is what it passes as `useSaveBarEntry`'s `dirty`. It and `FioBankCard` both extract their post-save local-state reset into one function and call it from both the save-success path and `onDiscard`, so the two can never drift apart the way a hand-mirrored reset list did twice in this directory.

Prefer **per-field errors over a single toast** where a card has more than one rejectable input. `settingsForm.ts` returns the first bad field's key because its four cards share one save state and one toast; `emailForwardingForm.ts` and `generationWeightsForm.ts` return a key *per field* so each renders under its own input with `aria-invalid` and `aria-describedby`. A disabled Save button with no message is the same defect as a dead click — `GenerationWeightsCard` greyed out its button on an out-of-range number and displayed nothing until this was fixed. Those per-field messages stay the card's job — `useSaveBarEntry`'s `disabledReason` is for a **card-level** block whose explanation is not visible from the bar (`OnboardingCard`'s "community features are off" is the only one today); `GenerationWeightsCard`, `EmailForwardingCard` and `FioBankCard` pass `disabled` without a reason because theirs is either a per-field error inside the card or a transient in-flight retry.

### `SaveBar` / `useSaveBarEntry` — One Shared Save Bar For Several `useCardForm`s

`components/organisms/team-settings/SaveBar.tsx` replaces per-card inline Save
buttons with one sticky bar at the bottom of the page, rendering one row per
currently-dirty card. A card registers itself with `useSaveBarEntry({ id,
label, tab, dirty, saving, disabled?, disabledReason?, onSave, onDiscard })`;
`onSave` returns `Promise<boolean>` (`false` = the card's own validation
rejected the save), and `SaveBar` calls the page's `onInvalid(tab)` prop on
`false` so a validation failure on a hidden tab still becomes visible.

Rules:

1. **The registering `useEffect`'s dependency array holds ONLY primitives
   plus the two stable wrapper callbacks** (`register, id, label, tab, dirty,
   saving, disabled, disabledReason, stableOnSave, stableOnDiscard`). Putting
   the entry object — or the raw `onSave`/`onDiscard` props — in that array
   causes a setState-per-render loop, because a fresh object/closure is a new
   reference every render. The hook works around needing fresh closures by
   holding `{ onSave, onDiscard }` in a `ref` reassigned on every render, and
   registering a pair of wrapper callbacks built once with `useCallback(...,
   [])` — a stable identity Biome's `useExhaustiveDependencies` is happy to
   see in the deps array, unlike the raw props.
2. **A card registers `null` when `!dirty`, and every `id` MUST appear in
   `ENTRY_ORDER`.** `SaveBarProvider` stores entries in a `Map` keyed by `id`
   and renders them in that fixed module-level order, never insertion order —
   effects run child-first, so a page-level shared entry would otherwise
   always register last, and any dirty/saving flip would reorder rows under
   the user's cursor. An `id` missing from `ENTRY_ORDER` gets `indexOf === -1`
   and silently sorts above every other row; adding a card means adding its
   `id` to that array in the same edit.
3. **The bar's `<section>` is `role=region` (via `aria-label`), never
   `role='status'`, and it is always mounted** (empty when nothing is dirty).
   A live region inserted at the same moment its content appears announces
   unreliably, so it must exist before it has anything to say. `OnboardingCard`
   already renders `<output aria-live='polite'>` on this page — `<output>`'s
   implicit ARIA role IS `status`, so a second `status` region makes
   `getByRole('status')` ambiguous, which is exactly what broke two specs in
   `e2e/tests/onboarding-settings.spec.ts` during development. (`FioBankCard`
   carries the same warning in a code comment for the same reason.)
4. **The bar is `sticky bottom-0`, never `fixed`, and is the last in-flow
   child of the page root** (it follows `</Tabs>`; the `UnsavedChangesGuard`
   rendered after it is a portal and does not count).
   `SidebarInset` is a flow sibling of the fixed sidebar, so
   a `sticky` child is automatically inset by the sidebar's width in both the
   expanded and collapsed states with zero extra classes — a `fixed
   bottom-0 left-0 right-0` bar (the pattern in `ChannelManagementPage.tsx`)
   overlaps the desktop sidebar instead.
5. **A component that renders `SaveBarProvider` must not itself call
   `useSaveBarEntry`.** The default context is a no-op registry, so a
   `useSaveBarEntry` call with no provider above it — including one in the
   same component that renders the provider — registers nothing, throws
   nothing and logs nothing: the row simply never appears. Split the page in
   two like `TeamSettingsPage` (provider shell) / `TeamSettingsPageBody`
   (everything that consumes the registry, including `useSaveBarEntries`).
6. **`onDiscard` MUST restore the `useCardForm` baseline AND every
   card-local `useState` the payload reads, through the same function the
   save-success path calls.** A discard that resets only `form` leaves the
   card clean-looking while an out-of-form value (`monitoredAddresses`,
   `imapSecret`, `fioToken`, `tokenCreatedAt`) still holds the abandoned
   edit, and the next save sends it. Reference: `EmailForwardingCard`'s
   `resetLocalState` and `FioBankCard`'s `resetFormFields`, each called from
   both places.

## Submitting Branded Values to API Endpoints

API request payloads frequently contain branded types defined in `@sideline/domain` (e.g. `Fee.AmountMinor`, `Fee.CurrencyCode`, `Team.TeamId`, `FeeAssignment.FeeAssignmentId`). When a form computes a plain `number` or `string` and must pass it as a branded field, **never** use `as unknown as Fee.AmountMinor` (or any `as unknown as` double-cast). Always decode through the branded schema:

```typescript
import { Fee } from '@sideline/domain';
import { Schema } from 'effect';

// Correct: decode at the boundary so an invalid value throws synchronously.
const brandedAmount = Schema.decodeSync(Fee.AmountMinor)(amountMinor);
const brandedCurrency = Schema.decodeSync(Fee.CurrencyCode)(currencyString);

// Wrong — bypasses every brand invariant and hides bugs.
const brandedAmount = amountMinor as unknown as Fee.AmountMinor;
```

Reference: `applications/web/src/components/organisms/FeeFormDialog.tsx` (`brandedAmount`, `brandedCurrency`), `applications/web/src/components/organisms/RecordPaymentDialog.tsx` (`Schema.decodeSync(Fee.AmountMinor)(...)`).

Rules:

1. **Never write `as unknown as <BrandedType>` in web code.** The double-cast bypasses both TypeScript's brand enforcement and the schema's runtime check. The ESLint/Biome config does not currently forbid it — discipline is enforced by code review.
2. **Use `Schema.decodeSync(<BrandedSchema>)(value)` for synchronous form submit handlers.** The cost is one decode per submit, which is negligible; the benefit is that invalid amounts/currencies throw locally instead of producing a 400 from the server with no actionable error.
3. **For values that are already validated by the form schema** (e.g. a `Team.TeamId` extracted from a typed route param), prefer a `const x: Team.TeamId = value` annotation over a cast — if the value is already typed as the brand at the source, no decode is needed.
4. **`.make()` is the right tool only for compile-time-known literals** (e.g. enum values from a `Schema.Literals([...])` union). Do not use it on user input.

### `Schema.Class` Payload Fields Must Be Real Instances

`Schema.Class` is **nominal**, not structural: a plain object matching every field of the class still fails to encode. The server has the same rule for RPC/HTTP handler return values (`applications/server/AGENTS.md`, "An RPC Handler Must Map Rows Into The Domain Class — `Schema.Class` Is Nominal") — it is not server-scoped, and it has now shipped a production bug on this side too. `AssistantConversation` passed plain `{ role, content }` objects for `AiChatApi.ChatRequest`'s `messages` field and the assistant could not send a single message.

```typescript
// Correct — a real instance.
new AiChatApi.ChatMessage({ role, content })

// Wrong — structurally identical, fails with `Expected AiChatMessage`.
{ role, content }
```

Rules:

1. **Every value the client constructs for a `Schema.Class`-typed field MUST be built with `new <Class>({ ... })`.** This applies to request payloads above all, and to `Schema.Union` members whose variants are classes. Never hand a structurally-identical plain object to a schema-typed field.
2. **The failure mode is why this is expensive, not the fix.** The encode throws **client-side, before the request is sent** — so there is no HTTP request, no server log line, and no network entry to inspect. Whatever generic error handler is in scope swallows it and the user sees a generic failure. From the outside it is indistinguishable from a broken backend, and diagnosing it costs disproportionately more than the one-line fix.
3. **A mocked API client means the real encode never runs.** `pnpm check` passes, every component test passes, and the feature cannot work at all — that is exactly how this shipped. A green suite is not evidence here.
4. **Wherever a payload is constructed, there MUST be a test that encodes it through the real schema, and that test MUST pin that a plain object fails.** `applications/web/src/lib/assistant/chatMessages.test.ts` is the worked example: it encodes `toChatMessages(...)` through `AiChatApi.ChatRequest` and asserts a bare `[{ role, content }]` is **rejected**. Without that negative case, deleting the mapping makes the test pass again.
5. **Build the payload in a named helper in `src/lib/<feature>/`, not inline in the component** (`toChatMessages` in `src/lib/assistant/chatMessages.ts`). Inline construction is what the mocked component test cannot reach; a helper is directly testable against the real schema.

## Auth Store — `lib/auth.ts`

Wraps browser `localStorage` via `@effect/platform-browser` `BrowserKeyValueStore`. All auth functions return Effects with `never` error and `never` requirements.

```typescript
import { KeyValueStore } from '@effect/platform';
import { BrowserKeyValueStore } from '@effect/platform-browser';

const kvLayer = BrowserKeyValueStore.layerLocalStorage;

const get = (key: string) =>
  KeyValueStore.KeyValueStore.pipe(
    Effect.flatMap((store) => store.get(key)),
    Effect.provide(kvLayer),
    Effect.catchAll(() => Effect.succeed(Option.none<string>())),
  );

export const getLastTeamId = get(LAST_TEAM);
export const setLastTeamId = (teamId: string) => set(LAST_TEAM, teamId);
```

**In React callbacks / `useEffect`**: use `Effect.runSync(...)` (localStorage is synchronous).
**In `beforeLoad` / `loader`**: pipe auth effects directly into the Effect chain.

### User Display Names — Read `displayName`, Never Re-Derive

Any API response carrying a user identity exposes a fully-resolved `displayName: string` (computed server-side via `DisplayName.pickDisplayName` — see `applications/server/AGENTS.md`). The web reads `displayName` directly.

```typescript
const displayName = user.displayName;        // correct
const displayName = Option.getOrElse(user.name, () => user.username); // WRONG — re-derives
```

Rules:

1. **Never re-implement the name fallback in the web.** `Option.getOrElse(x.name, () => x.username)` is forbidden — it skips the Discord nickname and global display name that the server already accounts for, producing a name that disagrees with the bot and the rest of the UI.
2. **`displayName` is always a plain non-`Option` `string`** — render it directly; derive initials/avatars from it (`user.displayName.split(' ')...`), not from `user.name`.
3. Reference: `NavUser.tsx`, `PlayerRow.tsx`. Applies to `Auth.CurrentUser`, roster players, RSVP attendees, group members, leaderboard rows.

### User-Scoped `localStorage` Keys for Per-User UX State

When storing per-user UX state in `localStorage` (e.g. "has the user seen the new X badge yet?", "preferred view mode", "dismissed tip"), the key MUST include the authenticated user's id. Shared-device scenarios (one browser, multiple Sideline accounts) would otherwise leak one user's "seen" flag onto another user's session.

Reference: `FinancesOverviewPage.tsx` — `` const overviewTabSeenKey = (userId: string) => `sideline:finances-overview-tab-seen:${userId}`; ``

Rules:

1. **Key format: `'sideline:<feature>-<state>:${userId}'`.** Always start with `sideline:` (prevents collision with embedded apps), then a kebab-case state identifier, then the user id segment. Never use a bare `'sideline:finances-overview-tab-seen'` constant — that key is global per device.
2. **Build the key via a small helper function** (`const myKey = (userId: string) => '...';`) at the top of the component module so the format is defined once. Do not inline string concatenation at each `getItem`/`setItem` call site.
3. **Wrap every `localStorage.getItem` / `localStorage.setItem` call in `try { ... } catch { ... }`.** Private-mode Safari and storage-quota-exceeded scenarios throw synchronously; the catch block must default to the "already seen" / no-op path so the UI never crashes.
4. **The page component accepts `userId?: string` as an OPTIONAL prop** so tests can mount it without a user. When `userId` is omitted, behave as if the state is already "seen" (badge not shown) — this is the safe default that does not flash UI for test scenarios.
5. **Do NOT migrate or back-fill old un-scoped keys.** A user encountering the new scoped key with no value sees the "new" badge once, then it persists. Renaming is acceptable; the worst case is one extra badge impression per user.

## `beforeLoad` Effect Pipe Pattern

`beforeLoad` should be a single `Effect.Do` pipe ending with `context.run` — **not** an `async` function with `Effect.runSync` calls:

```typescript
class SkipError extends Data.TaggedError('SkipError') {}

beforeLoad: ({ search, context }) =>
  Effect.Do.pipe(
    Effect.tap(
      Option.match(Option.fromNullable(search.token), {
        onSome: finishLogin,
        onNone: () => Effect.void,
      }),
    ),
    Effect.flatMap(() => getLastTeamId),
    Effect.flatMap(
      Option.match({
        onSome: (teamId) => Redirect.make({ to: '/teams/$teamId', params: { teamId } }),
        onNone: () => Effect.void,
      }),
    ),
    Effect.catchTag('SkipError', () => Effect.void),
    context.run,
  ),
```

**Key conventions:**
- `SkipError` — custom tagged error for "stop processing, no redirect needed"
- `Redirect.make({...})` — accepts type-safe `RedirectOptions` directly
- `Option.match({ onSome: ..., onNone: ... })` — branch on `Option` values
- No `async`/`await` or `Effect.runSync` — the entire `beforeLoad` is one `Effect.Do` pipe

## Loader: Parallel Fetch With Per-Arm Graceful Degradation

When a route `loader` must fetch multiple resources in parallel and one of them is **non-critical** (the page must still render if it fails — e.g. a banner that only appears for some users), wrap that single arm in `Effect.tapError(...) → Effect.catch(() => Effect.succeed(<fallback>))` **inside** the `Effect.all`. The other arms must NOT be wrapped — their failure must propagate to `warnAndCatchAll` so the route shows a real error.

```typescript
loader: async ({ params, context }) => {
  const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
  const [dashboard, myStatus] = await ApiClient.asEffect().pipe(
    Effect.flatMap((api) =>
      Effect.all([
        // Critical: failure breaks the page (handled by warnAndCatchAll below)
        api.dashboard.getDashboard({ params: { teamId } }),
        // Non-critical: failure degrades to an empty banner, page still renders
        api.finance.myStatus({ params: { teamId } }).pipe(
          Effect.tapError((e) => Effect.logWarning('Failed to load my finance status', e)),
          Effect.catch(() => Effect.succeed([] as ReadonlyArray<FinanceApi.MyFinanceStatus>)),
        ),
      ]),
    ),
    warnAndCatchAll,
    context.run,
  );
  return { dashboard, myStatus };
},
```

Rules:

1. **Only wrap the non-critical arm.** Wrapping every arm with `catch(() => ...)` silently hides every failure and produces a page that looks blank with no toast. Reserve graceful degradation for arms whose absence is a known acceptable UX.
2. **`Effect.tapError` MUST log before `Effect.catch` swallows.** Never `Effect.catch(() => Effect.succeed(...))` without an upstream log — the failure must be visible in SigNoz.
3. **The fallback must match the arm's `Success` type exactly,** including readonly-ness and currying. The `as ReadonlyArray<...>` cast above is required because `Effect.succeed([])` infers `never[]`.
4. **Return a named object, not a tuple, from the loader** (`return { dashboard, myStatus }`). The route component destructures by name; tuples break when a third arm is added later.
5. **When the loader fans out over N instances of the SAME non-critical resource, EVERY arm is wrapped** — the "other arms must not be wrapped" rule above governs a fixed `Effect.all` of *different* resources. Map the array to `Effect.all(items.map(...))` where each arm is `Effect.tapError(logWarning) → Effect.catch(() => Effect.succeed([id, null]))`, then `Object.fromEntries` the result into a `Record<string, T | null>` keyed by the item id, so a per-item failure degrades exactly one card. Reference: `routes/(authenticated)/(no-team)/profile/index.tsx` fetches `getMyEventPreferences` once per Discord-connected team. A `null` entry is the FAILURE signal, not a neutral default — the consumer must render a dedicated failure component for it (see "Pages With Several Independent Save Buttons — `useCardForm`" rule 8), so never substitute defaults for `null` at the page boundary.

Reference: `applications/web/src/routes/(authenticated)/teams/$teamId/index.tsx` (dashboard + `myStatus`).

## Runtime Singleton & Browser Telemetry

The web app runs every Effect through ONE module-level `ManagedRuntime` singleton held in `lib/runtime.ts`. The singleton carries the OpenTelemetry browser layer, the API client, and `ClientConfig`. OTEL config flows in one direction only:

```
fetchEnv (server function, src/env.ts)
  → initRuntime({ serverUrl, telemetryLayer })   (root beforeLoad)
    → ManagedRuntime singleton (makeAppLayer)
      → runPromiseServer / runPromiseClient / ServerRunner / runEffect
```

### `initRuntime` — Call Once In Root `beforeLoad`

`initRuntime({ serverUrl, telemetryLayer })` (`lib/runtime.ts`) builds the singleton via `ManagedRuntime.make(makeAppLayer(...))`. It is **idempotent** — the second and later calls return immediately (`if (_runtime !== null) return;`). It registers a one-shot `pagehide` listener that disposes the runtime.

Rules:

1. **`initRuntime` MUST be called from the root route `beforeLoad` (`src/routes/__root.tsx`), after `await fetchEnv(abortController)`, before any `runPromiseServer` / `runPromiseClient` call.** Every other runner (`runPromiseServer`, `runPromiseClient`, `ServerRunner`, `runEffect`) routes through the private `getRuntime()`, which **throws** `Error('Runtime not initialized — call initRuntime() first')` if the singleton is null. Never call a runner before `initRuntime`.
2. **The telemetry layer MUST be produced by `makeTelemetryLayer(...)` from `~/lib/telemetry`,** passing the four OTEL env values read from `fetchEnv`: `endpoint: OTEL_EXPORTER_OTLP_ENDPOINT`, `serviceName: OTEL_SERVICE_NAME`, `environment: APP_ENV`, `origin: APP_ORIGIN`. Never construct an `Otlp` layer inline in the route.
3. **All four OTEL env vars are optional** (`Schema.UndefinedOr(Schema.NonEmptyString)` in `src/env.ts`, `emptyStringAsUndefined: true`). When `endpoint` is `undefined`, `makeTelemetryLayer` returns `Layer.empty` — telemetry is silently disabled, the app still runs. Adding a new OTEL env var requires adding it to BOTH `src/env.ts` (`fetchEnv`) and the `makeTelemetryLayer({...})` call in `__root.tsx`.
4. **`makeAppLayer` MUST expose `ClientConfig` twice:** once provided as a dependency to `ApiClientLive`, and once merged into the runtime's output so effects that declare `ApiClient | ClientConfig` resolve it. The exact shape is load-bearing:
   ```typescript
   const clientConfigLayer = Layer.succeed(ClientConfig, { baseUrl: options.serverUrl });
   return Layer.mergeAll(
     ApiClientLive.pipe(Layer.provide(clientConfigLayer)),
     clientConfigLayer,
     Logger.layer([Logger.consolePretty()]),
     Layer.succeed(References.MinimumLogLevel, 'Info' as const),
     options.telemetryLayer,
   );
   ```
   Dropping the standalone `clientConfigLayer` from `Layer.mergeAll` makes the runtime's success type `ManagedRuntime<ApiClient, never>` and breaks every `ApiClient | ClientConfig` effect at the type level.

### The Telemetry Objection Gate — `lib/telemetryOptOut.ts`

Telemetry runs on **legitimate interest** (GDPR Art. 6(1)(f)), which the privacy policy states in §3. It is **not** consent: there is no banner, nothing to opt *in* to, and no consent record. What Art. 21 and §6 of the policy require is a way to **object**, and `lib/telemetryOptOut.ts` is it. Do not turn this into a consent gate without changing §3 of the policy in both `legal/privacy.md` and `cs/legal/privacy.md` first — the code and the published legal basis have to agree.

`isTelemetryAllowed()` is the single gate. Precedence, strongest first: a browser privacy signal (`navigator.globalPrivacyControl`, then Do Not Track) → the stored per-browser preference (`sideline-telemetry-opt-out`) → allowed, which is what legitimate interest permits.

Rules:

1. **Every path that transmits must consult the gate.** There are six, and they do not share a chokepoint: `makeTelemetryLayer` (returns `Layer.empty` when objected, so nothing leaves), `recordReactRender`, `registerWebVitals`, `registerErrorHandlers`, `beaconCrash` (`lib/crashBeacon.ts`), and the inline ES5 IIFE in `lib/preMountGuard.ts`. **Adding a seventh means adding a gate** — grep for `isTelemetryAllowed` before you add any browser-side send.
2. **Gate at send time, not only at registration time.** The Web Vitals and error listeners attach once at boot, so a registration-only check keeps sending for the rest of the session after someone switches telemetry off. `telemetry.ts` wraps the runner in `gated(runEffect)` for exactly this, which is what makes the switch take effect with no reload. Use `gated(...)`, never the raw `runEffect`, inside a listener.
3. **`beaconCrash` and the pre-mount IIFE need their own checks.** Neither goes through the Effect runtime, so gating the OTLP layer does not cover them — and both fire precisely when the app has crashed or has not booted, which is when an objection is easiest to leak.
4. **`telemetryOptOut.ts` must stay self-contained and non-throwing**, in the shape of `resolveStoredTheme.ts`: no imports from the app runtime, every `localStorage` and `navigator` access wrapped. `beaconCrash` calls it from a crashed page and must not be able to add a second failure to the first.
5. **The inline guard duplicates the precedence in ES5** because it runs before any module loads. It interpolates `TELEMETRY_OPT_OUT_STORAGE_KEY` from the module so the key cannot drift, and `preMountGuard.test.ts` asserts that. If you change the precedence, change it in both places — an objection honoured everywhere except the boot-failure path is worse than none, because it is invisible.
6. **No backticks or `${` in comments inside `PRE_MOUNT_GUARD_SOURCE`.** It is a template literal; a backtick in a comment terminates it and the parse error is reported against the *test* file, not the string.
7. **Unreadable `localStorage` means allowed, not objected.** A private window or blocked site data holds no objection we can see; that is not the same as one having been made.
8. **`isTelemetryAllowed()` returns `true` off the browser** (SSR, tests). The objection governs what a user's *device* transmits, not the web server's own instrumentation.
9. **The UI reads the value in an effect, never during render** (`TelemetryPreferenceCard`). It depends on `localStorage` and `navigator`, so rendering it directly hydrates mismatched against the server markup.

### `runEffect` — Fire-And-Forget From Non-Effect Callbacks

`runEffect(effect: Effect.Effect<void>): void` (`lib/runtime.ts`) does `void getRuntime().runFork(effect)`. Use it ONLY to record metrics/spans from plain (non-Effect) callbacks — Web Vitals, the React `<Profiler>` `onRender` hook. Never use it for API calls, navigation, or anything whose result the UI depends on — those go through `useRun()` / `runPromiseClient` / `runPromiseServer`.

### Web Vitals & React Render Metrics — `lib/telemetry.ts`

`lib/telemetry.ts` owns all browser metric definitions (`Metric.histogram(...)` for `web_vitals_lcp_ms`, `web_vitals_cls`, `web_vitals_fcp_ms`, `web_vitals_inp_ms`, `web_vitals_ttfb_ms`, `page_load_ms`, `react_render_ms`). Two registration helpers consume `runEffect`:

| Helper | Call site | Behaviour |
|--------|-----------|-----------|
| `registerWebVitals(runEffect)` | `__root.tsx` `beforeLoad`, immediately after `initRuntime` | Lazy-imports `web-vitals` and wires `onLCP`/`onCLS`/`onFCP`/`onINP`/`onTTFB` + a `load`-event page-load reporter. Idempotent via an internal `_vitalsRegistered` flag; no-ops on the server (`typeof window === 'undefined'`). |
| `recordReactRender(runEffect, actualDuration)` | `<Profiler id='app' onRender={...}>` wrapping `<Outlet />` in `RootComponent` | Records the React tree render duration into `react_render_ms`. |

Rules:

1. **`registerWebVitals` MUST be called exactly once, after `initRuntime`, in the root `beforeLoad`.** It is safe to call on every navigation (the `_vitalsRegistered` guard), but the canonical call site is the root `beforeLoad` right after `initRuntime(...)`.
2. **All new browser metrics live in `lib/telemetry.ts`,** defined with `Metric.histogram(name, { description, boundaries })`. Never define a `Metric` inline in a component or route.
3. **Metrics are recorded only via `runEffect(Metric.update(<metric>, value))`** — never `Effect.runSync`/`Effect.runPromise` on a metric update, and never a raw `getRuntime()` call from outside `lib/runtime.ts`.
4. **The `<Profiler>` wrapper lives in `RootComponent` (the root `component`), not the shell.** It wraps `<Outlet />` inside `RunProvider` + `TranslationOverridesProvider`. Do not move it into `RootDocumentRoute` — the shell renders above the context provider (see "Root Route: `shellComponent` vs `component`").
5. **`web-vitals` is lazy-imported** (`void import('web-vitals').then(...)`) so it stays out of the initial bundle. Keep it lazy — do not add a top-level `import` of `web-vitals`.

## Runtime — Client vs Server Runners

`lib/runtime.ts` exposes two distinct run functions:

| Function | Used in | Error channel | Returns | Side-effects |
|---|---|---|---|---|
| `runPromiseServer(url)(abortController?)` | `beforeLoad`, `loader` | `Redirect \| NotFound` | `Promise<A>` (throws on error) | None |
| `runPromiseClient(url)` | Root loader → `RunProvider` | `ClientError` | `Promise<Option<A>>` | Auto `toast.error` on failure |
| `runEffect(effect)` | Web Vitals, `<Profiler onRender>` only | `never` (effect is `Effect<void>`) | `void` (fire-and-forget `runFork`) | None |

All three functions route through the private `getRuntime()` singleton (see "Runtime Singleton & Browser Telemetry" above). The `url` argument to `runPromiseServer`/`runPromiseClient` is retained for signature stability but the runtime's `baseUrl` comes from the `ClientConfig` provided at `initRuntime` time. Calling any runner before `initRuntime` throws.

**`Run` type** (what `useRun()` returns):
```typescript
type RunOptions = { readonly success?: string; readonly loading?: string };

type Run = (
  options?: RunOptions,
) => <A>(
  effect: Effect.Effect<A, ClientError | SilentClientError, ApiClient | ClientConfig>,
) => Promise<Option.Option<A>>;
```

`Run` is curried: call it with optional `RunOptions` first, then pass the Effect. When `success` is provided, a success toast is shown automatically. When `loading` is provided, a loading toast is shown until the Effect completes.

**Wiring**: The root `beforeLoad` calls `initRuntime(...)` then `registerWebVitals(runEffect)` (see "Runtime Singleton & Browser Telemetry" above). `RootComponent` (the root route `component`, NOT the shell) creates `runPromiseClient(serverUrl)`, provides it via `RunProvider`, and wraps `<Outlet />` in a `<Profiler id='app' onRender={...recordReactRender(runEffect, ...)}>`. All organisms access the runner via `useRun()`. See "Root Route: `shellComponent` vs `component`" below for why this must not live in the shell.

### Server Runners: AbortController Wiring And Exit Handling

`runPromiseServer` / `ServerRunner` bind a `beforeLoad`/`loader` Effect to the router's `AbortController` so a superseded navigation interrupts the in-flight run. Both runners MUST execute via `Effect.runPromiseExit(effect, { signal: controller.signal })` and route the resulting `Exit` through the shared `resolveServerExit(exit, aborted)` helper (`lib/runtime.ts`). Never recreate this wiring inline in a route file.

```typescript
const exit = await Effect.runPromiseExit(effectResponse, {
  signal: abortController?.signal,
});
return resolveServerExit(exit, abortController?.signal.aborted ?? false);
```

Rules:

1. **Pass `{ signal: controller.signal }`, never the `AbortController` itself, as the second argument to `Effect.runPromiseExit`.** Effect expects a `{ signal }` options object; passing the bare controller (e.g. `Effect.runPromise(effect, abortController)`) type-checks but silently never wires abort, so superseded navigations keep running and can clobber the new page.
2. **An interrupted or superseded run MUST NOT settle the promise.** `resolveServerExit` returns a never-settling `new Promise<never>(() => {})` when `aborted` is `true` or `Cause.hasInterruptsOnly(exit.cause)` holds. The new navigation owns the outcome; settling here would surface a bogus error or unhandled rejection. Do not add a timeout to "rescue" such a run — see the comment in `routes/__root.tsx`.
3. **A genuine defect MUST throw a real `Error`.** For a non-interrupt failure `exit`, `resolveServerExit` does `Cause.squash` and throws the squashed value when it is an `Error`, otherwise `new Error('Unexpected runtime defect: ...')`. A bare `undefined` must never escape to the router.
4. **Typed `Redirect` / `NotFound` are not failures here.** Server runners wrap the Effect in `Effect.result`, so those land in the `Success` exit as `Result.fail(...)`; `resolveServerExit` re-throws them via `r.redirect()` / `notFound()`. The `Failure` exit branch is therefore interrupt/defect only.
5. **`resolveServerExit` has a co-located contract test** (`lib/runtime.test.ts`) covering success, redirect/notFound re-throw, never-settle on interrupt/abort, and the no-bare-`undefined` defect guard. Update it whenever the helper's branching changes.

### Pattern A: Organism builds and runs its own Effect (default)

The organism calls `useRun()`, builds the Effect pipeline internally, and runs it. This is the standard pattern for organisms that own their API logic.

```typescript
const run = useRun();
await ApiClient.pipe(
  Effect.flatMap((api) => api.someEndpoint(...)),
  Effect.catchTag('SomeError', () => ClientError.make('Error message')),
  run({ success: m.some_success_message() }),
);
```

### Pattern B: Parent passes an Effect pipeline as a prop (Effect-as-prop)

The parent (page) builds the Effect pipeline and passes it as a prop. The child (organism) calls `useRun()` to execute it. Use this pattern when:
- The parent owns the API context (route params, router invalidation) but the child owns the UI state (loading indicators, form fields)
- Multiple UI interactions in the child trigger variations of the same Effect (e.g., different arguments)

```typescript
// Parent (page) — builds the Effect, does NOT run it
const handleRsvpSubmit = React.useCallback(
  (response: EventRsvp.RsvpResponse, message: string) =>
    ApiClient.pipe(
      Effect.flatMap((api) => api.eventRsvp.submitRsvp({ path: {...}, payload: {...} })),
      Effect.catchAll(() => ClientError.make(m.rsvp_submitFailed())),
      Effect.tap(() => Effect.sync(() => router.invalidate())),
    ),
  [teamIdBranded, eventIdBranded, router],
);

// Child (organism) — receives the Effect builder, runs it via useRun()
interface MyPanelProps {
  onSubmit: (arg: string) => Effect.Effect<void, ClientError, ApiClient | ClientConfig>;
}

function MyPanel({ onSubmit }: MyPanelProps) {
  const run = useRun();
  const handleClick = async (value: string) => {
    await run({ success: m.some_message() })(onSubmit(value));
  };
  // ...
}
```

**Key rules for Effect-as-prop:**
- The prop type must be `(...args) => Effect.Effect<void, ClientError, ApiClient | ClientConfig>` — never `Effect.Effect` directly (the child needs to supply arguments).
- The child organism must call `useRun()` and execute the Effect — the parent must never run it.
- The parent must never import or depend on `useRun()` for this Effect — it only builds the pipeline.
- Use `React.useCallback` in the parent to memoize the Effect builder.

### Pattern C: Per-Row Lazy Fetch With `useQuery` + `useRun`

When a component (typically a row in a collapsible list) fetches data **on demand** (after the user expands the row) and the data is small enough that caching per-row is desirable, combine TanStack Query's `useQuery` with `useRun()` so the request still flows through the app's Effect runtime, gets the standard auth headers, and produces a typed `ClientError` on failure.

```typescript
import { useQuery } from '@tanstack/react-query';
import { Effect, Option, Schema } from 'effect';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

function MyPaymentHistoryRow({ teamId, feeId, currency }: Props) {
  const run = useRun();
  const decodedTeamId = Schema.decodeSync(Team.TeamId)(teamId);
  const decodedFeeId = Schema.decodeSync(Fee.FeeId)(feeId);

  const { data, isLoading, isError } = useQuery<ReadonlyArray<PaymentView>>({
    queryKey: ['myPaymentHistory', teamId, feeId],
    queryFn: async () => {
      const effect = ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.finance.myPaymentHistory({
            params: { teamId: decodedTeamId },
            query: { feeId: Option.some(decodedFeeId) },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('my_payments_history_error'))),
      );
      const result = await run()(effect);
      return Option.getOrThrow(result);
    },
    retry: false,
    throwOnError: false,
  });

  if (isLoading) return <div>{tr('my_payments_history_loading')}</div>;
  if (isError) return <div className='text-destructive'>{tr('my_payments_history_error')}</div>;
  // ... render data ...
}
```

Rules:

1. **Use `useQuery` only for per-row / on-demand data,** not for the page's primary payload. Primary payload always lives in the route loader (see "Loader" section above).
2. **`queryKey` must include every parameter that changes the request** (`teamId`, `feeId` in the example). Two rows with different `feeId` must have different keys so React Query caches them independently.
3. **`queryFn` builds the Effect, runs it via `run()()`, and unwraps the `Option`.** Call the curried `run()` with no `RunOptions` (no toast — TanStack Query owns the loading/error UI). `Option.getOrThrow(result)` converts `None` (the auto-toasted failure path) into a thrown error that drives `isError = true`.
4. **`Effect.mapError(() => ClientError.make(tr('...')))`** is required so the error has a localized user-facing message; `Effect.catchAll` would mask the failure entirely and `useQuery` would never enter `isError`.
5. **Always set `retry: false` and `throwOnError: false`.** Auto-retry produces flashing UI for on-demand fetches; `throwOnError: true` would crash the row instead of rendering the error state.
6. **Decode branded route params with `Schema.decodeSync(<Brand>)(value)` at the top of the component,** not inside `queryFn` — the cost is paid once per render, and any invalid value throws synchronously instead of on first interaction. Follow the same rule as "Submitting Branded Values to API Endpoints" above.

Reference: `applications/web/src/components/organisms/MyPaymentHistoryRow.tsx` + `.test.tsx`.

## Internationalization (i18n)

### Supported Locales

- **English (`en`)** — source language (base locale)
- **Czech (`cs`)**

### Framework: Paraglide JS v2

Paraglide compiles translations into typed `m.key()` functions at build time. Missing keys fail the build.

- **Vite plugin**: `paraglideVitePlugin` in `vite.config.ts`
- **Project config**: `project.inlang/settings.json`
- **Generated code**: `src/paraglide/` (auto-generated, gitignored)

### Translation Files

JSON files at `messages/{locale}.json`. Key format: `snake_case` with `_` separating hierarchy levels.

Parameterized strings use `{variable}` syntax: `"auth_signedInAs": "Signed in as {username}"`.

### Calling Translations From Web Code — `tr()` Only

In `applications/web/src/**`, **never** import from `@sideline/i18n/messages` directly. Always call `tr()` from `~/lib/translations.js`:

```typescript
import { tr } from '~/lib/translations.js';

<p>{tr('auth_signedInAs', { username: user.name })}</p>
```

Rules:

1. **The Biome rule `style/noRestrictedImports` enforces this** (`biome.json`): importing `@sideline/i18n/messages` from web fails lint. The override allows the path for `applications/bot/**`, `packages/i18n/**`, and `scripts/**` only — never extend the allow-list to web. The `applications/web/**` override re-declares the rule with **both** banned paths (`@sideline/i18n/messages` and `@sideline/rules/content`) because Biome `overrides` replace the base rule instead of merging with it — dropping either path from that override silently unbans it for the whole web app. Add any new web-only banned import to that same override entry.
2. **`tr(key, params?, options?)` returns a `string`.** It applies admin overrides on top of compiled Paraglide messages: it first checks the in-memory overrides map (kept in sync by `TranslationOverridesProvider`), and falls back to `messagesByKey[key]` from `@sideline/i18n/registry` if no override is set. An unknown key is logged via `console.warn` and the raw key is returned — never throw out of `tr()`.
3. **Overrides are refreshed by `TranslationOverridesProvider`** (`src/lib/translation-overrides-context.tsx`), which polls `GET /api/translations` every 30s via React Query (`refetchIntervalInBackground: false`) and calls `setTranslationOverrides(...)` on every successful fetch. The provider is mounted once in the root layout; do not mount it elsewhere.
4. **Use the `useTranslationOverrides()` hook only when a component must re-render explicitly on override changes** (e.g. the admin Translations page itself, where the version counter drives a refetch). `tr()` reads the current overrides snapshot synchronously and is sufficient for normal render paths.
5. **Adding a new translation key**: add it to `messages/en.json` AND `messages/cs.json` in `@sideline/i18n`, run `pnpm codegen` and `pnpm build` so `messagesByKey` picks it up, then call `tr('my_new_key', { param: value })`. Do not call `m.my_new_key(...)` from web code.
6. **Before adding a scoped key (e.g. `my_payments_kpi_*`, `<feature>_kpi_*`), grep for an existing key with the same English string** in `packages/i18n/messages/en.json`. If a generic key exists (e.g. `finance_kpi_outstanding = "Outstanding"`, `finance_kpi_overdue = "Overdue"`) and your component needs the same string, **reuse the generic key** — do not create `my_payments_kpi_outstanding` as a duplicate. The check is `grep -i '"<english string>"' packages/i18n/messages/en.json`. Reference: `MyPaymentsPage` reuses `finance_kpi_outstanding` and `finance_kpi_overdue` instead of minting `my_payments_kpi_outstanding` / `_overdue`.

### Closed-Union Copy Comes From An Explicit `Record`, Never A Computed Key

When a wire value is a **closed union of string literals** (`AiChatApi.DegradedReason`, `EntityRef['kind']`, an event status), resolve its copy through an explicit `Record<Union, () => string>` of literal `tr('…')` calls — the `src/lib/event-labels.ts:13` idiom. Never build the key: `` tr(`assistant_degraded_${reason}`) `` is banned.

```typescript
// ✗ Bad — invisible to lib/staticTrKeys.test.ts, prints the raw key on a miss
export const label = (reason: DegradedReason) => tr(`assistant_degraded_${reason}`);

// ✓ Good — every key is a literal the guard test can resolve
export const degradedReasonLabels: Record<DegradedReason, () => string> = {
  not_configured: () => tr('assistant_degraded_notConfigured'),
  disabled: () => tr('assistant_degraded_disabled'),
  provider_error: () => tr('assistant_degraded_providerError'),
  too_many_steps: () => tr('assistant_degraded_tooManySteps'),
  empty_answer: () => tr('assistant_degraded_emptyAnswer'),
};
```

Rules:

1. **`tr()` never throws on an unknown key** — it `console.warn`s and returns the raw key string, so a computed key that misses ships `assistant_degraded_not_configured` to the user's screen and passes CI.
2. **`src/lib/staticTrKeys.test.ts` only sees literal first arguments.** A computed key is skipped by construction, so the guard cannot catch the miss. An explicit `Record` puts every key back under the guard.
3. **The wire literals and the key names are allowed to differ** — the wire union is `snake_case` (`not_configured`) while the i18n keys are `camelCase` (`assistant_degraded_notConfigured`). A template literal would therefore miss **every** branch, not just one. Reference: `src/lib/assistant/entityRoutes.ts`.
4. **Declare the map as `Record<Union, () => string>`**, not `Partial<Record<…>>` — adding a literal to the domain union must then fail the web build until the copy exists.
5. **The same rule governs the non-copy maps keyed off that union** — icon, colour, shape. `src/lib/finance/matchReasons.ts` renders the nine `BankTransaction.BankTransactionMatchReason` literals through three parallel closed `Record`s (`matchReasonLabels`, `matchReasonIcons`, `matchReasonDashed`), all keyed off the **imported domain union**, never a locally re-declared copy. A tenth literal added to the engine then fails the web build three times instead of shipping a raw key and a missing icon to the treasurer's screen. This is why the union lives in `packages/domain` rather than being mirrored here: a local mirror makes every `Record` exhaustive against the wrong list.
6. **The `Record`s are the only sites the compiler protects. Every hand-rolled `===`/`||` gate and every `switch` with a `default` arm accepts a new literal silently — grep for them by hand.** When a closed wire union gains a member, the exhaustive `Record`s fail the build as designed; the three shapes below compile unchanged and render **nothing** for the new literal. `BankSyncConfig.BankSyncStatusCode` gaining `'account_mismatch'` broke the build in `src/lib/finance/bankTestStatus.ts` (`TEST_RESULT_META`) and `src/components/molecules/FioStatusBadge.tsx` (`STATUS_META`) — and in none of these:

   | Site | Shape | What the new literal did there, with no compile error |
   |------|-------|------------------------------------------------------|
   | `src/components/pages/BankTransactionsPage.tsx:77` | `config?.status === 'invalid' \|\| config?.status === 'sync_failing'` | Fell out of the alert gate, so the one page a treasurer actually opens showed **no banner at all** while imports were halted — the silent halt simply moved one route over. Fixed by hand (`accountMismatch` added to the gate and to the variant/title ternaries). |
   | `src/components/organisms/bank/FioStatusBlock.tsx:90` + `:201` | `switch (config.status)` with `default: statusAlert = null` | The `default` arm turned what would be an exhaustiveness error into a silent no-render. Fixed by hand (explicit `case 'account_mismatch'`). |
   | `src/components/organisms/team-settings/FioBankCard.tsx:73` | `config === null \|\| config.status === 'not_connected' \|\| config.status === 'invalid'` (the `helpOpen` initial state) | Still excluded, deliberately — the card's own `FioStatusBlock` alert carries the instruction, so the help panel stays collapsed. This is what "decide each hit explicitly" looks like when the answer is "leave it out". |

   Adding a literal to a closed wire union is therefore a **grep step, not a build step**. Run both greps below, seeded with literals the union already has, and decide each hit explicitly — add the new literal to the gate, or leave it out and record the omission (a one-line comment on the gate, or a row in the table above):

   ```bash
   # every hand-rolled gate on that union (seed with two EXISTING literals, not the new one)
   grep -rn "'not_connected'\|'sync_failing'" applications/web/src
   # every switch over the field, then read each one's default arm
   grep -rn "switch (.*\.status)" applications/web/src
   ```

   Prefer an explicit `case` per literal (`FioStatusBlock` now has one for all six ranks that reach the `switch`; `not_connected` returns earlier, so its `default: statusAlert = null` is unreachable and exists only to satisfy definite assignment). A `default:`/`else` arm that actually swallows literals is acceptable only when a comment on that arm names them. Either way the `default` is why the compiler will never flag the NEXT added literal — hence the grep.

### Locale Persistence

- **Authenticated users**: `locale` column on `users` table. Updated via `PATCH /auth/me/locale`.
- **Unauthenticated users**: Strategy chain — localStorage (manual choice) → cookie → browser `navigator.languages` detection → English fallback.
- **Root route** (`__root.tsx`): On load, if user is authenticated, calls `setLocale(user.locale)`.

### Locale Runtime API

```typescript
import { getLocale, setLocale } from '../paraglide/runtime.js';
getLocale();      // 'en' | 'cs'
setLocale('cs');
```

### Date Formatting

**`Intl` API** — use `useFormatDate` hook for general date display:

```typescript
const { formatDate, formatTime, formatDateTime, formatRelative } = useFormatDate();
```

**`date-fns`** — when calling `format()` from `date-fns` (e.g. in calendar components, date pickers), always pass the locale option via `useDateFnsLocale()`:

```typescript
import { useDateFnsLocale } from '~/hooks/useDateFnsLocale';
import { format } from 'date-fns';

const dateFnsLocale = useDateFnsLocale();
format(someDate, 'MMMM yyyy', { locale: dateFnsLocale });
```

The locale mapping lives in `src/lib/date-locale.ts` (`getDateFnsLocale()`). When adding a new Paraglide locale, add a corresponding entry to the `localeMap` in that file.

**Never call `date-fns` `format()` without `{ locale: dateFnsLocale }`** — it defaults to the browser locale, ignoring the user's app language setting.

### Language Switcher

`LanguageSwitcher` organism uses `LocaleSelect` molecule (Shadcn Select wrapper). Accepts `isAuthenticated` prop — when `true`, persists to server.

## Admin Page Layouts: Single-Page-With-Dialog vs List+Detail Routes

When building captain-/admin-facing CRUD for a small entity, pick exactly one of these two layouts. Do not mix them.

| Layout | When to use | Reference implementation |
|--------|-------------|--------------------------|
| **Single-page-with-dialog** | Entity has ≤4 user-editable fields, no nested resources, no per-row sub-pages. Create and edit share the same form. | `ActivityTypesPage` (`components/pages/ActivityTypesPage.tsx` at `/teams/:teamId/activity-types`), `AchievementsAdminPage` |
| **List + detail routes** | Entity has >4 fields, nested resources (e.g. role → role members), or per-row tabs/sub-pages. | Roles (`roles.index.tsx` + `roles.$roleId.tsx`), Rosters, Groups, Events |

### Single-Page-With-Dialog Rules

1. **One route file, one page component.** All CRUD lives in `/teams/:teamId/<resource>` — no `.$id.tsx` sibling. Route file is flat (not `.index.tsx`) since there are no sub-routes.
2. **Inline `<Dialog>` for create AND edit.** A single `<ResourceFormDialog>` component handles both: `editing?: ResourceInfo` prop is `undefined` for create, `Some` for edit. The form `defaultValues` and the submit handler branch on `isEditing = editing !== undefined`.
3. **Page owns dialog open state.** Use three React state slots: `createOpen: boolean`, `editTarget: ResourceInfo | null`, optional `cannotDeleteTarget: ResourceInfo | null` for referential-integrity blocked deletes. Reset with `setEditTarget(null)` / `setCreateOpen(false)`.
4. **Reset form on `open` change.** Inside the dialog component, `React.useEffect(() => { if (open) form.reset({...defaults}) }, [open, editing, form])` — re-opening with a different `editing` row must re-seed the form.
5. **Render every dialog always-mounted, driven by `open`.** Never conditionally mount the dialog (`{editTarget !== null && <Dialog/>}`). See "Dialogs Must Be Always-Mounted, Driven By `open`" below — the page passes `open={editTarget !== null}` and feeds the dialog its data from a freeze-ref.
6. **Render built-in/protected rows read-only.** Mark rows with `Option.isSome(row.slug)` (or equivalent "built-in" flag) and disable Edit/Delete `<Button>`s on them with `title={m.<resource>_protected()}`. The 422 `Protected` HTTP error is the server-side defence; the disabled button is the UX-side prevention.
7. **Handle 409 `HasLogs` (or equivalent referential-integrity error) with a dedicated `CannotDeleteDialog`.** After the `Effect.mapError` branch detects the tag, stash the offending row + count in state and render a second dialog offering "Rename instead" — never just toast the error.
8. **`router.invalidate()` after every successful mutation.** The page reads via the route loader; mutations must not optimistically update local state.

## Dialogs Must Be Always-Mounted, Driven By `open`

Every dialog/sheet/modal (Shadcn `Dialog`, `Sheet`, `AlertDialog` — anything backed by a Radix overlay) MUST be rendered unconditionally and have its visibility controlled by the `open` prop. NEVER conditionally mount it with `{state !== null && <Dialog open={true} .../>}` and force-unmount it on close. Force-unmounting a Radix dialog while it is open orphans its overlay, leaving a stuck dark backdrop that blocks all clicks until a full page reload.

```typescript
// WRONG — force-unmount on close orphans the Radix overlay (stuck dark backdrop)
{editTarget !== null && (
  <ResourceFormDialog open={true} editing={editTarget} onClose={() => setEditTarget(null)} />
)}

// CORRECT — always mounted, visibility driven by `open`, data frozen via a ref
const editTargetRef = React.useRef<ResourceInfo | null>(null);
if (editTarget !== null) editTargetRef.current = editTarget;

<ResourceFormDialog
  open={editTarget !== null}
  editing={editTarget ?? editTargetRef.current ?? undefined}
  onClose={() => setEditTarget(null)}
/>
```

Rules:

1. **Always pass `open={<state> !== null}` (or a boolean state slot), never `open={true}` inside a conditional mount.** The dialog component stays mounted across open/close; only `open` flips. Reference: `ActivityTypesPage.tsx`, `AchievementsAdminPage.tsx`, `AdminOnboardingTokensPage.tsx` (all migrated from conditional-mount to always-mounted).
2. **Freeze the last-known data in a `useRef` so content does not blank during the close animation.** When the dialog renders data from a nullable state slot (`editTarget`, `mintedUrl`), the slot is set to `null` on close while Radix is still animating the exit. Hold the last non-null value: `const ref = useRef<T | null>(null); if (state !== null) ref.current = state;` then pass `state ?? ref.current ?? undefined` (or `mintedUrl ?? ''` for a required string prop). Without the freeze, the dialog flashes empty for the duration of the close animation.
3. **Add a reset-on-open `useEffect` when local state was previously seeded only at mount.** A conditionally-mounted dialog got fresh `useState`/`form` defaults every time it mounted; an always-mounted dialog does not re-mount, so re-opening with a different row would show stale state. Re-seed inside `React.useEffect(() => { if (open) { form.reset({...}); /* reset other local state */ } }, [open, editing, form])`. Reference: `EditBuiltInSheet` and `CustomAchievementDialog` in `AchievementsAdminPage.tsx`.
4. **Clear any debounce/timeout `useRef` in the same `open` effect's `else`/cleanup branch.** Because the component no longer unmounts on close, a pending `setTimeout` would otherwise survive across closes. Reference: `MintedLinkDialog` (`timerRef`) in `AdminOnboardingTokensPage.tsx`, `EditBuiltInSheet` (`debounceRef`).

## Confirm Before Destructive Actions — `AlertDialog`

Any immediate, irreversible-from-the-UI destructive action (unassign a role, remove a member, delete a row that has no second confirmation step elsewhere) MUST be confirmed through Shadcn `AlertDialog` (`components/ui/alert-dialog`) — never fire the mutation directly from a plain button's `onClick`, and never use the native `window.confirm(...)`. The trigger that performs the destruction is `<AlertDialogAction>`; the escape hatch is `<AlertDialogCancel>`. Wrap the trigger and dialog in a small self-contained control component so the list/row stays declarative. Reference: `RemoveRoleControl` in `applications/web/src/components/pages/PlayerDetailPage.tsx`.

```typescript
function RemoveRoleControl({ roleName, onConfirm }: { roleName: string; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type='button' variant='ghost' size='icon' className='text-muted-foreground hover:text-destructive'>
          <X className='size-3' aria-hidden='true' />
          <span className='sr-only'>{tr('roles_removeAria', { role: roleName })}</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tr('roles_removeRoleConfirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{tr('roles_removeRoleConfirmDescription', { role: roleName })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tr('roles_removeRoleCancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{tr('roles_removeRoleConfirm')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

Rules:

1. **The mutation runs from `<AlertDialogAction onClick={onConfirm}>`, never from the trigger.** The trigger only opens the dialog. `<AlertDialogCancel>` closes it with no side effect. Do not call the destructive `onConfirm`/API handler on the trigger button.
2. **Pass the destructive action in as an `onConfirm: () => void` prop** so the control stays decoupled from how the parent runs the Effect (the parent builds and runs the mutation via `useRun()` / Effect-as-prop — see "Runtime — Client vs Server Runners"). The confirm control itself owns no API logic.
3. **Every icon-only trigger needs an accessible label** via `<span className='sr-only'>{tr('<feature>_removeAria', { ... })}</span>` next to an `aria-hidden='true'` icon. An `<X>` glyph with no label is unusable with a screen reader.
4. **Title, description, cancel, and confirm labels are all i18n keys** added to BOTH `packages/i18n/messages/en.json` and `cs.json` (i18n lockstep). The description names the specific entity being removed (`{ role: roleName }`), never a generic "Are you sure?".
5. **`AlertDialog` is a Radix overlay** — when its open state is parent-controlled rather than self-contained (this example is self-contained, so no `open` prop is needed), it falls under "Dialogs Must Be Always-Mounted, Driven By `open`" above.

## Shared Utility Modules (`src/lib/`)

Reusable label maps and option builders live in `src/lib/`. Always import from these files instead of duplicating inline.

| Module | Exports | Used by |
|--------|---------|---------|
| `src/lib/event-labels.ts` | `eventTypeLabels`, `dayShortLabels`, `dayFullLabels`, `DAY_ORDER`, `sortDays` | Event pages, calendar view, training type pages |
| `src/lib/group-options.ts` | `toGroupOptions`, `toGroupOptionLabel` | Any page with a group `SearchableSelect` |
| `src/lib/event-colors.ts` | `getEventColor`, color map utilities | Calendar view |
| `src/lib/datetime.ts` | `formatLocalDate`, `formatLocalTime`, `formatUtcTime`, `localToUtc`, `formatEventDateRange` (canonical for event start/end rendering) | Event/training forms, EventDetailPage, EventsListPage, EventCalendarView |
| `src/lib/discord.ts` | `DISCORD_CHANNEL_TYPE_TEXT`, `DISCORD_CHANNEL_TYPE_CATEGORY` | Any page with Discord channel selects |
| `src/lib/clipboard.ts` | `copyToClipboard(text): Promise<boolean>` | Any "copy to clipboard" button (invite links, minted onboarding URLs, calendar subscription URLs) |
| `src/lib/finance/` | `formatMoney`, `parseAmount`, `sortAssignments`, `computeKpis`, `pickDominantCurrency` | Finance pages, payment dialogs, "My Payments" page, dashboard banner, balance dashboard |
| `src/lib/rules/palette.ts` | `LEVEL_ACCENT`, `RULES_ACCENT`, `VERDICT` | Every `Rules*` organism, `TeamRulesPage` — see "Rules Trainer Colours" below |
| `src/lib/roles/` | `resolveEffectiveRoles` (`resolveEffectiveRoles.ts`), `sortEffectiveRoles` (`role-order.ts`) | `RoleBadge`, `EffectiveRolesList`, `PlayerDetailPage`, `PlayerRow`, `MemberSummaryHeader` — see "Effective Roles In The UI — `src/lib/roles/`" below |
| `src/lib/assistant/` | `parseAnswer` (`parseAnswer.ts`), `buildHistory` (`history.ts`), `ENTITY_ROUTE`/`entityKindLabels`/`degradedReasonLabels` (`entityRoutes.ts`) | `AssistantPage`, `AssistantConversation`, `AssistantAnswer`, `AssistantResultCard` — see "AI Assistant Client Rules — `src/lib/assistant/`" below |

### Rules Trainer Colours — `palette.ts` Only

The Rules Trainer is the one feature in this app with its own colour system, because it has nine
sibling packages that must be told apart at a glance and a right/wrong verdict that must survive
dark mode. All of it lives in `src/lib/rules/palette.ts`; never hand-write a colour class in a
`Rules*` component.

1. **Every class string in `palette.ts` must be a complete literal.** Tailwind scans source text, so
   an interpolated `bg-${hue}-500` emits no CSS at all. That is why the file is a written-out
   record of nine accents rather than a hue name plus template strings. Same convention as
   `LeaderboardPage.tsx`'s medal badges.
2. **Do not build per-package identity on the `--chart-1…5` theme tokens.** They swap hue between
   light and dark (`--chart-1` is orange in light, blue in dark), so a package would change colour
   on a theme toggle.
3. **`VERDICT` deliberately does not use `--success` / `--destructive`.** In dark mode `--success`
   is `oklch(0.35 0.1 150)` — a near-black green — and an answered step's correct option is a
   `disabled` button, so the shared `disabled:opacity-50` made the most important thing on screen
   the least legible. `VERDICT.correctOption` / `.wrongOption` therefore carry
   `disabled:opacity-100`; untouched options stay faded, which is the point. Keep using the theme
   tokens everywhere else in the app.
4. **`RULES_ACCENT.cta` is the only sanctioned override of the app's monochrome `primary`,** and
   only for the two buttons that drive the flow forward (start a run, replay/next). "Select all",
   "clear", the cheat sheet and the exam entry point stay on the shared variants.

### Clipboard Copies — `copyToClipboard` Only

Every "copy to clipboard" action MUST go through `copyToClipboard(text)` from `~/lib/clipboard`. Never call `navigator.clipboard.writeText(...)` directly — the bare call throws an unhandled rejection on permission denial and crashes in insecure contexts (no `navigator.clipboard`). `copyToClipboard` guards both cases and resolves to a `boolean`.

```typescript
import { copyToClipboard } from '~/lib/clipboard';

const handleCopy = () => {
  copyToClipboard(url).then((ok) => {
    if (!ok) return; // copy failed (insecure context / denied) — no "copied" hint
    setCopied(true);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  });
};
```

Rules:

1. **The success side-effect (the "Copied!" hint) is keyed off the resolved boolean.** Show the confirmation only when `ok === true`; on `false` show nothing — never assume the write succeeded.
2. **Hold the "copied" reset timeout in a `useRef` and clear it on dialog close / unmount,** following the always-mounted-dialog rules above. Reference: `MintedLinkDialog` in `AdminOnboardingTokensPage.tsx`.

### Currency-Picker Helpers: `pickDominantCurrency` vs `pickMostFrequentCurrency`

Two distinct helpers exist for collapsing a multi-currency dataset to a single display currency. They are NOT interchangeable — pick by what the user is interpreting:

| Helper | Location | Metric | Use when |
|--------|----------|--------|----------|
| `pickDominantCurrency` | `src/lib/finance/pickDominantCurrency.ts` | Highest `incomeMinor + expensesMinor` (by **transaction volume**) | Aggregating money totals — KPI cards that show "Income" / "Expenses" / "Net". A team with 10 CZK rows of 100 each and 1 EUR row of 100,000 should display EUR. Reference: `BalanceDashboard.tsx`. |
| `pickMostFrequentCurrency` | inline in `FinancesOverviewPage.tsx` | Highest **row count** | Aggregating per-member status — KPI cards showing "members overdue" / "members paid", where row count is the meaningful denominator. Reference: `FinancesOverviewPage.tsx` `ByMemberContent`. |

Rules:

1. **`pickDominantCurrency` is exported from `src/lib/finance/`** and has a co-located unit test (`pickDominantCurrency.test.ts`). It returns `null` on empty input; callers must `?? summaries[0].currency` or render an empty state.
2. **`pickMostFrequentCurrency` stays inline in `FinancesOverviewPage.tsx`** — do NOT promote it to `src/lib/finance/`. It is a one-call helper tightly coupled to `MemberOverviewRow`; extracting it would require a mirror type and add no reuse.
3. **Never substitute one for the other to "simplify".** A volume-based pick on row-count data underweights small-currency rows; a count-based pick on volume data treats a 1,000,000 EUR transaction the same as a 100 CZK transaction. The semantics are intentionally distinct.
4. **When adding a third "pick by X" helper**, place it next to `pickDominantCurrency` if it consumes a domain shape used by multiple pages; keep it inline if it is a single-page derived metric. The threshold for promotion is "two or more pages consume it" — see "Pure Helpers in `src/lib/<feature>/`" above.

### Pure Helpers in `src/lib/<feature>/`

When a component needs non-trivial derived data (sorting, KPI computation, parsing), extract the logic into a **pure helper module** under `src/lib/<feature>/` with a co-located `<name>.test.ts`. Reference: `src/lib/finance/sortAssignments.ts` + `sortAssignments.test.ts`, `src/lib/finance/computeKpis.ts` + `computeKpis.test.ts`.

Rules:

1. **One exported pure function per file.** The file name matches the function name (`sortAssignments.ts` exports `sortAssignments`).
2. **No React, no `tr()`, no `useRun`, no `ApiClient`.** Helpers in `src/lib/<feature>/` are framework-free — they only import from `effect` and other pure helpers. This keeps them testable under Vitest's default Node environment (no jsdom needed). The ONE permitted exception is `getLocale()` from `@sideline/i18n/runtime`, and only to feed a locale into `Intl` / `String.prototype.localeCompare` (reference: `src/lib/roles/role-order.ts`) — never to look up a message. The other exception is a **closed-union lookup table** (`src/lib/assistant/entityRoutes.ts`, `src/lib/finance/matchReasons.ts`), which exists precisely to keep every i18n key literal under `staticTrKeys.test.ts` — see "Closed-Union Copy Comes From An Explicit `Record`" above. Such a file may import the domain union type, `tr()`, and lucide icon components, and nothing else React-shaped.
3. **Define a local mirror type instead of importing from `@sideline/domain`** when the helper consumes a model shape (e.g. `FeeAssignmentView`). The mirror keeps the helper decoupled from the domain package's compile cycle and lets the test stub data with plain object literals. See `sortAssignments.ts` (`type FeeAssignmentView = { ... }`).
4. **Co-locate `<name>.test.ts` next to `<name>.ts`.** The test file imports the function directly and tests with plain object literals — no `render`, no `screen`, no mocks. `vitest.config.ts` already includes `src/**/*.test.ts` in the project glob.
5. **Call helpers from components/pages, not from loaders.** Loaders return raw API data; the page/component runs the helper to derive sorted/KPI'd views on each render.

### Effective Roles In The UI — `src/lib/roles/`

Every surface that renders a member's roles (roster row, member summary header, player detail) MUST derive its list through `resolveEffectiveRoles(player, availableRoles?)` and render each entry with `<RoleBadge>`. Never map `player.roleNames` to badges directly — that loses the `direct` / `inherited` / `both` provenance the server now sends on `Roster.RosterPlayer.effectiveRoles`. Prefer `<EffectiveRolesList roles={...} limit={n}>` for a read-only wrapping list: it applies `sortEffectiveRoles` itself and collapses the overflow into a `+n` `Popover`, so its callers MUST NOT pre-sort. Call `sortEffectiveRoles` directly only when rendering `<RoleBadge>` yourself (reference: `PlayerDetailPage.tsx` `RolesSection`, which interleaves per-role remove/forward controls).

Rules:

1. **`resolveEffectiveRoles` is the only place that handles the empty/absent `effectiveRoles` fallback.** The field is additive (`Schema.withDecodingDefaultKey(() => [])` — see `packages/domain/AGENTS.md`), so an older payload or a pre-existing test fixture yields `[]`; the helper then treats every `roleNames` entry as `source: 'direct'` with no group attribution, resolving the real `roleId`/`isBuiltIn` from `availableRoles` when the caller supplies it. Do not re-implement that fallback in a component.
2. **`sortEffectiveRoles` orders built-in before custom, built-ins by the FIXED rank Admin > Captain > Treasurer > Player, and custom roles by `localeCompare`.** Never sort by permission count (permissions are per-team editable, so badge order would differ between teams) and never sort by `source` (the dashed border and icon already carry that distinction).
3. **A role whose `source` is `'inherited'` gets no remove control.** Deleting the direct `member_roles` row would be a no-op the server refuses to sync; render a link to the granting group instead (`InheritedRoleForwardControl`, gated on `group:manage`). A `'both'` role KEEPS its remove control — the direct grant is real — but its confirm copy must say the role stays via the group (`roles_removeRoleStillInheritedDescription`).
4. **Filter the "assign a role" select against the full effective set by `roleId`, not by `name`.** `PlayerDetailPage`'s `RolesSection` builds `effectiveRoleIds` from the resolved list so a role already shown as an inherited badge is never also offered for assignment.

### AI Assistant Client Rules — `src/lib/assistant/`

The assistant surface (`routes/(authenticated)/teams/$teamId/assistant.tsx` → `AssistantPage` → `AssistantConversation`) renders **model-authored prose** and server-authored entity data. The separation is the whole security model: the model chooses which server-held entity a sentence cites, never the facts shown on the card.

Rules:

1. **Model prose is rendered as React text nodes only.** No markdown renderer, no `dangerouslySetInnerHTML`, ever — `AssistantAnswer` emits `{segment.text}` inside `<p>`. Adding a markdown dependency to render model output is a real XSS surface.
2. **`parseAnswer`'s marker grammar must stay byte-identical to the server's**: `/\[\[ref:([a-z0-9]{4})\]\]/`, matching `applications/server/src/services/ai/refTokens.ts` (minting) and `ChatAgent.ts` (stripping). A near-miss (wrong length, uppercase, internal whitespace) is not a marker and survives as literal text.
3. **A `ref` segment whose token is absent from the turn's `references` renders `null`** — never the raw `[[ref:xxxx]]` text, and never a link to a guessed position. Tokens are valid **only for the turn that produced them**; rebuild the `token -> position` map per turn from that turn's `references` (`useMemo` over `references` in `AssistantAnswer`), never across turns.
4. **`buildHistory` (`src/lib/assistant/history.ts`) mirrors the server's truncation constants exactly** — `HISTORY_CHAR_BUDGET = 8000` and `HISTORY_MAX_MESSAGES = 20` match `ChatAgent.ts`'s `HISTORY_CHAR_BUDGET` and `AiChatApi.ChatRequest`'s 20-message cap. Change one side and you must change the other in the same PR, or the UI silently disagrees with the model about what it saw.
5. **Gate the surface on the server's `getCapabilities.enabled`, never on a locally-inferred flag.** When it is `false`, `AssistantPage` replaces the log and composer entirely — never a disabled input box.
6. **Route to an entity through `ENTITY_ROUTE` (`entityRoutes.ts`), declared `as const satisfies Record<EntityRef['kind'], string>`.** The literal route strings must survive for TanStack Router's typed `<Link to>`; a widened `string` return forces an `as never` cast at every call site.

## Time-Sensitive Data: Timezone Correctness, Stale-Response Toggles, Focus Refetch

Features that operate on **team-scoped calendar dates** (weekly challenges' Monday rollover, future event-of-the-week, scheduled announcements) must follow three rules together. The bugs they prevent are silent, only manifest for users whose browser timezone differs from the team's `team_settings.timezone`, and only trigger at the rollover boundary — they will not appear in local dev.

### Server Is The Single Source Of Truth For "Current Week / Today"

The server-side helper `currentTeamMondayDateString(teamTz)` (in `applications/server/src/helpers/weeklyChallenge.ts`) is the canonical computation of "the Monday of the current ISO week, expressed as a `YYYY-MM-DD` string in the team's IANA timezone". The web client MUST NEVER recompute "current week" using browser-local `Date` arithmetic.

Rules:

1. **Never call `Date.getDay()`, `Date.getDate()`, `Date.getMonth()`, or `Date.getFullYear()` to determine "current week" / "is this row the active week".** These all read in the browser's local timezone — a captain in `America/Los_Angeles` viewing a `Europe/Prague` team sees Monday-midnight-Prague as Sunday-evening-LA, and any "is this row this week?" check computed client-side will be off by one day at the rollover boundary.
2. **Trust the server's `isActive` flag.** The `WeeklyChallengeView` returned by the server includes an `isActive: boolean` field that is the result of `currentTeamMondayDateString(teamTz) === weekStartDateString(row.week_start_date, teamTz)` evaluated server-side. The web client renders the row as "active" iff `view.isActive === true` — no client-side recomputation.
3. **For string-comparison "is row X this week?" inside web code, compare ISO date strings, never `Date` instances.** `row.weekStartDate.split('T')[0] === serverProvidedCurrentMonday` is the correct shape. `new Date(row.weekStartDate).getTime() === new Date(serverProvidedCurrentMonday).getTime()` is wrong — it re-introduces the browser-TZ interpretation.
4. **Inside `MondayPicker` and any other "is this Monday selectable?" component, identify Mondays via `Intl.DateTimeFormat('en-CA', { timeZone: teamTz, weekday: 'short' })`,** NOT `date.getDay() === 1`. The `getDay()` form reads the captain's browser timezone; a Monday in Prague is a Sunday in LA at the wrong hour. Reference: `applications/web/src/components/molecules/MondayPicker.tsx` (`isDisabled` callback builds `tzParts` via `Intl.DateTimeFormat` with `timeZone: teamTz` before any weekday/range comparison).
5. **The team timezone arrives as a prop or loader-data field;** never read `Intl.DateTimeFormat().resolvedOptions().timeZone` (browser timezone) as a substitute. If the team's timezone is unknown at the call site, that is a bug in the loader, not a reason to fall back to browser-local. It is carried on the wire by `EventApi.EventDetail.timezone`, `EventApi.EventListResponse.timezone` and `EventSeriesApi.EventSeriesInfo`/`EventSeriesDetail.timezone` — all `OptionFromOptionalKey`, so an older server mid-rollout omits the key instead of decode-failing the response. Resolve the `Option` with `Option.getOrElse(..., () => 'Europe/Prague')` (the server's own default for a team with no `team_settings` row) when the value drives a write, or omit the affected label entirely when it only drives display.
6. **`event_series` times as web sends and renders them are team-local wall clock, not UTC — do not convert them on the way in or out.** `startTime`/`endTime` on `EventSeriesApi` requests and responses are `HH:MM[:SS]`, but their dialect is **per payload and per stored row**, declared by the `timesAreTeamLocal` flag (see `applications/server/AGENTS.md` → "Series Times Are Team-Local Wall Clock") — it is not unconditionally the team's zone. Web always works in the team's zone, so a `<input type='time'>` value is sent **verbatim** and a stored value is rendered **verbatim** (trim seconds with `.slice(0, 5)`). Never wrap either direction in `localToUtc`/`formatUtcTime`. **Every `createEventSeries` and `updateEventSeries` payload web builds MUST set `timesAreTeamLocal: true`** — that flag is what makes the verbatim send truthful. Omitting the key decodes server-side to `false` (the pre-#650 UTC time-of-day dialect), and an update that supplies `startTime`/`endTime` while declaring a dialect that differs from the stored row's is rejected with HTTP 400 `EventSeriesTimeDialectMismatch`. Current call sites, all four already setting it: `EventsListPage.tsx` (create), `TrainingTypeDetailPage.tsx` (create and update), `EventDetailPage.tsx` (update). The single exception is projecting a per-occurrence instant back onto a series-level field ("save all future occurrences" in `EventDetailPage.tsx`): use `formatTimeInZone(instant, teamTimezone)` from `~/lib/datetime.ts`, which reads the TEAM's zone, not the viewer's, and falls back to `'Europe/Prague'` for an invalid zone instead of throwing the way `Intl.DateTimeFormat` does.

### `window.focus` → `router.invalidate()` For Calendar-Boundary Pages

Pages that render data whose semantics change at a calendar boundary (the page was loaded before Monday 00:00 in the team's timezone; the user comes back after the boundary) MUST re-fetch on `window.focus` so the `isActive` flag and "current week" highlight stay correct without a manual refresh.

```typescript
const router = useRouter();
React.useEffect(() => {
  const handleFocus = () => router.invalidate();
  window.addEventListener('focus', handleFocus);
  return () => window.removeEventListener('focus', handleFocus);
}, [router]);
```

Reference: `applications/web/src/components/pages/WeeklyChallengesPage.tsx`.

Rules:

1. **Use `window.addEventListener('focus', ...)`, not `'visibilitychange'`.** Focus fires when the user returns to the tab; visibilitychange fires on every minor tab change and would cause excessive re-fetching.
2. **Always pair the listener with a cleanup function** in the `useEffect` return. A missing cleanup leaks the listener on every navigation.
3. **The effect's only dependency is `router`** — adding loader data, team id, or "is active" derived state would re-bind the listener on every render.
4. **Only add this listener to pages with calendar-boundary semantics.** Adding it everywhere produces unnecessary server load — most pages do not change meaning at midnight.

### Stale-Response Handling In Debounced Optimistic Toggles

When a row exposes a toggle (e.g. "mark this week's challenge complete") with optimistic UI and debounce, the component MUST track in-flight requests by a monotonic id and ignore any response whose id is not the most recent. Without this, a slow successful response from click N can clobber a faster failed rollback from click N+1.

Reference: `applications/web/src/components/molecules/ChallengeCompletionCell.tsx`.

The pattern (4 refs + 1 state slot):

| Ref / state | Purpose |
|------|---------|
| `displayCompleted: useState<boolean>` | The optimistic UI state shown to the user. |
| `inFlightRequestIdRef: useRef<number>` | Monotonic counter; bumped on every click. |
| `optimisticStateRef: useRef<boolean>` | The state the user most recently intended (last toggle). |
| `serverStateRef: useRef<boolean>` | The last server-confirmed state. Initial value mirrors the `isCompleted` prop. |
| `timerRef: useRef<ReturnType<typeof setTimeout> \| null>` | The active debounce handle. |

On click:
1. Clear `timerRef` (cancel any pending request).
2. Increment `inFlightRequestIdRef.current` and capture the new value as `requestId`.
3. Toggle `optimisticStateRef.current` and `setDisplayCompleted(nextState)`.
4. Schedule the API call inside `setTimeout(..., 400)`. In the `then`/`catch` handlers, FIRST check `if (inFlightRequestIdRef.current !== requestId) return;` — any non-latest response is silently ignored.
5. On error of the latest request, roll back to `serverStateRef.current` (NOT to the pre-click value), update `optimisticStateRef`, `setDisplayCompleted`, and surface a toast via `onError`.

Rules:

1. **Roll back to `serverStateRef.current`, not to the captured pre-click optimistic value.** Mid-burst clicks can leave the optimistic state two-or-more flips ahead of the server; rolling back to the pre-click optimistic value preserves a state the server never confirmed. The only safe rollback is to the last server-confirmed truth.
2. **Stale-response detection runs in BOTH the success and error branches.** A late success that fires after a newer click would overwrite `serverStateRef` with the wrong truth; an early error from an older click would roll back optimistic state the user has since corrected. Both branches must short-circuit on `inFlightRequestIdRef.current !== requestId`.
3. **Sync `displayCompleted` / `optimisticStateRef` / `serverStateRef` from the `isCompleted` prop in a `useEffect`.** After `router.invalidate()` reloads the data, the new prop value is the new server truth — all three slots must adopt it.
4. **Debounce window is 400ms.** Shorter windows produce visible flicker on intentional double-toggles; longer windows make the feature feel unresponsive. Do not parameterise the value — pick 400ms or change every site in lockstep.
5. **Cleanup the timer on unmount** (`useEffect(() => () => clearTimeout(timerRef.current), [])`). A pending request firing after unmount is benign for the API but produces a React warning about state updates on unmounted components.
6. **This pattern does NOT solve in-flight cancellation** — two clicks farther apart than the debounce window can still race on the server. The mitigation is the `router.invalidate()` call after the toggle resolves (the server's response is the final truth). Do not add `AbortController` integration without first validating that the API client supports it end-to-end.

## Testing React Components

Web app tests use **jsdom** environment (configured in `vitest.config.ts`). A setup file (`test/setup.ts`) calls `cleanup()` from `@testing-library/react` after each test.

```typescript
// test/MyComponent.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Mock the tr() helper used by the component
vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      some_key: 'Some text',
    };
    return map[key] ?? key;
  },
}));

// Use dynamic import AFTER mocks are set up
const { MyComponent } = await import('~/components/atoms/MyComponent.js');

describe('MyComponent', () => {
  it('renders correctly', () => {
    render(<MyComponent prop='value' />);
    expect(screen.getByText('Some text')).not.toBeNull();
  });
});
```

**Key rules:**
- Always mock `~/lib/translations.js` (the `tr` export) with `vi.mock` before importing the component under test. Never mock `@sideline/i18n/messages` — web code does not import it directly.
- Use `await import(...)` (dynamic import) for the component after `vi.mock` calls — this ensures mocks are applied before module evaluation.
- Test files live in `applications/web/test/` with `.test.tsx` extension.
- `test/setup.ts` polyfills `window.matchMedia` (jsdom does not implement it; `useIsMobile`, `resolveStoredTheme.ts`, `preMountGuard.ts` and `use-pwa-install.ts` all call it unguarded). Its stub always reports `matches: false`. Do NOT add a per-file `matchMedia` stub unless the test needs a specific match result — then override `window.matchMedia` inside that test and restore it afterwards.
- Use `@testing-library/react` (`render`, `screen`, `fireEvent`) for DOM assertions.

### Timezone-Dependent Tests

`vitest.config.ts` sets `env: { TZ: process.env.TZ ?? 'UTC' }`, so the suite runs in **UTC** unless the caller exports `TZ` explicitly. UTC has no DST: a test that reads a browser-local `Date` part greens in CI and on the author's machine and fails on a colleague's. `.github/workflows/check.yml` therefore runs a second `Test (Europe/Helsinki)` leg over the web project only — UTC+2 with EU DST rules, the zone that discriminates against the CET assumptions most of this code was written under.

Rules:

1. **No web test may assume the ambient timezone.** A test whose assertions depend on a wall-clock offset MUST pin its zone. A test that does not depend on one MUST pass under both UTC and `Europe/Helsinki`.
2. **Pin with `withTz(tz, fn)` from `applications/web/test/tz.ts`.** Never hand-roll the save/mutate/restore: assigning the saved value back when `TZ` was unset stores the STRING `'undefined'`, which is not a valid zone, so the process silently falls back to UTC — permanently, because `process.env` is not reset between test files sharing a worker, making later files' effective zone depend on file order. `withTz` deletes the key instead.
3. **A file where every test needs the SAME zone pins it once in `beforeAll` and restores in `afterAll` with the same delete-if-previously-unset discipline** (reference: `test/datetime.test.ts`, pinned to `Europe/Prague`). A file whose tests each need a DIFFERENT zone is a separate file using `withTz` per test (reference: `test/datetime.localToUtc.dst.test.ts`, `test/datetime.formatUtcDate.test.ts`).
4. **Every DST test must be non-vacuous** — it must assert something that FAILS under a wrong zone. Assert a UTC-side value (`formatUtcTime(dt)`) or an epoch delta that differs from naive wall-clock arithmetic (`2026-10-25 00:30 → 03:30` local in Prague is 3 wall-clock hours but 4 real hours). A pair of local-side assertions alone passes vacuously under UTC.
5. **Verify the transition DATE matches the zone being pinned.** EU zones switch on the last Sundays of March and October (2026: `2026-03-29`, `2026-10-25`); US zones switch on the second Sunday of March and the first Sunday of November (2026: `2026-03-08`, `2026-11-01`). A "DST" case dated to the other continent's transition crosses nothing and asserts nothing.
6. **The spring-forward gap is at a fixed INSTANT, not a fixed wall clock.** It lands on 02:00 local at UTC+1 and on 03:00 local at UTC+2, so a wall-clock time that exists in Prague can be missing in Helsinki and normalize an hour forward. Assert the zone's own gap, never a shared "the gap is 02:00" assumption.
7. **Sweep locally before pushing** anything touching `src/lib/datetime.ts` or a component that formats times:

```bash
TZ=Europe/Helsinki pnpm vitest run --project=@sideline/web   # the CI leg, locally
TZ=America/New_York pnpm vitest run --project=@sideline/web  # negative-offset sweep
```


## Crash Recovery & Error Fallbacks

The app renders several distinct crash surfaces, each of which must survive the very failure it reports. Their source files: `src/components/layouts/AppErrorBoundary.tsx` (React error boundary wrapping `ThemeProvider` in `__root.tsx`), `src/components/layouts/AppCrashFallback.tsx` (the boundary's manual fallback UI), `src/components/layouts/AppReloadingScreen.tsx` (the boundary's quiet placeholder shown during the automatic one-shot reload — see "Automatic Reloads Must Persist That They Happened Or Refuse To Fire"), `src/components/layouts/RouteErrorComponent.tsx` (TanStack Router's inner `errorComponent`), and the pre-mount watchdog in `src/lib/preMountGuard.ts`.

### Crash UIs Must Be Self-Contained

A crash surface MUST NOT depend on anything that can itself be the crash source. `AppCrashFallback`, `RouteErrorComponent`'s fallback rendering, and the pre-mount recovery HTML therefore use **inline styles only** and import nothing from:

- the design system (`components/ui/*`, Shadcn, Tailwind class names that resolve via `ThemeProvider`)
- `tr()` / i18n (`~/lib/translations.js`, `@sideline/i18n/*`) — copy is hard-coded English
- the Effect runtime (`useRun`, `ApiClient`, `runPromiseClient`) — the runtime may not be initialized
- `ThemeProvider` or any React context provider rendered above the boundary

Rules:

1. **Hard-code colors and copy inline.** Do not add a `className` that relies on `bg-background`/`text-foreground` — those resolve to white when `.dark` is absent (see next section). Resolve `bg`/`fg` from `resolveStoredTheme()` and apply them via the `style` prop.
2. **Never throw from a crash surface.** `AppErrorBoundary.getDerivedStateFromError`/`componentDidCatch` and every helper they call (`reassertThemeOnDocument`, `beaconCrash`) wrap their bodies in `try { ... } catch {}`. The fallback crashing must not re-enter the boundary.
3. **Log via the runtime only when it is up.** `AppErrorBoundary.componentDidCatch` branches on `isRuntimeInitialized()` (`~/lib/runtime`): `runEffect(Effect.logError(...))` when live, else `beaconCrash(...)` (`~/lib/crashBeacon`) which posts directly via `navigator.sendBeacon` to `window.__SIDELINE_OTLP__`.

### The `.dark`-class White-Screen Failure Mode

A render crash unmounts `ThemeProvider`, which drops the `.dark` class from `<html>`. Because `<body>` uses `bg-background` and `--background` reverts to white without `.dark`, the crash UI would otherwise paint on a white background even in dark mode.

Rules:

1. **Every crash surface MUST call `reassertThemeOnDocument()` (`~/lib/resolveStoredTheme`)** to re-add `.dark` / set `color-scheme` and an explicit `backgroundColor` on `<html>` and `<body>`. Call it synchronously where possible: `AppErrorBoundary` calls it from `getDerivedStateFromError` AND `componentDidCatch`; `RouteErrorComponent` calls it from `React.useLayoutEffect` and additionally sets an inline `backgroundColor` on its root `<div>` as a belt-and-suspenders guard until the effect fires.
2. **Resolve the theme from `localStorage['sideline-theme']` via `resolveStoredTheme()`, NOT from the OS `prefers-color-scheme` directly.** `prefers-color-scheme` is only the fallback for the `'system'`/unset case inside `resolveStoredTheme`. A user who chose dark in-app on a light-mode OS must still get the dark crash screen.
3. **Crash backgrounds are the literals `#0a0a0a` (dark) / `#ffffff` (light).** These match `reassertThemeOnDocument` and the pre-mount recovery HTML; keep all three in sync if the app background changes.

### Reload Triggers Route Through `reloadGuard`

All programmatic reloads MUST go through `~/lib/reloadGuard` so reload loops are capped via `sessionStorage`. There are three independent counters:

| Trigger | Function | Counter key | Cap |
|---------|----------|-------------|-----|
| Crash / recovery reload | `requestReload(reason)` | `sideline-reload-count` (`RELOAD_COUNT_KEY`) | `RELOAD_CAP` = 2 |
| Service-worker `controllerchange` update | `requestSwReload()` | `sideline-sw-reload-count` (`SW_RELOAD_COUNT_KEY`) | `SW_RELOAD_CAP` = 1 |
| Automatic one-shot reload on crash | `requestAutoReloadOnce(reason)` | `sideline-auto-reload-count` (`AUTO_RELOAD_COUNT_KEY`) | `AUTO_RELOAD_CAP` = 1 |

Rules:

1. **Never call `window.location.reload()` directly outside `reloadGuard`** (the pre-mount IIFE has its own ES5 copy of the cap logic — see below). `AppCrashFallback`, `resetApp` (`~/lib/sw-recovery`), and the SW `controllerchange` handler in `RootDocument` all route through it.
2. **SW updates must use the separate counter** so a normal SW update plus one unrelated hiccup does not consume the crash cap and trip the recovery UI.
3. **The guard is cleared only on a confirmed-healthy render.** `markRouteHealthy()` (called from `HealthyOutlet`'s effect in `__root.tsx`, i.e. once a real child route commits) calls `clearReloadGuard()`, which clears BOTH `RELOAD_COUNT_KEY` and `AUTO_RELOAD_COUNT_KEY`. `markAppMounted()` (called from `RootComponent`) MUST NOT clear it — `RootComponent` commits even when the `<Outlet />` crashes.
4. **`resetApp` sets `sessionStorage['sideline-resetting']` (`RESETTING_KEY`) before unregistering the SW** so the `controllerchange` handler skips its own reload during the reset.

### Automatic Reloads Must Persist That They Happened Or Refuse To Fire

`AppErrorBoundary` silently reloads once on a post-mount crash (rendering `AppReloadingScreen` instead of flashing `AppCrashFallback`) before falling back to the manual crash screen. Any automatic (non-user-initiated) reload MUST be persistently counted and loop-guarded — an auto-reload that cannot remember it happened would fire on every crash forever.

Rules:

1. **An automatic reload MUST refuse to fire when `sessionStorage` is unavailable.** `requestAutoReloadOnce` returns `false` without reloading when it cannot persist the counter (private-mode / `SecurityError`). This is the OPPOSITE default from user-initiated reloads: `getReloadCount` treats an unreadable counter as `0` (allow) because a human clicked, whereas an automatic reload with no memory would loop, so it defaults to refuse.
2. **`canAutoReloadOnce()` gates on BOTH budgets** — `AUTO_RELOAD_COUNT_KEY < AUTO_RELOAD_CAP` AND `getReloadCount() < RELOAD_CAP`. `requestAutoReloadOnce` increments the auto counter and then delegates to `requestReload` (which increments the shared counter), so a pre-mount reload plus a crash auto-reload can never chain past `RELOAD_CAP`.
3. **`canAutoReloadOnce()` is pure and safe to call from render / `getDerivedStateFromError`.** The boundary reads it there to choose `AppReloadingScreen` vs `AppCrashFallback` up front; the actual reload happens in `componentDidCatch` behind a per-instance `_autoReloadTriggered` one-shot guard, and reverts to the manual screen (`setState({ autoReloading: false })`) when `requestAutoReloadOnce` returns `false`.
4. **`AppReloadingScreen` is a crash surface** — it follows all "Crash UIs Must Be Self-Contained" rules (inline styles, hard-coded copy, theme resolved via `resolveStoredTheme()`, backgrounds `#0a0a0a`/`#ffffff`).

### `preMountGuard.ts` IIFE Must Stay ES5-Safe and Self-Contained

`PRE_MOUNT_GUARD_SOURCE` is a string injected via `dangerouslySetInnerHTML` into `<head>` (in `RootDocument`) so it runs **before** the app bundle and before any transpilation. Inside the IIFE string body:

1. **Use ES5 syntax only** — `var` (no `const`/`let`), `function` expressions (no arrow functions), string concatenation (no template literals). The body is not transpiled.
2. **No imports / no module references.** Build-time constants (`RELOAD_COUNT_KEY`, `RELOAD_CAP`, `WATCHDOG_MS`, the recovery HTML) are interpolated into the template literal that *produces* the source string; the runtime body references only globals and its own `var`s.
3. **Swallow every error** (`try { ... } catch (e) {}`) — the guard must never itself break page load.
4. The watchdog shows the recovery HTML after `WATCHDOG_MS` if neither `window.__SIDELINE_MOUNTED__` (set by `markAppMounted`) nor `window.__SIDELINE_CRASHED__` (set by `AppErrorBoundary`) is set.

### Devtools Are Dev-Only and Lazy-Imported

TanStack devtools (`@tanstack/react-devtools`, `@tanstack/react-router-devtools`, `@tanstack/react-query-devtools`) live in `devDependencies`, NOT `dependencies`.

1. **Render devtools only behind `import.meta.env.DEV`** (`RootDocument` renders `{import.meta.env.DEV && <DevtoolsPanel />}`).
2. **Lazy-import the devtools packages** inside `DevtoolsPanel`'s effect (`await import('@tanstack/react-devtools')`, etc.) so they are fully tree-shaken from the production bundle. Never add a top-level `import` of a devtools package.
3. Do not move the devtools packages back to `dependencies`.

## Nitro Server Plugins

Nitro server plugins live in `applications/web/server/plugins/*.ts` and are **NOT auto-discovered** — each one MUST be registered explicitly in the `nitro({ plugins: [...] })` array in `applications/web/vite.config.ts`. A plugin file added without that registration silently never runs.

Current plugins: `og-url.ts`, `sw-cache-headers.ts`, `otlp-endpoint.ts` (injects `window.__SIDELINE_OTLP__` = `OTEL_EXPORTER_OTLP_ENDPOINT` into the HTML `<head>` so the pre-mount crash beacon has an endpoint before the bundle loads).

## Troubleshooting

- **TanStack Router serialization errors with Effect `Option`**: Add `ssr: false` to every route's `createFileRoute` options
- **"Cannot find module" errors**: Ensure imports use `.js` extensions, run `pnpm install`
- **White crash screen in dark mode**: A crash surface is rendering without calling `reassertThemeOnDocument()` or is using a `bg-background` class instead of an inline color (see "Crash Recovery & Error Fallbacks")
- **A new `server/plugins/*.ts` plugin never runs**: It is not registered in `nitro({ plugins: [...] })` in `vite.config.ts` (plugins are not auto-discovered)
