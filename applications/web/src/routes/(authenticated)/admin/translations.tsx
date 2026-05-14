import { createFileRoute, redirect } from '@tanstack/react-router';
import { Effect } from 'effect';
import { TranslationsAdminPage } from '~/components/pages/TranslationsAdminPage';
import { ApiClient, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/admin/translations')({
  component: TranslationsAdminRoute,
  ssr: false,
  beforeLoad: ({ context }) => {
    if (!context.user?.isGlobalAdmin) {
      throw redirect({ to: '/' });
    }
  },
  loader: async ({ context }) => {
    const data = await Effect.flatMap(ApiClient.asEffect(), (api) => api.translations.list()).pipe(
      warnAndCatchAll,
      context.run,
    );
    return { initialData: data };
  },
});

function TranslationsAdminRoute() {
  const { initialData } = Route.useLoaderData();
  return <TranslationsAdminPage initialData={initialData} />;
}
