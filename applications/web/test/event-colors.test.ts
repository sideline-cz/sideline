// TDD mode — written BEFORE `lib/event-colors.ts` is rewritten (plan §4/§7 F).
//
// New contract (plan §4):
//   export const EVENT_COLOR_SETS: Record<EventTypeColor, EventColorSet>
//   export function getEventColor(color: Option<EventTypeColor>, kind: Event.EventType): EventColorSet
//
// `color` is the resolved `EventTypeInfo.color` (or `EventInfo.eventTypeColor`) for the
// event's type, `Option.none()` only during a rolling deploy against an old server or for an
// event whose type was deleted before this feature existed. In that case the caller falls back
// to `defaultColorForKind[kind]` — "today's colour" for each kind, unchanged behaviour.
//
// This file WILL FAIL to import until the developer rewrites `event-colors.ts` — expected in
// TDD, not a bug to fix here.

import { EventType } from '@sideline/domain';
import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { EVENT_COLOR_SETS, getEventColor } from '~/lib/event-colors.js';

describe('getEventColor', () => {
  it('returns the cyan set for an explicit colour, regardless of kind', () => {
    const result = getEventColor(Option.some('cyan'), 'other');
    expect(result).toBe(EVENT_COLOR_SETS.cyan);
    expect(result.dot).toContain('cyan');
  });

  it('falls back to the kind default (blue for training) when colour is Option.none()', () => {
    // defaultColorForKind.training === 'blue' — "today's colour" for a training event.
    const result = getEventColor(Option.none(), 'training');
    expect(result).toBe(EVENT_COLOR_SETS[EventType.defaultColorForKind.training]);
    expect(result).toBe(EVENT_COLOR_SETS.blue);
  });

  it('falls back to the kind default for every other kind too', () => {
    for (const kind of EventType.EventTypeKind.literals) {
      const result = getEventColor(Option.none(), kind);
      expect(result).toBe(EVENT_COLOR_SETS[EventType.defaultColorForKind[kind]]);
    }
  });
});

describe('EVENT_COLOR_SETS — totality', () => {
  it('has exactly one entry per EventTypeColor literal', () => {
    const literals = new Set<string>(EventType.EventTypeColor.literals);
    const keys = new Set(Object.keys(EVENT_COLOR_SETS));

    for (const literal of literals) {
      expect(keys.has(literal)).toBe(true);
    }
    for (const key of keys) {
      expect(literals.has(key)).toBe(true);
    }
    expect(keys.size).toBe(literals.size);
  });

  // The tripwire for a hand-written palette entry that silently breaks dark mode: Tailwind
  // cannot see an interpolated class (`bg-${color}-100`), so every set is written out literally
  // — which means it's also trivially easy to copy-paste one entry and forget the `dark:` half.
  it('every entry carries a dark: variant in all four class strings', () => {
    for (const [color, set] of Object.entries(EVENT_COLOR_SETS)) {
      for (const key of ['bg', 'text', 'dot', 'border'] as const) {
        expect(set[key], `${color}.${key}`).toMatch(/dark:/);
      }
    }
  });
});
