import type { Roster } from '@sideline/domain';
import { Team, TeamMember } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import React from 'react';

import { TeamMembersPage } from '~/components/pages/TeamMembersPage';
import { ApiClient, ClientError, useRun, warnAndCatchAll } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/members/')({
  ssr: false,
  component: MembersRoute,
  loader: async ({ params, context }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.roster.listMembers({ params: { teamId } })),
      warnAndCatchAll,
      context.run,
    );
  },
});

function MembersRoute() {
  const { user } = Route.useRouteContext();
  const { teamId: teamIdRaw } = Route.useParams();
  const teamId = Schema.decodeSync(Team.TeamId)(teamIdRaw);
  const run = useRun();
  const initialPlayers = Route.useLoaderData();
  const [players, setPlayers] = React.useState<ReadonlyArray<Roster.RosterPlayer>>(initialPlayers);

  const currentMembership = players.find((p) => p.userId === user.id);
  const myPermissions = currentMembership?.permissions ?? [];
  const canEdit = myPermissions.includes('member:edit');
  const canRemove = myPermissions.includes('member:remove');

  const handleDeactivate = React.useCallback(
    async (memberIdRaw: string) => {
      if (!window.confirm(tr('members_deactivateConfirm'))) return;
      const memberId = Schema.decodeSync(TeamMember.TeamMemberId)(memberIdRaw);
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) => api.roster.deactivateMember({ params: { teamId, memberId } })),
        Effect.mapError(() => ClientError.make(tr('members_saveFailed'))),
        run({ success: tr('members_deactivated') }),
      );
      if (Option.isSome(result)) {
        setPlayers((prev) => prev.filter((p) => p.memberId !== memberId));
      }
    },
    [teamId, run],
  );

  return (
    <TeamMembersPage
      teamId={teamIdRaw}
      canEdit={canEdit}
      canRemove={canRemove}
      players={players}
      onDeactivate={handleDeactivate}
    />
  );
}
