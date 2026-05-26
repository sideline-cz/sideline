type RedirectDescriptor =
  | { to: '/admin/onboarding-tokens' }
  | { to: '/' }
  | { to: '/no-team'; search?: { removed: 1 } };

interface ResolveNoTeamRedirectOptions {
  readonly isGlobalAdmin: boolean;
  readonly hasOtherTeams: boolean;
  readonly wasViewing: boolean;
}

export const resolveNoTeamRedirect = (opts: ResolveNoTeamRedirectOptions): RedirectDescriptor => {
  if (opts.hasOtherTeams) {
    return { to: '/' };
  }
  if (opts.isGlobalAdmin) {
    return { to: '/admin/onboarding-tokens' };
  }
  if (opts.wasViewing) {
    return { to: '/no-team', search: { removed: 1 } };
  }
  return { to: '/no-team' };
};
