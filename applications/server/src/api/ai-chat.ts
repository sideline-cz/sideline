/**
 * The read-only in-app AI assistant's HTTP layer — plan `.work-plans/ai-app-interaction.md` §3
 * (wire contract) and §10 (authorization / rate limiting / kill switch).
 *
 * Ordering is load-bearing and directly tested (`test/api/ai-chat.test.ts`): membership → kill
 * switch/LLM-configured → rate limiter → `ChatAgent`. A non-member gets 403 before either the
 * kill switch or the rate limiter are even consulted (`requireMembership` runs first and
 * short-circuits on failure). A disabled server, OR one with no LLM configured, returns its
 * degraded response WITHOUT touching the rate limiter or `ChatAgent` — matching
 * `docs/deployment.md`'s `AI_CHAT_ENABLED` row and `getCapabilities`' own `enabled` computation
 * below: neither condition alone may spend a caller's rate-limit budget.
 */
import { AiChatApi, Auth, EventApi, type Team } from '@sideline/domain';
import { DateTime, Effect, Option, type ServiceMap } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission } from '~/api/permissions.js';
import {
  AiActionProposalsRepository,
  type LockedProposalRow,
} from '~/repositories/AiActionProposalsRepository.js';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { AiChatEnabledConfig } from '~/services/AiChatEnabledConfig.js';
import { ACTION_REGISTRY } from '~/services/ai/actions.js';
import type { ToolContext } from '~/services/ai/toolTypes.js';
import { makeCanSeeGroup } from '~/services/ai/toolTypes.js';
import type { ChatAgentResult } from '~/services/ChatAgent.js';
import { ChatAgent } from '~/services/ChatAgent.js';
import { ChatRateLimiter } from '~/services/ChatRateLimiter.js';
import { emitEventCreatedSideEffects } from '~/services/EventCreation.js';
import { LlmClient } from '~/services/LlmClient.js';

const forbidden = new AiChatApi.AiChatForbidden();

// `team_settings.timezone` has no CHECK constraint (same caveat as `dashboard.ts`'s
// `rawTeamTimezone` and `resolveZoned` in `event.ts`) — validate before it ever reaches
// `Intl.DateTimeFormat`, which throws a `RangeError` (a defect, not a typed failure) on an
// invalid IANA id. A team with no `team_settings` row, or an invalid stored value, falls back to
// the same `'Europe/Prague'` default the column itself uses.
const DEFAULT_TEAM_TIMEZONE = 'Europe/Prague';

const resolveTeamTimezone = (
  teamSettings: ServiceMap.Service.Shape<typeof TeamSettingsRepository>,
  teamId: Team.TeamId,
): Effect.Effect<string> =>
  teamSettings.findByTeamId(teamId).pipe(
    Effect.map((row) => {
      const raw = Option.match(row, {
        onNone: () => DEFAULT_TEAM_TIMEZONE,
        onSome: (r) => r.timezone,
      });
      return Option.isSome(DateTime.zoneMakeNamed(raw)) ? raw : DEFAULT_TEAM_TIMEZONE;
    }),
  );

const degradedResult = (reason: AiChatApi.DegradedReason): ChatAgentResult => ({
  answer: '',
  generated: false,
  degradedReason: Option.some(reason),
  references: [],
  proposal: Option.none(),
});

const toChatResponse = (result: ChatAgentResult): AiChatApi.ChatResponse =>
  new AiChatApi.ChatResponse({
    answer: result.answer,
    generated: result.generated,
    degradedReason: result.degradedReason,
    references: result.references,
    proposal: result.proposal,
  });

export const AiChatApiLive = HttpApiBuilder.group(Api, 'aiChat', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('teamSettings', () => TeamSettingsRepository.asEffect()),
    Effect.bind('chatAgent', () => ChatAgent.asEffect()),
    Effect.bind('rateLimiter', () => ChatRateLimiter.asEffect()),
    Effect.bind('llm', () => LlmClient.asEffect()),
    Effect.bind('aiChatEnabledConfig', () => AiChatEnabledConfig.asEffect()),
    Effect.bind('proposals', () => AiActionProposalsRepository.asEffect()),
    Effect.map(
      ({
        members,
        groups,
        teamSettings,
        chatAgent,
        rateLimiter,
        llm,
        aiChatEnabledConfig,
        proposals,
      }) =>
        handlers
          .handle('getCapabilities', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.tap(({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.bind('aiChatEnabled', () => aiChatEnabledConfig.asEffect),
              Effect.map(
                ({ aiChatEnabled }) =>
                  new AiChatApi.Capabilities({ enabled: aiChatEnabled && llm.configured }),
              ),
            ),
          )
          .handle('chat', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.bind('aiChatEnabled', () => aiChatEnabledConfig.asEffect),
              // `docs/deployment.md`'s `AI_CHAT_ENABLED` row promises `chat` short-circuits
              // "before consuming any rate-limit budget or calling the LLM" when no LLM is
              // configured, not just when the kill switch is off — this guard must check BOTH,
              // matching `getCapabilities` (`:86` above), which already does (CONCERN 3 fix: a
              // previous version only checked `aiChatEnabled`, so an enabled-but-unconfigured
              // server spent rate-limit budget on every call before `ChatAgent` degraded it).
              Effect.flatMap(({ currentUser, membership, aiChatEnabled }) =>
                aiChatEnabled && llm.configured
                  ? rateLimiter.check(currentUser.id).pipe(
                      Effect.flatMap(
                        Option.match({
                          onSome: (retryAfterSeconds) =>
                            Effect.fail(new AiChatApi.AiChatRateLimited({ retryAfterSeconds })),
                          onNone: () =>
                            Effect.Do.pipe(
                              Effect.bind('teamTimezone', () =>
                                resolveTeamTimezone(teamSettings, teamId),
                              ),
                              Effect.let(
                                'ctx',
                                ({ teamTimezone }): ToolContext => ({
                                  teamId,
                                  membership,
                                  teamTimezone,
                                  canSeeGroup: makeCanSeeGroup(groups, membership.id),
                                }),
                              ),
                              Effect.flatMap(({ ctx }) => chatAgent.respond(ctx, payload.messages)),
                            ),
                        }),
                      ),
                    )
                  : Effect.succeed(degradedResult(aiChatEnabled ? 'not_configured' : 'disabled')),
              ),
              Effect.map(toChatResponse),
            ),
          )
          .handle('confirmProposal', ({ params: { teamId, proposalId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              // 1. Membership.
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              // 1b. Kill switch — gated here too, not just on `chat`: `AI_CHAT_ENABLED=false`
              // must stop AI WRITES immediately, not leave a 15-minute tail of confirmable
              // proposals an operator flipping the switch expects to already be inert.
              Effect.bind('aiChatEnabled', () => aiChatEnabledConfig.asEffect),
              Effect.tap(({ aiChatEnabled }) =>
                aiChatEnabled ? Effect.void : Effect.fail(forbidden),
              ),
              Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
              // 2 (permission) / 3 (claim) / 4 (execute) all inside ONE transaction — see
              // `AiActionProposalsRepository`'s doc comment for why the read must happen inside
              // it too. Permission is re-checked BEFORE the claim so a caller who lost
              // `event:create` between propose and confirm gets 403 with the row still
              // claimable, not consumed for nothing.
              Effect.bind('event', ({ sql, membership, currentUser }) =>
                sql
                  .withTransaction(
                    proposals
                      .lockForConfirm({ id: proposalId, team_id: teamId, user_id: currentUser.id })
                      .pipe(
                        Effect.flatMap(
                          (
                            locked,
                          ): Effect.Effect<
                            LockedProposalRow,
                            | AiChatApi.AiProposalNotFound
                            | AiChatApi.AiProposalAlreadyUsed
                            | AiChatApi.AiProposalExpired
                          > =>
                            Option.match(locked, {
                              onNone: () => Effect.fail(new AiChatApi.AiProposalNotFound()),
                              onSome: (row) =>
                                row.consumed
                                  ? Effect.fail(new AiChatApi.AiProposalAlreadyUsed())
                                  : row.expired
                                    ? Effect.fail(new AiChatApi.AiProposalExpired())
                                    : Effect.succeed(row),
                            }),
                        ),
                        Effect.tap((row) =>
                          requirePermission(
                            membership,
                            ACTION_REGISTRY[row.action].permission,
                            new AiChatApi.AiProposalActionForbidden(),
                          ),
                        ),
                        Effect.tap(() =>
                          proposals
                            .claim({ id: proposalId, team_id: teamId, user_id: currentUser.id })
                            .pipe(
                              Effect.flatMap(
                                Option.match({
                                  // Unreachable: we hold the row lock from `lockForConfirm`
                                  // above, so `consumed_at` cannot change under us and `now()`
                                  // (== `transaction_timestamp()`) cannot advance mid-transaction.
                                  onNone: () =>
                                    Effect.die(
                                      new Error(
                                        'ai proposal claim matched nothing under FOR UPDATE — unreachable',
                                      ),
                                    ),
                                  onSome: () => Effect.void,
                                }),
                              ),
                            ),
                        ),
                        Effect.flatMap((row) =>
                          ACTION_REGISTRY[row.action]
                            .confirm(row.payload, { teamId, membership })
                            .pipe(
                              Effect.catchTag('EventForbidden', () =>
                                Effect.fail(new AiChatApi.AiProposalActionForbidden()),
                              ),
                            ),
                        ),
                      ),
                  )
                  .pipe(catchSqlErrors),
              ),
              // 5. AFTER commit — never inside the transaction (see `EventCreation.ts`'s doc
              // comment: both emitters swallow failures as defects, and a failed statement
              // inside a Postgres transaction aborts it).
              Effect.tap(({ event }) => emitEventCreatedSideEffects(teamId, event)),
              // 6. The view model, built from the RAW row, after the emitter ran.
              Effect.map(
                ({ event }) =>
                  new EventApi.EventInfo({
                    eventId: event.id,
                    teamId: event.team_id,
                    title: event.title,
                    eventType: event.event_type,
                    trainingTypeName: Option.none(),
                    // `insert` doesn't join `event_types` — the id is trigger-resolved and
                    // returned, but name and colour are left `None`, the same treatment
                    // `trainingTypeName` gets above and the same as `createEvent`'s own 201.
                    eventTypeId: event.event_type_id,
                    eventTypeName: Option.none(),
                    eventTypeColor: Option.none(),
                    description: event.description,
                    imageUrl: event.image_url,
                    locationUrl: event.location_url,
                    startAt: event.start_at,
                    endAt: event.end_at,
                    location: event.location,
                    status: event.status,
                    seriesId: event.series_id,
                    allDay: event.all_day,
                    startDate: Option.some(event.start_date),
                    endDate: Option.some(event.end_date),
                  }),
              ),
            ),
          )
          .handle('rejectProposal', ({ params: { teamId, proposalId } }) =>
            // Not kill-switch gated — discarding a proposal must always work.
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.bind('deleted', ({ currentUser }) =>
                proposals.deleteForUser({
                  id: proposalId,
                  team_id: teamId,
                  user_id: currentUser.id,
                }),
              ),
              Effect.flatMap(({ deleted }) =>
                Option.isNone(deleted)
                  ? Effect.fail(new AiChatApi.AiProposalNotFound())
                  : Effect.void,
              ),
            ),
          ),
    ),
  ),
);
