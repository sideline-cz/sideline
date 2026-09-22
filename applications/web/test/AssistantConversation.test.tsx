// Written under TDD, ahead of `AssistantConversation` (both now ship).
// Plan `.work-plans/ai-app-interaction.md` §13.10, design §2 (chat surface) / §5 (a11y).
//
// `AssistantConversation` owns the `turns` state, calls `useRun()` to POST
// `/teams/:teamId/ai/chat` (Pattern A, design §2.9), optimistically appends the user's own
// message, renders the answer (with inline `[[ref:<token>]]` resolution + uncited references
// as cards), the degraded notice (`generated: false`), and turn failures (403 / 429 / generic).
//
// NOTE on the wire contract (authoritative: `packages/domain/src/api/AiChatApi.ts`):
//   - `ChatResponse` is `{ answer, generated, degradedReason, references }` — no `usedTools`,
//     no streaming.
//   - `EntityRef`'s common field is `ref` (a 4-char `RefToken`), NOT `token` — the design doc's
//     §3.2 prose is stale on this point.
//   - The marker grammar is strict: `/\[\[ref:([a-z0-9]{4})\]\]/g` (4 lowercase-alphanumeric).
//   - `degradedReason` is the closed union `not_configured | disabled | provider_error |
//     too_many_steps | empty_answer`.
//
// Real copy now ships in `packages/i18n/messages/*.json`, but `tr()` here is still mocked with
// an explicit, finite map (never a generic "return the key" identity function):
// this is deliberate, not a convenience shortcut. If the component under test ever computes a
// key (e.g. a template literal over `degradedReason`/`reason` instead of the mandated explicit
// `Record<..., () => string>` lookup — see design §7 "No computed keys"), that computed key will
// MISS this map, fall through to the raw-key fallback, and trip the "no raw `assistant_` key
// leaks into the DOM" assertion in the degraded-turn test below. A blanket identity mock would
// silently hide exactly the regression that test exists to catch.

import { AiChatApi, EventApi } from '@sideline/domain';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DateTime, Effect, Option } from 'effect';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

const TR_MAP: Record<string, string> = {
  assistant_composer_label: 'Message the assistant',
  assistant_composer_placeholder: 'Ask a question',
  assistant_composer_send: 'Send',
  assistant_composer_hintDesktop: 'Enter to send',
  assistant_composer_hintMobile: 'Tap send',
  assistant_composer_tooLong: 'Message too long',
  assistant_logLabel: 'Conversation log',
  assistant_youLabel: 'You',
  assistant_assistantLabel: 'Bot',
  assistant_thinking: 'Working on it',
  assistant_historyTrimmed: 'Earlier messages omitted',
  assistant_degraded_title: 'Incomplete reply',
  assistant_degraded_notConfigured: 'Setup missing copy',
  assistant_degraded_disabled: 'Switched off copy',
  assistant_degraded_providerError: 'Provider trouble copy',
  assistant_degraded_tooManySteps: 'Too many steps copy',
  assistant_degraded_emptyAnswer: 'No content copy',
  assistant_turnFailedTitle: 'Reply failed',
  assistant_turnFailedGeneric: 'Generic failure copy',
  assistant_turnFailedRateLimited: 'Rate limited copy',
  assistant_turnFailedForbidden: 'No access copy',
  assistant_turnFailedRetryIn: 'Retry countdown copy',
  assistant_results_label: 'Matching results',
  assistant_results_showMore: 'Reveal remaining results',
  assistant_result_event: 'Event kind',
  assistant_result_member: 'Member kind',
  assistant_result_group: 'Group kind',
  assistant_result_roster: 'Roster kind',
  assistant_result_trainingType: 'Training type kind',
  assistant_empty_title: 'Ask something',
  assistant_empty_body: 'Try a question',
  assistant_empty_suggestionsLabel: 'Examples',
  assistant_suggestion_rsvp: 'Suggestion one',
  assistant_suggestion_filter: 'Suggestion two',
  assistant_suggestion_attendance: 'Suggestion three',
  assistant_suggestion_aggregate: 'Suggestion four',
  assistant_navTitle: 'Copilot',
  assistant_pageSubtitle: 'Ask about your team',
  assistant_newChat: 'Start over',
  assistant_newChatConfirmTitle: 'Clear the conversation?',
  assistant_newChatConfirmDescription: 'This cannot be undone',
  assistant_newChatConfirmAction: 'Clear',
  common_retry: 'Try again',
  common_cancel: 'Dismiss',
  common_listSeparator: ', ',
  group_memberCount: 'members count copy',
  roster_memberCount: 'roster members count copy',
  roster_active: 'On roster',
  roster_inactive: 'Off roster',
  trainingType_noGroup: 'Everyone',
  event_allDayLabel: 'Full day',
  event_status_active: 'Confirmed',
  event_status_cancelled: 'Called off',
  event_status_started: 'Underway',
  event_type_training: 'Practice',
  event_type_match: 'Match day',
  event_type_tournament: 'Tournament',
  event_type_meeting: 'Meeting',
  event_type_social: 'Social',
  event_type_other: 'Other',
  validation_required: 'Required field',
  members_ratingDescCounter: 'counter copy',
};

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => TR_MAP[key] ?? key,
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/hooks/use-mobile.js', () => ({
  useIsMobile: vi.fn(() => false),
}));

// Radix `Avatar.Image` never fires a load event in jsdom — mirrors
// `MemberSummaryHeader.test.tsx` / `AssistantResultCard.test.tsx`'s workaround. A member
// reference is unlikely in these fixtures but this keeps the mock surface consistent should one
// appear via a future edit.
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

// Self-contained (no captured outer variables — safe under vi.mock's hoisting): interpolates
// `params` into `to`'s `$param` placeholders so `<a href>` reflects the real resolved route.
vi.mock('@tanstack/react-router', () => ({
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

// `mockChat` stands in for the generated client's `api.aiChat.chat(...)` — the one call this
// organism makes (design §2.9, Pattern A: the organism builds and runs its own Effect via
// `ApiClient.asEffect()` + `useRun()`, exactly like `RatingFromDescription.tsx`).
const { mockChat } = vi.hoisted(() => ({ mockChat: vi.fn() }));

// A single, STABLE `run` reference that really executes the piped Effect via `Effect.option`
// (mirrors `runPromiseClient`'s shape minus the toast side effects) — so whatever
// `Effect.catchTag`/`Effect.tap` the component chains BEFORE handing off to `run()` runs for
// real, including any state-setting side effects that drive the 403/429/generic branching.
// Precedent: `applications/web/src/components/organisms/RulesTrainer.test.tsx`.
const mockRun = () => (effect: Effect.Effect<unknown, unknown>) =>
  Effect.runPromise(Effect.option(effect));

vi.mock('~/lib/runtime', () => ({
  ApiClient: { asEffect: () => Effect.succeed({ aiChat: { chat: mockChat } }) },
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

// Dynamic import AFTER mocks — will fail until AssistantConversation is created & exported
const { AssistantConversation } = await import(
  '~/components/organisms/assistant/AssistantConversation.js'
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_ID = 'team-1';

let refCounter = 0;
// 4-char lowercase-alphanumeric — the RefToken alphabet.
const nextRef = () => String(refCounter++).padStart(4, '0');

function makeEventRef(overrides: { title?: string; ref?: string } = {}) {
  const ref = overrides.ref ?? nextRef();
  return {
    kind: 'event' as const,
    ref,
    // A REAL `EventApi.EventInfo` instance, not a structurally-similar plain object: the
    // domain's `Schema.Class` constructors validate nested `Schema.Class` fields (here,
    // `AiChatApi.ChatResponse` -> `EntityRef` -> `event: EventApi.EventInfo`) against the
    // actual class, not just field shape — `new AiChatApi.ChatResponse({ references: [{...,
    // event: {...plainObject} }] })` throws "Expected EventInfo, got {...}" otherwise. This
    // mirrors production reality anyway: the real `api.aiChat.chat(...)` call decodes the wire
    // body through this same schema, so a genuine `EntityRef.event` is always a real instance.
    event: new EventApi.EventInfo({
      eventId: `event-${ref}` as any,
      teamId: TEAM_ID as any,
      title: overrides.title ?? `Event ${ref}`,
      eventType: 'training',
      trainingTypeName: Option.none<string>(),
      eventTypeId: Option.none() as any,
      eventTypeName: Option.none<Option.Option<string>>(),
      eventTypeColor: Option.none() as any,
      description: Option.none<string>(),
      imageUrl: Option.none<string>(),
      startAt: DateTime.makeUnsafe('2026-05-12T18:00:00.000Z'),
      endAt: Option.some(DateTime.makeUnsafe('2026-05-12T19:30:00.000Z')),
      location: Option.none<string>(),
      locationUrl: Option.none<string>(),
      status: 'active',
      allDay: false,
      seriesId: Option.none() as any,
      startDate: Option.none<string>(),
      endDate: Option.none<string>(),
    }),
  };
}

function respond(overrides: Partial<AiChatApi.ChatResponse> = {}) {
  return new AiChatApi.ChatResponse({
    answer: 'ok',
    generated: true,
    degradedReason: Option.none(),
    references: [],
    ...overrides,
  } as any);
}

function renderConversation(props: { pendingQuestion?: { text: string; id: number } } = {}) {
  return render(<AssistantConversation teamId={TEAM_ID} pendingQuestion={props.pendingQuestion} />);
}

function getTextarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

function getSendButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: TR_MAP.assistant_composer_send }) as HTMLButtonElement;
}

function submitMessage(text: string) {
  const textarea = getTextarea();
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.click(getSendButton());
}

beforeEach(() => {
  mockChat.mockReset();
  refCounter = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AssistantConversation', () => {
  describe('submit flow (13.10/1)', () => {
    it('appends the user message immediately, then renders the answer once the request resolves', async () => {
      mockChat.mockReturnValueOnce(Effect.succeed(respond({ answer: 'Practice is at 6pm.' })));

      renderConversation();
      submitMessage('When is practice?');

      // Optimistic append: visible before the (already-mocked, but still async) response lands.
      expect(screen.getByText('When is practice?')).not.toBeNull();

      await waitFor(() => {
        expect(screen.getByText('Practice is at 6pm.')).not.toBeNull();
      });
    });
  });

  describe('result list (13.10/2, 13.10/3)', () => {
    it('renders no result list / links when references is empty', async () => {
      mockChat.mockReturnValueOnce(
        Effect.succeed(respond({ answer: 'Nothing to show.', references: [] })),
      );
      renderConversation();
      submitMessage('anything');

      await waitFor(() => {
        expect(screen.getByText('Nothing to show.')).not.toBeNull();
      });
      expect(screen.queryAllByRole('link')).toHaveLength(0);
    });

    it('renders exactly 3 cards for 3 uncited references', async () => {
      const refs = [makeEventRef(), makeEventRef(), makeEventRef()];
      mockChat.mockReturnValueOnce(
        Effect.succeed(respond({ answer: 'Here are three.', references: refs as any })),
      );
      renderConversation();
      submitMessage('list three');

      await waitFor(() => {
        expect(screen.getAllByRole('link')).toHaveLength(3);
      });
    });

    it('caps at 5 visible cards for 8 uncited references, with a "show more" control that reveals the rest', async () => {
      const refs = Array.from({ length: 8 }, () => makeEventRef());
      mockChat.mockReturnValueOnce(
        Effect.succeed(respond({ answer: 'Here are eight.', references: refs as any })),
      );
      renderConversation();
      submitMessage('list eight');

      await waitFor(() => {
        expect(screen.getByText('Here are eight.')).not.toBeNull();
      });
      expect(screen.getAllByRole('link')).toHaveLength(5);

      const showMore = screen.getByRole('button', { name: TR_MAP.assistant_results_showMore });
      fireEvent.click(showMore);

      await waitFor(() => {
        expect(screen.getAllByRole('link')).toHaveLength(8);
      });
    });
  });

  describe('inline reference resolution (13.10/4, 13.10/5)', () => {
    it('resolves a [[ref:<token>]] marker to an inline link labelled with the entity data, not the raw marker — and does not repeat it as a card', async () => {
      const ref = makeEventRef({ title: 'Thursday training' });
      mockChat.mockReturnValueOnce(
        Effect.succeed(
          respond({
            answer: `Thursday's training is at [[ref:${ref.ref}]].`,
            references: [ref as any],
          }),
        ),
      );
      const { container } = renderConversation();
      submitMessage('when is Thursday training');

      await waitFor(() => {
        expect(container.textContent).toContain('Thursday training');
      });
      expect(container.textContent).not.toContain('[[ref:');
      // Cited — must render inline, not ALSO as a card (design §3.5 rule #2).
      expect(screen.getAllByRole('link')).toHaveLength(1);
    });

    it('drops an unresolvable marker silently — no link, no raw syntax, no crash — while the actual (uncited) reference still renders as a card', async () => {
      const known = makeEventRef({ title: 'Known Event', ref: '7f3a' });
      mockChat.mockReturnValueOnce(
        Effect.succeed(
          respond({
            answer: 'a [[ref:zzzz]] b',
            references: [known as any],
          }),
        ),
      );
      const { container } = renderConversation();
      submitMessage('stale marker case');

      await waitFor(() => {
        expect(container.textContent).toContain('Known Event');
      });
      expect(container.textContent).not.toContain('[[ref:');
      expect(screen.getAllByRole('link')).toHaveLength(1);
    });
  });

  describe('prose is never interpreted as markup', () => {
    it('renders markdown- and HTML-looking characters in the answer as literal text', async () => {
      const weird = '<script>alert(1)</script> **bold** _em_ # heading <b>x</b>';
      mockChat.mockReturnValueOnce(Effect.succeed(respond({ answer: weird })));
      const { container } = renderConversation();
      submitMessage('show me markup-ish text');

      await waitFor(() => {
        expect(container.textContent).toContain(weird);
      });
      // No actual <script> element was created by rendering the answer text.
      expect(container.querySelector('script')).toBeNull();
    });
  });

  describe('degraded turn (13.10/6)', () => {
    it('renders the degraded notice from the explicit degradedReason lookup, and no raw assistant_ key ever appears in the DOM', async () => {
      mockChat.mockReturnValueOnce(
        Effect.succeed(
          respond({ answer: '', generated: false, degradedReason: Option.some('provider_error') }),
        ),
      );
      const { container } = renderConversation();
      submitMessage('anything');

      await waitFor(() => {
        expect(screen.getByText(TR_MAP.assistant_degraded_providerError)).not.toBeNull();
      });
      expect(container.textContent).not.toMatch(/assistant_/);
    });

    it('is not styled as an error (no role="alert" with destructive-only signalling) and still renders references', async () => {
      const ref = makeEventRef({ title: 'Still Useful Event' });
      mockChat.mockReturnValueOnce(
        Effect.succeed(
          respond({
            answer: '',
            generated: false,
            degradedReason: Option.some('too_many_steps'),
            references: [ref as any],
          }),
        ),
      );
      const { container } = renderConversation();
      submitMessage('complex question');

      await waitFor(() => {
        expect(screen.getByText(TR_MAP.assistant_degraded_tooManySteps)).not.toBeNull();
      });
      expect(container.textContent).toContain('Still Useful Event');
    });
  });

  describe('request payload shape (13.10/7)', () => {
    it('never sends role: "tool" or role: "system" in the request', async () => {
      mockChat.mockReturnValueOnce(Effect.succeed(respond({ answer: 'ok' })));
      renderConversation();
      submitMessage('hello there');

      await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));
      const call = mockChat.mock.calls[0]?.[0];
      const messages = call?.payload?.messages ?? call?.messages;
      expect(Array.isArray(messages)).toBe(true);
      expect(messages.length).toBeGreaterThan(0);
      for (const m of messages) {
        expect(m.role === 'user' || m.role === 'assistant').toBe(true);
      }
    });
  });

  describe('history budgeting (13.10/8)', () => {
    it('shapes the outgoing payload through buildHistory (char-budget-bound, newest-first, whole messages only) and renders the trimmed divider once a message is dropped', async () => {
      const { buildHistory } = await import('~/lib/assistant/history.js');

      // `${marker}-` is 3 chars; repeating 700x (2100 chars) then slicing guarantees exactly
      // 2000 chars regardless of marker, while keeping the marker visible for debugging.
      const long = (marker: string) => `${marker}-`.repeat(700).slice(0, 2000);

      const u1 = long('u1');
      const a1 = long('a1');
      const u2 = long('u2');
      const a2 = long('a2');
      const u3 = long('u3');

      mockChat.mockReturnValueOnce(Effect.succeed(respond({ answer: a1 })));
      renderConversation();
      submitMessage(u1);
      await waitFor(() => expect(screen.getByText(a1)).not.toBeNull());

      mockChat.mockReturnValueOnce(Effect.succeed(respond({ answer: a2 })));
      submitMessage(u2);
      await waitFor(() => expect(screen.getByText(a2)).not.toBeNull());

      mockChat.mockReturnValueOnce(Effect.succeed(respond({ answer: 'ack' })));
      submitMessage(u3);
      await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(3));

      const turnsAtRequestTime = [
        { role: 'user' as const, content: u1 },
        { role: 'assistant' as const, content: a1 },
        { role: 'user' as const, content: u2 },
        { role: 'assistant' as const, content: a2 },
        { role: 'user' as const, content: u3 },
      ];
      const expected = buildHistory(turnsAtRequestTime);
      // Sanity on the fixture itself: the char budget must actually bind here (this is what
      // makes the test meaningful — otherwise it would pass even if buildHistory were never
      // called at all).
      expect(expected.droppedCount).toBeGreaterThan(0);

      const call = mockChat.mock.calls[2]?.[0];
      const sentMessages = (call?.payload?.messages ?? call?.messages ?? []).map((m: any) => ({
        role: m.role,
        content: m.content,
      }));
      expect(sentMessages).toEqual(expected.messages);
      // The newest user message is always present, whole (never sliced).
      expect(sentMessages.at(-1)).toEqual({ role: 'user', content: u3 });
      for (const m of sentMessages) {
        expect([u1, a1, u2, a2, u3]).toContain(m.content);
      }

      await waitFor(() => {
        expect(screen.getByText(TR_MAP.assistant_historyTrimmed)).not.toBeNull();
      });
    });
  });

  describe('composer length limit (13.10/9)', () => {
    it('cannot submit a message over 2000 characters', async () => {
      renderConversation();
      const textarea = getTextarea();
      expect(textarea.maxLength).toBe(2000);

      fireEvent.change(textarea, { target: { value: 'x'.repeat(2001) } });
      const sendButton = getSendButton();
      expect(sendButton.disabled).toBe(true);

      fireEvent.click(sendButton);
      expect(mockChat).not.toHaveBeenCalled();
    });
  });

  describe('turn failures — 403 (13.10 general error handling)', () => {
    it('renders a forbidden state with NO retry button', async () => {
      mockChat.mockReturnValueOnce(Effect.fail(new AiChatApi.AiChatForbidden({})));
      const { container } = renderConversation();
      submitMessage('anything');

      await waitFor(() => {
        expect(screen.getByText(TR_MAP.assistant_turnFailedForbidden)).not.toBeNull();
      });
      expect(screen.queryAllByRole('button', { name: TR_MAP.common_retry })).toHaveLength(0);
      expect(
        screen.queryAllByRole('button', { name: TR_MAP.assistant_turnFailedRetryIn }),
      ).toHaveLength(0);
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.querySelector('button')).toBeNull();
    });
  });

  describe('turn failures — 429', () => {
    it('renders a retry button disabled for retryAfterSeconds', async () => {
      mockChat.mockReturnValueOnce(
        Effect.fail(new AiChatApi.AiChatRateLimited({ retryAfterSeconds: 30 })),
      );
      renderConversation();
      submitMessage('anything');

      await waitFor(() => {
        expect(screen.getByText(TR_MAP.assistant_turnFailedRateLimited)).not.toBeNull();
      });
      const retryButton = screen.getByRole('button', {
        name: TR_MAP.assistant_turnFailedRetryIn,
      }) as HTMLButtonElement;
      expect(retryButton.disabled).toBe(true);
    });
  });

  describe('turn failures — generic transport error', () => {
    it('renders the generic failure copy with an immediately-enabled retry', async () => {
      mockChat.mockReturnValueOnce(Effect.fail(new Error('network down')));
      renderConversation();
      submitMessage('anything');

      await waitFor(() => {
        expect(screen.getByText(TR_MAP.assistant_turnFailedGeneric)).not.toBeNull();
      });
      const retryButton = screen.getByRole('button', {
        name: TR_MAP.common_retry,
      }) as HTMLButtonElement;
      expect(retryButton.disabled).toBe(false);
    });
  });

  describe('accessibility (design §5)', () => {
    it('has exactly one live region for the whole conversation, and no nested aria-live regions', async () => {
      mockChat.mockReturnValueOnce(Effect.succeed(respond({ answer: 'ok' })));
      const { container } = renderConversation();
      submitMessage('hello');

      await waitFor(() => {
        expect(screen.getByText('ok')).not.toBeNull();
      });

      const logs = container.querySelectorAll('[role="log"]');
      expect(logs).toHaveLength(1);
      expect(logs[0]?.getAttribute('aria-live')).toBe('polite');
      // No element inside the log carries its OWN explicit aria-live — role="alert" (the
      // implicit live-region role on turn failures / the degraded notice, design §5) is a
      // sanctioned exception to this rule, not a violation of it. The thinking indicator carries
      // no live-region role of its own: the parent `log` already covers its addition, and a
      // nested role="status" would double-announce it.
      expect(logs[0]?.querySelectorAll('[aria-live]')).toHaveLength(0);
    });

    it('the log container itself is not a tab stop', () => {
      const { container } = renderConversation();
      const log = container.querySelector('[role="log"]');
      expect(log).not.toBeNull();
      expect(log?.getAttribute('tabindex')).not.toBe('0');
    });
  });

  // F.8 (design §6.3, plan §13.10 hand-off addendum): a `pendingQuestion={ text, id }` prop
  // auto-sends once per id, guarded by a ref set BEFORE the async call (not by the dependency
  // array — `handleSend`'s identity changes with `turns`, so the effect legitimately re-runs on
  // every turn; the ref, not the deps, is what makes it fire once).
  describe('pendingQuestion auto-send (F.8)', () => {
    it('sends the pending question exactly once on mount, as a real ChatMessage', async () => {
      mockChat.mockReturnValueOnce(Effect.succeed(respond({ answer: 'Auto reply.' })));
      renderConversation({ pendingQuestion: { text: 'hi', id: 1 } });

      await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));
      const call = mockChat.mock.calls[0]?.[0];
      const messages = call?.payload?.messages ?? call?.messages;
      expect(messages[0]).toBeInstanceOf(AiChatApi.ChatMessage);
      expect(messages.at(-1)?.content).toBe('hi');

      await waitFor(() => expect(screen.getByText('Auto reply.')).not.toBeNull());
      // Still exactly one call once the exchange has fully settled.
      expect(mockChat).toHaveBeenCalledTimes(1);
    });

    it('does not resend on a re-render with the same object, nor with a new equal-valued one', async () => {
      mockChat.mockReturnValueOnce(Effect.succeed(respond({ answer: 'Auto reply.' })));
      const pendingQuestion = { text: 'hi', id: 1 };
      const { rerender } = renderConversation({ pendingQuestion });
      await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));

      rerender(<AssistantConversation teamId={TEAM_ID} pendingQuestion={pendingQuestion} />);
      rerender(<AssistantConversation teamId={TEAM_ID} pendingQuestion={{ text: 'hi', id: 1 }} />);

      expect(mockChat).toHaveBeenCalledTimes(1);
    });

    it('does not resend when an unrelated render changes handleSend identity (a manual second submit)', async () => {
      mockChat.mockReturnValueOnce(Effect.succeed(respond({ answer: 'Auto reply.' })));
      renderConversation({ pendingQuestion: { text: 'hi', id: 1 } });
      await waitFor(() => expect(screen.getByText('Auto reply.')).not.toBeNull());

      mockChat.mockReturnValueOnce(Effect.succeed(respond({ answer: 'Second reply.' })));
      submitMessage('manual follow-up');

      await waitFor(() => expect(screen.getByText('Second reply.')).not.toBeNull());
      // One auto-send + one manual send — not a third from the auto-send effect re-firing.
      expect(mockChat).toHaveBeenCalledTimes(2);
    });

    it('sends again for a new, higher id — even asking the identical text (repeat-the-question case)', async () => {
      mockChat.mockReturnValueOnce(Effect.succeed(respond({ answer: 'First.' })));
      const { rerender } = renderConversation({ pendingQuestion: { text: 'hi', id: 1 } });
      await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));

      mockChat.mockReturnValueOnce(Effect.succeed(respond({ answer: 'Second.' })));
      rerender(<AssistantConversation teamId={TEAM_ID} pendingQuestion={{ text: 'hi', id: 2 }} />);

      await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(2));
      const secondCall = mockChat.mock.calls[1]?.[0];
      const secondMessages = secondCall?.payload?.messages ?? secondCall?.messages;
      expect(secondMessages.at(-1)?.content).toBe('hi');
    });

    it('does not send when pendingQuestion is undefined', async () => {
      renderConversation({ pendingQuestion: undefined });
      // Give any stray effect a tick to fire before asserting the negative.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockChat).not.toHaveBeenCalled();
    });
  });

  // The blocker: `new AiChatApi.ChatMessage(...)` is a validating constructor — over 2000 chars
  // throws `Expected a value with a length of at most 2000`, and `''` throws too (isMinLength(1)).
  // `toChatMessages` at `AssistantConversation.tsx:191` runs BEFORE `setSubmitting(true)` and
  // OUTSIDE the `try` at `:246`, so an unclamped auto-send throws synchronously after the
  // optimistic user bubble is already committed: no error turn, no request, no toast — the page
  // just sits there permanently. `pendingQuestion` bypasses the composer's own `maxLength`/disabled
  // guard entirely (13.10/9 only protects manual typing), so this path must defend itself.
  describe('pendingQuestion clamp (blocker fix)', () => {
    it('clamps a 3000-character pending question to 2000 characters and still sends it', async () => {
      mockChat.mockReturnValueOnce(Effect.succeed(respond({ answer: 'Clamped reply.' })));
      const longText = 'x'.repeat(3000);
      renderConversation({ pendingQuestion: { text: longText, id: 1 } });

      await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));
      const call = mockChat.mock.calls[0]?.[0];
      const messages = call?.payload?.messages ?? call?.messages;
      const sent = messages.at(-1);
      expect(sent).toBeInstanceOf(AiChatApi.ChatMessage);
      expect(sent.content).toHaveLength(2000);
      expect(sent.content).toBe('x'.repeat(2000));

      // The reply actually lands — the page is not stuck showing only the user's own bubble,
      // which is exactly the silent failure mode this test exists to rule out.
      await waitFor(() => expect(screen.getByText('Clamped reply.')).not.toBeNull());
    });

    it('does not send an empty pending question, and does not throw', async () => {
      renderConversation({ pendingQuestion: { text: '', id: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockChat).not.toHaveBeenCalled();
      // No user bubble was committed either — the empty-state placeholder is still showing.
      expect(screen.getByText(TR_MAP.assistant_empty_title)).not.toBeNull();
    });

    it('does not send a whitespace-only pending question, and does not throw', async () => {
      renderConversation({ pendingQuestion: { text: '   ', id: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockChat).not.toHaveBeenCalled();
      expect(screen.getByText(TR_MAP.assistant_empty_title)).not.toBeNull();
    });
  });
});
