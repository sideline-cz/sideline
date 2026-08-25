/**
 * `startExam` — written to the PROPERTY the source violates (Phase 0 plan,
 * decision D10): every selected package must be representable in the exam
 * whenever `EXAM_N >= |selection|`.
 *
 * The source stratified by `topic.en` (`Object.values(byTopic).map(pick
 * one).slice(0, want)`), which silently dropped whichever topic-group was
 * inserted last once there were more distinct `topic.en` strings than
 * `EXAM_N` — two authoring duplicates (`'The pull'`/`'Pull'`,
 * `'Marker & thrower fouls'`/`'Thrower & marker fouls'`) turned 9 packages
 * into 11 topic-groups, so Stoppages (level 9) could never be drawn. This
 * version strata by `level` directly, which is the actual unit of
 * selection (`sel: readonly Level[]`) and is immune to any topic-string
 * duplication in content: one random pick per level, the bucket order
 * itself shuffled first, then a round-robin fill (also shuffled per bucket)
 * tops up to `want` without re-concentrating on whichever bucket happens to
 * be first.
 *
 * An empty `sel` returns an empty `ExamState` rather than falling back to
 * "examine everything" — the source's fallback (`selected.length > 0 ?
 * selected : scenarios.map(...)`) was only safe there because the exam
 * button was `disabled` while the pool was empty, making the branch
 * unreachable. As a pure function callable directly (e.g. from a Phase 2 RPC
 * handler with client-supplied `sel`), silently examining unselected content
 * is a real defect, not a faithful port. The caller — whoever renders the
 * "start exam" action — is responsible for keeping that action disabled on
 * an empty selection, exactly as the source's button did.
 */
import { EXAM_N } from '../constants.js';
import type { Level, Scenario, ScenarioId } from '../types.js';
import { buildPerms, shuffle } from './perms.js';
import { pool } from './pool.js';
import { blankAnswer, type ExamState } from './state.js';

export function startExam(
  scenarios: readonly Scenario[],
  sel: readonly Level[],
  rng: () => number = Math.random,
): ExamState {
  if (sel.length === 0) return { qs: [], perms: [], answers: [], i: 0 };

  const ps = pool(scenarios, sel);
  const want = Math.min(EXAM_N, ps.length);

  const byId = new Map(scenarios.map((sc) => [sc.id, sc] as const));
  const buckets = new Map<Level, ScenarioId[]>();
  for (const id of ps) {
    const sc = byId.get(id);
    if (!sc) continue;
    const bucket = buckets.get(sc.level);
    if (bucket) bucket.push(id);
    else buckets.set(sc.level, [id]);
  }

  const shuffledBuckets = shuffle([...buckets.values()], rng);

  const picks: ScenarioId[] = [];
  for (const bucket of shuffledBuckets) {
    if (picks.length >= want) break;
    const chosen = bucket[Math.floor(rng() * bucket.length)];
    if (chosen !== undefined) picks.push(chosen);
  }

  if (picks.length < want) {
    const leftovers = shuffledBuckets.map((bucket) =>
      shuffle(
        bucket.filter((id) => !picks.includes(id)),
        rng,
      ),
    );
    let bi = 0;
    while (picks.length < want && leftovers.some((bucket) => bucket.length > 0)) {
      const bucket = leftovers[bi % leftovers.length];
      const next = bucket?.shift();
      if (next !== undefined) picks.push(next);
      bi++;
    }
  }

  // `picks.length` is bounded at `want` by construction above (the first
  // loop breaks at `want`, the fill loop's `while` condition stops at
  // `want`), so this `.slice(0, want)` is a shuffle, not a truncation.
  const qs = shuffle(picks, rng);
  const perms = qs.map((id) => {
    const sc = byId.get(id);
    return sc ? buildPerms(sc, rng) : [];
  });

  return { qs, perms, answers: qs.map(() => blankAnswer()), i: 0 };
}
