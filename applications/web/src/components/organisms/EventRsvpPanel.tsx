import type { EventApi, EventRsvpApi } from '@sideline/domain';
import { type Effect, Option } from 'effect';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '~/components/ui/button';
import { Textarea } from '~/components/ui/textarea';
import type { ClientConfig } from '~/lib/client';
import { type ApiClient, type ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface EventRsvpPanelProps {
  eventDetail: EventApi.EventDetail;
  rsvpDetail: EventRsvpApi.EventRsvpDetail;
  nonResponders: ReadonlyArray<EventRsvpApi.NonResponderEntry>;
  onRsvpSubmit: (
    response: 'yes' | 'no' | 'maybe' | 'coming_later',
    message: string,
  ) => Effect.Effect<void, ClientError, ApiClient | ClientConfig>;
}

// The server projects the legacy `coming_later` write value to `maybe` on the read wire this
// release, so a late RSVP can come back as either tag — treat them as the same display state.
const isLate = (response: string): boolean => response === 'coming_later' || response === 'maybe';

export function EventRsvpPanel({
  eventDetail,
  rsvpDetail,
  nonResponders,
  onRsvpSubmit,
}: EventRsvpPanelProps) {
  const currentResponse = Option.getOrNull(rsvpDetail.myResponse);
  const savedMessage = Option.getOrElse(rsvpDetail.myMessage, () => '');

  const [submittingResponse, setSubmittingResponse] = useState<
    'yes' | 'no' | 'coming_later' | null
  >(null);
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
  const messageRequired = targetResponse !== null && isLate(targetResponse);
  const messageMissing = messageRequired && draftMessage.trim().length === 0;

  const handleResponseClick = async (response: 'yes' | 'no' | 'coming_later') => {
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
    await run({ success: tr('event_rsvpSubmitted') })(onRsvpSubmit(response, savedMessage));
    setSubmittingResponse(null);
  };

  const handleSaveNote = async () => {
    if (!targetResponse) return;
    if (isBusy) return;
    // Mandatory comment: block saving when the pending/current response is a late RSVP and the
    // note is blank — the note is what carries the "coming later" reason and is required.
    if (isLate(targetResponse) && draftMessage.trim().length === 0) return;
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
          <div className='flex gap-2'>
            {(['yes', 'coming_later', 'no'] as const).map((response) => {
              const activeVariant =
                response === 'yes'
                  ? 'default'
                  : response === 'coming_later'
                    ? 'secondary'
                    : 'destructive';
              const isActive = isLate(response)
                ? isLate(displayedResponse ?? '')
                : displayedResponse === response;
              const isLoadingThis = submittingResponse === response;
              return (
                <Button
                  key={response}
                  variant={isActive ? activeVariant : 'outline'}
                  onClick={() => handleResponseClick(response)}
                  disabled={isBusy}
                  aria-pressed={isActive}
                >
                  {isLoadingThis && <Loader2 className='animate-spin' aria-hidden='true' />}
                  {response === 'yes'
                    ? tr('rsvp_yes')
                    : response === 'coming_later'
                      ? tr('rsvp_maybe')
                      : tr('rsvp_no')}
                </Button>
              );
            })}
          </div>

          {targetResponse && (
            <>
              <div>
                <label htmlFor='rsvp-message' className='text-sm font-medium mb-1 block'>
                  {tr('rsvp_message')}
                  {messageRequired && ' *'}
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
                  aria-describedby={messageMissing ? 'rsvp-message-error' : undefined}
                />
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
        <div className='flex gap-4 text-sm mb-4'>
          <span className='text-green-700 dark:text-green-400'>
            {tr('rsvp_attending', { count: String(rsvpDetail.yesCount) })}
          </span>
          <span className='text-blue-600 dark:text-blue-400'>
            {tr('rsvp_undecided', { count: String(rsvpDetail.maybeCount) })}
          </span>
          <span className='text-red-600 dark:text-red-400'>
            {tr('rsvp_notAttending', { count: String(rsvpDetail.noCount) })}
          </span>
        </div>

        {rsvpDetail.minPlayersThreshold > 0 &&
          rsvpDetail.yesCount + rsvpDetail.maybeCount < rsvpDetail.minPlayersThreshold && (
            <div className='mb-4 rounded-md border border-yellow-300 bg-yellow-50 px-4 py-2 text-sm text-yellow-800 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-200'>
              {tr('rsvp_belowMinPlayers', {
                count: String(rsvpDetail.yesCount + rsvpDetail.maybeCount),
                threshold: String(rsvpDetail.minPlayersThreshold),
              })}
            </div>
          )}

        {rsvpDetail.rsvps.length > 0 ? (
          <ul className='space-y-1 text-sm'>
            {[...rsvpDetail.rsvps]
              .sort((a, b) => {
                const order = (r: string) => (r === 'yes' ? 0 : isLate(r) ? 1 : 2);
                return order(a.response) - order(b.response);
              })
              .map((r) => (
                <li key={r.teamMemberId} className='flex items-center gap-2'>
                  <span
                    className={
                      r.response === 'yes'
                        ? 'text-green-700 dark:text-green-400'
                        : isLate(r.response)
                          ? 'text-blue-600 dark:text-blue-400'
                          : 'text-red-600 dark:text-red-400'
                    }
                  >
                    {r.response === 'yes'
                      ? tr('rsvp_yes')
                      : isLate(r.response)
                        ? tr('rsvp_maybe')
                        : tr('rsvp_no')}
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
