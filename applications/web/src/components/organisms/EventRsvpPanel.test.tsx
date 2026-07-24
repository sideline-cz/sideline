import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      rsvp_title: 'RSVP',
      rsvp_yes: 'Yes',
      rsvp_no: 'No',
      rsvp_maybe: 'Coming later',
      rsvp_message: 'Message',
      rsvp_messagePlaceholder: 'Optional message for the team',
      rsvp_messageRequired: 'Please add a reason for coming later.',
      rsvp_deadlinePassed: 'RSVP deadline has passed.',
      rsvp_attending: '{count} going',
      rsvp_notAttending: '{count} not going',
      rsvp_undecided: '{count} coming later',
      rsvp_summary: 'Responses',
      rsvp_noResponses: 'No responses yet.',
      rsvp_belowMinPlayers: 'Only {count} confirmed, need {threshold}.',
      rsvp_nonRespondersTitle: 'Not yet responded',
      rsvp_saveNote: 'Save note',
      rsvp_savingNote: 'Saving...',
      event_rsvpSubmitted: 'RSVP submitted',
    };
    const template = map[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
  },
  setTranslationOverrides: vi.fn(),
}));

// `run(...)(effect)` just needs to resolve the already-produced "effect" value —
// production `onRsvpSubmit` is invoked synchronously as an argument before `run`
// ever sees it, so a trivial resolving mock is enough to exercise the component.
vi.mock('~/lib/runtime', () => ({
  ApiClient: { asEffect: () => ({}) },
  ClientError: { make: (msg: string) => ({ _tag: 'ClientError', message: msg }) },
  useRun: () => () => (effect: unknown) => Promise.resolve(effect),
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { EventRsvpPanel } = await import('~/components/organisms/EventRsvpPanel.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type RsvpResponse = 'yes' | 'no' | 'maybe' | 'coming_later';

type RsvpEntryView = {
  teamMemberId: string;
  memberName: Option.Option<string>;
  username: Option.Option<string>;
  response: RsvpResponse;
  message: Option.Option<string>;
  displayName: string;
};

type RsvpDetailView = {
  myResponse: Option.Option<RsvpResponse>;
  myMessage: Option.Option<string>;
  rsvps: ReadonlyArray<RsvpEntryView>;
  yesCount: number;
  noCount: number;
  maybeCount: number;
  canRsvp: boolean;
  minPlayersThreshold: number;
};

function makeRsvpEntry(overrides: Partial<RsvpEntryView> = {}): RsvpEntryView {
  return {
    teamMemberId: 'member-1',
    memberName: Option.some('Alice'),
    username: Option.some('alice'),
    response: 'yes',
    message: Option.none(),
    displayName: 'Alice',
    ...overrides,
  };
}

function makeRsvpDetail(overrides: Partial<RsvpDetailView> = {}): RsvpDetailView {
  return {
    myResponse: Option.none(),
    myMessage: Option.none(),
    rsvps: [],
    yesCount: 0,
    noCount: 0,
    maybeCount: 0,
    canRsvp: true,
    minPlayersThreshold: 0,
    ...overrides,
  };
}

function makeEventDetail(overrides: Partial<{ canEdit: boolean; canCancel: boolean }> = {}) {
  return {
    eventId: 'event-1',
    teamId: 'team-1',
    canEdit: false,
    canCancel: false,
    ...overrides,
  };
}

function renderPanel({
  eventDetail = makeEventDetail(),
  rsvpDetail = makeRsvpDetail(),
  nonResponders = [] as ReadonlyArray<{
    teamMemberId: string;
    memberName: Option.Option<string>;
    username: Option.Option<string>;
    displayName: string;
  }>,
  onRsvpSubmit = vi.fn(() => 'mock-effect'),
} = {}) {
  render(
    <EventRsvpPanel
      eventDetail={eventDetail as never}
      rsvpDetail={rsvpDetail as never}
      nonResponders={nonResponders as never}
      onRsvpSubmit={onRsvpSubmit as never}
    />,
  );
  return { onRsvpSubmit };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventRsvpPanel', () => {
  it('clicking "Yes" submits immediately, regardless of note content', async () => {
    const { onRsvpSubmit } = renderPanel({
      rsvpDetail: makeRsvpDetail({ myResponse: Option.some('no'), myMessage: Option.some('') }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));

    await waitFor(() => {
      expect(onRsvpSubmit).toHaveBeenCalledWith('yes', '');
    });
  });

  it('clicking "No" submits immediately, regardless of note content', async () => {
    const { onRsvpSubmit } = renderPanel({
      rsvpDetail: makeRsvpDetail({ myResponse: Option.some('yes'), myMessage: Option.some('') }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'No' }));

    await waitFor(() => {
      expect(onRsvpSubmit).toHaveBeenCalledWith('no', '');
    });
  });

  it('Yes/No submit uses the already-saved note, ignoring an unsaved draft typed into the textarea', async () => {
    // Starting response is "coming_later" so the note textarea is already visible/editable.
    const { onRsvpSubmit } = renderPanel({
      rsvpDetail: makeRsvpDetail({
        myResponse: Option.some('coming_later'),
        myMessage: Option.some('saved reason'),
      }),
    });

    const textarea = screen.getByLabelText(/Message/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'an unsaved draft note' } });

    fireEvent.click(screen.getByRole('button', { name: 'No' }));

    await waitFor(() => {
      // Called with the saved message, NOT the unsaved draft just typed.
      expect(onRsvpSubmit).toHaveBeenCalledWith('no', 'saved reason');
    });
  });

  it('clicking "Coming later" does NOT submit immediately; it reveals and focuses the note field', () => {
    const { onRsvpSubmit } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Coming later' }));

    expect(onRsvpSubmit).not.toHaveBeenCalled();

    const textarea = screen.getByLabelText(/Message/) as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    // Focus is moved to the note field in a `useEffect` keyed on `pendingResponse`, which runs
    // after React commits the re-render that reveals the textarea.
    expect(document.activeElement).toBe(textarea);
  });

  it('"Coming later" pending state: Save disabled + inline alert while note is empty', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Coming later' }));

    const textarea = screen.getByLabelText(/Message/);
    expect(textarea.getAttribute('aria-required')).toBe('true');
    expect(textarea.getAttribute('aria-invalid')).toBe('true');

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Please add a reason for coming later.');

    const saveButton = screen.getByRole('button', { name: 'Save note' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it('"Coming later" + non-empty note: Save enabled, no alert, and Save calls onRsvpSubmit with the note', async () => {
    const { onRsvpSubmit } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Coming later' }));

    const textarea = screen.getByLabelText(/Message/);
    fireEvent.change(textarea, { target: { value: 'running 10 min late' } });

    expect(textarea.getAttribute('aria-invalid')).toBe('false');
    expect(screen.queryByRole('alert')).toBeNull();

    const saveButton = screen.getByRole('button', { name: 'Save note' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(onRsvpSubmit).toHaveBeenCalledWith('coming_later', 'running 10 min late');
    });
  });

  it('does not call onRsvpSubmit for "Coming later" while the note is still empty (Save disabled)', () => {
    const { onRsvpSubmit } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Coming later' }));
    const saveButton = screen.getByRole('button', { name: 'Save note' });
    fireEvent.click(saveButton);

    expect(onRsvpSubmit).not.toHaveBeenCalled();
  });

  it('Yes/No responses do not require a note: Save works with an empty note', async () => {
    const { onRsvpSubmit } = renderPanel({
      rsvpDetail: makeRsvpDetail({ myResponse: Option.some('yes'), myMessage: Option.some('hi') }),
    });

    const textarea = screen.getByLabelText('Message') as HTMLTextAreaElement;
    expect(textarea.getAttribute('aria-required')).toBe('false');
    fireEvent.change(textarea, { target: { value: '' } });

    const saveButton = screen.getByRole('button', { name: 'Save note' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(onRsvpSubmit).toHaveBeenCalledWith('yes', '');
    });
  });

  it('clicking the currently-active response again clears a pending "Coming later" selection without submitting', () => {
    const { onRsvpSubmit } = renderPanel({
      rsvpDetail: makeRsvpDetail({ myResponse: Option.some('yes'), myMessage: Option.some('') }),
    });

    // Select "Coming later" — note becomes required.
    fireEvent.click(screen.getByRole('button', { name: 'Coming later' }));
    expect(screen.getByLabelText(/Message/).getAttribute('aria-required')).toBe('true');

    // Click "Yes" again (the currently-saved response) — this is the escape hatch.
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));

    // Escape hatch clears the pending "coming later" selection instead of submitting.
    expect(onRsvpSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message').getAttribute('aria-required')).toBe('false');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('below-min-players warning sums yesCount + maybeCount against the threshold (hidden at the boundary)', () => {
    renderPanel({
      rsvpDetail: makeRsvpDetail({ yesCount: 3, maybeCount: 2, minPlayersThreshold: 5 }),
    });

    // 3 + 2 = 5, which is NOT below the threshold of 5 — warning should be hidden.
    expect(screen.queryByText(/Only \d+ confirmed/)).toBeNull();
  });

  it('below-min-players warning shows using the yesCount + maybeCount sum, not yesCount alone', () => {
    renderPanel({
      rsvpDetail: makeRsvpDetail({ yesCount: 3, maybeCount: 1, minPlayersThreshold: 5 }),
    });

    // 3 + 1 = 4 < 5 — warning shown, using the summed count (4), not yesCount alone (3).
    expect(screen.getByText('Only 4 confirmed, need 5.')).not.toBeNull();
  });

  it('a legacy "maybe" response and a "coming_later" response both render as "Coming later" in blue', () => {
    renderPanel({
      rsvpDetail: makeRsvpDetail({
        rsvps: [
          makeRsvpEntry({
            teamMemberId: 'm-legacy',
            displayName: 'Legacy Maybe',
            response: 'maybe',
          }),
          makeRsvpEntry({
            teamMemberId: 'm-new',
            displayName: 'New ComingLater',
            response: 'coming_later',
          }),
        ],
      }),
    });

    const legacyRow = screen.getByText('Legacy Maybe').closest('li');
    const newRow = screen.getByText('New ComingLater').closest('li');
    expect(legacyRow).not.toBeNull();
    expect(newRow).not.toBeNull();

    for (const row of [legacyRow, newRow]) {
      const label = row?.querySelector('span');
      expect(label?.textContent).toBe('Coming later');
      expect(label?.className).toContain('text-blue-600');
    }
  });

  it('the "Coming later" button is shown as active (aria-pressed) when the saved response is the legacy "maybe" value', () => {
    renderPanel({
      rsvpDetail: makeRsvpDetail({ myResponse: Option.some('maybe') }),
    });

    const comingLaterButton = screen.getByRole('button', { name: 'Coming later' });
    expect(comingLaterButton.getAttribute('aria-pressed')).toBe('true');
  });
});
