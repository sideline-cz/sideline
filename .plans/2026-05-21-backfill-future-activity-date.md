# Bug fix: allow backdating and future-dating activity logs (`makánicko`)

Notion: https://www.notion.so/36793506-0818-800b-9d73-c83e6f0c7b14
Branch: `feat/backfill-future-date-activity-logs`

## Problem

Activities can only be logged for the current day. The user wants past dates (backdating) and future dates (planned).

## Solution (high level)

Accept an optional date on the create-log and update-log paths, both HTTP API and RPC. On the web app, add a DatePicker to the create form and edit Sheet. On the Discord bot, add an optional `date` STRING option to `/makanicko log`. Default behaviour (no date supplied) is unchanged: use server "now".

## Design decisions

1. **Date contract**: `YYYY-MM-DD` string (matches the existing `DatePicker` output and Discord's STRING option capability).
2. **Timezone**: Server interprets `YYYY-MM-DD` as **noon Europe/Prague** → UTC. Anchoring at noon (not midnight) is DST-safe and stays inside the same Prague calendar day for the bucketed stats query (`(al.logged_at AT TIME ZONE 'Europe/Prague')::date`).
3. **Default**: Absent → server uses `DateTime.nowUnsafe()` (preserves the original "log at this exact moment" semantics, including time-of-day). The web create form keeps the picker **empty by default** with placeholder "Pick a date (defaults to today)" so the wire payload is `None` for the common case. The web edit Sheet pre-fills with the existing log's Prague-date for visibility, but only sends `Some(date)` if the user actually changed the picker (tracked via a "dirty" flag).
4. **Bounds**: ±2 years from today. Out-of-range → tagged error. Calendar widget `fromYear={currentYear-2}` / `toYear={currentYear+2}` so the bound is also enforced at the UI level.
5. **Same-day sort tiebreaker**: Add `, al.id DESC` to the `ORDER BY logged_at` clauses in the repository so two logs sharing a noon timestamp (and any other timestamp ties) sort deterministically. Apply to `findByMemberQuery` (display order) and `findAllQuery` (stats walk). Repo lines 99 and 113.
6. **Schema shape**: Use `Schema.OptionFromNullOr(LoggedAtDate)` for both HTTP and RPC payloads (matches existing precedent — `duration_minutes`, `note`).
7. **Update path guard ordering** in the repo: existence check → auto-source check → date mutation. (The existing pipeline already runs these in sequence; we just keep the order when adding `logged_at`.)
8. **Server is the single source of truth for date validity**. The bot does not duplicate regex validation; it forwards the string and maps the `ActivityLogInvalidLoggedAtDate` tagged error to a friendly message. Empty-string from Discord is coerced to `Option.none()` at the extraction boundary (matches existing `duration` extraction pattern in `log.ts`).
9. **Auto-source logs**: cannot be backdated. Web UI already gates the Edit/Delete buttons behind `log.source !== 'auto'` (`ActivityLogList.tsx:266`), and the server `update()` still runs the auto-source guard before the date mutation. No new code needed for this.

## Task list

### Domain — `packages/domain`

1. **`src/api/ActivityLogApi.ts`**
   - Add `LoggedAtDate = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)))`.
   - Add `loggedAtDate: Schema.OptionFromNullOr(LoggedAtDate)` to `CreateActivityLogRequest`.
   - Add `loggedAtDate: Schema.OptionFromNullOr(LoggedAtDate)` to `UpdateActivityLogRequest`.
   - Add tagged error `InvalidLoggedAtDate` (`'ActivityLogInvalidLoggedAtDate'`).
   - Wire `InvalidLoggedAtDate.pipe(HttpApiSchema.status(400))` into the `error` arrays of `createLog` and `updateLog` endpoints.

2. **`src/rpc/activity/ActivityRpcModels.ts`**
   - Add tagged error `InvalidLoggedAtDate` (same tag `'ActivityLogInvalidLoggedAtDate'`).

3. **`src/rpc/activity/ActivityRpcGroup.ts`**
   - Add `logged_at_date: Schema.OptionFromNullOr(Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))))` to `LogActivity` payload.
   - Add `InvalidLoggedAtDate` to the error `Schema.Union`.

4. **`src/models/ActivityLogDate.ts`** (new)
   - Export `parseLoggedAtDateInPrague(dateString: string): Option.Option<Date>` — pure function.
   - Validates calendar correctness (handles non-leap Feb 29 etc).
   - Enforces ±730 days from today-in-Prague.
   - Returns the UTC `Date` corresponding to 12:00 Europe/Prague on that date, using `Intl.DateTimeFormat` offset computation (no new deps).

5. **`src/index.ts`** — re-export the new helper alongside `ActivityLog`.

### Server — `applications/server`

6. **`src/repositories/ActivityLogsRepository.ts`**
   - Extend `UpdateInput` schema with `logged_at: Schema.Date`.
   - Add `logged_at = ${input.logged_at}` to the `UPDATE activity_logs SET ...` SQL.
   - Extend `update()` method input with `logged_at: Option.Option<Date>`; in the pipeline pass through, defaulting to `new Date(existing.logged_at)` on `Option.none()`.
   - Add `, al.id DESC` tiebreaker to `findByMemberQuery` (`ORDER BY al.logged_at DESC, al.id DESC`).
   - Add `, al.id` tiebreaker to `findAllQuery` (`ORDER BY al.logged_at, al.id`) — keeps streak walk deterministic.

7. **`src/api/activity-logs.ts`**
   - Import `parseLoggedAtDateInPrague`.
   - In `createLog`: resolve `payload.loggedAtDate` — `Some` parsed-or-fail with `InvalidLoggedAtDate`, `None` → `DateTime.toDateUtc(DateTime.nowUnsafe())`.
   - In `updateLog`: resolve `payload.loggedAtDate` — `Some` parsed-or-fail, `None` → pass `Option.none()` to the repo (which falls through to `existing.logged_at`).
   - Pass `logged_at` into `activityLogs.update(...)`.

8. **`src/rpc/activity/index.ts`**
   - Destructure `logged_at_date` from the payload.
   - Resolve via `parseLoggedAtDateInPrague`; `Some` invalid → `ActivityRpcModels.InvalidLoggedAtDate`; `None` → `DateTime.toDateUtc(DateTime.nowUnsafe())`.
   - Pass into `activityLogs.insert(...)`.

### Bot — `applications/bot`

9. **`src/commands/makanicko/index.ts`**
   - Add `{ name: 'date', description: 'Date of the activity (YYYY-MM-DD, defaults to today)', description_localizations: { cs: 'Datum aktivity (RRRR-MM-DD, výchozí dnes)' }, type: STRING, required: false }` to the `/makanicko log` options array.

10. **`src/commands/makanicko/log.ts`**
    - Extract `loggedAtDate` from options using the existing `Array.findFirst`/`Option.flatMap` pattern. Coerce empty string → `Option.none()`.
    - Forward as `logged_at_date` to `rpc['Activity/LogActivity']({...})`.
    - Add `Effect.catchTag('ActivityLogInvalidLoggedAtDate', () => Effect.succeed({ content: m.bot_makanicko_log_invalid_date(...) }))`.

### Web — `applications/web`

11. **`src/components/organisms/ActivityLogList.tsx`**
    - Add `import { DatePicker } from '~/components/ui/date-picker'`.
    - Create form: `const [dateInput, setDateInput] = React.useState<string>('')`. Render `<DatePicker value={dateInput} onChange={setDateInput} placeholder={tr('activityLog_datePlaceholder')} fromYear={now-2} toYear={now+2} />` between the activity-type pills and the duration row. **No `onClear`** (today is the implicit default).
    - On submit: `loggedAtDate: dateInput ? Option.some(dateInput) : Option.none()`.
    - Edit Sheet: `const [editDate, setEditDate] = React.useState('')`, `const [editDateDirty, setEditDateDirty] = React.useState(false)`. In `openEdit` derive the Prague-date string from `log.loggedAt` via `Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' })`. Render the same DatePicker between pills and duration. On change, set both state + dirty. On submit, send `loggedAtDate: editDateDirty ? Option.some(editDate) : Option.none()`.
    - Extend `onCreateLog` / `onUpdateLog` prop signatures with `loggedAtDate: Option.Option<string>`.

12. **`src/routes/(authenticated)/teams/$teamId/workout.tsx`**
    - Extend `handleCreateLog` / `handleUpdateLog` callback input types with `loggedAtDate`.
    - Pass through into the `payload` of both `createLog` and `updateLog` RPC calls.

### i18n — `packages/i18n`

13. **`messages/en.json`** + **`messages/cs.json`** — add:
    - `activityLog_dateLabel`: "Date" / "Datum"
    - `activityLog_datePlaceholder`: "Pick a date (defaults to today)" / "Vyber datum (výchozí dnes)"
    - `activityLog_invalidDate`: "Invalid date." / "Neplatné datum."
    - `bot_makanicko_log_invalid_date`: "Invalid date. Use YYYY-MM-DD." / "Neplatné datum. Použij RRRR-MM-DD."

### Docs

14. Update product docs and internal docs to reflect the new field:
    - `applications/docs/src/content/docs/guides/activity-tracking.mdx`
    - `applications/docs/src/content/docs/guides/discord-integration.mdx`
    - `applications/docs/src/content/docs/changelog.md` (plain-language entry)
    - Add a changeset at `.changeset/`

## Tests (TDD — written first)

### `packages/domain/test/models/ActivityLogDate.test.ts` (new)
- Valid YYYY-MM-DD → `Some(Date)` whose Prague-formatted date matches the input.
- Real leap day `2024-02-29` → `Some`.
- Non-leap Feb 29 (`2025-02-29`) → `None`.
- `2026-13-01` → `None`.
- `not-a-date` → `None`.
- DST spring-forward (`2026-03-29`) → result still falls on `2026-03-29` in Prague.
- DST fall-back (`2026-10-25`) → result still falls on `2026-10-25` in Prague.
- Today exactly → `Some`.
- > today+730d → `None`. < today−730d → `None`.

### `applications/server/test/api/activity-logs.test.ts` (extend)
- Extend the in-file `createLog` handler to mirror new production logic (parse `loggedAtDate`).
- Extend the in-file `updateLog` handler likewise.
- Extend the mock `update` to accept and persist `logged_at`.

New cases:
- `createLog` with `loggedAtDate=Some('2026-05-15')` → captured `logged_at` matches Prague-noon UTC.
- `createLog` with `loggedAtDate=None` → captured `logged_at` within 5s of `Date.now()`.
- `createLog` with invalid bound → `ActivityLogInvalidLoggedAtDate`; store unchanged.
- `createLog` with invalid calendar → `ActivityLogInvalidLoggedAtDate`.
- `updateLog` with `loggedAtDate=Some(...)` → persisted.
- `updateLog` with `loggedAtDate=None` → unchanged.
- `updateLog` with invalid → tagged error; record untouched.
- **Auto-source guard precedence**: `updateLog` on an auto-source log with any `loggedAtDate` → `ActivityLogAutoSourceForbidden`, not `InvalidLoggedAtDate`.

### `applications/server/test/rpc/activity.test.ts` (extend)
- Extend the in-file `Activity/LogActivity` handler to parse `logged_at_date`.
- Cases:
  - With `logged_at_date=Some('2026-05-15')` and UUID activity type → succeeds; inserted Date matches expected.
  - With `logged_at_date=None` → defaults to now (5s tolerance).
  - Invalid → `ActivityLogInvalidLoggedAtDate`.
  - Bounds → `ActivityLogInvalidLoggedAtDate`.

### Repository integration test (skip unless file already exists)
- Check `applications/server/test/integration/repositories/ActivityLogsRepository.test.ts`. If exists, add `insert + update with logged_at` and `update with None preserves logged_at`. Otherwise skip (covered via the mock-based API test).

## Edge cases (acknowledged but no code action needed)

- Achievement re-evaluation runs over all rows each time (`AchievementEvaluator` line 30+); backdated logs naturally flow into streak/leaderboard calculations. Once an achievement is earned, deleting/editing logs cannot un-earn it (`alreadyEarned` filter at line 42) — desired behaviour.
- `MemberInactive` and `Forbidden` guards already fire before the date logic in both HTTP and RPC handlers; no precedence regression.

## Files touched — summary

| Layer | File | Change |
|---|---|---|
| domain | `packages/domain/src/api/ActivityLogApi.ts` | add `LoggedAtDate`, `loggedAtDate` on create+update, `InvalidLoggedAtDate` |
| domain | `packages/domain/src/rpc/activity/ActivityRpcGroup.ts` | add `logged_at_date`, error to union |
| domain | `packages/domain/src/rpc/activity/ActivityRpcModels.ts` | add `InvalidLoggedAtDate` |
| domain | `packages/domain/src/models/ActivityLogDate.ts` | new helper |
| domain | `packages/domain/src/index.ts` | re-export |
| server | `applications/server/src/repositories/ActivityLogsRepository.ts` | `logged_at` in update, ORDER BY tiebreakers |
| server | `applications/server/src/api/activity-logs.ts` | resolve `loggedAtDate` in create + update |
| server | `applications/server/src/rpc/activity/index.ts` | resolve `logged_at_date` |
| bot | `applications/bot/src/commands/makanicko/index.ts` | add `date` option |
| bot | `applications/bot/src/commands/makanicko/log.ts` | extract+forward, catch invalid-date |
| web | `applications/web/src/components/organisms/ActivityLogList.tsx` | DatePicker in create + edit |
| web | `applications/web/src/routes/(authenticated)/teams/$teamId/workout.tsx` | thread `loggedAtDate` |
| i18n | `packages/i18n/messages/en.json` + `cs.json` | new keys |
| docs | `applications/docs/src/content/docs/...` + `.changeset/*.md` | new field documentation + changeset |
| tests | `applications/server/test/api/activity-logs.test.ts` | new cases |
| tests | `applications/server/test/rpc/activity.test.ts` | new cases |
| tests | `packages/domain/test/models/ActivityLogDate.test.ts` | new |
