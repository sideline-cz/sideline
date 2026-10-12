import { Effect, Layer, Option } from 'effect';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';

export interface RecordedNotification {
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly memberIds: ReadonlyArray<string>;
}

/**
 * Records what each emit site asked for without touching a database.
 *
 * `notifyMembers` renders with the `'en'` locale so assertions can match on English copy —
 * picking a per-recipient locale is `NotificationsRepository`'s own job and is covered where
 * that repository is exercised for real.
 */
export const makeMockNotificationsRepositoryLayer = (sink: Array<RecordedNotification>) =>
  Layer.succeed(NotificationsRepository, {
    notifyMembers: (
      _teamId: unknown,
      memberIds: ReadonlyArray<string>,
      type: string,
      link: string | null,
      render: (locale: 'en' | 'cs') => { title: string; body: string },
    ) => {
      const { title, body } = render('en');
      sink.push({ type, title, body, link, memberIds: [...memberIds] });
      return Effect.void;
    },
    unreadCountForTeam: () => Effect.succeed(0),
    insert: () => Effect.void,
    insertBulk: () => Effect.void,
    findByUser: () => Effect.succeed([]),
    findByUserAndTeam: () => Effect.succeed([]),
    markAllAsReadForTeam: () => Effect.void,
    markAsRead: () => Effect.void,
    markAllAsRead: () => Effect.void,
    findById: () => Effect.succeed(Option.none()),
  } as any);
