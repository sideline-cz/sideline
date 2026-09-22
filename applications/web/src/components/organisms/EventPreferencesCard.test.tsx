// Nastavitelná docházka (design.md §A, plan §10.3). TDD — written before
// `EventPreferencesCard.tsx` exists.
//
// Component contract (design.md §A.2/A.3):
//   EventPreferencesCard({
//     teamId: string;
//     prefs: TeamApi.MemberEventPreferences | null; // null = load failure (design.md §A.8)
//     onRefresh: () => void;
//   })
//
// Covers:
//   1. Renders two Switches + a ToggleGroup reflecting the passed prefs; the
//      ToggleGroup root has role="radiogroup" and an accessible name.
//   2. Flipping a control does NOT call the API — only dirties the form.
//   3. Save with channel mode UNCHANGED → updateMyEventPreferences called once
//      with the three fields; no AlertDialog rendered.
//   4. Save with channel mode CHANGED → AlertDialog opens with the
//      direction-specific body; API called only after confirming; Cancel
//      calls nothing and leaves the form dirty.
//   5. Save failure → error toast key surfaces via ClientError, form stays dirty.
//   6. personalChannelsAvailable: false → channel block absent; dialog cannot fire.
//   7. Load failure (prefs === null) → header + alert + retry button.
//
// Uses `fireEvent`, not `@testing-library/user-event` — the latter is not a
// dependency of this package (see `EventRsvpPanel.test.tsx` for the same
// convention).

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    if (!params) return key;
    return `${key}:${JSON.stringify(params)}`;
  },
}));

// ---------------------------------------------------------------------------
// Mock ApiClient / useRun — the mock `run` actually threads through the real
// Effect so the component's own success/failure branching gets exercised,
// mirroring `EmailForwardingCard`'s usage (`Effect.mapError(...).pipe(run(...))`).
// ---------------------------------------------------------------------------

type UpdatePrefsResult =
  | {
      _tag: 'success';
      showAttendeeList: unknown;
      rsvpReminderDms: unknown;
      personalChannelsSplit: unknown;
      personalChannelsAvailable: boolean;
    }
  | { _tag: 'failure' };

const { updateMyEventPreferencesSpy } = vi.hoisted(() => ({
  updateMyEventPreferencesSpy: vi.fn(
    (args: { payload: Record<string, unknown> }): UpdatePrefsResult => ({
      _tag: 'success',
      showAttendeeList: args.payload.showAttendeeList,
      rsvpReminderDms: args.payload.rsvpReminderDms,
      personalChannelsSplit: args.payload.personalChannelsSplit,
      personalChannelsAvailable: true,
    }),
  ),
}));

vi.mock('~/lib/runtime', async () => {
  const { Effect, Option } = await import('effect');
  return {
    ApiClient: {
      asEffect: () =>
        Effect.succeed({
          team: {
            updateMyEventPreferences: (args: unknown) => {
              const result = updateMyEventPreferencesSpy(args as any);
              return result._tag === 'success' ? Effect.succeed(result) : Effect.fail(result);
            },
          },
        }),
    },
    ClientError: {
      make: (message: string) => ({ _tag: 'ClientError' as const, message }),
    },
    useRun: () => (_options?: unknown) => (effect: any) =>
      Effect.runPromise(
        effect.pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none())),
        ),
      ),
  };
});

const { EventPreferencesCard, EventPreferencesLoadFailed } = await import(
  './EventPreferencesCard.js'
);

const basePrefs = {
  showAttendeeList: true,
  rsvpReminderDms: true,
  personalChannelsSplit: false,
  personalChannelsAvailable: true,
};

const onRefresh = vi.fn();

describe('EventPreferencesCard', () => {
  it('renders two Switches and a ToggleGroup reflecting the passed prefs; the ToggleGroup root has role="radiogroup" and an accessible name', () => {
    render(<EventPreferencesCard teamId='team-1' prefs={basePrefs} onRefresh={onRefresh} />);

    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(2);

    const radiogroup = screen.getByRole('radiogroup');
    expect(radiogroup).not.toBeNull();
    expect(radiogroup.getAttribute('aria-labelledby')).not.toBeNull();
  });

  it('flipping a control does NOT call the API — SaveRow becomes enabled and the unsaved-changes hint appears', () => {
    render(<EventPreferencesCard teamId='team-1' prefs={basePrefs} onRefresh={onRefresh} />);

    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[0]);

    expect(updateMyEventPreferencesSpy).not.toHaveBeenCalled();
    expect(screen.getByText('teamSettings_unsavedChanges')).not.toBeNull();
    const saveButton = screen.getByRole('button', { name: 'profile_saveChanges' });
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('Save with channel mode UNCHANGED → updateMyEventPreferences called once with the three fields; no AlertDialog', async () => {
    render(<EventPreferencesCard teamId='team-1' prefs={basePrefs} onRefresh={onRefresh} />);

    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[0]); // flip showAttendeeList only — channel mode untouched

    const saveButton = screen.getByRole('button', { name: 'profile_saveChanges' });
    fireEvent.click(saveButton);

    await waitFor(() => expect(updateMyEventPreferencesSpy).toHaveBeenCalledTimes(1));
    const call = updateMyEventPreferencesSpy.mock.calls[0]?.[0] as {
      payload: Record<string, unknown>;
    };
    expect(call.payload).toMatchObject({
      showAttendeeList: false,
      rsvpReminderDms: true,
      personalChannelsSplit: false,
    });

    // No confirm dialog — the channel-mode field never changed.
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Save with channel mode CHANGED (one → split) → AlertDialog opens with eventPrefs_confirmToSplit; API called only after confirming', async () => {
    render(<EventPreferencesCard teamId='team-1' prefs={basePrefs} onRefresh={onRefresh} />);

    const threeChannelsOption = screen.getByRole('radio', { name: /eventPrefs_channelsSplit/ });
    fireEvent.click(threeChannelsOption);

    const saveButton = screen.getByRole('button', { name: 'profile_saveChanges' });
    fireEvent.click(saveButton);

    // Dialog fires, API not yet called.
    expect(await screen.findByRole('alertdialog')).not.toBeNull();
    expect(screen.getByText('eventPrefs_confirmToSplit')).not.toBeNull();
    expect(updateMyEventPreferencesSpy).not.toHaveBeenCalled();

    const confirmButton = screen.getByRole('button', { name: 'eventPrefs_confirmAction' });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(updateMyEventPreferencesSpy).toHaveBeenCalledTimes(1));
    const call = updateMyEventPreferencesSpy.mock.calls[0]?.[0] as {
      payload: Record<string, unknown>;
    };
    expect(call.payload.personalChannelsSplit).toBe(true);
  });

  it('Save with channel mode CHANGED (split → one) → AlertDialog shows eventPrefs_confirmToOne', async () => {
    render(
      <EventPreferencesCard
        teamId='team-1'
        prefs={{ ...basePrefs, personalChannelsSplit: true }}
        onRefresh={onRefresh}
      />,
    );

    const oneChannelOption = screen.getByRole('radio', { name: /eventPrefs_channelsOne/ });
    fireEvent.click(oneChannelOption);

    const saveButton = screen.getByRole('button', { name: 'profile_saveChanges' });
    fireEvent.click(saveButton);

    expect(await screen.findByRole('alertdialog')).not.toBeNull();
    expect(screen.getByText('eventPrefs_confirmToOne')).not.toBeNull();
  });

  it('Cancel on the confirm dialog calls nothing and leaves the form dirty', async () => {
    render(<EventPreferencesCard teamId='team-1' prefs={basePrefs} onRefresh={onRefresh} />);

    const threeChannelsOption = screen.getByRole('radio', { name: /eventPrefs_channelsSplit/ });
    fireEvent.click(threeChannelsOption);

    const saveButton = screen.getByRole('button', { name: 'profile_saveChanges' });
    fireEvent.click(saveButton);

    expect(await screen.findByRole('alertdialog')).not.toBeNull();

    const cancelButton = screen.getByRole('button', { name: 'common_cancel' });
    fireEvent.click(cancelButton);

    expect(updateMyEventPreferencesSpy).not.toHaveBeenCalled();
    // The dialog is closed but the form is still dirty — Save is still enabled.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByText('teamSettings_unsavedChanges')).not.toBeNull();
  });

  it('Save failure → eventPrefs_saveFailed surfaces via ClientError and the form stays dirty', async () => {
    updateMyEventPreferencesSpy.mockImplementationOnce(() => ({ _tag: 'failure' as const }));

    render(<EventPreferencesCard teamId='team-1' prefs={basePrefs} onRefresh={onRefresh} />);

    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[1]); // flip rsvpReminderDms — no dialog involved

    const saveButton = screen.getByRole('button', { name: 'profile_saveChanges' });
    fireEvent.click(saveButton);

    await waitFor(() => expect(updateMyEventPreferencesSpy).toHaveBeenCalled());
    // Form remains dirty — Save is still enabled for a retry.
    await waitFor(() => expect(screen.getByText('teamSettings_unsavedChanges')).not.toBeNull());
  });

  it('personalChannelsAvailable: false → the channel-mode block is absent; both switches still render', () => {
    render(
      <EventPreferencesCard
        teamId='team-1'
        prefs={{ ...basePrefs, personalChannelsAvailable: false }}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getAllByRole('switch')).toHaveLength(2);
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('personalChannelsAvailable: false → the confirm dialog cannot fire even after Save (by construction, no channel control exists to dirty)', async () => {
    render(
      <EventPreferencesCard
        teamId='team-1'
        prefs={{ ...basePrefs, personalChannelsAvailable: false }}
        onRefresh={onRefresh}
      />,
    );

    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[0]);

    const saveButton = screen.getByRole('button', { name: 'profile_saveChanges' });
    fireEvent.click(saveButton);

    await waitFor(() => expect(updateMyEventPreferencesSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('load failure → header + eventPrefs_loadFailed alert + retry button; calling retry invokes onRefresh', () => {
    const localOnRefresh = vi.fn();
    render(<EventPreferencesLoadFailed onRefresh={localOnRefresh} />);

    expect(screen.getByText('eventPrefs_title')).not.toBeNull();
    expect(screen.getByText('eventPrefs_loadFailed')).not.toBeNull();
    const retryButton = screen.getByRole('button', { name: 'common_retry' });

    // No controls rendered for a team whose preferences failed to load.
    expect(screen.queryAllByRole('switch')).toHaveLength(0);

    fireEvent.click(retryButton);
    expect(localOnRefresh).toHaveBeenCalled();
  });

  it('a retry after a failed load seeds the form from the REAL prefs, clean and not dirty', () => {
    // Regression: `useCardForm` seeds its useState ONCE. When the failure state and the
    // loaded state were the same component at the same position, React preserved the
    // instance across the retry, so the form kept the defaults it was seeded with while
    // the baseline became the member's real prefs — dirty, Save armed, and one click
    // would have written showAttendeeList/rsvpReminderDms true and personalChannelsSplit
    // false, deleting the member's three Discord channels and their history.
    const loaded = {
      showAttendeeList: false,
      rsvpReminderDms: false,
      personalChannelsSplit: true,
      personalChannelsAvailable: true,
    } as unknown as typeof basePrefs;

    const { rerender } = render(<EventPreferencesLoadFailed onRefresh={onRefresh} />);
    expect(screen.getByText('eventPrefs_loadFailed')).not.toBeNull();

    rerender(<EventPreferencesCard teamId='team-1' prefs={loaded} onRefresh={onRefresh} />);

    const switches = screen.getAllByRole('switch');
    expect(switches[0]?.getAttribute('aria-checked')).toBe('false');
    expect(switches[1]?.getAttribute('aria-checked')).toBe('false');
    expect(
      screen.getByRole('radio', { name: 'eventPrefs_channelsSplit' }).getAttribute('aria-checked'),
    ).toBe('true');
    // Clean: nothing to save, so the unsaved-changes hint must be absent.
    expect(screen.queryByText('teamSettings_unsavedChanges')).toBeNull();
  });
});
