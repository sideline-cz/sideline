# Weekly Challenges MVP — Part 3/3 (User-facing HTTP API + Web UI + E2E)

> Part 1 (PR #331, `d7513dc8`): schema, domain models, server repository, internal RPC for the bot.
> Part 2 (PR #332, `fbc2627f`): Discord bot processor + i18n keys for the embed.
> Canonical plan: `docs/plans/weekly-challenges-mvp.md` (sections §3 endpoints, §4 authorization, §10 tests).
> Notion bug: `35e93506-0818-80ca-b9d5-c051ee3b46db`.

## 1. Goal

Expose the existing `WeeklyChallengeRepository` through user-facing **HttpApi** endpoints, build the `/teams/$teamId/challenges` web page (grid + dialogs), wire authorization (captain create/update/delete, active-member mark/unmark, current-week guard), and add the integration + E2E tests called out in canonical §10. Closes the Notion bug.

The original RPC handler logic shipped on `fbd91222` and was deleted in revision. We pull the handler bodies from git history and adapt them to the HttpApi pattern that the rest of the codebase already uses (event.ts, expenses.ts, etc.). All five user-facing operations + List become HTTP endpoints — no `WeeklyChallengeRpcGroup` toLayer is wired into `SyncRpcsLive`; the RPC group's user-facing rpcs stay as a domain type without a server-side handler.

---

## 2. HTTP API design

### 2.1 New domain file: `packages/domain/src/api/WeeklyChallengeApi.ts`

Mirrors `packages/domain/src/api/EventApi.ts` shape. Defines payload/response schemas, error tags with `HttpApiSchema.status(...)`, and `WeeklyChallengeApiGroup` (`HttpApiGroup.make('weeklyChallenge')`).

**Reused from `packages/domain/src/models/WeeklyChallenge.ts`** (Part 1): `WeeklyChallenge`, `WeeklyChallengeView`, `WeeklyChallengeId`, `WeeklyChallengeKind`, `WeeklyChallengeTitle`, `WeeklyChallengeDescription`.

**New payload schemas:**

```
CreateWeeklyChallengeRequest = Schema.Struct({
  weekStart: Schema.Date,                         // Monday in team TZ; server re-derives & validates
  kind: WeeklyChallengeKind,
  title: WeeklyChallengeTitle,
  description: Schema.OptionFromNullOr(WeeklyChallengeDescription),
})

UpdateWeeklyChallengeRequest = Schema.Struct({
  title: WeeklyChallengeTitle,
  description: Schema.OptionFromNullOr(WeeklyChallengeDescription),
})

WeeklyChallengeListResponse = Schema.Struct({
  team: Schema.Struct({                                              // server provides team identity + TZ so the dialog can compute the current Monday and the +8w window without a second roundtrip
    id: TeamId,
    timezone: Schema.String,                                         // IANA TZ; e.g. 'Europe/Prague'
  }),
  canCreate: Schema.Boolean,
  currentMemberId: Schema.OptionFromNullOr(TeamMember.TeamMemberId),  // for client-side optimistic mark
  challenges: Schema.Array(WeeklyChallengeView),
})
```

The repository's `listForTeam` is extended to JOIN `teams.timezone` so the handler can return it without a second query. The GET response shape is therefore `{ team: { id, timezone }, canCreate, currentMemberId, challenges }`. The `NewChallengeDialog` consumes `team.timezone` to compute the current team-local Monday via `Intl.DateTimeFormat` and to disable past Mondays plus Mondays beyond `currentMonday + 8w`.

**Errors** — re-export from `packages/domain/src/rpc/weeklyChallenge/WeeklyChallengeRpcGroup.ts` so we don't duplicate tags. They are `Schema.TaggedErrorClass` already (no `_tag` clash).

### 2.2 Endpoint table

| Method | Path | Endpoint name | Success | Errors (HTTP) | Auth | Payload |
|---|---|---|---|---|---|---|
| `GET` | `/teams/:teamId/weekly-challenges` | `listChallenges` | `WeeklyChallengeListResponse` | `Forbidden 403` | active member | `query.limit?: Schema.NumberFromString` (default 12, max 12) |
| `POST` | `/teams/:teamId/weekly-challenges` | `createChallenge` | `WeeklyChallenge (201)` | `Forbidden 403`, `WeeklyChallengeAlreadyExistsForWeek 409`, `WeeklyChallengeWeekOutOfRange 422` | captain (`team:manage`) | `CreateWeeklyChallengeRequest` |
| `PATCH` | `/teams/:teamId/weekly-challenges/:challengeId` | `updateChallenge` | `WeeklyChallenge` | `Forbidden 403`, `WeeklyChallengeNotFound 404` | captain | `UpdateWeeklyChallengeRequest` |
| `DELETE` | `/teams/:teamId/weekly-challenges/:challengeId` | `deleteChallenge` | `Schema.Void (204)` | `Forbidden 403`, `WeeklyChallengeNotFound 404` | captain | — |
| `POST` | `/teams/:teamId/weekly-challenges/:challengeId/complete` | `markCompleted` | `Schema.Void (204)` | `Forbidden 403`, `WeeklyChallengeNotFound 404`, `WeeklyChallengeNotActive 409` | active member | — |
| `DELETE` | `/teams/:teamId/weekly-challenges/:challengeId/complete` | `unmarkCompleted` | `Schema.Void (204)` | `Forbidden 403`, `WeeklyChallengeNotFound 404`, `WeeklyChallengeNotActive 409` | active member | — |

`MarkCompleted` / `UnmarkCompleted` derive `member_id` from `Auth.CurrentUserContext` + team lookup. No member id ever crosses the wire (matches canonical §3).

### 2.3 Status mapping notes

- `WeeklyChallengeForbidden 403` — caller is not a member, inactive, or lacks `team:manage`.
- `WeeklyChallengeNotFound 404` — id miss, or id belongs to another team (treated as 404, not 403, to avoid id-existence oracle).
- `WeeklyChallengeNotActive 409` — mark/unmark targeting a non-current-week challenge. Repository already returns this tag (see `WeeklyChallengeRepository.ts` lines 379, 405).
- `WeeklyChallengeAlreadyExistsForWeek 409` — UNIQUE conflict on `(team_id, week_start_date)`, raised by `SqlErrors.catchUniqueViolation` in the repo's `create`.
- `WeeklyChallengeWeekOutOfRange 422` — `weekStart < currentMonday` OR `weekStart > currentMonday + 8w`. Server-side check before INSERT.

---

## 3. Auth helper plan

The `fbd91222` commit shipped local helpers (`resolveCurrentUser`, `assertCaptain`, `assertActiveMember`) that duplicate functionality already provided by the existing HttpApi infrastructure. **Do not restore them.** Use the existing primitives:

| Need | Existing primitive | File |
|---|---|---|
| Current user | `Auth.CurrentUserContext.asEffect()` | `packages/domain/src/api/Auth.ts` (via `AuthMiddleware`) |
| Membership lookup + Forbidden mapping | `requireMembership(members, teamId, userId, forbiddenErr)` | `applications/server/src/api/permissions.ts:8` |
| Permission check | `requirePermission(membership, 'team:manage', forbiddenErr)` | same, line 33 |
| Permission predicate (no throw) | `hasPermission(membership, 'team:manage')` | same, line 28 |
| Active flag | `membership.active ? Effect.void : Effect.fail(...)` | inline, see `activity-logs.ts:75` |

**Composition** (used in the handler):
- "Captain only" = `requireMembership` + `requirePermission(..., 'team:manage', ...)`.
- "Active team member" = `requireMembership` + inline `.active` check.
- The user's session is the source of truth for the member id (`membership.id`).

`Auth.CurrentUserContext` is injected by `AuthMiddleware` (already attached to every endpoint via `.middleware(AuthMiddleware)`), so we do not parse `Authorization` headers ourselves like the original handler did.

**No new helpers required.** This is a deliberate divergence from the `fbd91222` commit and removes ~70 lines of duplicated auth code.

---

## 4. Server file inventory

### 4.1 New

- `packages/domain/src/api/WeeklyChallengeApi.ts` — endpoint group + payload schemas + error tags. ~80 lines.
- `applications/server/src/api/weekly-challenge.ts` — `WeeklyChallengeApiLive` layer with the 6 handlers. ~200 lines. Pull logic from `fbd91222:applications/server/src/rpc/weeklyChallenge/index.ts`, drop the local auth helpers, replace with `requireMembership` / `requirePermission`. Reuse the existing `currentTeamMondayDateString` / `scheduleAtNineAm` helpers in `applications/server/src/helpers/weeklyChallenge.ts` (Part 1). The Part-1 `create` already enqueues the sync event when `weekly_summary_channel_id` is `Option.some`, so the handler just calls `challenges.create({...})` and then `challenges.enqueueAnnouncementEvent(...)` conditioned on team settings — same shape as the original.

### 4.2 Modified

- `packages/domain/src/api/index.ts` (or wherever API groups are barrelled) — add `WeeklyChallengeApi` export. (Check the actual barrel: most files import `from '@sideline/domain'` and `api.ts` then references `WeeklyChallengeApi.WeeklyChallengeApiGroup`.)
- `packages/domain/src/index.ts` — re-export `WeeklyChallengeApi` namespace.
- `applications/server/src/api/api.ts` — add `WeeklyChallengeApi.WeeklyChallengeApiGroup` to `Api.add(...)` (split across the two `.add(...)` blocks so each stays under the type-checker's group-count threshold — the file currently splits at 21 entries; add it to the second block alongside `WeeklySummaryApiGroup`).
- `applications/server/src/api/index.ts` — add `WeeklyChallengeApiLive` import + `Layer.provide(WeeklyChallengeApiLive)`.
- `applications/server/src/AppLive.ts` — **no change required**. `WeeklyChallengeRepository.Default` is already registered (Part 1, line 123).
- `applications/server/src/repositories/WeeklyChallengeRepository.ts` — extend `listForTeam` to return `{ team: { id, timezone }, challenges }` (JOIN `teams.timezone` on `team_id`). The `listChallenges` handler then maps that directly into `WeeklyChallengeListResponse`. This avoids a second roundtrip from the dialog to fetch team timezone for the Monday picker / +8w range (see §2.1).
- `packages/migrations/` — **no change**.
- `applications/server/src/rpc/index.ts` — **no change**. The user-facing `WeeklyChallengeRpcGroup` from `packages/domain/src/rpc/weeklyChallenge/WeeklyChallengeRpcGroup.ts` is unused (we ship HTTP, not RPC, for user traffic); leave the RPC group definition alone for now to avoid touching the domain barrel just to delete a type — it's harmless dead code and can be removed in a follow-up. (Flag this in the PR description as a known follow-up.)

---

## 5. Web file inventory

Coordinate with the parallel `/canvas` designer agent for component visual spec. The route name confirmed by `applications/web/src/routes/(authenticated)/teams/$teamId/` is `challenges.tsx` (matches canonical plan §8 path `/teams/$teamId/challenges`). TanStack splits sub-paths by dot; siblings include `workout.weekly.tsx` and `events.index.tsx`, so a flat `challenges.tsx` file is correct.

### 5.1 New

- `applications/web/src/routes/(authenticated)/teams/$teamId/challenges.tsx` — file route, `ssr: false`, loader fetches `api.weeklyChallenge.listChallenges({ params: { teamId } })`, renders `WeeklyChallengesPage`. Pattern: `events.index.tsx`.
- `applications/web/src/components/pages/WeeklyChallengesPage.tsx` — top-level page: header + "+ Nová výzva" button (captain), responsive grid/list switch (Tailwind `md:` breakpoint, confirm with designer), empty state, error toast on action failure.
- `applications/web/src/components/organisms/WeeklyChallengesGrid.tsx` — desktop grid: members × weeks (up to 12 columns). **Column ordering: chronological left — oldest week on the left, newest on the right.** The current week appears wherever it falls within the visible 12-week window (typically near the right edge once weeks accumulate); it is visually findable via the `bg-primary/5 border-x border-primary/30` highlight + `tento týden` badge. Rationale: matches the original "Poletíme Házecí Výzva" spreadsheet reference, the convention of every other calendar/grid in this codebase, and the user mental model from spreadsheets. Sticky first column (member names). Per-column kebab menu (captain only) → `Smazat` / `Upravit text`.
- `applications/web/src/components/organisms/WeeklyChallengesList.tsx` — mobile vertical card list, one card per week, current week pinned to top.
- `applications/web/src/components/organisms/NewChallengeDialog.tsx` — `Dialog` + form: `ToggleGroup` (kind), Monday-only `DatePicker` (default next un-used Monday), title `Input` with counter, description `Textarea` with counter. Submit → `api.weeklyChallenge.createChallenge`.
- `applications/web/src/components/organisms/EditChallengeDialog.tsx` — `Dialog` + form: title + description. Submit → `api.weeklyChallenge.updateChallenge`.
- `applications/web/src/components/molecules/ChallengeKindBadge.tsx` — small pill: `🥏 Throwing` / `🏃 Sport`.
- `applications/web/src/components/molecules/ChallengeCompletionCell.tsx` — cell content: `✓` (done) / `✗` (past, missed) / `—` (future or other-member future). Used in the grid and in the list.
- `applications/web/src/components/atoms/WeekRangeLabel.tsx` — formats `"10.3. – 16.3."` from a `week_start_date`.
- `applications/web/src/components/molecules/MondayPicker.tsx` — wraps shadcn `<Calendar>` with `disabled={(d) => d.getDay() !== 1 || isBefore(d, currentMonday) || isAfter(d, addWeeks(currentMonday, 8))}`. Props: `teamTz: string`, `existingWeekStarts: Array<string>` (to also disable Mondays that already have a challenge), `value: Date | undefined`, `onChange: (d: Date) => void`. Consumed by `NewChallengeDialog`.
- `applications/web/src/components/ui/alert-dialog.tsx` — generated by `pnpm dlx shadcn@latest add alert-dialog` (run inside `applications/web/`). Backs the destructive delete confirmation in `WeeklyChallengesGrid` / `WeeklyChallengesList`.

### 5.2 Modified

- `applications/web/src/components/layouts/AppSidebar.tsx` — insert a new `NavItem` in the `team` group **between `event_events` and `sidebar_makanicko`** (i.e. immediately before the Workout/Makaníčko entry, after the Events entry):
  ```
  {
    title: tr('challenges_navTitle'),
    icon: Target,   // from lucide-react
    to: '/teams/$teamId/challenges',
    params: { teamId },
  }
  ```
- `packages/i18n/messages/cs.json` and `packages/i18n/messages/en.json` — add the keys from §6.
- (Implicit) `applications/web/src/lib/client.ts` does not need modifications — the typed client is generated from `Api` automatically.

### 5.3 Web component logic notes

- **Toggle debounce (400 ms):** in `ChallengeCompletionCell`, implement a `useRef + setTimeout` debounce directly in the cell — **do not** add `use-debounce` as a dep. The cell holds an `inFlightRequestIdRef` (monotonically incremented on each click), an `optimisticStateRef` (the state the user most recently intended), and a `timerRef`. Each click cancels the pending timer, bumps the request id, and schedules a new timer 400 ms out. When the timer fires, it captures the current request id, sends the API call, and on response checks whether the returned/failed request id still matches the latest in-flight id; **only the response matching the latest request id is allowed to roll back optimistic state on failure**. Stale responses are ignored. Optimistic state flips immediately; on error matching the current request id, revert + toast (via existing `useRun()` from `runtime.ts`).
- **State propagation after create/update/delete:** invalidate the loader by `router.invalidate()` (TanStack Router). Same pattern as `events.index.tsx` after `createEvent`.
- **Captain detection on the client:** use `response.canCreate` from `WeeklyChallengeListResponse` (server-computed via `hasPermission(membership, 'team:manage')`). Do not duplicate the permission check on the client.
- **Member-id resolution for the current week's row:** use `response.currentMemberId` returned by the server. This is the `Option<TeamMemberId>` of the logged-in user's membership in this team. The grid component renders the toggle only on the row whose `member_id === currentMemberId.value` AND only on the column where `view.isActive === true`.

---

## 6. i18n keys

All keys live under `challenges_*` (page + UI) and reuse the existing `weeklyChallenge_embed_*` keys shipped in Part 2 for the Discord embed. The plan §8 in canonical specifies Czech-primary; English fallbacks below.

**Total: 47 new keys** (cs + en, so 94 lines added across `cs.json` and `en.json`). Breakdown: §6.1 sidebar + page chrome = 9 keys; §6.2 grid / list = 9 keys; §6.3 new / edit dialog = 14 keys; §6.4 captain controls / menu = 7 keys; §6.5 server error toasts = 8 keys. Exact list of all 47 keys (in order of appearance): `challenges_navTitle`, `challenges_pageTitle`, `challenges_subtitle`, `challenges_thisWeekBadge`, `challenges_emptyTitle`, `challenges_emptySubtitle_captain`, `challenges_emptySubtitle_member`, `challenges_loadError`, `challenges_retry`, `challenges_grid_memberColumn`, `challenges_grid_completedAlt`, `challenges_grid_missedAlt`, `challenges_grid_futureAlt`, `challenges_grid_emptyRow`, `challenges_grid_markCta`, `challenges_grid_unmarkCta`, `challenges_kind_throwing`, `challenges_kind_sport`, `challenges_newDialog_title`, `challenges_newDialog_kindLabel`, `challenges_newDialog_weekLabel`, `challenges_newDialog_weekHelp`, `challenges_newDialog_titleLabel`, `challenges_newDialog_titlePlaceholder`, `challenges_newDialog_descLabel`, `challenges_newDialog_descPlaceholder`, `challenges_newDialog_submit`, `challenges_newDialog_cancel`, `challenges_newDialog_titleCounter`, `challenges_newDialog_descCounter`, `challenges_editDialog_title`, `challenges_editDialog_submit`, `challenges_actions_createButton`, `challenges_actions_editItem`, `challenges_actions_deleteItem`, `challenges_actions_deleteConfirmTitle`, `challenges_actions_deleteConfirmBody`, `challenges_actions_deleteConfirmCta`, `challenges_actions_cancelCta`, `challenges_error_forbidden`, `challenges_error_notFound`, `challenges_error_notActive`, `challenges_error_alreadyExists`, `challenges_error_outOfRange`, `challenges_success_created`, `challenges_success_updated`, `challenges_success_deleted`.

### 6.1 Sidebar + page chrome

| Key | Czech | English |
|---|---|---|
| `challenges_navTitle` | Týdenní výzvy | Weekly Challenges |
| `challenges_pageTitle` | Týdenní výzvy | Weekly Challenges |
| `challenges_subtitle` | Jedna výzva týdně, kterou tým plní společně. | One challenge per week — completed together. |
| `challenges_thisWeekBadge` | tento týden | this week |
| `challenges_emptyTitle` | Zatím tu nic není. | Nothing here yet. |
| `challenges_emptySubtitle_captain` | Pro kapitány: založte první výzvu. | For captains: create the first challenge. |
| `challenges_emptySubtitle_member` | Až kapitán vyhlásí výzvu, objeví se tady. | Once your captain posts a challenge it will appear here. |
| `challenges_loadError` | Nepodařilo se načíst výzvy. | Failed to load challenges. |
| `challenges_retry` | Zkusit znovu | Retry |

### 6.2 Grid / list

| Key | Czech | English |
|---|---|---|
| `challenges_grid_memberColumn` | Hráč | Player |
| `challenges_grid_completedAlt` | Splněno | Completed |
| `challenges_grid_missedAlt` | Nesplněno | Not completed |
| `challenges_grid_futureAlt` | Ještě nezačalo | Not started yet |
| `challenges_grid_emptyRow` | — | — |
| `challenges_grid_markCta` | Označit splněno | Mark as completed |
| `challenges_grid_unmarkCta` | Splněno ✓ | Completed ✓ |
| `challenges_kind_throwing` | Házecí | Throwing |
| `challenges_kind_sport` | Sportovní | Sport |

### 6.3 New / Edit dialog

| Key | Czech | English |
|---|---|---|
| `challenges_newDialog_title` | Nová týdenní výzva | New weekly challenge |
| `challenges_newDialog_kindLabel` | Druh | Kind |
| `challenges_newDialog_weekLabel` | Týden (pondělí) | Week (Monday) |
| `challenges_newDialog_weekHelp` | Vyberte pondělí — od něho se výzva ohlásí v Discordu. | Pick a Monday — the challenge will be announced on Discord that day. |
| `challenges_newDialog_titleLabel` | Název | Title |
| `challenges_newDialog_titlePlaceholder` | Např. 30 bekhendů denně | E.g. 30 backhands a day |
| `challenges_newDialog_descLabel` | Popis (nepovinné) | Description (optional) |
| `challenges_newDialog_descPlaceholder` | Co to znamená a jak to počítáme. | What it means and how we count it. |
| `challenges_newDialog_submit` | Vytvořit výzvu | Create challenge |
| `challenges_newDialog_cancel` | Zrušit | Cancel |
| `challenges_newDialog_titleCounter` | {n}/120 | {n}/120 |
| `challenges_newDialog_descCounter` | {n}/2000 | {n}/2000 |
| `challenges_editDialog_title` | Upravit výzvu | Edit challenge |
| `challenges_editDialog_submit` | Uložit | Save |

### 6.4 Captain controls / menu

| Key | Czech | English |
|---|---|---|
| `challenges_actions_createButton` | + Nová výzva | + New challenge |
| `challenges_actions_editItem` | Upravit text | Edit text |
| `challenges_actions_deleteItem` | Smazat | Delete |
| `challenges_actions_deleteConfirmTitle` | Smazat výzvu? | Delete challenge? |
| `challenges_actions_deleteConfirmBody` | Tato akce smaže výzvu i všechna označení splnění. | This will delete the challenge and all its completion marks. |
| `challenges_actions_deleteConfirmCta` | Smazat | Delete |
| `challenges_actions_cancelCta` | Zrušit | Cancel |

### 6.5 Server error toasts

| Key | Czech | English |
|---|---|---|
| `challenges_error_forbidden` | Na tuto akci nemáte oprávnění. | You're not allowed to do that. |
| `challenges_error_notFound` | Výzva už neexistuje. | This challenge no longer exists. |
| `challenges_error_notActive` | Označit splnění jde jen u aktuálního týdne. | You can only mark completion for the current week. |
| `challenges_error_alreadyExists` | Pro tento týden už výzva existuje. | A challenge for that week already exists. |
| `challenges_error_outOfRange` | Datum musí být v rozsahu aktuální týden … +8 týdnů. | Date must be in the range current week … +8 weeks. |
| `challenges_success_created` | Výzva vytvořena. | Challenge created. |
| `challenges_success_updated` | Výzva upravena. | Challenge updated. |
| `challenges_success_deleted` | Výzva smazána. | Challenge deleted. |

---

## 7. Test plan

### 7.1 Repository integration tests — `applications/server/test/integration/repositories/WeeklyChallengeRepository.test.ts`

Follow pattern from `EventsRepository.test.ts`. Use `cleanDatabase` + `TestPgClient` from `../helpers.js`. Each test seeds users / team / members fresh.

| # | Test name | Setup | Action | Expected |
|---|---|---|---|---|
| 1 | `insert + list returns completedMemberIds: []` | Create team, captain, member; insert one challenge | `listForTeam(teamId, 'UTC')` | Array length 1, `completedMemberIds === []`, `isActive` set by Monday-comparison logic |
| 2 | `duplicate week → WeeklyChallengeAlreadyExistsForWeek` | Insert challenge for week X | Insert second challenge for same `week_start_date` | Effect.fail with `WeeklyChallengeAlreadyExistsForWeek` |
| 3 | `markCompleted is idempotent` | Insert challenge for current Monday | Call `markCompleted` twice with same `(challengeId, memberId, teamTz)` | First succeeds, second succeeds (no error, `ON CONFLICT DO NOTHING`); list shows exactly 1 entry |
| 4 | `unmarkCompleted on non-existent row is no-op` | Insert challenge for current Monday, no completions | Call `unmarkCompleted` | succeeds (`DELETE` of 0 rows); list still empty |
| 5 | `delete cascades completions` | Insert challenge + 2 completions | Call `delete(challengeId)` | `weekly_challenge_completions` rows for that challenge are gone (verify via raw SQL count) |
| 6 | _(removed — `currentTeamMondayDateString` already has unit coverage in `applications/server/test/unit/weeklyChallenge.test.ts`; no need to duplicate in an integration test.)_ | — | — | — |
| 7 | `two teams in different timezones produce different week_start_date rows` | Seed two teams: team A (`timezone = 'Pacific/Auckland'`), team B (`timezone = 'America/Los_Angeles'`). Mock `DateTime.nowUnsafe()` to a UTC instant where Auckland is already Monday but Los Angeles is still Sunday. | For each team, call `WeeklyChallengeRepository.create({ teamId, weekStart: <"next Monday" computed from that team's TZ> })` from the same UTC instant. | Both rows persist successfully; their `week_start_date` columns differ by exactly 7 days. Verifies that helper + repository compose correctly across timezones. |

**Required layers/mocks for repo tests:**
- `WeeklyChallengeRepository.Default`
- `TeamsRepository.Default`, `TeamMembersRepository.Default`, `UsersRepository.Default` (for FK seed)
- `TestPgClient` (real Postgres via testcontainers/local DB — see existing `helpers.ts`)
- For #7: use Vitest `vi.spyOn(DateTime, 'nowUnsafe')` or pass an injected clock; seed both teams with distinct `timezone` columns.

### 7.2 HTTP handler tests — `applications/server/test/api/weekly-challenge.test.ts`

Mirror the in-memory-mock pattern used by `applications/server/test/api/expenses.test.ts`. The harness wires `ApiLive` + `AuthMiddlewareLive` + an `HttpClient`, stubs each repository with an in-memory `Layer.succeed`, and asserts on the response status code + JSON body.

| # | Test name | Actor | Action | Expected |
|---|---|---|---|---|
| 1 | non-captain `POST /weekly-challenges` → 403 | regular member | create with valid payload | HTTP 403, body has `_tag: "WeeklyChallengeForbidden"` |
| 2 | captain `POST` → 201 + sync event enqueued | captain | create with `weekStart = currentMonday + 1w`, channel configured | HTTP 201, response is `WeeklyChallenge`; mock `enqueueAnnouncementEvent` was called with `scheduled_for = weekStart 09:00 teamTz` |
| 3 | `POST` 9 weeks ahead → 422; 8 weeks ahead → 201 | captain | two requests | first returns `WeeklyChallengeWeekOutOfRange (422)`, second returns `201` |
| 4 | `POST` in the past → 422 | captain | weekStart = currentMonday − 1w | HTTP 422 with `WeeklyChallengeWeekOutOfRange` |
| 5 | `POST .../complete` on past week → 409 | active member | challenge `week_start_date = currentMonday − 1w` | HTTP 409 with `WeeklyChallengeNotActive` |
| 6 | `POST .../complete` on current week succeeds; second call idempotent | active member | two POSTs to same id | both 204; in-memory completions has exactly 1 row |
| 7 | _(removed — `MarkCompleted` has no request body per the schema, so spoofing is structurally impossible. Invariant: handler resolves `member_id` solely from `Auth.CurrentUserContext` + team membership lookup. Covered implicitly by test #6 and #8.)_ | — | — | — |
| 8 | non-member `POST .../complete` → 403 | user with no membership in this team | mark | HTTP 403 with `WeeklyChallengeForbidden` |
| 9 | `PATCH ...` preserves completion count | captain | challenge has 3 completions; update title | response shows new title; list still shows 3 in `completedMemberIds` |
| 10 | captain `DELETE ...` cascades | captain | challenge has 2 completions | HTTP 204; subsequent list does NOT include the challenge id; completions repo also has none |
| 11 | cross-team id-substitution: captain of team A `POST`s `Create` to team B (where they have no membership) | captain of team A | `POST /teams/{teamB}/weekly-challenges` with valid payload | HTTP 403 with `WeeklyChallengeForbidden`. Same guard applies to PATCH/DELETE/complete when the URL `teamId` is one the actor is not a member of. |

**Required layers/mocks:**
- `ApiLive` (built from `~/api/index.js`)
- `AuthMiddlewareLive` with a stub `sessionsStore` + `usersMap` (mirror `expenses.test.ts:94-100`)
- Stub `TeamMembersRepository` to return `MembershipWithRole` with the right `permissions`/`active` for each test actor
- Stub `WeeklyChallengeRepository` with an in-memory `Map<challengeId, ChallengeRow>` + completions `Map<challengeId, Set<memberId>>`
- Stub `TeamSettingsRepository` returning `{ timezone: 'Europe/Prague', weekly_summary_channel_id: Option.some(...) }`
- Time control: freeze `DateTime.nowUnsafe()` via `vi.useFakeTimers` to a known Monday so the current-week checks are deterministic

### 7.3 Web component unit tests

Pick the two components with non-trivial logic. Other components are presentational and skipped.

#### `applications/web/src/components/molecules/ChallengeCompletionCell.test.tsx`

| # | Test | Setup | Action | Expected |
|---|---|---|---|---|
| 1 | renders `✓` when `completed && !isOwnRowActive` | view-only completed cell | mount | DOM has the `Completed` aria-label, no toggle button |
| 2 | renders `✗` when `!completed && past` | past-week missed | mount | shows `Not completed` |
| 3 | renders `—` when future or empty | future column | mount | shows em-dash |
| 4 | optimistic toggle: click flips state immediately | own row + current week, server call deferred | click toggle | local state shows "Splněno ✓" before the promise resolves |
| 5 | debounce coalesces rapid clicks | own row + current week | click 5× in 100 ms | server function called at most once after 400 ms debounce |
| 6 | error reverts optimistic state | own row + current week; server rejects with `WeeklyChallengeNotActive` | click toggle, wait for promise rejection | UI reverts to unchecked + toast shown |
| 7 | stale response ignored: rapid clicks where slow server returns success for click 1 and failure for click 2 | own row + current week; click 1 fires `markCompleted` (resolves OK after 800 ms), click 2 (200 ms later) fires `unmarkCompleted` (rejects after 1000 ms) | issue both clicks; wait for both promises to settle | final cell state reflects click 2's outcome (unchecked, error toast); the success of click 1 must NOT re-flip the state because its request id is stale |

#### `applications/web/src/components/organisms/NewChallengeDialog.test.tsx`

| # | Test | Setup | Action | Expected |
|---|---|---|---|---|
| 1 | submit disabled when title empty | open dialog | inspect submit | disabled |
| 2 | submit disabled when title > 120 chars | type 121 chars | inspect submit | disabled + counter shows in error color |
| 3 | submit enabled with valid title | type 5 chars + pick Monday + pick kind | inspect submit | enabled |
| 4 | only Mondays are selectable in date picker | open date picker | inspect | non-Monday days have `disabled` class/aria |
| 5 | submission calls `createChallenge` with parsed `weekStart` | fill form, submit | spy on api client | called with `{ teamId, weekStart: <picked-monday>, kind: 'throwing', title: 'X', description: Option.none() }` |
| 6 | `WeeklyChallengeAlreadyExistsForWeek` shows inline error not toast | mock api to reject with that tag | submit | inline error under the date picker, dialog stays open |

**Test harness:** existing Vitest + Testing Library setup (`MyPaymentsPage.test.tsx` is the reference). Mock `ApiClient` via `Layer.succeed`.

### 7.4 E2E test — `e2e/tests/weekly-challenges.spec.ts`

Pattern: `events.spec.ts`. Uses `api-mocks.ts` fixture for the captain user (`mock.mockCurrentUser` has `team:manage`).

**Steps (single spec, ~30 lines):**

1. `beforeEach`: mock `GET /teams/:teamId/weekly-challenges` to return empty list; mock `POST` to return a fresh challenge object; mock `POST .../complete` to return 204; navigate to `/teams/${TEAM_ID}/challenges`.
2. Assert page heading `Týdenní výzvy` (or English equivalent depending on locale env) is visible.
3. Click `+ Nová výzva`; fill title `E2E test challenge`; pick the default Monday (already selected); click `Vytvořit výzvu`.
4. After the POST is intercepted, update the mock for `GET` to return the new challenge. Reload the page (`page.reload()`).
5. Assert the new challenge title is visible in the grid.
6. Click the toggle in the captain's own row for the current week; assert the cell text changes to `Splněno ✓` within 600 ms (debounce + propagation).
7. Reload the page (mocking the GET to now return the challenge with `completedMemberIds: [captainMemberId]`).
8. Assert the cell still shows `Splněno ✓`.

Single spec named: `'captain creates a challenge, ticks own row, reloads, stays ticked'`.

---

## 8. Wiring the Discord deep-link URL

Part 2 left a TODO on the bot side: `applications/bot/src/rcp/weeklyChallenge/ProcessorService.ts:54` already passes `env.WEB_URL` into `handleWeeklyChallengeReady`, and `buildWeeklyChallengeEmbed.ts` already includes a `url` field in the embed when `webUrl` is `Option.some`. The embed link points at `${webUrl}/teams/${teamId}/challenges`.

Action items for the PR description:

- **No code change required in the bot for the deep link itself** — the wiring exists, only the route is missing. After this PR ships and `/teams/$teamId/challenges` exists in the web app, the embeds will become clickable automatically.
- Operationally: confirm `WEB_URL` is set in the bot's production env (default is `Option.none()` per `applications/bot/src/env.ts:29`). If it's currently `none`, set it to `https://sideline.app` (or the actual host) **after** PR is merged + deployed, so the link target exists before the first announcement carries it.
- Add a checkbox to the PR description: `[ ] Set bot env WEB_URL after deploy`.

---

## 9. Risks

1. **Re-introducing the deleted auth helpers from `fbd91222`.** The original commit defined `resolveCurrentUser`, `assertCaptain`, `assertActiveMember` locally. They were correct but duplicated existing primitives in `~/api/permissions.ts` + `Auth.CurrentUserContext`. **Mitigation:** explicitly use `requireMembership` / `requirePermission` / `Auth.CurrentUserContext.asEffect()`. Do NOT copy the helpers; the section §3 of this plan is the directive.
2. **400 ms client debounce vs React state.** Naive `useState` + `setTimeout` causes stale-closure bugs (the latest checked state may be lost if the timer fires from a stale render). **Mitigation:** committed to `useRef + setTimeout` per §5.3 — `inFlightRequestIdRef` (monotonic), `optimisticStateRef`, `timerRef`; only the response whose request id matches the latest in-flight id is allowed to roll back optimistic state. The cell tests §7.3 cases #5 and #7 verify coalescing and the stale-response-ignored invariant.
3. **Mobile/desktop breakpoint.** Plan §8 in canonical says "desktop grid + mobile vertical card list" but doesn't specify the breakpoint. **Mitigation:** designer agent owns this; default to Tailwind `md:` (768 px) unless designer specifies otherwise. Both organisms render conditionally based on `useIsMobile` from `~/hooks/use-mobile` (the project's established hook — see e.g. existing usages in the web app).
4. _(removed — see §7.2 #7 note; the schema has no body so spoofing is structurally impossible.)_
5. **Server-side current-Monday vs client-side `weekStart` value.** The client sends a `Date`. Postgres stores `DATE` (UTC-midnight). The repository's `formatDateUtc` reads UTC components — so the client must send the Monday as **UTC-midnight of the Monday in the team's local timezone** (which is what the date picker should produce when configured with the team timezone). The server then re-validates against `currentTeamMondayDateString(teamTz)` using the same UTC-midnight comparison. **Mitigation:** in the dialog, when the user picks "Monday X", construct `new Date(Date.UTC(year, monthIdx, day))` — NOT `new Date(year, monthIdx, day)` (which would be local-midnight). Add a comment in the dialog code citing this plan section.
6. **`isActive` flag and post-Sunday-midnight UI staleness.** `isActive` is computed server-side at request time. If a tab is open across a week boundary, the current week's toggle silently becomes inactive. **Mitigation:** the page (`WeeklyChallengesPage`) registers a `window.addEventListener('focus', …)` in a `useEffect` that calls `router.invalidate()` (TanStack Router) so the loader re-runs whenever the tab regains focus — refreshing `isActive` after midnight rollover. Cleanup removes the listener on unmount. Two lines of code. The server-side `WeeklyChallengeNotActive 409` remains the authoritative guard for the race window, and the cell test §7.3 case #6 verifies the optimistic-revert path.
7. **TanStack route filename style.** Existing routes use both `dotted.subpath.tsx` (`workout.weekly.tsx`) and folder/index (`events.index.tsx`). For a single-level route `/teams/$teamId/challenges` a flat `challenges.tsx` is idiomatic (matches e.g. `settings.tsx`, `notifications.tsx`). **Confirmed**.

---

## 10. Out of scope

- i18n admin page updates for the new keys (the admin page reads `messageKeys` from `@sideline/i18n/registry` automatically — no change required).
- Batch / season planning UI (multi-week creation).
- Manual Discord retry path (Part 2 follow-up — the 5-attempt cap + permanent stop is still in effect).
- Former-member badge in the grid ("(former)" tag for inactive members who completed historic challenges). Canonical §11 already defers this to v2.
- Removing the unused `WeeklyChallengeRpcGroup` (user-facing RPC group) from the domain barrel — left as a follow-up cleanup.
- Server-side per-user rate limiting on `markCompleted` (beyond client debounce). Repository idempotency + Postgres `ON CONFLICT DO NOTHING` already make spam harmless.

---

## 11. Implementation order

To minimise broken intermediate states for the tester writing tests first:

1. **Domain API group** (`packages/domain/src/api/WeeklyChallengeApi.ts`) + barrel exports → `pnpm --filter @sideline/domain build`. This unblocks all later imports.
2. **Repository integration tests** §7.1 — should pass immediately, since the repository already exists from Part 1. Any failure means we discovered a Part 1 bug.
3. **Server handler** `applications/server/src/api/weekly-challenge.ts` + wire into `api.ts` + `index.ts`.
4. **HTTP handler tests** §7.2 — written before the handler, fail-then-pass TDD.
5. **i18n keys** in cs.json + en.json.
6. **Install shadcn AlertDialog**: run `pnpm dlx shadcn@latest add alert-dialog` inside `applications/web/`. This generates `applications/web/src/components/ui/alert-dialog.tsx`; commit it. Required by the destructive delete-confirmation flow in the grid/list. Do this before the organisms in step 8.
7. **Web atoms / molecules** (`ChallengeKindBadge`, `ChallengeCompletionCell`, `WeekRangeLabel`, `MondayPicker`).
8. **Web organisms** (`WeeklyChallengesGrid`, `WeeklyChallengesList`, `NewChallengeDialog`, `EditChallengeDialog`).
9. **Web page** + **route** + sidebar nav entry.
10. **Web unit tests** §7.3.
11. **E2E spec** §7.4.

