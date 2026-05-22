import { createFileRoute, redirect } from '@tanstack/react-router';
import { Effect } from 'effect';
import { AdminOnboardingTokensPage } from '~/components/pages/AdminOnboardingTokensPage';
import { ApiClient, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/admin/onboarding-tokens')({
  component: AdminOnboardingTokensRoute,
  ssr: false,
  beforeLoad: ({ context }) => {
    if (!context.user?.isGlobalAdmin) {
      throw redirect({ to: '/' });
    }
  },
  loader: async ({ context }) => {
    const tokens = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.onboarding.listOnboardingTokens()),
      warnAndCatchAll,
      context.run,
    );
    return { tokens };
  },
});

function AdminOnboardingTokensRoute() {
  const { tokens } = Route.useLoaderData();
  return <AdminOnboardingTokensPage tokens={tokens} />;
}
