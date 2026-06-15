import { createFileRoute, redirect } from '@tanstack/react-router';
import { Effect } from 'effect';
import { AdminGlobalAdminsPage } from '~/components/pages/AdminGlobalAdminsPage';
import { ApiClient, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/admin/global-admins')({
  component: AdminGlobalAdminsRoute,
  ssr: false,
  beforeLoad: ({ context }) => {
    if (!context.user?.isGlobalAdmin) {
      throw redirect({ to: '/' });
    }
  },
  loader: async ({ context }) => {
    const admins = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.globalAdmin.listGlobalAdmins()),
      warnAndCatchAll,
      context.run,
    );
    return { admins };
  },
});

function AdminGlobalAdminsRoute() {
  const { admins } = Route.useLoaderData();
  return <AdminGlobalAdminsPage admins={admins} />;
}
