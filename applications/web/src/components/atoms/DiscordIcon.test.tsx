// "Also fix" item (whole-series review, fix/discord-onboarding-webapp): `DiscordIcon` always
// carried `role='img' aria-label='Discord'`, even at call sites (`AppSidebar`'s nav item) that
// render the same word as visible text right next to it — a screen reader announced
// "Discord, Discord" for that one nav entry. The `aria-hidden` prop lets a call site with
// adjacent accessible text opt out of the icon's own announcement.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DiscordIcon } from './DiscordIcon.js';

describe('DiscordIcon', () => {
  it('announces itself by default (role=img, aria-label=Discord)', () => {
    const { container } = render(<DiscordIcon />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe('Discord');
    expect(svg?.hasAttribute('aria-hidden')).toBe(false);
  });

  it('is silent to a screen reader, and drops the label, when aria-hidden is set', () => {
    const { container } = render(<DiscordIcon aria-hidden />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.hasAttribute('role')).toBe(false);
    expect(svg?.hasAttribute('aria-label')).toBe(false);
  });
});
