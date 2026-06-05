export function normalizeChannelName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Format a Discord channel name using the team's channel format template.
 * The template supports `{emoji}` and `{name}` placeholders.
 * The `{name}` placeholder receives the normalized (slug) form of `rawName`.
 * When emoji is empty, mirrors applyDiscordFormat: removes {emoji} and strips
 * leading/trailing separator chars (│, |) left when emoji is absent.
 */
export function formatChannelName(format: string, rawName: string, emoji: string): string {
  const normalizedName = normalizeChannelName(rawName);
  if (emoji === '') {
    // Remove {emoji} and collapse adjacent whitespace into a single space
    const result = format
      .replace(/\s*\{emoji\}\s*/g, ' ')
      .replaceAll('{name}', normalizedName)
      .trim();
    // Clean any leading/trailing separator chars (│, |) left when emoji is absent
    return result.replace(/^[│|]+|[│|]+$/g, '').trim();
  }
  return format.replaceAll('{emoji}', emoji).replaceAll('{name}', normalizedName).trim();
}
