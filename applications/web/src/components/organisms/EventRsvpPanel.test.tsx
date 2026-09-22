import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

// FIX (docs/plans/rsvp-maybe-restore.md): `rsvp_maybe` used to render "Coming
// later" here, which — combined with this stub's `map[key] ?? key` fallback —
// made every `getByRole('button', { name: 'Coming later' })` query in this
// file silently resolve to whichever button rendered `tr('rsvp_maybe')`. After
// the retarget, `rsvp_maybe` means "Not sure" (Nevím), so this MUST be fixed
// first, before any query below can be trusted to hit the button it names.
vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      rsvp_title: 'RSVP',
      rsvp_yes: 'Yes',
      rsvp_no: 'No',
      rsvp_maybe: 'Not sure',
      rsvp_comingLater: 'Coming later',
      rsvp_comingLaterCount: '{count} coming later',
      rsvp_message: 'Message',
      rsvp_messagePlaceholder: 'Optional message for the team',
      rsvp_messageRequired: 'Please add a reason for coming later.',
      rsvp_messageHelpRequired: 'Tell the team when you will arrive — required for "Coming later".',
      rsvp_messageHelpOptional: 'Optional note for the team.',
      rsvp_deadlinePassed: 'RSVP deadline has passed.',
      rsvp_attending: '{count} going',
      rsvp_notAttending: '{count} not going',
      rsvp_undecided: '{count} not sure',
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
  comingLaterCount: number;
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
    comingLaterCount: 0,
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
  it('renders four buttons in gradient order: Yes, Coming later, Not sure, No', () => {
    renderPanel();
    const buttons = screen.getAllByRole('button').map((b) => b.textContent?.trim());
    const rsvpButtonNames = ['Yes', 'Coming later', 'Not sure', 'No'];
    const indices = rsvpButtonNames.map((name) => buttons.indexOf(name));
    expect(indices.every((i) => i >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

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
    // Starting response is "yes" — any selected response renders the textarea, and starting from
    // "coming_later" would confound this with the note-clearing rule covered by the test below.
    const { onRsvpSubmit } = renderPanel({
      rsvpDetail: makeRsvpDetail({
        myResponse: Option.some('yes'),
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

  // A "coming later" note is mandatory and answers "when will you arrive", so it must not survive
  // leaving that response for a note-FREE target (yes/no) — instant-submit clears it client-side.
  // The server enforces the same rule via `effectiveClear` in `Event/SubmitRsvp` for clients that
  // send no message; the web must send the empty-string clear signal explicitly, because a
  // `coming_later` note is never blank and would otherwise always be re-sent.
  it.each([
    ['No', 'no'],
    ['Yes', 'yes'],
  ])('leaving "Coming later" for "%s" clears its mandatory note', async (label, response) => {
    const { onRsvpSubmit } = renderPanel({
      rsvpDetail: makeRsvpDetail({
        myResponse: Option.some('coming_later'),
        myMessage: Option.some('dorazím v 19:00'),
      }),
    });

    fireEvent.click(screen.getByRole('button', { name: label }));

    await waitFor(() => {
      expect(onRsvpSubmit).toHaveBeenCalledWith(response, '');
    });
  });

  // "Not sure" is a note-requiring target now too, so leaving "Coming later" for it does NOT
  // instant-submit (and therefore does not go through the client-side note-clearing branch
  // above, which only fires for yes/no) — it opens the note field exactly like clicking "Coming
  // later" itself does, and leaves the submit to an explicit Save.
  it('leaving "Coming later" for "Not sure" does not instant-submit; it reveals the note field instead', () => {
    const { onRsvpSubmit } = renderPanel({
      rsvpDetail: makeRsvpDetail({
        myResponse: Option.some('coming_later'),
        myMessage: Option.some('dorazím v 19:00'),
      }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Not sure' }));

    expect(onRsvpSubmit).not.toHaveBeenCalled();
    const textarea = screen.getByLabelText(/Message/) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(textarea);
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

  // ---------------------------------------------------------------------------
  // maybe ("Not sure") — now REQUIRES a note too, exactly like "Coming later"
  // (see `EventRsvp.rsvpResponseRequiresMessage`), so it no longer
  // instant-submits: it reveals and focuses the note field instead.
  // ---------------------------------------------------------------------------

  it('clicking "Not sure" does NOT submit immediately; it reveals and focuses the note field', () => {
    const { onRsvpSubmit } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Not sure' }));

    expect(onRsvpSubmit).not.toHaveBeenCalled();

    const textarea = screen.getByLabelText(/Message/) as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    // Focus is moved to the note field in a `useEffect` keyed on `pendingResponse`, which runs
    // after React commits the re-render that reveals the textarea.
    expect(document.activeElement).toBe(textarea);
  });

  it('Save is blocked with a blank note when the current response is "maybe"', () => {
    renderPanel({
      rsvpDetail: makeRsvpDetail({ myResponse: Option.some('maybe'), myMessage: Option.none() }),
    });

    const textarea = screen.getByLabelText(/Message/) as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    expect(textarea.getAttribute('aria-required')).toBe('true');

    const saveButton = screen.getByRole('button', { name: 'Save note' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Below-min-players — REWRITTEN (docs/plans/rsvp-maybe-restore.md): the
  // formula is now `yesCount + comingLaterCount` against the threshold.
  // `maybe` is deliberately excluded — the copy says "Pouze {count}
  // potvrzeno" ("Only {count} confirmed") and "Not sure" is not a
  // confirmation. These two cases prove that: the old (pre-split) formula
  // `yesCount + maybeCount` would read 8 and hide the warning at case 1, and
  // 4 and show it at case 2 — this rewrite locks the opposite outcomes.
  // ---------------------------------------------------------------------------

  it('below-min-players: { yes: 2, comingLater: 1, maybe: 5, threshold: 4 } shows the warning reading 3 (proves maybe is excluded)', () => {
    renderPanel({
      rsvpDetail: makeRsvpDetail({
        yesCount: 2,
        comingLaterCount: 1,
        maybeCount: 5,
        minPlayersThreshold: 4,
      }),
    });

    // 2 + 1 = 3 < 4 — warning shown, reading 3 (NOT 8, which is what
    // yesCount + maybeCount would have produced under the old formula).
    expect(screen.getByText('Only 3 confirmed, need 4.')).not.toBeNull();
  });

  it('below-min-players: { yes: 2, comingLater: 2, maybe: 0, threshold: 4 } hides the warning at the boundary', () => {
    renderPanel({
      rsvpDetail: makeRsvpDetail({
        yesCount: 2,
        comingLaterCount: 2,
        maybeCount: 0,
        minPlayersThreshold: 4,
      }),
    });

    // 2 + 2 = 4, which is NOT below the threshold of 4 — warning hidden.
    expect(screen.queryByText(/Only \d+ confirmed/)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // INVERTED (docs/plans/rsvp-maybe-restore.md): the wire projection that
  // made a legacy `maybe` row and a `coming_later` row render identically is
  // removed. They must now render DIFFERENT labels and DIFFERENT colour
  // classes in the per-responder list.
  // ---------------------------------------------------------------------------

  it('a "maybe" response and a "coming_later" response render DIFFERENT labels and DIFFERENT colour classes', () => {
    renderPanel({
      rsvpDetail: makeRsvpDetail({
        rsvps: [
          makeRsvpEntry({
            teamMemberId: 'm-maybe',
            displayName: 'Nevím Nora',
            response: 'maybe',
          }),
          makeRsvpEntry({
            teamMemberId: 'm-coming-later',
            displayName: 'Later Larry',
            response: 'coming_later',
          }),
        ],
      }),
    });

    // The response list lives behind the "Responses" disclosure, closed by default.
    fireEvent.click(screen.getByRole('button', { name: 'Responses' }));

    const maybeRow = screen.getByText('Nevím Nora').closest('li');
    const comingLaterRow = screen.getByText('Later Larry').closest('li');
    expect(maybeRow).not.toBeNull();
    expect(comingLaterRow).not.toBeNull();

    const maybeLabel = maybeRow?.querySelector('span');
    const comingLaterLabel = comingLaterRow?.querySelector('span');

    expect(maybeLabel?.textContent).not.toBe(comingLaterLabel?.textContent);
    expect(maybeLabel?.className).not.toBe(comingLaterLabel?.className);
  });

  // ---------------------------------------------------------------------------
  // INVERTED (docs/plans/rsvp-maybe-restore.md): aria-pressed on the row-1
  // buttons must track each response independently now — a saved "maybe" no
  // longer activates the "Coming later" button (they used to be
  // indistinguishable under the legacy projection).
  // ---------------------------------------------------------------------------

  it('myResponse Some("maybe") activates ONLY the "Not sure" button — "Coming later" is not pressed', () => {
    renderPanel({
      rsvpDetail: makeRsvpDetail({ myResponse: Option.some('maybe') }),
    });

    expect(screen.getByRole('button', { name: 'Not sure' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Coming later' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('myResponse Some("coming_later") activates ONLY the "Coming later" button — "Not sure" is not pressed (the mirror case)', () => {
    renderPanel({
      rsvpDetail: makeRsvpDetail({ myResponse: Option.some('coming_later') }),
    });

    expect(screen.getByRole('button', { name: 'Coming later' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Not sure' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  // ---------------------------------------------------------------------------
  // aria-pressed is true on exactly one of the four buttons, for each state.
  // ---------------------------------------------------------------------------

  (['yes', 'coming_later', 'maybe', 'no'] as const).forEach((response) => {
    it(`aria-pressed is true on exactly one of the four buttons when myResponse is "${response}"`, () => {
      renderPanel({
        rsvpDetail: makeRsvpDetail({ myResponse: Option.some(response) }),
      });

      const rsvpButtonNames = ['Yes', 'Coming later', 'Not sure', 'No'];
      const pressed = rsvpButtonNames.filter(
        (name) => screen.getByRole('button', { name }).getAttribute('aria-pressed') === 'true',
      );
      expect(pressed).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Accessibility — required marker is aria-hidden (not announced as a bare
  // "asterisk"); the textarea always carries aria-required.
  // ---------------------------------------------------------------------------

  it('the required marker is aria-hidden and the textarea carries aria-required', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Coming later' }));

    const textarea = screen.getByLabelText(/Message/);
    expect(textarea.hasAttribute('aria-required')).toBe(true);

    const marker = document.querySelector('[aria-hidden="true"]');
    expect(marker).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // aria-describedby lists both the permanent help text and the error text
  // when the note is missing on a mandatory-comment response; help alone
  // otherwise. The help text is rendered permanently (not only on error).
  // ---------------------------------------------------------------------------

  it('aria-describedby lists both help and error ids when the note is required and missing', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Coming later' }));

    const textarea = screen.getByLabelText(/Message/);
    const describedBy = textarea.getAttribute('aria-describedby') ?? '';
    const ids = describedBy.split(/\s+/).filter(Boolean);

    expect(ids.length).toBe(2);
    for (const id of ids) {
      expect(document.getElementById(id)).not.toBeNull();
    }
  });

  it('aria-describedby lists only the help id when the note is not missing (e.g. a non-mandatory response)', () => {
    renderPanel({
      rsvpDetail: makeRsvpDetail({ myResponse: Option.some('yes'), myMessage: Option.some('hi') }),
    });

    const textarea = screen.getByLabelText(/Message/);
    const describedBy = textarea.getAttribute('aria-describedby') ?? '';
    const ids = describedBy.split(/\s+/).filter(Boolean);

    expect(ids.length).toBe(1);
    expect(document.getElementById(ids[0])).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  // -------------------------------------------------------------------------
  // Redesign (c3): answers + counts stay above the fold, the response lists move
  // behind a disclosure that is CLOSED by default.
  // -------------------------------------------------------------------------

  it('the response list is hidden on first render', () => {
    renderPanel({
      rsvpDetail: makeRsvpDetail({
        rsvps: [makeRsvpEntry()],
        yesCount: 1,
      }),
    });

    expect(screen.queryByText('Alice')).toBeNull();
  });

  it('clicking the Responses toggle reveals the response list', () => {
    renderPanel({
      rsvpDetail: makeRsvpDetail({
        rsvps: [makeRsvpEntry()],
        yesCount: 1,
      }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Responses/ }));

    expect(screen.getByText('Alice')).not.toBeNull();
  });

  it('the disclosure toggle tracks its state in aria-expanded', () => {
    renderPanel();
    const toggle = screen.getByRole('button', { name: /Responses/ });

    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('the disclosure aria-controls points at the element it reveals', () => {
    renderPanel();
    const toggle = screen.getByRole('button', { name: /Responses/ });
    const controlledId = toggle.getAttribute('aria-controls');
    expect(controlledId).not.toBeNull();

    // Closed: the referenced region is not in the DOM yet.
    expect(document.getElementById(controlledId as string)).toBeNull();

    fireEvent.click(toggle);

    expect(document.getElementById(controlledId as string)).not.toBeNull();
  });

  it('non-responders live inside the same disclosure as the responses', () => {
    renderPanel({
      eventDetail: makeEventDetail({ canEdit: true }),
      nonResponders: [
        {
          teamMemberId: 'm-9',
          memberName: Option.none(),
          username: Option.none(),
          displayName: 'Zoe',
        },
      ],
    });

    expect(screen.queryByText('Zoe')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Responses/ }));

    expect(screen.getByText('Zoe')).not.toBeNull();
  });

  it('the count strip is visible without opening the disclosure', () => {
    renderPanel({ rsvpDetail: makeRsvpDetail({ yesCount: 3 }) });

    expect(screen.getByText('3 going')).not.toBeNull();
  });

  it('DOM order is answer buttons -> count strip -> note field -> disclosure toggle', () => {
    renderPanel({
      rsvpDetail: makeRsvpDetail({ myResponse: Option.some('yes'), yesCount: 3 }),
    });

    const yesButton = screen.getByRole('button', { name: 'Yes' });
    const countStrip = screen.getByText('3 going');
    const note = screen.getByLabelText(/Message/);
    const toggle = screen.getByRole('button', { name: /Responses/ });

    const precedes = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    expect(precedes(yesButton, countStrip)).toBe(true);
    expect(precedes(countStrip, note)).toBe(true);
    expect(precedes(note, toggle)).toBe(true);
  });

  it('the below-minimum warning does not compete with the note error for role="alert"', () => {
    renderPanel({
      rsvpDetail: makeRsvpDetail({ yesCount: 1, minPlayersThreshold: 5 }),
    });

    // The standing below-min notice is role="status", so it must not be an alert.
    expect(screen.getByText('Only 1 confirmed, need 5.')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    // Picking a note-requiring response raises the ONE real alert in the panel.
    fireEvent.click(screen.getByRole('button', { name: 'Coming later' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
