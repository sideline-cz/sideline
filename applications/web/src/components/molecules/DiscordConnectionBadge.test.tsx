// PR-9 — DiscordConnectionBadge is a pure state → Badge mapping. The one rule that matters:
// 'unknown' renders nothing.

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => key,
}));

const { DiscordConnectionBadge } = await import('./DiscordConnectionBadge.js');

describe('DiscordConnectionBadge', () => {
  it("renders nothing for 'unknown'", () => {
    const { container } = render(<DiscordConnectionBadge state='unknown' />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the connected badge with text, not colour-only', () => {
    render(<DiscordConnectionBadge state='connected' />);
    expect(screen.getByText('discord_connected')).not.toBeNull();
  });

  it('renders the not_connected badge with text, not colour-only', () => {
    render(<DiscordConnectionBadge state='not_connected' />);
    expect(screen.getByText('discord_notConnected')).not.toBeNull();
  });
});
