// Tests for `AssistantProposalCard` (plan `.work-plans/ai-app-interaction.md` §6.1, §7).
// The card renders a fixed, nine-field summary of one pending `AiChatApi.Proposal` and drives
// confirm/reject through `confirmProposal`/`rejectProposal`. It is an organism (Pattern A): it
// builds and runs its own Effect via `ApiClient.asEffect()` + `useRun()` and calls
// `router.invalidate()` on a successful confirm.
//
// Wire contract reminders (authoritative: `packages/domain/src/api/AiChatApi.ts`):
//   - `Proposal.summary` is ALWAYS all nine `ProposalFieldKey`s, in a fixed order — an action
//     that left a field unset still emits it as `{ type: 'none' }`, never omits the row.
//   - `ProposalFieldValue`'s discriminant is `type` (not `_tag` — that is reserved for tagged
//     errors and is the component's own LOCAL `CardState` union instead).
//   - `date` crosses as a bare `YYYY-MM-DD` string and must render VERBATIM, never parsed into
//     a `Date` (that would reintroduce a client-side off-by-one-day bug).
//
// As with `AssistantConversation.test.tsx`, `tr()` is mocked with an explicit, finite map —
// never a generic identity fallback — so a component that ever computes a key instead of going
// through one of the five `Record<...>` lookups documented in the plan would MISS this map and
// trip the "no raw key reaches the DOM" assertions below instead of being silently hidden.

import { AiChatApi, EventApi } from '@sideline/domain';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DateTime, Effect, Option } from 'effect';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

const TR_MAP: Record<string, string> = {
  // Field labels (proposalFieldLabels — nine keys, plan §6.1)
  event_title: 'Title label',
  event_eventType: 'Event type label',
  assistant_proposal_field_start: 'Starts label',
  assistant_proposal_field_end: 'Ends label',
  event_trainingType: 'Training type label',
  event_ownerGroup: 'Owner group label',
  event_memberGroup: 'Member group label',
  event_location: 'Location label',
  event_description: 'Description label',
  // Card chrome
  assistant_proposal_createEvent_title: 'Create this event?',
  assistant_proposal_createEvent_description: 'Nothing is created until you confirm.',
  assistant_proposal_createEvent_confirm: 'Create event',
  assistant_proposal_createEvent_confirmed: 'Event created.',
  assistant_proposal_reject: 'Discard',
  assistant_proposal_rejected: 'Discarded. Nothing was created.',
  assistant_proposal_working: 'Working…',
  assistant_proposal_expiresAt: 'Expires at some time',
  assistant_proposal_fieldNotSet: 'Not set',
  assistant_proposal_failedTitle: "I couldn't do that",
  assistant_proposal_expiredTitle: 'This suggestion expired',
  assistant_proposal_errorNotFound: 'Error copy: not found',
  assistant_proposal_errorAlreadyUsed: 'Error copy: already used',
  assistant_proposal_errorExpired: 'Error copy: expired',
  assistant_proposal_errorForbidden: 'Error copy: forbidden',
  assistant_proposal_errorGeneric: 'Error copy: generic',
  // Reused event-form / result-card copy
  event_allDayLabel: 'Full day',
  event_type_training: 'Practice',
  event_status_active: 'Confirmed',
  assistant_result_event: 'Event kind',
};

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => TR_MAP[key] ?? key,
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/hooks/use-mobile.js', () => ({
  useIsMobile: vi.fn(() => false),
}));

// Radix `Avatar.Image` never fires a load event in jsdom — mirrors
// `AssistantConversation.test.tsx` / `AssistantResultCard.test.tsx`'s documented workaround.
// Not exercised by the event-kind fixtures below, kept for consistency with the sibling tests.
vi.mock('~/components/ui/avatar', () => ({
  Avatar: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div data-slot='avatar' {...rest}>
      {children}
    </div>
  ),
  AvatarImage: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // biome-ignore lint/a11y/useAltText: alt is forwarded via {...props} from the real caller
    <img data-slot='avatar-image' {...props} />
  ),
  AvatarFallback: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <span data-slot='avatar-fallback' {...rest}>
      {children}
    </span>
  ),
}));

const { mockInvalidate } = vi.hoisted(() => ({ mockInvalidate: vi.fn() }));

// Self-contained (no captured outer variables — safe under vi.mock's hoisting): interpolates
// `params` into `to`'s `$param` placeholders, mirroring `AssistantConversation.test.tsx`.
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: mockInvalidate }),
  Link: ({
    to,
    params,
    children,
    ...rest
  }: React.PropsWithChildren<{ to: string; params?: Record<string, unknown> }>) => {
    const href = String(to).replace(/\$([a-zA-Z]+)/g, (whole: string, key: string) =>
      params && key in params ? String(params[key]) : whole,
    );
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

// `mockConfirm` / `mockReject` stand in for `api.aiChat.confirmProposal` / `rejectProposal`.
const { mockConfirm, mockReject } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockReject: vi.fn(),
}));

// A single, STABLE `run` reference that really executes the piped Effect via `Effect.option`
// (mirrors `AssistantConversation.test.tsx`'s `mockRun`) — so the component's own
// `Effect.catchCause`/`Effect.tap` chain runs for real, including the state-setting side effects
// that drive the busy/terminal branching.
const mockRun = () => (effect: Effect.Effect<unknown, unknown>) =>
  Effect.runPromise(Effect.option(effect));

vi.mock('~/lib/runtime', () => ({
  ApiClient: {
    asEffect: () =>
      Effect.succeed({ aiChat: { confirmProposal: mockConfirm, rejectProposal: mockReject } }),
  },
  ClientError: { make: (message: string) => ({ _tag: 'ClientError', message }) },
  SilentClientError: class SilentClientError {
    readonly _tag = 'SilentClientError';
    props: { message: string };
    constructor(props: { message: string }) {
      this.props = props;
    }
  },
  useRun: () => mockRun,
}));

// Dynamic import AFTER mocks — the component already exists (this suite verifies it).
const { AssistantProposalCard } = await import(
  '~/components/organisms/assistant/AssistantProposalCard.js'
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_ID = 'team-1';
const PROPOSAL_ID = '11111111-1111-4111-8111-111111111111';

const START_INSTANT = DateTime.makeUnsafe('2026-07-04T18:00:00.000Z');
const EXPIRES_AT = DateTime.makeUnsafe('2026-09-22T16:00:00.000Z');

function makeProposal(overrides: { summary?: AiChatApi.ProposalField[] } = {}) {
  const summary =
    overrides.summary ??
    [
      { key: 'title', value: { type: 'text', value: 'Thursday Practice' } },
      { key: 'eventType', value: { type: 'eventType', value: 'training' } },
      { key: 'start', value: { type: 'instant', value: START_INSTANT } },
      { key: 'end', value: { type: 'date', value: '2026-07-05' } },
      { key: 'trainingType', value: { type: 'text', value: 'U12 Skills' } },
      { key: 'ownerGroup', value: { type: 'text', value: 'Coaches' } },
      { key: 'memberGroup', value: { type: 'none' } },
      { key: 'location', value: { type: 'text', value: 'Main Hall' } },
      { key: 'description', value: { type: 'text', value: 'Bring water bottles.' } },
    ].map((f) => new AiChatApi.ProposalField(f as any));

  return new AiChatApi.Proposal({
    id: PROPOSAL_ID as any,
    action: 'create_event',
    summary,
    expiresAt: EXPIRES_AT,
  });
}

function makeConfirmedEvent(overrides: { title?: string } = {}) {
  return new EventApi.EventInfo({
    eventId: 'event-1' as any,
    teamId: TEAM_ID as any,
    title: overrides.title ?? 'Thursday Practice',
    eventType: 'training',
    trainingTypeName: Option.none<string>(),
    eventTypeId: Option.none(),
    eventTypeName: Option.none(),
    eventTypeColor: Option.none(),
    description: Option.none<string>(),
    imageUrl: Option.none<string>(),
    startAt: DateTime.makeUnsafe('2026-07-04T18:00:00.000Z'),
    endAt: Option.some(DateTime.makeUnsafe('2026-07-04T19:30:00.000Z')),
    location: Option.none<string>(),
    locationUrl: Option.none<string>(),
    status: 'active',
    allDay: false,
    seriesId: Option.none() as any,
    startDate: Option.none<string>(),
    endDate: Option.none<string>(),
  });
}

function renderCard(proposal = makeProposal()) {
  return render(<AssistantProposalCard proposal={proposal} teamId={TEAM_ID} />);
}

function getConfirmButton() {
  return screen.getByRole('button', {
    name: TR_MAP.assistant_proposal_createEvent_confirm,
  }) as HTMLButtonElement;
}

function getRejectButton() {
  return screen.getByRole('button', {
    name: TR_MAP.assistant_proposal_reject,
  }) as HTMLButtonElement;
}

const RAW_KEYS = [
  'assistant_proposal_field_start',
  'assistant_proposal_field_end',
  'event_title',
  'event_eventType',
  'event_trainingType',
  'event_ownerGroup',
  'event_memberGroup',
  'event_location',
  'event_description',
];

beforeEach(() => {
  mockConfirm.mockReset();
  mockReject.mockReset();
  mockInvalidate.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AssistantProposalCard', () => {
  describe('field summary (plan §6.1, §4)', () => {
    it('renders nine dt/dd pairs with labels resolved through the Record maps — no raw key reaches the DOM', () => {
      const { container } = renderCard();

      const dts = container.querySelectorAll('dt');
      const dds = container.querySelectorAll('dd');
      expect(dts).toHaveLength(9);
      expect(dds).toHaveLength(9);

      expect(screen.getByText(TR_MAP.event_title)).not.toBeNull();
      expect(screen.getByText(TR_MAP.event_eventType)).not.toBeNull();
      expect(screen.getByText(TR_MAP.assistant_proposal_field_start)).not.toBeNull();
      expect(screen.getByText(TR_MAP.assistant_proposal_field_end)).not.toBeNull();
      expect(screen.getByText(TR_MAP.event_trainingType)).not.toBeNull();
      expect(screen.getByText(TR_MAP.event_ownerGroup)).not.toBeNull();
      expect(screen.getByText(TR_MAP.event_memberGroup)).not.toBeNull();
      expect(screen.getByText(TR_MAP.event_location)).not.toBeNull();
      expect(screen.getByText(TR_MAP.event_description)).not.toBeNull();

      for (const rawKey of RAW_KEYS) {
        expect(container.textContent).not.toContain(rawKey);
      }
    });

    it('renders {type:"none"} as a visible "Not set" row, not an empty cell and not a missing row', () => {
      const { container } = renderCard();

      // memberGroup is the {type:'none'} field in the fixture — its row must still exist.
      const memberGroupLabel = screen.getByText(TR_MAP.event_memberGroup);
      const dt = memberGroupLabel.closest('dt');
      expect(dt).not.toBeNull();
      const dd = dt?.nextElementSibling;
      expect(dd?.tagName).toBe('DD');
      expect(dd?.textContent).toBe(TR_MAP.assistant_proposal_fieldNotSet);
      expect(dd?.textContent?.trim().length).toBeGreaterThan(0);

      expect(container.querySelectorAll('dt')).toHaveLength(9);
    });

    it('renders an instant field as a formatted time (not the raw ISO string)', () => {
      renderCard();

      const startLabel = screen.getByText(TR_MAP.assistant_proposal_field_start);
      const dd = startLabel.closest('dt')?.nextElementSibling;
      expect(dd).not.toBeNull();
      // Never the raw wire value.
      expect(dd?.textContent).not.toContain('2026-07-04T18:00:00.000Z');
      // A real, non-empty formatted rendering (locale-dependent, so assert shape, not string).
      expect(dd?.textContent?.trim().length).toBeGreaterThan(0);
    });

    it('renders a date field verbatim plus the all-day Badge, and no time component', () => {
      renderCard();

      const endLabel = screen.getByText(TR_MAP.assistant_proposal_field_end);
      const dd = endLabel.closest('dt')?.nextElementSibling;
      expect(dd).not.toBeNull();
      expect(dd?.textContent).toContain('2026-07-05');
      expect(dd?.textContent).toContain(TR_MAP.event_allDayLabel);
      // No time component anywhere in this cell (e.g. "18:00").
      expect(dd?.textContent).not.toMatch(/\d{1,2}:\d{2}/);
    });

    it('renders an eventType field through eventTypeLabels, not the raw literal', () => {
      renderCard();

      const eventTypeLabel = screen.getByText(TR_MAP.event_eventType);
      const dd = eventTypeLabel.closest('dt')?.nextElementSibling;
      expect(dd).not.toBeNull();
      expect(dd?.textContent).toBe(TR_MAP.event_type_training);
      expect(dd?.textContent).not.toBe('training');
    });
  });

  describe('focus order (plan §6.1: DOM order is Discard then Confirm)', () => {
    it('Confirm is the last focusable control', () => {
      renderCard();

      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(0);
      const last = buttons[buttons.length - 1];
      expect(last.textContent).toContain(TR_MAP.assistant_proposal_createEvent_confirm);
      // And Discard is first, never after Confirm.
      expect(buttons[0].textContent).toContain(TR_MAP.assistant_proposal_reject);
    });
  });

  describe('busy state', () => {
    it('disables both buttons and swaps only the pressed button label for the working copy', () => {
      mockConfirm.mockReturnValueOnce(Effect.never);
      renderCard();

      const confirmButton = getConfirmButton();
      const rejectButton = getRejectButton();
      fireEvent.click(confirmButton);

      // Re-query by name is wrong here (Confirm's accessible name just changed to the working
      // copy) — assert against the SAME DOM nodes captured above; React updates them in place.
      expect(confirmButton.disabled).toBe(true);
      expect(rejectButton.disabled).toBe(true);
      expect(confirmButton.textContent).toContain(TR_MAP.assistant_proposal_working);
      // The untouched button keeps its normal label, not the working copy.
      expect(rejectButton.textContent).toContain(TR_MAP.assistant_proposal_reject);
      expect(rejectButton.textContent).not.toContain(TR_MAP.assistant_proposal_working);
    });

    it('swaps only Reject label when Reject is the pressed button', () => {
      mockReject.mockReturnValueOnce(Effect.never);
      renderCard();

      const confirmButton = getConfirmButton();
      const rejectButton = getRejectButton();
      fireEvent.click(rejectButton);

      expect(rejectButton.disabled).toBe(true);
      expect(confirmButton.disabled).toBe(true);
      expect(rejectButton.textContent).toContain(TR_MAP.assistant_proposal_working);
      expect(confirmButton.textContent).toContain(TR_MAP.assistant_proposal_createEvent_confirm);
      expect(confirmButton.textContent).not.toContain(TR_MAP.assistant_proposal_working);
    });
  });

  describe('failure reasons (plan §6.1 terminal states table)', () => {
    const cases: Array<{
      name: string;
      error: unknown;
      messageKey: string;
      hidesFieldList: boolean;
      keepsConfirm: boolean;
    }> = [
      {
        name: 'notFound',
        error: new AiChatApi.AiProposalNotFound(),
        messageKey: 'assistant_proposal_errorNotFound',
        hidesFieldList: false,
        keepsConfirm: false,
      },
      {
        name: 'alreadyUsed',
        error: new AiChatApi.AiProposalAlreadyUsed(),
        messageKey: 'assistant_proposal_errorAlreadyUsed',
        hidesFieldList: true,
        keepsConfirm: false,
      },
      {
        name: 'expired',
        error: new AiChatApi.AiProposalExpired(),
        messageKey: 'assistant_proposal_errorExpired',
        hidesFieldList: false,
        keepsConfirm: false,
      },
      {
        name: 'forbidden',
        error: new AiChatApi.AiProposalActionForbidden(),
        messageKey: 'assistant_proposal_errorForbidden',
        hidesFieldList: false,
        keepsConfirm: false,
      },
      {
        name: 'generic',
        error: new Error('boom'),
        messageKey: 'assistant_proposal_errorGeneric',
        hidesFieldList: false,
        keepsConfirm: true,
      },
    ];

    for (const testCase of cases) {
      it(`renders its own distinct message for ${testCase.name}, ${
        testCase.hidesFieldList ? 'hides' : 'keeps'
      } the field list, and ${testCase.keepsConfirm ? 'keeps' : 'removes'} the Confirm button`, async () => {
        mockConfirm.mockReturnValueOnce(Effect.fail(testCase.error));
        const { container } = renderCard();

        fireEvent.click(getConfirmButton());

        await waitFor(() => {
          expect(screen.getByText(TR_MAP[testCase.messageKey])).not.toBeNull();
        });

        // Distinct message per reason: every OTHER reason's copy must be absent.
        for (const other of cases) {
          if (other.name === testCase.name) continue;
          expect(screen.queryByText(TR_MAP[other.messageKey])).toBeNull();
        }

        const dts = container.querySelectorAll('dt');
        if (testCase.hidesFieldList) {
          expect(dts).toHaveLength(0);
        } else {
          expect(dts).toHaveLength(9);
        }

        const buttons = screen.queryAllByRole('button');
        if (testCase.keepsConfirm) {
          expect(buttons).toHaveLength(2);
          expect(getConfirmButton().disabled).toBe(false);
        } else {
          expect(buttons).toHaveLength(0);
        }
      });
    }
  });

  describe('confirmed (plan §6.1 terminal states table)', () => {
    it('renders the success alert and an AssistantResultCard, and calls router.invalidate() once', async () => {
      const event = makeConfirmedEvent({ title: 'Thursday Practice' });
      mockConfirm.mockReturnValueOnce(Effect.succeed(event));
      renderCard();

      fireEvent.click(getConfirmButton());

      await waitFor(() => {
        expect(screen.getByText(TR_MAP.assistant_proposal_createEvent_confirmed)).not.toBeNull();
      });

      const link = screen.getByRole('link');
      expect(link.textContent).toContain('Thursday Practice');

      expect(mockInvalidate).toHaveBeenCalledTimes(1);
      // No buttons remain once confirmed.
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });
  });

  describe('focus management (plan §6.1 a11y)', () => {
    it('does not move focus on mount', () => {
      renderCard();
      expect(document.activeElement).toBe(document.body);
    });

    it('moves focus to the terminal container on a terminal transition', async () => {
      mockReject.mockReturnValueOnce(Effect.succeed(undefined));
      const { container } = renderCard();

      fireEvent.click(getRejectButton());

      await waitFor(() => {
        expect(screen.getByText(TR_MAP.assistant_proposal_rejected)).not.toBeNull();
      });

      const terminalContainer = container.querySelector('[tabindex="-1"]');
      expect(terminalContainer).not.toBeNull();
      expect(document.activeElement).toBe(terminalContainer);
    });
  });
});
