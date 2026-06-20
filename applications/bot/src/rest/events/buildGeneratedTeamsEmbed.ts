import type { EventRpcEvents } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import type * as Discord from 'dfx/types';
import { Array, pipe } from 'effect';
import type { Locale } from '~/locale.js';
import { EMBED_FIELD_VALUE_LIMIT } from '../utils.js';

const TRAINING_COLOR = 0x57f287; // green

/**
 * Builds a RichEmbed for the `teams_generated` sync event.
 * Each team gets one (or more, if long) inline field.
 * Calibrating members are prefixed with the `~` marker.
 * Gender is intentionally omitted for privacy.
 */
export const buildGeneratedTeamsEmbed = (
  event: Pick<EventRpcEvents.TeamsGeneratedEvent, 'title' | 'teams'>,
  locale: Locale,
): Discord.RichEmbed => {
  const totalPlayers = pipe(
    event.teams,
    Array.map((t) => t.members.length),
    Array.reduce(0, (acc, n) => acc + n),
  );

  // Elo difference between the first two teams (best-effort: 0 when < 2 teams)
  const eloDiff =
    event.teams.length >= 2
      ? Math.abs(Math.round((event.teams[0].avg_rating ?? 0) - (event.teams[1].avg_rating ?? 0)))
      : 0;

  const title = m.bot_teamGen_title({ title: event.title }, { locale });
  const description = m.bot_teamGen_summary(
    { count: String(totalPlayers), diff: String(eloDiff) },
    { locale },
  );

  const calibratingMarker = m.bot_teamGen_calibratingMarker({}, { locale });

  const fields: Discord.RichEmbedField[] = [];

  for (const team of event.teams) {
    const fieldName = `${team.name} — Ø ${Math.round(team.avg_rating)}`;

    const lines = pipe(
      team.members,
      Array.map((member) => {
        const prefix = member.is_calibrating ? calibratingMarker : '';
        return `• ${prefix}${member.display_name} (${Math.round(member.rating)})`;
      }),
    );

    // Chunk into multiple fields if necessary to respect the 1024-char field limit
    const chunks: string[] = [];
    let current = '';
    for (const line of lines) {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length > EMBED_FIELD_VALUE_LIMIT) {
        if (current) chunks.push(current);
        current = line;
      } else {
        current = candidate;
      }
    }
    if (current) chunks.push(current);

    for (let i = 0; i < chunks.length; i++) {
      fields.push({
        name: i === 0 ? fieldName : `${fieldName} (${i + 1})`,
        value: chunks[i],
        inline: true,
      });
    }
  }

  return {
    title,
    description,
    color: TRAINING_COLOR,
    fields,
  };
};
