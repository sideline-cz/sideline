import type { FinanceRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect } from 'effect';
import { env } from '~/env.js';
import { guildLocaleFromRaw, type Locale } from '~/locale.js';
import {
  buildBankTokenExpiringComponents,
  buildBankTokenExpiringEmbed,
} from './buildBankTokenExpiringEmbed.js';

/**
 * T10b — DMs the treasurer that the team's Fio token expires in `days_until_expiry` days
 * (emitted at T−14 / T−7 / T−1 by the server's `BankTokenExpiryCron`, one outbox row per
 * threshold). Unlike the payment reminder, there is no bot-side "sent" idempotency step — the
 * outbox row itself is the idempotency boundary (`bank_token_expiry_events`), so this handler
 * only DMs and lets `ProcessorService` ack via `Finance/MarkBankTokenExpiryProcessed`.
 */
export const handleBankTokenExpiring = (event: FinanceRpcEvents.BankTokenExpiringEvent) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    // Same guild-locale fallback as the payment reminder DM — no interaction to read a client
    // locale off, so fall back to the guild's `preferred_locale`, defaulting to Czech on failure.
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
    Effect.bind('dmChannel', ({ rest }) => rest.createDm({ recipient_id: event.user_discord_id })),
    Effect.tap(({ rest, dmChannel, locale }) => {
      const embed = buildBankTokenExpiringEmbed(event, locale);
      const components = buildBankTokenExpiringComponents(event.team_id, env.WEB_URL, locale);
      return Effect.suspend(() =>
        rest.createMessage(dmChannel.id, {
          embeds: [embed],
          components,
          allowed_mentions: { parse: [] },
        }),
      );
    }),
    Effect.asVoid,
  );
