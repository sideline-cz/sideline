import {
  TeamGenerationApi,
  TeamGenerationConfig,
  TeamGenerator,
  TeamMember,
} from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Option, Schema } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { hasPermission, requireManageAccess } from '~/api/training-shared.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import {
  type TeamGenerationConfigRow,
  TeamGenerationRepository,
} from '~/repositories/TeamGenerationRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MVP_TEAM_COUNT = 2;
const CALIBRATION_GAMES_THRESHOLD = 10;

const forbidden = new TeamGenerationApi.Forbidden();

// Resolve a persisted config (or its absence) to concrete values, falling back to defaults.
const resolveConfigValues = (config: Option.Option<TeamGenerationConfigRow>) => ({
  weightElo: Option.match(config, {
    onNone: () => TeamGenerationConfig.DEFAULT_WEIGHT_ELO,
    onSome: (c) => c.weight_elo,
  }),
  weightSize: Option.match(config, {
    onNone: () => TeamGenerationConfig.DEFAULT_WEIGHT_SIZE,
    onSome: (c) => c.weight_size,
  }),
  weightGender: Option.match(config, {
    onNone: () => TeamGenerationConfig.DEFAULT_WEIGHT_GENDER,
    onSome: (c) => c.weight_gender,
  }),
  defaultTeamCount: Option.match(config, {
    onNone: () => TeamGenerationConfig.DEFAULT_TEAM_COUNT,
    onSome: (c) => c.default_team_count,
  }),
  maxIterations: Option.match(config, {
    onNone: () => TeamGenerationConfig.DEFAULT_MAX_ITERATIONS,
    onSome: (c) => c.max_iterations,
  }),
});

// Decode a plain string to TeamMemberId (for converting engine warnings to API warnings)
const decodeTeamMemberId = Schema.decodeUnknownSync(TeamMember.TeamMemberId);

// Map Option<User.Gender> → TeamGenerator.GenderValue (unknown when None)
const toGenderValue = (gender: Option.Option<string>): TeamGenerator.GenderValue =>
  Option.match(gender, {
    onNone: () => 'unknown' as const,
    onSome: (g): TeamGenerator.GenderValue => {
      switch (g) {
        case 'male':
          return 'male';
        case 'female':
          return 'female';
        case 'other':
          return 'other';
        default:
          return 'unknown';
      }
    },
  });

// Map pure-TS GenerationWarning to the API Schema type
const mapWarning = (w: TeamGenerator.GenerationWarning): TeamGenerationApi.GenerationWarning => {
  if (w._tag === 'EloOutlier') {
    return { _tag: 'EloOutlier', teamMemberId: decodeTeamMemberId(w.teamMemberId) };
  }
  return w;
};

// ---------------------------------------------------------------------------
// API Live
// ---------------------------------------------------------------------------

export const TeamGenerationApiLive = HttpApiBuilder.group(Api, 'teamGeneration', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.map(({ members }) =>
      handlers
        // ------------------------------------------------------------------
        // POST /teams/:teamId/events/:eventId/generate-teams
        // ------------------------------------------------------------------
        .handle('generateTeams', ({ params: { teamId, eventId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('gate', () => requireManageAccess(members, teamId, forbidden)),
            // Lazily acquire repos (keeps unused test layers from breaking)
            Effect.bind('genRepo', () => TeamGenerationRepository.asEffect()),
            Effect.bind('eventsRepo', () => EventsRepository.asEffect()),
            // Load event and validate it belongs to this team and is a training event
            Effect.bind('event', ({ eventsRepo }) =>
              eventsRepo.findEventByIdWithDetails(eventId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new TeamGenerationApi.EventNotGeneratable()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ event }) =>
              event.team_id !== teamId ||
              event.event_type !== 'training' ||
              event.status === 'cancelled'
                ? Effect.fail(new TeamGenerationApi.EventNotGeneratable())
                : Effect.void,
            ),
            // MVP: validate teamCount is 2 if provided
            Effect.tap(() => {
              const requested = Option.getOrElse(payload.teamCount, () => MVP_TEAM_COUNT);
              return requested !== MVP_TEAM_COUNT
                ? Effect.fail(new TeamGenerationApi.UnsupportedTeamCount())
                : Effect.void;
            }),
            // Load RSVP-yes members with enriched data
            Effect.bind('yesMembers', ({ genRepo }) => genRepo.findYesMembersForEvent(eventId)),
            // Check we have enough players
            Effect.tap(({ yesMembers }) =>
              yesMembers.length < MVP_TEAM_COUNT
                ? Effect.fail(new TeamGenerationApi.InsufficientPlayers())
                : Effect.void,
            ),
            // Load config (fallback to defaults if no row)
            Effect.bind('config', ({ genRepo }) => genRepo.findConfigByTeamId(teamId)),
            Effect.let('constraints', ({ config }) => {
              const resolved = resolveConfigValues(config);
              return {
                teamCount: MVP_TEAM_COUNT,
                weightElo: resolved.weightElo,
                weightSize: resolved.weightSize,
                weightGender: resolved.weightGender,
                maxIterations: resolved.maxIterations,
              };
            }),
            // Map to GeneratablePlayer
            Effect.let('players', ({ yesMembers }) =>
              yesMembers.map(
                (m): TeamGenerator.GeneratablePlayer => ({
                  teamMemberId: m.team_member_id,
                  rating: m.rating,
                  gender: toGenderValue(m.gender),
                }),
              ),
            ),
            // Run the pure generator
            Effect.let('result', ({ players, constraints }) =>
              TeamGenerator.generateTeams(players, constraints),
            ),
            // Build the enriched response
            Effect.flatMap(({ result, yesMembers }) => {
              // Key by plain string so the engine's string member ids can look up branded ids
              const memberMap = new Map(yesMembers.map((m) => [String(m.team_member_id), m]));

              return Effect.forEach(result.teams, (team) =>
                Effect.forEach(team.members, (memberId) => {
                  const m = memberMap.get(String(memberId));
                  if (m === undefined) {
                    return LogicError.die(
                      `generateTeams: missing member ${memberId} in enrichment map`,
                    );
                  }
                  return Effect.succeed(
                    new TeamGenerationApi.GeneratedTeamMember({
                      teamMemberId: m.team_member_id,
                      displayName: Option.getOrElse(m.display_name, () => 'Unknown'),
                      discordId: m.discord_id,
                      avatar: m.avatar,
                      rating: m.rating,
                      isCalibrating: m.games_played < CALIBRATION_GAMES_THRESHOLD,
                      role: m.role_name,
                      jerseyNumber: m.jersey_number,
                      gender: m.gender,
                    }),
                  );
                }).pipe(
                  Effect.map(
                    (enrichedMembers) =>
                      new TeamGenerationApi.GeneratedTeamResponse({
                        index: team.index,
                        members: enrichedMembers,
                        averageRating: team.averageRating,
                        genderCounts: team.genderCounts,
                      }),
                  ),
                ),
              ).pipe(
                Effect.map(
                  (teams) =>
                    new TeamGenerationApi.GenerateTeamsResponse({
                      teams,
                      maxRatingSpread: result.maxRatingSpread,
                      iterationsUsed: result.iterationsUsed,
                      warnings: result.warnings.map(mapWarning),
                    }),
                ),
              );
            }),
          ),
        )
        // ------------------------------------------------------------------
        // GET /teams/:teamId/generation-config
        // ------------------------------------------------------------------
        .handle('getGenerationConfig', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('gate', () => requireManageAccess(members, teamId, forbidden)),
            Effect.bind('genRepo', () => TeamGenerationRepository.asEffect()),
            Effect.bind('config', ({ genRepo }) => genRepo.findConfigByTeamId(teamId)),
            Effect.map(({ gate: { currentUser, membership }, config }) => {
              const canManage =
                currentUser.isGlobalAdmin || hasPermission(membership, 'member:edit');
              return new TeamGenerationApi.GenerationConfigResponse({
                teamId,
                ...resolveConfigValues(config),
                canManage,
              });
            }),
          ),
        )
        // ------------------------------------------------------------------
        // PATCH /teams/:teamId/generation-config
        // ------------------------------------------------------------------
        .handle('updateGenerationConfig', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('gate', () => requireManageAccess(members, teamId, forbidden)),
            Effect.bind('genRepo', () => TeamGenerationRepository.asEffect()),
            // Load existing config for merge-with-defaults
            Effect.bind('existing', ({ genRepo }) => genRepo.findConfigByTeamId(teamId)),
            Effect.let('current', ({ existing }) => resolveConfigValues(existing)),
            Effect.flatMap(({ gate, genRepo, current }) =>
              genRepo
                .upsertConfig({
                  teamId,
                  weightElo: Option.getOrElse(payload.weightElo, () => current.weightElo),
                  weightSize: Option.getOrElse(payload.weightSize, () => current.weightSize),
                  weightGender: Option.getOrElse(payload.weightGender, () => current.weightGender),
                  defaultTeamCount: Option.getOrElse(
                    payload.defaultTeamCount,
                    () => current.defaultTeamCount,
                  ),
                  maxIterations: Option.getOrElse(
                    payload.maxIterations,
                    () => current.maxIterations,
                  ),
                })
                .pipe(
                  Effect.catchTag(
                    'NoSuchElementError',
                    LogicError.withMessage(
                      () => 'Failed upserting team generation config — no row returned',
                    ),
                  ),
                  Effect.map((updated) => {
                    const canManage =
                      gate.currentUser.isGlobalAdmin ||
                      hasPermission(gate.membership, 'member:edit');
                    return new TeamGenerationApi.GenerationConfigResponse({
                      teamId: updated.team_id,
                      weightElo: updated.weight_elo,
                      weightSize: updated.weight_size,
                      weightGender: updated.weight_gender,
                      defaultTeamCount: updated.default_team_count,
                      maxIterations: updated.max_iterations,
                      canManage,
                    });
                  }),
                ),
            ),
          ),
        )
        // ------------------------------------------------------------------
        // POST /teams/:teamId/events/:eventId/post-teams-to-discord
        // ------------------------------------------------------------------
        .handle('postTeamsToDiscord', ({ params: { teamId, eventId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('gate', () => requireManageAccess(members, teamId, forbidden)),
            Effect.bind('eventsRepo', () => EventsRepository.asEffect()),
            Effect.bind('teamsRepo', () => TeamsRepository.asEffect()),
            Effect.bind('mappings', () => DiscordChannelMappingRepository.asEffect()),
            Effect.bind('syncEvents', () => EventSyncEventsRepository.asEffect()),
            Effect.bind('genRepo', () => TeamGenerationRepository.asEffect()),
            // Validate the team exists and get guild_id
            Effect.bind('team', ({ teamsRepo }) =>
              teamsRepo.findById(teamId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new TeamGenerationApi.DiscordPostFailed()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            // Validate event belongs to this team and is a non-cancelled training event
            Effect.bind('event', ({ eventsRepo }) =>
              eventsRepo.findEventByIdWithDetails(eventId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new TeamGenerationApi.EventNotGeneratable()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ event }) =>
              event.team_id !== teamId ||
              event.event_type !== 'training' ||
              event.status === 'cancelled'
                ? Effect.fail(new TeamGenerationApi.EventNotGeneratable())
                : Effect.void,
            ),
            // Re-load the trusted roster from DB to build the Discord payload server-side
            Effect.bind('yesMembers', ({ genRepo }) => genRepo.findYesMembersForEvent(eventId)),
            // Validate submitted memberIds against trusted roster
            Effect.tap(({ yesMembers }) => {
              const rosterIds = new Set(yesMembers.map((m) => String(m.team_member_id)));
              const submittedIds = payload.teams.flatMap((t) => t.memberIds.map(String));

              // Check for duplicates
              const submittedSet = new Set<string>();
              for (const id of submittedIds) {
                if (submittedSet.has(id)) {
                  return Effect.fail(new TeamGenerationApi.TeamGenerationRosterChanged());
                }
                submittedSet.add(id);
              }

              // Every submitted id must be in the trusted roster
              for (const id of submittedIds) {
                if (!rosterIds.has(id)) {
                  return Effect.fail(new TeamGenerationApi.TeamGenerationRosterChanged());
                }
              }

              // Every roster member must appear in the submission
              for (const id of rosterIds) {
                if (!submittedSet.has(id)) {
                  return Effect.fail(new TeamGenerationApi.TeamGenerationRosterChanged());
                }
              }

              return Effect.void;
            }),
            // Resolve the target Discord channel via the event's owner group mapping
            Effect.bind('channelId', ({ event, mappings }) =>
              Option.match(event.owner_group_id, {
                onNone: () => Effect.succeed(Option.none()),
                onSome: (ownerGroupId) =>
                  mappings
                    .findByGroupId(teamId, ownerGroupId)
                    .pipe(
                      Effect.map((mapping) => Option.flatMap(mapping, (m) => m.discord_channel_id)),
                    ),
              }),
            ),
            // If no channel resolved, fail with DiscordPostFailed so the web surfaces it
            Effect.tap(({ channelId }) =>
              Option.isNone(channelId)
                ? Effect.fail(new TeamGenerationApi.DiscordPostFailed())
                : Effect.void,
            ),
            // Build teams payload entirely from trusted DB rows
            Effect.flatMap(({ team, event, channelId, syncEvents, yesMembers }) => {
              const memberMap = new Map(yesMembers.map((m) => [String(m.team_member_id), m]));

              const trustedTeams = payload.teams.map((t, idx) => {
                const teamMembers = t.memberIds.map((id) => {
                  const m = memberMap.get(String(id));
                  // Already validated above; m is guaranteed to exist here
                  if (m === undefined) {
                    return { display_name: 'Unknown', rating: 1200, is_calibrating: false };
                  }
                  return {
                    display_name: Option.getOrElse(m.display_name, () => 'Unknown'),
                    rating: m.rating,
                    is_calibrating: m.games_played < CALIBRATION_GAMES_THRESHOLD,
                  };
                });
                const avgRating =
                  teamMembers.length === 0
                    ? 1200
                    : Math.round(
                        teamMembers.reduce((acc, m) => acc + m.rating, 0) / teamMembers.length,
                      );
                return {
                  name: `Team ${idx + 1}`,
                  avg_rating: avgRating,
                  members: teamMembers,
                };
              });

              // Atomic insert-if-not-pending. A `false` result means a post is already
              // queued for this event — reject as pending (anti-spam). This closes the
              // check-then-insert race against concurrent posts.
              // TODO: Future work — edit the existing Discord message on repost instead of re-enqueuing.
              return syncEvents
                .emitTeamsGenerated(
                  teamId,
                  team.guild_id,
                  eventId,
                  event.title,
                  channelId,
                  trustedTeams,
                )
                .pipe(
                  Effect.flatMap((inserted) =>
                    inserted
                      ? Effect.logInfo(`Enqueued teams_generated for event ${event.id}`)
                      : Effect.fail(new TeamGenerationApi.TeamGenerationPostPending()),
                  ),
                );
            }),
            Effect.asVoid,
          ),
        ),
    ),
  ),
);
