import { describe, expect, it } from 'vitest';
import { DISCORD_EMBED_DESCRIPTION_MAX, sanitizeRendered } from '../src/sanitize.js';

// The zero-width space character inserted by sanitizeRendered
const ZWSP = '​';

describe('sanitizeRendered', () => {
  it('@everyone literal in input → neutered with zero-width space', () => {
    const result = sanitizeRendered('Hello @everyone!');
    expect(result).not.toContain('@everyone');
    expect(result).toContain(`@${ZWSP}everyone`);
  });

  it('@here literal → neutered with zero-width space', () => {
    const result = sanitizeRendered('Hey @here what is up');
    expect(result).not.toContain('@here');
    expect(result).toContain(`@${ZWSP}here`);
  });

  it('legitimate user mention <@123> left alone', () => {
    const result = sanitizeRendered('Welcome <@123>!');
    expect(result).toContain('<@123>');
  });

  it('content > 4096 chars → hard-truncated to exactly 4096', () => {
    const input = 'a'.repeat(DISCORD_EMBED_DESCRIPTION_MAX + 100);
    const result = sanitizeRendered(input);
    expect(result.length).toBe(DISCORD_EMBED_DESCRIPTION_MAX);
  });

  it('content == 4096 chars → unchanged length', () => {
    const input = 'b'.repeat(DISCORD_EMBED_DESCRIPTION_MAX);
    const result = sanitizeRendered(input);
    expect(result.length).toBe(DISCORD_EMBED_DESCRIPTION_MAX);
  });
});
