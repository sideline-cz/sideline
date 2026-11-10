/**
 * The AI write path's single executor — plan `.work-plans/ai-app-interaction.md` §16. One
 * function handles every `propose_*` tool call, dispatching generically into `ACTION_REGISTRY`
 * (`services/ai/actions.ts`) rather than switching on the action name — a new registry entry
 * therefore needs no change here.
 */
import { type AiActionProposal, AiChatApi } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Option, Result } from 'effect';
import { hasPermission } from '~/api/permissions.js';
import { AiActionProposalsRepository } from '~/repositories/AiActionProposalsRepository.js';
import type { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { ACTION_REGISTRY, type ActionDefinition, type ProposeR } from '~/services/ai/actions.js';
import { connectedGuildId, discordNotConnected } from '~/services/ai/readTools.js';
import {
  forbiddenResult,
  type ToolContext,
  type ToolExecutionResult,
} from '~/services/ai/toolTypes.js';

/** Runs the action's own `propose` and, only on success, inserts the proposal row. */
const proposeAndPersist = (
  def: ActionDefinition,
  action: AiActionProposal.AiActionName,
  rawArgs: unknown,
  ctx: ToolContext,
): Effect.Effect<ToolExecutionResult, never, ProposeR | AiActionProposalsRepository> =>
  Effect.Do.pipe(
    Effect.bind('proposals', () => AiActionProposalsRepository.asEffect()),
    Effect.bind('proposed', () => def.propose(rawArgs, ctx)),
    Effect.flatMap(({ proposals, proposed }) =>
      Result.match(proposed, {
        onFailure: (detail): Effect.Effect<ToolExecutionResult> =>
          Effect.succeed({ result: { error: 'invalid_arguments', detail }, hits: [] }),
        onSuccess: ({ payloadJson, summary }): Effect.Effect<ToolExecutionResult> =>
          proposals
            .insert({
              team_id: ctx.teamId,
              user_id: ctx.membership.user_id,
              action,
              payload_json: payloadJson,
            })
            .pipe(
              Effect.map(
                (row): ToolExecutionResult => ({
                  result: { status: 'proposed', proposalId: row.id },
                  hits: [],
                  proposal: new AiChatApi.Proposal({
                    id: row.id,
                    action,
                    summary,
                    expiresAt: row.expires_at,
                  }),
                }),
              ),
              // `SqlSchema.findOne` (unlike `findOneOption`) fails `NoSuchElementError` if the
              // `INSERT ... RETURNING` produced no row — unreachable for a bare insert with no
              // `WHERE`, but still a typed possibility the repository leaves to its caller
              // (mirrors `EventsRepository.insertEvent`'s callers).
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => 'Failed inserting ai_action_proposals row'),
              ),
            ),
      }),
    ),
  );

/**
 * Re-checks `def.permissions` even though `visibleTools` (`registry.ts`) already hid
 * `propose_<action>` from a caller without it — that filter is UX only, never the security
 * boundary; the provider can still emit a call for a tool it was never offered.
 *
 * A Discord action (`def.requiresDiscord`) is refused with `discord_not_connected` when the bot
 * is not in the team's guild. Every refusal returns before the insert: nothing is written.
 *
 * On success, persists the proposal (`AiActionProposalsRepository.insert`) and returns BOTH the
 * model-facing `result` (just `{ status: 'proposed', proposalId }` — no payload field reaches the
 * model) and the `proposal` the client renders as a confirmation card.
 */
export const proposeAction = (
  action: AiActionProposal.AiActionName,
  rawArgs: unknown,
  ctx: ToolContext,
): Effect.Effect<
  ToolExecutionResult,
  never,
  ProposeR | BotGuildsRepository | AiActionProposalsRepository
> => {
  const def = ACTION_REGISTRY[action];
  const missing = def.permissions.find((p) => !hasPermission(ctx.membership, p));
  if (missing !== undefined) {
    return Effect.succeed(forbiddenResult(missing));
  }
  const connected = def.requiresDiscord
    ? connectedGuildId(ctx.teamId).pipe(Effect.map(Option.isSome))
    : Effect.succeed(true);
  return connected.pipe(
    Effect.flatMap((ok) =>
      ok ? proposeAndPersist(def, action, rawArgs, ctx) : Effect.succeed(discordNotConnected),
    ),
  );
};
