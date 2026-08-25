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
| `src/content/*.json` — situations, rule quotes, UI strings | 1.10 MiB | **Yes, verbatim.** Already pure bilingual data. |
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
| Authoring repo? | **`frisbee-rules` is retired** — content, the WFDF source PDFs and the authoring docs all move into `packages/rules` |
| Leaderboard visibility? | **Self and captains only** — a member sees their own standing; captains see the team |
| Public discovery? | ⚠️ **Revised in Phase 1: per-locale routes, client-rendered, NOT indexable.** See below |
| Czech content? | **Proofread gates the public launch** — see Phase 1 |

### Decision: a `@sideline/rules` package, not code inside `web`

Content and scoring logic go in a new workspace package `packages/rules/`, because three
consumers need them:

- `web` — renders the trainer.
- `server` — **scores submitted attempts** with shared logic, so scoring lives in one place
  rather than being reimplemented per consumer. ⚠ **Corrected during Phase 0:** an earlier
  draft justified this as "the client must not report its own score, or the team leaderboard is
  trivially faked". That is not achievable and never was — see the honour-system decision below.
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

### Decision: the trainer is client-rendered — the SSR/indexability goal is dropped

⚠️ **Reverses this plan's original "SSR + per-locale routes so both languages are indexable".**
That was not achievable by adding a route, and the reason is structural rather than incidental:

- `applications/web/src/routes/__root.tsx` sets `ssr: false` on the **root** route, and
  `src/router.tsx` declares `defaultSsr: false` at the type level. `vite.config.ts` additionally
  sets `prerender: { enabled: false }`.
- The cause is documented in `router.tsx`: Effect's `Option` uses branded phantom types containing
  function signatures, which fail TanStack's compile-time serialization check. The root
  `beforeLoad` returns `userOption: Option<User>`, which poisons every descendant route.
- A child route cannot re-enable SSR above a non-SSR parent, so `ssr: true` on `/en/rules` alone
  does nothing. The e2e suite already encodes the consequence: *"the raw HTML shell never contains
  a `<header>`"*.

**Decided: accept client rendering and drop the SEO goal.** Consequences to hold onto:

- **Per-locale routes are still right**, just for different reasons — an explicit, shareable
  language choice and a clean split for the Czech review gate. They are no longer an SEO measure,
  so do not justify future work by appealing to indexability.
- **This weakens the Czech gate's own rationale.** The gate was written against an *SSR-indexed,
  Sideline-branded* `/cs/rules`; un-indexed, the exposure is much closer to today's
  rules.sideline.cz. The gate is kept anyway (it costs nothing and in-app exposure is still real),
  but it is no longer urgent. `packages/rules/authoring/czech-review-checklist.md` is the
  clearing mechanism.
- The genuine fix, if indexability ever matters, is registering `serializationAdapters` for
  Effect's `Option` so the whole app can server-render. That benefits every route and is its own
  project — not something to smuggle into a feature PR.

### Decision: the leaderboard is an honour system — and cannot be anything else

Settled in Phase 0, after the "server-scored so it can't be faked" rationale turned out to be
unachievable.

Two requirements in this plan are mutually exclusive for the same 109 scenarios:

- Phase 1 ships an **offline-capable public PWA** with instant verdicts and rule explanations
  ("a rules argument at a tournament happens where there is no signal"). That requires the answer
  key on the device.
- Exam integrity requires the answer key **not** to be on the device.

Measured facts that close the argument: `ok:true` sits at option index **0 in all 367 steps**, and
picks are original option indices, so a client posting `[0,0,0]` scores 100% on every scenario.
Even randomising authoring order would not help, because the `ok` flags ship inside the content
chunk that offline practice depends on. Serving exam questions from the server changes nothing —
they are drawn from the same scenarios the user already downloaded.

**Therefore:** `scoreAttempt` in `@sideline/rules` is *shared scoring logic, not a trust
boundary*, and the rules leaderboard is social rather than competitive. It must never gate
anything that matters. Documented in `packages/rules/AGENTS.md` so it is not mistaken for
security later.

The genuinely secure alternative — a server-only exam pool never shipped to the client — needs
content that does not exist and is not costed in any phase here. If the leaderboard ever needs to
mean something, that is the work, and it is a content project, not an API change.

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

### Phase 0 — `@sideline/rules` (no UI) — ✅ DONE

Delivered: the package (three subpath exports — `.`, `/content`, `/reference`), the content, the
pure engine (`state` `anim` `answer` `chain` `exam` `perms` `pool` `score` `locale`), and 123
tests. Notes on what changed versus this plan's original text:

- **Guards use plain `vitest`, no Effect anywhere** — `packages/template-renderer`'s precedent,
  because the engine is called from React render and from `requestAnimationFrame` at 60 fps.
- **`chainView` was pulled forward from Phase 1.** The "locked steps leaked their key labels"
  regression lives in the old `chainHTML`, so the decision logic is now a pure, table-tested
  function and Phase 1's component is a dumb map over it.
- **Four content defects fixed**, each verified zero-visual-change or a genuine bug:
  - 6 fx authored `type:"zone"` rendered nothing (`buildFx` only branches on
    `bubble|flash|mark|arrow`); deleted, reauthoring filed in `authoring/content-backlog.md`
  - 23 scenarios carried a dead pre-chain `options` array (51 KB), read by nothing; deleted
  - 57 dead `r` values on `x`/`target`/`dot` marks (`f.r` is read only in the `zone` branch)
  - **the exam could never draw from level 9** — 11 topic strings for 9 packages meant
    `slice(0, EXAM_N)` dropped the last bucket and the fill path was dead. Topics normalised to
    one per level, and `startExam` now buckets by `level`, shuffles before slicing, and
    round-robins the fill.
- **A guard that silently checked English only** — `HARDCODED_COUNT`'s Czech alternatives could
  never match, because JavaScript's `\b` is ASCII-only and "situací" ends in "í". Fixed with a
  Unicode-aware lookahead. It mattered because Czech is the unreviewed half of the content.
- `ui.json` lives in `authoring/`, not `src/` — it is the **input** to Phase 1's i18n catalogue
  migration, not a runtime dependency, so the trainer does not grow a second translation
  mechanism alongside `tr()`.

1. Create the package; move `src/content/*.json` across as the single source of truth.
2. Port the pure logic out of `app.js`: `pool` `score` `answeredCount` `currentAnswer`
   `answerStep` `startExam` `examAnswer` `advanceExam` `permsFor` `shuffle` `animLimit`
   `pathTangents` `ipos`. These are already side-effect-free or trivially made so.
3. Port the content guards to plain `vitest` — **not** `@effect/vitest`: the **build guards** (every scenario has
   `qAt < dur`, exactly one `ok:true` per step, every `§` chip resolves, both languages on every
   field, nothing positioned outside its own `view`), **independence**, and **duplication**.
   These have each caught real defects and must not be dropped in the move.

### Phase 1 — public `/rules`, native React, local-only progress

**Gate: the Czech proofread must land before this ships publicly** (see Risks). The trainer is
already live in Czech at rules.sideline.cz, but a Sideline-branded, SSR-indexed page teaching
rules to Czech players is a higher bar than a side-project subdomain.

4. Routes under `applications/web/src/routes/`, outside `(authenticated)`, **per-locale and
   client-rendered** (see the SSR decision above — `ssr: false` is mandatory, and indexability is
   not on the table): `/en/rules` and `/cs/rules`, plus `/rules` redirecting to the negotiated
   locale.

   Use **explicit route files** (`en.rules.tsx`, `cs.rules.tsx`), not a `$lang` param: a
   top-level dynamic segment competes greedily with the existing `/invite/$code`,
   `/onboarding/$token` and `(authenticated)` routes. Two locales, two two-line files.

   Locale must be threaded from the route as an explicit prop, **not** read from Paraglide.
   `getLocale()` resolves via `localStorage → cookie → preferredLanguage → baseLocale` with no
   `url` strategy, so on `/cs/rules` it will happily return `en` and the URL will silently
   disagree with the rendered language. `tr()` takes an explicit locale as its third argument
   (`src/lib/translations.ts`); content uses `text(localized, locale)` from `@sideline/rules`.
   Adding a `url` strategy would change locale resolution for every existing route and for the
   bot and server too — out of scope.
5. `components/organisms/RulesTrainer/` — per Atomic Design, since it owns significant local
   state. The SVG field + animation runtime becomes a component driven by a
   `requestAnimationFrame` hook; the chain/exam/summary views become shadcn.
6. Progress in `localStorage`, exactly as today. No server, no auth, works offline.
7. **Lazy-load content per package.** At 740 KB (and growing toward 200 situations) the content
   must not sit in the main bundle — this was an optional win as a standalone site and is a
   requirement inside the app shell.
8. Make the installed PWA work offline. This is the "app" half of "web and app", and it is
   genuinely useful — a rules argument at a tournament happens where there is no signal.

   Two corrections from measuring the actual build:
   - **The content chunks are already cached.** Vite rewrites the JSON imports into `.js` chunks,
     so `request.destination === 'script'` and `sw.js`'s existing `CacheFirst` route picks them up
     with no change. An earlier worry that a `.json` fetch has `destination === ''` and would be
     skipped does not apply — there are no `.json` requests at runtime.
   - **The real problem is cache capacity, and it predates the trainer.** `applications/web` ships
     **192 JS chunks** against `ExpirationPlugin`'s `maxEntries: 100`. LRU eviction therefore
     already churns the app shell, and adding nine content chunks means practising rules can evict
     app chunks and vice versa — so "works offline" is unreliable *today*, before the trainer.
     Give rules content its **own** cache (its own `maxEntries` and a longer `maxAgeSeconds`,
     matched on the content chunk URL pattern) rather than letting it compete in `STATIC_CACHE`,
     and remember a new cache name must be added to `EXPECTED_CACHES` or it is purged on every
     activate. Raising `STATIC_CACHE`'s own limit is a separate, app-wide fix worth doing on its
     own merits.
9. **Surface it on the sideline.cz homepage.** `HomePage.tsx` is a hero (headline, subheadline,
   Discord CTA, three `hero_feature_*` badges) over a demo bento grid (`DemoStats`,
   `DemoUpcomingEvents`, `DemoLeaderboard`, `DemoRsvpBanner`, `DemoFinance`,
   `DemoAchievements`). Add:
   - a fourth hero badge (`hero_feature_rules`, `BookOpen` from `lucide-react`) alongside
     team/events/workout;
   - a bento card for the trainer that, unlike its siblings, is a **real link** rather than a
     static demo — it is the one thing on that page a visitor can use without signing in;
   - new `tr()` keys in `@sideline/i18n` for both.

   This must ship **in the same change as the route**, or the homepage links to a 404.

**Phase 1 acceptance criteria** (carried over from Phase 0, which could not verify them without a
real web consumer):

- ~~**Verify the chunk split for real.**~~ ✅ **Already verified during Phase 0**, so this is no
  longer a Phase 1 unknown. Through Vite/Rollup, `import { pool } from '@sideline/rules'` pulls
  **1203 bytes and zero JSON chunks**, and `PACKAGE_LOADERS` splits into **nine separate chunks**
  (83–172 KB raw / 21–40 KB gz). Vite also rewrites
  `import('./01-pull.json', { with: { type: 'json' } })` into `import('./01-pull-<hash>.mjs')`,
  correctly dropping the attribute because the target is no longer JSON — so the
  `ERR_IMPORT_ATTRIBUTE_MISSING` concern does not apply on the web side. Still worth a spot-check
  once a real route exists, but the design is proven, not hoped for.
  (Note: esbuild with `--splitting` emits dead async chunks here even though the entry itself
  tree-shakes to 859 B. That is an esbuild artifact; Vite is what `web` uses.)
- ~~**Port the Playwright suite**~~ ✅ **DONE** (`e2e/tests/rules-trainer.spec.ts` +
  `rules-trainer-mobile.spec.ts`). It covers all 109 situations on **every PR**, split into nine
  per-level tests so the existing 8-way sharding distributes it (3.5 min at 4 workers, vs 10.6
  min as one serial sweep).

  Two things worth carrying forward:
  - The port could not transliterate the prototype. It asserted through globals (`anim.t`,
    `anim.fx`, `state`, `currentAnswer()`, `SCENARIOS`) which do not exist in React with
    component-local state. The freeze is now observed by polling the disc's SVG `transform` until
    it settles and asserting it stays put; the correct option is derived by importing the content
    as an **answer key** and matching on option *text*, which works through the shuffle rather
    than around it. That is why `@sideline/rules` is a root devDependency — `e2e/` has no
    `package.json` of its own.
  - **A gate-behind-a-flag version was written first and rejected.** At 10.6 min serial it would
    never have run in CI, and coverage that only runs when someone sets an env var is a soft
    version of the dropped-suite risk this plan warns about. If the sweep ever needs to shrink,
    shrink it by sharding further — not by flagging it off.
- **Reauthor the 6 deleted zone fx** as `type:"mark", kind:"zone"` and review them visually. This
  changes rendered output for 5 scenarios, so capture the Playwright baseline *first*. A
  zone-*extent* guard belongs with this work: `ob6`'s existing `mark/zone` already pokes 0.2 units
  outside its view, which the current point-only check cannot see.
- ~~**Migrate `authoring/ui.json`'s 84 keys**~~ ✅ **DONE**, and the awkward 6 resolved by
  splitting them along the content/chrome line this plan already draws:
  - **78 simple `{en, cs}` keys** → the catalogue as `rules_*`, plus `levels` and `pkgDesc`
    expanded into `rules_level_N_name` / `rules_level_N_desc` (96 keys total).
  - **The four cheat-sheet tables are CONTENT, not chrome**, so they did NOT go into the
    catalogue. Every row carries a rulebook citation (`9.5.1`, `15.4`, `16.2`) — this plan's own
    test for content is "versioned alongside the rulebook citations they encode". They live in
    `packages/rules/src/content/cheatsheet.json`, ship via `@sideline/rules/reference`, and
    render through `text()`. Flattening three tables into ~45 catalogue keys would have been the
    wrong shape as well as the wrong category.
  - Each table is localised **whole** (`Localized<string[][]>`) because a row's cells are one
    authored unit. That introduces an alignment risk no other content file has — a dropped or
    merged row leaves both languages present and non-empty, so the both-languages guard stays
    green while the Czech table shows different rows with citations on the wrong entries. Guard
    **G19** compares row and column counts for exactly this.
- Animation pacing constants to reuse rather than reinvent: 450 ms after a completed exam chain,
  350 ms between steps (recorded in `packages/rules/AGENTS.md`).

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
    correctness from `@sideline/rules` — so scoring is defined once, not reimplemented per
    consumer. This is *not* an anti-cheat measure; see the honour-system decision.
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
- **Bundle size — measured, and smaller than feared.** 1.10 MiB of content on disk, but what
  matters is transfer: **257 KB gzipped total**, in per-package chunks of **21–40 KB gz**
  (largest `09-stoppages` 40 KB, smallest `02-marking` 21 KB), plus 20 KB gz for `rules.json`.
  Earlier drafts of this plan put the alarm ~4.5× too high. Phase 1 step 7 is still right — a
  visitor practising one package should not pay for nine — but it is an optimisation, not a
  crisis, and it should not be allowed to distort the Phase 1 design.
- **Content authoring must not fork.** Once content lives in `packages/rules`, the
  `frisbee-rules` repo stops being a source of truth and is retired.
- **The Czech is AI-written and unreviewed** beyond the first 23 situations — that is 86 situations
  of unreviewed rules translation. It is already live that way at rules.sideline.cz, so this is
  about *exposure*, not a new defect: an SSR-indexed, Sideline-branded `/cs/rules` teaching a
  mistranslated ruling to Czech players is a different proposition. **Decided: the proofread gates
  the public launch.** A per-package review checklist is the deliverable that unblocks it.

## Elsewhere (outside this repo)

- **Portfolio** — the trainer is listed on majksa.cz as project 03, tagged `tool`
  (`websites` repo, branch `feat/portfolio-rules-trainer`). Done. Once Phase 4 moves the canonical
  URL, that entry's `link` needs updating from `rules.sideline.cz`.
- **`frisbee-rules`** — retired as of the Phase 0 move. Until then it stays the authoring repo and
  the standalone site stays live.

## Open questions

The five questions this plan opened with are now decided (see Decisions taken). What remains:

1. **What counts as "mastering" a package?** Needed before Phase 2's schema is fixed, because it
   defines what the leaderboard ranks. Candidates: every situation in the package answered
   correctly at least once; correct in a single clean exam run; or a decaying score so mastery
   lapses and invites re-practice. The third is the best teaching design and the most work.
2. **Does anonymous progress import into the account on login?** Phase 2 step 12 assumes yes.
   Simpler than it looked: the honour-system decision dissolves the trust question, because
   server-scored attempts are no more trustworthy than imported local ones. So the only remaining
   question is UX — merge, replace, or ask — not integrity.
3. **After Phase 4, does `rules.sideline.cz` redirect or retire?** A redirect preserves any
   accumulated links and the portfolio entry; retiring is cleaner. The subdomain currently has
   its own identity ("Ultimate Rules Trainer") that the in-app version will not.
4. ~~**Bare `/rules`**~~ — **decided: redirect to the negotiated locale** (via the existing
   `getLocale()`). A locale-picking landing page adds a hop for no benefit, and with the SEO goal
   dropped there is nothing to gain from a third URL.
