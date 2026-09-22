import type { EventApi, EventRsvp, EventRsvpApi } from '@sideline/domain';
import { type Effect, Option } from 'effect';
import { Check, CircleHelp, Clock, Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '~/components/ui/button';
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
  maybe: 'text-amber-600 dark:text-amber-400',
  no: 'text-red-600 dark:text-red-400',
};

const RESPONSE_LABEL_KEY: Record<RsvpResponse, string> = {
  yes: 'rsvp_yes',
  coming_later: 'rsvp_comingLater',
  maybe: 'rsvp_maybe',
  no: 'rsvp_no',
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
  // Set while the user has clicked "Coming later" but not yet saved a required note.
  const [pendingResponse, setPendingResponse] = useState<'coming_later' | null>(null);
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraftMessage(savedMessage);
  }, [savedMessage]);

  useEffect(() => {
    if (pendingResponse === 'coming_later') {
      messageInputRef.current?.focus();
    }
  }, [pendingResponse]);

  const run = useRun();

  const isBusy = submittingResponse !== null || savingMessage;

  // The response that a note-save would currently target: the pending "coming later" choice
  // takes priority over the already-saved response.
  const targetResponse = pendingResponse ?? currentResponse;
  const displayedResponse = submittingResponse ?? targetResponse;
  const messageRequired = targetResponse === 'coming_later';
  const messageMissing = messageRequired && draftMessage.trim().length === 0;

  const handleResponseClick = async (response: RsvpResponse) => {
    if (isBusy) return;
    if (response === 'coming_later') {
      // Mandatory comment: "Coming later" never instant-submits — it only reveals + focuses the
      // note field (focus happens in a `useEffect` on `pendingResponse`, after the textarea has
      // been committed to the DOM) and requires a non-empty note before Save will submit it.
      setPendingResponse('coming_later');
      return;
    }
    if (response === currentResponse) {
      setPendingResponse(null);
      return;
    }
    setPendingResponse(null);
    setSubmittingResponse(response);
    // Leaving "coming_later" clears its mandatory note (the server's clear signal is an empty
    // string) instead of re-sending it — that note answers "when will you arrive", so carrying it
    // onto any other response renders nonsense like "Nevím 💬 dorazím v 19:00". Mirrors the
    // server-side `effectiveClear` guard in `Event/SubmitRsvp`, which fires on the same condition
    // when a client sends no message at all (the bot's path). Without this the web would never
    // trigger that guard: a `coming_later` note is never empty, so `savedMessage` is always `Some`.
    const messageToSend = currentResponse === 'coming_later' ? '' : savedMessage;
    await run({ success: tr('event_rsvpSubmitted') })(onRsvpSubmit(response, messageToSend));
    setSubmittingResponse(null);
  };

  const handleSaveNote = async () => {
    if (!targetResponse) return;
    if (isBusy) return;
    // Mandatory comment: block saving when the pending/current response is "coming later" and the
    // note is blank — the note is what carries the "coming later" reason and is required.
    if (targetResponse === 'coming_later' && draftMessage.trim().length === 0) return;
    setSavingMessage(true);
    await run({ success: tr('event_rsvpSubmitted') })(onRsvpSubmit(targetResponse, draftMessage));
    setSavingMessage(false);
    setPendingResponse(null);
  };

  return (
    <div>
      <h2 className='text-lg font-semibold mb-4'>{tr('rsvp_title')}</h2>

      {rsvpDetail.canRsvp ? (
        <div className='flex flex-col gap-4'>
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

          {targetResponse && (
            <>
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
                  {messageRequired
                    ? tr('rsvp_messageHelpRequired')
                    : tr('rsvp_messageHelpOptional')}
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
            </>
          )}
        </div>
      ) : (
        <p className='text-sm text-muted-foreground'>{tr('rsvp_deadlinePassed')}</p>
      )}

      <div className='mt-6'>
        <h3 className='text-sm font-semibold mb-2'>{tr('rsvp_summary')}</h3>
        <div className='flex flex-wrap gap-4 text-sm mb-4'>
          <span className={RESPONSE_TEXT_CLASS.yes}>
            {tr('rsvp_attending', { count: String(rsvpDetail.yesCount) })}
          </span>
          <span className={RESPONSE_TEXT_CLASS.coming_later}>
            {tr('rsvp_comingLaterCount', { count: String(rsvpDetail.comingLaterCount) })}
          </span>
          <span className={RESPONSE_TEXT_CLASS.maybe}>
            {tr('rsvp_undecided', { count: String(rsvpDetail.maybeCount) })}
          </span>
          <span className={RESPONSE_TEXT_CLASS.no}>
            {tr('rsvp_notAttending', { count: String(rsvpDetail.noCount) })}
          </span>
        </div>

        {rsvpDetail.minPlayersThreshold > 0 &&
          rsvpDetail.yesCount + rsvpDetail.comingLaterCount < rsvpDetail.minPlayersThreshold && (
            <div className='mb-4 rounded-md border border-yellow-300 bg-yellow-50 px-4 py-2 text-sm text-yellow-800 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-200'>
              {tr('rsvp_belowMinPlayers', {
                count: String(rsvpDetail.yesCount + rsvpDetail.comingLaterCount),
                threshold: String(rsvpDetail.minPlayersThreshold),
              })}
            </div>
          )}

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
    </div>
  );
}
