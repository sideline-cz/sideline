// SeasonPicker maps the URL `season` param to a Radix value and back. The rules that matter:
// the current option sends `undefined` (no param), a bookmarked current-season id still lands
// on the current option, and Earlier is always last.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => key,
}));

// jsdom has no scrollIntoView; Radix Select calls it when the list opens.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const { SeasonPicker } = await import('./SeasonPicker.js');

const seasons = [
  { id: 's2', startsAt: '2026-09-01T00:00:00Z', endsAt: Option.none(), isCurrent: true },
  {
    id: 's1',
    startsAt: '2026-03-01T00:00:00Z',
    endsAt: Option.some('2026-09-01T00:00:00Z'),
    isCurrent: false,
  },
] as any;

const combo = () => screen.getByRole('combobox', { name: 'activitySeason_pickerLabel' });

describe('SeasonPicker', () => {
  it('shows the current option for a bookmarked current-season id, with Earlier last', () => {
    render(<SeasonPicker seasons={seasons} value='s2' onChange={vi.fn()} />);

    expect(combo().textContent).toContain('activitySeason_optionCurrent');

    fireEvent.click(combo());
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[2]?.textContent).toBe('activitySeason_optionEarlier');
  });

  it('sends undefined for the current option and the id for a past season', () => {
    const onChange = vi.fn();
    const { unmount } = render(<SeasonPicker seasons={seasons} value='s1' onChange={onChange} />);

    fireEvent.click(combo());
    fireEvent.click(
      within(screen.getByRole('listbox')).getByRole('option', {
        name: 'activitySeason_optionCurrent',
      }),
    );
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    unmount();

    render(<SeasonPicker seasons={seasons} value={undefined} onChange={onChange} />);
    fireEvent.click(combo());
    fireEvent.click(within(screen.getByRole('listbox')).getAllByRole('option')[1] as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith('s1');
  });
});
