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

/**
 * Apply a team's personal-events channel-name template. Supported placeholders:
 * `{name}` (slugified member display name) and `{discord_id}`. Discord normalises
 * channel names further on creation; we cap length and guarantee a non-empty result.
 */
export const formatPersonalChannelName = (
  template: string,
  name: string,
  discordId: string,
): string => {
  const result = template.replaceAll('{name}', slugify(name)).replaceAll('{discord_id}', discordId);
  const trimmed = result.slice(0, 100);
  return trimmed.length > 0 ? trimmed : `events-${discordId}`;
};
