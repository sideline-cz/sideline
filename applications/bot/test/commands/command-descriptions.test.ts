import { describe, expect, it } from 'vitest';
import { commandBuilder } from '~/commands/index.js';

// Discord caps slash-command and option `description` (and every
// `description_localizations` entry) at 100 characters. The registration is an
// atomic bulk overwrite, so ONE over-length description makes Discord reject the
// entire command set with a 400 — which both prevents all commands from
// registering and crash-loops the bot at startup. TypeScript can't catch this,
// so this test walks the registered command definitions and enforces the limit.
const DISCORD_DESCRIPTION_LIMIT = 100;

type Found = { readonly path: string; readonly value: string };

const collectDescriptions = (root: unknown): Array<Found> => {
  const out: Array<Found> = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        walk(v, `${path}[${i}]`);
      });
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'description' && typeof value === 'string') {
        out.push({ path: `${path}.description`, value });
      } else if (
        key === 'description_localizations' &&
        value !== null &&
        typeof value === 'object'
      ) {
        for (const [loc, locValue] of Object.entries(value as Record<string, unknown>)) {
          if (typeof locValue === 'string') {
            out.push({ path: `${path}.description_localizations.${loc}`, value: locValue });
          }
        }
      } else if (typeof value === 'object') {
        walk(value, `${path}.${key}`);
      }
    }
  };
  walk(root, 'commandBuilder');
  return out;
};

describe('slash command descriptions', () => {
  const descriptions = collectDescriptions(commandBuilder);

  it('finds command descriptions to validate (guards against a no-op walk)', () => {
    expect(descriptions.length).toBeGreaterThan(0);
  });

  it("keeps every command/option description within Discord's 100-char limit", () => {
    const tooLong = descriptions
      .filter((d) => d.value.length > DISCORD_DESCRIPTION_LIMIT)
      .map((d) => `${d.path} = ${d.value.length} chars`);
    expect(tooLong).toEqual([]);
  });
});
