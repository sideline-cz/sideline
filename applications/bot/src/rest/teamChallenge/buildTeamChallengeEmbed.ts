import type { Team, TeamChallenge } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import type * as Discord from 'dfx/types';
import { Option } from 'effect';
import type { Locale } from '~/locale.js';

const THROWING_COLOR = 0x10b981; // emerald-500
const SPORT_COLOR = 0xf59e0b; // amber-500

export type BuildTeamChallengeEmbedInput = {
  readonly title: TeamChallenge.TeamChallengeTitle;
  readonly kind: TeamChallenge.TeamChallengeKind;
  readonly description: Option.Option<TeamChallenge.TeamChallengeDescription>;
  readonly startDate: string; // "YYYY-MM-DD"
  readonly endDate: string; // "YYYY-MM-DD"
  readonly teamId: Team.TeamId;
  readonly webUrl: Option.Option<string>;
  readonly locale: Locale;
};

export const buildTeamChallengeEmbed = (input: BuildTeamChallengeEmbedInput): Discord.RichEmbed => {
  const { title, kind, description, startDate, endDate, teamId, webUrl, locale } = input;

  const embedTitle =
    kind === 'throwing'
      ? m.teamChallenge_embed_title_throwing({ title }, { locale })
      : m.teamChallenge_embed_title_sport({ title }, { locale });

  const kindLabel =
    kind === 'throwing'
      ? m.teamChallenge_embed_kind_throwing({}, { locale })
      : m.teamChallenge_embed_kind_sport({}, { locale });

  const fields: Array<Discord.RichEmbedField> = [
    {
      name: m.teamChallenge_embed_field_kind({}, { locale }),
      value: kindLabel,
      inline: true,
    },
    {
      name: m.teamChallenge_embed_field_period({}, { locale }),
      value: `${startDate} – ${endDate}`,
      inline: true,
    },
    ...Option.match(description, {
      onNone: () => [],
      onSome: (desc) => [{ name: title, value: desc, inline: false }],
    }),
  ];

  return {
    title: embedTitle,
    color: kind === 'throwing' ? THROWING_COLOR : SPORT_COLOR,
    fields,
    footer: { text: m.teamChallenge_embed_footer({}, { locale }) },
    ...Option.match(webUrl, {
      onNone: () => ({}),
      onSome: (url) => ({ url: `${url.replace(/\/$/, '')}/teams/${teamId}/challenges` }),
    }),
  };
};
