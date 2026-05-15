import { BotInfoRpcGroup } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { Effect } from 'effect';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { APP_VERSION } from '~/version.js';

export const BotInfoRpcLive = Effect.Do.pipe(
  Effect.bind('botInfoStore', () => BotInfoStore.asEffect()),
  Effect.let(
    'BotInfo/ReportBotInfo',
    ({ botInfoStore }) =>
      ({ version }: { readonly version: string }) =>
        botInfoStore.set(version),
  ),
  Effect.let('BotInfo/GetServerVersion', () => () => Effect.succeed(APP_VERSION)),
  Bind.remove('botInfoStore'),
  (handlers) => BotInfoRpcGroup.BotInfoRpcGroup.toLayer(handlers),
);
