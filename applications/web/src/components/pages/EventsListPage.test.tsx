// Tests for the create-event dialog: the inline create form left the page and now lives in a
// Dialog opened by the "New event" header button (list and calendar view alike). Dismissing the
// dialog keeps the draft; only a successful submit closes it.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DateTime, Option } from 'effect';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invalidate, submitResult } = vi.hoisted(() => ({
  invalidate: vi.fn(),
  submitResult: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      event_events: 'Events',
      event_newEvent: 'New event',
      event_oneTime: 'One-time',
      event_recurring: 'Recurring',
      event_title: 'Title',
      event_createEvent: 'Create Event',
      event_createSeries: 'Create Recurring Series',
      event_startTime: 'Start time',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
  useRouter: () => ({ invalidate }),
  useRouterState: ({ select }: { select: (s: { status: string }) => unknown }) =>
    select({ status: 'idle' }),
}));

vi.mock('~/lib/runtime', () => ({
  ApiClient: { asEffect: () => ({ pipe: () => submitResult() }) },
  ClientError: { make: (msg: string) => ({ _tag: 'ClientError', message: msg }) },
  useRun: () => () => () => undefined,
}));

vi.mock('~/components/organisms/EventCalendarView', () => ({
  EventCalendarView: () => <div data-testid='calendar' />,
}));

const { EventsListPage } = await import('./EventsListPage.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'event-1',
    teamId: 'team-1',
    title: 'Weekly Training',
    eventType: 'training' as const,
    eventTypeId: Option.none(),
    eventTypeName: Option.none(),
    eventTypeColor: Option.none(),
    trainingTypeName: Option.none(),
    description: Option.none(),
    imageUrl: Option.none(),
    startAt: DateTime.makeUnsafe('2026-04-05T14:00:00Z'),
    endAt: Option.some(DateTime.makeUnsafe('2026-04-05T16:00:00Z')),
    location: Option.none(),
    locationUrl: Option.none(),
    status: 'active' as const,
    allDay: false,
    seriesId: Option.none(),
    startDate: Option.none(),
    endDate: Option.none(),
    ...overrides,
  };
}

const EVENTS = [
  makeEvent(),
  makeEvent({
    eventId: 'event-2',
    title: 'Friendly Match',
    eventType: 'match',
    startAt: DateTime.makeUnsafe('2026-04-10T18:00:00Z'),
    endAt: Option.some(DateTime.makeUnsafe('2026-04-10T20:00:00Z')),
  }),
];

const EVENT_TYPES = [
  {
    eventTypeId: 'et-training',
    teamId: 'team-1',
    name: Option.none<string>(),
    kind: 'training',
    color: 'blue',
    position: 0,
    usageCount: 0,
  },
];

function renderPage(overrides: Record<string, unknown> = {}) {
  const props = {
    teamId: 'team-1',
    events: EVENTS,
    canCreate: true,
    canViewAll: false,
    showAllGroups: false,
    onShowAllGroupsChange: vi.fn(),
    trainingTypes: [],
    eventTypes: EVENT_TYPES,
    groups: [],
    teamTimezone: 'Europe/Prague',
    ...overrides,
  };
  return render(
    <EventsListPage {...(props as unknown as React.ComponentProps<typeof EventsListPage>)} />,
  );
}

const openDialog = () => {
  fireEvent.click(screen.getByRole('button', { name: 'New event' }));
  return screen.getByRole('dialog', { name: 'New event' });
};

const titleInput = () => screen.getByLabelText('Title') as HTMLInputElement;

// Open the dialog and fill a valid recurring series (Title "Weekly", first weekday, 18:00).
const fillRecurring = () => {
  openDialog();
  fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
  fireEvent.change(titleInput(), { target: { value: 'Weekly' } });
  const dayToggle = document.querySelector<HTMLButtonElement>('button[aria-pressed="false"]');
  expect(dayToggle).not.toBeNull();
  fireEvent.click(dayToggle as HTMLButtonElement);
  fireEvent.change(screen.getByLabelText('Start time (Europe/Prague)'), {
    target: { value: '18:00' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create Recurring Series' }));
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventsListPage create dialog', () => {
  beforeEach(() => {
    invalidate.mockReset();
    submitResult.mockReset();
    submitResult.mockImplementation(() => Promise.resolve(Option.some({})));
  });

  it('should show a "New event" button and no inline create form when canCreate is true', () => {
    renderPage({ canCreate: true });

    expect(screen.getByRole('button', { name: 'New event' })).not.toBeNull();
    expect(screen.queryByLabelText('Title')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create Event' })).toBeNull();
  });

  it('should not show a "New event" button when canCreate is false', () => {
    renderPage({ canCreate: false });

    expect(screen.queryByRole('button', { name: 'New event' })).toBeNull();
  });

  it('should open a "New event" dialog with the Title field and both mode toggles', () => {
    renderPage();

    openDialog();

    expect(screen.getByLabelText('Title')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'One-time' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Recurring' })).not.toBeNull();
  });

  it('should label the recurring start time with the team timezone when Recurring is chosen', () => {
    renderPage();

    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));

    expect(screen.getByLabelText('Start time (Europe/Prague)')).not.toBeNull();
  });

  it('should keep the draft when the dialog is dismissed and reopened', async () => {
    renderPage();

    const dialog = openDialog();
    fireEvent.change(titleInput(), { target: { value: 'Draft' } });
    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    openDialog();
    expect(titleInput().value).toBe('Draft');
  });

  it('should return focus to the "New event" button when the dialog is dismissed', async () => {
    renderPage();

    fireEvent.keyDown(openDialog(), { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New event' }));
  });

  it('should close the dialog after a successful recurring submit', async () => {
    renderPage();

    fillRecurring();

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(submitResult).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('should keep the dialog open with the values intact when the submit fails', async () => {
    submitResult.mockImplementation(() => Promise.resolve(Option.none()));
    renderPage();

    fillRecurring();

    // Wait for the whole submit to settle (button re-enabled), not just for the request.
    await waitFor(() => {
      expect(submitResult).toHaveBeenCalledTimes(1);
      const submit = screen.getByRole('button', { name: 'Create Recurring Series' });
      expect((submit as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.getByRole('dialog', { name: 'New event' })).not.toBeNull();
    expect(titleInput().value).toBe('Weekly');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('should open the create dialog from the calendar view', () => {
    renderPage();

    fireEvent.click(screen.getByTitle('event_viewCalendar'));
    expect(screen.getByTestId('calendar')).not.toBeNull();

    openDialog();
    expect(screen.getByLabelText('Title')).not.toBeNull();
  });
});
