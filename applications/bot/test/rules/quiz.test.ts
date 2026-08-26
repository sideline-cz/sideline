/**
 * The Discord rules quiz.
 *
 * The centrepiece here is the **spoiler gate**. On web it is enforced partly
 * by `animLimit` freezing the demo; in Discord there is no demo, so the
 * whole gate is `chainView`'s reveal decisions rendered into one message.
 * The two regressions `chainView` exists to prevent
 * (`packages/rules/src/engine/chain.ts`) both have a Discord-shaped form:
 *
 *  - a locked step leaking its key label — "Where it restarts" tells you
 *    there IS a restart before you have decided what happened
 *  - an unanswered step leaking a `why`, which states the ruling outright
 *
 * Both are asserted against the real content, not a fixture, because the
 * failure would be content-dependent.
 */
import type { Scenario } from '@sideline/rules';
import { text } from '@sideline/rules';
import { describe, expect, it } from 'vitest';
import { buildChainMessage } from '~/rest/rules/buildChainMessage.js';
import { buildQuizMessage } from '~/rest/rules/buildQuizMessage.js';
import { quizPerms } from '~/rest/rules/perms.js';
import { ALL_SCENARIOS, pickScenario, scenarioById } from '~/rest/rules/pickScenario.js';
import {
  decodeStartId,
  decodeStepId,
  encodeStartId,
  encodeStepId,
  replayAnswer,
} from '~/rest/rules/quizState.js';

const locale = 'en' as const;

/** A scenario with a genuinely multi-step chain, so "locked" states exist. */
const multiStep = (): Scenario => {
  const found = ALL_SCENARIOS.find((s) => s.steps.length >= 3);
  if (!found) throw new Error('content has no scenario with 3+ steps');
  return found;
};

/** Everything the message would render, as one searchable string — so a
 * "must not appear anywhere" assertion cannot be defeated by the text moving
 * between a field name, a field value, the title or the footer. */
const allText = (embeds: unknown): string => JSON.stringify(embeds);

describe('quizState — custom_id round trip', () => {
  it('round-trips a scenario id and its picks', () => {
    expect(decodeStartId(encodeStartId('pl9'))).toBe('pl9');
    expect(decodeStepId(encodeStepId('pl9', [0, 2, 1]))).toEqual({
      scenarioId: 'pl9',
      picks: [0, 2, 1],
    });
  });

  it('encodes an empty chain, which is how a freshly-opened chain looks', () => {
    expect(decodeStepId(encodeStepId('s1', []))).toEqual({ scenarioId: 's1', picks: [] });
  });

  it('stays well inside Discord’s 100-character custom_id limit', () => {
    // Worst case in the real content: longest id, longest chain, max pick digit.
    const longestId = ALL_SCENARIOS.reduce((a, s) => (s.id.length > a.length ? s.id : a), '');
    const longestChain = ALL_SCENARIOS.reduce((a, s) => Math.max(a, s.steps.length), 0);
    const worst = encodeStepId(
      longestId,
      Array.from({ length: longestChain }, () => 3),
    );
    expect(worst.length).toBeLessThanOrEqual(100);
  });

  it('rejects malformed ids rather than throwing', () => {
    // A custom_id is untrusted: a user can craft an interaction with any id.
    expect(decodeStepId('rules-step:pl9')).toBeUndefined(); // no separator
    expect(decodeStepId('rules-step::012')).toBeUndefined(); // no scenario
    expect(decodeStepId('rules-step:pl9:9')).toBeUndefined(); // pick out of digit range
    expect(decodeStepId('rules-step:pl9:abc')).toBeUndefined(); // non-numeric
    expect(decodeStepId('rules-step:pl9:000000')).toBeUndefined(); // longer than any chain
    expect(decodeStepId('poll-vote:1:2')).toBeUndefined(); // another feature's id
    expect(decodeStartId('rules-start:')).toBeUndefined();
    expect(scenarioById('nope')).toBeUndefined();
  });
});

describe('replayAnswer', () => {
  it('scores a fully-correct chain as ok, matching the engine', () => {
    const sc = multiStep();
    const correct = sc.steps.map((st) => st.opts.findIndex((o) => o.ok === true));
    const answer = replayAnswer(sc, correct);
    expect(answer.done).toBe(true);
    expect(answer.ok).toBe(true);
  });

  it('marks a chain with one wrong step as done but not ok', () => {
    const sc = multiStep();
    const picks = sc.steps.map((st, i) =>
      i === 0 ? st.opts.findIndex((o) => o.ok !== true) : st.opts.findIndex((o) => o.ok === true),
    );
    const answer = replayAnswer(sc, picks);
    expect(answer.done).toBe(true);
    expect(answer.ok).toBe(false);
    expect(answer.steps[0]?.ok).toBe(false);
  });

  it('ignores a tampered pick instead of scoring or throwing', () => {
    const sc = multiStep();
    // 3 is a valid digit but out of range for a 2-option step; the engine
    // refuses it, so the chain simply does not advance.
    const answer = replayAnswer(sc, [99]);
    expect(answer.steps).toHaveLength(0);
    expect(answer.done).toBe(false);
  });
});

describe('quizPerms', () => {
  it('is stable for the same participant across presses', () => {
    const sc = multiStep();
    expect(quizPerms(sc, 'user-1')).toEqual(quizPerms(sc, 'user-1'));
  });

  it('differs between participants, so answers cannot be copied', () => {
    // Across the whole content set at least one scenario must order
    // differently for two different users — a shuffle that never varies by
    // user would make one person's screenshot a valid answer key.
    const differs = ALL_SCENARIOS.some(
      (sc) => JSON.stringify(quizPerms(sc, 'user-1')) !== JSON.stringify(quizPerms(sc, 'user-2')),
    );
    expect(differs).toBe(true);
  });

  it('does not leave the correct option first every time', () => {
    // `ok: true` is authored at index 0 in all 367 steps, so identity order
    // would make "A" always correct. This is the reason perms exist at all.
    const firstIsCorrect = ALL_SCENARIOS.flatMap((sc) => {
      const perms = quizPerms(sc, 'user-1');
      return sc.steps.map((st, i) => st.opts[perms[i]?.[0] ?? 0]?.ok === true);
    });
    expect(firstIsCorrect.some((v) => v === false)).toBe(true);
  });
});

describe('buildQuizMessage — the shared, public half', () => {
  it('carries the situation and exactly one button, and no chain content', () => {
    const sc = multiStep();
    const { embeds, components } = buildQuizMessage(sc, locale);
    const rendered = allText(embeds);

    expect(components).toHaveLength(1);
    expect(rendered).toContain(text(sc.situation, locale));

    // The public message is frozen at the equivalent of `qAt`: no step
    // question, no option text, no `why` may appear on it.
    for (const step of sc.steps) {
      expect(rendered).not.toContain(text(step.q, locale));
      for (const opt of step.opts) {
        expect(rendered).not.toContain(text(opt.why, locale));
      }
    }
    expect(rendered).not.toContain(text(sc.explain, locale));
  });
});

describe('buildChainMessage — the spoiler gate', () => {
  it('never leaks a locked step’s key label or question', () => {
    const sc = multiStep();
    const perms = quizPerms(sc, 'user-1');
    const { embeds } = buildChainMessage(sc, replayAnswer(sc, []), perms, locale);
    const rendered = allText(embeds);

    // Step 1 is live; every later step is locked and must be a placeholder.
    for (const step of sc.steps.slice(1)) {
      expect(rendered).not.toContain(text(step.q, locale));
    }
  });

  it('never shows a why for a step that has not been answered', () => {
    const sc = multiStep();
    const perms = quizPerms(sc, 'user-1');
    const { embeds } = buildChainMessage(sc, replayAnswer(sc, []), perms, locale);
    const rendered = allText(embeds);

    for (const step of sc.steps) {
      for (const opt of step.opts) {
        expect(rendered).not.toContain(text(opt.why, locale));
      }
    }
  });

  it('renders the live step’s options as buttons carrying the next pick', () => {
    const sc = multiStep();
    const perms = quizPerms(sc, 'user-1');
    const { components } = buildChainMessage(sc, replayAnswer(sc, []), perms, locale);

    const row = components[0];
    expect(row).toBeDefined();
    const buttons = (row as { components: ReadonlyArray<{ custom_id: string }> }).components;
    expect(buttons).toHaveLength(sc.steps[0]?.opts.length ?? 0);

    // Each button appends its own ORIGINAL option index to the picks so far.
    const encoded = buttons.map((b) => decodeStepId(b.custom_id)?.picks);
    expect(encoded).toEqual(perms[0]?.map((originalIndex) => [originalIndex]));
  });

  it('reveals the explanation and citations only once the chain is done', () => {
    const sc = multiStep();
    const perms = quizPerms(sc, 'user-1');
    const correct = sc.steps.map((st) => st.opts.findIndex((o) => o.ok === true));

    const midway = buildChainMessage(sc, replayAnswer(sc, correct.slice(0, 1)), perms, locale);
    expect(allText(midway.embeds)).not.toContain(text(sc.explain, locale));

    const finished = buildChainMessage(sc, replayAnswer(sc, correct), perms, locale);
    expect(allText(finished.embeds)).toContain(text(sc.explain, locale));
    // A finished chain has no live step, so no option buttons remain.
    expect(finished.components).toHaveLength(0);
  });

  it('shows the correct option alongside a wrong pick, so a miss still teaches', () => {
    const sc = multiStep();
    const perms = quizPerms(sc, 'user-1');
    const step0 = sc.steps[0];
    if (!step0) throw new Error('no first step');
    const wrong = step0.opts.findIndex((o) => o.ok !== true);
    const correctIdx = step0.opts.findIndex((o) => o.ok === true);

    const { embeds } = buildChainMessage(sc, replayAnswer(sc, [wrong]), perms, locale);
    const rendered = allText(embeds);
    expect(rendered).toContain(text(step0.opts[wrong]?.why ?? { en: '', cs: '' }, locale));
    expect(rendered).toContain(text(step0.opts[correctIdx]?.t ?? { en: '', cs: '' }, locale));
  });
});

describe('pickScenario', () => {
  it('restricts to the requested package', () => {
    const sc = pickScenario(3, () => 0);
    expect(sc?.level).toBe(3);
  });

  it('draws from every package when unrestricted', () => {
    expect(pickScenario(undefined, () => 0)).toBeDefined();
  });
});
