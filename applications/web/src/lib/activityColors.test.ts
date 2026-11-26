import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { activityTypeColors } from '~/lib/activityColors.js';

describe('activityTypeColors', () => {
  it('derives by position and lets a stored pick win without shifting the others', () => {
    const colors = activityTypeColors([
      { name: 'Gym' },
      { name: 'Running', color: Option.some('fuchsia') },
      { name: 'Yoga', color: Option.none() },
    ]);
    expect(colors.get('Gym')).toBe('bg-emerald-500');
    expect(colors.get('Running')).toBe('bg-fuchsia-500');
    expect(colors.get('Yoga')).toBe('bg-amber-500');
  });
});
