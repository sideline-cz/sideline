import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Blocker (whole-series review of fix/discord-onboarding-webapp, commit 46806427): per-member
// provenance for Discord role grants. `discord_role_mappings.adopted` answers a MAPPING-level
// question ("did Sideline create this Discord role") and says nothing about whether a specific
// member holds the role because Sideline itself put them there, or because a captain granted it
// by hand (before or outside Sideline). `46806427` excluded `adopted` mappings from both diff
// functions' unassign candidates wholesale, which stops the diff from ever stripping a role from
// ANY member for an adopted mapping — including a member Sideline itself promoted into that role
// and later demoted, who now keeps Discord access forever because nothing else in the system ever
// emits `role_unassigned` for a group-detach or group-removal (see the two diff functions' doc
// comments for the full inventory of emitters).
//
// `member_role_grants` records the member-level fact instead: "Sideline's own `handleAssigned.ts`
// successfully added this Discord role to this member." Written by `Role/MarkEventProcessed`
// (`applications/server/src/rpc/role/index.ts`) only when the event it just marked processed was
// a `role_assigned` event — i.e. the bot's `addGuildMemberRole` call actually succeeded — and
// cleared the same way on a successfully-processed `role_unassigned` event for the same
// (team_member_id, role_id) pair, so the row's presence always reflects "as far as Sideline's
// event history can tell, this member currently holds this role because Sideline granted it."
//
// No backfill populates this table for role/member pairs that predate this migration — there is
// no reliable signal to reconstruct provenance retroactively, and guessing wrong in the "assume
// granted" direction reintroduces the exact stripping defect this table exists to prevent. A
// member with no row here for a given role is therefore treated as "don't strip" by both diff
// functions, the same as an adopted mapping was before this migration — this migration only
// narrows that blanket protection to the (team_member_id, role_id) pairs that actually need it.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    CREATE TABLE IF NOT EXISTS member_role_grants (
      team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
      role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (team_member_id, role_id)
    )
  `,
);
