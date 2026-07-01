// TDD mode — tests written BEFORE MemberSummaryHeader.tsx exists.
// These tests WILL FAIL until:
//   - applications/web/src/components/organisms/MemberSummaryHeader.tsx is implemented
//
// Component contract:
//   function MemberSummaryHeader(props: {
//     player: Roster.RosterPlayer;
//     canManageRoles: boolean;
//   }): JSX.Element
//
// Behaviour:
//   - Renders displayName and "@{username}"
//   - jerseyNumber Some(n) → "#{n}"; None → no "#" (em-dash or nothing)
//   - avatar Some → <img> with Discord CDN src containing discordId; None → initials fallback
//   - joinedAt → a joined label/text is rendered (via tr('members_joinedLabel', { date }))
//   - roleNames[0] rendered as primary badge; "+{n}" indicator when more roles exist
//   - permissions list rendered ONLY when canManageRoles is true

import { render, screen } from '@testing-library/react';
import { Option } from 'effect';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      members_joinedLabel: 'Joined {date}',
      members_permissionsTitle: 'Permissions',
      members_inactiveBadge: 'Inactive',
    };
    const template = map[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (_: string, k: string) => String(params[k] ?? `{${k}}`));
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: React.PropsWithChildren<{ to?: string; params?: Record<string, string> }>) => {
    const href = to
      ? to.replace(/\$(\w+)/g, (_: string, key: string) => params?.[key] ?? key)
      : '#';
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

// Radix Avatar's <img> only mounts after a real image-load event fires, which
// jsdom never dispatches. Mock the primitive with plain DOM elements so the
// test can assert on src/initials synchronously, matching how the project
// already stubs other Radix-portal-dependent primitives (see test/setup.ts).
vi.mock('~/components/ui/avatar', () => ({
  Avatar: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div data-slot='avatar' {...rest}>
      {children}
    </div>
  ),
  AvatarImage: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // biome-ignore lint/a11y/useAltText: alt is forwarded via {...props} from the real caller
    <img data-slot='avatar-image' {...props} />
  ),
  AvatarFallback: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <span data-slot='avatar-fallback' {...rest}>
      {children}
    </span>
  ),
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { MemberSummaryHeader } = await import('~/components/organisms/MemberSummaryHeader.js');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type RosterPlayerFixture = {
  memberId: string;
  userId: string;
  discordId: string;
  roleNames: ReadonlyArray<string>;
  permissions: ReadonlyArray<string>;
  name: Option.Option<string>;
  birthDate: Option.Option<string>;
  gender: Option.Option<'male' | 'female' | 'other'>;
  jerseyNumber: Option.Option<number>;
  username: string;
  avatar: Option.Option<string>;
  displayName: string;
  joinedAt: string;
};

function makePlayer(overrides: Partial<RosterPlayerFixture> = {}): RosterPlayerFixture {
  return {
    memberId: 'member-1',
    userId: 'user-1',
    discordId: '1234567890',
    roleNames: ['Captain'],
    permissions: ['member:view'],
    name: Option.some('Alice Doe'),
    birthDate: Option.none(),
    gender: Option.none(),
    jerseyNumber: Option.none(),
    username: 'alicedoe',
    avatar: Option.none(),
    displayName: 'Alice Doe',
    joinedAt: '2024-03-15T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemberSummaryHeader', () => {
  it('renders displayName and @username', () => {
    const player = makePlayer({ displayName: 'Alice Doe', username: 'alicedoe' });
    render(<MemberSummaryHeader player={player as never} canManageRoles={false} />);

    expect(screen.getByText('Alice Doe')).not.toBeNull();
    expect(screen.getByText('@alicedoe')).not.toBeNull();
  });

  it('jerseyNumber Some(7) → renders "#7"', () => {
    const player = makePlayer({ jerseyNumber: Option.some(7) });
    render(<MemberSummaryHeader player={player as never} canManageRoles={false} />);

    expect(screen.getByText('#7')).not.toBeNull();
  });

  it('jerseyNumber None → no "#" rendered (em-dash or absent)', () => {
    const player = makePlayer({ jerseyNumber: Option.none() });
    render(<MemberSummaryHeader player={player as never} canManageRoles={false} />);

    expect(screen.queryByText(/^#\d+$/)).toBeNull();
  });

  it('avatar Some → renders img with Discord CDN src containing discordId', () => {
    const player = makePlayer({
      discordId: '999888777',
      avatar: Option.some('abcdef123'),
    });
    render(<MemberSummaryHeader player={player as never} canManageRoles={false} />);

    const img = document.querySelector('img[data-slot="avatar-image"]');
    expect(img).not.toBeNull();
    const src = img?.getAttribute('src') ?? '';
    expect(src).toContain('cdn.discordapp.com');
    expect(src).toContain('999888777');
    expect(src).toContain('abcdef123');
  });

  it('avatar None → renders initials fallback instead of an img', () => {
    const player = makePlayer({ avatar: Option.none(), displayName: 'Bob Smith' });
    render(<MemberSummaryHeader player={player as never} canManageRoles={false} />);

    const img = document.querySelector('img[data-slot="avatar-image"]');
    expect(img).toBeNull();

    const fallback = document.querySelector('[data-slot="avatar-fallback"]');
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toMatch(/BS|BO/i);
  });

  it('joinedAt present → joined label/text is rendered', () => {
    const player = makePlayer({ joinedAt: '2024-03-15T00:00:00Z' });
    render(<MemberSummaryHeader player={player as never} canManageRoles={false} />);

    expect(screen.getByText(/Joined/)).not.toBeNull();
  });

  it('roleNames with multiple roles → primary badge + "+1" indicator', () => {
    const player = makePlayer({ roleNames: ['Captain', 'Striker'] });
    render(<MemberSummaryHeader player={player as never} canManageRoles={false} />);

    expect(screen.getByText('Captain')).not.toBeNull();
    expect(screen.getByText(/\+1/)).not.toBeNull();
    // Secondary role name should not be rendered as its own visible badge text
    expect(screen.queryByText('Striker')).toBeNull();
  });

  it('roleNames with a single role → no "+n" overflow indicator', () => {
    const player = makePlayer({ roleNames: ['Captain'] });
    render(<MemberSummaryHeader player={player as never} canManageRoles={false} />);

    expect(screen.getByText('Captain')).not.toBeNull();
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });

  it('canManageRoles=true → permissions list is visible', () => {
    const player = makePlayer({ permissions: ['member:view', 'member:edit'] });
    render(<MemberSummaryHeader player={player as never} canManageRoles={true} />);

    expect(screen.getByText('member:view')).not.toBeNull();
    expect(screen.getByText('member:edit')).not.toBeNull();
  });

  it('canManageRoles=false → permissions list is NOT in the DOM', () => {
    const player = makePlayer({ permissions: ['member:view', 'member:edit'] });
    render(<MemberSummaryHeader player={player as never} canManageRoles={false} />);

    expect(screen.queryByText('member:view')).toBeNull();
    expect(screen.queryByText('member:edit')).toBeNull();
  });

  it('isInactive=true → renders an Inactive badge', () => {
    const player = makePlayer();
    render(
      <MemberSummaryHeader player={player as never} canManageRoles={false} isInactive={true} />,
    );

    expect(screen.getByText('Inactive')).not.toBeNull();
  });

  it('isInactive=false (or omitted) → no Inactive badge rendered', () => {
    const player = makePlayer();
    render(<MemberSummaryHeader player={player as never} canManageRoles={false} />);

    expect(screen.queryByText('Inactive')).toBeNull();
  });
});
