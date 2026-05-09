export const DISCORD_EMBED_DESCRIPTION_MAX = 4096;
const ZWSP = '​';

/**
 * Neuters @everyone / @here literals by inserting a zero-width space and
 * hard-truncates to DISCORD_EMBED_DESCRIPTION_MAX.
 */
export const sanitizeRendered = (rendered: string): string => {
  const neutered = rendered
    .replaceAll('@everyone', `@${ZWSP}everyone`)
    .replaceAll('@here', `@${ZWSP}here`);
  return neutered.length > DISCORD_EMBED_DESCRIPTION_MAX
    ? neutered.slice(0, DISCORD_EMBED_DESCRIPTION_MAX)
    : neutered;
};
