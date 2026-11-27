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
 *
 * `confirmProposal` serves every `ACTION_REGISTRY` action, not only events: `create_event` answers
 * 201 with the created `EventInfo`; a Discord action answers 202 `DiscordChangeQueued`, because
 * confirm only queues the change for the bot; an update, cancel or attendance confirm answers 200
 * `AiActionApplied`.
 */
import { AiChatApi, Auth, EventApi, type Team } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership } from '~/api/permissions.js';
import type { EventRow } from '~/repositories/EventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { AiChatEnabledConfig } from '~/services/AiChatEnabledConfig.js';
import type { ConfirmResult } from '~/services/ai/actions.js';
import { chatTurn, confirmTurn, rejectTurn } from '~/services/ai/turns.js';
import type { ChatAgentResult } from '~/services/ChatAgent.js';
import { LlmClient } from '~/services/LlmClient.js';

const forbidden = new AiChatApi.AiChatForbidden();

const toChatResponse = (result: ChatAgentResult): AiChatApi.ChatResponse =>
  new AiChatApi.ChatResponse({
    answer: result.answer,
    generated: result.generated,
    degradedReason: result.degradedReason,
    references: result.references,
    proposal: result.proposal,
  });

// Built from the RAW row, after `emitEventCreatedSideEffects` ran.
const toConfirmedEventInfo = (event: EventRow): EventApi.EventInfo =>
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
  });

type ConfirmedResponse =
  | EventApi.EventInfo
  | AiChatApi.DiscordChangeQueued
  | AiChatApi.AiActionApplied;

const toConfirmedResponse = (result: ConfirmResult): ConfirmedResponse => {
  switch (result.kind) {
    case 'event_created':
      return toConfirmedEventInfo(result.event);
    case 'discord_queued':
      return new AiChatApi.DiscordChangeQueued({ status: 'queued' });
    case 'event_updated':
    case 'event_cancelled':
    case 'attendance_confirmed':
    case 'rsvp_submitted':
    case 'applied':
      return new AiChatApi.AiActionApplied({ status: 'applied' });
  }
};

export const AiChatApiLive = HttpApiBuilder.group(Api, 'aiChat', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('llm', () => LlmClient.asEffect()),
    Effect.bind('aiChatEnabledConfig', () => AiChatEnabledConfig.asEffect()),
    Effect.map(({ members, llm, aiChatEnabledConfig }) => {
      // Membership runs first and short-circuits: a non-member gets 403 before the kill switch
      // or the rate limiter are even consulted.
      const membershipOf = (teamId: Team.TeamId) =>
        Auth.CurrentUserContext.asEffect().pipe(
          Effect.flatMap((currentUser) =>
            requireMembership(members, teamId, currentUser.id, forbidden),
          ),
        );
      return handlers
        .handle('getCapabilities', ({ params: { teamId } }) =>
          membershipOf(teamId).pipe(
            Effect.andThen(aiChatEnabledConfig.asEffect),
            Effect.map(
              (aiChatEnabled) =>
                new AiChatApi.Capabilities({ enabled: aiChatEnabled && llm.configured }),
            ),
          ),
        )
        .handle('chat', ({ params: { teamId }, payload }) =>
          membershipOf(teamId).pipe(
            Effect.flatMap((membership) => chatTurn(teamId, membership, payload.messages)),
            Effect.map(toChatResponse),
          ),
        )
        .handle('confirmProposal', ({ params: { teamId, proposalId } }) =>
          membershipOf(teamId).pipe(
            Effect.flatMap((membership) => confirmTurn(teamId, membership, proposalId)),
            Effect.map(({ result }) => toConfirmedResponse(result)),
          ),
        )
        .handle('rejectProposal', ({ params: { teamId, proposalId } }) =>
          membershipOf(teamId).pipe(
            Effect.flatMap((membership) => rejectTurn(teamId, membership, proposalId)),
          ),
        );
    }),
  ),
);
