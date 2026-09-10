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

/**
 * How **erasure** treats a table, under the anonymise-in-place model.
 *
 * The identity lives on `users` (see `SUBJECT_ERASURE`). Scrubbing it there
 * pseudonymises every row that merely points at it, which is why `keep` is the
 * common answer rather than a cop-out: an RSVP row carries no personal data
 * once the id behind it resolves to nobody.
 *
 * `scrub` is for rows that hold personal data of their *own* beyond the
 * foreign key — free text the person wrote. `delete` is for rows that exist
 * only to serve that person and that nobody else's records depend on.
 */
export type ErasureDisposition =
  | { readonly kind: 'delete'; readonly reason: string }
  | { readonly kind: 'scrub'; readonly columns: ReadonlyArray<string>; readonly reason: string }
  | { readonly kind: 'keep'; readonly reason: string };

export interface ExportedTable {
  readonly table: string;
  /** The column(s) tying the row to the person. */
  readonly via: ReadonlyArray<string>;
  readonly subject: 'users' | 'team_members';
  readonly disposition: ExportDisposition;
  readonly erasure: ErasureDisposition;
}

const own = (
  table: string,
  subject: 'users' | 'team_members',
  via: ReadonlyArray<string>,
  erasure: ErasureDisposition,
  redact?: ReadonlyArray<string>,
): ExportedTable => ({
  table,
  via,
  subject,
  disposition: redact ? { kind: 'export', redact } : { kind: 'export' },
  erasure,
});

const skip = (
  table: string,
  subject: 'users' | 'team_members',
  via: ReadonlyArray<string>,
  reason: string,
  erasure: ErasureDisposition,
): ExportedTable => ({ table, via, subject, disposition: { kind: 'exclude', reason }, erasure });

/** Rows that exist only to serve this person; nobody else's records need them. */
const drop = (reason: string): ErasureDisposition => ({ kind: 'delete', reason });
/** Pseudonymised by scrubbing `users`; the row itself holds nothing personal. */
const pseudonymised: ErasureDisposition = {
  kind: 'keep',
  reason:
    'Carries no personal data beyond the foreign key, which resolves to nobody once `users` is scrubbed.',
};
const financial: ErasureDisposition = {
  kind: 'keep',
  reason:
    'Financial record. Section 5 of the privacy policy commits to retaining these after account deletion so the history stays accurate.',
};
const authorship: ErasureDisposition = {
  kind: 'keep',
  reason:
    'Authorship of a record belonging to other people. Deleting it would destroy their data; the reference is pseudonymised by scrubbing `users`.',
};

/**
 * Ordered by subject then table, matching the foreign-key inventory the
 * integration test reads out of `information_schema`.
 */
export const EXPORT_MANIFEST: ReadonlyArray<ExportedTable> = [
  // -- account-level (users) -------------------------------------------------
  own(
    'dashboard_layouts',
    'users',
    ['user_id'],
    drop('A saved dashboard arrangement serves only this person.'),
  ),
  own('expense_history', 'users', ['performed_by_user_id'], financial),
  own('expenses', 'users', ['created_by_user_id', 'updated_by_user_id'], financial),
  own(
    'ical_tokens',
    'users',
    ['user_id'],
    drop('A live calendar credential must stop working when the account is erased.'),
    ['token'],
  ),
  own('invite_acceptances', 'users', ['user_id'], pseudonymised),
  own(
    'notifications',
    'users',
    ['user_id'],
    drop('Addressed to this person alone and of no use to anyone else.'),
  ),
  own(
    'oauth_connections',
    'users',
    ['user_id'],
    drop('Live Discord credentials. Erasure must revoke access, not pseudonymise it.'),
    ['access_token', 'refresh_token'],
  ),
  own('payments', 'users', ['recorded_by_user_id', 'voided_by_user_id'], financial),
  own(
    'pending_guild_joins',
    'users',
    ['user_id'],
    drop('Transient join state for this person; meaningless once the account is gone.'),
  ),
  own('pending_teams', 'users', ['created_by'], authorship),
  own(
    'rules_attempts',
    'users',
    ['user_id'],
    drop(
      'Quiz answers are tied to the account rather than a team, so nothing else references them.',
    ),
  ),
  own(
    'sessions',
    'users',
    ['user_id'],
    drop('Live login credentials. Erasure must end every session.'),
    ['token'],
  ),
  own('team_invites', 'users', ['created_by'], authorship),
  own('team_members', 'users', ['user_id'], pseudonymised),
  own('team_onboarding_tokens', 'users', ['created_by', 'consumed_by'], authorship, ['token_hash']),
  own('teams', 'users', ['created_by'], authorship),
  own('translation_overrides', 'users', ['updated_by'], authorship),

  // -- team-scoped (team_members) -------------------------------------------
  skip(
    'achievement_sync_events',
    'team_members',
    ['team_member_id'],
    'Outbox rows driving Discord delivery. The achievement itself is exported via earned_achievements; this is transport state, not data about the person.',
    drop('Transport state for a delivery that will never happen again.'),
  ),
  own('activity_logs', 'team_members', ['team_member_id'], {
    kind: 'scrub',
    columns: ['note'],
    reason:
      'The note is free text the person wrote about themselves. The log itself is team training history others rely on, so the row stays and the prose goes.',
  }),
  own('carpool_cars', 'team_members', ['owner_team_member_id'], {
    kind: 'scrub',
    columns: ['note'],
    reason:
      'Free text the person wrote. The car row is part of a shared carpool other members organised around.',
  }),
  own('carpool_seats', 'team_members', ['team_member_id', 'assigned_by'], pseudonymised),
  own('carpools', 'team_members', ['created_by'], authorship),
  own('earned_achievements', 'team_members', ['team_member_id'], pseudonymised),
  own('event_roster_requests', 'team_members', ['team_member_id', 'decided_by'], pseudonymised),
  own('event_rsvps', 'team_members', ['team_member_id'], {
    kind: 'scrub',
    columns: ['message'],
    reason:
      "The RSVP message is free text the person wrote. Attendance itself is part of other members' event history and stays.",
  }),
  own('event_series', 'team_members', ['created_by'], authorship),
  own('events', 'team_members', ['created_by', 'claimed_by'], authorship),
  own('fee_assignments', 'team_members', ['team_member_id'], financial),
  own('group_members', 'team_members', ['team_member_id'], pseudonymised),
  own('member_role_grants', 'team_members', ['team_member_id'], pseudonymised),
  own('member_roles', 'team_members', ['team_member_id'], pseudonymised),
  own('payments', 'team_members', ['team_member_id'], financial),
  skip(
    'personal_event_channels',
    'team_members',
    ['team_member_id'],
    'Discord channel bookkeeping (channel id and dirty flag). The events themselves are exported; this is delivery plumbing.',
    drop('A private channel for this person alone; nothing else references it.'),
  ),
  skip(
    'personal_event_messages',
    'team_members',
    ['team_member_id'],
    'Discord message ids for the personal channel. Delivery plumbing, same as personal_event_channels.',
    drop('Message ids for that same private channel.'),
  ),
  own('player_rating_history', 'team_members', ['team_member_id', 'submitted_by'], pseudonymised),
  own('player_ratings', 'team_members', ['team_member_id'], pseudonymised),
  own('poll_options', 'team_members', ['added_by'], authorship),
  own('poll_votes', 'team_members', ['team_member_id'], pseudonymised),
  own('polls', 'team_members', ['created_by'], authorship),
  own('roster_members', 'team_members', ['team_member_id'], pseudonymised),
  own('team_challenge_completions', 'team_members', ['member_id'], pseudonymised),
  own('team_challenges', 'team_members', ['created_by'], authorship),
  own('training_game_participants', 'team_members', ['team_member_id'], pseudonymised),
  own('training_games', 'team_members', ['submitted_by'], authorship),
];

/**
 * The subject tables themselves, which carry the identity every other row
 * borrows. They are not in `EXPORT_MANIFEST` because nothing has a foreign key
 * from `users` to `users` — but erasure has to name them, because scrubbing
 * here is what pseudonymises the other 49 relationships.
 *
 * `discord_id` and `username` are `NOT NULL`, so they are replaced with a
 * value derived from the row id rather than nulled. Everything not listed
 * stays: `created_at` and `locale` say nothing about who someone was, and
 * `id` must survive for the foreign keys to remain valid — which is the whole
 * premise of anonymising in place.
 */
export const SUBJECT_ERASURE: ReadonlyArray<{
  readonly table: 'users' | 'team_members';
  readonly nullColumns: ReadonlyArray<string>;
  readonly placeholderColumns: ReadonlyArray<string>;
  readonly reason: string;
}> = [
  {
    table: 'users',
    nullColumns: [
      'avatar',
      'name',
      'gender',
      'birth_date',
      'discord_nickname',
      'discord_display_name',
    ],
    placeholderColumns: ['discord_id', 'username'],
    reason:
      'Every identifying field on the account. Scrubbing here is what turns the id in all 49 referencing tables into a pseudonym.',
  },
  {
    table: 'team_members',
    nullColumns: ['last_role_sync_error'],
    placeholderColumns: [],
    reason:
      "Holds no identity of its own — it borrows the account's. Only the sync error is cleared, because Discord error text can quote a username.",
  },
];

/** Columns that must never leave the server, whatever the manifest says. */
export const NEVER_EXPORT_COLUMNS: ReadonlyArray<string> = EXPORT_MANIFEST.flatMap((entry) =>
  entry.disposition.kind === 'export' && entry.disposition.redact
    ? entry.disposition.redact.map((column) => `${entry.table}.${column}`)
    : [],
);
