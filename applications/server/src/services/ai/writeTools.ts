/**
 * The AI write path's single executor — plan `.work-plans/ai-app-interaction.md` §16. One
 * function handles every `propose_*` tool call, dispatching generically into `ACTION_REGISTRY`
 * (`services/ai/actions.ts`) rather than switching on the action name — a new registry entry
 * therefore needs no change here.
 */
import { type AiActionProposal, AiChatApi } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Result } from 'effect';
import { hasPermission } from '~/api/permissions.js';
import { AiActionProposalsRepository } from '~/repositories/AiActionProposalsRepository.js';
import type { GroupsRepository } from '~/repositories/GroupsRepository.js';
import type { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { ACTION_REGISTRY } from '~/services/ai/actions.js';
import {
  forbiddenResult,
  type ToolContext,
  type ToolExecutionResult,
} from '~/services/ai/toolTypes.js';

/**
 * Re-checks `def.permission` even though `visibleTools` (`registry.ts`) already hid
 * `propose_<action>` from a caller without it — that filter is UX only, never the security
 * boundary; the provider can still emit a call for a tool it was never offered.
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
  GroupsRepository | TrainingTypesRepository | AiActionProposalsRepository
> => {
  const def = ACTION_REGISTRY[action];
  if (!hasPermission(ctx.membership, def.permission)) {
    return Effect.succeed(forbiddenResult(def.permission));
  }
  return Effect.Do.pipe(
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
};
