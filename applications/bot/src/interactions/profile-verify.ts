import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as Discord from 'dfx/types';
import { Effect, Metric } from 'effect';
import { buildProfileCompleteModal } from '~/commands/complete/modal.js';
import { type Locale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';

/**
 * The one entry `custom_id` used everywhere a "finish your profile" button appears:
 * the blocked-action ephemeral (Task 8), the welcome-embed field (Task 9) and the
 * read-only channel's pinned embed (Task 10). Exported so no caller ever retypes the
 * literal — the sync-loop reconcile in `~/rcp/onboarding/ProcessorService.ts` needs
 * it to recognise our own pinned message.
 */
export const VERIFY_BUTTON_ID = 'profile-verify';

/**
 * Builds that button. Built as a literal rather than through `UI.button()`: that helper's declared
 * return type widens `custom_id` back to `string | null | undefined` (a button can
 * be a URL button with no `custom_id` at all) even though this call always supplies
 * one — the literal keeps `custom_id` known-`string` for every caller.
 */
export const buildVerifyButton = (
  locale: Locale,
): Discord.ButtonComponentForMessageRequest & { readonly custom_id: string } => ({
  type: Discord.MessageComponentTypes.BUTTON,
  style: Discord.ButtonStyleTypes.PRIMARY,
  label: m.bot_verify_button({}, { locale }),
  custom_id: VERIFY_BUTTON_ID,
});

/**
 * Stateless entry button — `custom_id: 'profile-verify'` carries no data, so it is
 * safe to place on any number of public messages without a `custom_id` collision
 * (Discord rejects the WHOLE message with 50035 on a duplicate id). Responds `MODAL`
 * directly: a `MODAL` response cannot be deferred, so there is no RPC call and no
 * "already verified" pre-check here — the modal always opens, and
 * `Guild/CompleteMemberProfile` (via `ProfileCompleteModal`) already handles a
 * non-member or an already-complete member re-submitting, exactly as `/dokoncit` does.
 */
export const ProfileVerifyButton = Ix.messageComponent(
  Ix.id(VERIFY_BUTTON_ID),
  Effect.Do.pipe(
    Effect.tap(() =>
      Metric.update(
        Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'button' }),
        1,
      ),
    ),
    Effect.bind('interaction', () => Interaction.asEffect()),
    Effect.map(({ interaction }) => {
      const locale = userLocale(interaction);
      const guildId = interaction.guild_id;

      if (!guildId) {
        return Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: m.bot_complete_no_guild({}, { locale }),
            flags: Discord.MessageFlags.Ephemeral,
          },
        });
      }

      return Ix.response({
        type: Discord.InteractionCallbackTypes.MODAL,
        data: buildProfileCompleteModal(locale),
      });
    }),
    Effect.withSpan('interaction/profile-verify-button'),
  ),
);
