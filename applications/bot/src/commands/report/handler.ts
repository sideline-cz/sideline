import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Array, Effect, Metric, Option, pipe } from 'effect';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import type { ReportType } from '~/services/githubIssue.js';

/** Anything other than the one literal Discord can send for the `feature`
 * choice is treated as a bug report — the safer default of the two, since a
 * mislabelled bug still gets read. */
export const reportTypeFromOption = (raw: Option.Option<string>): ReportType =>
  Option.getOrElse(raw, () => 'bug') === 'feature' ? 'feature' : 'bug';

export const reportHandler = Interaction.asEffect().pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'command' }),
      1,
    ),
  ),
  Effect.map((interaction) => {
    const locale = userLocale(interaction);

    const data = interaction.data;
    const options = data && 'options' in data ? [...(data.options ?? [])] : [];
    const type = reportTypeFromOption(
      pipe(
        options,
        Array.findFirst((o) => o.name === 'type'),
        Option.flatMap((o) => ('value' in o ? Option.some(String(o.value)) : Option.none())),
      ),
    );

    return Ix.response({
      type: DiscordTypes.InteractionCallbackTypes.MODAL,
      data: {
        custom_id: `report:${type}`,
        title:
          type === 'bug'
            ? m.bot_report_modal_title_bug({}, { locale })
            : m.bot_report_modal_title_feature({}, { locale }),
        components: [
          UI.row([
            UI.textInput({
              custom_id: 'report_title',
              label: m.bot_report_title_label({}, { locale }),
              style: DiscordTypes.TextInputStyleTypes.SHORT,
              required: true,
              placeholder:
                type === 'bug'
                  ? m.bot_report_title_placeholder_bug({}, { locale })
                  : m.bot_report_title_placeholder_feature({}, { locale }),
              max_length: 150,
            }),
          ]),
          UI.row([
            UI.textInput({
              custom_id: 'report_description',
              label: m.bot_report_description_label({}, { locale }),
              style: DiscordTypes.TextInputStyleTypes.PARAGRAPH,
              required: true,
              placeholder:
                type === 'bug'
                  ? m.bot_report_description_placeholder_bug({}, { locale })
                  : m.bot_report_description_placeholder_feature({}, { locale }),
              max_length: 3000,
            }),
          ]),
        ],
      },
    });
  }),
  Effect.withSpan('command/report'),
);
