import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import React from 'react';
import { MyProfilePage } from '~/components/pages/MyProfilePage';

export const Route = createFileRoute('/(authenticated)/(no-team)/profile/')({
  component: ProfileRoute,
  beforeLoad: async ({ context }) => {
    if (!context.user) {
      throw redirect({ to: '/' });
    }
    if (!context.user.isProfileComplete) {
      throw redirect({ to: '/profile/complete' });
    }
  },
});

function ProfileRoute() {
  const { user, teams } = Route.useRouteContext();
  const router = useRouter();

  const handleUpdated = React.useCallback(() => {
    router.invalidate();
  }, [router]);

  return <MyProfilePage user={user} teams={teams} onUpdated={handleUpdated} />;
}
