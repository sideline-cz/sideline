// TDD mode — tests written BEFORE resolveNoTeamRedirect.ts exists.
// These tests WILL FAIL until:
//   - applications/web/src/lib/auth/resolveNoTeamRedirect.ts is implemented
//
// Contract:
//   resolveNoTeamRedirect(opts: {
//     isGlobalAdmin: boolean;
//     hasOtherTeams: boolean;
//     wasViewing: boolean;
//   }): RedirectDescriptor
//
//   type RedirectDescriptor =
//     | { to: '/admin/onboarding-tokens' }
//     | { to: '/' }
//     | { to: '/no-team'; search?: { removed: 1 } }
//
// Decision table:
//   isGlobalAdmin && !hasOtherTeams → { to: '/admin/onboarding-tokens' }
//   hasOtherTeams (regardless of isGlobalAdmin) → { to: '/' }
//   else (non-admin, no teams, not viewing) → { to: '/no-team' }
//   else (non-admin, no teams, wasViewing)  → { to: '/no-team', search: { removed: 1 } }

import { describe, expect, it } from 'vitest';

// Dynamic import — will fail until the module exists
const { resolveNoTeamRedirect } = await import('./resolveNoTeamRedirect.js');

describe('resolveNoTeamRedirect', () => {
  it('global admin with no teams redirects to /admin/onboarding-tokens', () => {
    const result = resolveNoTeamRedirect({
      isGlobalAdmin: true,
      hasOtherTeams: false,
      wasViewing: false,
    });
    expect(result.to).toBe('/admin/onboarding-tokens');
  });

  it('global admin with no teams and wasViewing still redirects to /admin/onboarding-tokens', () => {
    // wasViewing is irrelevant when isGlobalAdmin && !hasOtherTeams
    const result = resolveNoTeamRedirect({
      isGlobalAdmin: true,
      hasOtherTeams: false,
      wasViewing: true,
    });
    expect(result.to).toBe('/admin/onboarding-tokens');
  });

  it('non-admin with no teams and not wasViewing redirects to /no-team with no search', () => {
    const result = resolveNoTeamRedirect({
      isGlobalAdmin: false,
      hasOtherTeams: false,
      wasViewing: false,
    });
    expect(result.to).toBe('/no-team');
    // search should be absent or empty
    expect((result as any).search?.removed).toBeUndefined();
  });

  it('non-admin with no teams and wasViewing redirects to /no-team with search.removed = 1', () => {
    const result = resolveNoTeamRedirect({
      isGlobalAdmin: false,
      hasOtherTeams: false,
      wasViewing: true,
    });
    expect(result.to).toBe('/no-team');
    expect((result as any).search).toEqual({ removed: 1 });
  });

  it('non-admin with hasOtherTeams redirects to /', () => {
    const result = resolveNoTeamRedirect({
      isGlobalAdmin: false,
      hasOtherTeams: true,
      wasViewing: false,
    });
    expect(result.to).toBe('/');
  });

  it('non-admin with hasOtherTeams and wasViewing still redirects to /', () => {
    const result = resolveNoTeamRedirect({
      isGlobalAdmin: false,
      hasOtherTeams: true,
      wasViewing: true,
    });
    expect(result.to).toBe('/');
  });

  it('global admin with hasOtherTeams redirects to / (teams presence overrides admin flag)', () => {
    // Having other teams takes priority over the global-admin onboarding redirect
    const result = resolveNoTeamRedirect({
      isGlobalAdmin: true,
      hasOtherTeams: true,
      wasViewing: false,
    });
    expect(result.to).toBe('/');
  });
});
