/**
 * `startExam` — written as PROPERTIES, not a transcription of today's
 * behaviour (Phase 0 plan, decision D10). The source has a live
 * stratification bug: with all 9 levels selected, `Object.values(byTopic)`
 * produces 11 entries (two authoring duplicates:
 * `'The pull'`/`'Pull'` and `'Marker & thrower fouls'`/`'Thrower & marker
 * fouls'`), gets sliced to 10, and drops the last insertion-order topic —
 * Level 9 (Stoppages) can never appear. A test transcribed from that
 * behaviour would pass today and hide the bug forever. These tests must
 * FAIL against the unfixed logic and PASS once D10's fix lands.
 */
import { describe, expect, it } from 'vitest';
import { EXAM_N, LEVELS } from '~/constants.js';
import type { Level, Scenario, ScenarioId } from '~/types.js';
import { loc, makeRng, scenario, sid, step } from './helpers.js';

const { startExam } = await import('~/engine/exam.js');

/** Two scenarios per level, each with a unique per-level topic and a 2-step
 * chain (so the perm-shape assertions below have something to check). */
function buildLeveledContent(levels: readonly Level[]): readonly Scenario[] {
  const out: Scenario[] = [];
  for (const level of levels) {
    for (const n of [1, 2]) {
      out.push(
        scenario({
          id: sid(`l${level}s${n}`),
          level,
          topic: loc(`Topic ${level}`),
          steps: [step({ k: 'a' }), step({ k: 'b' })],
        }),
      );
    }
  }
  return out;
}

/**
 * Reproduces the real content's exact stratification-bug shape: levels 1
 * and 4 each authored under two distinct topic strings (`'The pull'` /
 * `'Pull'`, `'Marker & thrower fouls'` / `'Thrower & marker fouls'`),
 * yielding 11 topic-groups spread over 9 levels — one more than `EXAM_N`.
 * This is precisely why `Object.values(byTopic).slice(0, want)` used to
 * drop the last-inserted group (Stoppages, level 9) once the slice bound
 * was reached (Phase 0 plan, decision D10). A fix that stratifies fairly
 * (shuffle + round-robin fill, or grouping by level instead of raw topic
 * text) must still surface every level here.
 */
function buildDuplicateTopicContent(): readonly Scenario[] {
  const out: Scenario[] = [];
  let n = 0;
  for (const level of LEVELS) {
    const topics =
      level === 1
        ? ['The pull', 'Pull']
        : level === 4
          ? ['Marker & thrower fouls', 'Thrower & marker fouls']
          : [`Topic ${level}`];
    for (const topic of topics) {
      out.push(
        scenario({
          id: sid(`s${++n}`),
          level,
          topic: loc(topic),
          steps: [step({ k: 'a' }), step({ k: 'b' })],
        }),
      );
    }
  }
  return out;
}

function levelOf(scenarios: readonly Scenario[], id: ScenarioId): Level {
  const sc = scenarios.find((s) => s.id === id);
  if (!sc) throw new Error(`no scenario ${id}`);
  return sc.level;
}

describe('startExam', () => {
  it('every selected package is represented when EXAM_N >= |selection| (D10)', () => {
    // 11 topic-groups over 9 levels (the exact real-content bug shape) with
    // a pool of 11 scenarios and EXAM_N=10 — the naive
    // `Object.values(byTopic).slice(0, want)` drops the last-inserted group
    // (level 9) here. This must FAIL against that logic and PASS once D10
    // ships fair stratification.
    const scenarios = buildDuplicateTopicContent();
    expect(EXAM_N).toBeGreaterThanOrEqual(LEVELS.length);
    const ex = startExam(scenarios, LEVELS, makeRng(1));
    const levelsDrawn = new Set(ex.qs.map((id) => levelOf(scenarios, id)));
    expect(levelsDrawn).toEqual(new Set(LEVELS));
  });

  it('every selected package is represented — also holds for uniformly-topicked content', () => {
    const scenarios = buildLeveledContent(LEVELS);
    const ex = startExam(scenarios, LEVELS, makeRng(1));
    const levelsDrawn = new Set(ex.qs.map((id) => levelOf(scenarios, id)));
    expect(levelsDrawn).toEqual(new Set(LEVELS));
  });

  it('never returns more than min(EXAM_N, poolSize) questions — small pool', () => {
    const scenarios = buildLeveledContent([1]);
    const ex = startExam(scenarios, [1], makeRng(2));
    expect(ex.qs.length).toBe(Math.min(EXAM_N, scenarios.length));
    expect(ex.qs.length).toBe(2);
  });

  it('never returns more than min(EXAM_N, poolSize) questions — large pool', () => {
    const scenarios = buildLeveledContent(LEVELS);
    const ex = startExam(scenarios, LEVELS, makeRng(3));
    expect(ex.qs.length).toBe(Math.min(EXAM_N, scenarios.length));
    expect(ex.qs.length).toBe(EXAM_N);
  });

  it('only draws from scenarios whose level is in sel', () => {
    const scenarios = buildLeveledContent(LEVELS);
    const sel: readonly Level[] = [2, 5];
    const ex = startExam(scenarios, sel, makeRng(4));
    for (const id of ex.qs) {
      expect(sel).toContain(levelOf(scenarios, id));
    }
  });

  it('is deterministic under an injected stub rng', () => {
    const scenarios = buildLeveledContent(LEVELS);
    const first = startExam(scenarios, LEVELS, makeRng(42));
    const second = startExam(scenarios, LEVELS, makeRng(42));
    expect(second.qs).toEqual(first.qs);
    expect(second.perms).toEqual(first.perms);
  });

  it('yields exactly one perm array per step of each drawn scenario, each a genuine permutation', () => {
    const scenarios = buildLeveledContent(LEVELS);
    const ex = startExam(scenarios, LEVELS, makeRng(5));
    expect(ex.perms).toHaveLength(ex.qs.length);
    ex.qs.forEach((id, qIdx) => {
      const sc = scenarios.find((s) => s.id === id);
      if (!sc) throw new Error('missing scenario');
      const stepPerms = ex.perms[qIdx];
      expect(stepPerms).toHaveLength(sc.steps.length);
      sc.steps.forEach((st, stepIdx) => {
        const perm = stepPerms?.[stepIdx] ?? [];
        expect([...perm].sort((a, b) => a - b)).toEqual(st.opts.map((_, j) => j));
      });
    });
  });

  it('an empty selection returns an empty ExamState rather than examining everything', () => {
    // The source's fallback (`selected.length > 0 ? selected :
    // scenarios.map(...)`) only worked because its exam button was disabled
    // on an empty pool. Called directly, it silently examined every level —
    // exactly the shape a Phase 2 RPC handler must not reproduce.
    const scenarios = buildLeveledContent(LEVELS);
    const ex = startExam(scenarios, [], makeRng(7));
    expect(ex).toEqual({ qs: [], perms: [], answers: [], i: 0 });
  });

  it('a selection larger than EXAM_N still draws exactly one per level (unchanged, but pinned)', () => {
    const scenarios = buildLeveledContent(LEVELS);
    const ex = startExam(scenarios, LEVELS, makeRng(8));
    expect(ex.qs.length).toBe(EXAM_N);
    const levelsDrawn = new Set(ex.qs.map((id) => levelOf(scenarios, id)));
    expect(levelsDrawn.size).toBe(LEVELS.length);
  });

  it('starts with blank answers and i = 0', () => {
    const scenarios = buildLeveledContent(LEVELS);
    const ex = startExam(scenarios, LEVELS, makeRng(6));
    expect(ex.i).toBe(0);
    expect(ex.answers).toHaveLength(ex.qs.length);
    for (const a of ex.answers) {
      expect(a).toEqual({ steps: [], done: false, ok: false });
    }
  });
});
