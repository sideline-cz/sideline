// Slice 3a — the attendance confirm section. `entries[].present` arrives pre-ticked from the
// server (the stored value once confirmed, a live RSVP pre-tick otherwise); this component only
// renders it and lets a captain toggle before sending a FULL REPLACE of the confirmed set.
//
// Covers:
//   1. one checkbox per entry, ticked iff `present`.
//   2. unticking one member and confirming PUTs the FULL list — everyone else unchanged.
//   3. `confirmedAt` Some → the confirmed line renders and the button says "Update".
//   4. a PUT failure preserves the toggled checkbox state (no silent reset) — the "error toast"
//      itself is `runtime.ts`'s own responsibility (see `runtime.test.ts`), not re-tested here.
//   5. empty `entries` → the empty state renders, no crash.

import type { EventRsvp } from '@sideline/domain';
import { TeamMember } from '@sideline/domain';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Effect as EffectType, Option as OptionType } from 'effect';
import { DateTime, Effect, Option, Schema } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      eventAttendance_section: 'Attendance',
      eventAttendance_description: 'Mark who actually showed up.',
      eventAttendance_confirm: 'Confirm attendance',
      eventAttendance_update: 'Update attendance',
      eventAttendance_saving: 'Saving…',
      eventAttendance_confirmedAt: 'Confirmed {date} {time}',
      eventAttendance_empty: 'No members to confirm attendance for.',
      eventAttendance_saved: 'Attendance confirmed.',
      eventAttendance_saveFailed: 'Failed to save attendance. Please try again.',
      eventAttendance_notConfirmable: 'Attendance can no longer be confirmed for this event.',
      rsvp_yes: 'Yes',
      rsvp_no: 'No',
      rsvp_maybe: 'Not sure',
      rsvp_comingLater: 'Coming later',
    };
    const template = map[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
  },
  setTranslationOverrides: vi.fn(),
}));

const { confirmSpy } = vi.hoisted(() => ({ confirmSpy: vi.fn() }));

// The mock `run` really executes the piped Effect (mirroring `runtime.ts`'s own shape minus the
// toast side effect), so `Effect.catchTag`/`Effect.mapError` in the component run for real
// instead of being bypassed by a pass-through stub.
vi.mock('~/lib/runtime', async () => {
  const { Effect: RealEffect, Option: RealOption } = await import('effect');
  return {
    ApiClient: {
      asEffect: () =>
        RealEffect.succeed({
          eventAttendance: {
            confirmEventAttendance: (args: unknown) => confirmSpy(args),
          },
        }),
    },
    ClientError: { make: (message: string) => ({ _tag: 'ClientError' as const, message }) },
    useRun:
      () =>
      () =>
      (effect: EffectType.Effect<unknown, unknown>): Promise<OptionType.Option<unknown>> =>
        RealEffect.runPromise(
          effect.pipe(
            RealEffect.map(RealOption.some),
            RealEffect.catch(() => RealEffect.succeed(RealOption.none())),
          ),
        ),
  };
});

// ---------------------------------------------------------------------------
// Dynamic import (after mocks)
// ---------------------------------------------------------------------------

const { EventAttendanceConfirmSection } = await import('./EventAttendanceConfirmSection.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type EntryOverrides = {
  teamMemberId: string;
  displayName: string;
  rsvpResponse: Option.Option<EventRsvp.RsvpResponse>;
  present: boolean;
};

type EntryView = {
  teamMemberId: TeamMember.TeamMemberId;
  displayName: string;
  rsvpResponse: Option.Option<EventRsvp.RsvpResponse>;
  present: boolean;
};

function makeEntry(overrides: Partial<EntryOverrides> = {}): EntryView {
  const merged: EntryOverrides = {
    teamMemberId: 'member-1',
    displayName: 'Alice',
    // No RSVP hint by default — keeps each row's accessible label exactly the display name so
    // `getByLabelText('Bob')` resolves unambiguously in the tests below.
    rsvpResponse: Option.none(),
    present: true,
    ...overrides,
  };
  return {
    ...merged,
    teamMemberId: Schema.decodeSync(TeamMember.TeamMemberId)(merged.teamMemberId),
  };
}

const onRefresh = vi.fn();

beforeEach(() => {
  confirmSpy.mockReset();
  onRefresh.mockReset();
});

describe('EventAttendanceConfirmSection', () => {
  it('renders one checkbox per entry, ticked iff present', () => {
    const entries = [
      makeEntry({ teamMemberId: 'm1', displayName: 'Alice', present: true }),
      makeEntry({ teamMemberId: 'm2', displayName: 'Bob', present: false }),
    ];

    render(
      <EventAttendanceConfirmSection
        teamId='team-1'
        eventId='event-1'
        confirmedAt={Option.none()}
        entries={entries}
        onRefresh={onRefresh}
      />,
    );

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0].getAttribute('aria-checked')).toBe('true');
    expect(checkboxes[1].getAttribute('aria-checked')).toBe('false');
  });

  it('unticking one member and confirming PUTs the FULL list, with only that member present:false', async () => {
    confirmSpy.mockReturnValue(Effect.succeed(undefined));
    const entries = [
      makeEntry({ teamMemberId: 'm1', displayName: 'Alice', present: true }),
      makeEntry({ teamMemberId: 'm2', displayName: 'Bob', present: true }),
      makeEntry({ teamMemberId: 'm3', displayName: 'Carol', present: false }),
    ];

    render(
      <EventAttendanceConfirmSection
        teamId='team-1'
        eventId='event-1'
        confirmedAt={Option.none()}
        entries={entries}
        onRefresh={onRefresh}
      />,
    );

    // Untick Bob (was present:true)
    fireEvent.click(screen.getByLabelText('Bob'));

    fireEvent.click(screen.getByRole('button', { name: 'Confirm attendance' }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());

    const call = confirmSpy.mock.calls[0][0] as {
      payload: { entries: ReadonlyArray<{ teamMemberId: string; present: boolean }> };
    };
    expect(call.payload.entries).toEqual([
      { teamMemberId: 'm1', present: true },
      { teamMemberId: 'm2', present: false },
      { teamMemberId: 'm3', present: false },
    ]);
  });

  it('confirmedAt Some renders the confirmed line and relabels the button to Update', () => {
    const entries = [makeEntry({ teamMemberId: 'm1', present: true })];
    const confirmedAt = DateTime.makeUnsafe('2026-01-05T14:30:00Z');

    render(
      <EventAttendanceConfirmSection
        teamId='team-1'
        eventId='event-1'
        confirmedAt={Option.some(confirmedAt)}
        entries={entries}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByText(/Confirmed /)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Update attendance' })).not.toBeNull();
  });

  it('a PUT failure preserves the toggled checkbox state — no silent reset', async () => {
    confirmSpy.mockReturnValue(Effect.fail(new Error('network error')));
    const entries = [
      makeEntry({ teamMemberId: 'm1', displayName: 'Alice', present: true }),
      makeEntry({ teamMemberId: 'm2', displayName: 'Bob', present: true }),
    ];

    render(
      <EventAttendanceConfirmSection
        teamId='team-1'
        eventId='event-1'
        confirmedAt={Option.none()}
        entries={entries}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByLabelText('Bob'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm attendance' }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalled());

    // Bob's checkbox is still unticked — the failure never silently reset local state.
    expect(screen.getByLabelText('Bob').getAttribute('aria-checked')).toBe('false');
  });

  it('empty entries renders the empty state, no crash', () => {
    render(
      <EventAttendanceConfirmSection
        teamId='team-1'
        eventId='event-1'
        confirmedAt={Option.none()}
        entries={[]}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByText('No members to confirm attendance for.')).not.toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
