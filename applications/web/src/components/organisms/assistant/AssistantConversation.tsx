/**
 * Owns the conversation's `turns` state, the `role='log'` region, the composer, retry/New-chat
 * flows and the client-side history budget (design §2, §6). Pattern A (design §2.9): this
 * organism builds and runs its own Effect via `ApiClient.asEffect()` + `useRun()`; it takes no
 * router hooks and brands `teamId` itself.
 *
 * **Ambiguity resolution (design §2.1 vs §6):** the "New chat" trigger is owned and rendered by
 * THIS organism, not `AssistantPage` — only `AssistantConversation` holds `turns` state, so only
 * it knows whether the button should show at all (`turns.length > 0`). `AssistantPage` keeps the
 * page-level `h1`/subtitle; this component renders everything below that (its own header row for
 * the New-chat trigger, the log, the composer, and the always-mounted New-chat `AlertDialog`).
 *
 * `AssistantThinkingIndicator`, `AssistantDegradedNotice` and `AssistantUserMessage` are inlined
 * here per design §6 (each under ~20 lines of static JSX, no independent reuse).
 */
import { type AiChatApi, Team } from '@sideline/domain';
import { Cause, Effect, Option, Schema } from 'effect';
import { Info, Loader2, RotateCcw, Sparkles } from 'lucide-react';
import React from 'react';
import { AssistantAnswer } from '~/components/molecules/assistant/AssistantAnswer.js';
import { AssistantEmptyState } from '~/components/molecules/assistant/AssistantEmptyState.js';
import { AssistantResultList } from '~/components/molecules/assistant/AssistantResultList.js';
import {
  AssistantTurnError,
  type AssistantTurnErrorReason,
  turnErrorMessages,
} from '~/components/molecules/assistant/AssistantTurnError.js';
import { AssistantComposer } from '~/components/organisms/assistant/AssistantComposer.js';
import { AssistantProposalCard } from '~/components/organisms/assistant/AssistantProposalCard.js';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog.js';
import { Button } from '~/components/ui/button.js';
import { Separator } from '~/components/ui/separator.js';
import { useFormatDate } from '~/hooks/useFormatDate.js';
import { toChatMessages } from '~/lib/assistant/chatMessages.js';
import { degradedReasonLabels } from '~/lib/assistant/entityRoutes.js';
import { buildHistory, type HistoryTurn } from '~/lib/assistant/history.js';
import { parseAnswer } from '~/lib/assistant/parseAnswer.js';
import { ApiClient, SilentClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface UserTurn {
  readonly id: string;
  readonly role: 'user';
  readonly content: string;
  readonly at: Date;
}

interface AssistantTurnData {
  readonly id: string;
  readonly role: 'assistant';
  readonly content: string;
  readonly references: ReadonlyArray<AiChatApi.EntityRef>;
  readonly degradedReason: Option.Option<AiChatApi.DegradedReason>;
  readonly proposal: Option.Option<AiChatApi.Proposal>;
  readonly at: Date;
}

interface ErrorTurnData {
  readonly id: string;
  readonly role: 'error';
  readonly userContent: string;
  readonly reason: AssistantTurnErrorReason;
  readonly retryAfterSeconds: number | undefined;
  readonly at: Date;
}

type Turn = UserTurn | AssistantTurnData | ErrorTurnData;

interface MessageTurn extends HistoryTurn {
  readonly id: string;
}

// Only turns that actually carry content the model should see next turn: every user turn, and
// an assistant turn whose `answer` was non-empty (a degraded `empty_answer` turn has nothing to
// replay — including it would build a `ChatMessage` the wire schema's `isMinLength(1)` rejects).
function toMessageTurns(turns: ReadonlyArray<Turn>): ReadonlyArray<MessageTurn> {
  return turns.flatMap((turn): ReadonlyArray<MessageTurn> => {
    if (turn.role === 'user') return [{ id: turn.id, role: 'user', content: turn.content }];
    if (turn.role === 'assistant' && turn.content.length > 0) {
      return [{ id: turn.id, role: 'assistant', content: turn.content }];
    }
    return [];
  });
}

// Cast-free tag/field sniffing on a squashed, `unknown`-typed failure (`Cause.squash`). TS
// narrows `unknown` through `typeof`/`in` guards without an `as` assertion.
function tagOf(value: unknown): string | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    '_tag' in value &&
    typeof value._tag === 'string'
  ) {
    return value._tag;
  }
  return undefined;
}

function retryAfterSecondsOf(value: unknown): number | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'retryAfterSeconds' in value &&
    typeof value.retryAfterSeconds === 'number'
  ) {
    return value.retryAfterSeconds;
  }
  return undefined;
}

/** The whole failure taxonomy of one turn, in one place — the three outcomes differ only in the
 * `reason` they commit and whether they carry a `retryAfterSeconds`. */
function classifyTurnFailure(squashed: unknown): {
  readonly reason: AssistantTurnErrorReason;
  readonly retryAfterSeconds: number | undefined;
} {
  switch (tagOf(squashed)) {
    case 'AiChatForbidden':
      return { reason: 'forbidden', retryAfterSeconds: undefined };
    case 'AiChatRateLimited':
      return { reason: 'rateLimited', retryAfterSeconds: retryAfterSecondsOf(squashed) };
    default:
      return { reason: 'generic', retryAfterSeconds: undefined };
  }
}

interface AssistantConversationProps {
  teamId: string;
  /** The command-palette hand-off (design §6.3 / plan §D). `{ text, id }`, not a bare `string` —
   *  the route strips `?ask=` immediately, so asking the identical text twice in a row would be
   *  swallowed by a value-equality guard; the monotonic `id` makes the second ask a genuinely
   *  new event. */
  pendingQuestion?: { text: string; id: number };
}

export function AssistantConversation({ teamId, pendingQuestion }: AssistantConversationProps) {
  const run = useRun();
  const teamIdBranded = React.useMemo(() => Schema.decodeSync(Team.TeamId)(teamId), [teamId]);

  const [turns, setTurns] = React.useState<ReadonlyArray<Turn>>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [newChatOpen, setNewChatOpen] = React.useState(false);
  const [presetValue, setPresetValue] = React.useState<string | undefined>(undefined);

  const idCounterRef = React.useRef(0);
  const nextId = React.useCallback(() => `assistant-turn-${idCounterRef.current++}`, []);

  const bottomRef = React.useRef<HTMLDivElement>(null);
  // Unconditional auto-scroll to the newest turn (design §2.2). `turns` must stay in the
  // dependency array even though the body never reads it — it is a deliberate re-scroll
  // trigger, not a value read here, and it must fire on every new turn AND on an in-place turn
  // replacement (a retry succeeding), which a `turns.length`-only dependency would miss.
  // biome-ignore lint/correctness/useExhaustiveDependencies: turns is a deliberate re-scroll trigger, not a value read here
  React.useEffect(() => {
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    bottomRef.current?.scrollIntoView?.({ behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [turns]);

  const messageTurns = React.useMemo(() => toMessageTurns(turns), [turns]);
  const historyPreview = React.useMemo(() => buildHistory(messageTurns), [messageTurns]);
  const dividerBeforeId =
    historyPreview.droppedCount > 0 ? historyPreview.messages[0]?.id : undefined;

  const commit = React.useCallback((id: string, turn: Turn, isRetry: boolean) => {
    setTurns((prev) => (isRetry ? prev.map((t) => (t.id === id ? turn : t)) : [...prev, turn]));
  }, []);

  const runExchange = React.useCallback(
    async (
      userContent: string,
      opts: {
        responseId: string;
        finalEntryId: string;
        priorTurns: ReadonlyArray<Turn>;
        isRetry: boolean;
      },
    ) => {
      const { responseId, finalEntryId, priorTurns, isRetry } = opts;
      const built = buildHistory(
        toMessageTurns(priorTurns).concat([
          { id: finalEntryId, role: 'user', content: userContent },
        ]),
      );
      const messages = toChatMessages(built.messages);

      setSubmitting(true);

      const effect = ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.aiChat.chat({ params: { teamId: teamIdBranded }, payload: { messages } }),
        ),
        Effect.tap((response) => {
          commit(
            responseId,
            {
              id: responseId,
              role: 'assistant',
              content: response.answer,
              references: response.references,
              degradedReason: response.degradedReason,
              proposal: response.proposal,
              at: new Date(),
            },
            isRetry,
          );
          return Effect.void;
        }),
        Effect.asVoid,
        // A single dispatch point, not a chain of `catchTag`s each re-failing into the next:
        // `Effect.catchCause` here inspects the squashed failure ONCE and commits exactly one
        // error turn. Chaining `catchTag('AiChatForbidden', ...)` -> `catchTag('AiChatRateLimited',
        // ...)` -> `catchCause(generic)` would have a real bug — the final `catchCause` catches
        // EVERY remaining cause unconditionally, including the `SilentClientError` the two
        // preceding branches just deliberately raised, silently overwriting a correct
        // forbidden/rateLimited commit with a second, wrong "generic" one.
        //
        // `Effect.catchAll` does not exist in `effect@4.0.0-beta.40` (finding #1) and a plain
        // `Effect.fail(new Error(...))` (the generic-transport-failure shape this branch must
        // also handle) has no `_tag`, so `Effect.catchTag` alone cannot cover it — `catchCause`
        // plus a tag-sniffing helper is the only single-shot option.
        Effect.catchCause((cause) => {
          const squashed = Cause.squash(cause);
          const { reason, retryAfterSeconds } = classifyTurnFailure(squashed);
          commit(
            responseId,
            {
              id: responseId,
              role: 'error',
              userContent,
              reason,
              retryAfterSeconds,
              at: new Date(),
            },
            isRetry,
          );
          return Effect.fail(new SilentClientError({ message: turnErrorMessages[reason]() }));
        }),
      );

      try {
        await run({})(effect);
      } finally {
        setSubmitting(false);
      }
    },
    [run, teamIdBranded, commit],
  );

  const handleSend = React.useCallback(
    async (content: string) => {
      const userTurnId = nextId();
      const responseId = nextId();
      const priorTurns = turns;
      setTurns((prev) => [...prev, { id: userTurnId, role: 'user', content, at: new Date() }]);
      setPresetValue(undefined);
      await runExchange(content, {
        responseId,
        finalEntryId: userTurnId,
        priorTurns,
        isRetry: false,
      });
    },
    [turns, nextId, runExchange],
  );

  // The command-palette hand-off's auto-send, exactly once per id (design §6.3 / plan §D).
  // `handleSend`'s identity changes on every `turns` update (it closes over `turns`), so this
  // effect legitimately re-runs on every turn — the ref guard, not the dependency array, is
  // what makes it fire once. Do not "fix" it by trimming deps; that is how the next person
  // breaks it. The ref is assigned BEFORE `handleSend` so a re-entrant render (triggered by
  // `handleSend`'s own optimistic `setTurns` call, which is what gives it a new identity in the
  // first place) sees the guard already tripped.
  //
  // The clamp: `toChatMessages` -> `new AiChatApi.ChatMessage(...)` is a validating constructor
  // that throws on `''` (isMinLength(1)) and on >2000 chars (isMaxLength(2000)), and that call
  // happens before `setSubmitting(true)` and outside the `try` in `runExchange` above — an
  // unclamped auto-send throws synchronously right after the optimistic user bubble lands on
  // screen: no error turn, no request, no log, page dead. The route already slices `?ask=` to
  // 2000 characters, but `pendingQuestion` is a prop, not re-validated at a trust boundary by
  // the time it gets here, so this is the last line of defence before the throwing constructor.
  const sentIdRef = React.useRef(0);
  React.useEffect(() => {
    if (pendingQuestion === undefined || sentIdRef.current >= pendingQuestion.id) return;
    sentIdRef.current = pendingQuestion.id;
    const text = pendingQuestion.text.trim().slice(0, 2000);
    if (text.length === 0) return;
    void handleSend(text);
  }, [pendingQuestion, handleSend]);

  const handleRetry = React.useCallback(
    async (errorTurn: ErrorTurnData) => {
      const index = turns.findIndex((t) => t.id === errorTurn.id);
      if (index <= 0) return;
      const userTurn = turns[index - 1];
      const priorTurns = turns.slice(0, index - 1);
      await runExchange(errorTurn.userContent, {
        responseId: errorTurn.id,
        finalEntryId: userTurn.id,
        priorTurns,
        isRetry: true,
      });
    },
    [turns, runExchange],
  );

  const handlePickPrompt = React.useCallback((prompt: string) => setPresetValue(prompt), []);

  const handleClearConversation = React.useCallback(() => {
    setTurns([]);
    setNewChatOpen(false);
  }, []);

  return (
    <div className='flex flex-1 min-h-0 flex-col gap-4'>
      <div className='flex shrink-0 justify-end'>
        {turns.length > 0 && (
          <Button type='button' variant='ghost' size='sm' onClick={() => setNewChatOpen(true)}>
            <RotateCcw className='size-4' aria-hidden='true' />
            {tr('assistant_newChat')}
          </Button>
        )}
      </div>

      <div
        role='log'
        aria-live='polite'
        aria-relevant='additions text'
        aria-label={tr('assistant_logLabel')}
        className='flex-1 min-h-0 overflow-y-auto'
      >
        {turns.length === 0 ? (
          <AssistantEmptyState onPickPrompt={handlePickPrompt} />
        ) : (
          <ol className='mx-auto flex w-full max-w-3xl flex-col gap-6 py-4'>
            {turns.map((turn) => (
              <React.Fragment key={turn.id}>
                {turn.id === dividerBeforeId && (
                  <li className='flex items-center gap-2 text-xs text-muted-foreground' role='note'>
                    <Separator className='flex-1' />
                    {tr('assistant_historyTrimmed')}
                    <Separator className='flex-1' />
                  </li>
                )}
                {turn.role === 'user' && (
                  <li className='flex justify-end'>
                    <div className='max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground sm:max-w-[75%] whitespace-pre-wrap break-words'>
                      <span className='sr-only'>{tr('assistant_youLabel')}: </span>
                      {turn.content}
                    </div>
                  </li>
                )}
                {turn.role === 'assistant' && <AssistantTurnView turn={turn} teamId={teamId} />}
                {turn.role === 'error' && (
                  <li className='flex flex-col gap-3'>
                    <TurnSpeakerRow at={turn.at} />
                    <AssistantTurnError
                      reason={turn.reason}
                      retryAfterSeconds={turn.retryAfterSeconds}
                      disabled={submitting}
                      onRetry={() => {
                        void handleRetry(turn);
                      }}
                    />
                  </li>
                )}
              </React.Fragment>
            ))}
            {submitting && (
              <li className='flex items-center gap-2 text-sm text-muted-foreground'>
                <Loader2 className='size-4 animate-spin' aria-hidden='true' />
                {tr('assistant_thinking')}
              </li>
            )}
            <div ref={bottomRef} />
          </ol>
        )}
      </div>

      <AssistantComposer onSend={handleSend} disabled={submitting} presetValue={presetValue} />

      <AlertDialog open={newChatOpen} onOpenChange={setNewChatOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr('assistant_newChatConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tr('assistant_newChatConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('common_cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleClearConversation}>
              {tr('assistant_newChatConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TurnSpeakerRow({ at }: { at: Date }) {
  const { formatRelative } = useFormatDate();
  return (
    <div className='flex items-center gap-2'>
      <Sparkles className='size-4 text-primary' aria-hidden='true' />
      <span className='text-xs font-medium'>{tr('assistant_assistantLabel')}</span>
      <span className='text-xs text-muted-foreground'>{formatRelative(at)}</span>
    </div>
  );
}

interface AssistantTurnViewProps {
  turn: AssistantTurnData;
  teamId: string;
}

function AssistantTurnView({ turn, teamId }: AssistantTurnViewProps) {
  const tokens = React.useMemo(
    () => new Map(turn.references.map((reference, index) => [reference.ref, index] as const)),
    [turn.references],
  );
  const { cited } = React.useMemo(() => parseAnswer(turn.content, tokens), [turn.content, tokens]);
  const uncited = React.useMemo(
    () => turn.references.filter((_, index) => !cited.has(index)),
    [turn.references, cited],
  );
  return (
    <li className='flex flex-col gap-3'>
      <TurnSpeakerRow at={turn.at} />
      {Option.isSome(turn.degradedReason) && (
        <Alert>
          <Info className='size-4' aria-hidden='true' />
          <AlertTitle>{tr('assistant_degraded_title')}</AlertTitle>
          <AlertDescription>{degradedReasonLabels[turn.degradedReason.value]()}</AlertDescription>
        </Alert>
      )}
      {turn.content.length > 0 && (
        <AssistantAnswer text={turn.content} references={turn.references} teamId={teamId} />
      )}
      {uncited.length > 0 && <AssistantResultList references={uncited} teamId={teamId} />}
      {Option.isSome(turn.proposal) && (
        <AssistantProposalCard proposal={turn.proposal.value} teamId={teamId} />
      )}
    </li>
  );
}
