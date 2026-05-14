import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      searchable_select_search: 'Search...',
      searchable_select_noResults: 'No results found.',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

const { SearchableSelect } = await import('~/components/atoms/SearchableSelect.js');

const baseOptions = [
  { value: 'alpha-value', label: 'Alpha' },
  { value: 'bravo-value', label: 'Bravo' },
];

function renderSelect(props: Partial<React.ComponentProps<typeof SearchableSelect>> = {}) {
  const onValueChange = vi.fn();
  render(
    <SearchableSelect
      options={baseOptions}
      value=''
      onValueChange={onValueChange}
      placeholder='Select an option'
      {...props}
    />,
  );
  return { onValueChange };
}

function getTrigger() {
  return screen.getByRole('combobox');
}

function openPopover() {
  fireEvent.click(getTrigger());
}

describe('SearchableSelect', () => {
  it('renders trigger with placeholder when no value', () => {
    renderSelect({ value: '', placeholder: 'Pick one' });
    expect(getTrigger().textContent).toContain('Pick one');
  });

  it('renders trigger with selected option label', () => {
    renderSelect({
      options: [{ value: 'opt1', label: 'Option 1' }, ...baseOptions],
      value: 'opt1',
    });
    expect(getTrigger().textContent).toContain('Option 1');
  });

  it('opens popover on trigger click', () => {
    renderSelect();
    openPopover();
    expect(screen.getByPlaceholderText('Search...')).not.toBeNull();
  });

  it('filters options by search query', () => {
    renderSelect();
    openPopover();
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'Alp' } });
    expect(screen.getByText('Alpha')).not.toBeNull();
    expect(screen.queryByText('Bravo')).toBeNull();
  });

  it('filters case-insensitively', () => {
    renderSelect();
    openPopover();
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'ALPHA' } });
    expect(screen.getByText('Alpha')).not.toBeNull();
  });

  it('calls onValueChange on option click', () => {
    const { onValueChange } = renderSelect();
    openPopover();
    fireEvent.click(screen.getByRole('option', { name: 'Alpha' }));
    expect(onValueChange).toHaveBeenCalledWith('alpha-value');
  });

  it('closes popover after selection', () => {
    renderSelect();
    openPopover();
    fireEvent.click(screen.getByRole('option', { name: 'Alpha' }));
    expect(screen.queryByPlaceholderText('Search...')).toBeNull();
  });

  it('sorts options alphabetically', () => {
    renderSelect({
      options: [
        { value: 'z', label: 'Zebra' },
        { value: 'a', label: 'Alpha' },
        { value: 'm', label: 'Middle' },
      ],
    });
    openPopover();
    const options = screen.getAllByRole('option');
    expect(options[0].textContent).toContain('Alpha');
    expect(options[1].textContent).toContain('Middle');
    expect(options[2].textContent).toContain('Zebra');
  });

  it('pins values at top before sorted options', () => {
    renderSelect({
      options: [
        { value: 'z', label: 'Zebra' },
        { value: 'none', label: 'None' },
        { value: 'a', label: 'Alpha' },
      ],
      pinnedValues: ['none'],
    });
    openPopover();
    const options = screen.getAllByRole('option');
    expect(options[0].textContent).toContain('None');
    expect(options[1].textContent).toContain('Alpha');
    expect(options[2].textContent).toContain('Zebra');
  });

  it('shows no-results message when search matches nothing', () => {
    renderSelect();
    openPopover();
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'xyz123' } });
    expect(screen.getByText('No results found.')).not.toBeNull();
  });

  it('clears search on popover reopen', () => {
    renderSelect();
    openPopover();
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'test' } });
    // Close with Escape
    fireEvent.keyDown(screen.getByPlaceholderText('Search...'), { key: 'Escape' });
    // Reopen
    openPopover();
    expect((screen.getByPlaceholderText('Search...') as HTMLInputElement).value).toBe('');
  });

  it('disabled prevents opening', () => {
    renderSelect({ disabled: true });
    openPopover();
    expect(screen.queryByPlaceholderText('Search...')).toBeNull();
  });

  it('passes id and aria-invalid to trigger', () => {
    renderSelect({ id: 'my-id', 'aria-invalid': 'true' });
    const trigger = getTrigger();
    expect(trigger.getAttribute('id')).toBe('my-id');
    expect(trigger.getAttribute('aria-invalid')).toBe('true');
  });

  it('handles empty options', () => {
    renderSelect({ options: [] });
    openPopover();
    expect(screen.getByText('No results found.')).not.toBeNull();
  });
});
