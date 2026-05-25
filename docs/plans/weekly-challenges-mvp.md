# Weekly Challenges MVP — Final Plan

> Notion: Sportovní aktivity (`35e93506-0818-80ca-b9d5-c051ee3b46db`)
> Branch: `fix/sportovni-aktivity`

## 1. Goal

Port the "Poletíme Házecí Výzva" Excel sheet into Sideline as a real feature. A captain posts one challenge per week (kind = **throwing** or **sport**). Members self-mark completion. Discord announces the challenge when its week begins.

## 2. Data model

### Tables (migration `1787000000_create_weekly_challenges.ts`)

```sql
CREATE TABLE weekly_challenges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  week_start_date DATE NOT NULL,                          -- Monday in team TZ
  kind            TEXT NOT NULL CHECK (kind IN ('throwing','sport')),
  title           TEXT NOT NULL,                          -- ≤120 chars
  description     TEXT,                                   -- optional, ≤2000 chars
  created_by      UUID NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, week_start_date)
);

CREATE TABLE weekly_challenge_completions (
  challenge_id UUID NOT NULL REFERENCES weekly_challenges(id) ON DELETE CASCADE,
  member_id    UUID NOT NULL REFERENCES team_members(id)    ON DELETE CASCADE,
  PRIMARY KEY (challenge_id, member_id)
);

CREATE TABLE weekly_challenge_sync_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  challenge_id  UUID NOT NULL REFERENCES weekly_challenges(id) ON DELETE CASCADE,
  channel_id    TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,                     -- week_start_date 09:00 team.tz
  attempts      INT NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ
);

CREATE INDEX idx_wc_team_week ON weekly_challenges (team_id, week_start_date DESC);
CREATE INDEX idx_wcse_due     ON weekly_challenge_sync_events (team_id) WHERE processed_at IS NULL;
```

### Domain schemas (`packages/domain/src/models/WeeklyChallenge.ts`)

- `WeeklyChallengeKind = 'throwing' | 'sport'`
- `WeeklyChallengeTitle` — non-empty, ≤120
- `WeeklyChallengeDescription` — ≤2000, optional
- `WeeklyChallenge` model class with all DB fields
- `WeeklyChallengeView = { challenge, completedMemberIds[], isActive }`

## 3. RPC API

`packages/domain/src/rpc/weeklyChallenge/WeeklyChallengeRpcGroup.ts`

| RPC | Payload | Returns |
|---|---|---|
| `List` | `{ teamId, limit? = 12 }` | `Array<WeeklyChallengeView>` (newest first) |
| `Create` | `{ teamId, weekStart, kind, title, description? }` | `WeeklyChallenge` |
| `UpdateTitleDescription` | `{ challengeId, title, description? }` | `WeeklyChallenge` |
| `Delete` | `{ challengeId }` | `void` |
| `MarkCompleted` | `{ challengeId }` | `void` |
| `UnmarkCompleted` | `{ challengeId }` | `void` |

`MarkCompleted` / `UnmarkCompleted` resolve `member_id` from the session — no member id ever crosses the wire.

### Error tags

| Tag | HTTP | When |
|---|---|---|
| `WeeklyChallengeNotFound` | 404 | id lookup miss |
| `WeeklyChallengeNotActive` | 409 | mark/unmark on non-current-week challenge |
| `WeeklyChallengeAlreadyExistsForWeek` | 409 | UNIQUE conflict |
| `WeeklyChallengeWeekOutOfRange` | 422 | `weekStart < currentMonday` OR `> currentMonday + 8w` |
| `WeeklyChallengeForbidden` | 403 | non-captain creating/deleting; non-member marking |

## 4. Authorization

- **View**: any team member
- **Create / Update / Delete**: captain only (look up via `MemberRolesRepository`)
- **Mark / Unmark**: only for self, only on the **current ISO week** for the team's timezone

## 5. Timezone correctness (hater BLOCKER fix)

- `currentTeamMondayDate(teamTz): DateString` helper — `weekRangeFor(now, teamTz).startAt` formatted as `YYYY-MM-DD` in team TZ.
- Used on Create (server derives the stored `week_start_date`) and on Mark/Unmark (compares stored date to current Monday).
- DST boundary covered by domain test.

## 6. Concurrency & identity (hater BLOCKER fix)

- Mark/Unmark wraps in `sql.withTransaction`:
  1. `SELECT week_start_date FROM weekly_challenges WHERE id = $1 FOR UPDATE`
  2. assert `week_start_date == currentTeamMondayDate(team.tz)`
  3. `INSERT ... ON CONFLICT DO NOTHING` (mark) or `DELETE` (unmark)
- `assertActiveTeamMember(userId, teamId)` resolves the member from session before the transaction.
- `ON DELETE CASCADE` on completions; deleted-challenge race surfaces as 404.

## 7. Discord integration (hater BLOCKER fix)

- Sync event enqueued at Create with `scheduled_for = week_start_date 09:00 team.tz`.
- Processor (`applications/bot/src/rpc/weeklyChallenge/ProcessorService.ts`) drains rows where `processed_at IS NULL AND scheduled_for <= now()`.
- Catches Discord errors `10003 Unknown Channel`, `50001 Missing Access`, `50013 Missing Permissions` → records `last_error`, increments `attempts`, stops after 5.
- Reuses team's existing announcement channel (no new `team_settings` column).

## 8. UI (designer spec)

### Page: `/teams/$teamId/challenges`
- Desktop grid: rows = active team members, columns = up to 12 most recent weeks, sticky first column, horizontal scroll.
- Current week column highlighted with `bg-primary/5 border-x border-primary/30`; header shows `tento týden` badge.
- Cells: ✓ (completed) / ✗ (not completed, past) / — (empty / future).
- Current user's row on active week: Shadcn `Toggle` ("Označit splněno" / "Splněno ✓"). 400 ms client debounce.
- Captain controls: top-right "+ Nová výzva" button, per-column kebab `[⋮]` → Smazat / Upravit text.
- Mobile: vertical card list, one card per week, current week pinned on top.
- Empty state, loading skeleton, error alert with retry.

### Modal: "Nová týdenní výzva"
- `ToggleGroup` (Throwing 🥏 / Sport 🏃), Monday-only `DatePicker` (default = next un-used Monday), title (counter), optional description (counter).
- Inline validation for required title and "week already taken".

### Discord embed
- Title prefixed with kind emoji ("🥏 Nová týdenní výzva: {title}" / "🏃 ...").
- Color: emerald (throwing) / amber (sport).
- Inline fields: Druh, Týden (e.g. "10.3. – 16.3.").
- Description as embed body (omitted when empty).
- Embed URL = deep link to `/teams/{teamId}/challenges`.

### i18n
- Czech-primary keys with English fallbacks (`challenges_*`).
- Gender-neutral wording: `Pro kapitány:` not `Kapitáne`.

## 9. Files

### New
- `packages/migrations/src/before/1787000000_create_weekly_challenges.ts`
- `packages/domain/src/models/WeeklyChallenge.ts`
- `packages/domain/src/rpc/weeklyChallenge/{WeeklyChallengeRpcGroup,WeeklyChallengeSyncEvents,index}.ts`
- `applications/server/src/repositories/WeeklyChallengeRepository.ts`
- `applications/server/src/api/weekly-challenge.ts`
- `applications/server/src/helpers/weeklyChallenge.ts` (`currentTeamMondayDate`, `assertActiveTeamMember`)
- `applications/bot/src/rpc/weeklyChallenge/ProcessorService.ts`
- `applications/web/src/routes/teams/$teamId/challenges.tsx`
- `applications/web/src/components/{pages/WeeklyChallengesPage, organisms/WeeklyChallengesGrid, organisms/WeeklyChallengesList, organisms/NewChallengeDialog, organisms/EditChallengeDialog, molecules/ChallengeKindBadge, molecules/ChallengeCompletionCell, atoms/WeekRangeLabel}.tsx`
- Test files (see §10)

### Modified
- `packages/domain/src/models/index.ts`, `packages/domain/src/index.ts`, `packages/domain/src/rpc/SyncRpcs.ts`
- `applications/server/src/api/{api,index}.ts`, `applications/server/src/AppLive.ts`
- `applications/bot/src/AppLive.ts`
- `applications/web/src/i18n/{cs,en}.ts`, team layout/sidebar nav
- `docs/database.md`, `docs/api.md`, `docs/thesis/er-diagram.md`, `docs/thesis/use-cases.md`

## 10. Tests (TDD)

### Domain (`packages/domain/test/models/WeeklyChallenge.test.ts`)
1. Kind rejects unknown values
2. Title rejects empty / >120
3. Description decodes null → `Option.none()`

### Repository (`applications/server/test/integration/repositories/WeeklyChallengeRepository.test.ts`)
1. Insert + list returns `completedMemberIds: []`
2. Duplicate week → `WeeklyChallengeAlreadyExistsForWeek`
3. `markCompleted` idempotent (no error on second call)
4. `unmarkCompleted` of non-existent row is no-op
5. `delete` cascades completions
6. `currentTeamMondayDate` returns team-TZ Monday across DST boundary
7. Two teams in different timezones on same UTC instant resolve to different Mondays when needed

### Handler (`applications/server/test/api/weekly-challenge.test.ts`)
1. Non-captain Create → `Forbidden`
2. Captain Create valid → success + sync event enqueued with `scheduled_for`
3. Create with `weekStart` 9 weeks ahead → `WeekOutOfRange`; 8 weeks ahead → ok
4. Create in the past → `WeekOutOfRange`
5. `MarkCompleted` on past week → `NotActive`
6. `MarkCompleted` on current week → success; second call idempotent
7. `MarkCompleted` resolves member from session (spoofed body member ignored)
8. Non-member calling `MarkCompleted` → `Forbidden`
9. `UpdateTitleDescription` preserves completion count
10. Captain Delete cascades

### Bot (`applications/bot/test/rpc/weeklyChallenge/ProcessorService.test.ts`)
1. Future `scheduled_for` event is skipped
2. Discord error `10003` records `last_error`, increments `attempts`, doesn't crash
3. After 5 attempts the event stops being retried

### Web E2E (`e2e/tests/weekly-challenges.spec.ts`)
1. Captain creates a challenge, ticks own row, reloads — still ticked

## 11. Known limitations (deferred, will be noted in PR)

- Former members: completion rows kept, displayed without "(former)" badge in v1 (cosmetic, no extra logic).
- No batch / season planning UI.
- Discord retries cap at 5; manual replay path is v2.
- Toggle abuse protected by 400 ms debounce + server idempotency only.
