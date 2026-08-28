import { Schema } from 'effect';
import { DfxGuild } from '~/schemas.js';

export type Locale = 'en' | 'cs';

/** For permanent messages (visible to whole guild): use guild language */
export const guildLocale = (interaction: { guild_locale?: string }): Locale =>
  interaction.guild_locale?.startsWith('cs') ? 'cs' : 'en';

/**
 * The locale of a raw `getGuild` response.
 *
 * Sync handlers have no interaction to read `guild_locale` off, so a permanent
 * message posted from the outbox has to fetch the guild and read
 * `preferred_locale` instead. An undecodable response falls back to English
 * rather than throwing: Discord adding or changing a field must not stop a
 * team's scheduled post from going out.
 */
export const guildLocaleFromRaw = (raw: unknown): Locale => {
  try {
    return guildLocale({ guild_locale: Schema.decodeUnknownSync(DfxGuild)(raw).preferred_locale });
  } catch {
    return 'en';
  }
};

/** For ephemeral messages (visible only to user): use user's Discord client language */
export const userLocale = (interaction: { locale?: string; guild_locale?: string }): Locale =>
  (interaction.locale?.startsWith('cs') ? 'cs' : undefined) ?? guildLocale(interaction);
