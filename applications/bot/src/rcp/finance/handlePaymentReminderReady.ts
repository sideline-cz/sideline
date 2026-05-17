import type { FinanceRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect } from 'effect';
import { SyncRpc } from '~/services/SyncRpc.js';
import { buildPaymentReminderEmbed } from './buildPaymentReminderEmbed.js';

export const handlePaymentReminderReady = (event: FinanceRpcEvents.PaymentReminderReadyEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('dmChannel', ({ rest }) => rest.createDm({ recipient_id: event.user_discord_id })),
    Effect.tap(({ rest, dmChannel }) =>
      rest.createMessage(dmChannel.id, {
        embeds: [buildPaymentReminderEmbed(event)],
      }),
    ),
    Effect.tap(({ rpc }) =>
      rpc['Finance/MarkReminderSent']({
        assignment_id: event.assignment_id,
        kind: event.kind,
      }),
    ),
    Effect.asVoid,
  );
