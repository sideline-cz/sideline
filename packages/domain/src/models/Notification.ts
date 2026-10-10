import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { TeamId } from '~/models/Team.js';
import { UserId } from '~/models/User.js';

export const NotificationId = Schema.String.pipe(Schema.brand('NotificationId'));
export type NotificationId = typeof NotificationId.Type;

export const NotificationType = Schema.Literals([
  'age_group_added',
  'age_group_removed',
  'role_assigned',
  'role_removed',
  'event_cancelled',
  'fee_assigned',
  'roster_request_approved',
  'roster_request_declined',
]);
export type NotificationType = typeof NotificationType.Type;

export class Notification extends Model.Class<Notification>('Notification')({
  id: Model.Generated(NotificationId),
  team_id: TeamId,
  user_id: UserId,
  type: NotificationType,
  title: Schema.String,
  body: Schema.String,
  // A team-relative path ("/teams/<id>/finance"), never an absolute URL — the web renders it
  // through the router, which cannot follow an external href.
  link: Schema.OptionFromNullOr(Schema.String),
  is_read: Schema.Boolean,
  created_at: Model.DateTimeInsertFromDate,
}) {}
