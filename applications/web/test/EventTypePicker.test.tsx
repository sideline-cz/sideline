// TDD mode — written BEFORE `EventTypePicker` exists (plan §4/§7 F, guards B3/B4).
//
// This is the shared picker `EventsListPage.tsx:412` and `EventDetailPage.tsx:540` factor out
// to keep the B3/B4 logic in one place instead of duplicating it per page.
//
// Assumed component contract:
//
//   interface EventTypePickerProps {
//     // Active types from GET /teams/:teamId/event-types, in position order.
//     eventTypes: ReadonlyArray<EventTypeApi.EventTypeInfo>;
//     // The event's OWN persisted snapshot (EventInfo/EventDetail shape) — used only to
//     // resolve a default when `value` is None, and to render a synthetic option when the
//     // persisted id points at a type no longer in `eventTypes` (archived).
//     event: {
//       eventType: Event.EventType;
//       eventTypeId: Option.Option<EventType.EventTypeId>;
//       eventTypeName: Option.Option<Option.Option<string>>;
//       eventTypeColor: Option.Option<EventType.EventTypeColor>;
//     };
//     // Controlled current selection.
//     value: Option.Option<EventType.EventTypeId>;
//     onChange: (next: { eventTypeId: EventType.EventTypeId; kind: Event.EventType }) => void;
//   }
//
// Behaviour under test (plan §4 B3/B4, §7 F):
//   - B4, archived: when `value` (or `event.eventTypeId`) points at an id absent from
//     `eventTypes`, the component prepends a DISABLED SelectItem built from the event's own
//     eventTypeName/eventTypeColor, and it renders as the current selection — a title-only
//     edit must not silently re-type the event onto the placeholder/first item.
//   - B3, unchanged submission: when `value` already names an ACTIVE type, the component
//     does not call `onChange` on mount — whatever the parent already holds (the original
//     eventTypeId) is what a title-only edit submits, unchanged.
//   - B4, no id at all (old server): when `value` is None AND `event.eventTypeId` is None, the
//     component preselects the first ACTIVE type OF THE EVENT'S OWN KIND — never simply the
//     first type in the list — and reports that choice via `onChange` so the parent's form
//     state carries a concrete id from the first render.
//
// This file WILL FAIL to import until the developer implements EventTypePicker.tsx — expected
// in TDD, not a bug to fix here.

import { render, screen } from '@testing-library/react';
import { Option } from 'effect';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      event_type_training: 'Training',
      event_type_match: 'Match',
      event_type_tournament: 'Tournament',
      event_type_meeting: 'Meeting',
      event_type_social: 'Social',
      event_type_other: 'Other',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

// Radix's shadcn `Select` renders its content through a Portal and needs pointer-capture/
// scroll APIs jsdom does not implement. This repo already mocks the (also Portal-based)
// dropdown-menu primitive globally in test/setup.ts for the same reason — this file does the
// same for `ui/select`, locally, so the picker's OWN logic (which option is selected/disabled,
// what onChange receives) is what's under test, not Radix's positioning internals.
const SelectCtx = React.createContext<{ onValueChange?: (v: string) => void }>({});

vi.mock('~/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: React.PropsWithChildren<{
    value?: string;
    onValueChange?: (v: string) => void;
    disabled?: boolean;
  }>) => (
    <SelectCtx.Provider value={{ onValueChange }}>
      <div data-testid='select-root' data-value={value} data-disabled={String(!!disabled)}>
        {children}
      </div>
    </SelectCtx.Provider>
  ),
  SelectTrigger: ({ children }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div>{children}</div>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    value,
    disabled,
    children,
  }: React.PropsWithChildren<{ value: string; disabled?: boolean }>) => {
    const { onValueChange } = React.useContext(SelectCtx);
    return (
      <button
        type='button'
        role='option'
        data-value={value}
        disabled={disabled}
        aria-disabled={disabled}
        onClick={() => onValueChange?.(value)}
      >
        {children}
      </button>
    );
  },
}));

// Dynamic import AFTER mocks — will fail until EventTypePicker is implemented
const { EventTypePicker } = await import('~/components/molecules/EventTypePicker.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function activeType(overrides: Record<string, unknown> = {}) {
  return {
    eventTypeId: 'et-1',
    teamId: 'team-1',
    name: Option.none<string>(),
    kind: 'training',
    color: 'blue',
    position: 0,
    usageCount: 0,
    ...overrides,
  } as any;
}

const TRAINING_TYPE = activeType({
  eventTypeId: 'et-training',
  name: Option.some('Ranní tréninky'),
  kind: 'training',
  position: 0,
});

const MATCH_TYPE = activeType({
  eventTypeId: 'et-match',
  name: Option.none<string>(),
  kind: 'match',
  position: 1,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventTypePicker — B4: archived current type', () => {
  it('renders the archived type as a disabled option, still selected', () => {
    const onChange = vi.fn();

    render(
      <EventTypePicker
        eventTypes={[TRAINING_TYPE, MATCH_TYPE]}
        event={{
          eventType: 'training',
          eventTypeId: Option.some('et-archived' as any),
          eventTypeName: Option.some(Option.some('Old Friday Training')),
          eventTypeColor: Option.some('rose' as any),
        }}
        value={Option.some('et-archived' as any)}
        onChange={onChange}
      />,
    );

    const archivedOption = screen.getByRole('option', { name: 'Old Friday Training' });
    expect(archivedOption).toBeDisabled();

    // Still the current selection — a shadcn Select would otherwise fall back to its
    // placeholder, and a title-only edit would silently re-type the event.
    const root = screen.getByTestId('select-root');
    expect(root.getAttribute('data-value')).toBe('et-archived');
  });
});

describe('EventTypePicker — B3: unchanged submission', () => {
  it('does not call onChange on mount when value already names an active type', () => {
    const onChange = vi.fn();

    render(
      <EventTypePicker
        eventTypes={[TRAINING_TYPE, MATCH_TYPE]}
        event={{
          eventType: 'training',
          eventTypeId: Option.some('et-training' as any),
          eventTypeName: Option.some(Option.some('Ranní tréninky')),
          eventTypeColor: Option.some('blue' as any),
        }}
        value={Option.some('et-training' as any)}
        onChange={onChange}
      />,
    );

    // A title-only edit touches nothing here — whatever the parent already holds is what
    // gets submitted. The picker must not overwrite it.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('select-root').getAttribute('data-value')).toBe('et-training');
  });
});

describe('EventTypePicker — B4: no eventTypeId at all (old server)', () => {
  it('preselects the first ACTIVE type of the event’s own kind, never simply the first type in the list', () => {
    const onChange = vi.fn();

    render(
      <EventTypePicker
        // MATCH_TYPE is first in the list — the regression this guards against is
        // preselecting it just because it's array index 0.
        eventTypes={[MATCH_TYPE, TRAINING_TYPE]}
        event={{
          eventType: 'training',
          eventTypeId: Option.none(),
          eventTypeName: Option.none(),
          eventTypeColor: Option.none(),
        }}
        value={Option.none()}
        onChange={onChange}
      />,
    );

    expect(onChange).toHaveBeenCalledWith({ eventTypeId: 'et-training', kind: 'training' });
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ eventTypeId: 'et-match' }));
  });
});
