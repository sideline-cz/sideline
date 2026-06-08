import type { EmailRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect } from 'effect';
import { env } from '~/env.js';
import {
  buildApprovalComponents,
  buildApprovalEmbed,
  buildEmailDeepLink,
  buildOriginalEmbed,
  buildSummaryEmbed,
  buildTeamPostComponents,
} from '~/rest/email/buildEmailEmbeds.js';

// For email posts we default to Czech as the team locale is not available.
const LOCALE = 'cs' as const;

export const handleEmailPostEvent = (event: EmailRpcEvents.EmailPostEvent) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.flatMap(({ rest }) => {
      const deepLink = buildEmailDeepLink(env.WEB_URL, event.team_id, event.email_message_id);

      switch (event.kind) {
        case 'approval_request': {
          const embed = buildApprovalEmbed(event, LOCALE);
          const components = buildApprovalComponents(
            event.team_id,
            event.email_message_id,
            deepLink,
            LOCALE,
          );
          return rest
            .createMessage(event.coach_channel_id, {
              embeds: [embed],
              components,
              allowed_mentions: { parse: [] },
            })
            .pipe(Effect.asVoid);
        }
        case 'post_summary': {
          const embed = buildSummaryEmbed(event, LOCALE);
          const components = buildTeamPostComponents(deepLink, LOCALE);
          return rest
            .createMessage(event.target_channel_id, {
              embeds: [embed],
              components: components.length > 0 ? components : undefined,
              allowed_mentions: { parse: [] },
            })
            .pipe(Effect.asVoid);
        }
        case 'post_original': {
          const embed = buildOriginalEmbed(event, LOCALE);
          const components = buildTeamPostComponents(deepLink, LOCALE);
          return rest
            .createMessage(event.target_channel_id, {
              embeds: [embed],
              components: components.length > 0 ? components : undefined,
              allowed_mentions: { parse: [] },
            })
            .pipe(Effect.asVoid);
        }
        default: {
          // Exhaustive check — all cases should be handled above
          const _exhaustive: never = event.kind;
          return Effect.succeed(_exhaustive);
        }
      }
    }),
    Effect.asVoid,
  );
