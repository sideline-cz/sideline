import { Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';

import type { MemberOverviewRow } from '~/components/pages/FinancesOverviewPage.js';
import { FinancesOverviewPage } from '~/components/pages/FinancesOverviewPage.js';
import { ApiClient, NotFound, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/finances')({
  ssr: false,
  component: FinancesRoute,
  loader: async ({ params, context }) => {
    const teamId = await Schema.decodeEffect(Team.TeamId)(params.teamId).pipe(
      Effect.mapError(NotFound.make),
      context.run,
    );

    const domainRows = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.finance.overview({ params: { teamId } })),
      warnAndCatchAll,
      context.run,
    );

    const rows: ReadonlyArray<MemberOverviewRow> = domainRows.map((r) => ({
      teamMemberId: r.teamMemberId,
      memberName: Option.getOrNull(r.memberName),
      currency: r.currency,
      totalDueMinor: r.totalDueMinor,
      totalPaidMinor: r.totalPaidMinor,
      overdueCount: r.overdueCount,
      pendingCount: r.pendingCount,
      paidCount: r.paidCount,
    }));

    return rows;
  },
});

function FinancesRoute() {
  const { teamId } = Route.useParams();
  const rows = Route.useLoaderData();

  return <FinancesOverviewPage rows={rows} teamId={teamId} />;
}
