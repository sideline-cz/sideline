import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { NotificationId, NotificationType } from '~/models/Notification.js';
import { TeamId } from '~/models/Team.js';

export class NotificationInfo extends Schema.Class<NotificationInfo>('NotificationInfo')({
  notificationId: NotificationId,
  teamId: TeamId,
  type: NotificationType,
  title: Schema.String,
  body: Schema.String,
  link: Schema.OptionFromNullOr(Schema.String),
  isRead: Schema.Boolean,
  createdAt: Schema.String,
}) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('NotificationForbidden', {}) {}

export class NotificationNotFound extends Schema.TaggedErrorClass<NotificationNotFound>()(
  'NotificationNotFound',
  {},
) {}

export class NotificationApiGroup extends HttpApiGroup.make('notification')
  .add(
    HttpApiEndpoint.get('listNotifications', '/notifications', {
      success: Schema.Array(NotificationInfo),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      query: {
        teamId: TeamId,
      },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('unreadCount', '/notifications/unread-count', {
      success: Schema.Struct({ count: Schema.Int }),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      query: {
        teamId: TeamId,
      },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('markAsRead', '/notifications/:notificationId/read', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        NotificationNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { notificationId: NotificationId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('markAllAsRead', '/notifications/read-all', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      payload: Schema.Struct({
        teamId: TeamId,
      }),
    }).middleware(AuthMiddleware),
  ) {}
