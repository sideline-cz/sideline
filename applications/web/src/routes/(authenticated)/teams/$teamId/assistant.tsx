import { Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Effect, Schema } from 'effect';
import React from 'react';
import { AssistantPage } from '~/components/pages/AssistantPage';
import { ApiClient } from '~/lib/runtime';

// `Schema.optional` is the local `validateSearch` convention (`events.index.tsx:8`) — TanStack
// owns this shape, not the wire. No length check here: the clamp happens in the effect below,
// deliberately NOT via `Schema.check(isMaxLength(2000))` — a `validateSearch` failure rejects
// into the route error boundary, turning a slightly-too-long hand-crafted URL into a full error
// page instead of a truncated question (plan §D).
const AssistantSearchSchema = Schema.Struct({ ask: Schema.optional(Schema.String) });

// Flat route, no sub-routes — same shape as `notifications.tsx` (design §1).
export const Route = createFileRoute('/(authenticated)/teams/$teamId/assistant')({
  ssr: false,
  validateSearch: Schema.toStandardSchemaV1(AssistantSearchSchema),
  // `loaderDeps` deliberately NOT extended with `ask` — it must not re-run the capabilities
  // loader (plan §D).
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
  const { ask } = Route.useSearch();
  const navigate = Route.useNavigate();

  const [pending, setPending] = React.useState<{ text: string; id: number } | undefined>(undefined);
  const idRef = React.useRef(0);

  // The hand-off's one-shot capture (plan §D). `.slice(0, 2000)` — NOT a schema check — is the
  // blocker fix: `new AiChatApi.ChatMessage(...)` throws over 2000 chars, and that throw happens
  // before the composer's own guard could ever run for an auto-sent question.
  React.useEffect(() => {
    const text = ask?.trim().slice(0, 2000);
    if (text === undefined || text.length === 0) return;
    idRef.current += 1;
    setPending({ text, id: idRef.current });
    // Exact form: no `to`, no `params` — stays on the current route, clears every search param.
    // `replace: true` keeps `?ask=` out of history so a refresh or Back never re-sends it.
    void navigate({ search: {}, replace: true });
  }, [ask, navigate]);

  return <AssistantPage teamId={teamId} enabled={enabled} pendingQuestion={pending} />;
}
