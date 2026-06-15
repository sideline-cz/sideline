# Elo Rating System — Implementation Plan

**Story:** As a system, I maintain Elo ratings for all players (Epic 6.1)
**Branch:** `feat/elo-rating-system`

Tracks individual player skill ratings derived from team game results, with persisted history and a coach/admin-only profile display.

---

## 1. Decision: Elo variant

**Standard Elo, team-average, integer-stored, K-factor calibration.**

- Inputs are team-based W/L only — Glicko/Glicko-2 need richer per-match data to pay off. Standard Elo is a pure, deterministic, trivially-testable function.
- Team strength = mean of member ratings; one expected score per side; per-team delta applied to every player using that player's own K-factor.
- Constants (single source of truth in `Elo.ts`): `DEFAULT_RATING = 1200`, `CALIBRATION_GAMES = 10`, `K_CALIBRATION = 40`, `K_ESTABLISHED = 20`.

> No game/match result entity exists in the codebase today. Scope = **engine + storage + display + a manual coach-gated "apply game result" write endpoint**. A future Games epic reuses the same repository.

---

## 2. Domain package (`@sideline/domain`)

- **`models/Elo.ts`** (new, pure — no Effect/IO):
  - `expectedScore(a, b) = 1 / (1 + 10 ** ((b - a) / 400))`
  - `kFactor(gamesPlayed) = gamesPlayed < CALIBRATION_GAMES ? 40 : 20`
  - `computeTeamGameUpdate({ teamA, teamB, outcome })` → per-player `{ oldRating, newRating, delta, kFactor }`. Guards empty team (returns empty, no NaN). Rounds final rating. Doc note: per-player K + rounding ⇒ not strictly zero-sum (intentional, like chess).
- **`models/PlayerRating.ts`** (new): `PlayerRating` + `PlayerRatingHistoryEntry` `Model.Class` with branded ids.
- **`api/PlayerRatingApi.ts`** (new): `HttpApiGroup` (see §5).
- **`index.ts`**: namespace exports.
- `Roster.ts` is **NOT** changed — Elo never rides on `member:view`-gated payloads (avoids leaking to Players).

---

## 3. Database (migration in `packages/migrations/src/before/`)

```
player_ratings(
  id, team_id→teams, team_member_id→team_members UNIQUE,
  rating INT default 1200, games_played, wins, losses, draws,
  created_at, updated_at)
  index (team_id, rating DESC)

player_rating_history(
  id, team_id→teams, team_member_id→team_members,
  rating_before, rating_after, delta INT,
  result CHECK in ('win','loss','draw'),
  game_id UUID NULL (forward-compat, no FK yet),
  submitted_by UUID NULL→team_members (audit),
  created_at)
  index (team_member_id, created_at DESC, id DESC)
```

---

## 4. Repository (`applications/server`)

`PlayerRatingsRepository.ts` (new), registered in `AppLive.ts`:
- `getMemberRating` — single query with `LEFT JOIN LATERAL` onto most-recent history row → returns rating + `previousRating`/`lastDelta` for the trend (no second call).
- `getTeamRatings`, `findHistoryByMember`.
- `getOrInitMany` — `INSERT ... ON CONFLICT DO NOTHING` at `DEFAULT_RATING`.
- `applyGameUpdates` — inside `sql.withTransaction`: ensure rows, **lock all affected rows in one `SELECT ... FOR UPDATE ORDER BY team_member_id`** (deadlock-safe), run engine, UPDATE ratings + counters, INSERT history rows (with `submitted_by`).

---

## 5. API (gate = `member:edit`, server-enforced)

All endpoints gated on `member:edit` (held by Admin + Captain; **not** Player) + explicit global-admin branch. Reads are **not** on `roster:view`.

| Endpoint | Method | Returns |
|---|---|---|
| `getTeamRatings` | GET `/teams/:teamId/ratings` | ranked entries + `canManage` |
| `getMemberRating` | GET `/teams/:teamId/members/:memberId/rating` | `MemberRatingResponse` |
| `getMemberRatingHistory` | GET `.../rating/history` | history entries |
| `applyGameResult` | POST `/teams/:teamId/ratings/games` | updated ratings |

`MemberRatingResponse`: `{ rating, gamesPlayed, previousRating: Option, lastDelta: Option, wins, losses, draws, isCalibrating, calibrationThreshold }`.

`applyGameResult` validates both teams non-empty + disjoint → typed `InvalidGameResult` **before** the engine. `submitted_by` = acting member (sentinel global-admin → null). Double-submit idempotency = accepted limitation (documented).

---

## 6. Web display (coach/admin only)

- **`MemberRatingCard.tsx`** (new organism) — Shadcn `Card`: big rating number, trend indicator (↑/↓/→ + signed delta, color + icon + aria-label), W/L/D record grid, calibration `Badge` + progress when `isCalibrating`, tooltip. Presentational; data via props.
- **`PlayerDetailPage.tsx`** — render `{canEdit && rating ? <MemberRatingCard/> : null}` near `ActivityStatsCard`.
- **`members.$memberId.tsx` loader** — add `getMemberRating` to the `Effect.all`, graceful catch (absent → omit card, matching `activityLogs`). `canEdit` already from `member:edit`.
- **i18n** — new `members_rating*` keys in `en.json` + `cs.json` using Paraglide interpolation (`{played}/{threshold}`, `{delta}`, etc.).
- Calibration denominator always from API `calibrationThreshold` (never hardcoded).

---

## 7. Tests

- **`packages/domain/test/Elo.test.ts`** — expectedScore (equal=0.5, symmetry, 400-gap≈10/11, large gaps strict bounds), kFactor boundary (9→40, 10→20), team update (equal teams win/draw/loss, calibration K doubling, upset magnitudes, team-average equivalence, unequal sizes, empty team no-NaN), zero-sum unrounded for equal-K only.
- **Repository integration** (testcontainers) — getOrInitMany seeding/idempotency, applyGameUpdates rating+counters+history+submitted_by, ordering, FK cascade, concurrent serialize.
- **API** — gate matrix (Player→Forbidden, Captain/Admin/global-admin→allowed), trend DTO, validation errors, RosterPlayer-has-no-Elo leak regression.
- **Mock-layer cascade** — add a `PlayerRatingsRepository` mock only where the compiler demands it after registering in `AppLive`.

---

## 8. Task → files map

| Task | Files |
|---|---|
| 1 DB model | `PlayerRating.ts`, migration, `index.ts` |
| 2 Variant | documented; constants in `Elo.ts` |
| 3 Engine | `Elo.ts`, repo `applyGameUpdates`, handler |
| 4 Calibration | `Elo.ts` `kFactor` + seeding |
| 5 History | history table + model + repo |
| 6 Display | `PlayerRatingApi.ts`, `player-rating.ts`, web card + page + loader + i18n |
| 7 Tests | `Elo.test.ts` + repo/API tests |

## 9. Build/ship notes

- `pnpm build` after domain edits (server/tests need fresh `dist/`).
- Doc sync: `docs/database.md`, `docs/api.md`, `docs/thesis/er-diagram.md`, use-cases; changeset (minor) for domain/server/migrations/web.
