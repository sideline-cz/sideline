// Tests for RulesFieldSvg — in particular that `posAt` returning `null` for
// an unknown actor id is handled (never rendered at the field's origin).
import type { Scenario, ScenarioId } from '@sideline/rules';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => key,
}));

const { RulesFieldSvg } = await import('~/components/organisms/RulesFieldSvg.js');

const sid = (s: string): ScenarioId => s as ScenarioId;

const BASE_SCENARIO: Scenario = {
  id: sid('fix1'),
  level: 1,
  topic: { en: 'Topic', cs: 'Topic' },
  title: { en: 'Title', cs: 'Title' },
  roleTeam: 'off',
  role: { en: 'Thrower', cs: 'Thrower' },
  view: [0, 0, 100, 40],
  dur: 10,
  qAt: 4,
  actors: [
    {
      id: 'O1',
      team: 'off',
      label: 'O1',
      you: true,
      kf: [
        [0, 10, 10],
        [10, 30, 30],
      ],
    },
  ],
  disc: {
    kf: [
      [0, 15, 15],
      [10, 35, 35],
    ],
  },
  fx: [],
  situation: { en: 'Situation', cs: 'Situation' },
  question: { en: 'Question?', cs: 'Question?' },
  explain: { en: 'Explain', cs: 'Explain' },
  rules: [],
  steps: [],
};

describe('RulesFieldSvg', () => {
  it('renders the known actor at its interpolated position, with a "you" ring', () => {
    const { container } = render(<RulesFieldSvg scenario={BASE_SCENARIO} t={0} locale='en' />);
    const actorGroup = container.querySelector('g[transform="translate(10 10)"]');
    expect(actorGroup).not.toBeNull();
    expect(actorGroup?.querySelector('circle[stroke="#ffd23f"]')).not.toBeNull();
  });

  it('falls back to the field centre — never [0, 0] — for a bubble fx referencing an unknown actor', () => {
    const scenario: Scenario = {
      ...BASE_SCENARIO,
      fx: [
        {
          type: 'bubble',
          t: 0,
          dur: 100,
          actor: 'does-not-exist',
          text: { en: 'Hey', cs: 'Hey' },
          style: 'call',
        },
      ],
    };

    expect(() => render(<RulesFieldSvg scenario={scenario} t={1} locale='en' />)).not.toThrow();

    const { container } = render(<RulesFieldSvg scenario={scenario} t={1} locale='en' />);
    // fallbackCenter = [vx + vw/2, vy + vh/2] = [50, 20]; the bubble sits
    // above that point (see `BubbleOrFlashFx`), never at the origin.
    const bubbleGroup = Array.from(container.querySelectorAll('g')).find(
      (g) => g.getAttribute('transform') !== null && g.textContent?.includes('Hey'),
    );
    expect(bubbleGroup).not.toBeUndefined();
    expect(bubbleGroup?.getAttribute('transform')).not.toBe('translate(0 0)');
    const match = bubbleGroup?.getAttribute('transform')?.match(/translate\(([-\d.]+) /);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeCloseTo(50, 1);
  });

  it('never renders an actor at the origin when its id does not resolve (defensive: no actors is the null-posAt case)', () => {
    const scenario: Scenario = { ...BASE_SCENARIO, actors: [] };
    const { container } = render(<RulesFieldSvg scenario={scenario} t={5} locale='en' />);
    // No actor groups at all — `posAt` returning null for every id must
    // never fall through to rendering a group at the origin.
    expect(container.querySelector('g[transform="translate(0 0)"]')).toBeNull();
  });
});
