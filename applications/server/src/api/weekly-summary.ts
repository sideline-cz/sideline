import { Auth } from '@sideline/domain';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { getWeeklySummaryHandler } from '~/services/WeeklySummaryHandler.js';

export const WeeklySummaryApiLive = HttpApiBuilder.group(Api, 'weeklySummary', (handlers) =>
  Effect.succeed(
    handlers.handle('getWeeklySummary', ({ params: { teamId }, query: { week, includeTeam } }) =>
      Effect.Do.pipe(
        Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
        Effect.flatMap(({ currentUser }) =>
          getWeeklySummaryHandler({
            teamId,
            currentUserId: currentUser.id,
            week,
            includeTeam,
          }),
        ),
      ),
    ),
  ),
);
