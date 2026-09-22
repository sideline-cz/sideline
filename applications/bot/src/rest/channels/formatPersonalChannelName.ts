/** Slugify a member display name into a Discord-channel-safe fragment. */
const slugify = (value: string): string => {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return slug.length > 0 ? slug : 'member';
};

const BUCKET_SUFFIX: Record<string, string> = {
  training: '-trainings',
  tournament: '-tournaments',
  other: '-others',
};

const MAX_CHANNEL_NAME = 100;

/**
 * Apply a team's personal-events channel-name template. Supported placeholders:
 * `{name}` (slugified member display name) and `{discord_id}`. Discord normalises
 * channel names further on creation; we cap length and guarantee a non-empty result.
 *
 * `bucket` (Nastavitelná docházka, plan §7.1/B2) appends a fixed ASCII suffix for the
 * split channel modes; `'all'` (the default) appends nothing and is byte-identical to
 * today's 3-argument output — that identity is load-bearing (see plan §4.2) and pinned
 * by a unit test.
 *
 * The suffix is reserved BEFORE slicing, not appended after. Appending first and
 * slicing after would let a long base truncate '-trainings' and '-tournaments' down
 * to the same 100-char string once the base gets long enough — two Discord channels
 * with identical names, which `uq_personal_event_channels_discord_channel` does NOT
 * catch (the snowflakes differ, only the names collide).
 */
export const formatPersonalChannelName = (
  template: string,
  name: string,
  discordId: string,
  bucket = 'all',
): string => {
  const suffix = BUCKET_SUFFIX[bucket] ?? '';
  const base = template.replaceAll('{name}', slugify(name)).replaceAll('{discord_id}', discordId);
  // Fall back on the BASE, not on base+suffix: a template that renders empty would
  // otherwise yield '-trainings' for every member of the team (length > 0, so this
  // fallback would never fire, and the whole team collides on one name per bucket).
  const safeBase = base.length > 0 ? base : `events-${discordId}`;
  return safeBase.slice(0, MAX_CHANNEL_NAME - suffix.length) + suffix;
};
