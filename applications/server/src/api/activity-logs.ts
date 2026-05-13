import { ActivityLogApi, Auth } from '@sideline/domain';
import { DateTime, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership } from '~/api/permissions.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { AchievementEvaluator } from '~/services/AchievementEvaluator.js';

export const ActivityLogApiLive = HttpApiBuilder.group(Api, 'activityLog', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('activityLogs', () => ActivityLogsRepository.asEffect()),
    Effect.bind('activityTypes', () => ActivityTypesRepository.asEffect()),
    Effect.bind('evaluatorOpt', () => Effect.serviceOption(AchievementEvaluator)),
    Effect.map(({ members, activityLogs, activityTypes, evaluatorOpt }) =>
      handlers
        .handle('listLogs', ({ params: { teamId, memberId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, new ActivityLogApi.Forbidden()),
            ),
            Effect.tap(({ membership }) =>
              membership.id === memberId
                ? Effect.void
                : Effect.fail(new ActivityLogApi.Forbidden()),
            ),
            Effect.bind('logs', () => activityLogs.findByMember(memberId)),
            Effect.map(
              ({ logs }) =>
                new ActivityLogApi.ActivityLogListResponse({
                  logs: logs.map(
                    (l) =>
                      new ActivityLogApi.ActivityLogEntry({
                        id: l.id,
                        activityTypeId: l.activity_type_id,
                        activityTypeName: l.activity_type_name,
                        activityTypeEmoji: l.activity_type_emoji,
                        loggedAt: l.logged_at,
                        durationMinutes: l.duration_minutes,
                        note: l.note,
                        source: l.source,
                      }),
                  ),
                }),
            ),
          ),
        )
        .handle('createLog', ({ params: { teamId, memberId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, new ActivityLogApi.Forbidden()),
            ),
            Effect.tap(({ membership }) =>
              membership.id === memberId
                ? Effect.void
                : Effect.fail(new ActivityLogApi.Forbidden()),
            ),
            Effect.tap(({ membership }) =>
              membership.active ? Effect.void : Effect.fail(new ActivityLogApi.MemberInactive()),
            ),
            Effect.flatMap(() =>
              activityLogs.insert({
                team_member_id: memberId,
                activity_type_id: payload.activityTypeId,
                logged_at: DateTime.toDateUtc(DateTime.nowUnsafe()),
                duration_minutes: payload.durationMinutes,
                note: payload.note,
                source: 'manual',
              }),
            ),
            Effect.tap(() =>
              Option.match(evaluatorOpt, {
                onNone: () => Effect.void,
                onSome: (ev) =>
                  ev
                    .evaluate(memberId)
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning('Achievement evaluation failed', cause),
                      ),
                    ),
              }),
            ),
            Effect.map(
              (inserted) =>
                new ActivityLogApi.ActivityLogEntry({
                  id: inserted.id,
                  activityTypeId: inserted.activity_type_id,
                  activityTypeName: inserted.activity_type_name,
                  activityTypeEmoji: inserted.activity_type_emoji,
                  loggedAt: inserted.logged_at,
                  durationMinutes: payload.durationMinutes,
                  note: payload.note,
                  source: inserted.source,
                }),
            ),
          ),
        )
        .handle('updateLog', ({ params: { teamId, memberId, logId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, new ActivityLogApi.Forbidden()),
            ),
            Effect.tap(({ membership }) =>
              membership.id === memberId
                ? Effect.void
                : Effect.fail(new ActivityLogApi.Forbidden()),
            ),
            Effect.tap(({ membership }) =>
              membership.active ? Effect.void : Effect.fail(new ActivityLogApi.MemberInactive()),
            ),
            Effect.flatMap(() =>
              activityLogs.update(logId, memberId, {
                activity_type_id: payload.activityTypeId,
                duration_minutes: payload.durationMinutes,
                note: payload.note,
              }),
            ),
            Effect.tap(() =>
              Option.match(evaluatorOpt, {
                onNone: () => Effect.void,
                onSome: (ev) =>
                  ev
                    .evaluate(memberId)
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning('Achievement evaluation failed', cause),
                      ),
                    ),
              }),
            ),
            Effect.map(
              (updated) =>
                new ActivityLogApi.ActivityLogEntry({
                  id: updated.id,
                  activityTypeId: updated.activity_type_id,
                  activityTypeName: updated.activity_type_name,
                  activityTypeEmoji: updated.activity_type_emoji,
                  loggedAt: updated.logged_at,
                  durationMinutes: updated.duration_minutes,
                  note: updated.note,
                  source: updated.source,
                }),
            ),
          ),
        )
        .handle('deleteLog', ({ params: { teamId, memberId, logId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, new ActivityLogApi.Forbidden()),
            ),
            Effect.tap(({ membership }) =>
              membership.id === memberId
                ? Effect.void
                : Effect.fail(new ActivityLogApi.Forbidden()),
            ),
            Effect.tap(({ membership }) =>
              membership.active ? Effect.void : Effect.fail(new ActivityLogApi.MemberInactive()),
            ),
            Effect.flatMap(() => activityLogs.delete(logId, memberId)),
            Effect.asVoid,
          ),
        ),
    ),
  ),
);
