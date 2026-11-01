// Tests for the create-event dialog: the inline create form left the page and now lives in a
// Dialog opened by the "New event" header button (list and calendar view alike). Dismissing the
// dialog keeps the draft; only a successful submit closes it.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DateTime, Option } from 'effect';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invalidate, submitResult, apiCall } = vi.hoisted(() => ({
  invalidate: vi.fn(),
  submitResult: vi.fn(),
  // Every `api.<group>.<method>(args)` call the page makes: [group, method, args].
  apiCall: vi.fn(),
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
      event_eventType: 'Event type',
      event_trainingType: 'Training type',
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

// The page's first pipe step (`Effect.flatMap((api) => api.x.y(args))`) runs against a fake api
// that records the call, so tests can read the exact payload; the pipe's result is `submitResult`.
vi.mock('~/lib/runtime', async () => {
  const { Effect } = await import('effect');
  const api = new Proxy(
    {},
    {
      get: (_target, group) =>
        new Proxy(
          {},
          {
            get: (_t, method) => (args: unknown) => {
              apiCall(String(group), String(method), args);
              return Effect.void;
            },
          },
        ),
    },
  );
  return {
    ApiClient: {
      asEffect: () => ({
        pipe: (first: (self: unknown) => unknown) => {
          Effect.runSync(first(Effect.succeed(api)) as Parameters<typeof Effect.runSync>[0]);
          return submitResult();
        },
      }),
    },
    ClientError: { make: (msg: string) => ({ _tag: 'ClientError', message: msg }) },
    useRun: () => () => () => undefined,
  };
});

// Stub of the real picker: one button per type, and the same mount-time auto-select (B4) — the
// first type of the event's own kind when nothing is selected yet.
vi.mock('~/components/molecules/EventTypePicker', async () => {
  const React = await import('react');
  const { Option } = await import('effect');
  type PickerType = { eventTypeId: string; kind: string };
  return {
    EventTypePicker: ({
      eventTypes,
      event,
      value,
      onChange,
    }: {
      eventTypes: ReadonlyArray<PickerType>;
      event: { eventType: string; eventTypeId: Option.Option<string> };
      value: Option.Option<string>;
      onChange: (next: PickerType) => void;
    }) => {
      React.useEffect(() => {
        if (Option.isSome(value) || Option.isSome(event.eventTypeId)) return;
        const fallback = eventTypes.find((t) => t.kind === event.eventType) ?? eventTypes[0];
        if (fallback) onChange({ eventTypeId: fallback.eventTypeId, kind: fallback.kind });
      }, [value, event.eventTypeId, event.eventType, eventTypes, onChange]);
      return (
        <div data-testid='event-type-picker'>
          {eventTypes.map((t) => (
            <button
              key={t.eventTypeId}
              type='button'
              onClick={() => onChange({ eventTypeId: t.eventTypeId, kind: t.kind })}
            >
              {`pick-${t.kind}`}
            </button>
          ))}
        </div>
      );
    },
  };
});

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
  {
    eventTypeId: 'et-match',
    teamId: 'team-1',
    name: Option.none<string>(),
    kind: 'match',
    color: 'red',
    position: 1,
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

const openRecurring = () => {
  openDialog();
  fireEvent.click(screen.getByRole('button', { name: 'Recurring' }));
};

// Open the dialog and fill a valid recurring series (Title "Weekly", first weekday, 18:00).
const fillRecurring = () => {
  openRecurring();
  fillAndSubmitRecurring();
};

const fillAndSubmitRecurring = () => {
  fireEvent.change(titleInput(), { target: { value: 'Weekly' } });
  const dayToggle = document.querySelector<HTMLButtonElement>('button[aria-pressed="false"]');
  expect(dayToggle).not.toBeNull();
  fireEvent.click(dayToggle as HTMLButtonElement);
  fireEvent.change(screen.getByLabelText('Start time (Europe/Prague)'), {
    target: { value: '18:00' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create Recurring Series' }));
};

type SeriesPayload = {
  eventType: Option.Option<string>;
  eventTypeId: Option.Option<string>;
  trainingTypeId: Option.Option<string>;
};

const createSeriesPayload = async (): Promise<SeriesPayload> => {
  await waitFor(() => {
    expect(apiCall.mock.calls.some((c) => c[1] === 'createEventSeries')).toBe(true);
  });
  const call = apiCall.mock.calls.find((c) => c[1] === 'createEventSeries') ?? [];
  return (call[2] as { payload: SeriesPayload }).payload;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventsListPage create dialog', () => {
  beforeEach(() => {
    invalidate.mockReset();
    apiCall.mockReset();
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

describe('EventsListPage recurring series event type', () => {
  beforeEach(() => {
    invalidate.mockReset();
    apiCall.mockReset();
    submitResult.mockReset();
    submitResult.mockImplementation(() => Promise.resolve(Option.some({})));
  });

  it('should render the event type picker inside the recurring form', () => {
    renderPage();

    openRecurring();

    const form = screen.getByRole('button', { name: 'Create Recurring Series' }).closest('form');
    expect(form).not.toBeNull();
    expect(within(form as HTMLElement).getByTestId('event-type-picker')).not.toBeNull();
  });

  it('should send the auto-selected training type when the recurring form is submitted untouched', async () => {
    renderPage();

    fillRecurring();

    const payload = await createSeriesPayload();
    expect(payload.eventType).toEqual(Option.some('training'));
    expect(payload.eventTypeId).toEqual(Option.some('et-training'));
  });

  it('should send no eventTypeId when no type was ever selected (empty type list)', async () => {
    renderPage({ eventTypes: [] });

    fillRecurring();

    const payload = await createSeriesPayload();
    expect(payload.eventType).toEqual(Option.some('training'));
    expect(payload.eventTypeId).toEqual(Option.none());
  });

  it('should hide and clear the training type when a non-training type is picked', async () => {
    renderPage({ trainingTypes: [{ trainingTypeId: 'tt-1', name: 'Throwing' }] });

    openRecurring();
    fireEvent.click(screen.getByRole('combobox', { name: 'Training type' }));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Throwing'));
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Training type' }).textContent).toContain(
        'Throwing',
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'pick-match' }));
    await waitFor(() => {
      expect(screen.queryByRole('combobox', { name: 'Training type' })).toBeNull();
    });

    fillAndSubmitRecurring();

    const payload = await createSeriesPayload();
    expect(payload.eventType).toEqual(Option.some('match'));
    expect(payload.eventTypeId).toEqual(Option.some('et-match'));
    expect(payload.trainingTypeId).toEqual(Option.none());
  });
});
