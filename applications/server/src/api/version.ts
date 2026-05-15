import { VersionApi } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { APP_VERSION } from '~/version.js';

export const VersionApiLive = HttpApiBuilder.group(Api, 'version', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('store', () => BotInfoStore.asEffect()),
    Effect.map(({ store }) =>
      handlers.handle('get', () =>
        store.get.pipe(
          Effect.map(
            (botOpt) =>
              new VersionApi.VersionInfo({
                server: APP_VERSION,
                bot: Option.getOrElse(botOpt, () => 'unknown'),
              }),
          ),
        ),
      ),
    ),
  ),
);
