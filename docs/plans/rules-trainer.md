# Plan: Ultimate Rules Trainer inside Sideline

**Branch:** `feat/rules-trainer` (this doc: `docs/rules-trainer-plan`)
**Source project:** `~/Projects/frisbee-rules` — currently deployed standalone at
[rules.sideline.cz](https://rules.sideline.cz) (109 situations, live 2026-08-24)
**Design spec:** _to be written_ (`docs/design/rules-trainer.md`)

## What exists today

A bilingual (EN/CS) interactive trainer for the **WFDF Rules of Ultimate 2025–2028**: animated
game situations, each resolved as a step-by-step outcome chain, plus an untimed exam. It is
**109 situations / 367 steps / 1182 options / 197 rule quotes** across 9 packages, every ruling
cited to an exact rulebook sub-number and verified against the source PDFs.

It ships today as one self-contained HTML file built from source:

| Piece | Size | Ports to Sideline? |
|---|---|---|
| `src/content/*.json` — situations, rule quotes, UI strings | ~740 KB | **Yes, verbatim.** Already pure bilingual data. |
| `src/engine/app.js` — the whole program | 34 KB / 658 lines | **Partly.** See the split below. |
| `src/styles.css` | 185 lines | No — replaced by Tailwind + shadcn. |
| `build.mjs` + `test/{independence,duplication,chains,mobile}.mjs` | — | Guards port to vitest; `chains` becomes a Playwright e2e. |

The content/engine split already done in the source project is what makes this tractable: the
content is portable data, and only the engine is DOM-bound.

## Decisions taken

Confirmed with the user before planning:

| Question | Decision |
|---|---|
| Which surfaces? | **Both public and members** — a free public trainer *and* member-only progress/leaderboards |
| Integration depth? | **Native React port**, not an iframe embed |
| Progress? | **Per-user progress plus team leaderboards** |

### Decision: a `@sideline/rules` package, not code inside `web`

Content and scoring logic go in a new workspace package `packages/rules/`, because three
consumers need them:

- `web` — renders the trainer.
- `server` — **scores submitted attempts**. The client must not report its own score, or the
  team leaderboard is trivially faked. The server needs the answer key, so the answer key has to
  live somewhere both can import.
- `bot` — plausible follow-up (a Discord rules quiz); the Discord-first architecture makes this
  likely enough to not paint ourselves into a corner.

```
packages/rules/
  src/content/*.json      the 109 situations, rule quotes, trainer UI strings
  src/engine/             PURE logic, no DOM: pool/score/answer state machine,
                          exam flow, per-run option shuffle, animation math
  src/index.ts            public API (must export everything consumers use)
  test/                   content guards as @effect/vitest
```

### Decision: scenario content stays inline-bilingual; only chrome goes through `@sideline/i18n`

Sideline's i18n is a Paraglide key catalogue (EN/CS, with DB-backed admin overrides). The
trainer's content is already `{en, cs}` on every field — 1182 options, 367 questions, 197 rule
quotes.

**Those do not become translation keys.** They are *content*, versioned alongside the rulebook
citations they encode, and pushing ~4000 strings into the catalogue would swamp the
`/admin/translations` UI for no benefit. Only the trainer's **chrome** (buttons, headings,
package names, score labels) goes through `tr()`.

The trainer's existing `ui.json` maps onto the catalogue; its `src/content/*.json` does not.

### Decision: rules practice is NOT an `ActivityLog` entry

Tempting, because `LeaderboardApi` already ranks team members and takes an `activityTypeId`
filter — we would get a leaderboard for free. **Rejected:** that leaderboard ranks by
`totalActivities`, `totalDurationMinutes` and streaks, i.e. *physical training volume*. Logging
quiz sessions there would inject "minutes" that mean something different into gym/running/
training aggregates, and `ActivityTypeSlug` is a closed literal union (`gym | running |
stretching | training`) that does not want a fifth member.

Instead: a dedicated rules leaderboard ranked on **mastery** (packages mastered, accuracy),
which is the thing worth competing on.

### Decision: reuse the Achievement system for milestones

`Achievement` is a code-defined catalogue (`ACHIEVEMENTS`, threshold-based, evaluated from
stats) with a `grantsDiscordRole` flag and a `CustomAchievement` escape hatch. Rules milestones
fit it exactly, and `grantsDiscordRole` gives a Discord "knows the rules" role with no new
machinery. Candidate slugs: `rules_first_exam`, `rules_package_mastered`,
`rules_all_packages`, `rules_perfect_exam`.

This does mean extending `AchievementSlug` and the evaluation input (which currently carries
`ActivityStats` + `countsBySlug`) with rules stats — a real but contained change.

## Phases

Each phase is independently shippable. Phase 1 delivers user-visible value with no schema work.

### Phase 0 — `@sideline/rules` (no UI)

1. Create the package; move `src/content/*.json` across as the single source of truth.
2. Port the pure logic out of `app.js`: `pool` `score` `answeredCount` `currentAnswer`
   `answerStep` `startExam` `examAnswer` `advanceExam` `permsFor` `shuffle` `animLimit`
   `pathTangents` `ipos`. These are already side-effect-free or trivially made so.
3. Port the content guards to `@effect/vitest`: the **build guards** (every scenario has
   `qAt < dur`, exactly one `ok:true` per step, every `§` chip resolves, both languages on every
   field, nothing positioned outside its own `view`), **independence**, and **duplication**.
   These have each caught real defects and must not be dropped in the move.

### Phase 1 — public `/rules`, native React, local-only progress

4. `applications/web/src/routes/rules.tsx` (+ `rules.$package.tsx`), outside `(authenticated)`.
5. `components/organisms/RulesTrainer/` — per Atomic Design, since it owns significant local
   state. The SVG field + animation runtime becomes a component driven by a
   `requestAnimationFrame` hook; the chain/exam/summary views become shadcn.
6. Progress in `localStorage`, exactly as today. No server, no auth, works offline.
7. **Lazy-load content per package.** At 740 KB (and growing toward 200 situations) the content
   must not sit in the main bundle — this was an optional win as a standalone site and is a
   requirement inside the app shell.
8. Add the content chunks to the service worker's `STATIC_CACHE` so the installed PWA works
   offline. This is the "app" half of "web and app", and it is genuinely useful — a rules
   argument at a tournament happens where there is no signal.

### Phase 2 — per-user progress (server-scored)

9. `packages/domain`: `models/RulesProgress.ts`, `api/RulesTrainerApi.ts` (`HttpApiGroup`
   `'rulesTrainer'`, `AuthMiddleware`). HTTP, not RPC — web-facing feature pages use the HTTP
   API; RPC groups here are bot-only.
10. Migration: attempts + per-scenario results.

    ```
    rules_attempts         id, user_id, team_id?, mode('practice'|'exam'),
                           packages, started_at, finished_at, score, total
    rules_scenario_results attempt_id, scenario_id, correct, steps(jsonb)
    ```

    Per-scenario rows are what make "you have mastered 7 of 9 packages" answerable without
    replaying every attempt.
11. Server handler + repository: client submits `{scenarioId, stepPicks[]}`, **server** computes
    correctness from `@sideline/rules`. Never trust a client-reported score.
12. Anonymous → logged-in: on login, offer to import `localStorage` progress.

### Phase 3 — team leaderboard + achievements

13. Rules leaderboard endpoint scoped to a team, ranked on mastery/accuracy, mirroring
    `LeaderboardApi`'s shape (rank, displayName resolution, `Forbidden` on non-membership) so the
    UI can reuse existing components.
14. Member route `(authenticated)/teams/$teamId/rules` — the same trainer organism plus a
    progress panel and the leaderboard.
15. Wire the new achievement slugs + optional Discord role.

### Phase 4 — cutover

16. Point `rules.sideline.cz` at the new route (redirect) or retire the subdomain.
17. **The risky step, and it has a known failure mode:** two apps must never claim the same host.
    Remove `ingress.host` from the majksa-projects `rules` app and merge that render PR
    **before** the new host goes live; verify a 200 after each step.
18. Archive the old `rules` app and delete `rules/` from `majksa-projects/static`.

## Risks

- **Animation fidelity is the subtle part.** The spoiler gate — the demo freezes at `qAt` and
  only plays its resolution once the last step is answered — is the trainer's single most
  important behaviour, and it has broken twice before (`s14` played its whole demo; locked steps
  leaked their key labels). It is currently guarded by a Playwright suite that drives all 109
  situations. **That suite must be ported to `e2e/`, not dropped**, or the port will regress it
  silently.
- **Motion quality.** Movement uses monotone cubic Hermite interpolation specifically because
  Catmull-Rom overshoots and would let a landed disc drift past its spot. Port `pathTangents` /
  `ipos` as-is; do not substitute a generic easing library.
- **Bundle size.** 740 KB of content today, ~1.4 MB at 200 situations. Phase 1 step 7 is not
  optional.
- **Content authoring must not fork.** Once content lives in `packages/rules`, the
  `frisbee-rules` repo must stop being a second source of truth. See open questions.

## Open questions

1. **Where does authoring live after the move?** Options: (a) move content + the rulebook PDFs
   into `packages/rules` and retire `frisbee-rules`; (b) keep `frisbee-rules` as the authoring
   repo and sync content in. (a) is cleaner but drags 2 MB of WFDF PDFs and the authoring docs
   into the monorepo. **Recommendation: (a)** — a second source of truth for content that encodes
   rule citations is the more expensive problem.
2. **Does the public trainer need SSR/SEO?** TanStack Start can server-render it. If the point is
   discovery ("free WFDF rules trainer"), it should; if it is just a member perk with a public
   door, client-only is simpler.
3. **Should the public trainer be per-locale routed** (`/en/rules`, `/cs/rules`) for SEO, or use
   the existing locale-persistence strategy?
4. **Leaderboard privacy.** Is a member's rules accuracy visible to the whole team, or only to
   themselves and captains? Accuracy is more personal than attendance.
5. **Czech content is AI-written and unreviewed** beyond the first 23 situations — a standing item
   from the source project. Shipping it on a Sideline-branded surface raises the bar; it wants a
   proofread before Phase 1 goes public.
