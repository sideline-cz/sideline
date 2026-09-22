// `SaveBar` / `useSaveBarEntry` registry mechanics, in isolation via throwaway probe
// components — no real card needed. See `applications/web/AGENTS.md`'s "SaveBar /
// useSaveBarEntry" section for the invariants this pins.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

const { SaveBar, SaveBarProvider, useSaveBarEntries, useSaveBarEntry } = await import(
  './SaveBar.js'
);

interface ProbeProps {
  id: string;
  label: string;
  tab: string;
  dirty: boolean;
  saving?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSave: () => Promise<boolean>;
  onDiscard: () => void;
}

function Probe({
  id,
  label,
  tab,
  dirty,
  saving = false,
  disabled,
  disabledReason,
  onSave,
  onDiscard,
}: ProbeProps) {
  useSaveBarEntry({ id, label, tab, dirty, saving, disabled, disabledReason, onSave, onDiscard });
  return null;
}

const rowText = (form: string) => `teamSettings_saveBar_dirtyIn:${JSON.stringify({ form })}`;
const saveAria = (form: string) => `teamSettings_saveBar_saveAria:${JSON.stringify({ form })}`;
const discardAria = (form: string) =>
  `teamSettings_saveBar_discardAria:${JSON.stringify({ form })}`;

describe('SaveBar / useSaveBarEntry registry', () => {
  it('registers nothing while clean', () => {
    render(
      <SaveBarProvider>
        <Probe
          id='a'
          label='A'
          tab='general'
          dirty={false}
          onSave={() => Promise.resolve(true)}
          onDiscard={() => {}}
        />
        <SaveBar onInvalid={() => {}} />
      </SaveBarProvider>,
    );
    expect(screen.queryByText(rowText('A'))).toBeNull();
  });

  it('renders one row per dirty entry, in ENTRY_ORDER — not registration order', () => {
    // 'profile' is declared (and so mounts/registers) BEFORE 'settings' here, while
    // ENTRY_ORDER puts 'settings' first — insertion order and ENTRY_ORDER disagree on
    // purpose, so this only passes if the bar actually sorts by ENTRY_ORDER.
    render(
      <SaveBarProvider>
        <Probe
          id='profile'
          label='Profile'
          tab='general'
          dirty
          onSave={() => Promise.resolve(true)}
          onDiscard={() => {}}
        />
        <Probe
          id='settings'
          label='Settings'
          tab='general'
          dirty
          onSave={() => Promise.resolve(true)}
          onDiscard={() => {}}
        />
        <SaveBar onInvalid={() => {}} />
      </SaveBarProvider>,
    );

    const rows = screen.getAllByText(/^teamSettings_saveBar_dirtyIn:/);
    expect(rows.map((r) => r.textContent)).toEqual([rowText('Settings'), rowText('Profile')]);
  });

  it('unregisters when an entry goes clean, and re-registers when it goes dirty again', () => {
    const { rerender } = render(
      <SaveBarProvider>
        <Probe
          id='a'
          label='A'
          tab='general'
          dirty
          onSave={() => Promise.resolve(true)}
          onDiscard={() => {}}
        />
        <SaveBar onInvalid={() => {}} />
      </SaveBarProvider>,
    );
    expect(screen.queryByText(rowText('A'))).not.toBeNull();

    rerender(
      <SaveBarProvider>
        <Probe
          id='a'
          label='A'
          tab='general'
          dirty={false}
          onSave={() => Promise.resolve(true)}
          onDiscard={() => {}}
        />
        <SaveBar onInvalid={() => {}} />
      </SaveBarProvider>,
    );
    expect(screen.queryByText(rowText('A'))).toBeNull();

    rerender(
      <SaveBarProvider>
        <Probe
          id='a'
          label='A'
          tab='general'
          dirty
          onSave={() => Promise.resolve(true)}
          onDiscard={() => {}}
        />
        <SaveBar onInvalid={() => {}} />
      </SaveBarProvider>,
    );
    expect(screen.queryByText(rowText('A'))).not.toBeNull();
  });

  it('unregisters on unmount — a dirty probe that unmounts leaves no stale row', () => {
    const { rerender } = render(
      <SaveBarProvider>
        <Probe
          id='a'
          label='A'
          tab='general'
          dirty
          onSave={() => Promise.resolve(true)}
          onDiscard={() => {}}
        />
        <SaveBar onInvalid={() => {}} />
      </SaveBarProvider>,
    );
    expect(screen.queryByText(rowText('A'))).not.toBeNull();

    rerender(
      <SaveBarProvider>
        <SaveBar onInvalid={() => {}} />
      </SaveBarProvider>,
    );
    expect(screen.queryByText(rowText('A'))).toBeNull();
  });

  it('Save invokes the latest onSave closure', () => {
    // Re-render with a DIFFERENT onSave identity while every primitive prop stays the same —
    // the ref-vs-deps trap. A stale closure would still call the FIRST onSave.
    const firstOnSave = vi.fn(() => Promise.resolve(true));
    const secondOnSave = vi.fn(() => Promise.resolve(true));

    const { rerender } = render(
      <SaveBarProvider>
        <Probe id='a' label='A' tab='general' dirty onSave={firstOnSave} onDiscard={() => {}} />
        <SaveBar onInvalid={() => {}} />
      </SaveBarProvider>,
    );

    rerender(
      <SaveBarProvider>
        <Probe id='a' label='A' tab='general' dirty onSave={secondOnSave} onDiscard={() => {}} />
        <SaveBar onInvalid={() => {}} />
      </SaveBarProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: saveAria('A') }));

    expect(secondOnSave).toHaveBeenCalledTimes(1);
    expect(firstOnSave).not.toHaveBeenCalled();
  });

  it('does not re-render infinitely with inline onSave/onDiscard identities', () => {
    // Mirrors the real page shape: `TeamSettingsPageBody` calls `useSaveBarEntries()` and is
    // an ancestor of every card, so a registry update re-renders it and its whole subtree —
    // including any card whose `onSave`/`onDiscard` are inline arrows (a fresh identity every
    // render). `EntriesConsumer` stands in for that ancestor.
    const renderCount = { current: 0 };

    function EntriesConsumer({ children }: { children: React.ReactNode }) {
      useSaveBarEntries();
      return <>{children}</>;
    }

    function LoopProbe() {
      renderCount.current += 1;
      useSaveBarEntry({
        id: 'loop',
        label: 'Loop',
        tab: 'general',
        dirty: true,
        saving: false,
        onSave: () => Promise.resolve(true),
        onDiscard: () => {},
      });
      return null;
    }

    render(
      <SaveBarProvider>
        <EntriesConsumer>
          <LoopProbe />
        </EntriesConsumer>
        <SaveBar onInvalid={() => {}} />
      </SaveBarProvider>,
    );

    // One render from the initial mount, one more once the registration's state update
    // propagates back down through `EntriesConsumer`. A regression that puts the raw
    // `onSave`/`onDiscard` props in the effect's deps re-registers on every one of those
    // renders, which keeps the count climbing (or trips React's own update-depth guard).
    expect(renderCount.current).toBeLessThan(5);
  });

  it('Save is disabled while saving', () => {
    render(
      <SaveBarProvider>
        <Probe
          id='a'
          label='A'
          tab='general'
          dirty
          saving
          onSave={() => Promise.resolve(true)}
          onDiscard={() => {}}
        />
        <SaveBar onInvalid={() => {}} />
      </SaveBarProvider>,
    );
    const button = screen.getByRole('button', { name: saveAria('A') }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('profile_saving');
  });

  it('Save is disabled while disabled is true', () => {
    render(
      <SaveBarProvider>
        <Probe
          id='a'
          label='A'
          tab='general'
          dirty
          disabled
          disabledReason='nope'
          onSave={() => Promise.resolve(true)}
          onDiscard={() => {}}
        />
        <SaveBar onInvalid={() => {}} />
      </SaveBarProvider>,
    );
    const button = screen.getByRole('button', { name: saveAria('A') }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText('nope')).not.toBeNull();
  });

  it('Discard invokes onDiscard', () => {
    const onDiscard = vi.fn();
    render(
      <SaveBarProvider>
        <Probe
          id='a'
          label='A'
          tab='general'
          dirty
          onSave={() => Promise.resolve(true)}
          onDiscard={onDiscard}
        />
        <SaveBar onInvalid={() => {}} />
      </SaveBarProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: discardAria('A') }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("an onSave resolving false calls onInvalid with the entry's tab", async () => {
    const onInvalid = vi.fn();
    render(
      <SaveBarProvider>
        <Probe
          id='a'
          label='A'
          tab='email'
          dirty
          onSave={() => Promise.resolve(false)}
          onDiscard={() => {}}
        />
        <SaveBar onInvalid={onInvalid} />
      </SaveBarProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: saveAria('A') }));
    await waitFor(() => expect(onInvalid).toHaveBeenCalledWith('email'));
  });
});
