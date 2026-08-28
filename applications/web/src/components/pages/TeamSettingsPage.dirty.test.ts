// A source-text invariant, not a render test.
//
// `TeamSettingsPage` has several cards, each with its own Save button gated on
// its own `has*Changes` flag, and each posting its own payload. Nothing ties a
// field's *dirty flag* to the *handler that actually sends it*, so wiring a
// field to the wrong flag type-checks, renders, and looks completely normal —
// and produces a section you can edit but not save, while a different card's
// button lights up and posts a payload the edit is not in.
//
// That shipped: the rules-quiz fields were compared in `hasWelcomeChanges`
// while `handleSaveSettings` was the handler sending them, so editing them
// left the settings Save button disabled and enabled the welcome one, which
// silently discarded the change.
//
// The real fix is structural — one object per card, so a field cannot be
// compared against one flag and posted by another handler. Until that lands,
// this pins the fields most recently gotten wrong.
//
// `check-workspace-deps.mjs` is the precedent for guarding an invariant by
// scanning source text when the type system cannot express it.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'TeamSettingsPage.tsx'),
  'utf8',
);

/** The body of a `const <name> = ... ;` expression, up to the first `;` that
 * ends the declaration. Enough for these flat `a !== b || c !== d` chains. */
const declarationBody = (name: string): string => {
  const start = SOURCE.indexOf(`const ${name} =`);
  expect(start, `${name} not found — was it renamed?`).toBeGreaterThan(-1);
  const end = SOURCE.indexOf(';', start);
  return SOURCE.slice(start, end);
};

/** Fields the settings card owns: posted by `handleSaveSettings`, so they must
 * be what enables the settings card's own button. */
const SETTINGS_FIELDS = ['rulesQuizChannel', 'rulesQuizIntervalDays', 'rulesQuizTime'] as const;

describe('TeamSettingsPage dirty flags', () => {
  const settings = declarationBody('hasSettingsChanges');
  const welcome = declarationBody('hasWelcomeChanges');

  for (const field of SETTINGS_FIELDS) {
    it(`tracks ${field} in hasSettingsChanges, the flag on the button that saves it`, () => {
      expect(settings).toContain(field);
    });

    it(`does not track ${field} in hasWelcomeChanges, whose handler never sends it`, () => {
      expect(welcome).not.toContain(field);
    });
  }

  it('sends the rules-quiz fields from handleSaveSettings', () => {
    const handler = SOURCE.slice(
      SOURCE.indexOf('const handleSaveSettings'),
      SOURCE.indexOf('const handleSaveWelcome'),
    );
    expect(handler).toContain('rulesQuizChannelId:');
    expect(handler).toContain('rulesQuizIntervalDays:');
    expect(handler).toContain('rulesQuizTime:');
  });
});
