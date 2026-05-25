import { Auth, WeeklyChallenge, WeeklyChallengeApi } from '@sideline/domain';
import { Options } from '@sideline/effect-lib';
import { DateTime, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { hasPermission, requireMembership, requirePermission } from '~/api/permissions.js';
import {
  currentTeamMondayDateString,
  formatDateUtc,
  scheduleAtNineAm,
} from '~/helpers/weeklyChallenge.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { WeeklyChallengeRepository } from '~/repositories/WeeklyChallengeRepository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Adds `weeks` calendar weeks to a YYYY-MM-DD date string.
 * Safe for pure date math (no TZ ambiguity).
 */
const addWeeksToDateString = (dateStr: string, weeks: number): string => {
  const [year, month, day] = dateStr.split('-').map(Number) as [number, number, number];
  const d = new Date(Date.UTC(year, month - 1, day + weeks * 7));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

type TeamSettingsLike = { readonly timezone: string };

/**
 * Resolves the team's IANA timezone from its (possibly absent) settings row,
 * defaulting to 'UTC' when the row has not been provisioned.
 */
const resolveTeamTimezone = (settings: Option.Option<TeamSettingsLike>): string =>
  Option.match(settings, { onNone: () => 'UTC', onSome: (s) => s.timezone });

const forbidden = new WeeklyChallengeApi.WeeklyChallengeForbidden();
const notFound = new WeeklyChallengeApi.WeeklyChallengeNotFound();

export const WeeklyChallengeApiLive = HttpApiBuilder.group(Api, 'weeklyChallenge', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('challenges', () => WeeklyChallengeRepository.asEffect()),
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('settings', () => TeamSettingsRepository.asEffect()),
    Effect.map(({ challenges, members, settings }) =>
      handlers
        .handle('listChallenges', ({ params: { teamId }, query }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              membership.active ? Effect.void : Effect.fail(forbidden),
            ),
            Effect.bind('teamSettings', () => settings.findByTeamId(teamId)),
            Effect.let('teamTz', ({ teamSettings }) => resolveTeamTimezone(teamSettings)),
            Effect.let('limitArg', () =>
              Option.match(query.limit, {
                onNone: () => undefined,
                onSome: (n) => Math.max(1, Math.min(52, n)),
              }),
            ),
            Effect.bind('listResult', ({ teamTz, limitArg }) =>
              challenges.listForTeam(teamId, teamTz, limitArg),
            ),
            Effect.let('canCreate', ({ membership }) => hasPermission(membership, 'team:manage')),
            Effect.let('currentMemberId', ({ membership }) =>
              membership.active ? Option.some(membership.id) : Option.none(),
            ),
            Effect.map(
              ({ listResult, canCreate, currentMemberId }) =>
                new WeeklyChallengeApi.WeeklyChallengeListResponse({
                  team: listResult.team,
                  canCreate,
                  currentMemberId,
                  challenges: listResult.challenges,
                }),
            ),
          ),
        )
        .handle('createChallenge', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'team:manage', forbidden)),
            Effect.bind('teamSettings', () => settings.findByTeamId(teamId)),
            Effect.let('teamTz', ({ teamSettings }) => resolveTeamTimezone(teamSettings)),
            Effect.tap(({ teamTz }) => {
              // Compare at the calendar-date level (YYYY-MM-DD) so that
              // timezone offsets between team-local Monday midnight and UTC
              // midnight do not corrupt the boundary arithmetic.
              const currentMondayStr = currentTeamMondayDateString(teamTz);
              const maxMondayStr = addWeeksToDateString(currentMondayStr, 8);
              const weekStartStr = formatDateUtc(payload.weekStart);
              if (weekStartStr < currentMondayStr) {
                return Effect.fail(new WeeklyChallengeApi.WeeklyChallengeWeekOutOfRange());
              }
              if (weekStartStr > maxMondayStr) {
                return Effect.fail(new WeeklyChallengeApi.WeeklyChallengeWeekOutOfRange());
              }
              return Effect.void;
            }),
            Effect.bind('challenge', ({ membership }) =>
              challenges.create({
                team_id: teamId,
                week_start_date: payload.weekStart,
                kind: payload.kind,
                title: payload.title,
                description: payload.description,
                created_by: membership.id,
              }),
            ),
            Effect.tap(({ challenge, teamSettings, teamTz }) => {
              const channelIdOpt = Option.flatMap(teamSettings, (s) => s.weekly_summary_channel_id);
              if (Option.isNone(channelIdOpt)) {
                return Effect.void;
              }
              const scheduledFor = scheduleAtNineAm(payload.weekStart, teamTz);
              return challenges
                .enqueueAnnouncementEvent(challenge.id, teamId, channelIdOpt.value, scheduledFor)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      'WeeklyChallenge: failed to enqueue announcement sync event',
                      cause,
                    ),
                  ),
                );
            }),
            Effect.map(
              ({ challenge }) =>
                // Re-construct a properly-typed WeeklyChallenge so that
                // HttpApiBuilder's encodeUnknownEffect can validate and
                // encode the response correctly. The repository may return
                // the select-variant encoded form (Dates, null) or the
                // already-decoded type form (DateTime.Utc, Option).
                // DateTime.makeUnsafe handles both transparently.
                new WeeklyChallenge.WeeklyChallenge({
                  id: challenge.id,
                  team_id: teamId,
                  week_start_date: payload.weekStart,
                  kind: payload.kind,
                  title: payload.title,
                  description: payload.description,
                  created_by: challenge.created_by,
                  created_at: DateTime.makeUnsafe(challenge.created_at),
                  updated_at: DateTime.makeUnsafe(challenge.updated_at),
                }),
            ),
          ),
        )
        .handle('updateChallenge', ({ params: { teamId, challengeId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'team:manage', forbidden)),
            Effect.bind('existing', () =>
              challenges
                .findById(challengeId)
                .pipe(Effect.flatMap(Options.toEffect(() => notFound))),
            ),
            Effect.tap(({ existing }) =>
              existing.team_id !== teamId ? Effect.fail(notFound) : Effect.void,
            ),
            Effect.bind('updated', () =>
              challenges.updateTitleDescription(challengeId, payload.title, payload.description),
            ),
            Effect.map(({ updated }) => updated),
          ),
        )
        .handle('deleteChallenge', ({ params: { teamId, challengeId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'team:manage', forbidden)),
            Effect.bind('existing', () =>
              challenges
                .findById(challengeId)
                .pipe(Effect.flatMap(Options.toEffect(() => notFound))),
            ),
            Effect.tap(({ existing }) =>
              existing.team_id !== teamId ? Effect.fail(notFound) : Effect.void,
            ),
            Effect.tap(() => challenges.delete(challengeId)),
            Effect.asVoid,
          ),
        )
        .handle('markCompleted', ({ params: { teamId, challengeId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              membership.active ? Effect.void : Effect.fail(forbidden),
            ),
            // B1: verify challenge belongs to this team before mutating
            Effect.bind('existing', () =>
              challenges
                .findById(challengeId)
                .pipe(Effect.flatMap(Options.toEffect(() => notFound))),
            ),
            Effect.tap(({ existing }) =>
              existing.team_id !== teamId ? Effect.fail(notFound) : Effect.void,
            ),
            Effect.bind('teamSettings', () => settings.findByTeamId(teamId)),
            Effect.let('teamTz', ({ teamSettings }) => resolveTeamTimezone(teamSettings)),
            Effect.tap(({ membership, teamTz }) =>
              challenges.markCompleted(challengeId, membership.id, teamTz),
            ),
            Effect.asVoid,
          ),
        )
        .handle('unmarkCompleted', ({ params: { teamId, challengeId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              membership.active ? Effect.void : Effect.fail(forbidden),
            ),
            // B1: verify challenge belongs to this team before mutating
            Effect.bind('existing', () =>
              challenges
                .findById(challengeId)
                .pipe(Effect.flatMap(Options.toEffect(() => notFound))),
            ),
            Effect.tap(({ existing }) =>
              existing.team_id !== teamId ? Effect.fail(notFound) : Effect.void,
            ),
            Effect.bind('teamSettings', () => settings.findByTeamId(teamId)),
            Effect.let('teamTz', ({ teamSettings }) => resolveTeamTimezone(teamSettings)),
            Effect.tap(({ membership, teamTz }) =>
              challenges.unmarkCompleted(challengeId, membership.id, teamTz),
            ),
            Effect.asVoid,
          ),
        ),
    ),
  ),
);
