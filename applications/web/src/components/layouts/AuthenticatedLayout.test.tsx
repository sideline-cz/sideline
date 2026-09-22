// PR-9 test list item 22 — AuthenticatedLayout no longer renders PendingDiscordJoinBanner
// (CC-11: the banner is retired, replaced by DiscordConnectCard + the connect-discord
// interstitial + the sidebar badge).
//
// `CommandPalette` is intentionally NOT mocked out in this file (unlike most consumers of this
// layout) — the whole point of the tests below is to exercise `AuthenticatedLayoutContent`'s
// own `onSelectHit` per-kind navigation switch and `onAskAssistant` hand-off (:145-183), which
// only run when the real palette drives them. A mocked-out palette (as most other suites do,
// see `CommandPalette.test.tsx`'s own header) would leave a swapped param — e.g. the `member`
// branch reading `hit.event.eventId` — invisible to the whole suite.

import {
  type AiChatApi,
  EventApi,
  GroupApi,
  Roster,
  SearchApi,
  TrainingTypeApi,
} from '@sideline/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DateTime, Effect, Option, Schema } from 'effect';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// cmdk scrolls the highlighted row into view on every highlight change; jsdom does not
// implement `scrollIntoView` — same polyfill as `CommandPalette.test.tsx`.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

vi.mock('~/lib/translations.js', () => ({ tr: (key: string) => key }));

vi.mock('~/hooks/use-mobile.js', () => ({
  useIsMobile: vi.fn(() => false),
}));

// Same workaround as `AssistantResultCard.test.tsx` / `CommandPalette.test.tsx`: Radix
// `Avatar.Image` never fires a load event in jsdom, and the palette renders member rows through
// the real `AssistantResultCard`.
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

// `navigateSpy` must be a SINGLE stable spy across every render — `useNavigate: () => vi.fn()`
// would hand `AuthenticatedLayoutContent` a fresh, never-called mock on every re-render, making
// every assertion below vacuously pass regardless of what the component actually did.
const { navigateSpy, mockSearch } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  mockSearch: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    ...rest
  }: React.PropsWithChildren<{ to: string; params?: Record<string, unknown> }>) => {
    const href = String(to).replace(/\$([a-zA-Z]+)/g, (whole: string, key: string) =>
      params && key in params ? String(params[key]) : whole,
    );
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
  Outlet: () => <div data-testid='outlet' />,
  useMatches: () => [],
  useNavigate: () => navigateSpy,
  useRouter: () => ({ subscribe: () => () => undefined }),
}));

const mockRun = () => (effect: Effect.Effect<unknown, unknown>) =>
  Effect.runPromise(Effect.option(effect));

vi.mock('~/lib/runtime', () => ({
  ApiClient: { asEffect: () => Effect.succeed({ search: { search: mockSearch } }) },
  ClientError: { make: (message: string) => ({ _tag: 'ClientError', message }) },
  SilentClientError: class SilentClientError {
    readonly _tag = 'SilentClientError';
    props: { message: string };
    constructor(props: { message: string }) {
      this.props = props;
    }
  },
  useRun: () => mockRun,
}));

vi.mock('~/components/layouts/AppSidebar', () => ({
  AppSidebar: () => <div data-testid='app-sidebar' />,
}));

vi.mock('~/components/molecules/PwaInstallPrompt.js', () => ({
  PwaInstallPrompt: () => null,
}));

vi.mock('~/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SidebarInset: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SidebarTrigger: () => <button type='button'>trigger</button>,
  useSidebar: () => ({ setOpenMobile: () => undefined }),
}));

const { AuthenticatedLayout } = await import('./AuthenticatedLayout.js');

const user = {
  id: 'user-1',
  discordId: '1',
  username: 'test',
  avatar: { _tag: 'None' as const },
  isProfileComplete: true,
  name: { _tag: 'None' as const },
  birthDate: { _tag: 'None' as const },
  gender: { _tag: 'None' as const },
  locale: 'en' as const,
  isGlobalAdmin: false,
  displayName: 'Test User',
};

const TEAM_ID = 'team-1';

const team = {
  teamId: TEAM_ID,
  teamName: 'Ultimate Praha',
  logoUrl: { _tag: 'None' as const },
  roleNames: [],
  permissions: [],
  discordJoined: 'not_connected' as const,
};

// ---------------------------------------------------------------------------
// Fixtures — real `Schema.Class` instances, mirroring `CommandPalette.test.tsx`.
// ---------------------------------------------------------------------------

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${idCounter++}`;

function eventHit(title: string): AiChatApi.SearchHit {
  const eventId = nextId('event');
  return {
    kind: 'event',
    event: new EventApi.EventInfo({
      eventId: eventId as any,
      teamId: TEAM_ID as any,
      title,
      eventType: 'training',
      trainingTypeName: Option.none(),
      eventTypeId: Option.none() as any,
      eventTypeName: Option.none<Option.Option<string>>(),
      eventTypeColor: Option.none() as any,
      description: Option.none(),
      imageUrl: Option.none(),
      startAt: DateTime.makeUnsafe('2026-05-12T18:00:00.000Z'),
      endAt: Option.some(DateTime.makeUnsafe('2026-05-12T19:30:00.000Z')),
      location: Option.none(),
      locationUrl: Option.none(),
      status: 'active',
      allDay: false,
      seriesId: Option.none(),
      startDate: Option.some('2026-05-12'),
      endDate: Option.some('2026-05-12'),
    }),
  };
}

function memberHit(displayName: string): AiChatApi.SearchHit {
  return {
    kind: 'member',
    memberId: nextId('member') as any,
    displayName,
    avatarUrl: Option.none(),
    jerseyNumber: Option.none(),
    roleNames: [],
    effectiveRoles: [],
    active: true,
  };
}

function groupHit(name: string): AiChatApi.SearchHit {
  return {
    kind: 'group',
    group: new GroupApi.GroupInfo({
      groupId: nextId('group') as any,
      teamId: TEAM_ID as any,
      parentId: Option.none(),
      name,
      emoji: Option.none(),
      color: Option.none(),
      memberCount: 10,
      discordChannelProvisioning: false,
    }),
  };
}

function rosterHit(name: string): AiChatApi.SearchHit {
  return {
    kind: 'roster',
    roster: new Roster.RosterInfo({
      rosterId: nextId('roster') as any,
      teamId: TEAM_ID as any,
      name,
      active: true,
      memberCount: 15,
      createdAt: '2026-01-01T00:00:00.000Z',
      color: Option.none(),
      emoji: Option.none(),
      discordChannelId: Option.none(),
      discordChannelName: Option.none(),
      discordChannelProvisioning: false,
    }),
  };
}

function trainingTypeHit(name: string): AiChatApi.SearchHit {
  return {
    kind: 'trainingType',
    trainingType: new TrainingTypeApi.TrainingTypeInfo({
      trainingTypeId: nextId('tt') as any,
      teamId: TEAM_ID as any,
      name,
      ownerGroupName: Option.none(),
      memberGroupName: Option.none(),
    }),
  };
}

// Round-trips through the real wire schema, same guard `CommandPalette.test.tsx` uses.
function hitThroughWire(hit: AiChatApi.SearchHit): AiChatApi.SearchHit {
  const encoded = Schema.encodeSync(Schema.Array(SearchApi.SearchHit))([hit]);
  const [decoded] = Schema.decodeUnknownSync(Schema.Array(SearchApi.SearchHit))(encoded);
  // biome-ignore lint/style/noNonNullAssertion: a one-element round-trip always has index 0
  return decoded!;
}

function renderLayout() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthenticatedLayout
        user={user as never}
        teams={[team as never]}
        activeTeam={team as never}
        onLogout={() => undefined}
      />
    </QueryClientProvider>,
  );
}

async function openPalette() {
  fireEvent.click(screen.getByRole('button', { name: /search_title/ }));
}

async function search(term: string) {
  const input = screen.getByRole('combobox') as HTMLInputElement;
  fireEvent.change(input, { target: { value: term } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}

beforeEach(() => {
  idCounter = 0;
  navigateSpy.mockReset();
  mockSearch.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.removeAttribute('data-scroll-locked');
});

describe('AuthenticatedLayout', () => {
  it('does not render PendingDiscordJoinBanner (CC-11 — retired)', () => {
    renderLayout();
    // The banner rendered a `role='status'` strip with `invite_joinDiscordBannerDescription` /
    // `discord_connect_*` copy directly under the sidebar; none of it exists anymore, and there
    // is no dismiss-only strip immediately above the outlet.
    expect(screen.queryByText('invite_joinDiscordBannerDescription')).toBeNull();
    expect(screen.getByTestId('outlet')).not.toBeNull();
    expect(screen.getByTestId('app-sidebar')).not.toBeNull();
  });

  describe('search palette navigation (plan §F.6 rows 15/16 — the layout-level switch)', () => {
    const kindCases: ReadonlyArray<{
      kind: string;
      build: () => AiChatApi.SearchHit;
      label: string;
      to: string;
      idField: string;
    }> = [
      {
        kind: 'event',
        build: () => eventHit('Layout event'),
        label: 'Layout event',
        to: '/teams/$teamId/events/$eventId',
        idField: 'eventId',
      },
      {
        kind: 'member',
        build: () => memberHit('Layout member'),
        label: 'Layout member',
        to: '/teams/$teamId/members/$memberId',
        idField: 'memberId',
      },
      {
        kind: 'group',
        build: () => groupHit('Layout group'),
        label: 'Layout group',
        to: '/teams/$teamId/groups/$groupId',
        idField: 'groupId',
      },
      {
        kind: 'roster',
        build: () => rosterHit('Layout roster'),
        label: 'Layout roster',
        to: '/teams/$teamId/rosters/$rosterId',
        idField: 'rosterId',
      },
      {
        kind: 'trainingType',
        build: () => trainingTypeHit('Layout training type'),
        label: 'Layout training type',
        to: '/teams/$teamId/training-types/$trainingTypeId',
        idField: 'trainingTypeId',
      },
    ];

    for (const { kind, build, label, to, idField } of kindCases) {
      it(`selecting a ${kind} hit navigates to ${to} with exactly that hit's id`, async () => {
        const hit = build();
        const wired = hitThroughWire(hit);
        mockSearch.mockReturnValueOnce(Effect.succeed([wired]));
        renderLayout();

        await openPalette();
        await search(label);

        const row = await waitFor(() => screen.getByText(label));
        const option = row.closest('[role="option"]');
        expect(option).not.toBeNull();
        // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
        fireEvent.click(option!);

        expect(navigateSpy).toHaveBeenCalledTimes(1);
        const call = navigateSpy.mock.calls[0]?.[0];
        expect(call.to).toBe(to);

        let expectedId: string;
        switch (wired.kind) {
          case 'event':
            expectedId = wired.event.eventId;
            break;
          case 'member':
            expectedId = wired.memberId;
            break;
          case 'group':
            expectedId = wired.group.groupId;
            break;
          case 'roster':
            expectedId = wired.roster.rosterId;
            break;
          case 'trainingType':
            expectedId = wired.trainingType.trainingTypeId;
            break;
        }
        expect(call.params).toEqual({ teamId: TEAM_ID, [idField]: expectedId });

        // Selecting a hit closes the palette — the dialog must not still be open afterwards.
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    }

    it('asking the assistant navigates to the assistant route with the trimmed question in search.ask', async () => {
      renderLayout();

      await openPalette();
      await search('what is going on with the team?');

      const label = await waitFor(() => screen.getByText('search_askAssistant'));
      const option = label.closest('[role="option"]');
      expect(option).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
      fireEvent.click(option!);

      expect(navigateSpy).toHaveBeenCalledTimes(1);
      const call = navigateSpy.mock.calls[0]?.[0];
      expect(call.to).toBe('/teams/$teamId/assistant');
      expect(call.params).toEqual({ teamId: TEAM_ID });
      expect(call.search).toEqual({ ask: 'what is going on with the team?' });
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});
