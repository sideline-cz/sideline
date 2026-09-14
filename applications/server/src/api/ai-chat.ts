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
import { AiChatApi, Auth, type Team } from '@sideline/domain';
import { DateTime, Effect, Option, type ServiceMap } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership } from '~/api/permissions.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { AiChatEnabledConfig } from '~/services/AiChatEnabledConfig.js';
import type { ToolContext } from '~/services/ai/toolTypes.js';
import { makeCanSeeGroup } from '~/services/ai/toolTypes.js';
import type { ChatAgentResult } from '~/services/ChatAgent.js';
import { ChatAgent } from '~/services/ChatAgent.js';
import { ChatRateLimiter } from '~/services/ChatRateLimiter.js';
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
});

const toChatResponse = (result: ChatAgentResult): AiChatApi.ChatResponse =>
  new AiChatApi.ChatResponse({
    answer: result.answer,
    generated: result.generated,
    degradedReason: result.degradedReason,
    references: result.references,
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
    Effect.map(
      ({ members, groups, teamSettings, chatAgent, rateLimiter, llm, aiChatEnabledConfig }) =>
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
          ),
    ),
  ),
);
