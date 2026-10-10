import { Notification, Team, type TeamMember, User } from '@sideline/domain';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class NotificationRow extends Schema.Class<NotificationRow>('NotificationRow')({
  id: Notification.NotificationId,
  team_id: Team.TeamId,
  user_id: User.UserId,
  type: Notification.NotificationType,
  title: Schema.String,
  body: Schema.String,
  link: Schema.NullOr(Schema.String),
  is_read: Schema.Boolean,
  created_at: Schema.String,
}) {}

const InsertInput = Schema.Struct({
  team_id: Schema.String,
  user_id: Schema.String,
  type: Schema.String,
  title: Schema.String,
  body: Schema.String,
  link: Schema.NullOr(Schema.String),
});

/**
 * Recipients for a `notifyMembers` fan-out. `locale` comes from `users.locale` so the stored
 * title/body are written in the language the recipient reads — see `notifyMembers`.
 */
const RecipientRow = Schema.Struct({
  user_id: User.UserId,
  locale: User.Locale,
});

const FindByUserAndTeamInput = Schema.Struct({
  user_id: Schema.String,
  team_id: Schema.String,
});

const MarkAllReadForTeamInput = Schema.Struct({
  user_id: Schema.String,
  team_id: Schema.String,
});

const MarkReadInput = Schema.Struct({
  id: Notification.NotificationId,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByUserId = SqlSchema.findAll({
    Request: Schema.String,
    Result: NotificationRow,
    execute: (userId) => sql`
      SELECT id, team_id, user_id, type, title, body, is_read,
             link, created_at::text AS created_at
      FROM notifications
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT 50
    `,
  });

  const findByUserIdAndTeamId = SqlSchema.findAll({
    Request: FindByUserAndTeamInput,
    Result: NotificationRow,
    execute: (input) => sql`
      SELECT id, team_id, user_id, type, title, body, is_read,
             link, created_at::text AS created_at
      FROM notifications
      WHERE user_id = ${input.user_id} AND team_id = ${input.team_id}
      ORDER BY created_at DESC
      LIMIT 50
    `,
  });

  const markAllReadForTeam = SqlSchema.void({
    Request: MarkAllReadForTeamInput,
    execute: (input) =>
      sql`UPDATE notifications SET is_read = true WHERE user_id = ${input.user_id} AND team_id = ${input.team_id} AND is_read = false`,
  });

  const insertOne = SqlSchema.findOne({
    Request: InsertInput,
    Result: NotificationRow,
    execute: (input) => sql`
      INSERT INTO notifications (team_id, user_id, type, title, body, link)
      VALUES (${input.team_id}, ${input.user_id}, ${input.type}, ${input.title}, ${input.body}, ${input.link})
      RETURNING id, team_id, user_id, type, title, body, link, is_read,
                created_at::text AS created_at
    `,
  });

  // Resolves the notification recipients for a set of team members. Inactive members are
  // excluded: a removed member keeps their `team_members` row, and mailing them about a fee or
  // a cancelled event they are no longer part of is noise they cannot act on.
  const findRecipients = SqlSchema.findAll({
    Request: Schema.Struct({ member_ids: Schema.Array(Schema.String) }),
    Result: RecipientRow,
    execute: (input) => sql`
      SELECT u.id AS user_id, u.locale
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      WHERE tm.id = ANY(${input.member_ids}::uuid[]) AND tm.active = true
    `,
  });

  const countUnread = SqlSchema.findAll({
    Request: Schema.Struct({ user_id: Schema.String, team_id: Schema.String }),
    Result: Schema.Struct({ count: Schema.Number }),
    execute: (input) => sql`
      SELECT count(*)::int AS count
      FROM notifications
      WHERE user_id = ${input.user_id} AND team_id = ${input.team_id} AND is_read = false
    `,
  });

  const markOneAsRead = SqlSchema.void({
    Request: MarkReadInput,
    execute: (input) => sql`UPDATE notifications SET is_read = true WHERE id = ${input.id}`,
  });

  const markAllRead = SqlSchema.void({
    Request: Schema.String,
    execute: (userId) =>
      sql`UPDATE notifications SET is_read = true WHERE user_id = ${userId} AND is_read = false`,
  });

  const findOneById = SqlSchema.findOneOption({
    Request: Notification.NotificationId,
    Result: NotificationRow,
    execute: (id) => sql`
      SELECT id, team_id, user_id, type, title, body, link, is_read,
             created_at::text AS created_at
      FROM notifications WHERE id = ${id}
    `,
  });

  const findByUser = (userId: User.UserId) => findByUserId(userId).pipe(catchSqlErrors);

  const findByUserAndTeam = (userId: User.UserId, teamId: Team.TeamId) =>
    findByUserIdAndTeamId({ user_id: userId, team_id: teamId }).pipe(catchSqlErrors);

  const markAllAsReadForTeam = (userId: User.UserId, teamId: Team.TeamId) =>
    markAllReadForTeam({ user_id: userId, team_id: teamId }).pipe(catchSqlErrors);

  const insert = (
    teamId: Team.TeamId,
    userId: User.UserId,
    type: Notification.NotificationType,
    title: string,
    body: string,
    link: string | null = null,
  ) =>
    insertOne({ team_id: teamId, user_id: userId, type, title, body, link }).pipe(catchSqlErrors);

  const insertBulk = (
    notifications: ReadonlyArray<{
      teamId: Team.TeamId;
      userId: User.UserId;
      type: Notification.NotificationType;
      title: string;
      body: string;
      link?: string | null;
    }>,
  ) =>
    Effect.all(
      notifications.map((n) =>
        insertOne({
          team_id: n.teamId,
          user_id: n.userId,
          type: n.type,
          title: n.title,
          body: n.body,
          link: n.link ?? null,
        }),
      ),
    ).pipe(Effect.asVoid, catchSqlErrors);

  /**
   * Fan a notification out to a set of team members, rendering its text once per distinct
   * recipient locale.
   *
   * This is the entry point every emit site should use. It owns the three things a caller
   * would otherwise repeat: resolving `team_members.id` -> `users.id`, picking the recipient's
   * language, and swallowing its own failures.
   *
   * **Never fails.** A notification is a courtesy on top of an operation that already
   * committed — a cancelled event stays cancelled, an assigned fee stays assigned. Letting a
   * notification error surface would roll a caller's success into a 500, so the whole cause is
   * logged and dropped here rather than at each of the call sites. `catchCause`, not `ignore`:
   * a dead connection arrives as a defect, and that must not fail the cancel either.
   *
   * ponytail: title/body are rendered at write time, so a row keeps the language the recipient
   * had when it was created and ignores any later team translation override. Store `type` plus
   * a params blob and render via `tr()` on the web if either has to follow the reader.
   */
  const notifyMembers = (
    teamId: Team.TeamId,
    memberIds: ReadonlyArray<TeamMember.TeamMemberId>,
    type: Notification.NotificationType,
    link: string | null,
    render: (locale: User.Locale) => { readonly title: string; readonly body: string },
  ): Effect.Effect<void> =>
    memberIds.length === 0
      ? Effect.void
      : findRecipients({ member_ids: memberIds }).pipe(
          catchSqlErrors,
          Effect.flatMap((recipients) =>
            insertBulk(
              recipients.map((recipient) => {
                const { title, body } = render(recipient.locale);
                return { teamId, userId: recipient.user_id, type, title, body, link };
              }),
            ),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning(`Failed to create ${type} notifications`, cause),
          ),
        );

  const unreadCountForTeam = (userId: User.UserId, teamId: Team.TeamId) =>
    countUnread({ user_id: userId, team_id: teamId }).pipe(
      Effect.map((rows) => rows[0]?.count ?? 0),
      catchSqlErrors,
    );

  const markAsRead = (notificationId: Notification.NotificationId) =>
    markOneAsRead({ id: notificationId }).pipe(catchSqlErrors);

  const markAllAsRead = (userId: User.UserId) => markAllRead(userId).pipe(catchSqlErrors);

  const findById = (notificationId: Notification.NotificationId) =>
    findOneById(notificationId).pipe(catchSqlErrors);

  return {
    findByUser,
    findByUserAndTeam,
    markAllAsReadForTeam,
    insert,
    insertBulk,
    notifyMembers,
    unreadCountForTeam,
    markAsRead,
    markAllAsRead,
    findById,
  };
});

export class NotificationsRepository extends ServiceMap.Service<
  NotificationsRepository,
  Effect.Success<typeof make>
>()('api/NotificationsRepository') {
  static readonly Default = Layer.effect(NotificationsRepository, make);
}
