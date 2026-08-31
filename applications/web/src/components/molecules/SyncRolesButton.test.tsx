// PR-9 test list items 20-21.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { Option } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

const { SyncRolesButton } = await import('./SyncRolesButton.js');

const okResult = (overrides: Partial<Record<string, unknown>> = {}) => ({
  addedCount: 2,
  removedCount: 1,
  roleSyncState: 'ok' as const,
  lastRoleSyncAt: Option.none(),
  lastRoleSyncError: Option.none(),
  ...overrides,
});

describe('SyncRolesButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('test 20 — disables for 60s after a completed run', async () => {
    const onSync = vi.fn().mockResolvedValue(okResult());
    render(<SyncRolesButton onSync={onSync} />);

    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });

    expect(button.disabled).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(59_000);
    });
    expect(button.disabled).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(button.disabled).toBe(false);
  });

  it('test 21 — renders discord_syncError_retryable for the retryable bucket', async () => {
    const onSync = vi
      .fn()
      .mockResolvedValue(okResult({ lastRoleSyncError: Option.some('retryable') }));
    render(<SyncRolesButton onSync={onSync} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
      await Promise.resolve();
    });
    expect(screen.getByText('discord_syncError_retryable')).not.toBeNull();
  });

  it('test 21 — renders discord_syncError_captainAction for the captain_action bucket', async () => {
    const onSync = vi
      .fn()
      .mockResolvedValue(okResult({ lastRoleSyncError: Option.some('captain_action') }));
    render(<SyncRolesButton onSync={onSync} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
      await Promise.resolve();
    });
    expect(screen.getByText('discord_syncError_captainAction')).not.toBeNull();
  });

  it('test 21 — renders discord_syncError_userAction for the user_action bucket', async () => {
    const onSync = vi
      .fn()
      .mockResolvedValue(okResult({ lastRoleSyncError: Option.some('user_action') }));
    render(<SyncRolesButton onSync={onSync} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
      await Promise.resolve();
    });
    expect(screen.getByText('discord_syncError_userAction')).not.toBeNull();
  });

  it('test 21 — renders discord_syncError_unknown for the unknown bucket', async () => {
    const onSync = vi
      .fn()
      .mockResolvedValue(okResult({ lastRoleSyncError: Option.some('unknown') }));
    render(<SyncRolesButton onSync={onSync} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
      await Promise.resolve();
    });
    expect(screen.getByText('discord_syncError_unknown')).not.toBeNull();
  });

  it('renders the queued-result copy on success, not the error copy', async () => {
    const onSync = vi.fn().mockResolvedValue(okResult());
    render(<SyncRolesButton onSync={onSync} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
      await Promise.resolve();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Blocker 2 (whole-series review, fix/discord-onboarding-webapp): `onSync` rejecting (e.g. the
  // server 403ing a member who can't sync, or any other request failure) used to propagate as an
  // unhandled promise rejection out of `handleClick` — the `try/finally` had no `catch` — while
  // the button still flipped to the ✓ cooldown state, showing success for a sync that never
  // happened. `handleClick` must catch the rejection, surface a failure state, and still apply
  // the cooldown (a rejected call still counts as a completed run for rate-limit purposes).
  it('catches a rejected onSync, shows a failure notice instead of the checkmark, and still enters cooldown', async () => {
    const onSync = vi.fn().mockRejectedValue(new Error('sync failed'));
    render(<SyncRolesButton onSync={onSync} />);

    const button = screen.getByRole('button') as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Cooldown still applies — a failed attempt must not be immediately retryable.
    expect(button.disabled).toBe(true);
    // The ✓ (success) icon must never be shown for a call that rejected.
    expect(button.querySelector('svg.lucide-check')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('discord_syncFailed');
  });
});
