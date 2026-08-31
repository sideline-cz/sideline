// Should-fix 3 (review of 46806427, fix/discord-onboarding-webapp): the a11y fix (`aria-hidden`
// prop on `DiscordIcon`, see `DiscordIcon.tsx`'s doc comment) was applied to exactly one of three
// call sites that render the icon right next to adjacent visible/accessible text —
// `AppSidebar.discordIcon.test.ts` pins only the sidebar's `DiscordNavIcon` wrapper. `HomePage`'s
// "Sign in with Discord" button and `ConnectDiscordPage`'s header (which sits directly above the
// visible "Join the {team} Discord" title) still rendered the bare, self-announcing icon, so a
// screen reader said "Discord, Discord" there too.
//
// This is a source-text invariant, not a render test — same rationale as
// `AppSidebar.discordIcon.test.ts` and `TeamSettingsPage.dirty.test.ts`: scanning every current
// (and future) call site for the icon is cheaper and more durable than hand-picking components to
// render. Every call site in `src/` that renders `<DiscordIcon` (other than the atom's own
// definition and test files) is assumed to sit next to adjacent visible/accessible text — the
// project has no icon-only usage of this glyph today — and must pass `aria-hidden`.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ICON_FILE = join(dirname(fileURLToPath(import.meta.url)), 'DiscordIcon.tsx');

const DISCORD_ICON_JSX = /<DiscordIcon\b[^>]*\/>/g;

const collectSourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : collectSourceFiles(full);
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    if (/\.test\.(ts|tsx)$/.test(entry.name)) return [];
    if (full === ICON_FILE) return [];
    return [full];
  });

describe('every <DiscordIcon /> call site next to adjacent text passes aria-hidden', () => {
  const files = collectSourceFiles(SRC_DIR);

  it('found at least the known call sites (regex sanity check)', () => {
    const total = files.reduce(
      (sum, file) => sum + [...readFileSync(file, 'utf8').matchAll(DISCORD_ICON_JSX)].length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(3);
  });

  it('every call site passes aria-hidden', () => {
    const bare: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(DISCORD_ICON_JSX)) {
        if (!match[0].includes('aria-hidden')) {
          const line = content.slice(0, match.index).split('\n').length;
          bare.push(`${relative(SRC_DIR, file)}:${line} — "${match[0]}"`);
        }
      }
    }
    expect(bare).toEqual([]);
  });
});
