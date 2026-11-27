/**
 * The AI assistant's three user-facing operations — one chat turn, confirm a proposal, reject a
 * proposal — shared by every surface that talks to the assistant: the web's HTTP API
 * (`api/ai-chat.ts`) and the Discord bot's sync RPC (`rpc/assistant`). Each caller resolves WHO is
 * acting (a session user, or a linked Discord account) into a team membership first; from there
 * the path is identical, so Discord cannot drift into a second assistant.
 *
 * Ordering is load-bearing (tested in `test/api/ai-chat.test.ts`): the kill switch and the
 * LLM-configured check run before the rate limiter, so neither a disabled server nor one with no
 * LLM spends a caller's rate-limit budget.
 */
import { type AiActionProposal, AiChatApi, type Team } from '@sideline/domain';
import { DateTime, Effect, Option, type ServiceMap } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { markPersonalMessagesDirtyBestEffort } from '~/api/event.js';
import { requirePermission } from '~/api/permissions.js';
import {
  AiActionProposalsRepository,
  type LockedProposalRow,
} from '~/repositories/AiActionProposalsRepository.js';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { AiChatEnabledConfig } from '~/services/AiChatEnabledConfig.js';
import { ACTION_REGISTRY, type ConfirmResult } from '~/services/ai/actions.js';
import { makeCanSeeGroup, type ToolContext } from '~/services/ai/toolTypes.js';
import { ChatAgent, type ChatAgentResult } from '~/services/ChatAgent.js';
import { ChatRateLimiter } from '~/services/ChatRateLimiter.js';
import { emitEventCreatedSideEffects } from '~/services/EventCreation.js';
import { emitEventCancelledSideEffects } from '~/services/EventWrites.js';
import { LlmClient } from '~/services/LlmClient.js';
import { emitRsvpSideEffects } from '~/services/RsvpWrites.js';

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

/** One chat turn as `membership`. `history` is the whole conversation, newest last. */
export const chatTurn = (
  teamId: Team.TeamId,
  membership: MembershipWithRole,
  history: ReadonlyArray<AiChatApi.ChatMessage>,
) =>
  Effect.Do.pipe(
    Effect.bind('aiChatEnabled', () =>
      AiChatEnabledConfig.asEffect().pipe(Effect.flatMap((config) => config.asEffect)),
    ),
    Effect.bind('llm', () => LlmClient.asEffect()),
    Effect.flatMap(({ aiChatEnabled, llm }) =>
      aiChatEnabled && llm.configured
        ? Effect.Do.pipe(
            Effect.bind('rateLimit', () =>
              ChatRateLimiter.asEffect().pipe(
                Effect.flatMap((limiter) => limiter.check(membership.user_id)),
              ),
            ),
            Effect.tap(({ rateLimit }) =>
              Option.match(rateLimit, {
                onSome: (retryAfterSeconds) =>
                  Effect.fail(new AiChatApi.AiChatRateLimited({ retryAfterSeconds })),
                onNone: () => Effect.void,
              }),
            ),
            Effect.bind('teamSettings', () => TeamSettingsRepository.asEffect()),
            Effect.bind('groups', () => GroupsRepository.asEffect()),
            Effect.bind('teamTimezone', ({ teamSettings }) =>
              resolveTeamTimezone(teamSettings, teamId),
            ),
            Effect.let(
              'ctx',
              ({ teamTimezone, groups }): ToolContext => ({
                teamId,
                membership,
                teamTimezone,
                canSeeGroup: makeCanSeeGroup(groups, membership.id),
              }),
            ),
            Effect.flatMap(({ ctx }) =>
              ChatAgent.asEffect().pipe(Effect.flatMap((agent) => agent.respond(ctx, history))),
            ),
          )
        : Effect.succeed(degradedResult(aiChatEnabled ? 'not_configured' : 'disabled')),
    ),
  );

/** The best-effort work that must run AFTER commit (see `EventCreation.ts`). A Discord action
 *  and an attendance confirm have none: everything they write is in the transaction. */
const afterCommit = (
  teamId: Team.TeamId,
  result: ConfirmResult,
): Effect.Effect<
  void,
  never,
  | EventsRepository
  | Effect.Services<ReturnType<typeof emitEventCreatedSideEffects>>
  | Effect.Services<ReturnType<typeof emitEventCancelledSideEffects>>
  | Effect.Services<ReturnType<typeof emitRsvpSideEffects>>
> => {
  switch (result.kind) {
    case 'event_created':
      return emitEventCreatedSideEffects(teamId, result.event);
    case 'event_updated':
      return EventsRepository.asEffect().pipe(
        Effect.flatMap((events) => markPersonalMessagesDirtyBestEffort(events, result.event.id)),
      );
    case 'event_cancelled':
      return emitEventCancelledSideEffects(teamId, result.event);
    case 'rsvp_submitted':
      return emitRsvpSideEffects(teamId, result.submitted);
    case 'discord_queued':
    case 'attendance_confirmed':
    case 'applied':
      return Effect.void;
  }
};

const forbidden = new AiChatApi.AiChatForbidden();

/**
 * Confirm one pending proposal as `membership`. Permission (re-checked), claim and execute run in
 * ONE transaction — see `AiActionProposalsRepository`'s doc comment for why the read must happen
 * inside it too. Permission is checked BEFORE the claim so a caller who lost one of the action's
 * permissions between propose and confirm gets a 403 with the row still claimable.
 */
export const confirmTurn = (
  teamId: Team.TeamId,
  membership: MembershipWithRole,
  proposalId: AiActionProposal.AiActionProposalId,
) =>
  Effect.Do.pipe(
    // Kill switch — gated here too, not just on chat: `AI_CHAT_ENABLED=false` must stop AI
    // WRITES immediately, not leave a 15-minute tail of confirmable proposals.
    Effect.tap(() =>
      AiChatEnabledConfig.asEffect().pipe(
        Effect.flatMap((config) => config.asEffect),
        Effect.flatMap((enabled) => (enabled ? Effect.void : Effect.fail(forbidden))),
      ),
    ),
    Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
    Effect.bind('proposals', () => AiActionProposalsRepository.asEffect()),
    Effect.bind('result', ({ sql, proposals }) => {
      const key = { id: proposalId, team_id: teamId, user_id: membership.user_id };
      return sql
        .withTransaction(
          proposals.lockForConfirm(key).pipe(
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
              Effect.forEach(
                ACTION_REGISTRY[row.action].permissions,
                (permission) =>
                  requirePermission(
                    membership,
                    permission,
                    new AiChatApi.AiProposalActionForbidden(),
                  ),
                { discard: true },
              ),
            ),
            Effect.tap(() =>
              proposals.claim(key).pipe(
                Effect.flatMap(
                  Option.match({
                    // Unreachable: we hold the row lock from `lockForConfirm` above, so
                    // `consumed_at` cannot change under us and `now()` cannot advance
                    // mid-transaction.
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
              ACTION_REGISTRY[row.action].confirm(row.payload, { teamId, membership }).pipe(
                Effect.map((result) => ({ result, action: row.action })),
                Effect.catchTag('EventForbidden', () =>
                  Effect.fail(new AiChatApi.AiProposalActionForbidden()),
                ),
              ),
            ),
          ),
        )
        .pipe(catchSqlErrors);
    }),
    // AFTER commit — never inside the transaction.
    Effect.tap(({ result }) => afterCommit(teamId, result.result)),
    Effect.map(({ result }) => result),
  );

/** Discard one pending proposal. Not kill-switch gated — discarding must always work. */
export const rejectTurn = (
  teamId: Team.TeamId,
  membership: MembershipWithRole,
  proposalId: AiActionProposal.AiActionProposalId,
) =>
  AiActionProposalsRepository.asEffect().pipe(
    Effect.flatMap((proposals) =>
      proposals.deleteForUser({ id: proposalId, team_id: teamId, user_id: membership.user_id }),
    ),
    Effect.flatMap((deleted) =>
      Option.isNone(deleted) ? Effect.fail(new AiChatApi.AiProposalNotFound()) : Effect.void,
    ),
  );
