import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// PR-8 (level-based role reconciliation, CC-10). `team_members.discord_joined_at` is a tri-state
// (NULL = unknown) consumed only by PR-9's `UserTeam.discordJoined` — it does NOT gate role-sync
// emission (that is a level-based diff computed from the payload's actual Discord roles on every
// `Guild/RegisterMember` / `Guild/ReconcileMembers` call, so writing this column is idempotent and
// never "consumes" anything). No backfill is needed on add: unlike a `*_sent_at` idempotency
// marker, a fresh NULL here does not trigger any notification blast.
//
// `bot_guilds.members_backfilled_at` moved here from PR-9 (review nit) because it is written by
// `Guild/ReconcileMembers`, which is PR-8's RPC.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS discord_joined_at TIMESTAMPTZ`,
    ),
    Effect.tap(
      () => sql`
          CREATE INDEX IF NOT EXISTS idx_team_members_discord_not_joined
            ON team_members(team_id) WHERE discord_joined_at IS NULL
        `,
    ),
    Effect.tap(
      () => sql`ALTER TABLE bot_guilds ADD COLUMN IF NOT EXISTS members_backfilled_at TIMESTAMPTZ`,
    ),
  ),
);
