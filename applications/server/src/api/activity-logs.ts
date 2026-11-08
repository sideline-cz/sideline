import {
  ActivityLogApi,
  ActivityLogDate,
  ActivityStats,
  Auth,
  DisplayName,
  type TeamMember,
} from '@sideline/domain';
import { Options } from '@sideline/effect-lib';
import { DateTime, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission, requireReadAccess } from '~/api/permissions.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { resolveScope } from '~/repositories/activitySeasonScope.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { AchievementEvaluator } from '~/services/AchievementEvaluator.js';

/**
 * Parses a `YYYY-MM-DD` Prague-local date string into a `Date` anchored at
 * Prague noon, failing with `InvalidLoggedAtDate` if the string is not a
 * valid date within the ±730 day window. Used by both `createLog` and
 * `updateLog` to consistently surface bad client input.
 */
const parsePragueDate = (dateStr: string) =>
  ActivityLogDate.parseLoggedAtDateInPrague(dateStr).pipe(
    Options.toEffect(() => new ActivityLogApi.InvalidLoggedAtDate()),
  );

const MATRIX_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// The last MATRIX_DAYS Prague days, oldest first, today last. Date-only UTC arithmetic: no DST.
const matrixDays = (today: string): ReadonlyArray<string> => {
  const base = Date.parse(today);
  return Array.from({ length: MATRIX_DAYS }, (_, i) =>
    new Date(base - (MATRIX_DAYS - 1 - i) * DAY_MS).toISOString().slice(0, 10),
  );
};

export const ActivityLogApiLive = HttpApiBuilder.group(Api, 'activityLog', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('activityLogs', () => ActivityLogsRepository.asEffect()),
    Effect.bind('activityTypes', () => ActivityTypesRepository.asEffect()),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('evaluatorOpt', () => Effect.serviceOption(AchievementEvaluator)),
    Effect.map(({ members, activityLogs, activityTypes, groups, evaluatorOpt }) =>
      handlers
        .handle('listLogs', ({ params: { teamId, memberId }, query }) =>
          Effect.Do.pipe(
            // The global-admin sentinel id never equals memberId: admins read, but never see notes.
            Effect.bind('membership', () =>
              requireReadAccess(members, teamId, new ActivityLogApi.Forbidden()),
            ),
            Effect.let('isSelf', ({ membership }) => membership.id === memberId),
            // Own logs need no member:view. Others: permission first, then existence (404 for
            // another team's or an inactive member).
            Effect.tap(({ membership, isSelf }) =>
              isSelf
                ? Effect.void
                : requirePermission(membership, 'member:view', new ActivityLogApi.Forbidden()).pipe(
                    Effect.andThen(members.findRosterMemberByIds(teamId, memberId)),
                    Effect.flatMap(Options.toEffect(() => new ActivityLogApi.MemberNotFound())),
                  ),
            ),
            Effect.bind('scope', () => resolveScope(activityLogs, teamId, query.season)),
            Effect.bind('data', ({ scope }) =>
              Effect.all({
                logs: activityLogs.findByMember(memberId, scope),
                seasons: activityLogs.findSeasons(teamId),
              }),
            ),
            Effect.map(
              ({ isSelf, data: { logs, seasons } }) =>
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
                        // A note is private free text: only its author gets it. The server is the wall.
                        note: isSelf ? l.note : Option.none(),
                        source: l.source,
                      }),
                  ),
                  seasons: seasons.map(
                    (s) =>
                      new ActivityLogApi.ActivitySeason({
                        id: s.id,
                        startsAt: s.starts_at,
                        endsAt: s.ends_at,
                        isCurrent: s.is_current,
                      }),
                  ),
                }),
            ),
          ),
        )
        .handle('getActivityMatrix', ({ params: { teamId }, query: { group } }) =>
          Effect.Do.pipe(
            Effect.bind('membership', () =>
              requireReadAccess(members, teamId, new ActivityLogApi.Forbidden()),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'member:view', new ActivityLogApi.Forbidden()),
            ),
            Effect.bind('data', () =>
              Effect.all({
                roster: members.findRosterByTeam(teamId),
                cells: activityLogs.findTeamMatrix(teamId),
                groupList: groups.findGroupsByTeamId(teamId, false),
                // A group of another team yields that team's members; the roster intersection
                // below is then empty (rows: []).
                groupMemberIds: Option.match(group, {
                  onNone: () => Effect.succeed(Option.none<ReadonlySet<TeamMember.TeamMemberId>>()),
                  onSome: (g) =>
                    groups
                      .getDescendantMemberIds(g)
                      .pipe(Effect.map((ids) => Option.some(new Set(ids)))),
                }),
              }),
            ),
            Effect.map(({ data: { roster, cells, groupList, groupMemberIds } }) => {
              const days = matrixDays(ActivityStats.todayInPrague());
              const daySet = new Set(days);
              // cells arrive ordered by member, day, type name
              type DayEntries = Map<string, ActivityLogApi.ActivityMatrixEntry[]>;
              const byMember = new Map<string, DayEntries>();
              for (const c of cells) {
                // The JS clock and the DB now() can disagree by one day near midnight.
                if (!daySet.has(c.day)) continue;
                const memberDays: DayEntries = byMember.get(c.team_member_id) ?? new Map();
                byMember.set(c.team_member_id, memberDays);
                const entries: ActivityLogApi.ActivityMatrixEntry[] = memberDays.get(c.day) ?? [];
                memberDays.set(c.day, entries);
                entries.push(
                  new ActivityLogApi.ActivityMatrixEntry({
                    activityTypeName: c.activity_type_name,
                    activityTypeEmoji: c.activity_type_emoji,
                    totalMinutes: c.total_minutes,
                  }),
                );
              }

              const rows = roster
                .filter((r) =>
                  Option.match(groupMemberIds, {
                    onNone: () => true,
                    onSome: (ids) => ids.has(r.member_id),
                  }),
                )
                .map(
                  (r) =>
                    new ActivityLogApi.ActivityMatrixRow({
                      memberId: r.member_id,
                      displayName: Option.getOrElse(
                        DisplayName.pickDisplayName({
                          name: r.name,
                          nickname: r.discord_nickname,
                          displayName: r.discord_display_name,
                          username: Option.some(r.username),
                        }),
                        () => r.username,
                      ),
                      cells: Array.from(
                        byMember.get(r.member_id) ?? [],
                        ([date, entries]) =>
                          new ActivityLogApi.ActivityMatrixCell({ date, entries }),
                      ),
                    }),
                )
                .sort((a, b) => a.displayName.localeCompare(b.displayName, 'cs'));

              return new ActivityLogApi.ActivityMatrixResponse({
                days,
                rows,
                groups: groupList.map(
                  (g) =>
                    new ActivityLogApi.ActivityMatrixGroup({
                      groupId: g.id,
                      name: g.name,
                      emoji: g.emoji,
                    }),
                ),
              });
            }),
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
            Effect.bind('loggedAt', () =>
              Option.match(payload.loggedAtDate, {
                onNone: () => Effect.sync(() => DateTime.toDateUtc(DateTime.nowUnsafe())),
                onSome: parsePragueDate,
              }),
            ),
            Effect.flatMap(({ loggedAt }) =>
              activityLogs.insert({
                team_member_id: memberId,
                activity_type_id: payload.activityTypeId,
                logged_at: loggedAt,
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
            Effect.bind('updatedLoggedAt', () =>
              Option.match(payload.loggedAtDate, {
                onNone: () => Effect.succeed(Option.none<Date>()),
                onSome: (dateStr) => Effect.map(parsePragueDate(dateStr), Option.some),
              }),
            ),
            Effect.flatMap(({ updatedLoggedAt }) =>
              activityLogs.update(logId, memberId, {
                activity_type_id: payload.activityTypeId,
                logged_at: updatedLoggedAt,
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
