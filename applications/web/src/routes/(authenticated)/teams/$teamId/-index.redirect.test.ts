// PR-9 test list items 15-18 — the dashboard-index redirect to `/teams/$teamId/connect-discord`.
// Exercises `Route.options.beforeLoad` directly (no route tree / router needed): it's a plain
// function that either returns or `throw`s a TanStack `redirect()` Response.

import { isRedirect } from '@tanstack/react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({ tr: (key: string) => key }));

const { Route } = await import('./index.js');

const USER_ID = 'user-1';
const TEAM_ID = 'team-1';

const baseTeam = {
  teamId: TEAM_ID,
  teamName: 'Ultimate Praha',
  logoUrl: { _tag: 'None' as const },
  roleNames: [],
  permissions: [],
};

const runBeforeLoad = async (opts: {
  readonly discordJoined: 'connected' | 'not_connected' | 'unknown';
  readonly isProfileComplete?: boolean;
}) => {
  const beforeLoad = Route.options.beforeLoad;
  if (beforeLoad === undefined) throw new Error('beforeLoad is not defined');
  return beforeLoad({
    context: {
      user: { id: USER_ID, isProfileComplete: opts.isProfileComplete ?? true },
      teams: [{ ...baseTeam, discordJoined: opts.discordJoined }],
    },
    params: { teamId: TEAM_ID },
  } as never);
};

describe('teams/$teamId/index beforeLoad — Discord connect redirect (PR-9)', () => {
  it('test 15 — redirects when not_connected and not snoozed', async () => {
    localStorage.clear();
    let caught: unknown;
    try {
      await runBeforeLoad({ discordJoined: 'not_connected' });
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);
    expect((caught as { options: { to: string } }).options.to).toBe(
      '/teams/$teamId/connect-discord',
    );
  });

  it('test 16 — does NOT redirect when unknown', async () => {
    localStorage.clear();
    const result = await runBeforeLoad({ discordJoined: 'unknown' });
    expect(result).toBeUndefined();
  });

  it('does NOT redirect when connected', async () => {
    localStorage.clear();
    const result = await runBeforeLoad({ discordJoined: 'connected' });
    expect(result).toBeUndefined();
  });

  it('test 17 — does not redirect while snoozed', async () => {
    localStorage.clear();
    localStorage.setItem(
      `sideline:discord-connect-snoozed:${USER_ID}:${TEAM_ID}`,
      String(Date.now() + 60_000),
    );
    const result = await runBeforeLoad({ discordJoined: 'not_connected' });
    expect(result).toBeUndefined();
  });

  it('test 18 — a localStorage throw is treated as snoozed (no redirect loop)', async () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: () => {
          throw new DOMException('SecurityError');
        },
        setItem: () => {},
      },
      writable: true,
      configurable: true,
    });
    const result = await runBeforeLoad({ discordJoined: 'not_connected' });
    expect(result).toBeUndefined();
    Object.defineProperty(globalThis, 'localStorage', {
      value: original,
      writable: true,
      configurable: true,
    });
  });

  it('the isProfileComplete redirect still wins and runs first', async () => {
    localStorage.clear();
    let caught: unknown;
    try {
      await runBeforeLoad({ discordJoined: 'not_connected', isProfileComplete: false });
    } catch (e) {
      caught = e;
    }
    expect(isRedirect(caught)).toBe(true);
    expect((caught as { options: { to: string } }).options.to).toBe('/profile/complete');
  });
});
