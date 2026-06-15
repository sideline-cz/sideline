import { Auth, Elo, PlayerRatingApi, type Team, type TeamMember } from '@sideline/domain';
import { DateTime, Effect, Option, type ServiceMap } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import {
  GLOBAL_ADMIN_SENTINEL_ID,
  hasPermission,
  requirePermission,
  requireReadAccess,
} from '~/api/permissions.js';
import { PlayerRatingsRepository } from '~/repositories/PlayerRatingsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 50;

// ---------------------------------------------------------------------------
// Gate: requires member:edit on ALL endpoints
// Resolves read access then additionally checks member:edit.
// Global admins bypass the permission check because VIEW_PERMISSIONS lacks member:edit.
// ---------------------------------------------------------------------------

const requireManageAccess = (
  members: ServiceMap.Service.Shape<typeof TeamMembersRepository>,
  teamId: Team.TeamId,
) =>
  Effect.Do.pipe(
    Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
    Effect.bind('membership', () =>
      requireReadAccess(members, teamId, new PlayerRatingApi.Forbidden()),
    ),
    Effect.tap(({ currentUser, membership }) =>
      currentUser.isGlobalAdmin
        ? Effect.void
        : requirePermission(membership, 'member:edit', new PlayerRatingApi.Forbidden()),
    ),
  );

// ---------------------------------------------------------------------------
// API Live
// ---------------------------------------------------------------------------

export const PlayerRatingApiLive = HttpApiBuilder.group(Api, 'playerRating', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('ratings', () => PlayerRatingsRepository.asEffect()),
    Effect.map(({ members, ratings }) =>
      handlers
        // ------------------------------------------------------------------
        // GET /teams/:teamId/ratings
        // ------------------------------------------------------------------
        .handle('getTeamRatings', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('gate', () => requireManageAccess(members, teamId)),
            Effect.bind('rows', () => ratings.getTeamRatings(teamId)),
            Effect.map(({ gate: { currentUser, membership }, rows }) => {
              const canManage =
                currentUser.isGlobalAdmin || hasPermission(membership, 'member:edit');

              const entries = rows.map(
                (row) =>
                  new PlayerRatingApi.TeamRatingEntry({
                    memberId: row.team_member_id,
                    rating: row.rating,
                    gamesPlayed: row.games_played,
                    previousRating: row.prev_rating,
                    lastDelta: row.last_delta,
                    wins: row.wins,
                    losses: row.losses,
                    draws: row.draws,
                  }),
              );

              return new PlayerRatingApi.TeamRatingsResponse({
                canManage,
                calibrationThreshold: Elo.CALIBRATION_GAMES,
                entries,
              });
            }),
          ),
        )
        // ------------------------------------------------------------------
        // GET /teams/:teamId/members/:memberId/rating
        // ------------------------------------------------------------------
        .handle('getMemberRating', ({ params: { teamId, memberId } }) =>
          Effect.Do.pipe(
            Effect.tap(() => requireManageAccess(members, teamId)),
            // Verify member belongs to this team
            Effect.tap(() =>
              members.findRosterMemberByIds(teamId, memberId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new PlayerRatingApi.PlayerNotFound()),
                    onSome: () => Effect.void,
                  }),
                ),
              ),
            ),
            Effect.bind('row', () => ratings.getMemberRating(teamId, memberId)),
            Effect.map(({ row }) => {
              if (Option.isNone(row)) {
                // Member exists but has never played — return defaults
                return new PlayerRatingApi.MemberRatingResponse({
                  memberId,
                  rating: Elo.DEFAULT_RATING,
                  gamesPlayed: 0,
                  previousRating: Option.none(),
                  lastDelta: Option.none(),
                  wins: 0,
                  losses: 0,
                  draws: 0,
                  isCalibrating: true,
                  calibrationThreshold: Elo.CALIBRATION_GAMES,
                });
              }

              const r = row.value;
              return new PlayerRatingApi.MemberRatingResponse({
                memberId: r.team_member_id,
                rating: r.rating,
                gamesPlayed: r.games_played,
                previousRating: r.prev_rating,
                lastDelta: r.last_delta,
                wins: r.wins,
                losses: r.losses,
                draws: r.draws,
                isCalibrating: r.games_played < Elo.CALIBRATION_GAMES,
                calibrationThreshold: Elo.CALIBRATION_GAMES,
              });
            }),
          ),
        )
        // ------------------------------------------------------------------
        // GET /teams/:teamId/members/:memberId/rating/history
        // ------------------------------------------------------------------
        .handle('getMemberRatingHistory', ({ params: { teamId, memberId } }) =>
          Effect.Do.pipe(
            Effect.tap(() => requireManageAccess(members, teamId)),
            // Verify member belongs to this team
            Effect.tap(() =>
              members.findRosterMemberByIds(teamId, memberId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new PlayerRatingApi.PlayerNotFound()),
                    onSome: () => Effect.void,
                  }),
                ),
              ),
            ),
            Effect.bind('history', () =>
              ratings.findHistoryByMember(teamId, memberId, HISTORY_LIMIT),
            ),
            Effect.map(
              ({ history }) =>
                new PlayerRatingApi.RatingHistoryResponse({
                  entries: history.map(
                    (h) =>
                      new PlayerRatingApi.RatingHistoryEntry({
                        id: h.id,
                        ratingBefore: h.rating_before,
                        ratingAfter: h.rating_after,
                        delta: h.delta,
                        result: h.result,
                        gameId: h.game_id,
                        submittedBy: h.submitted_by,
                        createdAt: DateTime.formatIso(DateTime.makeUnsafe(h.created_at.getTime())),
                      }),
                  ),
                }),
            ),
          ),
        )
        // ------------------------------------------------------------------
        // POST /teams/:teamId/ratings/games
        // ------------------------------------------------------------------
        .handle('applyGameResult', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('gate', () => requireManageAccess(members, teamId)),
            // Validate: non-empty teams
            Effect.tap(() =>
              payload.teamA.length === 0 || payload.teamB.length === 0
                ? Effect.fail(new PlayerRatingApi.InvalidGameResult({ reason: 'emptyTeam' }))
                : Effect.void,
            ),
            // Validate: no duplicates within the same team
            Effect.tap(() => {
              const hasDupA = new Set(payload.teamA).size !== payload.teamA.length;
              const hasDupB = new Set(payload.teamB).size !== payload.teamB.length;
              return hasDupA || hasDupB
                ? Effect.fail(new PlayerRatingApi.InvalidGameResult({ reason: 'overlap' }))
                : Effect.void;
            }),
            // Validate: no overlap between teams
            Effect.tap(() => {
              const setA = new Set(payload.teamA);
              const hasOverlap = payload.teamB.some((id) => setA.has(id));
              return hasOverlap
                ? Effect.fail(new PlayerRatingApi.InvalidGameResult({ reason: 'overlap' }))
                : Effect.void;
            }),
            // Verify all member ids belong to the team
            Effect.bind('rosterIds', () =>
              members
                .findRosterByTeam(teamId)
                .pipe(
                  Effect.map(
                    (roster) => new Set<TeamMember.TeamMemberId>(roster.map((r) => r.member_id)),
                  ),
                ),
            ),
            Effect.tap(({ rosterIds }) => {
              const allIds = [...payload.teamA, ...payload.teamB];
              const unknown = allIds.find((id) => !rosterIds.has(id));
              return unknown !== undefined
                ? Effect.fail(new PlayerRatingApi.InvalidGameResult({ reason: 'unknownMember' }))
                : Effect.void;
            }),
            // Apply updates — read+compute+write is atomic inside the transaction
            Effect.tap(({ gate }) => {
              // submittedBy: the current user's membership id if they are a real member
              const submittedBy =
                gate.membership.id === GLOBAL_ADMIN_SENTINEL_ID
                  ? Option.none<TeamMember.TeamMemberId>()
                  : Option.some(gate.membership.id);

              return ratings.applyGameUpdates({
                teamId,
                teamAMemberIds: payload.teamA,
                teamBMemberIds: payload.teamB,
                outcome: payload.outcome,
                submittedBy,
              });
            }),
            // Return updated team ratings
            Effect.bind('updatedRows', () => ratings.getTeamRatings(teamId)),
            Effect.map(({ gate: { currentUser, membership }, updatedRows }) => {
              const canManage =
                currentUser.isGlobalAdmin || hasPermission(membership, 'member:edit');

              const entries = updatedRows.map(
                (row) =>
                  new PlayerRatingApi.TeamRatingEntry({
                    memberId: row.team_member_id,
                    rating: row.rating,
                    gamesPlayed: row.games_played,
                    previousRating: row.prev_rating,
                    lastDelta: row.last_delta,
                    wins: row.wins,
                    losses: row.losses,
                    draws: row.draws,
                  }),
              );

              return new PlayerRatingApi.TeamRatingsResponse({
                canManage,
                calibrationThreshold: Elo.CALIBRATION_GAMES,
                entries,
              });
            }),
          ),
        ),
    ),
  ),
);
