// Tests for the event-detail redesign's page shell: facts render as read-only text on first
// render (the regression the whole redesign story exists to fix — a coach used to land straight
// on the edit form), the Edit/Cancel Event buttons live in the header regardless of edit state,
// status/type/series chips render above the title, and the series cancel-scope picker is reachable
// even when the edit form was never opened (BLOCKER A: the picker's state was hoisted out of the
// form so "Cancel Event" stays wired whether or not you're editing).
//
// Heavy child organisms are stubbed to `() => null` — this file tests composition/gating, not
// their internals. `EventFactBar` is kept real: it is the component under the same redesign.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DateTime, Option } from 'effect';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cancelResult, navigate } = vi.hoisted(() => ({
  cancelResult: vi.fn(),
  navigate: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      event_backToEvents: 'Back to Events',
      event_edit: 'Edit',
      event_cancelEvent: 'Cancel Event',
      event_cancelConfirm: 'Are you sure you want to cancel this event?',
      event_cancelKeep: 'Keep event',
      event_editScopeBack: 'Back to editing',
      event_editCancel: 'Discard changes',
      event_saveChanges: 'Save Changes',
      event_saving: 'Saving...',
      event_title: 'Title',
      event_titlePlaceholder: 'e.g. Tuesday Training',
      event_status_active: 'Active',
      event_status_cancelled: 'Cancelled',
      event_status_started: 'Started',
      event_type_training: 'Training',
      event_type_match: 'Match',
      event_recurring: 'Recurring',
      event_editScopeTitle: 'How would you like to edit?',
      event_editThisOnly: 'This event only',
      event_editAllFuture: 'All future events in series',
      event_cancelScopeTitle: 'What would you like to cancel?',
      event_cancelThisOnly: 'This event only',
      event_cancelAllFuture: 'All future events in series',
      event_eventDate: 'Date',
      event_allDayLabel: 'All day',
      event_location: 'Location',
      event_trainingType: 'Training Type',
      common_opensInNewTab: 'opens in a new tab',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
  useRouter: () => ({ invalidate: vi.fn() }),
  useNavigate: () => navigate,
}));

vi.mock('~/lib/runtime', () => ({
  ApiClient: { asEffect: () => ({ pipe: () => cancelResult() }) },
  ClientError: { make: (msg: string) => ({ _tag: 'ClientError', message: msg }) },
  useRun: () => () => (effect: unknown) => Promise.resolve(effect),
}));

vi.mock('~/components/organisms/EventRsvpPanel.js', () => ({ EventRsvpPanel: () => null }));
vi.mock('~/components/organisms/EventAttendanceRosterSection.js', () => ({
  EventAttendanceRosterSection: () => null,
}));
vi.mock('~/components/organisms/EventAttendanceConfirmSection.js', () => ({
  EventAttendanceConfirmSection: () => <div data-testid='attendance-confirm-section' />,
}));
vi.mock('~/components/organisms/TrainingResultSection.js', () => ({
  TrainingResultSection: () => null,
}));
vi.mock('~/components/organisms/TeamGeneratorSection.js', () => ({
  TeamGeneratorSection: () => null,
}));

const { EventDetailPage } = await import('./EventDetailPage.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type EventStatus = 'active' | 'cancelled' | 'started';

function makeEventDetail(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'event-1',
    teamId: 'team-1',
    title: 'Tuesday Training',
    eventType: 'training' as const,
    // Added by the custom-event-types change (#710): `eventTypeName` is a nested Option
    // (outer = rolling-deploy optional key, inner = "seeded row, no custom name").
    eventTypeId: Option.none(),
    eventTypeName: Option.none(),
    eventTypeColor: Option.none(),
    trainingTypeId: Option.none(),
    trainingTypeName: Option.none(),
    description: Option.none(),
    imageUrl: Option.none(),
    startAt: DateTime.makeUnsafe('2026-09-24T14:00:00Z'),
    endAt: Option.none(),
    location: Option.none(),
    locationUrl: Option.none(),
    status: 'active' as EventStatus,
    allDay: false,
    createdByName: Option.none(),
    canEdit: true,
    canCancel: true,
    seriesId: Option.none(),
    seriesModified: false,
    ownerGroupId: Option.none(),
    ownerGroupName: Option.none(),
    memberGroupId: Option.none(),
    memberGroupName: Option.none(),
    startDate: Option.none(),
    endDate: Option.none(),
    timezone: Option.none(),
    ...overrides,
  };
}

function renderPage(
  eventDetailOverrides: Record<string, unknown> = {},
  attendanceOverrides: Record<string, unknown> = {},
) {
  const eventDetail = makeEventDetail(eventDetailOverrides);
  const props = {
    teamId: 'team-1',
    eventId: 'event-1',
    eventDetail,
    trainingTypes: [],
    eventTypes: [],
    rsvpDetail: {},
    attendance: {
      canConfirm: false,
      confirmedAt: Option.none(),
      entries: [],
      ...attendanceOverrides,
    },
    nonResponders: [],
    groups: [],
    rosters: [],
    canManageRosters: false,
    canManageRatings: false,
    canGenerate: false,
    initialEventRosterLink: Option.none(),
    rsvpYesAttendees: [],
    initialTrainingGames: [],
  };
  return {
    ...render(
      <EventDetailPage {...(props as unknown as React.ComponentProps<typeof EventDetailPage>)} />,
    ),
    eventDetail,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventDetailPage', () => {
  beforeEach(() => {
    navigate.mockReset();
    cancelResult.mockReset();
    cancelResult.mockImplementation(() => Promise.resolve(Option.some({})));
  });

  it('a coach sees facts as text, not a form, on first render (canEdit:true, status:active) — the regression this redesign fixes', () => {
    renderPage({ canEdit: true, status: 'active' });

    expect(screen.getByText('Date:')).not.toBeNull();
    expect(screen.queryByLabelText('Title')).toBeNull();
  });

  it('Edit button is visible for a coach', () => {
    renderPage({ canEdit: true, status: 'active' });

    expect(screen.getByRole('button', { name: 'Edit' })).not.toBeNull();
  });

  it('clicking Edit reveals the form', () => {
    renderPage({ canEdit: true, status: 'active' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByLabelText('Title')).not.toBeNull();
  });

  it('the fact bar stays visible while editing', () => {
    renderPage({ canEdit: true, status: 'active' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByLabelText('Title')).not.toBeNull();
    expect(screen.getByText('Date:')).not.toBeNull();
  });

  it('Discard closes the form and restores the original title', () => {
    renderPage({ canEdit: true, status: 'active', title: 'Original Title' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const titleInput = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'Changed Title' } });

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));

    expect(screen.queryByLabelText('Title')).toBeNull();

    // Reopen — the form must show the ORIGINAL title, not the discarded edit.
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Original Title');
  });

  it('a non-coach sees the same facts and no Edit button', () => {
    renderPage({ canEdit: false, status: 'active' });

    expect(screen.getByText('Date:')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('no Edit button on a cancelled event', () => {
    renderPage({ canEdit: true, status: 'cancelled' });

    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('no Edit button on a started event', () => {
    renderPage({ canEdit: true, status: 'started' });

    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('chips render above the title: status + type + series, and the old "part of series" copy is gone', () => {
    renderPage({ status: 'active', eventType: 'training', seriesId: Option.some('series-1') });

    expect(screen.getByText('Active')).not.toBeNull();
    expect(screen.getByText('Training')).not.toBeNull();
    expect(screen.getByText('Recurring')).not.toBeNull();
    expect(screen.queryByText('event_partOfSeries')).toBeNull();
  });

  it('no series means no Recurring chip', () => {
    renderPage({ seriesId: Option.none() });

    expect(screen.queryByText('Recurring')).toBeNull();
  });

  it('exactly one Cancel Event button — both when the form is closed and while editing', () => {
    renderPage({ canEdit: true, canCancel: true, status: 'active' });

    expect(screen.getAllByRole('button', { name: 'Cancel Event' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getAllByRole('button', { name: 'Cancel Event' })).toHaveLength(1);
  });

  it('no Cancel Event button on a started event even when canCancel is true', () => {
    renderPage({ canCancel: true, status: 'started' });

    expect(screen.queryByRole('button', { name: 'Cancel Event' })).toBeNull();
  });

  it('BLOCKER A: the series cancel-scope picker renders when the form is CLOSED', () => {
    renderPage({ canCancel: true, status: 'active', seriesId: Option.some('series-1') });

    // Never opened Edit — the picker must still be reachable from the header button.
    expect(screen.queryByLabelText('Title')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Event' }));

    expect(screen.getByRole('alertdialog')).not.toBeNull();
    expect(screen.getByText('What would you like to cancel?')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'This event only' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'All future events in series' })).not.toBeNull();
  });

  it('the series edit-scope prompt still fires: Edit -> Save -> both scope options appear', async () => {
    renderPage({ canEdit: true, status: 'active', seriesId: Option.some('series-1') });

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByLabelText('Title').closest('form');
    expect(form).not.toBeNull();

    fireEvent.click(within(form as HTMLElement).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(screen.getByText('How would you like to edit?')).not.toBeNull();
    });
    expect(screen.getByRole('alertdialog')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'This event only' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'All future events in series' })).not.toBeNull();
  });

  it('a non-series cancel asks in an AlertDialog, not window.confirm', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage({ canCancel: true, status: 'active', title: 'Tuesday Training' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Event' }));

    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Are you sure you want to cancel this event?')).not.toBeNull();
    expect(within(dialog).getByText('Tuesday Training')).not.toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('"Keep event" closes the non-series cancel dialog without cancelling and refocuses Cancel Event', async () => {
    renderPage({ canCancel: true, status: 'active' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Event' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep event' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel Event' }));
    expect(cancelResult).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('confirming the non-series cancel dialog cancels the event and navigates to the list', async () => {
    renderPage({ canCancel: true, status: 'active' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Event' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel Event' }));

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({ to: '/teams/$teamId/events' }),
      );
    });
    expect(cancelResult).toHaveBeenCalledTimes(1);
  });

  it('dismissing the series edit-scope dialog keeps the edit form and its values and refocuses Save Changes', async () => {
    renderPage({ canEdit: true, status: 'active', seriesId: Option.some('series-1') });

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Changed Title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).not.toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Back to editing' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Changed Title');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save Changes' }));
    expect(cancelResult).not.toHaveBeenCalled();
  });

  it('the header Cancel Event button is disabled while a cancel is in flight (double-cancel guard)', async () => {
    cancelResult.mockImplementation(() => new Promise(() => {}));
    renderPage({ canCancel: true, status: 'active' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Event' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel Event' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    const headerButton = screen.getByRole('button', { name: 'Cancel Event' }) as HTMLButtonElement;
    expect(headerButton.disabled).toBe(true);
    expect(cancelResult).toHaveBeenCalledTimes(1);
  });

  it('a failed cancel re-enables the header Cancel Event button and does not navigate', async () => {
    cancelResult.mockImplementation(() => Promise.resolve(Option.none()));
    renderPage({ canCancel: true, status: 'active' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Event' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel Event' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    await waitFor(() => {
      const headerButton = screen.getByRole('button', {
        name: 'Cancel Event',
      }) as HTMLButtonElement;
      expect(headerButton.disabled).toBe(false);
    });
    expect(cancelResult).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('the attendance confirm section is NOT rendered when canConfirm is false', () => {
    renderPage(
      { eventType: 'training', status: 'active' },
      { canConfirm: false, confirmedAt: Option.none(), entries: [] },
    );

    expect(screen.queryByTestId('attendance-confirm-section')).toBeNull();
  });

  it('the attendance confirm section renders when canConfirm is true for an active training', () => {
    renderPage(
      { eventType: 'training', status: 'active' },
      { canConfirm: true, confirmedAt: Option.none(), entries: [] },
    );

    expect(screen.getByTestId('attendance-confirm-section')).not.toBeNull();
  });
});
