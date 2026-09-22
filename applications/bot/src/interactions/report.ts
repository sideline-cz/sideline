import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction, ModalSubmitData } from 'dfx/Interactions/index';
import * as Discord from 'dfx/types';
import { Effect, Metric, Option } from 'effect';
import { env } from '~/env.js';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { interactionUserId } from '~/schemas.js';
import { buildIssueBody, createIssue, type ReportType } from '~/services/githubIssue.js';
import { APP_VERSION } from '~/version.js';

/** `report:{type}` → the type. Mirrors the command's own fallback: anything
 * that is not exactly `feature` is a bug report. */
export const reportTypeFromCustomId = (customId: string): ReportType =>
  customId.split(':')[1] === 'feature' ? 'feature' : 'bug';

const modalValueOption = (
  submission: Discord.APIModalSubmission,
  customId: string,
): Option.Option<string> => {
  for (const row of submission.components ?? []) {
    if (row.type !== 1) continue;
    for (const comp of row.components) {
      if (comp.custom_id === customId) {
        return comp.value && comp.value.trim().length > 0
          ? Option.some(comp.value.trim())
          : Option.none();
      }
    }
  }
  return Option.none();
};

export const ReportModal = Ix.modalSubmit(
  Ix.idStartsWith('report:'),
  Effect.Do.pipe(
    Effect.tap(() =>
      Metric.update(
        Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'modal' }),
        1,
      ),
    ),
    Effect.bind('data', () => ModalSubmitData.asEffect()),
    Effect.bind('interaction', () => Interaction.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.flatMap(({ data, interaction, rest }) => {
      const locale = userLocale(interaction);

      const ephemeral = (content: string) =>
        Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content, flags: Discord.MessageFlags.Ephemeral },
        });

      // Reject before deferring: the user typed a report and deserves to be
      // told it went nowhere, not left with a silent "thinking…".
      if (Option.isNone(env.GITHUB_REPORT_TOKEN)) {
        return Effect.logWarning('/report submitted but GITHUB_REPORT_TOKEN is not set').pipe(
          Effect.as(ephemeral(m.bot_report_not_configured({}, { locale }))),
        );
      }
      const token = env.GITHUB_REPORT_TOKEN.value;

      const title = modalValueOption(data, 'report_title');
      if (Option.isNone(title)) {
        return Effect.succeed(ephemeral(m.bot_report_invalid_title({}, { locale })));
      }

      const description = modalValueOption(data, 'report_description');
      if (Option.isNone(description)) {
        return Effect.succeed(ephemeral(m.bot_report_invalid_description({}, { locale })));
      }

      const discordUserId = interactionUserId(interaction);
      const user = interaction.member?.user ?? interaction.user;

      const work = createIssue({
        repo: env.GITHUB_REPORT_REPO,
        token,
        type: reportTypeFromCustomId(data.custom_id),
        title: title.value,
        body: buildIssueBody({
          description: description.value,
          author: {
            displayName: user?.global_name ?? user?.username ?? 'unknown',
            discordUserId: Option.getOrElse(discordUserId, () => 'unknown'),
            guildId: Option.fromNullishOr(interaction.guild_id),
          },
          botVersion: APP_VERSION,
        }),
      }).pipe(
        Effect.map((url) => m.bot_report_success({ url }, { locale })),
        Effect.catchTag('GithubIssueError', (error) =>
          Effect.logError('Failed to create GitHub issue from /report', error).pipe(
            Effect.as(m.bot_report_error({}, { locale })),
          ),
        ),
        Effect.flatMap((content) =>
          rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
            payload: { content },
          }),
        ),
        Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
          Effect.logError('Failed to update report response', error),
        ),
        // Defensive backstop, same reasoning as `profile-complete`: a defect
        // anywhere above would leave the deferred ephemeral hanging on
        // "Sideline is thinking…" forever. This must always resolve it.
        Effect.catchCause((cause) =>
          Effect.logError('report: unexpected failure filing report', cause).pipe(
            Effect.andThen(
              rest
                .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
                  payload: { content: m.bot_report_error({}, { locale }) },
                })
                .pipe(
                  Effect.catchTag(
                    ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'],
                    (error) => Effect.logError('Failed to update report response', error),
                  ),
                ),
            ),
          ),
        ),
      );

      const deferred: Discord.CreateMessageInteractionCallbackRequest = {
        type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: Discord.MessageFlags.Ephemeral },
      };
      return Effect.as(Effect.forkDetach(work), deferred);
    }),
    Effect.withSpan('interaction/report-modal'),
  ),
);
