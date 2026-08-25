/**
 * The animation runtime: `animLimit` is the spoiler gate (half A — see
 * `chain.ts` for half B), and `pathTangents` / `ipos` / `createAnimator` are
 * the motion maths.
 *
 * Motion along a keyframe path uses monotone cubic Hermite interpolation
 * (Fritsch-Carlson tangents) rather than easing each segment on its own —
 * this is C1-continuous, so speed carries through a keyframe, and — unlike
 * a plain Catmull-Rom — the monotone tangent clamp guarantees no overshoot,
 * so a disc that lands on a spot never swings past it. End tangents are
 * zero, so a path still eases out of its first keyframe and settles into
 * its last. This ports the source's `pathTangents` / `ipos`
 * character-for-character (Phase 0 plan, decision D3) — do not substitute
 * an easing library, do not "simplify" the clamp.
 */
import type { Keyframe, Scenario } from '../types.js';
import type { Answer, Mode } from './state.js';

/** `1` selects the `x` component of a keyframe, `2` selects `y` (index 0 is `t`). */
type Axis = 1 | 2;

/**
 * `animLimit` is the spoiler gate: in `exam` the demo never plays past
 * `qAt` regardless of the (nonexistent, in exam) answer state; in `review`
 * it always plays through to `dur`; in `learn` it is `qAt` until the whole
 * chain is answered, then `dur`.
 */
export function animLimit(args: {
  readonly mode: Mode;
  readonly scenario: Scenario;
  readonly answer: Answer;
}): number {
  const { mode, scenario, answer } = args;
  if (mode === 'exam') return scenario.qAt;
  if (mode === 'review') return scenario.dur;
  return answer.done ? scenario.dur : scenario.qAt;
}

/**
 * Tangents for one path's one axis, ported verbatim from the source. Zero
 * at both ends (ease out of the start, settle at the end); zero wherever
 * the direction reverses (a stationary point is planted rather than
 * overshooting); otherwise the average slope, clamped to
 * `3 * min(|d[i-1]|, |d[i]|)` — the monotone Fritsch-Carlson clamp that
 * guarantees no overshoot.
 */
export function pathTangents(kf: readonly Keyframe[], axis: Axis): number[] {
  const n = kf.length;
  const d: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const cur = kf[i];
    const next = kf[i + 1];
    d[i] = (next[axis] - cur[axis]) / (next[0] - cur[0] || 1e-6);
  }
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) {
      m[i] = 0;
      continue;
    }
    const a = d[i - 1];
    const b = d[i];
    if (a * b <= 0) {
      m[i] = 0;
      continue;
    }
    m[i] = (a + b) / 2;
    const lim = 3 * Math.min(Math.abs(a), Math.abs(b));
    if (Math.abs(m[i]) > lim) m[i] = m[i] < 0 ? -lim : lim;
  }
  return m;
}

/** The Hermite basis, given precomputed tangents for both axes. Shared by
 * `ipos` (which computes tangents fresh, since it has no path identity to
 * cache against) and `createAnimator` (which precomputes tangents once per
 * path — see decision D3). */
function hermiteAt(
  kf: readonly Keyframe[],
  t: number,
  mx: readonly number[],
  my: readonly number[],
): [number, number] {
  const first = kf[0];
  if (t <= first[0]) return [first[1], first[2]];
  const last = kf[kf.length - 1];
  if (t >= last[0] || kf.length < 2) return [last[1], last[2]];
  let i = 0;
  while (i < kf.length - 2 && t > kf[i + 1][0]) i++;
  // `i` is bounded above by the `while` to `kf.length - 2`, so `i + 1` never
  // exceeds `kf.length - 1` — `kf[i+1]` and `mx`/`my`[i+1] below are in range.
  const a = kf[i];
  const b = kf[i + 1];
  const h = b[0] - a[0] || 1e-6;
  const u = (t - a[0]) / h;
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  return [
    h00 * a[1] + h10 * h * mx[i] + h01 * b[1] + h11 * h * mx[i + 1],
    h00 * a[2] + h10 * h * my[i] + h01 * b[2] + h11 * h * my[i + 1],
  ];
}

/**
 * Position at time `t` along a keyframe path, ported from the source's
 * `ipos`. The source cached `mx`/`my` by writing onto the (imported!)
 * keyframe array — shared mutable state that breaks on a long-lived server
 * and on frozen content (decision D3). This version has no path identity to
 * cache against, so it recomputes tangents fresh on every call; callers that
 * sample the same path many times per frame (i.e. `createAnimator`) should
 * precompute once instead of calling this directly.
 */
export function ipos(kf: readonly Keyframe[], t: number): [number, number] {
  const mx = pathTangents(kf, 1);
  const my = pathTangents(kf, 2);
  return hermiteAt(kf, t, mx, my);
}

export type Animator = {
  /** `null` when `actorId` does not resolve to any actor on the scenario —
   * callers must handle it, rather than getting a silent `[0, 0]` (the
   * field's origin, which sits inside the view for most scenarios and would
   * otherwise render a bad id as a player standing there). */
  readonly posAt: (actorId: string, t: number) => [number, number] | null;
  readonly discAt: (t: number) => [number, number];
};

/**
 * Precomputes Hermite tangents for every actor path and the disc path
 * exactly once, then closes over them — replacing the source's
 * cache-on-the-array trick with a structural guarantee that works on frozen
 * content and has no identity question (decision D3).
 *
 * Measured: re-creating an animator every frame for all 8 paths of the
 * worst real scenario costs ~0.32 ms of CPU per second of animation versus
 * ~0.06 ms/s for reusing one — both trivial against a 16.7 ms/frame budget.
 * So the performance angle is not why this exists and Phase 1 should not
 * contort its component tree chasing it; the actual value is correctness on
 * frozen content and having no cache-identity question, not speed.
 *
 * The keyframes live in the same map entry as their own tangents (keyed by
 * actor id, last write wins on a duplicate id — same as the `Map` itself).
 * `posAt` used to re-resolve the actor separately via `scenario.actors.find`
 * (first match), which for a duplicate id paired actor A's keyframes with
 * actor B's tangents — a path belonging to neither. There is now exactly one
 * source of truth per id.
 */
export function createAnimator(scenario: Scenario): Animator;
/** @internal test-only overload so a test can count tangent computations;
 * stripped from `dist/**\/*.d.ts` by `stripInternal` (see
 * `tsconfig.build.json`) — the public signature is the single-argument one
 * above. */
export function createAnimator(
  scenario: Scenario,
  deps: { readonly pathTangents?: typeof pathTangents },
): Animator;
export function createAnimator(
  scenario: Scenario,
  deps?: { readonly pathTangents?: typeof pathTangents },
): Animator {
  const compute = deps?.pathTangents ?? pathTangents;

  const actorTangents = new Map<
    string,
    {
      readonly kf: readonly Keyframe[];
      readonly mx: readonly number[];
      readonly my: readonly number[];
    }
  >();
  for (const a of scenario.actors) {
    actorTangents.set(a.id, { kf: a.kf, mx: compute(a.kf, 1), my: compute(a.kf, 2) });
  }
  const discTangents = { mx: compute(scenario.disc.kf, 1), my: compute(scenario.disc.kf, 2) };

  return {
    posAt(actorId, t) {
      const entry = actorTangents.get(actorId);
      if (!entry) return null;
      return hermiteAt(entry.kf, t, entry.mx, entry.my);
    },
    discAt(t) {
      return hermiteAt(scenario.disc.kf, t, discTangents.mx, discTangents.my);
    },
  };
}
