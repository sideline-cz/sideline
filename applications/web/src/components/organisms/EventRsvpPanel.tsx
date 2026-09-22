import type { EventApi, EventRsvpApi } from '@sideline/domain';
import { EventRsvp } from '@sideline/domain';
import { type Effect, Option } from 'effect';
import { Check, ChevronDown, CircleHelp, Clock, Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Separator } from '~/components/ui/separator';
import { Textarea } from '~/components/ui/textarea';
import type { ClientConfig } from '~/lib/client';
import { type ApiClient, type ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

type RsvpResponse = EventRsvp.RsvpResponse;

interface EventRsvpPanelProps {
  eventDetail: EventApi.EventDetail;
  rsvpDetail: EventRsvpApi.EventRsvpDetail;
  nonResponders: ReadonlyArray<EventRsvpApi.NonResponderEntry>;
  onRsvpSubmit: (
    response: RsvpResponse,
    message: string,
  ) => Effect.Effect<void, ClientError, ApiClient | ClientConfig>;
}

// Canonical order everywhere: yes -> coming_later -> maybe -> no.
const RESPONSES: ReadonlyArray<RsvpResponse> = ['yes', 'coming_later', 'maybe', 'no'];

const RESPONSE_ICON: Record<RsvpResponse, typeof Check> = {
  yes: Check,
  coming_later: Clock,
  maybe: CircleHelp,
  no: X,
};

const RESPONSE_VARIANT: Record<RsvpResponse, 'default' | 'secondary' | 'destructive'> = {
  yes: 'default',
  coming_later: 'secondary',
  maybe: 'secondary',
  no: 'destructive',
};

const RESPONSE_TEXT_CLASS: Record<RsvpResponse, string> = {
  yes: 'text-green-700 dark:text-green-400',
  coming_later: 'text-blue-600 dark:text-blue-400',
  // amber-600 is 3.18:1 against the card background — fails WCAG AA (4.5:1) for normal text.
  // amber-700 is 5.05:1 — the other three response colours already pass and are unchanged.
  maybe: 'text-amber-700 dark:text-amber-400',
  no: 'text-red-600 dark:text-red-400',
};

const RESPONSE_LABEL_KEY: Record<RsvpResponse, string> = {
  yes: 'rsvp_yes',
  coming_later: 'rsvp_comingLater',
  maybe: 'rsvp_maybe',
  no: 'rsvp_no',
};

// Full-sentence i18n keys behind the compact count-strip icons — kept as `sr-only` text so the
// strip's meaning survives for anyone who can't see colour, without printing four sentences.
const RESPONSE_COUNT_LABEL_KEY: Record<RsvpResponse, string> = {
  yes: 'rsvp_attending',
  coming_later: 'rsvp_comingLaterCount',
  maybe: 'rsvp_undecided',
  no: 'rsvp_notAttending',
};

export function EventRsvpPanel({
  eventDetail,
  rsvpDetail,
  nonResponders,
  onRsvpSubmit,
}: EventRsvpPanelProps) {
  const currentResponse = Option.getOrNull(rsvpDetail.myResponse);
  const savedMessage = Option.getOrElse(rsvpDetail.myMessage, () => '');

  const [submittingResponse, setSubmittingResponse] = useState<RsvpResponse | null>(null);
  const [draftMessage, setDraftMessage] = useState(savedMessage);
  const [savingMessage, setSavingMessage] = useState(false);
  // Set while the user has clicked a note-requiring response ("Coming later" / "Nevím") but has
  // not yet saved its required note.
  const [pendingResponse, setPendingResponse] = useState<RsvpResponse | null>(null);
  // Closed by default for everyone — the response list and non-responders list sit behind an
  // explicit disclosure now instead of always being on screen.
  const [summaryOpen, setSummaryOpen] = useState(false);
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraftMessage(savedMessage);
  }, [savedMessage]);

  useEffect(() => {
    if (pendingResponse !== null) {
      messageInputRef.current?.focus();
    }
  }, [pendingResponse]);

  const run = useRun();

  const isBusy = submittingResponse !== null || savingMessage;

  // The response that a note-save would currently target: a pending note-requiring choice
  // takes priority over the already-saved response.
  const targetResponse = pendingResponse ?? currentResponse;
  const displayedResponse = submittingResponse ?? targetResponse;
  const messageRequired =
    targetResponse !== null && EventRsvp.rsvpResponseRequiresMessage(targetResponse);
  const messageMissing = messageRequired && draftMessage.trim().length === 0;

  const handleResponseClick = async (response: RsvpResponse) => {
    if (isBusy) return;
    if (EventRsvp.rsvpResponseRequiresMessage(response)) {
      // Mandatory comment: "Coming later" and "Nevím" never instant-submit — they only reveal +
      // focus the note field (focus happens in a `useEffect` on `pendingResponse`, after the
      // textarea has been committed to the DOM) and require a non-empty note before Save will
      // submit them.
      setPendingResponse(response);
      return;
    }
    if (response === currentResponse) {
      setPendingResponse(null);
      return;
    }
    setPendingResponse(null);
    setSubmittingResponse(response);
    // Leaving a note-requiring response clears its mandatory note (the server's clear signal is
    // an empty string) instead of re-sending it — that note answers a question specific to the
    // response it was written for, so carrying it over renders nonsense. Mirrors the server-side
    // `effectiveClear` guard in `Event/SubmitRsvp`, which fires on the same condition when a
    // client sends no message at all (the bot's path). Without this the web would never trigger
    // that guard: a mandatory note is never empty, so `savedMessage` is always `Some`.
    // Only reachable for yes/no now — the note-requiring responses return above.
    const messageToSend =
      currentResponse !== null && EventRsvp.rsvpResponseRequiresMessage(currentResponse)
        ? ''
        : savedMessage;
    await run({ success: tr('event_rsvpSubmitted') })(onRsvpSubmit(response, messageToSend));
    setSubmittingResponse(null);
  };

  const handleSaveNote = async () => {
    if (!targetResponse) return;
    if (isBusy) return;
    // Mandatory comment: block saving when the pending/current response requires a note and the
    // note is blank — that note is what carries the reason and is required.
    if (EventRsvp.rsvpResponseRequiresMessage(targetResponse) && draftMessage.trim().length === 0)
      return;
    setSavingMessage(true);
    await run({ success: tr('event_rsvpSubmitted') })(onRsvpSubmit(targetResponse, draftMessage));
    setSavingMessage(false);
    setPendingResponse(null);
  };

  const belowMinPlayers =
    rsvpDetail.minPlayersThreshold > 0 &&
    rsvpDetail.yesCount + rsvpDetail.comingLaterCount < rsvpDetail.minPlayersThreshold;

  return (
    <div>
      <h2 className='text-lg font-semibold mb-4'>{tr('rsvp_title')}</h2>

      {rsvpDetail.canRsvp ? (
        <div className='grid grid-cols-2 gap-2 sm:flex sm:flex-wrap'>
          {RESPONSES.map((response) => {
            const isActive = displayedResponse === response;
            const isLoadingThis = submittingResponse === response;
            const Icon = RESPONSE_ICON[response];
            return (
              <Button
                key={response}
                variant={isActive ? RESPONSE_VARIANT[response] : 'outline'}
                onClick={(e) => {
                  // `coming_later` moves focus to the textarea in a `useEffect` right after
                  // this; every other response instant-submits and keeps focus on the button
                  // that was clicked — jsdom's `fireEvent.click` doesn't do this by itself.
                  e.currentTarget.focus();
                  void handleResponseClick(response);
                }}
                disabled={isBusy}
                aria-pressed={isActive}
                className='w-full sm:w-auto'
              >
                {isLoadingThis && <Loader2 className='animate-spin' aria-hidden='true' />}
                <Icon aria-hidden='true' />
                {tr(RESPONSE_LABEL_KEY[response])}
              </Button>
            );
          })}
        </div>
      ) : (
        <p className='text-sm text-muted-foreground'>{tr('rsvp_deadlinePassed')}</p>
      )}

      {/* `flex-nowrap`: must stay on one line even at a 320px viewport — four short
          icon+number pairs fit comfortably; the full sentence lives in the `sr-only` span. */}
      <div className='mt-4 flex flex-nowrap items-center gap-3 text-sm'>
        {RESPONSES.map((response) => {
          const Icon = RESPONSE_ICON[response];
          const count =
            response === 'yes'
              ? rsvpDetail.yesCount
              : response === 'coming_later'
                ? rsvpDetail.comingLaterCount
                : response === 'maybe'
                  ? rsvpDetail.maybeCount
                  : rsvpDetail.noCount;
          return (
            <span
              key={response}
              className={`flex items-center gap-1 font-medium ${RESPONSE_TEXT_CLASS[response]}`}
            >
              <Icon className='size-4' aria-hidden='true' />
              <span aria-hidden='true'>{count}</span>
              <span className='sr-only'>{tr(RESPONSE_COUNT_LABEL_KEY[response], { count })}</span>
            </span>
          );
        })}
      </div>

      {belowMinPlayers && (
        <Alert variant='warning' role='status' className='mt-4'>
          <AlertDescription>
            {tr('rsvp_belowMinPlayers', {
              count: String(rsvpDetail.yesCount + rsvpDetail.comingLaterCount),
              threshold: String(rsvpDetail.minPlayersThreshold),
            })}
          </AlertDescription>
        </Alert>
      )}

      {rsvpDetail.canRsvp && targetResponse && (
        <div className='mt-4 flex flex-col gap-4'>
          <div>
            <label htmlFor='rsvp-message' className='text-sm font-medium mb-1 block'>
              {tr('rsvp_message')}
              {messageRequired && <span aria-hidden='true'> *</span>}
            </label>
            <Textarea
              id='rsvp-message'
              ref={messageInputRef}
              value={draftMessage}
              onChange={(e) => setDraftMessage(e.target.value)}
              placeholder={tr('rsvp_messagePlaceholder')}
              rows={2}
              aria-required={messageRequired}
              aria-invalid={messageMissing}
              aria-describedby={
                messageMissing ? 'rsvp-message-help rsvp-message-error' : 'rsvp-message-help'
              }
            />
            <p id='rsvp-message-help' className='mt-1 text-sm text-muted-foreground'>
              {messageRequired ? tr('rsvp_messageHelpRequired') : tr('rsvp_messageHelpOptional')}
            </p>
            {messageMissing && (
              <p
                id='rsvp-message-error'
                role='alert'
                className='mt-1 text-sm text-red-600 dark:text-red-400'
              >
                {tr('rsvp_messageRequired')}
              </p>
            )}
          </div>
          <div>
            <Button onClick={handleSaveNote} disabled={isBusy || messageMissing}>
              {savingMessage && <Loader2 className='animate-spin' aria-hidden='true' />}
              {savingMessage ? tr('rsvp_savingNote') : tr('rsvp_saveNote')}
            </Button>
          </div>
        </div>
      )}

      <Separator className='my-6' />

      <div>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='-ml-2'
          aria-expanded={summaryOpen}
          aria-controls='rsvp-responses-panel'
          onClick={() => setSummaryOpen((open) => !open)}
        >
          <ChevronDown
            className={`size-4 transition-transform ${summaryOpen ? 'rotate-180' : ''}`}
            aria-hidden='true'
          />
          {tr('rsvp_summary')}
        </Button>

        {summaryOpen && (
          <div id='rsvp-responses-panel' className='mt-2'>
            {rsvpDetail.rsvps.length > 0 ? (
              <ul className='space-y-1 text-sm'>
                {[...rsvpDetail.rsvps]
                  .sort((a, b) => RESPONSES.indexOf(a.response) - RESPONSES.indexOf(b.response))
                  .map((r) => (
                    <li key={r.teamMemberId} className='flex items-center gap-2'>
                      <span className={RESPONSE_TEXT_CLASS[r.response]}>
                        {tr(RESPONSE_LABEL_KEY[r.response])}
                      </span>
                      <span>{r.displayName}</span>
                      {Option.isSome(r.message) && (
                        <span className='text-muted-foreground'>— {r.message.value}</span>
                      )}
                    </li>
                  ))}
              </ul>
            ) : (
              <p className='text-sm text-muted-foreground'>{tr('rsvp_noResponses')}</p>
            )}

            {(eventDetail.canEdit || eventDetail.canCancel) && nonResponders.length > 0 && (
              <div className='mt-6'>
                <h3 className='text-sm font-semibold mb-2'>{tr('rsvp_nonRespondersTitle')}</h3>
                <ul className='space-y-1 text-sm text-muted-foreground'>
                  {nonResponders.map((nr) => (
                    <li key={nr.teamMemberId}>{nr.displayName}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
