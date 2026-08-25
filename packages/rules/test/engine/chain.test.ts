/**
 * The spoiler gate, half B: `chainView` is the pure decision logic behind
 * the old `chainHTML` (see the Phase 0 plan, decision D9). Two regressions
 * this file exists to prevent forever:
 *  - a locked step leaking its key label (the dimension name can itself be
 *    a spoiler — e.g. "Where it restarts" implies there IS a restart)
 *  - the exam rendering more than the single live step, or leaking a verdict
 */
import { describe, expect, it } from 'vitest';
import { answer, scenario, step, stepPick } from './helpers.js';

const { chainView } = await import('~/engine/chain.js');

describe('chainView', () => {
  it('locked steps have showKeyLabel: false', () => {
    const sc = scenario({
      steps: [step({ k: 'what' }), step({ k: 'where' }), step({ k: 'restart' })],
    });
    // Nothing answered yet: step 0 is current, steps 1 and 2 are locked.
    const entries = chainView(sc, answer(), 'learn');
    const locked = entries.filter((e) => e.state === 'locked');
    expect(locked.length).toBeGreaterThan(0);
    for (const e of locked) {
      expect(e.showKeyLabel).toBe(false);
    }
  });

  it('exam mode: exactly one entry is not hidden, and showVerdict is false everywhere', () => {
    const sc = scenario({
      steps: [step({ k: 'what' }), step({ k: 'where' }), step({ k: 'result' })],
    });
    const a = answer({ steps: [stepPick(0, true)] }); // one step answered, chain not done
    const entries = chainView(sc, a, 'exam');
    expect(entries).toHaveLength(3);
    const visible = entries.filter((e) => e.state !== 'hidden');
    expect(visible).toHaveLength(1);
    for (const e of entries) {
      expect(e.showVerdict).toBe(false);
    }
  });

  it('exam mode: the single visible entry is the current (live) step, not an answered one', () => {
    const sc = scenario({ steps: [step({ k: 'what' }), step({ k: 'where' })] });
    const a = answer({ steps: [stepPick(0, true)] });
    const entries = chainView(sc, a, 'exam');
    const visible = entries.find((e) => e.state !== 'hidden');
    expect(visible?.index).toBe(1);
    expect(visible?.state).toBe('current');
  });

  it('a dimension key label appears only on its first occurrence in the chain', () => {
    const sc = scenario({
      steps: [step({ k: 'result' }), step({ k: 'result' })],
    });
    // Both steps visible: step 0 answered, step 1 current.
    const a = answer({ steps: [stepPick(0, true)] });
    const entries = chainView(sc, a, 'learn');
    expect(entries[0]?.showKeyLabel).toBe(true);
    expect(entries[1]?.showKeyLabel).toBe(false);
  });

  it('answered steps outside the exam are state: answered with showVerdict: true', () => {
    const sc = scenario({ steps: [step(), step()] });
    const a = answer({ steps: [stepPick(0, true)] });
    const entries = chainView(sc, a, 'learn');
    expect(entries[0]?.state).toBe('answered');
    expect(entries[0]?.showVerdict).toBe(true);
  });

  it('review mode also shows verdicts on answered steps and never hides them', () => {
    const sc = scenario({ steps: [step(), step()] });
    const a = answer({ steps: [stepPick(0, true), stepPick(0, true)], done: true, ok: true });
    const entries = chainView(sc, a, 'review');
    for (const e of entries) {
      expect(e.state).not.toBe('hidden');
    }
    expect(entries[0]?.showVerdict).toBe(true);
    expect(entries[1]?.showVerdict).toBe(true);
  });

  it('a completed chain in learn mode has no locked or current entries left', () => {
    const sc = scenario({ steps: [step(), step()] });
    const a = answer({ steps: [stepPick(0, true), stepPick(0, true)], done: true, ok: true });
    const entries = chainView(sc, a, 'learn');
    for (const e of entries) {
      expect(e.state).toBe('answered');
    }
  });

  it('relays a non-identity permutation on answered, current AND locked entries', () => {
    const sc = scenario({
      steps: [step({ k: 'a' }), step({ k: 'b' }), step({ k: 'c' })],
    });
    const a = answer({ steps: [stepPick(0, true)] }); // step 0 answered, step 1 current, step 2 locked
    const perms = [
      [1, 0],
      [1, 0],
      [1, 0],
    ];
    const entries = chainView(sc, a, 'learn', perms);
    expect(entries[0]?.state).toBe('answered');
    expect(entries[1]?.state).toBe('current');
    expect(entries[2]?.state).toBe('locked');
    expect(entries[0]?.order).toEqual([1, 0]);
    expect(entries[1]?.order).toEqual([1, 0]);
    expect(entries[2]?.order).toEqual([1, 0]);
  });

  it('falls back to identity order when perms is omitted', () => {
    const sc = scenario({ steps: [step(), step()] });
    const entries = chainView(sc, answer(), 'learn');
    for (const e of entries) {
      expect(e.order).toEqual(sc.steps[e.index]?.opts.map((_, j) => j));
    }
  });
});
