import type { Auth } from '@sideline/domain';
import { Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Schema } from 'effect';
import { ConnectDiscordPage } from '~/components/pages/ConnectDiscordPage';

interface ConnectDiscordSearch {
  readonly next?: string;
}

export const Route = createFileRoute('/(authenticated)/teams/$teamId/connect-discord')({
  ssr: false,
  component: ConnectDiscordRoute,
  validateSearch: (search: Record<string, unknown>): ConnectDiscordSearch =>
    typeof search.next === 'string' ? { next: search.next } : {},
});

function ConnectDiscordRoute() {
  const { teamId } = Route.useParams();
  const { next } = Route.useSearch();
  const { user, teams } = Route.useRouteContext();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  // Explicit annotation (not a cast — `teams` already has this shape; TanStack's inferred
  // context type here is a deferred/conditional type that confuses `Array.prototype.find`'s
  // generic inference, silently widening the callback's element type to `any`) works around it.
  const typedTeams: ReadonlyArray<Auth.UserTeam> = teams;
  const team = typedTeams.find((t) => t.teamId === teamIdBranded);
  const teamName = team?.teamName ?? '';

  return (
    <ConnectDiscordPage teamId={teamIdBranded} teamName={teamName} userId={user.id} next={next} />
  );
}
