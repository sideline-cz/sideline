/**
 * `ai_action_proposals` — the AI write path's confirm-before-write staging table (plan
 * `.work-plans/ai-app-interaction.md` §16, migration `1792400000_create_ai_action_proposals`).
 *
 * Four methods only, all deliberately thin — the transactional composition (read + claim +
 * execute) lives in `confirmProposal` (`api/ai-chat.ts`), NOT here: no `sql.withTransaction` in
 * this file, the caller owns the transaction.
 *
 * `payload::text` both directions (SELECT casts `::text`, the insert binds a JSON string cast
 * back with `::jsonb`) — same rule as `TeamSettingsRepository`'s JSONB columns: the round trip
 * must never depend on how the driver happens to marshal `jsonb`.
 */
import { AiActionProposal, type Auth, type Team } from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

export class LockedProposalRow extends Schema.Class<LockedProposalRow>('LockedProposalRow')({
  action: AiActionProposal.AiActionName,
  payload: Schema.String,
  consumed: Schema.Boolean,
  expired: Schema.Boolean,
}) {}

class ProposalIdRow extends Schema.Class<ProposalIdRow>('ProposalIdRow')({
  id: AiActionProposal.AiActionProposalId,
}) {}

class InsertedProposalRow extends Schema.Class<InsertedProposalRow>('InsertedProposalRow')({
  id: AiActionProposal.AiActionProposalId,
  expires_at: Schemas.DateTimeFromDate,
}) {}

const ScopedProposalRequest = Schema.Struct({
  id: AiActionProposal.AiActionProposalId,
  team_id: Schema.String,
  user_id: Schema.String,
});

const make = Effect.Do.pipe(
  Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
  Effect.map(({ sql }) => {
    // THE claim body's read half. Runs INSIDE the caller's transaction, together with `claim`
    // below, so both observe the same `transaction_timestamp()` for `expires_at <= now()` — see
    // the doc comment on `confirmProposal` for why the read must not happen outside the
    // transaction.
    const _lockForConfirm = SqlSchema.findOneOption({
      Request: ScopedProposalRequest,
      Result: LockedProposalRow,
      execute: (i) => sql`
        SELECT action, payload::text AS payload,
               (consumed_at IS NOT NULL) AS consumed,
               (expires_at <= now())     AS expired
        FROM ai_action_proposals
        WHERE id = ${i.id} AND team_id = ${i.team_id} AND user_id = ${i.user_id}
        FOR UPDATE
      `,
    });

    // Single-use AND expiry enforced in ONE statement. `Option.none()` back from this is
    // unreachable when called after a successful `lockForConfirm` in the same transaction — see
    // `confirmProposal`'s doc comment.
    const _claim = SqlSchema.findOneOption({
      Request: ScopedProposalRequest,
      Result: ProposalIdRow,
      execute: (i) => sql`
        UPDATE ai_action_proposals SET consumed_at = now()
        WHERE id = ${i.id} AND team_id = ${i.team_id} AND user_id = ${i.user_id}
          AND consumed_at IS NULL AND expires_at > now()
        RETURNING id
      `,
    });

    const _insert = SqlSchema.findOne({
      Request: Schema.Struct({
        team_id: Schema.String,
        user_id: Schema.String,
        action: AiActionProposal.AiActionName,
        payload_json: Schema.String,
      }),
      Result: InsertedProposalRow,
      execute: (i) => sql`
        INSERT INTO ai_action_proposals (team_id, user_id, action, payload, expires_at)
        VALUES (${i.team_id}, ${i.user_id}, ${i.action}, ${i.payload_json}::jsonb,
                now() + INTERVAL '15 minutes')
        RETURNING id, expires_at
      `,
    });

    const _deleteForUser = SqlSchema.findOneOption({
      Request: ScopedProposalRequest,
      Result: ProposalIdRow,
      execute: (i) => sql`
        DELETE FROM ai_action_proposals
        WHERE id = ${i.id} AND team_id = ${i.team_id} AND user_id = ${i.user_id}
        RETURNING id
      `,
    });

    const lockForConfirm = (params: {
      readonly id: AiActionProposal.AiActionProposalId;
      readonly team_id: Team.TeamId;
      readonly user_id: Auth.UserId;
    }) => _lockForConfirm(params).pipe(catchSqlErrors);

    const claim = (params: {
      readonly id: AiActionProposal.AiActionProposalId;
      readonly team_id: Team.TeamId;
      readonly user_id: Auth.UserId;
    }) => _claim(params).pipe(catchSqlErrors);

    const insert = (params: {
      readonly team_id: Team.TeamId;
      readonly user_id: Auth.UserId;
      readonly action: AiActionProposal.AiActionName;
      readonly payload_json: string;
    }) => _insert(params).pipe(catchSqlErrors);

    const deleteForUser = (params: {
      readonly id: AiActionProposal.AiActionProposalId;
      readonly team_id: Team.TeamId;
      readonly user_id: Auth.UserId;
    }) => _deleteForUser(params).pipe(catchSqlErrors);

    return { lockForConfirm, claim, insert, deleteForUser };
  }),
);

export class AiActionProposalsRepository extends ServiceMap.Service<
  AiActionProposalsRepository,
  Effect.Success<typeof make>
>()('api/AiActionProposalsRepository') {
  static readonly Default = Layer.effect(AiActionProposalsRepository, make);
}
