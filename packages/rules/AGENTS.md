# Rules Trainer Package (`@sideline/rules`)

WFDF Rules of Ultimate trainer content and a pure scoring/animation engine. **No Effect runtime,
no I/O.** Consumed by the server (exam scoring, RPC handlers), the bot, and — once the UI ships —
`applications/web` for the trainer's learn/exam/review flows.

The engine shipped in `0.1.0` alongside the content: `animLimit`, `createAnimator`, `ipos`,
`pathTangents`, `chainView`, `answerStep`, `examAnswer`, `advanceExam`, `openReview`, `startExam`,
`buildPerms`, `buildRunPerms`, `shuffle`, `pool`, `score`, `scoreAttempt`, `text`. Phase 1 renders
it; it does not need to port it.

`chainView`'s `order` field is never shuffled by `chainView` itself — it only relays whatever
`perms` the caller passes. The caller is responsible for supplying the run's actual permutation:
`buildRunPerms` (learn) or `startExam`'s `ExamState.perms` (exam/review). Omitting `perms` falls
back to identity order (the correct option first, every time) — fine for a test, a bug in Phase 1
if it ships that way.

## Architecture

```
src/
├── index.ts          — types, constants, LEVEL_META, PACKAGE_LOADERS. NEVER imports content.ts
├── content.ts         — ALL_PACKAGES, eager, all nine packages (subpath ./content)
├── reference.ts        — RULES + SIGNALS (subpath ./reference)
├── types.ts            — Localized<T>, Lang, Level, ScenarioId, Scenario, Step, Option,
│                         Keyframe, Actor, Disc, Fx (discriminated union on `type`)
├── constants.ts         — LEVELS, EXAM_N, LEVEL_META (hand-maintained, see below)
├── content/
│   ├── packages/01-pull.json … 09-stoppages.json
│   ├── rules.json, signals.json
│   └── loaders.ts       — PACKAGE_LOADERS: dynamic import() + JSON import attributes
└── engine/               — pure scoring/animation logic
    ├── state.ts          — Mode, StepPick, Answer, RunState, ExamState, blankAnswer,
    │                       currentAnswer, stepsOf, actorTeam
    ├── anim.ts           — animLimit (the spoiler gate), pathTangents, ipos, createAnimator
    ├── answer.ts         — answerStep, examAnswer, advanceExam, openReview (pure transitions)
    ├── chain.ts          — chainView (the per-step reveal decision)
    ├── exam.ts           — startExam (level-stratified, shuffled, round-robin filled)
    ├── perms.ts          — buildPerms, shuffle (option display order)
    ├── pool.ts           — pool, poolLen, posOf, countLevel
    ├── score.ts          — score, answeredCount, examScore, scoreAttempt
    └── locale.ts         — text (content only; chrome goes through @sideline/i18n)
reference/                — NOT bundled: 5 WFDF PDFs + .txt siblings + README.md (citation source)
authoring/                 — NOT bundled: content-backlog.md, czech-terminology.md,
                            cz-audit.mjs, ui.json (Phase 1 i18n catalogue input)
test/                      — vitest, no @effect/vitest helpers
```

## Constraints

1. **No Effect imports.** This package must remain runtime-agnostic. `ipos` runs
   per-actor-per-frame inside a 60fps `requestAnimationFrame` loop and the engine must be callable
   synchronously from React render — an Effect runtime in the hot path is a non-starter. Do not
   add `effect` to `dependencies`, `devDependencies`, or `peerDependencies`.
2. **No I/O.** All exported functions are pure. Content is data, not fetched.
3. **No runtime `Schema` decode of content.** Content is repo-versioned, reviewed in PRs like
   code, and validated by guards in `test/guards/` instead (CI, not runtime).

## The three subpath exports — and the one web must never use

```jsonc
"exports": {
  ".":           { "import": "./dist/index.js" },   // types, engine, constants, PACKAGE_LOADERS
  "./content":   { "import": "./dist/content.js" }, // ALL_PACKAGES — eager, all nine packages
  "./reference": { "import": "./dist/reference.js" } // RULES + SIGNALS (~20 KB gz)
}
```

- **`@sideline/rules`** pulls in *no* scenario JSON. Use `PACKAGE_LOADERS[level]()` to fetch one
  package's scenarios on demand (dynamic `import()`).
- **`@sideline/rules/reference`** is small (~20 KB gz) and needed by web to render a `§` rule chip,
  so it is not behind the eager entry.
- **`@sideline/rules/content`** eagerly imports all nine packages (~257 KB gz total, 21–40 KB gz
  per package). Fine for the server, the bot, and tests. **`applications/web` must never import
  it** — a biome `style/noRestrictedImports` override scoped to `applications/web` in the repo
  root `biome.json` enforces this and will fail lint with a message pointing at
  `PACKAGE_LOADERS` instead.

This split works because `applications/web/tsconfig.json` does not extend `tsconfig.base.json`
(it maps only `@/*`, `~/*`, `@sideline/domain*`), so `@sideline/rules` resolves through the plain
workspace symlink + this package's `exports` map — unlike `@sideline/domain`, which
`vite.config.ts` hand-aliases.

**`ui.json` is never shipped.** It lives in `authoring/` as the input for a future Phase 1
i18n-catalogue migration (trainer chrome goes through `tr()` / `@sideline/i18n`, not a second
translation mechanism). No file under `src/` reads it — if you find yourself importing it from
`src/`, that is a regression.

**Barrel filenames are flat (`src/content.ts`, `src/reference.ts`), not directories.**
`tsconfig.base.json` maps `@sideline/x/*` → `packages/x/src/*.js`; a directory barrel
(`src/content/all.ts`) would not resolve through that path pattern.

## JSON content imports require the import attribute

Every JSON import — static or dynamic — must carry `with { type: 'json' }`:

```ts
import pull from './content/packages/01-pull.json' with { type: 'json' }
const p = await import('./content/packages/01-pull.json', { with: { type: 'json' } })
```

Omitting it makes Node throw `ERR_IMPORT_ATTRIBUTE_MISSING` at runtime under `module: NodeNext` —
this would crash the server on boot the moment anything reached `@sideline/rules/content` or a
`PACKAGE_LOADERS` entry. There is no compile error for a missing attribute; only a build + real
`node --input-type=module -e "import(...)"` smoke test catches it. `tsc -b` itself copies the
JSON into `dist/` (no separate copy step needed) but does not validate the runtime attribute.

### …but the attribute is exactly what stops a BUNDLER rewriting the import

The attribute is a Node requirement and a bundler obstacle, and those pull in opposite directions.
Vite/Rolldown will **not** rewrite a dynamic `import()` that carries `with { type: 'json' }` — it
leaves the specifier verbatim, so the browser resolves it relative to `/assets/` and every request
404s. This is not theoretical: it shipped to a preview build with a green `pnpm build`, green
`pnpm check`, and green unit tests (they mock the loaders), and was only caught by driving the page
in a real browser.

Confirmed by elimination — it is the attribute, not the specifier shape. Both of these are left
un-rewritten: the relative `'./packages/01-pull.json'` and the bare
`'@sideline/rules/packages/01-pull.json'`. Removing the attribute rewrites correctly.

So consumers split:

| Consumer | Loader | Attribute |
|---|---|---|
| server, bot, tests (Node) | `PACKAGE_LOADERS` from `@sideline/rules` | **required** — Node throws without it |
| `applications/web` (bundled) | `WEB_PACKAGE_LOADERS` in `applications/web/src/lib/rules/loaders.ts` | **must be omitted** — web is `moduleResolution: "bundler"`, so TS does not want it either |

The `./packages/*` subpath export exists to serve the web map. Its specifiers must stay **literal**
— a computed `` `…/${level}.json` `` is also unfollowable. `applications/web/src/lib/rules/loaders.test.ts`
asserts that map's keys equal `LEVELS` and that every loader resolves real content, so adding a
tenth package without wiring it there fails a test rather than 404ing at runtime.

`resolveJsonModule: true` is already on via `tsconfig.base.json`; `tsconfig.src.json`'s `include`
was extended with `src/**/*.json` because, under the repo's composite/project-references
tsconfig layout, `tsc -b` refuses to typecheck an imported JSON file that isn't also matched by
`include` (`TS6307`) — `resolveJsonModule` alone is not enough here.

## `scoreAttempt` is shared scoring logic, not a trust boundary

The parent plan's original "never trust a client-reported score" instinct does not hold for this
feature: Phase 1 ships the full answer key to the device (the PWA must work offline), so any exam
key is already local, and the leaderboard is an accepted honour system. `ok: true` sits at index
0 in all 367 steps and the `ok` flags ship to the client for offline practice, so a client
submitting `[0, 0, 0, …]` scores 100% — that is expected, not a defect to paper over.
`scoreAttempt` still must never throw and never index blindly on malformed input (defensive
against malformed input, not adversarial input): a non-array/wrong-length `picks`, or any
individual pick that is the wrong type, non-integer, out of range, `NaN`, `Infinity`, or a
`bigint`, normalises to `StepPick.pick: null` — the one documented "untrustworthy pick" sentinel
(see `StepPick` in `engine/state.ts`) — rather than being echoed back verbatim. Echoing it back
would have broken `Answer`'s own JSON round trip (`NaN`/`Infinity` silently become `null` through
`JSON.stringify`, and a `bigint` makes it throw).

## `startExam`'s per-scenario draw rate is unevenly distributed by design

Per-*package* exam coverage is exactly even — one draw per selected level, every time `EXAM_N >=
|selection|`. Per-*scenario* draw rates are not: a scenario in a 9-scenario package appears in
12.3% of exams, while one in the 20-scenario level 9 (Stoppages) appears in only 5.6% — a 2.2×
spread, inherent to "one guaranteed pick per stratum, round-robin fill for the rest" and present
in the source too, not a regression. Phase 2 "weak areas" analytics must not read a scenario's
lower exam-appearance count as a skill signal — it may simply live in a bigger package.

## Animation pacing constants (for Phase 1, so it doesn't reinvent them)

The source `examAnswer` used **450 ms** before advancing to the next question and **350 ms** for
the inter-step reveal pacing. Carry these over verbatim when the exam-mode UI is built; they are
tuned, not arbitrary.

`pick === -1` was a timed-out sentinel two renderers in the source app read defensively, but the
exam is untimed and nothing ever produced that value. It has been dropped — do not reintroduce a
`-1` branch without a producer for it.

## Content authoring workflow

`frisbee-rules` (the standalone prototype repo this content was ported from) is retired — do not
fork content back into it. All future authoring happens directly in this package:

- New situations go in `src/content/packages/NN-*.json`. A scenario's `level` must equal its
  package file's `level` (guarded).
- Read `authoring/content-backlog.md` before picking the next batch — it documents which rule
  numbers are genuinely unmined vs. already taught under a different citation, and the near-clone
  trap from batch 10.
- `authoring/czech-terminology.md` is the Czech glossary; `authoring/cz-audit.mjs` checks new
  content against it. Czech content is AI-written and unreviewed — flag it for proofreading, don't
  assume it's correct.
- `reference/` holds the 5 WFDF source PDFs (+ `.txt` extracts) — the citation source of record
  for every `rules[]` entry. `rules.json` / `signals.json` are the compiled quote/signal tables
  those citations resolve against.
- Three classes of dead authored data were removed in Phase 0 and are now guarded against:
  23 pre-chain `options` arrays, 57 `r` values on non-`zone` marks (G13), and the 6 `type: 'zone'`
  fx below (G12). All three were "authored, shipped, never read" — when adding content, assume a
  field you cannot trace to a reader is dead.
- The 6 dead `type: 'zone'` fx deleted in Phase 0 (pl7, rf3, sp5, ob2, gl1, gl2) are logged in
  `authoring/content-backlog.md` for reauthoring as `{ type: 'mark', kind: 'zone' }` once there is
  a Playwright visual baseline to check the result against — don't reintroduce bare `type: 'zone'`
  fx, `buildFx`'s Phase 1 successor still won't render it.
- `test/chains.mjs` and `test/mobile.mjs` from the prototype repo (which drove all scenarios
  through the spoiler gate, and a mobile-viewport smoke pass) become Playwright specs in a future
  `e2e/` — do not lose that coverage when the UI lands; nothing in this package's vitest suite
  replaces it.

## Testing

Plain vitest in `test/`. Do not import `@effect/vitest` — this package has no Effect dependency to
test against.

```bash
pnpm --filter @sideline/rules test
pnpm --filter @sideline/rules check
pnpm --filter @sideline/rules build
```
