import type { EventApi, EventRsvpApi } from '@sideline/domain';
import { type Effect, Option } from 'effect';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
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
    response: 'yes' | 'no' | 'maybe',
    message: string,
  ) => Effect.Effect<void, ClientError, ApiClient | ClientConfig>;
}

export function EventRsvpPanel({
  eventDetail,
  rsvpDetail,
  nonResponders,
  onRsvpSubmit,
}: EventRsvpPanelProps) {
  const currentResponse = Option.getOrNull(rsvpDetail.myResponse);
  const savedMessage = Option.getOrElse(rsvpDetail.myMessage, () => '');

  const [submittingResponse, setSubmittingResponse] = useState<'yes' | 'no' | 'maybe' | null>(null);
  const [draftMessage, setDraftMessage] = useState(savedMessage);
  const [savingMessage, setSavingMessage] = useState(false);

  useEffect(() => {
    setDraftMessage(savedMessage);
  }, [savedMessage]);

  const run = useRun();

  const isBusy = submittingResponse !== null || savingMessage;

  const handleResponseClick = async (response: 'yes' | 'no' | 'maybe') => {
    if (response === currentResponse) return;
    if (isBusy) return;
    setSubmittingResponse(response);
    await run({ success: tr('event_rsvpSubmitted') })(onRsvpSubmit(response, savedMessage));
    setSubmittingResponse(null);
  };

  const handleSaveNote = async () => {
    if (!currentResponse) return;
    if (isBusy) return;
    setSavingMessage(true);
    await run({ success: tr('event_rsvpSubmitted') })(onRsvpSubmit(currentResponse, draftMessage));
    setSavingMessage(false);
  };

  return (
    <div>
      <h2 className='text-lg font-semibold mb-4'>{tr('rsvp_title')}</h2>

      {rsvpDetail.canRsvp ? (
        <div className='flex flex-col gap-4'>
          <div className='flex gap-2'>
            {(['yes', 'maybe', 'no'] as const).map((response) => {
              const activeVariant =
                response === 'yes' ? 'default' : response === 'maybe' ? 'secondary' : 'destructive';
              const displayedResponse = submittingResponse ?? currentResponse;
              const isActive = displayedResponse === response;
              const isLoadingThis = submittingResponse === response;
              return (
                <Button
                  key={response}
                  variant={isActive ? activeVariant : 'outline'}
                  onClick={() => handleResponseClick(response)}
                  disabled={isBusy}
                  aria-pressed={displayedResponse === response}
                >
                  {isLoadingThis && <Loader2 className='animate-spin' aria-hidden='true' />}
                  {response === 'yes'
                    ? tr('rsvp_yes')
                    : response === 'maybe'
                      ? tr('rsvp_maybe')
                      : tr('rsvp_no')}
                </Button>
              );
            })}
          </div>

          {currentResponse && (
            <>
              <div>
                <label htmlFor='rsvp-message' className='text-sm font-medium mb-1 block'>
                  {tr('rsvp_message')}
                </label>
                <Textarea
                  id='rsvp-message'
                  value={draftMessage}
                  onChange={(e) => setDraftMessage(e.target.value)}
                  placeholder={tr('rsvp_messagePlaceholder')}
                  rows={2}
                />
              </div>
              <div>
                <Button onClick={handleSaveNote} disabled={isBusy}>
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
          <span className='text-yellow-600 dark:text-yellow-400'>
            {tr('rsvp_undecided', { count: String(rsvpDetail.maybeCount) })}
          </span>
          <span className='text-red-600 dark:text-red-400'>
            {tr('rsvp_notAttending', { count: String(rsvpDetail.noCount) })}
          </span>
        </div>

        {rsvpDetail.minPlayersThreshold > 0 &&
          rsvpDetail.yesCount < rsvpDetail.minPlayersThreshold && (
            <div className='mb-4 rounded-md border border-yellow-300 bg-yellow-50 px-4 py-2 text-sm text-yellow-800 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-200'>
              {tr('rsvp_belowMinPlayers', {
                count: String(rsvpDetail.yesCount),
                threshold: String(rsvpDetail.minPlayersThreshold),
              })}
            </div>
          )}

        {rsvpDetail.rsvps.length > 0 ? (
          <ul className='space-y-1 text-sm'>
            {[...rsvpDetail.rsvps]
              .sort((a, b) => {
                const order: Record<string, number> = { yes: 0, maybe: 1, no: 2 };
                return (order[a.response] ?? 3) - (order[b.response] ?? 3);
              })
              .map((r) => (
                <li key={r.teamMemberId} className='flex items-center gap-2'>
                  <span
                    className={
                      r.response === 'yes'
                        ? 'text-green-700 dark:text-green-400'
                        : r.response === 'maybe'
                          ? 'text-yellow-600 dark:text-yellow-400'
                          : 'text-red-600 dark:text-red-400'
                    }
                  >
                    {r.response === 'yes'
                      ? tr('rsvp_yes')
                      : r.response === 'maybe'
                        ? tr('rsvp_maybe')
                        : tr('rsvp_no')}
                  </span>
                  <span>
                    {Option.getOrElse(r.memberName, () => Option.getOrElse(r.username, () => '—'))}
                  </span>
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
                <li key={nr.teamMemberId}>
                  {Option.getOrElse(nr.memberName, () => Option.getOrElse(nr.username, () => '—'))}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
