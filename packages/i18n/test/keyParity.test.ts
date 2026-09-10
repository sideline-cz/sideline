import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// This package is Effect-free (see AGENTS.md) — plain vitest, synchronous assertions.
//
// The message catalogue has exactly two locale files (cs.json, en.json); there is no
// "third locale" concern. A new key landing in only one of the two files is otherwise
// undetected until someone renders it in the other locale and a placeholder/missing-key
// fallback ships silently (§8.5 residual risk: "New i18n keys land in only one of the two
// message files").

const readJson = (relativePath: string): Record<string, string> => {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
};

describe('i18n message catalogue — key parity between cs.json and en.json', () => {
  it('cs.json and en.json declare exactly the same set of keys', () => {
    const cs = readJson('../messages/cs.json');
    const en = readJson('../messages/en.json');

    // $schema (and any other non-message metadata key starting with $) is a Paraglide/inlang
    // convention key, not a translatable message — exclude it from the parity comparison.
    const messageKeys = (catalogue: Record<string, string>) =>
      Object.keys(catalogue)
        .filter((key) => !key.startsWith('$'))
        .sort();

    const csKeys = messageKeys(cs);
    const enKeys = messageKeys(en);

    expect(csKeys).toEqual(enKeys);
  });

  it('PR 2 all-day sentence variants exist in both locales', () => {
    const cs = readJson('../messages/cs.json');
    const en = readJson('../messages/en.json');

    for (const key of [
      'bot_rsvp_reminder_dm_all_day',
      'bot_claim_unclaimed_reminder_description_all_day',
    ]) {
      expect(Object.hasOwn(cs, key)).toBe(true);
      expect(Object.hasOwn(en, key)).toBe(true);
    }
  });
});
