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
| `organisms/` | May own significant local state, form logic, or API calls via `useRun()`. No TanStack Router hooks. |
| `pages/` | One file per route. Receives data from `Route.useLoaderData()` / `Route.useRouteContext()` via props. Contains navigation callbacks. |
| `layouts/` | Pure structural wrappers. Render `{children}` slots. No business logic. |

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
4. **For edit forms, track a `dirty` flag** so the API call only sends the new date when the user actually picked one. Initialize `editDate` from `<Resource>Date.formatPragueDate(new Date(row.<field>))` and set `editDateDirty = true` only inside `onChange`. The submit handler then sends `editDateDirty ? Option.some(editDate) : Option.none<string>()` — pairs cleanly with the server's "missing key = do not update" PATCH contract (see `packages/domain/AGENTS.md` → `Schema.OptionFromOptional`).
5. **Never compute the displayed string with `date-fns` `format(...)` outside the component.** The component already calls `useDateFnsLocale()` internally; duplicating the locale wiring at the call site re-introduces the bug class that the central `useDateFnsLocale` hook exists to prevent (see "Date Formatting" below).

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

## Forms — React Hook Form + Effect Schema

**Always use Shadcn Form (`components/ui/form`) with React Hook Form and Effect Schema** for any form that collects user input.

```typescript
import { effectTsResolver } from '@hookform/resolvers/effect-ts';
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
    resolver: effectTsResolver(MyFormSchema),
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

- Use `effectTsResolver(MySchema)` from `@hookform/resolvers/effect-ts` — **not** `standardSchemaResolver`, not zod, not yup
- Do **not** wrap the schema in `Schema.standardSchemaV1(...)` — pass it directly
- Use transforming schemas (`NumberFromString`, `optionalWith({ as: 'Option' })`, `NonEmptyString`)
- `type FormValues = Schema.Schema.Type<typeof MySchema>` is the decoded/transformed type
- Do **not** pass explicit generics to `useForm<MyFormValues>(...)` — let `effectTsResolver` infer
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
  (response: 'yes' | 'no' | 'maybe', message: string) =>
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

1. **The Biome rule `style/noRestrictedImports` enforces this** (`biome.json`): importing `@sideline/i18n/messages` from web fails lint. The override allows the path for `applications/bot/**`, `packages/i18n/**`, and `scripts/**` only — never extend the allow-list to web.
2. **`tr(key, params?, options?)` returns a `string`.** It applies admin overrides on top of compiled Paraglide messages: it first checks the in-memory overrides map (kept in sync by `TranslationOverridesProvider`), and falls back to `messagesByKey[key]` from `@sideline/i18n/registry` if no override is set. An unknown key is logged via `console.warn` and the raw key is returned — never throw out of `tr()`.
3. **Overrides are refreshed by `TranslationOverridesProvider`** (`src/lib/translation-overrides-context.tsx`), which polls `GET /api/translations` every 30s via React Query (`refetchIntervalInBackground: false`) and calls `setTranslationOverrides(...)` on every successful fetch. The provider is mounted once in the root layout; do not mount it elsewhere.
4. **Use the `useTranslationOverrides()` hook only when a component must re-render explicitly on override changes** (e.g. the admin Translations page itself, where the version counter drives a refetch). `tr()` reads the current overrides snapshot synchronously and is sufficient for normal render paths.
5. **Adding a new translation key**: add it to `messages/en.json` AND `messages/cs.json` in `@sideline/i18n`, run `pnpm codegen` and `pnpm build` so `messagesByKey` picks it up, then call `tr('my_new_key', { param: value })`. Do not call `m.my_new_key(...)` from web code.
6. **Before adding a scoped key (e.g. `my_payments_kpi_*`, `<feature>_kpi_*`), grep for an existing key with the same English string** in `packages/i18n/messages/en.json`. If a generic key exists (e.g. `finance_kpi_outstanding = "Outstanding"`, `finance_kpi_overdue = "Overdue"`) and your component needs the same string, **reuse the generic key** — do not create `my_payments_kpi_outstanding` as a duplicate. The check is `grep -i '"<english string>"' packages/i18n/messages/en.json`. Reference: `MyPaymentsPage` reuses `finance_kpi_outstanding` and `finance_kpi_overdue` instead of minting `my_payments_kpi_outstanding` / `_overdue`.

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
2. **No React, no `tr()`, no `useRun`, no `ApiClient`.** Helpers in `src/lib/<feature>/` are framework-free — they only import from `effect` and other pure helpers. This keeps them testable under Vitest's default Node environment (no jsdom needed).
3. **Define a local mirror type instead of importing from `@sideline/domain`** when the helper consumes a model shape (e.g. `FeeAssignmentView`). The mirror keeps the helper decoupled from the domain package's compile cycle and lets the test stub data with plain object literals. See `sortAssignments.ts` (`type FeeAssignmentView = { ... }`).
4. **Co-locate `<name>.test.ts` next to `<name>.ts`.** The test file imports the function directly and tests with plain object literals — no `render`, no `screen`, no mocks. `vitest.config.ts` already includes `src/**/*.test.ts` in the project glob.
5. **Call helpers from components/pages, not from loaders.** Loaders return raw API data; the page/component runs the helper to derive sorted/KPI'd views on each render.

## Time-Sensitive Data: Timezone Correctness, Stale-Response Toggles, Focus Refetch

Features that operate on **team-scoped calendar dates** (weekly challenges' Monday rollover, future event-of-the-week, scheduled announcements) must follow three rules together. The bugs they prevent are silent, only manifest for users whose browser timezone differs from the team's `team_settings.timezone`, and only trigger at the rollover boundary — they will not appear in local dev.

### Server Is The Single Source Of Truth For "Current Week / Today"

The server-side helper `currentTeamMondayDateString(teamTz)` (in `applications/server/src/helpers/weeklyChallenge.ts`) is the canonical computation of "the Monday of the current ISO week, expressed as a `YYYY-MM-DD` string in the team's IANA timezone". The web client MUST NEVER recompute "current week" using browser-local `Date` arithmetic.

Rules:

1. **Never call `Date.getDay()`, `Date.getDate()`, `Date.getMonth()`, or `Date.getFullYear()` to determine "current week" / "is this row the active week".** These all read in the browser's local timezone — a captain in `America/Los_Angeles` viewing a `Europe/Prague` team sees Monday-midnight-Prague as Sunday-evening-LA, and any "is this row this week?" check computed client-side will be off by one day at the rollover boundary.
2. **Trust the server's `isActive` flag.** The `WeeklyChallengeView` returned by the server includes an `isActive: boolean` field that is the result of `currentTeamMondayDateString(teamTz) === weekStartDateString(row.week_start_date, teamTz)` evaluated server-side. The web client renders the row as "active" iff `view.isActive === true` — no client-side recomputation.
3. **For string-comparison "is row X this week?" inside web code, compare ISO date strings, never `Date` instances.** `row.weekStartDate.split('T')[0] === serverProvidedCurrentMonday` is the correct shape. `new Date(row.weekStartDate).getTime() === new Date(serverProvidedCurrentMonday).getTime()` is wrong — it re-introduces the browser-TZ interpretation.
4. **Inside `MondayPicker` and any other "is this Monday selectable?" component, identify Mondays via `Intl.DateTimeFormat('en-CA', { timeZone: teamTz, weekday: 'short' })`,** NOT `date.getDay() === 1`. The `getDay()` form reads the captain's browser timezone; a Monday in Prague is a Sunday in LA at the wrong hour. Reference: `applications/web/src/components/molecules/MondayPicker.tsx` (`isDisabled` callback builds `tzParts` via `Intl.DateTimeFormat` with `timeZone: teamTz` before any weekday/range comparison).
5. **The team timezone arrives as a prop or loader-data field;** never read `Intl.DateTimeFormat().resolvedOptions().timeZone` (browser timezone) as a substitute. If the team's timezone is unknown at the call site, that is a bug in the loader, not a reason to fall back to browser-local.

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
- Use `@testing-library/react` (`render`, `screen`, `fireEvent`) for DOM assertions.

## Troubleshooting

- **TanStack Router serialization errors with Effect `Option`**: Add `ssr: false` to every route's `createFileRoute` options
- **"Cannot find module" errors**: Ensure imports use `.js` extensions, run `pnpm install`
