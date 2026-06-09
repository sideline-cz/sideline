import type { EmailRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect } from 'effect';
import { env } from '~/env.js';
import {
  buildApprovalComponents,
  buildApprovalEmbeds,
  buildEmailDeepLink,
  buildOriginalEmbed,
  buildTeamPostComponents,
  buildTeamPostEmbed,
} from '~/rest/email/buildEmailEmbeds.js';

// For email posts we default to Czech as the team locale is not available.
const LOCALE = 'cs' as const;

export const handleEmailPostEvent = (event: EmailRpcEvents.EmailPostEvent) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.flatMap(({ rest }) => {
      switch (event.kind) {
        case 'approval_request': {
          const deepLink = buildEmailDeepLink(env.WEB_URL, event.team_id, event.email_message_id);
          const embeds = buildApprovalEmbeds(event, LOCALE);
          const components = buildApprovalComponents(
            event.team_id,
            event.email_message_id,
            deepLink,
            LOCALE,
          );
          return rest
            .createMessage(event.coach_channel_id, {
              embeds: [...embeds],
              components,
              allowed_mentions: { parse: [] },
            })
            .pipe(Effect.asVoid);
        }
        case 'post_summary': {
          const embed = buildTeamPostEmbed(event, LOCALE);
          const components = buildTeamPostComponents(event.team_id, event.email_message_id, LOCALE);
          return rest
            .createMessage(event.target_channel_id, {
              embeds: [embed],
              components,
              allowed_mentions: { parse: [] },
            })
            .pipe(Effect.asVoid);
        }
        case 'post_original': {
          const embed = buildOriginalEmbed(event, LOCALE);
          return rest
            .createMessage(event.target_channel_id, {
              embeds: [embed],
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
