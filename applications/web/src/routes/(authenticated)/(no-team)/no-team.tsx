import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Effect } from 'effect';
import React from 'react';
import { NoTeamPage } from '~/components/pages/NoTeamPage.js';
import { logout } from '~/lib/auth';

export const Route = createFileRoute('/(authenticated)/(no-team)/no-team')({
  ssr: false,
  component: NoTeamRoute,
  validateSearch: (search: Record<string, unknown>): { removed?: 1 } =>
    search.removed === 1 || search.removed === '1' ? { removed: 1 } : {},
});

function NoTeamRoute() {
  const { removed } = Route.useSearch();
  const navigate = useNavigate();

  const handleLogout = React.useCallback(() => {
    Effect.runSync(logout);
    navigate({ to: '/' });
  }, [navigate]);

  return <NoTeamPage justRemoved={removed === 1} onLogout={handleLogout} />;
}
