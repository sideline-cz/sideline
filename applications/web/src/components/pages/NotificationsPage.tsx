import type { NotificationApi } from '@sideline/domain';
import { Notification, Team } from '@sideline/domain';
import { useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import React from 'react';
import { Button } from '~/components/ui/button';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface NotificationsPageProps {
  notifications: ReadonlyArray<NotificationApi.NotificationInfo>;
  teamId: string;
}

export function NotificationsPage({ notifications, teamId }: NotificationsPageProps) {
  const run = useRun();
  const router = useRouter();

  const handleMarkAsRead = React.useCallback(
    async (notificationIdRaw: string) => {
      const notificationId = Schema.decodeSync(Notification.NotificationId)(notificationIdRaw);
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) => api.notification.markAsRead({ params: { notificationId } })),
        Effect.mapError(() => ClientError.make(tr('notification_markReadFailed'))),
        run(),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [run, router],
  );

  const handleMarkAllAsRead = React.useCallback(async () => {
    const decodedTeamId = Schema.decodeSync(Team.TeamId)(teamId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.notification.markAllAsRead({ payload: { teamId: decodedTeamId } }),
      ),
      Effect.mapError(() => ClientError.make(tr('notification_markReadFailed'))),
      run(),
    );
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [run, router, teamId]);

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  return (
    <div>
      <header className='mb-8'>
        <h1 className='text-2xl font-bold'>{tr('notification_title')}</h1>
      </header>

      {unreadCount > 0 && (
        <Button onClick={handleMarkAllAsRead} variant='outline' className='mb-4' size='sm'>
          {tr('notification_markAllRead')}
        </Button>
      )}

      {notifications.length === 0 ? (
        <p className='text-muted-foreground'>{tr('notification_noNotifications')}</p>
      ) : (
        <div className='flex flex-col gap-2'>
          {notifications.map((notification) => (
            <div
              key={notification.notificationId}
              className={`border rounded p-3 ${notification.isRead ? 'opacity-60' : ''}`}
            >
              <div className='flex items-start justify-between gap-2'>
                <div>
                  <p className='font-medium'>{notification.title}</p>
                  <p className='text-sm text-muted-foreground'>{notification.body}</p>
                  <p className='text-xs text-muted-foreground mt-1'>{notification.createdAt}</p>
                </div>
                {!notification.isRead && (
                  <Button
                    variant='ghost'
                    size='sm'
                    onClick={() => handleMarkAsRead(notification.notificationId)}
                  >
                    {tr('notification_markRead')}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
