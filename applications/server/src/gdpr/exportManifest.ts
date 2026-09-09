/**
 * Every table that references a person, and what a data export does with it.
 *
 * A GDPR Art. 15 export has to be **complete** — one that quietly omits a
 * table is worse than none, because it presents itself as "your data". With
 * 51 foreign keys into `users` and `team_members`, completeness cannot rest on
 * anyone remembering to update a query when a table is added.
 *
 * So this manifest is the source of truth, and
 * `test/integration/gdpr/exportManifest.test.ts` asserts it matches the live
 * schema exactly: a new table referencing a person fails that test until
 * somebody records a decision here. Discipline is not the mechanism.
 *
 * `redact` is load-bearing and not cosmetic: an export is a file a person
 * downloads, mails to themselves, and stores. Putting a live session token or
 * an OAuth refresh token in it turns a privacy feature into a credential leak.
 */

/** How the export treats a table. */
export type ExportDisposition =
  | { readonly kind: 'export'; readonly redact?: ReadonlyArray<string> }
  | { readonly kind: 'exclude'; readonly reason: string };

export interface ExportedTable {
  readonly table: string;
  /** The column(s) tying the row to the person. */
  readonly via: ReadonlyArray<string>;
  readonly subject: 'users' | 'team_members';
  readonly disposition: ExportDisposition;
}

const own = (
  table: string,
  subject: 'users' | 'team_members',
  via: ReadonlyArray<string>,
  redact?: ReadonlyArray<string>,
): ExportedTable => ({
  table,
  via,
  subject,
  disposition: redact ? { kind: 'export', redact } : { kind: 'export' },
});

const skip = (
  table: string,
  subject: 'users' | 'team_members',
  via: ReadonlyArray<string>,
  reason: string,
): ExportedTable => ({ table, via, subject, disposition: { kind: 'exclude', reason } });

/**
 * Ordered by subject then table, matching the foreign-key inventory the
 * integration test reads out of `information_schema`.
 */
export const EXPORT_MANIFEST: ReadonlyArray<ExportedTable> = [
  // -- account-level (users) -------------------------------------------------
  own('dashboard_layouts', 'users', ['user_id']),
  own('expense_history', 'users', ['performed_by_user_id']),
  own('expenses', 'users', ['created_by_user_id', 'updated_by_user_id']),
  own('ical_tokens', 'users', ['user_id'], ['token']),
  own('invite_acceptances', 'users', ['user_id']),
  own('notifications', 'users', ['user_id']),
  own('oauth_connections', 'users', ['user_id'], ['access_token', 'refresh_token']),
  own('payments', 'users', ['recorded_by_user_id', 'voided_by_user_id']),
  own('pending_guild_joins', 'users', ['user_id']),
  own('pending_teams', 'users', ['created_by']),
  own('rules_attempts', 'users', ['user_id']),
  own('sessions', 'users', ['user_id'], ['token']),
  own('team_invites', 'users', ['created_by']),
  own('team_members', 'users', ['user_id']),
  own('team_onboarding_tokens', 'users', ['created_by', 'consumed_by'], ['token_hash']),
  own('teams', 'users', ['created_by']),
  own('translation_overrides', 'users', ['updated_by']),

  // -- team-scoped (team_members) -------------------------------------------
  skip(
    'achievement_sync_events',
    'team_members',
    ['team_member_id'],
    'Outbox rows driving Discord delivery. The achievement itself is exported via earned_achievements; this is transport state, not data about the person.',
  ),
  own('activity_logs', 'team_members', ['team_member_id']),
  own('carpool_cars', 'team_members', ['owner_team_member_id']),
  own('carpool_seats', 'team_members', ['team_member_id', 'assigned_by']),
  own('carpools', 'team_members', ['created_by']),
  own('earned_achievements', 'team_members', ['team_member_id']),
  own('event_roster_requests', 'team_members', ['team_member_id', 'decided_by']),
  own('event_rsvps', 'team_members', ['team_member_id']),
  own('event_series', 'team_members', ['created_by']),
  own('events', 'team_members', ['created_by', 'claimed_by']),
  own('fee_assignments', 'team_members', ['team_member_id']),
  own('group_members', 'team_members', ['team_member_id']),
  own('member_role_grants', 'team_members', ['team_member_id']),
  own('member_roles', 'team_members', ['team_member_id']),
  own('payments', 'team_members', ['team_member_id']),
  skip(
    'personal_event_channels',
    'team_members',
    ['team_member_id'],
    'Discord channel bookkeeping (channel id and dirty flag). The events themselves are exported; this is delivery plumbing.',
  ),
  skip(
    'personal_event_messages',
    'team_members',
    ['team_member_id'],
    'Discord message ids for the personal channel. Delivery plumbing, same as personal_event_channels.',
  ),
  own('player_rating_history', 'team_members', ['team_member_id', 'submitted_by']),
  own('player_ratings', 'team_members', ['team_member_id']),
  own('poll_options', 'team_members', ['added_by']),
  own('poll_votes', 'team_members', ['team_member_id']),
  own('polls', 'team_members', ['created_by']),
  own('roster_members', 'team_members', ['team_member_id']),
  own('team_challenge_completions', 'team_members', ['member_id']),
  own('team_challenges', 'team_members', ['created_by']),
  own('training_game_participants', 'team_members', ['team_member_id']),
  own('training_games', 'team_members', ['submitted_by']),
];

/** Columns that must never leave the server, whatever the manifest says. */
export const NEVER_EXPORT_COLUMNS: ReadonlyArray<string> = EXPORT_MANIFEST.flatMap((entry) =>
  entry.disposition.kind === 'export' && entry.disposition.redact
    ? entry.disposition.redact.map((column) => `${entry.table}.${column}`)
    : [],
);
