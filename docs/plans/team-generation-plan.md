# Implementation Plan — Balanced Training Team Generator (Epic 6.3)

**Branch:** `feat/team-generation` · **Scope:** full story in one PR · **MVP:** 2 teams now, N-ready API.

This is the thesis centerpiece. Plan consolidates the architect + designer specs and resolves the hater's four blockers.

---

## Blocker resolutions (baked in)

1. **Cost-function normalization.** Each constraint term is normalized to `[0,1]` *before* weighting, so Elo (≈100s) no longer dwarfs size/gender (small ints):
   - `eloTerm = ratingSpread / SCALE_ELO` (SCALE_ELO ≈ 400, clamped to 1).
   - `sizeTerm = sizeImbalance / maxPossibleSizeImbalance`.
   - `genderTerm = genderImbalance / maxPossibleGenderImbalance`.
   - `cost = wElo*eloTerm + wSize*sizeTerm + wGender*genderTerm`. A unit test asserts a gender-weighted run changes assignments vs. an unweighted run.
2. **Stateless generate; outbox-backed post.** Nothing is persisted on generate. `post-teams-to-discord` re-derives the teams server-side from the trusted roster and enqueues them on the existing `event_sync_events` outbox (a `teams_generated` row with a `teams_payload` JSONB snapshot of just that delivery); the bot drains the outbox and posts the embed. **No dedicated snapshot table** is added. Only the *config weights* are persisted. Re-post is guarded by an atomic insert-if-not-pending on the outbox (rejects while a post is still unprocessed); editing the existing Discord message on repost is future work.

   > **As-built note:** the original draft assumed the post could reach the bot via a `SyncRpcs` RPC, but `SyncRpcs` is bot→server only — server→Discord must go through the event-sync outbox, which is what shipped.
3. **Separate `TeamGeneratorSection` organism** (designer's approach) — not an extension of `TrainingResultSection`. Generation and result-logging are distinct intents.
4. **Unknown gender = its own bucket**, excluded from the gender-balance penalty but counted for size. `InsufficientGenderMix` warns when the labeled population is too small to balance.

Other decisions: response schema is `Array<GeneratedTeam>` from day one; server validates `teamCount === 2` for MVP (N-ready model). Seed is an explicit constraint field; all collections sorted by `(rating desc, teamMemberId)` and swap ties broken by `(lowest cost, lowest member id)` for determinism. Generate / post / config all gated on `member:edit`.

---

## The algorithm (Tasks 1, 2, 3)

**`packages/domain/src/models/TeamGenerator.ts`** — pure, no Effect (mirrors `Elo.ts`).

- **Phase 1 — seed:** sort by Elo desc, snake-draft into N teams (1→N, N→1, …). O(n log n).
- **Phase 2 — refine:** hill-climbing — evaluate all single cross-team swaps, apply the best cost-reducing swap, stop at no-improvement or `maxIterations`. Deterministic with seeded xorshift PRNG for tie-breaks.
- **Cost:** normalized weighted sum (above).
- **Edge cases → `warnings`, never throws:** odd counts (snake-draft keeps max size diff 1 → `OddPlayerCount`), Elo outliers (mean ± k·σ → `EloOutlier`), insufficient gender mix (`InsufficientGenderMix`), `< teamCount` players (server maps to `InsufficientPlayers` 422).
- Exposes `snakeDraftOnly` helper so tests can prove local-search improves on the baseline.

**Thesis alternatives documented:** pure snake-draft (baseline), Karmarkar–Karp/largest-differencing, randomized restarts, exact ILP.

---

## Domain & persistence

- `packages/domain/src/models/TeamGenerator.ts` — engine (above).
- `packages/domain/src/models/TeamGenerationConfig.ts` — `Model.Class` (weights, default_team_count, max_iterations).
- `packages/domain/src/api/TeamGenerationApi.ts` — `teamGeneration` HttpApiGroup:
  - `POST /teams/:teamId/events/:eventId/generate-teams` → `Array<GeneratedTeam>` + warnings + enriched players (displayName, discordId, avatar, rating, isCalibrating, role, jerseyNumber, gender). Errors: `Forbidden(403)`, `InsufficientPlayers(422)`, `EventNotGeneratable(409)`.
  - `GET/PATCH /teams/:teamId/generation-config`.
  - `POST /teams/:teamId/events/:eventId/post-teams-to-discord` (payload = final assignment). Errors `Forbidden(403)`, `DiscordPostFailed(502)`.
- `packages/migrations/src/before/1789800000_create_team_generation_config.ts` — config table keyed by `team_id`, sensible defaults; constants fallback so no row is required to generate.
- `packages/domain/src/rpc/training/TrainingRpcGroup.ts` (+ merge into `SyncRpcs.ts`) — `Training/PostGeneratedTeams`.

## Server

- `applications/server/src/api/team-generation.ts` — handlers; extract shared `requireManageAccess` into `training-shared.ts`.
- `applications/server/src/repositories/TeamGenerationRepository.ts` — config CRUD + RSVP-yes-with-ratings(+default 1200)+gender(+role/jersey/avatar) join query.
- Wire `TeamGenerationApiLive` + repo layer where `PlayerRatingApiLive` is provided.

## Bot (Tasks 4, 6)

- `applications/bot/src/commands/training/index.ts` — add `generate` subcommand (event autocomplete, mirrors `result`); posts a deep-link to the web generator.
- `applications/bot/src/rcp/training/handlePostGeneratedTeams.ts` — resolves channel (reuse claim-request logic) + posts embed.
- `applications/bot/src/rest/events/buildGeneratedTeamsEmbed.ts` — training-green embed, one inline field per team, avg Elo in field name, `~` prefix for calibrating players. Gender **not** shown in the member-facing embed (privacy).

## Web (Tasks 5, 10, 12)

- `applications/web/src/components/organisms/TeamGeneratorSection.tsx` — new organism: Generate / Regenerate / Post-to-Discord toolbar, loading/empty/result/posted states, live balance summary (`aria-live`), warnings as inline notices.
- `applications/web/src/components/molecules/PlayerCard.tsx` — avatar + name + Elo (`tabular-nums`, calibrating badge) + gender icon (Mars/Venus/CircleDashed, accessible label, not colour-only) + role/jersey.
- **Manual swap (Task 10):** select-two-to-swap (accessible, touch-friendly), focusable cards with `aria-pressed`, "Edited" badge + "Reset to generated". Drag-and-drop deferred as enhancement.
- `applications/web/src/routes/(authenticated)/teams/$teamId/events.$eventId.tsx` — load `generationConfig`, pass `canGenerate` down; insert section with same gating as `TrainingResultSection`.
- **Admin weights (Task 9):** `WeightSliderField` molecule + weights card on `TeamSettingsPage` — sliders 0–100 with normalized-percent readout, number-of-teams + max-size-diff inputs, Save / Reset-to-defaults.

## i18n

Add `teamGen_*` / `gender_*` (web) and `bot_teamGen_*` (bot) keys to `packages/i18n/messages/{en,cs}.json`.

---

## Tests (Task 7)

- **`packages/domain/test/TeamGenerator.test.ts`** (centerpiece, pure `@effect/vitest`): even split equal ratings (spread 0); snake-draft balance bound; local-search beats `snakeDraftOnly`; determinism (same seed → identical); partition invariant (every player once, none dropped) over many seeds; odd count → sizes {4,3} + warning; Elo outlier warning; insufficient gender mix; gender weighting actually shifts assignments; `maxIterations=0` returns seed unchanged; finite-invariants (no NaN, spread ≥ 0, iters ≤ max).
- **`applications/server/src/api/team-generation.test.ts`**: non-training → `EventNotGeneratable`; `< teamCount` → `InsufficientPlayers`; no `member:edit` → `Forbidden`; happy path partitions roster with enriched fields + default 1200; config PATCH admin gating + GET round-trip.
- Repository test for the join (default rating, `Option.none` gender).

---

## Thesis docs (Tasks 8, 11)

- `docs/thesis/team-generation-algorithm.md` — problem formalization (multi-way balanced partitioning w/ side constraints), chosen design, normalized cost function, complexity, edge cases, public signature.
- `docs/thesis/team-generation-evaluation.md` — comparison of approaches, evaluation methodology + results (spread / runtime / constraint satisfaction across team sizes), discussion. References the test file as reproducibility artifact.

---

## Build order & risks

1. Domain models/api/engine → `pnpm build` → migrations → server → bot → web.
2. TDD: write `TeamGenerator.test.ts` first (pure, runs before any integration).
3. Risks: domain rebuild gating; migration timestamp must exceed `1789700000`; gender optionality; determinism (seeded PRNG, stable sorts); 2-team validation keeps API N-ready.
4. Add a changeset.
