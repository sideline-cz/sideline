// TDD mode — written BEFORE `EventTypesPage.tsx` exists (plan §4/§7 F).
//
// Assumed component contract (modelled on the sibling ActivityTypesPage.tsx —
// dialog form + list + delete/archive confirm + withFieldErrors + useRun):
//
//   EventTypesPage({ teamId: string, canAdmin: boolean, eventTypes: EventTypeApi.EventTypeInfo[] })
//     - renders one row per type, in the given (position) order
//     - each row shows a colour swatch (`data-testid="event-type-swatch-<id>"`) and a name —
//       `Option.getOrElse(type.name, () => eventTypeLabels[type.kind]())`, i.e. a `name: None`
//       row must render the translated KIND label, never a blank cell
//     - each row has "Move up"/"Move down" reorder buttons (`tr('eventType_moveUp'/'moveDown')`
//       as their accessible name); the first row's "Move up" and the last row's "Move down"
//       are disabled — reordering is ▲/▼, per plan §4
//     - each row has an "Archive" button; clicking it calls `window.confirm(...)` with a message
//       that includes the type's `usageCount` (`tr('eventType_archiveConfirm', { name, count })`)
//       BEFORE calling the API — archive is always soft-delete, but the confirmation still warns
//       how many events reference the type
//
//   EventTypeFormDialog({ teamId, open, onClose, onSaved, editing? })
//     - a "Behaves like" kind select (`role="combobox"`), OPTIONS from `Event.EventType.literals`,
//       labelled with the existing `event_type_<kind>` keys (plan §0: "the word 'kind' never
//       appears" in copy, but the underlying select is exactly the kind literal)
//     - the kind select is ENABLED when creating (no `editing` prop) and DISABLED when editing
//       (kind is immutable once a type exists — plan §0/§2)
//
// This file WILL FAIL to import until the developer implements EventTypesPage.tsx — expected
// in TDD, not a bug to fix here.

import { render, screen } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      eventType_title: 'Event types',
      eventType_subtitle: 'Customize the event types your team uses',
      eventType_empty_title: 'No event types yet',
      eventType_empty_subtitle: 'Create your first event type',
      eventType_create: 'Create',
      eventType_creating: 'Creating…',
      eventType_created: 'Event type created',
      eventType_edit: 'Edit',
      eventType_save: 'Save',
      eventType_saving: 'Saving…',
      eventType_saved: 'Event type saved',
      eventType_nameAlreadyTaken: 'Name already taken',
      eventType_name: 'Name',
      eventType_namePlaceholder: 'e.g. Morning training',
      eventType_kind: 'Behaves like',
      eventType_archiveAction: 'Archive',
      eventType_moveUp: 'Move up',
      eventType_moveDown: 'Move down',
      eventType_usageCount: 'In use',
      event_type_training: 'Training',
      event_type_match: 'Match',
      event_type_tournament: 'Tournament',
      event_type_meeting: 'Meeting',
      event_type_social: 'Social',
      event_type_other: 'Other',
      achievement_admin_cancel: 'Cancel',
      validation_required: 'Required',
    };
    if (key === 'eventType_archiveConfirm') {
      return `Archive "${String(params?.name)}"? Used by ${String(params?.count)} events.`;
    }
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/lib/runtime', () => ({
  ApiClient: {
    asEffect: vi.fn(() => ({
      pipe: vi.fn(),
    })),
  },
  ClientError: { make: (msg: string) => ({ _tag: 'ClientError', message: msg }) },
  SilentClientError: class {
    constructor(public props: { message: string }) {}
  },
  useRun: vi.fn(() => vi.fn(() => new Promise(() => {}))),
}));

vi.mock('~/lib/form', () => ({
  withFieldErrors: vi.fn(() => (effect: unknown) => effect),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: vi.fn() }),
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}));

// Dynamic import AFTER mocks — will fail until EventTypesPage is implemented
const { EventTypesPage, EventTypeFormDialog } = await import(
  '~/components/pages/EventTypesPage.js'
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_ID = 'team-1' as any;

function eventType(overrides: Record<string, unknown> = {}) {
  return {
    eventTypeId: 'et-1',
    teamId: TEAM_ID,
    name: Option.none<string>(),
    kind: 'training',
    color: 'blue',
    position: 0,
    usageCount: 0,
    ...overrides,
  } as any;
}

const TYPES = [
  eventType({
    eventTypeId: 'et-1',
    name: Option.some('Ranní tréninky'),
    kind: 'training',
    color: 'blue',
    position: 0,
    usageCount: 5,
  }),
  eventType({
    eventTypeId: 'et-2',
    name: Option.none<string>(),
    kind: 'match',
    color: 'red',
    position: 1,
    usageCount: 0,
  }),
  eventType({
    eventTypeId: 'et-3',
    name: Option.some('Beach party'),
    kind: 'social',
    color: 'pink',
    position: 2,
    usageCount: 2,
  }),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventTypesPage — list', () => {
  it('renders every type with its name and a colour swatch', () => {
    render(<EventTypesPage teamId={TEAM_ID} canAdmin={true} eventTypes={TYPES} />);

    expect(screen.getByText('Ranní tréninky')).toBeInTheDocument();
    expect(screen.getByText('Beach party')).toBeInTheDocument();
    expect(screen.getByTestId('event-type-swatch-et-1')).toBeInTheDocument();
    expect(screen.getByTestId('event-type-swatch-et-2')).toBeInTheDocument();
    expect(screen.getByTestId('event-type-swatch-et-3')).toBeInTheDocument();
  });

  it('renders the translated kind label for a name: None row, never a blank cell', () => {
    render(<EventTypesPage teamId={TEAM_ID} canAdmin={true} eventTypes={TYPES} />);

    // et-2 has name: Option.none() and kind: 'match' — must fall back to the kind label.
    expect(screen.getByText('Match')).toBeInTheDocument();
  });

  it('disables "Move up" on the first row only', () => {
    render(<EventTypesPage teamId={TEAM_ID} canAdmin={true} eventTypes={TYPES} />);

    const moveUpButtons = screen.getAllByRole('button', { name: 'Move up' });
    expect(moveUpButtons).toHaveLength(3);
    expect(moveUpButtons[0]).toBeDisabled();
    expect(moveUpButtons[1]).not.toBeDisabled();
    expect(moveUpButtons[2]).not.toBeDisabled();
  });

  it('disables "Move down" on the last row only', () => {
    render(<EventTypesPage teamId={TEAM_ID} canAdmin={true} eventTypes={TYPES} />);

    const moveDownButtons = screen.getAllByRole('button', { name: 'Move down' });
    expect(moveDownButtons).toHaveLength(3);
    expect(moveDownButtons[0]).not.toBeDisabled();
    expect(moveDownButtons[1]).not.toBeDisabled();
    expect(moveDownButtons[2]).toBeDisabled();
  });

  it('the archive confirmation shows the type’s usageCount', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<EventTypesPage teamId={TEAM_ID} canAdmin={true} eventTypes={TYPES} />);

    const archiveButtons = screen.getAllByRole('button', { name: 'Archive' });
    archiveButtons[0].click();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = confirmSpy.mock.calls[0][0];
    expect(message).toContain('5');
    expect(message).toContain('Ranní tréninky');

    confirmSpy.mockRestore();
  });
});

describe('EventTypeFormDialog — kind ("Behaves like") select', () => {
  it('is enabled when creating a new type', () => {
    render(
      <EventTypeFormDialog teamId={TEAM_ID} open={true} onClose={vi.fn()} onSaved={vi.fn()} />,
    );

    expect(screen.getByRole('combobox')).not.toBeDisabled();
  });

  it('is disabled when editing an existing type — kind is immutable once a type exists', () => {
    render(
      <EventTypeFormDialog
        teamId={TEAM_ID}
        open={true}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        editing={TYPES[0]}
      />,
    );

    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});
