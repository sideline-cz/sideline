/**
 * Pure content-guard functions, ported from `frisbee-rules`' `build.mjs` +
 * `test/independence.mjs` + `test/duplication.mjs`.
 *
 * Every guard here is a plain function over data — no `readFileSync`, no
 * `process.exit`. This is what lets each guard be exercised twice per the
 * TDD spec: once against the real, already-landed content (where it MUST
 * pass, proving the port is faithful) and once against a deliberately
 * malformed fixture (proving the guard actually bites and isn't a tautology).
 *
 * `test/guards/*.test.ts` import these; `test/guards/fixtures.ts` builds the
 * minimal valid scenario/package these functions operate on.
 */
import type {
  Actor,
  Disc,
  Fx,
  FxArrow,
  FxBubble,
  FxFlash,
  FxMark,
  Lang,
  Level,
  Localized,
  Option,
  RulesPackage,
  Scenario,
  Step,
} from '~/types.js';

/* ---------------------------------------------------------------- G1 ---- */
/** No duplicate scenario `id` across packages. */
export function findDuplicateScenarioIds(packages: readonly RulesPackage[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) {
      if (seen.has(sc.id)) problems.push(`duplicate scenario id ${sc.id}`);
      seen.add(sc.id);
    }
  }
  return problems;
}

/* ---------------------------------------------------------------- G2 ---- */
/** `sc.level` equals its owning package's `level`. */
export function findLevelMismatches(packages: readonly RulesPackage[]): string[] {
  const problems: string[] = [];
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) {
      if (sc.level !== pkg.level) {
        problems.push(`${sc.id} has level ${sc.level} but sits in a level-${pkg.level} package`);
      }
    }
  }
  return problems;
}

/* ---------------------------------------------------------------- G3 ---- */
/** Non-empty chain on every scenario. */
export function findEmptyChains(packages: readonly RulesPackage[]): string[] {
  const problems: string[] = [];
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) {
      if (!sc.steps || sc.steps.length === 0) problems.push(`${sc.id} has no outcome chain`);
    }
  }
  return problems;
}

/* ---------------------------------------------------------------- G4 ---- */
/**
 * `qAt` defined. `types.ts` declares `qAt: number` (not optional) — this
 * guard still matters at runtime because there is no `Schema` decode (D2):
 * a malformed JSON file would satisfy the TS types via the `as unknown as
 * RulesPackage` cast in `content.ts` without ever having the field.
 */
export function findMissingQAt(packages: readonly RulesPackage[]): string[] {
  const problems: string[] = [];
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) {
      if ((sc as { qAt?: number }).qAt === undefined) {
        problems.push(`${sc.id}: no qAt — the demo would play its resolution`);
      }
    }
  }
  return problems;
}

/* ---------------------------------------------------------------- G5 ---- */
/** `qAt < dur`. */
export function findQAtNotBeforeDur(packages: readonly RulesPackage[]): string[] {
  const problems: string[] = [];
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) {
      if (sc.qAt >= sc.dur) problems.push(`${sc.id}: qAt ${sc.qAt} >= dur ${sc.dur}`);
    }
  }
  return problems;
}

/* ---------------------------------------------------------------- G6 ---- */
/** Exactly one `ok:true` per step. */
export function findWrongOkCounts(packages: readonly RulesPackage[]): string[] {
  const problems: string[] = [];
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) {
      sc.steps.forEach((st, i) => {
        const correct = st.opts.filter((o) => o.ok === true).length;
        if (correct !== 1)
          problems.push(`${sc.id} step ${i + 1}: ${correct} correct options, expected 1`);
      });
    }
  }
  return problems;
}

/* ---------------------------------------------------------------- G7 ---- */
/** Scenario `rules[]` AND every step's `rules[]` resolve in `rules.json`. */
export function findUnresolvedRules(
  packages: readonly RulesPackage[],
  rules: Readonly<Record<string, unknown>>,
): string[] {
  const problems: string[] = [];
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) {
      for (const r of sc.rules ?? []) {
        if (!rules[r]) problems.push(`${sc.id}: § ${r} has no RULES entry`);
      }
      sc.steps.forEach((st, i) => {
        for (const r of st.rules ?? []) {
          if (!rules[r]) problems.push(`${sc.id} step ${i + 1}: § ${r} has no RULES entry`);
        }
      });
    }
  }
  return problems;
}

/* ---------------------------------------------------------------- G8 ---- */
/** `signals[]` resolve in `signals.json`. */
export function findUnresolvedSignals(
  packages: readonly RulesPackage[],
  signals: Readonly<Record<string, unknown>>,
): string[] {
  const problems: string[] = [];
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) {
      for (const n of sc.signals ?? []) {
        if (!signals[String(n)]) problems.push(`${sc.id}: hand signal ${n} does not exist`);
      }
    }
  }
  return problems;
}

/* ---------------------------------------------------------------- G9 ---- */
/**
 * Both `en` and `cs` on `title`/`situation`/`question`/`explain`, on each
 * step's `q`, and on each option's `t` and `why`.
 */
export function findMissingLanguages(packages: readonly RulesPackage[]): string[] {
  const problems: string[] = [];
  const SCENARIO_TEXT_FIELDS = ['title', 'situation', 'question', 'explain'] as const;
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) {
      for (const field of SCENARIO_TEXT_FIELDS) {
        const val = sc[field] as Localized<string> | undefined;
        if (!val?.en || !val?.cs) problems.push(`${sc.id}: ${field} is missing a language`);
      }
      sc.steps.forEach((st, i) => {
        if (!st.q?.en || !st.q?.cs)
          problems.push(`${sc.id} step ${i + 1}: question missing a language`);
        st.opts.forEach((o, j) => {
          if (!o.t?.en || !o.t?.cs || !o.why?.en || !o.why?.cs) {
            problems.push(`${sc.id} step ${i + 1} option ${j + 1}: missing text`);
          }
        });
      });
    }
  }
  return problems;
}

/* --------------------------------------------------------------- G10 ---- */
/**
 * Actor kf, disc kf and fx coordinates all inside the scenario's own `view`.
 *
 * Ports `build.mjs`'s in-view check, but fixes the gap the plan calls out:
 * the original `if (f.x !== undefined)` guard skips every `arrow` fx (whose
 * coordinates are `x1/y1/x2/y2`, not `x/y`) — all 16 of them, silently. This
 * version checks `arrow` fx by their own coordinate pair, both ends.
 * `bubble` fx are exempt — they carry no coordinates of their own (they are
 * positioned relative to their `actor` at render time).
 */
export function findOutOfViewPoints(packages: readonly RulesPackage[]): string[] {
  const problems: string[] = [];
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) {
      const [vx, vy, vw, vh] = sc.view;
      const inView = (x: number, y: number) => x >= vx && x <= vx + vw && y >= vy && y <= vy + vh;
      for (const a of sc.actors) {
        for (const [, x, y] of a.kf) {
          if (!inView(x, y))
            problems.push(
              `${sc.id}: actor ${a.id} at (${x},${y}) is outside view [${sc.view.join(',')}]`,
            );
        }
      }
      for (const [, x, y] of sc.disc.kf) {
        if (!inView(x, y))
          problems.push(`${sc.id}: disc at (${x},${y}) is outside view [${sc.view.join(',')}]`);
      }
      for (const f of sc.fx) {
        if (f.type === 'arrow') {
          if (!inView(f.x1, f.y1)) {
            problems.push(
              `${sc.id}: fx arrow start (${f.x1},${f.y1}) is outside view [${sc.view.join(',')}]`,
            );
          }
          if (!inView(f.x2, f.y2)) {
            problems.push(
              `${sc.id}: fx arrow end (${f.x2},${f.y2}) is outside view [${sc.view.join(',')}]`,
            );
          }
        } else if (f.type === 'flash' || f.type === 'mark') {
          if (!inView(f.x, f.y)) {
            problems.push(
              `${sc.id}: fx ${f.type} at (${f.x},${f.y}) is outside view [${sc.view.join(',')}]`,
            );
          }
        }
      }
    }
  }
  return problems;
}

/* --------------------------------------------------------------- G11 ---- */
/**
 * No cross-reference regex hit in `title`/`situation`/`question`/`note` and
 * step `q`, both languages; no hard-coded scenario count in content or in
 * `authoring/ui.json`. Both regexes ported verbatim from `independence.mjs`.
 */
export const CROSS_REFERENCE =
  /\b[Ss]ame (play|stack|mark|deep|block)\b|\bagain\b|[Pp]erspective flip|Obrácená perspektiva|příští situac|předchozí situac|další situace|next scenario|previous scenario|scenario \d+|situací \d+|this package/;
/**
 * FIXED relative to `independence.mjs`, which used a trailing `\b` here.
 *
 * JavaScript's `\b` is defined against ASCII `\w` ([A-Za-z0-9_]) regardless of
 * flags. "situací" ends in "í", which is therefore a NON-word character, so the
 * boundary could only fire when an ASCII word character followed immediately —
 * which never happens in prose, where a space or punctuation always follows.
 * Both Czech alternatives were consequently dead: the guard silently checked
 * English only.
 *
 * That matters because the Czech half of the content is the AI-written,
 * unreviewed half (see the trainer plan's Risks), i.e. exactly where a stale
 * hard-coded count is most likely to survive. A guard that quietly skips it is
 * worse than no guard, because it reads as coverage.
 *
 * The Unicode-aware negative lookahead keeps the intended "not part of a longer
 * word" semantics for every alternative, in both languages. Verified: the
 * English cases behave identically, the three Czech cases go from false to
 * true, and real content still has zero hits.
 */
export const HARDCODED_COUNT =
  /\b\d{2,3} (game situations|situations|herních situací|situací)(?![\p{L}\p{N}_])/u;

export function findIndependenceViolations(packages: readonly RulesPackage[]): string[] {
  const problems: string[] = [];
  const check = (where: string, text: string | undefined) => {
    if (!text) return;
    const cross = CROSS_REFERENCE.exec(text);
    if (cross) problems.push(`${where}: cross-reference — "${cross[0]}"`);
    const count = HARDCODED_COUNT.exec(text);
    if (count) problems.push(`${where}: hard-coded count — "${count[0]}"`);
  };
  const FIELDS = ['title', 'situation', 'question', 'note'] as const;
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) {
      for (const lang of ['en', 'cs'] as const) {
        for (const field of FIELDS)
          check(`${sc.id}.${field}.${lang}`, (sc[field] as Localized<string> | undefined)?.[lang]);
        sc.steps.forEach((st, i) => {
          check(`${sc.id}.step${i + 1}.${lang}`, st.q?.[lang]);
        });
      }
    }
  }
  return problems;
}

/**
 * UI chrome is exempt from the cross-reference rule (it legitimately
 * describes the trainer itself), but must never carry a hard-coded scenario
 * count — that is how the hero copy went stale as content grew.
 */
export function findHardcodedCountsInUi(ui: Readonly<Record<string, unknown>>): string[] {
  const problems: string[] = [];
  for (const [key, val] of Object.entries(ui)) {
    if (typeof val !== 'object' || val === null) continue;
    for (const lang of ['en', 'cs'] as const) {
      const text = (val as Record<string, unknown>)[lang];
      if (typeof text !== 'string') continue;
      const m = HARDCODED_COUNT.exec(text);
      if (m) problems.push(`UI.${key}.${lang}: hard-coded count — "${m[0]}"`);
    }
  }
  return problems;
}

/* --------------------------------------------------------------- G12 ---- */
/** fx `type` ∈ `{bubble,flash,mark,arrow}` and mark `kind` ∈ `{x,target,zone,dot}`. */
const VALID_FX_TYPES = new Set(['bubble', 'flash', 'mark', 'arrow']);
const VALID_MARK_KINDS = new Set(['x', 'target', 'zone', 'dot']);

export function findInvalidFx(packages: readonly RulesPackage[]): string[] {
  const problems: string[] = [];
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) {
      for (const f of sc.fx) {
        if (!VALID_FX_TYPES.has(f.type)) {
          problems.push(`${sc.id}: fx type "${f.type}" is not one of bubble|flash|mark|arrow`);
        } else if (f.type === 'mark' && !VALID_MARK_KINDS.has(f.kind)) {
          problems.push(`${sc.id}: mark kind "${f.kind}" is not one of x|target|zone|dot`);
        }
      }
    }
  }
  return problems;
}

/* --------------------------------------------------------------- G13 ---- */
/**
 * No unknown keys at any level, driven off `src/types.ts`'s own shapes —
 * package, scenario, actor, disc, step, option, fx-per-`type`, and every
 * `Localized<string>` field.
 *
 * The key sets below are no longer a hand-copied duplicate of the types:
 * each is `Object.keys` of a `satisfies Record<keyof X, true>` literal, so
 * TS itself enforces both directions of drift — adding a field to a type
 * and forgetting it here is a missing-property error, and (the direction a
 * hand-copied `Set` could never catch) REMOVING a field from a type while
 * leaving it allowed here is now an excess-property error on the literal,
 * because `keyof X` no longer contains it. `RulesPackage`'s own keys and
 * every `Localized<string>` field's keys (only `en`/`cs` — a stray `de`
 * would previously slip past G9, which only checks that `en`/`cs` are
 * *present*, never that nothing else is) are derived and checked the same
 * way. Tuple arity (`Keyframe`, `view`) is a different shape of the same
 * problem but is checked by G18 instead, since it is about numeric
 * array shapes rather than named keys.
 *
 * This breadth (down to fx-per-type) is what earned G13 its keep in the
 * first place: it flagged 57 `r` values authored on `x`/`target`/`dot`
 * marks, which a scenario-level check would have missed. `buildFx` in the
 * source app only ever reads `f.r` inside the `zone` branch, so `r` on any
 * other mark kind was exactly the same defect class as the dead `options`
 * field (D6): present, authored, and never read. Those 57 have since been
 * deleted; the 12 functional `zone` values remain. `r` stays a valid key of
 * `FxMark` at the type level (a static type cannot express a
 * value-dependent constraint), so the derived key set allows it
 * unconditionally — the guard below narrows it back to `kind === 'zone'`
 * only, as an explicit rule on top of the derived shape, matching the
 * type's own documented intent rather than its looser compile-time shape.
 */
const RULES_PACKAGE_KEYS = new Set(
  Object.keys({ level: true, name: true, scenarios: true } satisfies Record<
    keyof RulesPackage,
    true
  >),
);
const SCENARIO_KEYS = new Set(
  Object.keys({
    id: true,
    level: true,
    topic: true,
    title: true,
    roleTeam: true,
    role: true,
    view: true,
    dur: true,
    qAt: true,
    actors: true,
    disc: true,
    fx: true,
    situation: true,
    question: true,
    explain: true,
    note: true,
    rules: true,
    signals: true,
    steps: true,
  } satisfies Record<keyof Scenario, true>),
);
const ACTOR_KEYS = new Set(
  Object.keys({ id: true, team: true, label: true, kf: true, you: true } satisfies Record<
    keyof Actor,
    true
  >),
);
const DISC_KEYS = new Set(
  Object.keys({ kf: true, downAt: true } satisfies Record<keyof Disc, true>),
);
const STEP_KEYS = new Set(
  Object.keys({ k: true, q: true, rules: true, opts: true } satisfies Record<keyof Step, true>),
);
const OPTION_KEYS = new Set(
  Object.keys({ t: true, ok: true, why: true } satisfies Record<keyof Option, true>),
);
const LOCALIZED_KEYS = new Set(Object.keys({ en: true, cs: true } satisfies Record<Lang, true>));

const FX_KEYS_BY_TYPE: Readonly<Record<string, ReadonlySet<string>>> = {
  bubble: new Set(
    Object.keys({
      t: true,
      type: true,
      dur: true,
      actor: true,
      text: true,
      style: true,
    } satisfies Record<keyof FxBubble, true>),
  ),
  flash: new Set(
    Object.keys({ t: true, type: true, x: true, y: true } satisfies Record<keyof FxFlash, true>),
  ),
  arrow: new Set(
    Object.keys({ t: true, type: true, x1: true, y1: true, x2: true, y2: true } satisfies Record<
      keyof FxArrow,
      true
    >),
  ),
  mark: new Set(
    Object.keys({
      t: true,
      type: true,
      kind: true,
      x: true,
      y: true,
      label: true,
      labelAbove: true,
      r: true,
    } satisfies Record<keyof FxMark, true>),
  ),
};

function unknownKeysOf(obj: object, allowed: ReadonlySet<string>): string[] {
  return Object.keys(obj).filter((k) => !allowed.has(k));
}

/** Flags any key on a `Localized<string>` value other than `en`/`cs` (a
 * stray `de`, a typo'd `En`, …) — G9 only ever checked that `en`/`cs` were
 * present, never that nothing else was. */
function checkLocalizedKeys(where: string, val: Localized<string> | undefined, problems: string[]) {
  if (!val) return;
  for (const k of unknownKeysOf(val, LOCALIZED_KEYS))
    problems.push(`${where}: unknown language "${k}"`);
}

export function findUnknownKeys(packages: readonly RulesPackage[]): string[] {
  const problems: string[] = [];
  for (const pkg of packages) {
    for (const k of unknownKeysOf(pkg, RULES_PACKAGE_KEYS))
      problems.push(`level ${pkg.level} package: unknown package key "${k}"`);
    for (const sc of pkg.scenarios) {
      for (const k of unknownKeysOf(sc, SCENARIO_KEYS))
        problems.push(`${sc.id}: unknown scenario key "${k}"`);
      checkLocalizedKeys(`${sc.id}.topic`, sc.topic, problems);
      checkLocalizedKeys(`${sc.id}.title`, sc.title, problems);
      checkLocalizedKeys(`${sc.id}.role`, sc.role, problems);
      checkLocalizedKeys(`${sc.id}.situation`, sc.situation, problems);
      checkLocalizedKeys(`${sc.id}.question`, sc.question, problems);
      checkLocalizedKeys(`${sc.id}.explain`, sc.explain, problems);
      checkLocalizedKeys(`${sc.id}.note`, sc.note, problems);
      for (const a of sc.actors) {
        for (const k of unknownKeysOf(a, ACTOR_KEYS))
          problems.push(`${sc.id}: unknown actor key "${k}" on ${a.id}`);
      }
      for (const k of unknownKeysOf(sc.disc, DISC_KEYS))
        problems.push(`${sc.id}: unknown disc key "${k}"`);
      sc.steps.forEach((st, i) => {
        for (const k of unknownKeysOf(st, STEP_KEYS))
          problems.push(`${sc.id} step ${i + 1}: unknown step key "${k}"`);
        checkLocalizedKeys(`${sc.id} step ${i + 1}.q`, st.q, problems);
        st.opts.forEach((o, j) => {
          for (const k of unknownKeysOf(o, OPTION_KEYS)) {
            problems.push(`${sc.id} step ${i + 1} option ${j + 1}: unknown option key "${k}"`);
          }
          checkLocalizedKeys(`${sc.id} step ${i + 1} option ${j + 1}.t`, o.t, problems);
          checkLocalizedKeys(`${sc.id} step ${i + 1} option ${j + 1}.why`, o.why, problems);
        });
      });
      for (const f of sc.fx) {
        const allowedForType = FX_KEYS_BY_TYPE[f.type];
        if (!allowedForType) {
          problems.push(`${sc.id}: fx has unknown type "${f.type}"`);
          continue;
        }
        for (const k of unknownKeysOf(f, allowedForType)) {
          problems.push(`${sc.id}: fx (${f.type}) has unknown key "${k}"`);
        }
        if (f.type === 'mark' && f.kind !== 'zone' && 'r' in f) {
          problems.push(`${sc.id}: fx (mark) has unknown key "r"`);
        }
        if (f.type === 'mark') checkLocalizedKeys(`${sc.id}: fx (mark).label`, f.label, problems);
        if (f.type === 'bubble') checkLocalizedKeys(`${sc.id}: fx (bubble).text`, f.text, problems);
      }
    }
  }
  return problems;
}

/* --------------------------------------------------------------- G14 ---- */
/**
 * Duplication guard, ported verbatim from `duplication.mjs`, tuned scoring
 * included.
 *
 * KNOWN LIMIT — read this before trusting a PASS. Verified by injecting a
 * reworded copy of `to3` into a scratch content dir: caught it at 1.00, and
 * the real content passes clean. But that is the whole-chain case. The other
 * three clones in that batch shared only TWO of three steps with their
 * originals (bw1/ts1, cz1/gl1, br1/s1); averaged over a chain that partial
 * overlap lands near the WARN tier, not FAIL. So a PASS here does not mean
 * "no duplication" — it means "nothing retreads an entire chain". When
 * adding content, still read the WARN lines, and still check whether the
 * LESSON is already taught somewhere, which is not the same question as
 * whether the rule is cited.
 */
export const DUPLICATION_WARN = 0.4;
export const DUPLICATION_FAIL = 0.55;

const STOP = new Set(
  (
    'a an the is are was were be been do does did what where who when how why and or but if then than that this those' +
    ' these it its you your they their them there here of to in on at for from with without as by not no yes may must' +
    ' can could should would will shall so now play player players disc team teams rules rule rulebook says say'
  ).split(' '),
);

export function wordBag(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

type ScoredStep = { rules: string; bag: Set<string>; aBag: Set<string> };
export type ScoredScenario = { id: string; title: string; steps: readonly ScoredStep[] };

/** Builds the comparable, pre-bagged representation `chainSimilarity` scores. */
export function scoreScenarios(packages: readonly RulesPackage[]): ScoredScenario[] {
  const scenarios: ScoredScenario[] = [];
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) {
      scenarios.push({
        id: sc.id,
        title: sc.title.en,
        steps: sc.steps.map((st) => {
          const answer = st.opts.find((o) => o.ok === true)?.t.en ?? '';
          return {
            rules: (st.rules ?? []).slice().sort().join(','),
            bag: wordBag(`${st.q.en} ${answer}`),
            aBag: wordBag(answer),
          };
        }),
      });
    }
  }
  return scenarios;
}

export function meanBestMatch(
  short: readonly ScoredStep[],
  long: readonly ScoredStep[],
  key: 'bag' | 'aBag',
): number {
  let total = 0;
  for (const s of short) {
    let best = 0;
    for (const l of long) best = Math.max(best, jaccard(s[key], l[key]));
    total += best;
  }
  return total / short.length;
}

export type SimilarityResult = {
  score: number;
  textScore: number;
  answerScore: number;
  ruleScore: number;
};

/**
 * What actually distinguishes a clone from two scenarios that legitimately
 * apply the same rule:
 *
 *   - a clone gives the same ANSWERS. Rewording the prompts (which is how
 *     the real clone got past a manual read) barely moves this.
 *   - a clone cites the same RULES.
 *
 * Question wording is the weakest signal of the three, so it only breaks
 * ties. Scored separately rather than blended, because a legitimate pair can
 * score HIGHER on question text than a genuine clone does — a single
 * blended number cannot separate them.
 */
export function chainSimilarity(a: ScoredScenario, b: ScoredScenario): SimilarityResult {
  if (!a.steps.length || !b.steps.length)
    return { score: 0, textScore: 0, answerScore: 0, ruleScore: 0 };
  const [short, long] = a.steps.length <= b.steps.length ? [a.steps, b.steps] : [b.steps, a.steps];

  const textScore = meanBestMatch(short, long, 'bag');
  const answerScore = meanBestMatch(short, long, 'aBag');

  const ra = new Set(a.steps.flatMap((s) => s.rules.split(',').filter(Boolean)));
  const rb = new Set(b.steps.flatMap((s) => s.rules.split(',').filter(Boolean)));
  const ruleScore = jaccard(ra, rb);

  const lenRatio = short.length / long.length;
  const score = answerScore * (0.25 + 0.75 * ruleScore) * lenRatio;
  return { score, textScore, answerScore, ruleScore };
}

export type ClonePair = SimilarityResult & { a: string; b: string; aTitle: string; bTitle: string };

export function findClonePairs(
  scenarios: readonly ScoredScenario[],
  threshold: number,
): ClonePair[] {
  const pairs: ClonePair[] = [];
  for (let i = 0; i < scenarios.length; i++) {
    for (let j = i + 1; j < scenarios.length; j++) {
      const r = chainSimilarity(scenarios[i], scenarios[j]);
      if (r.score >= threshold) {
        pairs.push({
          a: scenarios[i].id,
          b: scenarios[j].id,
          aTitle: scenarios[i].title,
          bTitle: scenarios[j].title,
          ...r,
        });
      }
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return pairs;
}

/* --------------------------------------------------------------- G15 ---- */
/** Exactly one distinct `topic.en` per level. */
export function findMultipleTopicsPerLevel(packages: readonly RulesPackage[]): string[] {
  const problems: string[] = [];
  const byLevel = new Map<Level, Set<string>>();
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) {
      const topics = byLevel.get(sc.level) ?? new Set<string>();
      topics.add(sc.topic.en);
      byLevel.set(sc.level, topics);
    }
  }
  for (const [level, topics] of byLevel) {
    if (topics.size !== 1)
      problems.push(
        `level ${level} has ${topics.size} distinct topic.en values: ${[...topics].join(', ')}`,
      );
  }
  return problems;
}

/* --------------------------------------------------------------- G16 ---- */
/** Exactly one `you` actor per scenario. */
export function findYouActorCountViolations(packages: readonly RulesPackage[]): string[] {
  const problems: string[] = [];
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) {
      const count = sc.actors.filter((a) => a.you).length;
      if (count !== 1) problems.push(`${sc.id}: ${count} actors marked you, expected exactly 1`);
    }
  }
  return problems;
}

/* --------------------------------------------------------------- G17 ---- */
/** `LEVEL_META[l].scenarioCount` equals the actual scenario count for that level. */
export function findScenarioCountMismatches(
  packages: readonly RulesPackage[],
  levelMeta: Readonly<Record<number, { scenarioCount: number }>>,
): string[] {
  const problems: string[] = [];
  const counts = new Map<Level, number>();
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) counts.set(sc.level, (counts.get(sc.level) ?? 0) + 1);
  }
  for (const levelKey of Object.keys(levelMeta)) {
    const level = Number(levelKey);
    const actual = counts.get(level as Level) ?? 0;
    if (levelMeta[level].scenarioCount !== actual) {
      problems.push(
        `LEVEL_META[${level}].scenarioCount is ${levelMeta[level].scenarioCount} but actual count is ${actual}`,
      );
    }
  }
  return problems;
}

/* --------------------------------------------------------------- G18 ---- */
/**
 * One numeric/shape guard covering everything the dedicated `qAt` checks
 * (G4/G5) don't. `dur` is exactly as unguarded as `qAt` was before those
 * guards existed — the same "a malformed JSON file satisfies the TS types
 * via the `as unknown as RulesPackage` cast without ever having the field"
 * argument (see G4's doc) applies verbatim, and deleting `sc.dur` currently
 * passes all 17 other guards while breaking `animLimit` for `review` and
 * for `learn` + `done` (both read `scenario.dur`, both would get
 * `undefined`).
 *
 * Also covered, all found to slip through the other 17 guards:
 *  - `qAt`/`dur` of the wrong type (e.g. `qAt: "3"`, which `>=`/`<` would
 *    silently coerce) or out of range (`qAt < 0`)
 *  - `view` without exactly 4 entries, or a non-positive width/height
 *  - an empty `kf` (actor or disc), a keyframe without exactly 3 entries,
 *    or non-monotonic keyframe `t`
 *  - an `fx.t` after the scenario's own `dur`
 *  - a `bubble` fx whose `actor` does not resolve to a real actor id (the
 *    renderer's `actorTeam` falls back to `'off'` for an unknown id, which
 *    would render a defender's call in offence blue)
 *  - a step with fewer than 2 options
 *  - two actors sharing an id within one scenario
 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function checkKeyframes(where: string, kf: unknown, problems: string[]): void {
  if (!Array.isArray(kf) || kf.length === 0) {
    problems.push(`${where}: kf is empty`);
    return;
  }
  let lastT = Number.NEGATIVE_INFINITY;
  kf.forEach((frame: unknown, i) => {
    if (!Array.isArray(frame) || frame.length !== 3) {
      problems.push(`${where}: keyframe ${i} does not have exactly 3 entries`);
      return;
    }
    const [t] = frame;
    if (!isFiniteNumber(t)) {
      problems.push(`${where}: keyframe ${i} has a non-numeric t`);
      return;
    }
    if (t < lastT) problems.push(`${where}: keyframe ${i} has t ${t} before the previous ${lastT}`);
    lastT = t;
  });
}

export function findShapeViolations(packages: readonly RulesPackage[]): string[] {
  const problems: string[] = [];
  for (const pkg of packages) {
    for (const sc of pkg.scenarios) {
      if (!isFiniteNumber(sc.qAt) || !isFiniteNumber(sc.dur) || !(sc.qAt >= 0 && sc.qAt < sc.dur)) {
        problems.push(`${sc.id}: qAt (${sc.qAt}) and dur (${sc.dur}) must satisfy 0 <= qAt < dur`);
      }

      if (!Array.isArray(sc.view) || sc.view.length !== 4) {
        problems.push(`${sc.id}: view does not have exactly 4 entries`);
      } else {
        const [, , w, h] = sc.view;
        if (!(isFiniteNumber(w) && w > 0) || !(isFiniteNumber(h) && h > 0)) {
          problems.push(`${sc.id}: view width/height must be positive, got [${sc.view.join(',')}]`);
        }
      }

      const actorIds = new Set<string>();
      for (const a of sc.actors) {
        if (actorIds.has(a.id)) problems.push(`${sc.id}: duplicate actor id "${a.id}"`);
        actorIds.add(a.id);
        checkKeyframes(`${sc.id}: actor ${a.id}`, a.kf, problems);
      }
      checkKeyframes(`${sc.id}: disc`, sc.disc.kf, problems);

      for (const f of sc.fx) {
        if (!isFiniteNumber(f.t) || (isFiniteNumber(sc.dur) && f.t > sc.dur)) {
          problems.push(`${sc.id}: fx at t=${f.t} is after dur (${sc.dur})`);
        }
        if (f.type === 'bubble' && !actorIds.has(f.actor)) {
          problems.push(`${sc.id}: bubble fx references unknown actor "${f.actor}"`);
        }
      }

      sc.steps.forEach((st, i) => {
        if (!Array.isArray(st.opts) || st.opts.length < 2) {
          problems.push(
            `${sc.id} step ${i + 1}: only ${st.opts?.length ?? 0} option(s), expected at least 2`,
          );
        }
      });
    }
  }
  return problems;
}

/** Re-exported only so fixture builders elsewhere can type fx overrides. */
export type { Fx };
