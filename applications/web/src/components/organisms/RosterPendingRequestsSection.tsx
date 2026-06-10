import type { EventRosterApi } from '@sideline/domain';
import { EventRosterModel, RosterModel, Team } from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import React from 'react';

import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface RosterPendingRequestsSectionProps {
  teamId: string;
  rosterId: string;
  initialRequests: ReadonlyArray<EventRosterApi.PendingRequestView>;
  onRefresh: () => void;
}

export function RosterPendingRequestsSection({
  teamId,
  rosterId,
  initialRequests,
  onRefresh,
}: RosterPendingRequestsSectionProps) {
  const run = useRun();

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const rosterIdBranded = Schema.decodeSync(RosterModel.RosterId)(rosterId);

  const [requests, setRequests] =
    React.useState<ReadonlyArray<EventRosterApi.PendingRequestView>>(initialRequests);
  const [processingIds, setProcessingIds] = React.useState<ReadonlySet<string>>(new Set());

  // Sync state when parent reloads
  React.useEffect(() => {
    setRequests(initialRequests);
  }, [initialRequests]);

  const handleApprove = React.useCallback(
    async (requestId: string) => {
      const requestIdBranded = Schema.decodeSync(EventRosterModel.EventRosterRequestId)(requestId);
      setProcessingIds((prev) => new Set([...prev, requestId]));
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.eventRoster.approveRosterRequest({
            params: {
              teamId: teamIdBranded,
              rosterId: rosterIdBranded,
              requestId: requestIdBranded,
            },
          }),
        ),
        Effect.catchTag('EventRosterRequestAlreadyHandled', () =>
          Effect.fail(ClientError.make(tr('eventRoster_actionFailed'))),
        ),
        Effect.mapError(() => ClientError.make(tr('eventRoster_actionFailed'))),
        run({ success: tr('eventRoster_approveSuccess') }),
      );
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
      if (Option.isSome(result)) {
        setRequests((prev) => prev.filter((r) => r.requestId !== requestId));
        onRefresh();
      }
    },
    [teamIdBranded, rosterIdBranded, run, onRefresh],
  );

  const handleDecline = React.useCallback(
    async (requestId: string) => {
      const requestIdBranded = Schema.decodeSync(EventRosterModel.EventRosterRequestId)(requestId);
      setProcessingIds((prev) => new Set([...prev, requestId]));
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.eventRoster.declineRosterRequest({
            params: {
              teamId: teamIdBranded,
              rosterId: rosterIdBranded,
              requestId: requestIdBranded,
            },
          }),
        ),
        Effect.catchTag('EventRosterRequestAlreadyHandled', () =>
          Effect.fail(ClientError.make(tr('eventRoster_actionFailed'))),
        ),
        Effect.mapError(() => ClientError.make(tr('eventRoster_actionFailed'))),
        run({ success: tr('eventRoster_declineSuccess') }),
      );
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
      if (Option.isSome(result)) {
        setRequests((prev) => prev.filter((r) => r.requestId !== requestId));
        onRefresh();
      }
    },
    [teamIdBranded, rosterIdBranded, run, onRefresh],
  );

  if (requests.length === 0) {
    return (
      <Card className='mb-6'>
        <CardHeader>
          <CardTitle className='text-base'>{tr('eventRoster_pendingRequests')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className='text-muted-foreground text-sm'>{tr('eventRoster_noPendingRequests')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className='mb-6'>
      <CardHeader>
        <CardTitle className='text-base'>{tr('eventRoster_pendingRequests')}</CardTitle>
      </CardHeader>
      <CardContent>
        <table className='w-full'>
          <thead>
            <tr className='border-b text-sm text-muted-foreground'>
              <th className='py-2 px-4 text-left font-medium'>
                {tr('eventRoster_requestCandidate')}
              </th>
              <th className='hidden sm:table-cell py-2 px-4 text-left font-medium'>
                {tr('eventRoster_requestEvent')}
              </th>
              <th className='hidden sm:table-cell py-2 px-4 text-left font-medium'>
                {tr('eventRoster_requestedAt')}
              </th>
              <th className='py-2 px-4' />
            </tr>
          </thead>
          <tbody>
            {requests.map((req) => {
              const isProcessing = processingIds.has(req.requestId);
              const candidateName = Option.getOrElse(
                req.candidateName,
                () => req.candidateMemberId,
              );
              return (
                <tr key={req.requestId} className='border-b'>
                  <td className='py-2 px-4'>
                    <span className='font-medium'>{candidateName}</span>
                    <p className='text-xs text-muted-foreground sm:hidden'>{req.eventTitle}</p>
                  </td>
                  <td className='hidden sm:table-cell py-2 px-4 text-sm'>{req.eventTitle}</td>
                  <td className='hidden sm:table-cell py-2 px-4 text-sm text-muted-foreground'>
                    {req.requestedAt}
                  </td>
                  <td className='py-2 px-4'>
                    <div className='flex gap-2 justify-end'>
                      <Button
                        size='sm'
                        variant='default'
                        disabled={isProcessing}
                        onClick={() => handleApprove(req.requestId)}
                      >
                        {tr('eventRoster_approve')}
                      </Button>
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={isProcessing}
                        onClick={() => handleDecline(req.requestId)}
                      >
                        {tr('eventRoster_decline')}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
