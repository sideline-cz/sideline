// A source-text invariant, not a render test — see `TeamSettingsPage.dirty.test.ts` for the
// precedent of guarding an invariant by scanning source text when a full render is impractical
// (`AppSidebar` needs `SidebarProvider` context plus `TeamSwitcher`/`NavUser`'s own data
// dependencies, none of which this invariant is about).
//
// "Also fix" item (whole-series review, fix/discord-onboarding-webapp): the Discord nav item
// pairs `DiscordIcon` with the adjacent visible label `tr('discord_navTitle')`
// (`<item.icon /><span>{item.title}</span>`) — `DiscordIcon`'s default
// `role='img' aria-label='Discord'` announces "Discord, Discord" to a screen reader there. The
// fix is `DiscordNavIcon`, a wrapper rendering `<DiscordIcon aria-hidden />`, wired in as the nav
// item's `icon`. This pins both halves: the nav item must reference the wrapper (not the bare,
// self-announcing icon), and the wrapper must actually pass `aria-hidden`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'AppSidebar.tsx'),
  'utf8',
);

describe('AppSidebar Discord nav icon', () => {
  it('wires the Discord nav item through the aria-hidden wrapper, not the bare icon', () => {
    expect(SOURCE).toContain('icon: DiscordNavIcon');
    expect(SOURCE).not.toContain('icon: DiscordIcon');
  });

  it('the wrapper actually renders DiscordIcon with aria-hidden', () => {
    const wrapper = SOURCE.slice(
      SOURCE.indexOf('function DiscordNavIcon'),
      SOURCE.indexOf('interface NavItem'),
    );
    expect(wrapper).toContain('<DiscordIcon aria-hidden />');
  });
});
