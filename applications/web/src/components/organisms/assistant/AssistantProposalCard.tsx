/**
 * The confirmation card for one pending `AiChatApi.Proposal` (plan §6.1). An organism, not a
 * molecule: it builds and runs its own Effect via `ApiClient.asEffect()` + `useRun()` and calls
 * `router.invalidate()` on a successful confirm — Pattern A (`applications/web/AGENTS.md:827`).
 * Props are exactly `{ proposal, teamId }`: no callbacks, no hoisted state — `AssistantConversation`
 * threads nothing else through.
 *
 * All nine `ProposalFieldKey`s always render, `{ type: 'none' }` included ("Not set" is a visible
 * row, never an omitted one) — a field that silently disappeared could not be verified before the
 * user confirms a write. A `date` field renders its string verbatim, never parsed into a `Date`:
 * it is already a team-local calendar date, and parsing it would re-introduce an off-by-one-day
 * bug client-side. Only `instant` goes through `useFormatDate`.
 *
 * Failure classification is one `Effect.catchCause` + `Cause.squash` + a `switch` on the sniffed
 * `_tag`, mirroring `classifyTurnFailure` (`AssistantConversation.tsx:123-135`) — NOT a chain of
 * `catchTag`s (that file's header comment documents the real bug in that shape). The expiry
 * shown in the header is the absolute time only, never a countdown: `Date.now()` drifts and jumps
 * on wake, so a client-side gate would either block a valid confirm or do nothing at all — the
 * server's `expires_at > now()` is the only gate that matters.
 */
import { type AiChatApi, type EventApi, Team } from '@sideline/domain';
import { useRouter } from '@tanstack/react-router';
import { Cause, DateTime, Effect, Schema } from 'effect';
import { CircleCheck, Clock, Loader2, OctagonX } from 'lucide-react';
import React from 'react';
import { AssistantResultCard } from '~/components/molecules/assistant/AssistantResultCard.js';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert.js';
import { Badge } from '~/components/ui/badge.js';
import { Button } from '~/components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '~/components/ui/card.js';
import { useFormatDate } from '~/hooks/useFormatDate.js';
import { eventTypeLabels } from '~/lib/event-labels.js';
import { ApiClient, SilentClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface AssistantProposalCardProps {
  readonly proposal: AiChatApi.Proposal;
  // Unbranded, like every sibling prop in this tree — branded inside via Schema.decodeSync.
  readonly teamId: string;
}

type ProposalErrorReason = 'notFound' | 'alreadyUsed' | 'expired' | 'forbidden' | 'generic';

// Component-local discriminated union — `_tag`, not the wire `type` ProposalFieldValue uses.
// Different layers, no collision (AssistantTurnError's `AssistantTurnErrorReason` is the
// neighbouring precedent for a local-only union next to a wire one).
type CardState =
  | { readonly _tag: 'pending' }
  | { readonly _tag: 'busy'; readonly which: 'confirm' | 'reject' }
  | { readonly _tag: 'confirmed'; readonly event: EventApi.EventInfo }
  | { readonly _tag: 'rejected' }
  | { readonly _tag: 'failed'; readonly reason: ProposalErrorReason };

// Every label map a closed union feeds is declared `Record<…>`, never `Partial<>` — that is
// what turns a new union member into a build failure instead of a raw key reaching the screen
// (`turnErrorMessages`, `AssistantTurnError.tsx:24-28`, is the verified precedent).
const proposalFieldLabels: Record<AiChatApi.ProposalFieldKey, () => string> = {
  title: () => tr('event_title'),
  eventType: () => tr('event_eventType'),
  start: () => tr('assistant_proposal_field_start'),
  end: () => tr('assistant_proposal_field_end'),
  trainingType: () => tr('event_trainingType'),
  ownerGroup: () => tr('event_ownerGroup'),
  memberGroup: () => tr('event_memberGroup'),
  location: () => tr('event_location'),
  description: () => tr('event_description'),
};

const proposalTitles: Record<AiChatApi.Proposal['action'], () => string> = {
  create_event: () => tr('assistant_proposal_createEvent_title'),
};
const proposalDescriptions: Record<AiChatApi.Proposal['action'], () => string> = {
  create_event: () => tr('assistant_proposal_createEvent_description'),
};
const proposalConfirmLabels: Record<AiChatApi.Proposal['action'], () => string> = {
  create_event: () => tr('assistant_proposal_createEvent_confirm'),
};
const proposalSuccessLabels: Record<AiChatApi.Proposal['action'], () => string> = {
  create_event: () => tr('assistant_proposal_createEvent_confirmed'),
};

const proposalErrorMessages: Record<ProposalErrorReason, () => string> = {
  notFound: () => tr('assistant_proposal_errorNotFound'),
  alreadyUsed: () => tr('assistant_proposal_errorAlreadyUsed'),
  expired: () => tr('assistant_proposal_errorExpired'),
  forbidden: () => tr('assistant_proposal_errorForbidden'),
  generic: () => tr('assistant_proposal_errorGeneric'),
};

// Cast-free `_tag` sniffing on a squashed, `unknown`-typed failure — the same shape
// `AssistantConversation.tsx`'s `tagOf` uses, duplicated here per the plan: the label maps and
// their supporting helpers live inline in this file, not in a shared `lib/` module.
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

function classifyProposalFailure(squashed: unknown): ProposalErrorReason {
  switch (tagOf(squashed)) {
    case 'AiProposalNotFound':
      return 'notFound';
    case 'AiProposalAlreadyUsed':
      return 'alreadyUsed';
    case 'AiProposalExpired':
      return 'expired';
    case 'AiChatForbidden':
      // The kill switch renders as "forbidden" too (plan §8 item 8, accepted as-is) — the data
      // clause ("nothing was created") stays true even when the cause was an operator flipping
      // AI_CHAT_ENABLED, so the user is not misled about state; only the reason is imprecise.
      return 'forbidden';
    case 'AiProposalActionForbidden':
      return 'forbidden';
    default:
      return 'generic';
  }
}

function renderProposalFieldValue(
  value: AiChatApi.ProposalFieldValue,
  formatDateTime: (date: Date) => string,
): React.ReactNode {
  switch (value.type) {
    case 'text':
      return value.value;
    case 'instant':
      return formatDateTime(new Date(Number(DateTime.toEpochMillis(value.value))));
    case 'date':
      // Rendered VERBATIM — never parsed into a `Date`. It is already a team-local calendar
      // date; parsing it re-introduces an off-by-one-day bug on the client.
      return (
        <>
          {value.value} <Badge variant='secondary'>{tr('event_allDayLabel')}</Badge>
        </>
      );
    case 'eventType':
      return eventTypeLabels[value.value]();
    case 'none':
      // A visible row, never an omitted one — `memberGroup: none` means everyone on the team
      // sees this event, a visibility decision the user must be able to verify before confirming.
      return <span className='text-muted-foreground'>{tr('assistant_proposal_fieldNotSet')}</span>;
  }
}

export function AssistantProposalCard({ proposal, teamId }: AssistantProposalCardProps) {
  const run = useRun();
  const router = useRouter();
  const { formatDateTime, formatTime } = useFormatDate();
  const titleId = React.useId();
  const teamIdBranded = React.useMemo(() => Schema.decodeSync(Team.TeamId)(teamId), [teamId]);

  const [state, setState] = React.useState<CardState>({ _tag: 'pending' });

  const terminalRef = React.useRef<HTMLDivElement>(null);
  // Focus moves to the terminal message container when a terminal state replaces the button the
  // user just pressed — never on mount (initial state is `pending`, so this never fires then),
  // and never merely because the card appeared (no `aria-live` here either — the log region
  // that owns this card is already `role='log' aria-live='polite'`; nesting would double-announce).
  React.useEffect(() => {
    if (state._tag === 'confirmed' || state._tag === 'rejected' || state._tag === 'failed') {
      terminalRef.current?.focus();
    }
  }, [state._tag]);

  const handleConfirm = React.useCallback(async () => {
    setState({ _tag: 'busy', which: 'confirm' });
    const effect = ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.aiChat.confirmProposal({
          params: { teamId: teamIdBranded, proposalId: proposal.id },
        }),
      ),
      Effect.tap((event) => {
        setState({ _tag: 'confirmed', event });
        router.invalidate();
        return Effect.void;
      }),
      Effect.asVoid,
      Effect.catchCause((cause) => {
        const reason = classifyProposalFailure(Cause.squash(cause));
        setState({ _tag: 'failed', reason });
        return Effect.fail(new SilentClientError({ message: proposalErrorMessages[reason]() }));
      }),
    );
    await run({})(effect);
  }, [run, router, teamIdBranded, proposal.id]);

  const handleReject = React.useCallback(async () => {
    setState({ _tag: 'busy', which: 'reject' });
    const effect = ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.aiChat.rejectProposal({
          params: { teamId: teamIdBranded, proposalId: proposal.id },
        }),
      ),
      Effect.tap(() => {
        setState({ _tag: 'rejected' });
        return Effect.void;
      }),
      Effect.asVoid,
      Effect.catchCause((cause) => {
        const reason = classifyProposalFailure(Cause.squash(cause));
        setState({ _tag: 'failed', reason });
        return Effect.fail(new SilentClientError({ message: proposalErrorMessages[reason]() }));
      }),
    );
    await run({})(effect);
  }, [run, teamIdBranded, proposal.id]);

  const busy = state._tag === 'busy';
  const isTerminal =
    state._tag === 'confirmed' || state._tag === 'rejected' || state._tag === 'failed';
  const showFieldList = !isTerminal || !(state._tag === 'failed' && state.reason === 'alreadyUsed');
  const showFooter = !isTerminal || (state._tag === 'failed' && state.reason === 'generic');

  return (
    <section aria-labelledby={titleId}>
      <Card>
        <CardHeader>
          <CardTitle id={titleId}>{proposalTitles[proposal.action]()}</CardTitle>
          <CardDescription>{proposalDescriptions[proposal.action]()}</CardDescription>
          <CardDescription>
            {tr('assistant_proposal_expiresAt', {
              time: formatTime(new Date(Number(DateTime.toEpochMillis(proposal.expiresAt)))),
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className='flex flex-col gap-4'>
          {showFieldList && (
            <dl className='grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,8rem)_1fr]'>
              {proposal.summary.map((field) => (
                <React.Fragment key={field.key}>
                  <dt className='break-words text-muted-foreground'>
                    {proposalFieldLabels[field.key]()}
                  </dt>
                  <dd className='break-words'>
                    {renderProposalFieldValue(field.value, formatDateTime)}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          )}
          {isTerminal && (
            <div ref={terminalRef} tabIndex={-1} className='flex flex-col gap-3 outline-none'>
              {state._tag === 'confirmed' && (
                <>
                  <Alert>
                    <CircleCheck className='size-4' aria-hidden='true' />
                    <AlertTitle>{proposalSuccessLabels[proposal.action]()}</AlertTitle>
                  </Alert>
                  <AssistantResultCard
                    reference={{ kind: 'event', event: state.event }}
                    teamId={teamId}
                  />
                </>
              )}
              {state._tag === 'rejected' && (
                <p className='text-sm text-muted-foreground'>{tr('assistant_proposal_rejected')}</p>
              )}
              {state._tag === 'failed' && state.reason === 'expired' && (
                <Alert>
                  <Clock className='size-4' aria-hidden='true' />
                  <AlertTitle>{tr('assistant_proposal_expiredTitle')}</AlertTitle>
                  <AlertDescription>{proposalErrorMessages[state.reason]()}</AlertDescription>
                </Alert>
              )}
              {state._tag === 'failed' && state.reason !== 'expired' && (
                <Alert variant='destructive'>
                  <OctagonX className='size-4' aria-hidden='true' />
                  <AlertTitle>{tr('assistant_proposal_failedTitle')}</AlertTitle>
                  <AlertDescription>{proposalErrorMessages[state.reason]()}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </CardContent>
        {showFooter && (
          <CardFooter className='flex-col-reverse gap-2 sm:flex-row sm:justify-end'>
            {/* DOM order is Discard THEN Confirm — a stray Enter must never land on the write.
                `flex-col-reverse` puts Confirm visually on top on a phone regardless. */}
            <Button
              type='button'
              variant='outline'
              className='w-full sm:w-auto'
              disabled={busy}
              onClick={() => {
                void handleReject();
              }}
            >
              {state._tag === 'busy' && state.which === 'reject' ? (
                <>
                  <Loader2 className='size-4 animate-spin' aria-hidden='true' />
                  {tr('assistant_proposal_working')}
                </>
              ) : (
                tr('assistant_proposal_reject')
              )}
            </Button>
            <Button
              type='button'
              className='w-full sm:w-auto'
              disabled={busy}
              onClick={() => {
                void handleConfirm();
              }}
            >
              {state._tag === 'busy' && state.which === 'confirm' ? (
                <>
                  <Loader2 className='size-4 animate-spin' aria-hidden='true' />
                  {tr('assistant_proposal_working')}
                </>
              ) : (
                proposalConfirmLabels[proposal.action]()
              )}
            </Button>
          </CardFooter>
        )}
      </Card>
    </section>
  );
}
