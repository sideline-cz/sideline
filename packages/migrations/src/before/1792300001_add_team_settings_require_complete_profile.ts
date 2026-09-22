import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// The captain's opt-in for the profile-completeness gate (RSVP, training claim, carpool seat) and
// the join-time unverified role/channel. Defaults to `false` so nothing changes for any existing
// team on deploy — see `.work-plans/discord-full-onboarding.md` → "Rollout: two levers".
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    ALTER TABLE team_settings
      ADD COLUMN IF NOT EXISTS require_complete_profile BOOLEAN NOT NULL DEFAULT false
  `,
);
