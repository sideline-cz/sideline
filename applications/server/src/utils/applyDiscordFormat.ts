import { Option } from 'effect';

export const DEFAULT_ROLE_FORMAT = '{emoji} {name}';
export const DEFAULT_CHANNEL_FORMAT = '{emoji}\u2502{name}';
export const DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT = 'events-{discord_id}';

/** Apply a Discord name format template. When emoji is None, {emoji} is removed and separators are cleaned up. */
export const applyDiscordFormat = (
  template: string,
  name: string,
  emoji: Option.Option<string>,
): string => {
  const emojiStr = Option.getOrElse(emoji, () => '');
  if (emojiStr === '') {
    // Remove {emoji} and collapse adjacent whitespace into a single space
    const result = template
      .replace(/\s*\{emoji\}\s*/g, ' ')
      .replaceAll('{name}', name)
      .trim();
    // Clean any leading/trailing separator chars (│, |) left when emoji is absent
    return result.replace(/^[\u2502|]+|[\u2502|]+$/g, '').trim();
  }
  return template.replaceAll('{emoji}', emojiStr).replaceAll('{name}', name).trim();
};
