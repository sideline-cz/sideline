import { Bind } from '@sideline/effect-lib';
import { Effect, Option } from 'effect';
import { SyncRpc } from '~/services/SyncRpc.js';

export const BackfillService = Effect.Do.pipe(
  Effect.tap(() => Effect.logInfo('ChannelBackfillService initialized')),
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.let('processTick', ({ rpc }) =>
    rpc['Channel/BackfillMissingGroupRoles']({ team_id: Option.none(), limit: Option.none() }).pipe(
      Effect.tap((count) =>
        count > 0 ? Effect.logInfo(`Backfilled ${count} missing group roles`) : Effect.void,
      ),
      Effect.asVoid,
    ),
  ),
  Bind.remove('rpc'),
);
