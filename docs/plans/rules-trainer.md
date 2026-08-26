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
| Czech content? | ⚠️ **Gate lifted by owner sign-off** — `/cs/rules` is ungated; see Risks |

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
- **This weakened the Czech gate's own rationale, and the gate is now closed.** The gate was
  written against an *SSR-indexed, Sideline-branded* `/cs/rules`; un-indexed, the exposure is much
  closer to today's rules.sideline.cz. See Risks for the decision.
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

### Decision: the trainer is mounted in the app layout, and the public routes stay

Owner feedback after Phase 3 shipped: *"place the rules inside the app layout.
`/teams/{uuid}/rules`. without language and inside the layout. do we need the public one? the rules
'intro/showing' will be visible on sideline homepage"*.

The first half is unambiguous and done: `RulesTrainer` now mounts on
`(authenticated)/teams/$teamId/rules`, which already lives inside the sidebar shell and already has
a nav entry. That route previously rendered only the leaderboard and a link out to `/rules` — a
standings page for a trainer somewhere else.

The second half was a question, and the answer is **keep the public routes**. Removing
`/en/rules` + `/cs/rules` would have cost:

- The **e2e suite**, which is the trainer's only real regression guard. `rules-trainer.spec.ts`
  drives all 109 situations through the spoiler gate on **every PR**, and it is cheap precisely
  because it is signed-out — the `e2e/` harness has **no authentication at all**, for any test.
  Repointing the sweep at an authenticated route means building sign-in into Playwright first.
- The `rules.sideline.cz` **redirect target** (Phase 4 step 16): with no public route, that
  subdomain can only be retired, breaking every existing link to it.
- The free public trainer, which was a stated goal of this plan from the start, and the Czech
  review work that only matters for an indexable public page.

So both entry points render the same organism. They differ in exactly one thing, and it is the
thing that is easy to get backwards:

- **Public routes thread the locale explicitly** — `tr(key, params, { locale })` — because
  Paraglide has no `url` strategy, so `getLocale()` would contradict the `/cs` in the path.
- **Inside `(authenticated)` the page reads `getLocale()`**, because there is no path locale to
  contradict. `TeamRulesPage` passes that straight into the organism's `locale` prop.

`TeamRulesPage` deliberately does **not** render its own `RulesProgressPanel`: the organism already
shows one on its intro screen for a signed-in player, and the caller here is always signed in.

### Decision: nine package colours, not nine shades of grey

Same feedback round: *"the selection is not clear. click and hover are same. + everything is really
graish. use more colors"*.

Both halves had one root cause. The picker was a shadcn `ToggleGroup`, which is a **segmented
control**: every item carries `data-[spacing=0]:rounded-none` and
`data-[variant=outline]:border-l-0`, and only the first and last item keep a rounded edge. Laid out
as the gapped 3-column grid nine packages need, that produced square, border-less cards whose `on`
state was the same faint `bg-accent` as their hover state. It is now a plain
`<button aria-pressed>` grid, with selection carried on four axes at once (accent border, accent
surface, filled number pill, filled check mark) so it survives colour-blindness and touch devices,
where hover never lifts.

The colours themselves live in `applications/web/src/lib/rules/palette.ts`:

- **`LEVEL_ACCENT`** — one hue per package, ramping emerald → teal → cyan → sky → blue → indigo →
  violet → fuchsia → rose with the difficulty. The same accent follows a package from the picker to
  the practice screen's level badge to its progress bar.
- **`RULES_ACCENT`** — the trainer's own blue, matching the `#2f6df6` the pitch SVG already paints
  the offence in. `RULES_ACCENT.cta` is the one place the trainer overrides the app's monochrome
  `primary`, for the two buttons that drive the flow (start a run, replay the demo).
- **`VERDICT`** — right/wrong. Explicit emerald/red rather than the `--success` / `--destructive`
  tokens, because in dark mode `--success` is `oklch(0.35 0.1 150)` (a near-black green) and the
  correct option is a `disabled` button, so the shared `disabled:opacity-50` made the single most
  important thing in an answered step the least legible one.

Two constraints on anyone editing this:

- **Every class string in `palette.ts` must be a complete literal.** Tailwind scans source text, so
  an interpolated `bg-${hue}-500` produces no CSS at all.
- **Do not build package identity on `--chart-1…5`.** Those swap hue between light and dark
  (`--chart-1` is orange in light, blue in dark), so a package would change colour on a theme
  toggle.

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

### Phase 1 — public `/rules`, native React, local-only progress — ✅ DONE

Shipped across #565 (routes + practice flow), #567 (e2e), #568 (exam, review, cheat sheet) and
#569 (homepage + content cache). Two of this phase's original assumptions did not survive and are
corrected in the decisions above: **SSR/indexability was dropped** (the app is client-rendered and
cannot re-enable SSR per route), and **the PWA cold-start promise is unmet** — an already-open page
survives losing signal, but a cold start with no signal serves `offline.html`, so the "rules
argument at a tournament" scenario still does not work. That needs an app-wide service-worker
decision, not more trainer work.

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
     own merits. ✅ **Done** — `RULES_CACHE`, registered *before* the generic static route because
     Workbox matches in registration order and these chunks are `destination: 'script'`. Verified
     in a browser: all nine land in `rules-content`, none leak into `static-assets`.

   ⚠️ **But the motivating scenario does NOT work, and this step cannot deliver it.** Measured:

   | | Result |
   |---|---|
   | Page already open, then signal lost | trainer keeps working ✅ |
   | **Cold start with no signal** | `offline.html` — "📵 You're offline" ❌ |

   `sw.js` serves navigations `NetworkOnly` with an `offline.html` fallback, deliberately, so a
   returning user always gets the newest deployed shell. That means **no amount of asset caching
   makes a cold start work offline** — and a cold start is exactly "a rules argument at a
   tournament happens where there is no signal", the sentence this step was written to satisfy.

   So caching content is still worth having (it makes the warm case reliable and immune to
   app-shell churn), but the tournament promise is unmet. Delivering it requires serving a cached
   shell for navigations, which trades away the always-newest-deploy guarantee and has its own
   staleness and cross-user implications. That is an app-wide service-worker policy decision, not
   a rules-trainer task — **do not claim offline support for the trainer until it is made.**
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

### Phase 2 — per-user progress (server-scored) — ✅ DONE

Shipped across #570 (decaying mastery), #571 (migration + contracts), #572 (repository, handler,
API wiring) and #573 (progress panel, attempt submission, local import). Note the phase title is
now slightly misleading: scoring *is* server-side, but that is for a single definition rather than
for trust — see the honour-system decision.

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

### Phase 3 — team leaderboard + achievements — ✅ DONE

Shipped across #574 (leaderboard API, self-and-captains visibility), #576 (member route) and #578
(achievements, evaluated per active membership). Step 15 turned out to be much larger than its one
line suggested — see the notes on it below, which are kept because they explain why.

13. Rules leaderboard endpoint scoped to a team, ranked on mastery/accuracy, mirroring
    `LeaderboardApi`'s shape (rank, displayName resolution, `Forbidden` on non-membership) so the
    UI can reuse existing components.
14. Member route `(authenticated)/teams/$teamId/rules` — the same trainer organism plus a
    progress panel and the leaderboard. **Landed in two passes:** the leaderboard first (#576),
    then the trainer organism itself, after owner feedback that the route showed standings for a
    trainer it did not contain. See "Decision: the trainer is mounted in the app layout, and the
    public routes stay" below.
15. Wire the new achievement slugs + optional Discord role. **Bigger than this line suggests** —
    four things surfaced while building Phase 2:

    - **`AchievementEvaluator.evaluate` takes a `TeamMemberId`, but rules attempts are
      team-less.** That is a direct consequence of the (deliberate) decision to give
      `rules_attempts` no `team_id` so progress survives joining and leaving a team. So the
      submit handler has no membership context to evaluate with, and Phase 2 wires **no**
      achievement hook at all. Phase 3 must add a user-scoped evaluation path, or resolve the
      caller's memberships at evaluation time and fan out. This is new work, not a one-liner.
    - **`AchievementEvaluationInput` must gain a rules field**, and both construction sites
      (`AchievementEvaluator.ts`, and `AchievementPreview.ts` **twice**) must populate it. That
      gives `AchievementEvaluator` a new repository dependency, which re-triggers the
      mock-layer cascade across all 41 `ApiLive` test files.
    - **`BUILT_IN_RULE_KINDS` is an exhaustive record over `CustomRuleKind`**, which is
      `'total_activities' | 'longest_streak' | 'total_duration' | 'activity_type_count'` —
      **none of which describes a rules milestone**. Either add a literal (no migration needed;
      `custom_achievements.rule_kind` is plain `TEXT` with no CHECK) or decide rules
      achievements do not belong in this catalogue. Omitting an entry is a compile error, which
      is the good outcome.
    - **`packages/domain/test/Achievement.test.ts` asserts exactly 5 role-granting
      achievements.** Any new `grantsDiscordRole: true` slug breaks it, and that count must be
      updated deliberately rather than reflexively.

    Also worth knowing: `grantsDiscordRole` is metadata consumed on the read side, not the
    trigger. The actual grant path is evaluate → `earned.insertIfMissing` → emit to the
    `achievement_sync_events` outbox → the bot polls it and reads the role id from the
    per-team `achievement_role_mappings` table. So the flag means "eligible for a
    captain-configured role", not "grants a role".

### Phase 4 — cutover — ▶ UNBLOCKED, not started

The precondition is met as of **2026-08-26**: production serves the trainer, so there is now
something for `rules.sideline.cz` to point at. Verified rather than assumed —
`sideline.cz/en/rules`, `/cs/rules` and `/rules` all return **200**, and `sideline-cz/ops`
`env/production` pins:

| App | Digest | Tag |
|-----|--------|-----|
| server | `sha256:5e9a5ead…` | `v0.44.0` |
| web | `sha256:23d5f30e…` | `v0.32.0` |
| bot | `sha256:19c180b7…` | `v0.35.0` |

The bot promote (ops PR #511, `render(production): from main@1d6d3864`) matters beyond tidiness:
production briefly ran the new server and web against **July's bot**, whose exhaustive
`Record<AchievementSlug, …>` maps in `applications/bot/src/rest/achievements/buildAchievementEmbed.ts`
predate the four rules slugs. `TITLE_MESSAGES[slug](locale)` on an unknown slug is `undefined(...)`
— a TypeError, not a missing emoji — so the first person to earn a rules achievement would have
failed that sync event permanently. Any future release that adds an `AchievementSlug` has the same
skew; promote the bot with the server.

⚠️ **The `v0.35.0` digest is `sha256:19c180b7…`, not the `sha256:6a3711e0…` recorded during the
release.** That earlier hash was an intermediate, untagged manifest from the same build round; the
tag re-push (see the dashboard-cut release note under Risks) produced a different one. Read the
digest back from the `ops` repo or the GHCR version list, never from release notes.

#### The redirect is a Cloudflare edge rule, which dissolves step 17's ordering risk

**Owner's call (2026-08-26).** `rules.sideline.cz` is Cloudflare-proxied (every response carries a
`cf-ray`), so the redirect happens at the edge and the request never reaches an origin at all.

⚠️ **This rule lives in the Cloudflare dashboard, in neither repo.** That is the one real cost of
choosing it, and it is why the exact configuration is written out here — someone grepping either
repo for `rules.sideline.cz` in six months will otherwise find only the majksa-projects app config
that no longer serves it, and conclude the subdomain is dead.

```
Cloudflare → Rules → Redirect Rules

  When incoming requests match:  Hostname equals rules.sideline.cz
  Then:                          Type   Static
                                 URL    https://sideline.cz/rules
                                 Status 301
                                 Preserve query string: off
```

`/rules` rather than `/en/rules`: the bare route negotiates locale (localStorage → cookie →
`navigator.languages` → English). **Verified against production**, not assumed — a browser at
`en-US` lands on `/en/rules` ("Learn the calls by living them"), one at `cs-CZ` lands on
`/cs/rules` ("Nauč se pravidla tím, že je zažiješ"), both rendering all nine packages. So a Czech
player's old bookmark reaches the Czech trainer. Hard-coding `/en/rules` would silently send every
Czech visitor to English.

Path is deliberately **not** preserved. The standalone site is a single self-contained HTML file,
so every path under `rules.sideline.cz` is the same page; forwarding `$request_uri` would only
manufacture 404s on the new host.

**Why this matters beyond convenience:** it removes step 17's failure mode entirely rather than
sequencing around it. That step exists because two apps must never claim the same host — implying a
window where the old app has released `rules.sideline.cz` and the new one has not yet taken it. An
edge redirect never routes the host to an origin, so releasing it in majksa-projects and enabling
the rule are **independent**; there is no ordering to get right and no dead window. The rejected
alternative (add `rules.sideline.cz` to `sideline-proxy`'s `ingress.domains` — the schema does
support a `domains` list, see `portfolio` / `space-alert` / `zpevnik-*` in `majksa-projects/ops` —
plus an nginx `server_name` block beside the existing `/docs` redirect) is version-controlled and
reviewable, but costs a proxy release, an ops PR, and keeps that window.

Note that `ingress.domains` **alone** would not have worked: it makes the host an alias, so
`rules.sideline.cz/` would serve the Sideline homepage rather than the trainer. It needs a redirect
in front of it either way.

16. Add the Cloudflare Redirect Rule above. Verify `curl -I https://rules.sideline.cz` returns
    **301** to `https://sideline.cz/rules`, and that following it renders the trainer.
17. Remove `ingress.host` from the majksa-projects `rules` app and merge that render PR. No longer
    order-sensitive against step 16 (see above), but still verify `rules.sideline.cz` after it.
18. Archive the old `rules` app and delete `rules/` from `majksa-projects/static`.

The production promote itself is a MajNet dashboard action authorised via Tailscale identity and
cannot be done from this repo; merging the resulting `env/production` render PR is the deploy
trigger and *can* be done via GitHub.

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
- **A dashboard-cut release tag may fire no workflow at all — silently.** Observed on
  `@sideline/bot@v0.35.0`: MajNet's dashboard created the tag at `da7244fd` and **no `release.yaml`
  run started**. Deleting the remote tag and re-pushing the byte-identical tag with a developer's
  own credentials fired it immediately. Token-based workflow-loop prevention is the obvious suspect
  — this repo already carries a `GH_PAT` workaround elsewhere for exactly that class of problem —
  but **this is unproven**, and nothing here fixes it.

  Two consequences worth holding onto, because neither is specific to this plan:

  - **The failure mode is silence, not an error.** There is no failed run to notice; the release
    simply does not happen. After any dashboard-cut release, confirm a run actually started —
    `gh api repos/{owner}/{repo}/actions/runs?event=push` is more reliable than `gh run list`,
    which lags indexing badly enough to have twice produced a false "not fired" here.
  - **The re-push changes the image digest.** The re-run builds a fresh image, so the digest
    recorded when the tag was first cut is stale. Always read the digest back from
    `sideline-cz/ops` or the GHCR version list, never from notes written at release time — see the
    `v0.35.0` warning under Phase 4.
- **The Czech is AI-written and unreviewed** beyond the first 23 situations — that is 86 situations
  of unreviewed rules translation. It is already live that way at rules.sideline.cz, so this is
  about *exposure*, not a new defect: a Sideline-branded `/cs/rules` teaching a mistranslated
  ruling to Czech players is a different proposition.

  **Gate lifted (owner sign-off), with the risk knowingly accepted.** `/cs/rules` no longer carries
  `noindex` or the review notice. Two things stay true and are worth keeping in view:

  - The sign-off was a **page-level judgement, not a read of all 1182 options**. The failure this
    gate guarded against is a dropped or inverted negation in a *wrong* option's `why` — it reads
    as fluent Czech, and it is invisible to both a glance and to `cz-audit.mjs` (which runs clean,
    and by design cannot certify meaning). So this is accepted risk, not verified correctness.
  - `noindex` was doing very little anyway once the SSR decision landed: the trainer is
    client-rendered, so the page was never going to be meaningfully indexed. What actually changed
    for users is the notice disappearing.

  **CLOSED (2026-08-26, owner): the review is not planned, and the risk is accepted.** The banner,
  its `rules_csReviewNotice` / `rules_csReviewNoticeBody` keys, the `showTranslationReviewNotice`
  prop and `authoring/czech-review-checklist.md` are all **deleted**, not left dormant — a retained
  artifact reads as scheduled work, and this is not scheduled. The e2e test asserting the notice is
  *absent* stays, so it cannot reappear silently.

  What is being accepted, stated plainly so nobody re-derives it: 86 of 109 situations are
  AI-written Czech that no rules-literate Czech speaker has read. The specific failure is a dropped
  or inverted negation in a *wrong* option's `why`, which reads as fluent Czech and is invisible to
  both a glance and `cz-audit.mjs`. The same content has been live in Czech at rules.sideline.cz
  since before Sideline carried it, so this is exposure that already existed rather than a new
  defect. If a mistranslated ruling ever surfaces, fix that ruling — do not rebuild the gate.

## Backlog — beyond Phase 4

Not planned or costed; recorded so the design constraints are not rediscovered later.

### Learn the rules / take the test from inside Discord

A slash command that runs a situation or a short test in Discord, without opening the web app.
This is the reason `@sideline/rules` was built Effect-free with a `/content` subpath the bot can
import eagerly — the groundwork exists and nothing needs restructuring.

**Owner steer (2026-08-26), which changes the shape of this from what was written here before:**
ship the animation as **precomputed GIFs**, and make the quiz a public question message that opens
a private chain per participant. Both are recorded below. The earlier version of this entry
concluded the animation "cannot come with it" and floated a still image at `qAt` as consolation —
that is superseded.

#### The animation comes with it, as two GIFs per scenario, built ahead of time

The animation is already a pure function of `(scenario, t)`. `RulesFieldSvg` takes
`{ scenario, t, locale }` and returns SVG; its only hook is a `React.useMemo`, with no DOM and no
`window` access, so `renderToStaticMarkup` yields a frame at any `t` with no refactor.

The 109 scenarios are **static content that never changes at runtime**. So do not put a rasteriser
and an encoder in the bot image and render per interaction — precompute in CI and ship the files.
That removes per-interaction latency entirely, which matters because a slash command must ack
within 3 seconds.

`animLimit` (`packages/rules/src/engine/anim.ts`) already proves there are exactly **two** states to
encode, not a continuum: `qAt` before the chain is answered, `dur` after. So render `0 → dur` once
as a single frame sequence and cut two clips from those same frames:

| Clip | Range | Where it goes |
|------|-------|---------------|
| setup | `[0, qAt]` | the public question message |
| resolution | `[0, dur]` | the ephemeral follow-up, per user, once **that** user's chain is done |

109 × 2 = **218 files**. Regenerate only when content changes — a separate workflow, not something
that runs on every PR.

**The reason this is worth doing beyond fidelity:** in Discord the spoiler gate stops being a UI
promise and becomes a property of the artefact. On web the gate is enforced by the client capping
`t` — the later frames exist, something merely declines to draw them. In a precomputed setup clip
the frames past `qAt` are *not in the file the viewer has*. Nobody can scrub past what was never
encoded.

**GIF, not MP4** (owner's call, and the right one): Discord autoplays GIFs inline, while a video
attachment renders as a poster frame plus a play button. For a five-second teaching loop that
autoplays by default, the worse compression is the correct trade — and this content is flat vector
art with a small palette, which is close to the best case for GIF anyway.

#### The resolution clip must be ephemeral, never posted to the channel

If the resolution lands publicly the moment the first person answers, it spoils the scenario for
everyone still working through it. The public message stays on the setup clip permanently; the
resolution clip is delivered to each participant individually as they finish. This is the single
easiest thing to get wrong here, because posting it publicly is the more obvious implementation.

#### Quiz shape: one public message, one private chain per user

Not a fully-ephemeral quiz. The public message carries the question, the setup GIF and **one**
button; clicking it opens that user's own ephemeral chain. This gives the quiz a shared,
channel-visible presence without ever rendering one participant's state where another can see it.

It is also already the house pattern — see "Per-user actions on a shared board message: one button
keyed by entity id, resolved server-side" in `applications/bot/AGENTS.md`, and
`CarpoolLeaveMineButton` as the reference implementation. The rules that carry over unchanged:

- The button's `custom_id` encodes **only** the shared entity id (the scenario or quiz-session id),
  never anything per-user. The acting user is resolved server-side from the interaction.
- Every per-user reply is ephemeral (`ephemeralDeferred` + `replyWebhook`).
- **Per-user state in a shared channel is the trap.** Sideline has been bitten by rendering
  per-user state into a shared message before; that is what this shape exists to prevent.

#### Constraints that carry over unchanged

- **The spoiler gate still has to hold on the text side too.** Beyond the GIF, the risk is a later
  step's key label or a `why` arriving in the same message. `chainView` already computes exactly
  that decision (`state`, `showVerdict`, `showKeyLabel`) and is pure — the bot must drive it rather
  than reimplement the reveal rules.
- **Command and option descriptions must stay ≤100 characters in every locale.** An over-length
  description makes Discord reject the *entire* command registration with a 400 and crash-loops the
  bot, with no error surfacing in logs. There is a guard test for this — keep it passing.
- `scoreAttempt` is shared logic and already tolerates hostile input, so the bot can submit
  attempts through the same path as web.

#### Open questions to settle before costing this

1. **Bot attachment size ceiling.** It varies with the guild's boost tier. Flat vector art should
   land in the low hundreds of KB per clip, but measure against the real limit rather than assume —
   and note the limit applies to the smallest guild the bot serves, not the largest.
2. **Where the 218 files live at send time.** They cannot be referenced by URL: bots cannot set
   `embed.video`, the web app has SSR and prerender disabled so there are no OG tags for Discord to
   unfurl, and Discord CDN URLs are signed and expire — so "upload once, reuse the link" does not
   work either. That leaves uploading bytes per message, from either the bot image (which grows it)
   or a cached fetch of web static.
3. **Does the ephemeral view re-render per step, or only deliver the resolution GIF at the end?**
4. **Frame rate and dimensions**, which set both file size and CI build time. ~180 frames per
   scenario at 30fps over a typical `dur`, × 109, is the whole render budget.

### A daily rule, with streaks

One deterministic situation per day that everyone gets, completable for a streak.

- **Determinism is the point.** Everyone must get the *same* situation on the same day, or people
  cannot discuss it — which is most of the appeal. That is a pure function of the date, so it
  belongs in `@sideline/rules` next to `mastery.ts` (`dailyScenario(date)`), seeded by the date
  rather than by `Math.random`, and unit-testable without a clock.
- **Streaks cannot reuse the activity streak.** This plan already rejected putting rules practice
  into `ActivityLog`, so `currentStreak`/`longestStreak` on `LeaderboardEntry` are about physical
  training volume and must not absorb rules activity. A rules streak needs its own consecutive-day
  tracking.
- **It is a different mechanic from decaying mastery, not a variant of it.** Mastery answers "how
  well do you know this now" and decays continuously; a streak answers "did you show up today" and
  breaks discretely. Both are legitimate, but conflating them would make either meaningless —
  keep them separate columns and separate UI.
- Pairs naturally with the Discord command above: a daily post in a channel is the obvious delivery
  mechanism, and it gives the bot work a reason to exist beyond convenience.

**Delivery: a per-team channel, configurable in team settings.**

- Follow the **welcome channel** pattern — an explicitly configured, member-visible channel stored
  on team settings — not the channel-by-type targeting that was **deliberately removed** (columns
  dropped, transitional RPC field gone, shipped in web v0.28.1 / server v0.40.3). Do not
  resurrect that mechanism for this.
- It is member-visible, unlike the system channel (a hidden captain join log), so treat it as
  content players read rather than an audit surface.
- **The shared post makes the spoiler problem worse, not better.** One public message that everyone
  reads means the first person to answer in-channel spoils the day for everyone who hasn't played
  yet. So the post itself carries only the situation and the question; every answer interaction must
  be an **ephemeral per-user view**, and results/verdicts must never render into the shared message.
  This is the same rule as the Discord command above, but here it is load-bearing rather than
  merely tidy.
- **Timezone is already solved — do not invent anything.** `team_settings.timezone` exists
  (`TEXT NOT NULL DEFAULT 'Europe/Prague'`, a valid IANA string, added in `1745800000`), so
  "daily" means daily in the team's own timezone and a single UTC cron hour is never the answer.
  Two precedents to copy rather than re-derive:
  - `rsvp_reminder_time` (`TIME NOT NULL`) is a time-of-day **interpreted in the team's
    `timezone`**, with the cron matching within a 5-minute window. That is exactly the shape a
    `daily_rule_time` wants.
  - `weekly_summary_channel_id` is a **nullable** channel column where `NULL` means the cron
    **skips the team** — the bot posts the weekly summary each Sunday at 20:00 local team time
    only when it is set. That is precisely the "unset means feature off, cleanly" behaviour this
    needs: no posts, no errors, no daily log noise about a missing channel. Copy it.

  So the settings work is a nullable `daily_rule_channel_id` plus optionally a
  `daily_rule_time`, both alongside the existing weekly-summary and reminder fields, and the cron
  is a sibling of the weekly-summary cron rather than new machinery.

## Elsewhere (outside this repo)

- **Portfolio** — the trainer is listed on majksa.cz as project 03, tagged `tool`
  (`websites` repo, branch `feat/portfolio-rules-trainer`). Done. Once Phase 4 moves the canonical
  URL, that entry's `link` needs updating from `rules.sideline.cz`.
- **`frisbee-rules`** — retired as of the Phase 0 move. Until then it stays the authoring repo and
  the standalone site stays live.

## Open questions

The five questions this plan opened with are now decided (see Decisions taken). What remains:

1. ~~**What counts as "mastering" a package?**~~ **DECIDED: a decaying score — mastery lapses.**
   Implemented as pure logic in `packages/rules/src/engine/mastery.ts` ahead of the schema, since
   it is the thing the schema has to support.

   - **Exponential half-life decay**, 45 days (`MASTERY_HALF_LIFE_DAYS`), per scenario from its
     last fully-correct answer. Exponential rather than linear because it is the standard
     spaced-repetition shape and never quite reaches zero, so a situation you once knew never
     reads as *never* known.
   - **A package is mastered at mean strength ≥ 0.8** (`MASTERED_THRESHOLD`). Below 1 deliberately:
     requiring every situation to be simultaneously fresh would make the 20-situation package
     nearly unmasterable and would flicker off the moment one situation aged.
   - **Unanswered scenarios count as 0**, so mastery cannot be reached by drilling one situation.
   - **Overall mastery is weighted by package size**, which makes it identical to "mean strength
     across every situation". An unweighted mean of the nine packages would let a player out-rank
     someone who knows strictly more situations by farming the small packages.
   - **Computed on read, not materialised.** Strength derives from one `lastCorrectAt` timestamp
     per scenario, so there is no score to keep fresh: no cron, no staleness window, and no way
     for the leaderboard and the progress panel to disagree because one was recomputed and the
     other was not. This is what keeps Phase 2's schema to the two tables already sketched.

   It lives in `@sideline/rules` rather than the server because three consumers must agree on it —
   the server ranks with it, web renders progress with it, and a Discord bot would answer "how am
   I doing?" with it. One definition, one set of tests, no drift.
2. **Does anonymous progress import into the account on login?** Phase 2 step 12 assumes yes.
   Simpler than it looked: the honour-system decision dissolves the trust question, because
   server-scored attempts are no more trustworthy than imported local ones. So the only remaining
   question is UX — merge, replace, or ask — not integrity.
3. ~~**After Phase 4, does `rules.sideline.cz` redirect or retire?**~~ **DECIDED: redirect**, as a
   Cloudflare edge Redirect Rule to `https://sideline.cz/rules` — see Phase 4 for the exact rule,
   which is recorded there precisely because it lives in neither repo. Retiring was rejected: the
   subdomain has been live since 2026-08-24 and shared, so every existing bookmark would break
   with no signpost. The one thing genuinely lost is the subdomain's own identity ("Ultimate Rules
   Trainer"), which the in-app version does not carry.
4. ~~**`sp5`'s zone annotation**~~ — **DECIDED: dropped.** Its `r=2.6` "their lane" circle rendered
   almost entirely under the actor markers, and the radius was never visually validated because the
   fx never rendered in the source app either. Rather than guess a new radius and risk encircling
   something the author did not mean, the annotation is gone and the situation text carries "their
   lane". No content change was needed — the fx was deleted in #562 and never restored. The five
   zones that *were* restored (`pl7`, `rf3`, `ob2`, `gl1`, `gl2`) are unaffected.
5. ~~**PWA cold-start offline**~~ — **DECIDED: left unmet, deliberately.** Navigations stay
   `NetworkOnly`. A page already open survives losing signal; a cold start with no signal serves
   `offline.html`. Serving a cached shell would trade away "returning users always get the newest
   deploy" **app-wide**, including authenticated pages where a shell can outlive the API contract it
   was built against. So the plan's "rules argument at a tournament" scenario is knowingly
   unsupported rather than half-supported. `public/sw.js` carries the same note, because that is
   where someone would otherwise "fix" it incidentally.
6. ~~**`STATIC_CACHE` `maxEntries`**~~ — **DECIDED: raised 100 → 250.** The app ships ~192 hashed
   JS chunks, so at 100 the LRU thrashed and the cache reported "assets are cached" while holding
   roughly half of one page load. Note this failure is **silent** — if the bundle ever passes ~250,
   raise it again; nothing will error.
7. ~~**Bare `/rules`**~~ — **decided: redirect to the negotiated locale** (via the existing
   `getLocale()`). A locale-picking landing page adds a hop for no benefit, and with the SEO goal
   dropped there is nothing to gain from a third URL.
