import { Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Effect, Schema } from 'effect';
import { AssistantPage } from '~/components/pages/AssistantPage';
import { ApiClient } from '~/lib/runtime';

// Flat route, no sub-routes — same shape as `notifications.tsx` (design §1).
export const Route = createFileRoute('/(authenticated)/teams/$teamId/assistant')({
  ssr: false,
  component: AssistantRoute,
  loader: async ({ params, context }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.aiChat.getCapabilities({ params: { teamId } })),
      Effect.map((capabilities) => ({ enabled: capabilities.enabled })),
      // Deliberately NOT `warnAndCatchAll`: that maps any failure to `NotFound`, and a 404 page
      // for a transient capabilities blip is a worse answer than the disabled state, whose copy
      // ("not available right now") is true either way (design §1).
      Effect.tapError((e) => Effect.logWarning('assistant capabilities failed', e)),
      Effect.catch(() => Effect.succeed({ enabled: false })),
      context.run,
    );
  },
});

function AssistantRoute() {
  const { teamId } = Route.useParams();
  const { enabled } = Route.useLoaderData();
  return <AssistantPage teamId={teamId} enabled={enabled} />;
}
