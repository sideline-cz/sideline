import type { FinanceRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option } from 'effect';
import { env } from '~/env.js';
import { guildLocaleFromRaw, type Locale } from '~/locale.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import {
  buildPaymentReminderComponents,
  buildPaymentReminderEmbed,
  type PaymentReminderQr,
} from './buildPaymentReminderEmbed.js';
import { paymentQrAttachment } from './paymentQrAttachment.js';

type QrOrNone = Option.Option<PaymentReminderQr & { readonly file: File }>;

export const handlePaymentReminderReady = (event: FinanceRpcEvents.PaymentReminderReadyEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    // This is a permanent one-off DM, not an interaction, so there is no client locale to read —
    // fall back to the guild's `preferred_locale`, same as the RSVP/training-claim DMs
    // (`guildLocaleFromRaw`). A failed lookup defaults to Czech rather than English: Fio bank
    // sync is a Czech-only feature (unlike the mixed-locale event/quiz flows).
    Effect.bind('locale', ({ rest }) =>
      rest.getGuild(event.guild_id).pipe(
        Effect.map(guildLocaleFromRaw),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Finance: could not read the locale of guild ${event.guild_id}, defaulting to Czech`,
            cause,
          ).pipe(Effect.as<Locale>('cs')),
        ),
      ),
    ),
    // T10 — never fail the reminder because of the QR. `FinanceQrUnavailable` (no bank config,
    // or the member has no variable symbol) and any transient RPC failure both degrade to the
    // text-only reminder exactly as it was before this feature.
    Effect.bind('qr', ({ rpc }) =>
      rpc['Finance/GetPaymentQr']({ assignment_id: event.assignment_id }).pipe(
        Effect.map((result): QrOrNone => {
          const { file, url } = paymentQrAttachment(result);
          return Option.some({ spayd: result.spayd, imageUrl: url, file });
        }),
        Effect.catchTag(
          'FinanceQrUnavailable',
          (): Effect.Effect<QrOrNone> => Effect.succeed(Option.none()),
        ),
        Effect.catchTag(
          'RpcClientError',
          (error): Effect.Effect<QrOrNone> =>
            Effect.logWarning(
              `Finance: failed to fetch payment QR for assignment ${event.assignment_id}`,
              error,
            ).pipe(Effect.as(Option.none())),
        ),
      ),
    ),
    Effect.bind('dmChannel', ({ rest }) => rest.createDm({ recipient_id: event.user_discord_id })),
    Effect.tap(({ rest, dmChannel, locale, qr }) => {
      const embed = buildPaymentReminderEmbed(
        event,
        locale,
        Option.map(qr, ({ spayd, imageUrl }) => ({ spayd, imageUrl })),
      );
      const components = buildPaymentReminderComponents(event.team_id, env.WEB_URL, locale);
      const post = Effect.suspend(() =>
        rest.createMessage(dmChannel.id, {
          embeds: [embed],
          components,
          allowed_mentions: { parse: [] },
        }),
      );
      return Option.match(qr, {
        onNone: () => post,
        onSome: ({ file }) => rest.withFiles([file])(post),
      });
    }),
    Effect.tap(({ rpc }) =>
      rpc['Finance/MarkReminderSent']({
        assignment_id: event.assignment_id,
        kind: event.kind,
      }),
    ),
    Effect.asVoid,
  );
