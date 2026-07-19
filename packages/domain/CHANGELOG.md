# @sideline/domain

## 0.37.4

### Patch Changes

- [#501](https://github.com/maxa-ondrej/sideline/pull/501) [`9933852`](https://github.com/maxa-ondrej/sideline/commit/9933852e34ed10e43a0a90fded2dc59ed5cf8f60) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Carpool improvements:

  - **Stable car ordering** — cars are now numbered in creation order (oldest is car 1, newly added cars append as the next number). Previously the board sorted by a random UUID, so adding a car could renumber the existing one.
  - **Change seats** — a car's owner can update the seat count from the car thread. Reducing below the number of people already in the car is blocked.
  - **Kick passenger** — a car's owner can remove a specific passenger from their car (also removes them from the car thread).

## 0.37.3

### Patch Changes

- [#499](https://github.com/maxa-ondrej/sideline/pull/499) [`df6359f`](https://github.com/maxa-ondrej/sideline/commit/df6359fc427fbe0d9d421edcf0b4d153b7818455) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix the `/carpool` "add car" modal failing with an interaction error (and "Sideline didn't respond in time") on English-locale teams. The capacity input reused a 53-character placeholder string as its Discord input label, exceeding Discord's 45-character label limit and getting the whole modal rejected before it could open. The label now uses a dedicated short message key.

  Also render the carpool board embed in the Sideline team's configured language (`teams.onboarding_locale`) instead of the Discord guild locale: `CarpoolView` now carries the team `language`, the server populates it from the team row, and `buildCarpoolEmbed` reads it directly.

## 0.37.2

### Patch Changes

- [#494](https://github.com/maxa-ondrej/sideline/pull/494) [`0d576b0`](https://github.com/maxa-ondrej/sideline/commit/0d576b0069a968b71aab623126ea6caf2db56f0b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Brand the `team_member_id` fields in the PersonalEvents and Guild RPC groups as `TeamMember.TeamMemberId` instead of raw `Schema.String` (14 fields across request payloads and success responses). This lets the server RPC handlers drop their two `Schema.decodeSync(TeamMember.TeamMemberId)` helpers and 9 per-call-site decodes — the decoded payload is now branded end-to-end — and removes a latent brand-stripping `String(...)` coercion in `IdentifyEventsChannel`. The bot's personal-channel reconcile/reorder types are branded to match so the ids flow through without widening. The brand is refinement-free so the wire format is unchanged; this is a type-safety tightening with no runtime or protocol change.

## 0.37.1

### Patch Changes

- [#486](https://github.com/maxa-ondrej/sideline/pull/486) [`95e4fc9`](https://github.com/maxa-ondrej/sideline/commit/95e4fc9c85029a67520a943bd99cb191d7657405) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add an admin "Remove option" button to polls. Captains/admins can remove one or
  more options from an open poll via an ephemeral select menu; votes for removed
  options are deleted and the remaining options are renumbered so their letters stay
  contiguous. A poll always keeps at least two options.

## 0.37.0

### Minor Changes

- [#463](https://github.com/maxa-ondrej/sideline/pull/463) [`d9c0bf8`](https://github.com/maxa-ondrej/sideline/commit/d9c0bf89d61a51d4886fd071293316d138cfd9c0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a `/complete` Discord slash command that lets a team member complete their profile without leaving Discord: it captures name, date of birth, gender, and jersey number. Gender is a native command choice; name, date of birth, and jersey number are collected via a modal. Name, birth date, and gender persist on the user and mark the profile complete (`is_profile_complete = true`, the same as web onboarding); jersey number persists on the team membership. Adds a `Guild/CompleteMemberProfile` RPC with defensive server-side validation and transactional writes, and tightens the shared birth-date schema to strict `YYYY-MM-DD` (rejecting rolled-over dates like `2005-02-30`).

## 0.36.0

### Minor Changes

- [#459](https://github.com/maxa-ondrej/sideline/pull/459) [`53a8a87`](https://github.com/maxa-ondrej/sideline/commit/53a8a87c7eba97553f21cf554b7a43790ef840a6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - feat: deactivate members when they leave Discord, with membership cascade

  When a member leaves (or is kicked/banned from) the Discord guild, the bot now
  deactivates their team membership and tears down their memberships: it removes
  all their group and roster memberships, revokes their Discord roles / channel
  access (via the existing channel-sync outbox), and de-provisions their personal
  events channel. The `team_members` row and all history (RSVPs, attendance,
  created events) are kept, so the member/history is recoverable on rejoin —
  though prior group/roster memberships are not auto-restored (a captain re-adds
  them; Discord-role-backed groups return automatically).

  The cascade is centralized (`deactivateMemberAndCascade`) and shared by the new
  `Guild/RemoveMember` leave path and the existing admin "deactivate member"
  endpoint, runs in a single transaction with a per-team advisory lock, and skips
  deactivation of the last remaining team manager to avoid orphaning a team.

## 0.35.0

### Minor Changes

- [#458](https://github.com/maxa-ondrej/sideline/pull/458) [`b970c70`](https://github.com/maxa-ondrej/sideline/commit/b970c70d9fd4e21db28a8d53436c2cfb259a6e8c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - feat: re-post events when a team's events channel changes

  Changing a team's `discord_events_channel_id` now migrates existing upcoming
  events to the new channel instead of leaving them stranded in the old one.
  The settings update emits an `event_channel_moved` sync event; the bot
  atomically repoints the team's active, future events to the new channel
  (nulling their message id as the commit point), deletes the old announcements,
  re-posts every now-unposted upcoming event (driven off durable state so a
  crashed run recovers on retry), and reorders both channels — the old one's
  divider is cleaned up, the new one is capped/ordered by `reorderChannelMessages`.
  Also picks up upcoming events that were created while no events channel was
  configured (posting was skipped at creation) and posts them into the new
  channel.

## 0.34.0

### Minor Changes

- [#454](https://github.com/maxa-ondrej/sideline/pull/454) [`d5812ff`](https://github.com/maxa-ondrej/sideline/commit/d5812ff3a9b88433aec2f9d59a392969cca1a95a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a Discord `/sudo` command that lets team admins temporarily elevate to Discord Administrator.
  - `/sudo` is a toggle: an admin running it grants themselves a shared `Sideline Sudo` role (carrying the Discord Administrator permission) and posts an audit entry with a "Leave sudo" button to the team's system channel; running it again while elevated revokes the role.
  - Any admin can press "Leave sudo" to end another admin's session; the audit message is edited to a resolved state showing who was in sudo, who ended it, and — from start to end — how long the session lasted. Non-admins clicking it get an ephemeral denial and the shared message is left untouched.
  - Both exit paths (the "Leave sudo" button and re-running `/sudo`) now close the same audit message and record the duration. A new `sudo_sessions` table persists the active session (audit message location + start time) so either path can find and resolve the message; entries are cleaned up on team deletion.
  - Access is enforced server-side via a new `Guild/CheckTeamAdmin` RPC (resolves the caller's team membership and `team:manage` permission), not via Discord `default_member_permissions` — so the command stays visible to team admins regardless of their Discord-native permissions.
  - The interaction is deferred and the elevation work is forked so Discord's 3-second acknowledgement window is respected; role-assign/revoke permission errors (bot role hierarchy) are surfaced clearly on both exit paths, and a missing system channel still grants sudo with an ephemeral notice (re-run `/sudo` to step down).
  - No auto-expiry in this version: sudo persists until the invoker toggles it off or an admin presses "Leave sudo".

### Patch Changes

- [#452](https://github.com/maxa-ondrej/sideline/pull/452) [`61cc064`](https://github.com/maxa-ondrej/sideline/commit/61cc06420c759ef9312abfb0778a9460ebeb6467) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Improve the member detail webpage

  Redesign the team member detail page into a card-based, responsive layout with a new member summary header (avatar, name, @username, jersey, joined date, primary role). Surface the member's joined date through the roster API, add a confirmation dialog before removing a role, give the profile edit form unsaved-changes feedback (per-field indicators, a dirty footer, save disabled until valid changes exist) plus name-length and future-birth-date validation, and add friendlier empty states with owner-only CTAs for activities and achievements.

  Also add a view/edit toggle for the profile card, let captains/admins manage the member's group and roster memberships directly from the page, and add a "Danger zone" to deactivate or reactivate a member (restricted to admins with the `member:remove` permission) — deactivation now also revokes the member's Discord roster/group role and channel access, and reactivation restores it.

## 0.33.0

### Minor Changes

- [#449](https://github.com/maxa-ondrej/sideline/pull/449) [`f30f493`](https://github.com/maxa-ondrej/sideline/commit/f30f4938ebbc8096f8d175f47fd30c0a2032682f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Rework the Discord events overview into private per-member event channels plus a single global shared channel.
  - Each member gets a private Discord channel (inside a configurable category, visible only to them and the bot) showing all their upcoming events as persistent messages with RSVP buttons. Overflow categories are auto-created past Discord's 50-channel cap.
  - One global shared events channel (aggregate voting) is configurable in team settings; the per-event channel relation is removed (the event create/edit channel picker is gone).
  - Hybrid sync keeps both surfaces consistent: the clicker's message updates instantly, and a bot reconcile loop converges all other personal copies and the global aggregate via a timestamp-guarded dirty marker.
  - Personal channels are ordered the same way as the global channel (soonest upcoming event nearest the input box) via a per-channel reorder pass.
  - Personal event messages now show the "Going" attendee list and an "Attendees" button, matching the global channel.
  - Unanswered events mention the member in their personal message so Discord highlights it, without ever pinging them (the mention is applied via a message edit, which never notifies); the mention clears once they respond.
  - New optional team setting to restrict personal channels to a single group (and its descendant groups) — members outside the group rely on the global channel only, and channels for excluded members are de-provisioned.
  - New optional team setting for the generated personal channel name format (`{name}` / `{discord_id}` placeholders; defaults to `events-{discord_id}`). A static name (no placeholder) is allowed.
  - A freshly-provisioned personal channel is immediately populated with the member's existing upcoming events.
  - Changing the channel-name format renames all existing personal channels to match.
  - New `/event refresh` subcommand: anyone can run it inside their own personal events channel to re-render and reorder it; Sideline admins (`team:manage`) can additionally refresh the global events channel and any other member's personal channel.
  - Removes the old `/event overview` command, the overview-channel team setting, and the SetOverviewChannel RPC. The coaching-status announcement is retained.

## 0.32.0

### Minor Changes

- [#444](https://github.com/maxa-ondrej/sideline/pull/444) [`a20acad`](https://github.com/maxa-ondrej/sideline/commit/a20acad5dd92081758ce5ae070556f01735d413d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a "Who voted?" button to the `/poll` public board

  Members can now click **👥 Who voted?** on a poll (open or closed) to get an ephemeral message listing each option with the people who voted for it, rendered as `Name (@mention)` without pinging anyone. Backed by a new `Poll/GetPollVoters` RPC and a team-scoped `findPollVoters` query that returns the true per-option vote counts (the displayed voter list is capped at 60 per option, with the remainder shown as "…and N more"). Voter identities are visible to all team members.

## 0.31.0

### Minor Changes

- [#442](https://github.com/maxa-ondrej/sideline/pull/442) [`defddbd`](https://github.com/maxa-ondrej/sideline/commit/defddbd3ce5650450753aa21c3cc320525ecd815) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - feat: rework RSVP reminder notifications with missed-RSVP threshold

  RSVP reminders now only notify built-in "Player" role members whose consecutive
  missed-RSVP streak is below a per-team configurable threshold (`max_missed_rsvps`,
  default 4). A `missed_rsvps` counter on `team_members` increments when an event
  starts and an invited Player hadn't responded; it resets to 0 on any RSVP response
  (both via the web UI and Discord buttons). Captains can adjust the threshold in team
  settings.

### Patch Changes

- [#440](https://github.com/maxa-ondrej/sideline/pull/440) [`64488ad`](https://github.com/maxa-ondrej/sideline/commit/64488ad91e4d3859fe79b3ad4900564bda827298) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - fix: backfill members into existing Discord group roles on channel-created

  The group channel-created handler provisioned or reused a Discord role but never
  re-added existing members to it — the same gap that was fixed for rosters. When a
  group's Discord role already existed, the handler logged "skipped" and added no
  one, so members who joined before the role existed (or were dropped by a past sync
  failure) never regained access.

  The handler now resolves a single role id across all branches and then runs one
  shared, idempotent member-backfill step (retry-while-not-permanent, per-member
  failure isolation, concurrency 1), mirroring the roster handler. Backfill is
  descendant-aware: a group's role includes members of the group plus all descendant
  subgroups, matching how adding a member emits `member_added` for the group and
  every ancestor. Adds a team-scoped `Channel/GetGroupMembers` RPC backed by a
  recursive descendant query. No database migration.

- [#443](https://github.com/maxa-ondrej/sideline/pull/443) [`0bae4c3`](https://github.com/maxa-ondrej/sideline/commit/0bae4c302b4114adb20e476d5ed2472b7ddb374b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - fix: "Sync roster roles with Discord" button now also removes extras

  The existing team-wide "Sync roster roles with Discord" button (formerly
  labelled "Re-sync roster role members") now performs a bidirectional
  reconcile: it re-adds roster members who are missing their Discord role
  AND removes the roster Discord role from users who are no longer active
  members of any roster that shares that role.

  Implementation details:
  - A new `roster_role_reconcile` channel-sync event is emitted once per
    active roster role when the sync is triggered and is processed
    asynchronously by the bot.
  - The bot reads the live list of Discord role holders (paginated),
    computes the union of active roster members across all rosters sharing
    that role, diffs the two sets, and removes anyone in the holder set but
    not in the union set.
  - Removal is retried on transient Discord errors. The bot is fail-closed:
    if the guild member list cannot be read, no removals are performed so
    legitimate members are never accidentally stripped.
  - A new database migration extends the channel-sync event-type CHECK
    constraint to include `roster_role_reconcile`.
  - The `roster_backfillRoles` / `roster_backfillRolesHelp` i18n keys are
    updated in both English and Czech to reflect the two-way sync.

## 0.30.0

### Minor Changes

- [#438](https://github.com/maxa-ondrej/sideline/pull/438) [`72f3a3b`](https://github.com/maxa-ondrej/sideline/commit/72f3a3bad411aab4fcd4eeea78fafa9647116e77) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - feat: add a custom `/poll` command

  Captains can create polls in a team channel with `/poll`, choosing a question and
  2–10 options (semicolon-separated). Members vote by clicking option buttons; results
  render live in the embed with per-option bars, counts, and percentages. Two optional
  features: restrict who may add new options to a selected Discord role, and set a
  deadline after which voting closes.

  Polls support single-choice (click to vote, click again to retract, click another to
  move) and multiple-choice (`multiple:true`, toggle each option independently). Voting
  is serialized per poll with a `FOR UPDATE` lock for deterministic toggle behavior.
  Authorization is enforced server-side: a new `poll:manage` permission (granted to
  Admin and Captain) gates creating and closing polls, and the add-option role gate is
  checked against the member's raw Discord roles on the server (members with
  `poll:manage` or the poll's creator may always add). Deadlines are parsed in the
  team's timezone and the poll closes lazily on the next interaction after the deadline,
  rebuilding the message to its closed, read-only state. Fully localized (EN/CS).

### Patch Changes

- [#435](https://github.com/maxa-ondrej/sideline/pull/435) [`2f92bbc`](https://github.com/maxa-ondrej/sideline/commit/2f92bbc547a1d70c14c1b7641565d7b2c69ee883) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - fix: add admin tool to backfill members into existing Discord roster roles

  Adds an on-demand, team-scoped admin tool to re-sync members into existing
  Discord roster roles — for roster members who should hold a role but don't due
  to past sync failures. A new team-level "Re-sync roster role members" button on
  the rosters list page (gated by `roster:manage`) calls a new
  `POST /teams/:teamId/rosters/backfill-role-members` endpoint, which sweeps active
  rosters that already have a Discord role and re-emits the idempotent
  `roster_channel_created` event to re-add members. A dedup guard excludes rosters
  that already have an unprocessed channel sync event, so repeated clicks don't
  enqueue duplicates. The sweep is members-only (it does not create missing roles),
  batched (limit 50) and returns a `remainingCount` so an admin can click again to
  continue. No bot poll loop and no database migration.

- [#432](https://github.com/maxa-ondrej/sideline/pull/432) [`e61cfd9`](https://github.com/maxa-ondrej/sideline/commit/e61cfd996344ee3f05ce70017b7f491ad5ac7a9a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - fix: add a per-team Discord category for new roster channels

  Teams can now choose a Discord category under which new roster channels are
  created, configured on the Team Settings page (mirrors the existing archive
  category). When a deactivated roster is reactivated, its channel is re-created
  in that category. The bot applies the category as `parent_id` on channel
  creation; if the category is stale or deleted (permanent Discord error) it
  falls back to creating the channel at the guild root, while transient errors
  retry with the category intact. Persisted via a new `discord_roster_category_id`
  column on `team_settings` and carried to the bot through a dedicated
  `target_category_id` on the roster channel-created event.

- [#434](https://github.com/maxa-ondrej/sideline/pull/434) [`3a85212`](https://github.com/maxa-ondrej/sideline/commit/3a852129456d030bf7fe68f3b7fc633af234fce1) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix roster reactivation not re-adding members to the Discord role

  When a roster was reactivated, the bot re-created the Discord role but never re-added the roster's members, so the role came back empty. The bot's roster channel-created handler now backfills all current roster members onto the role, and is idempotent — if a role mapping already exists it reuses that role instead of creating a duplicate. Members are added with per-member failure isolation (a single failed add no longer aborts the sync) and no retries on permanent errors.

  Adds a manual "Sync with Discord" action on rosters (matching the existing group action) so captains can re-apply members on demand. This first phase re-adds members (add/heal); pruning stale role-holders is a planned follow-up.

- [#436](https://github.com/maxa-ondrej/sideline/pull/436) [`1eb4e9a`](https://github.com/maxa-ondrej/sideline/commit/1eb4e9a3199f38c2613373b40b38c13d4b2bd637) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a `/summarize` Discord command that summarizes the current channel or thread

  Members can now run `/summarize` in any channel or thread to get an LLM-generated
  summary of the recent conversation. Two optional parameters refine the scope:
  `messages` (1–200, default 50) caps how many recent messages are summarized, and
  `since` accepts either a relative duration (`24h`, `7d`, `3d12h`) or an ISO date
  (`2026-06-20`) to summarize only messages from that point onward. When neither is
  given, the last 50 messages are used.

  The bot fetches and paginates the channel history (newest-first, up to 200),
  filters out bot and empty messages, and sends a fenced, author-labeled transcript
  to the server. The server reuses the existing OpenAI-compatible `LlmClient` via a
  new `Summarize/SummarizeChannel` RPC, treating the transcript as untrusted content
  (prompt-injection guard) and falling back to a deterministic summary when no LLM is
  configured or the call fails. The response is an ephemeral embed with a footer that
  honestly reports how many messages were summarized and flags when the window was
  capped or truncated; `allowed_mentions` is cleared so an echoed `@mention` never
  pings. Available in English and Czech.

## 0.29.0

### Minor Changes

- [#423](https://github.com/maxa-ondrej/sideline/pull/423) [`bf0716c`](https://github.com/maxa-ondrej/sideline/commit/bf0716cd86155c06bf0ca16b8207ba5e30f86e4e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add an admin-only "All groups" toggle to the team events list. By default members see only events for the groups they belong to; admins (members with `team:manage`) can now flip a toggle to see every team event regardless of group. The toggle is driven by a URL search param so it refetches from the server, and the server re-checks the `team:manage` permission — a non-admin cannot bypass group filtering by sending the flag. It composes with the existing client-side "Show past & cancelled" filter, and the calendar view inherits the broadened scope.

- [#418](https://github.com/maxa-ondrej/sideline/pull/418) [`51f1048`](https://github.com/maxa-ondrej/sideline/commit/51f1048a4182556c315ee4b278253b8f597a2d32) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add two AI-assisted features to the captain-only player ELO rating card, reusing the existing LlmClient.
  - **Rating insight**: an on-demand, plain-language summary of a player's recent form (trend from recent rating deltas, win/loss/draw record, calibration status), shown on the rating card with an AI-vs-fallback indicator. Backed by `GET /teams/:teamId/members/:memberId/rating/insight`.
  - **ELO from description (suggest-and-confirm)**: for an unrated player, a captain describes the player's ability in free text and AI suggests a starting rating + rationale; the captain can edit the number before confirming. The applied rating seeds `player_ratings` while keeping `games_played = 0`, so the first calibration games (K=40) quickly correct the estimate. Backed by `POST .../rating/estimate` (no persist) and `POST .../rating/seed`.

  Ratings stay 800–1800 (enforced in the domain schema, the server, and the UI). Both AI calls degrade to deterministic fallbacks when the LLM is unavailable and never fail the request. All endpoints require `member:edit` (captain/admin) and verify the member belongs to the team. No database migration.

- [#413](https://github.com/maxa-ondrej/sideline/pull/413) [`dd91e63`](https://github.com/maxa-ondrej/sideline/commit/dd91e634678c34742ca8224fb7c9c9ced1c098f0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a team-average Elo rating system. Captains and admins (any member with `member:edit`) can record game results via `POST /teams/:teamId/ratings/games`; the server applies K=40 during calibration (first 10 games) and K=20 thereafter. Current standings are readable by all team members via `GET /teams/:teamId/ratings`; individual rating details and full game history are available per-member. Two new database tables (`player_ratings`, `player_rating_history`) back the feature. A `MemberRatingCard` component surfaces ratings on the player profile page.

- [#416](https://github.com/maxa-ondrej/sideline/pull/416) [`39f23d6`](https://github.com/maxa-ondrej/sideline/commit/39f23d6fde5b1d997e22ea8c802def2e41d72141) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a balanced training team generator. Captains and admins (any member with `member:edit`) can generate two balanced teams for a training event based on player Elo ratings, with optional gender-mix weighting, then review, manually swap players, and post the result to Discord.

  The core is a pure, deterministic engine (`TeamGenerator`) that seeds teams via snake-draft and refines them with hill-climbing local search over a normalized weighted cost function (Elo spread, team size, gender distribution), surfacing warnings for uneven team sizes, Elo outliers, and insufficient gender mix. Per-team balancing weights are configurable per team (`team_generation_config` table). The web `TeamGeneratorSection` provides generation, live balance feedback, and accessible select-two-to-swap manual adjustment; the `/training generate` Discord command deep-links to it. Posting to Discord goes through the event-sync outbox (`teams_generated` event) and re-derives all embed content server-side from the trusted roster. MVP ships two teams with an N-ready API and engine.

- [#415](https://github.com/maxa-ondrej/sideline/pull/415) [`30166b5`](https://github.com/maxa-ondrej/sideline/commit/30166b5b0245a31414028d2a8be06a2afdc8ddb7) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add training game result logging. Coaches (any member with `member:edit`) open a training event and split the RSVP-yes attendees into Team A / Team B, then record the winner (Team A / Team B / Draw); multiple games (rounds) can be logged per session. Saving a result applies an incremental Elo update via the existing rating engine — the new game's id is recorded on each `player_rating_history` row — and best-effort auto-logs training attendance for all RSVP-yes members (deduplicated per UTC day). Two new tables (`training_games`, `training_game_participants`) back the feature. The `/training result` Discord command is a convenience deep-link: it replies with an ephemeral link to the web result editor, listing loggable trainings (including just-finished ones) via the new `Event/GetLoggableTrainingEvents` RPC. Logged games are immutable for now.

## 0.28.0

### Minor Changes

- [#410](https://github.com/maxa-ondrej/sideline/pull/410) [`57b267f`](https://github.com/maxa-ondrej/sideline/commit/57b267f2ba806dc0e3cf0ac8c91d0e4145631b12) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a global-admin management area so existing global admins can view, grant, and revoke global-admin status from the web admin section. Grants are recorded with a new `global_admin_granted_at` timestamp. Safeguards prevent self-revocation and removing the last effective admin (counting both database admins and the `APP_GLOBAL_ADMIN_DISCORD_IDS` env allowlist); env-allowlisted admins are surfaced as non-revocable. The last-admin check uses a TOCTOU-safe guarded update.

## 0.27.1

### Patch Changes

- [#402](https://github.com/maxa-ondrej/sideline/pull/402) [`1681e50`](https://github.com/maxa-ondrej/sideline/commit/1681e5075b9f824075fcda935bd3dcf5b5a65410) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix carpool car creation: any team member can now add their own car (volunteer as
  a driver), not just captains. Starting a carpool remains captain/admin-only
  (`carpool:manage`). Previously the `Carpool/AddCar` action was incorrectly gated
  behind `carpool:manage`, so the "Add Car" button shown to everyone always failed
  for regular members. Membership is still required — non-members are rejected.

- [#404](https://github.com/maxa-ondrej/sideline/pull/404) [`717bf0c`](https://github.com/maxa-ondrej/sideline/commit/717bf0c90f40c933951532327df4a5211311d0b2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix channel access for groups that were never provisioned with a Discord role.

  Granting channel access to such a group silently saved the grant but never
  applied a Discord permission overwrite and gave no feedback — so the group
  appeared to "do nothing" (confirmed in production for role-only groups created
  before their team's Discord provisioning, which had no `discord_channel_mappings`
  row and thus no resolvable role).

  The server now backfills missing group roles (a low-cadence bot tick calls a new
  `Channel/BackfillMissingGroupRoles` RPC; role-only groups get a role, groups that
  already have a channel get the role attached to it — no duplicate channels), and
  re-applies a group's stored channel-access grants automatically the moment its
  Discord role first appears (group-axis reconcile on the role none→present
  transition, generalising the existing channel-axis reconcile). `setAccess` also
  best-effort enqueues provisioning when it encounters a role-less group, and the
  bot's role provisioning is now idempotent (no duplicate roles on retry).

  Channel detail responses also expose a per-grant `roleResolvable` flag, and the
  channel access sheet shows a "Not yet active in Discord" badge, info notice, and
  clearer toast so the saved-but-pending state is visible until it self-heals.

## 0.27.0

### Minor Changes

- [#399](https://github.com/maxa-ondrej/sideline/pull/399) [`58b7a5a`](https://github.com/maxa-ondrej/sideline/commit/58b7a5aa2954faa5925bdcf0f3e9334b5d102d2e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Link a tournament event to a real roster with a per-pair auto-approve toggle. An
  RSVP "yes" drives roster membership: with auto-approve on, the member is added
  automatically; with it off, an Approve/Decline request is posted to a dedicated
  per-event thread in the owner group's channel and is also actionable on the web
  roster detail page. Withdrawing a "yes" removes flow-added members (manual members
  are protected) and cancels pending requests; enabling auto-approve backfills current
  "yes" responders. Configure and approve from either Discord or the web.

## 0.26.3

### Patch Changes

- [#396](https://github.com/maxa-ondrej/sideline/pull/396) [`4f69c4c`](https://github.com/maxa-ondrej/sideline/commit/4f69c4ce586911ad828844928ec4a393e5f39678) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add per-team IMAP email ingestion alongside the existing inbound webhook. Teams can now
  configure an IMAP mailbox in Team Settings; a UID-tracked cron poller fetches new mail every
  few minutes, parses it, and feeds the same summarize → coach-approval → Discord pipeline the
  webhook uses. Mailbox credentials are stored encrypted at rest (AES-256-GCM with an app-held
  key), never returned by the API, and entered via a write-only password field. Message-ID
  deduplication prevents double-processing when both ingestion methods run at once, and the
  watermark only advances past mail that was successfully ingested so transient failures retry
  rather than lose messages.

## 0.26.2

### Patch Changes

- [#392](https://github.com/maxa-ondrej/sideline/pull/392) [`aeffab9`](https://github.com/maxa-ondrej/sideline/commit/aeffab928c7ccfdd80101d024e13c5fea5885b2c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - fix(event): mention the assigned coach on training start and consolidate claim embeds into one owners thread

  When a training starts, the "Starting now" post now mentions the assigned coach
  instead of pinging the whole member group. If no coach has claimed the training
  (or the coach has no linked Discord account), the post instead pings the owners
  group with a "no coach claimed this training" warning. Non-training events are
  unchanged and still ping the member group.

  Coach claim embeds are no longer posted as a separate thread per training. Each
  owners group now has a single persistent claim thread (a new
  `discord_channel_mappings.claim_thread_id` column, created lazily and race-safe
  via an atomic save) into which all claim embeds are posted. When a training
  starts, its claim message is removed from that thread to keep it tidy. Three new
  RPCs (`Event/GetOwnerClaimThread`, `Event/SaveOwnerClaimThread`,
  `Event/ClearOwnerClaimThread`) back the persistent thread, and `EventStartedEvent`
  now carries the coach's Discord id.

## 0.26.1

### Patch Changes

- [#389](https://github.com/maxa-ondrej/sideline/pull/389) [`a924f26`](https://github.com/maxa-ondrej/sideline/commit/a924f269c0917b65bcca6c7d4ec8c57bdba6b893) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - fix(carpool): add a persistent Leave button and unbold thread titles

  Passengers could only leave a car from the ephemeral reserve-confirmation message,
  which disappears once dismissed. There is now a persistent "Leave car" button in each
  car's private thread (next to the owner's Assign/Remove controls) and a single shared
  "Leave my car" button on the main board. The board button is backed by a new
  `Carpool/LeaveCarpool` RPC that resolves the member's seat by carpool (a member is in at
  most one car per carpool) and removes them from the right thread.

  Carpool thread titles also no longer render literal `**asterisks**` — the thread name now
  uses the plain display name, while the welcome embed body keeps bold formatting.

## 0.26.0

### Minor Changes

- [#383](https://github.com/maxa-ondrej/sideline/pull/383) [`741f36a`](https://github.com/maxa-ondrej/sideline/commit/741f36adbbbc7f77b43e4a9ab400003418e13d7f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - feat(email): two-tier summaries (short + detailed) with ephemeral paginated Discord previews and dual-summary web editing

  Every forwarded email now gets a SHORT summary (a plain opening sentence plus ~6 emoji-led bullets) and a DETAILED summary (the existing balanced one), generated in a single OpenAI JSON-mode call. The coach approval message shows both summaries inline; the posted team message shows the short summary with buttons that open ephemeral, paginated previews of the detailed summary and the original email (no Sideline redirect). The Sideline web email page edits both summaries. Adds a nullable `short_summary` column (legacy rows fall back to the detailed summary, then the body) and a team-ownership + posted-status-guarded `Email/GetEmailContent` RPC for the member-facing previews.

## 0.25.0

### Minor Changes

- [#376](https://github.com/maxa-ondrej/sideline/pull/376) [`4f2d818`](https://github.com/maxa-ondrej/sideline/commit/4f2d818a03acf47d15e1a74eabf06136c84f1c94) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add email forwarding with AI summarization and coach approval. Teams can forward organizational emails to a unique inbound address (secured by a per-team token plus HMAC signature verification, body-size cap, and rate limiting). Each email is summarized via an `effect/unstable/ai` LLM client (config-gated, with a deterministic stub when no provider is configured), then an approval request with Approve/Reject buttons and a "Review & edit in Sideline" link is posted to a configurable coach channel. On approval the AI summary posts to the team's target channel; on rejection the original email posts instead. Both posts link back to a new web Email Detail page where coaches can review the original message, download attachments, edit the summary before approving, and members can view posted emails. Adds the `email_forwarding_config`, `email_messages`, `email_post_sync_events`, and `email_attachments` tables, the `EmailForwardingApi` endpoints, the `Email` RPC group, an email summarization cron, and the `EmailSyncService` bot worker. New env vars: `EMAIL_WEBHOOK_SIGNING_SECRET` (required) and optional `LLM_API_URL`/`LLM_API_KEY`/`LLM_MODEL`.

## 0.24.0

### Minor Changes

- [#367](https://github.com/maxa-ondrej/sideline/pull/367) [`7479b19`](https://github.com/maxa-ondrej/sideline/commit/7479b1992514f9eec87456e09ad93e4ebb2f754e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Improve the coach assigning feature:
  - **Configurable claim lead-time** — training claim-request messages now post a configurable number of days before the training (new per-team setting `claim_request_days_before`, default 3) instead of at event creation time, which could be up to the event horizon (~2 weeks) ahead. A new `TrainingClaimRequestCron` drives the scheduled posting; the on-creation emitter only fires immediately when the training already falls inside the lead-time window.
  - **Training-day coaching status** — a new `CoachingStatusCron` posts a "today's coach is X" announcement to the member-visible training channel on the training day, only when the training is already claimed (to avoid notification spam).
  - **Thread-based claim management** — the claim message now spawns a Discord thread (tracked via the new `events.claim_thread_id` column); the claim embed and buttons remain on the starter message.

  Includes an idempotent migration adding `team_settings.claim_request_days_before`, `events.claim_request_sent_at`, `events.coaching_status_sent_at`, and `events.claim_thread_id`, extending the `event_sync_events` type check with `coaching_status`, partial indexes for the new cron scans, and a backfill that marks existing trainings as already-handled so there is no first-deploy notification blast.

### Patch Changes

- [#371](https://github.com/maxa-ondrej/sideline/pull/371) [`8d5c386`](https://github.com/maxa-ondrej/sideline/commit/8d5c38680e82293b1bca226da837be0749115c66) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Expose the training claim-request lead time (`claim_request_days_before`) in the web Team Settings UI. Captains can now configure, in a new "Coach assignment" card, how many days before a training the coach claim request is posted (0–30, default 3) — previously only changeable directly in the database. Adds the field to the team-settings API contract (response + partial-update request, bounded 0–30), maps it through the server handler, and renders a number input that is independent of the RSVP reminder toggle.

## 0.23.0

### Minor Changes

- [#356](https://github.com/maxa-ondrej/sideline/pull/356) [`8e17378`](https://github.com/maxa-ondrej/sideline/commit/8e173785eb8ce2a74f6a9bd729e51e6de252102b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - feat(events): hide started/cancelled events by default and support all-day / multi-day events
  - The events list now hides `started` and `cancelled` events by default, with a "Show past & cancelled" toggle. The calendar view continues to show all events.
  - Events can be marked **all day** (no time), including multi-day spans such as tournaments. An "All day" toggle on the create/edit forms hides the time inputs. All-day events render as date(s) only across the web list, detail, and calendar views, in Discord embeds (date-style timestamps), and in the iCal feed (`VALUE=DATE`).

## 0.22.0

### Minor Changes

- [#346](https://github.com/maxa-ondrej/sideline/pull/346) [`e22ccc5`](https://github.com/maxa-ondrej/sideline/commit/e22ccc5c9f367efca2e26956b6abcb9f351f3878) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Restore archived channels and set a channel emoji

  Admins can now restore an archived channel (single, with bulk support on the
  server) — moving it back out of the configured archive category. Managed-channel
  archiving keeps the Discord link so a restored channel re-activates cleanly.

  When creating a channel, admins can specify an emoji; the channel's Discord name
  is composed from the team's configured channel name format (e.g. `{emoji}│{name}`),
  with a live preview in the create dialog.

- [#346](https://github.com/maxa-ondrej/sideline/pull/346) [`e22ccc5`](https://github.com/maxa-ondrej/sideline/commit/e22ccc5c9f367efca2e26956b6abcb9f351f3878) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add web-based Discord channel management for admins

  Admins (with `group:manage`) can now create, rename, and archive Discord text
  channels directly from Sideline, organize them with Sideline-side categories and
  ordering, and grant existing groups VIEW/EDIT/ADMIN access to each channel
  (mapped to Discord permission overwrites). The ADMIN tier is bounded — it grants
  message/thread moderation but never channel rename or delete. Introduces a new
  `managed` channel entity that reuses the existing channel-sync pipeline, backed
  by new `team_channels` and `team_channel_access` tables and a new channel HTTP
  API. v1 scope: text channels only; ordering/categories are Sideline-side.

  The channel list reflects the team's actual Discord channels (synced from the
  `discord_channels` mirror, merged with managed channels still provisioning),
  grouped by their Discord category. Channels in the team's configured archive
  category are shown as archived, and admins can archive any Discord channel — not
  just Sideline-created ones — moving it into the archive category.

  Admins can also **bulk-archive** channels (multi-select) and **manage permissions
  for any Discord channel**, not just Sideline-created ones: managing access on a
  previously-unmanaged channel "adopts" it — making it private and replacing its
  existing Discord permissions with the Sideline access model (after a clear
  confirmation). A partial unique index keeps adoption idempotent.

  Also hardens `Runtime.runMain` so unsatisfied layer dependencies fail `pnpm check`
  at the call site instead of crashing the app at startup (the previous `as never`
  cast hid them). This surfaced and fixed a pre-existing missing dependency in
  `EventStartCron` (`DiscordChannelMappingRepository`).

### Patch Changes

- Updated dependencies [[`e22ccc5`](https://github.com/maxa-ondrej/sideline/commit/e22ccc5c9f367efca2e26956b6abcb9f351f3878)]:
  - @sideline/effect-lib@0.0.8

## 0.21.1

### Patch Changes

- [#349](https://github.com/maxa-ondrej/sideline/pull/349) [`08fb679`](https://github.com/maxa-ondrej/sideline/commit/08fb679cde568d45a51fb274ddb789ac5588c6b4) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Remove the redundant `/api` segment from the Translations API endpoint paths. Translations was the only API group whose endpoint paths embedded `/api/...` (e.g. `/api/translations`), so combined with the server's global `.prefix(API_PREFIX)` (`/api`) it was mounted at `/api/api/translations` — a double prefix inconsistent with every other group (which use bare paths like `/teams` under the `/api` prefix). The endpoint paths are now `/translations`, `/translations/:key`, `/translations/import`, and `/translations/export.json`, so the group mounts at the expected `/api/translations`. The externally-observed URLs are unchanged for the list/upsert/import endpoints (they were already documented as `/api/translations`), and this fixes the CSV/JSON export route, which previously 404'd because the client/proxy hit `/api/translations/export.json` while the server served `/api/api/translations/export.json`.

## 0.21.0

### Minor Changes

- [#342](https://github.com/maxa-ondrej/sideline/pull/342) [`f4f0e3f`](https://github.com/maxa-ondrej/sideline/commit/f4f0e3f9a33a200c58e02c45949489cf8f7a226b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Discord carpool board feature (`/doprava` / `/carpool`). Captains post a live-updating board; members add cars (capacity 1–8 including driver), reserve seats via buttons, and manage passengers in a per-car private thread. Introduces three new database tables (`carpools`, `carpool_cars`, `carpool_seats`), eight new `Carpool/*` RPC methods, and a new `carpool:manage` permission granted to Admin and Captain roles by default.

- [#338](https://github.com/maxa-ondrej/sideline/pull/338) [`c50e57f`](https://github.com/maxa-ondrej/sideline/commit/c50e57f4e00c9b46fefbd3241917f4a1d214a435) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Team members can now customize their dashboard: show/hide and reorder the four non-urgent widgets (stats, upcoming events, activity, team management) per team. The layout is persisted server-side in a new `dashboard_layouts` table so it syncs across devices. The two urgency banners (awaiting RSVP, outstanding payments) stay pinned and are intentionally not user-hideable so members never silently miss alerts. New `GET`/`PUT /teams/:teamId/dashboard-layout` endpoints; the dashboard read endpoint is unchanged and the layout loads as a graceful-degradation arm so the dashboard never breaks if the config call fails.

### Patch Changes

- [#335](https://github.com/maxa-ondrej/sideline/pull/335) [`32f598b`](https://github.com/maxa-ondrej/sideline/commit/32f598b8c8c83471b38d5221ac2eaced1da634d5) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a dedicated `challenge:manage` permission for the Weekly Challenges feature, granted to both Admin and Captain roles by default. Previously the team-challenge HTTP API checked the admin-only `team:manage` permission, blocking captains from creating / editing / deleting challenges. The new migration backfills the permission for all existing teams' built-in Admin and Captain roles.

- [#343](https://github.com/maxa-ondrej/sideline/pull/343) [`4345dd3`](https://github.com/maxa-ondrej/sideline/commit/4345dd3fec03ac134c8ad22e4ef9d16ec63a7052) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Show a consistent, server-resolved display name for users across the website. The name-selection logic that previously lived only in the Discord bot is now a shared `DisplayName.pickDisplayName` helper in `@sideline/domain`, computed server-side and returned as a `displayName` field on the `CurrentUser`, `RosterPlayer`, `LeaderboardEntry`, RSVP (`RsvpEntry`/`NonResponderEntry`), and group-member API responses. The web app now renders that field everywhere it shows a person's name (nav menu, profile, leaderboard, rosters, team members, player detail, group members, RSVP panel, fee/challenge assignee pickers) instead of ad-hoc fallbacks — fixing the leaderboard, which previously showed the raw Discord username with no fallback to the user's real name.

  Precedence is profile name → Discord nickname → Discord display name → username. Empty/whitespace-only Discord name strings are now skipped (also fixes a latent bot bug). Also fixes the weekly-summary top-contributor name, which was previously a placeholder team-member id.

- [#337](https://github.com/maxa-ondrej/sideline/pull/337) [`a48c644`](https://github.com/maxa-ondrej/sideline/commit/a48c644e56bcae9a615bf7f3273fb77810141f5f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix removed users retaining access to old teams. `TeamMembersRepository.findMembershipByIds` now filters inactive memberships by default, closing access through every endpoint that gates on team membership. Notification endpoints (`listNotifications`, `markAsRead`, `markAllAsRead`) now require active membership. iCal fee feed and payment-reminder cron exclude inactive members. `auth.autoJoinTeams` treats deactivation as terminal — removed users must rejoin via fresh invite. Web shows a new `/no-team` page for 0-team users with an optional "you were removed" banner; team-detail routes redirect removed users instead of 404ing.

  Add global-admin bootstrap: the first registered user is automatically granted global admin (new `users.is_global_admin` column, set atomically on first insert). `isGlobalAdmin` now resolves from the DB flag OR the `APP_GLOBAL_ADMIN_DISCORD_IDS` env allowlist via a shared `toCurrentUser` helper. Global admins with no teams are routed to `/admin/onboarding-tokens` (where they can onboard the first team) instead of the `/no-team` page.

## 0.20.0

### Minor Changes

- [#326](https://github.com/maxa-ondrej/sideline/pull/326) [`7fe28e8`](https://github.com/maxa-ondrej/sideline/commit/7fe28e84facfe9b4bef5b70c8627710fea5eb690) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add an admin-mediated team onboarding flow. Global admins now mint single-use, time-limited onboarding links bound to a specific Discord user; captains complete team setup (identity, Discord server, channels) via a 2-step wizard that authenticates with their bound Discord account. Team provisioning runs in a SQL transaction so the token is only consumed if the team is fully provisioned. As part of this work, `TeamsRepository.insertQuery` now persists all 16 team columns (previously silently dropped 6).

- [#331](https://github.com/maxa-ondrej/sideline/pull/331) [`d7513dc`](https://github.com/maxa-ondrej/sideline/commit/d7513dc8615ea3b28d905493c050d461adc8a4c9) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add backend foundation for Weekly Challenges (Týdenní výzvy). Captains can create one challenge per week per team with a kind discriminator (`throwing` or `sport`), title, and optional description; team members can self-mark completion on the current ISO week only. Includes 3 new tables (`weekly_challenges`, `weekly_challenge_completions`, `weekly_challenge_sync_events`), domain schemas, RPC group with 5 typed error tags, repository with transactional FOR UPDATE mark/unmark, timezone-aware Monday-date helpers, and an outbox table populated at create time so the bot can announce the challenge on its start Monday at 09:00 team-local. The Discord bot drain and web UI will land in follow-up PRs.

- [#333](https://github.com/maxa-ondrej/sideline/pull/333) [`e953389`](https://github.com/maxa-ondrej/sideline/commit/e9533899780a0983329bbb8acdd159c4f1e71cc8) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add user-facing surface for Weekly Challenges (Part 3/3 of Týdenní výzvy). Captains can create, edit, and delete one challenge per week per team; members tick "splněno" on their own row for the current ISO week. The new page at `/teams/{teamId}/challenges` shows a 12-week history grid (chronological-left, sticky member-name column on desktop, vertical card list with the active week pinned on top on mobile) with optimistic toggle updates, stale-response handling via monotonic in-flight request IDs, and post-midnight refresh on window focus. The new HTTP API at `applications/server/src/api/weekly-challenge.ts` adds six endpoints — `GET/POST/PATCH/DELETE /teams/:teamId/weekly-challenges[/:challengeId]` plus mark/unmark — reusing the existing `requireMembership` + `requirePermission` primitives; cross-team isolation is enforced on every mutation, and Discord sync events are enqueued only on Create. `MondayPicker` correctly identifies Mondays in the team's timezone (not the captain's browser) via `Intl.DateTimeFormat`, and the grid uses the server-computed `view.isActive` flag as the source of truth for current-week styling. Adds 47 new `challenges_*` i18n keys (cs primary, en fallback, gender-neutral). Closes the Sportovní aktivity bug.

## 0.19.4

### Patch Changes

- [#323](https://github.com/maxa-ondrej/sideline/pull/323) [`f1fd0cd`](https://github.com/maxa-ondrej/sideline/commit/f1fd0cda5578907f85e49efdb240fd48adb9f070) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Achievement notifications are now posted to a configurable per-team Achievement channel. Existing teams continue posting to their welcome channel by default; set the channel to "None" on the team settings page to disable achievement notifications.

## 0.19.3

### Patch Changes

- [#318](https://github.com/maxa-ondrej/sideline/pull/318) [`eac2e36`](https://github.com/maxa-ondrej/sideline/commit/eac2e365aedadbe052174e202700392bef507a7b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Allow backdating and future-dating activity (makánicko) logs. Previously, activities could only be recorded for the current day; users now choose any date within ±2 years when logging or editing an activity, both on the web app and via the `/makanicko log` Discord command.
  - **Web**: the activity log create form and edit sheet show a date picker. The picker defaults to "today" (empty submission) for create; on edit it pre-fills with the existing log's date and only overrides the stored timestamp when the user explicitly changes it.
  - **Discord**: `/makanicko log` accepts an optional `date` (`YYYY-MM-DD`) parameter; omitting it keeps the original "log now" behaviour.
  - Picked dates anchor at 12:00 Europe/Prague (DST-safe), so they always land in the correct day-bucket for streaks, stats and the leaderboard. Same-day display ordering gets a stable `id` tiebreaker so two logs sharing a noon timestamp don't jitter on refresh.
  - Out-of-range or malformed dates surface a clear "Invalid date" toast (web) or ephemeral reply (bot) instead of failing silently.

## 0.19.2

### Patch Changes

- [#316](https://github.com/maxa-ondrej/sideline/pull/316) [`f2a41c3`](https://github.com/maxa-ondrej/sideline/commit/f2a41c3a0210dd1d300df24e2038272d97981faf) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add explicit `rsvp_reminders_enabled` toggle to team settings and fix `daysBefore = 0` to mean "remind on the day of the event" (was silently treated as "disabled" because the cron filtered on `rsvp_reminder_days_before > 0`). With this change:
  - Teams that had `rsvp_reminder_days_before = 0` expecting same-day reminders will now actually receive them at `rsvp_reminder_time` on the day of the event (and the late-RSVP and unclaimed-training reminders that depend on this same cron path will fire too).
  - A new `rsvp_reminders_enabled` boolean (default `true`) is the explicit way to disable RSVP reminders. Surface in `Team Settings` as the "Enable RSVP reminders" checkbox.

  Migrate-up only — defaults to `TRUE` for all existing teams.

## 0.19.1

### Patch Changes

- [`976c68c`](https://github.com/maxa-ondrej/sideline/commit/976c68c5e08e45906f65a237fe0e9b891642883f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix custom achievement role-source radio: "auto-create role" now actually creates the Discord role on save, and "no role" clears an existing mapping when editing. Previously the dialog only honored `existing` — `auto_create` was silently discarded and `none` left any prior role in place. `createCustom` now returns the new achievement id so the web client can enqueue the role provision event after a successful save.

## 0.19.0

### Minor Changes

- [#311](https://github.com/maxa-ondrej/sideline/pull/311) [`2f5291f`](https://github.com/maxa-ondrej/sideline/commit/2f5291f5a2b6643ee5bd6bed922b208c669c3f09) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team expense tracking. Admins and treasurers can log, edit, and delete team expenses across five categories (fields, equipment, travel, tournaments, other) via a new `/teams/:teamId/finances/expenses` page. The Finances overview gains a new default "Overview" tab with an income vs. expense balance dashboard — KPI strip for income, expenses, and net balance, plus a category breakdown — driven by a multi-currency `balance-summary` endpoint. Every write is captured in an `expense_history` audit table via a Postgres trigger. Reuses existing `finance:view` (read) and `finance:manage_fees` (write) permissions — no new permission literal.

- [#289](https://github.com/maxa-ondrej/sideline/pull/289) [`6abf99c`](https://github.com/maxa-ondrej/sideline/commit/6abf99c886c1e5b43fed364699e1f0ee947c4a9c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add fee management and payment tracking MVP. Admins can define fees, assign them to members, and record manual payments (cash or bank transfer); members see their outstanding fees via `/finance status` in Discord and captains get a team-wide overview in the web app. Introduces `finance:view`, `finance:manage_fees`, and `finance:record_payments` permissions (treasurer pattern).

- [#306](https://github.com/maxa-ondrej/sideline/pull/306) [`9e421b5`](https://github.com/maxa-ondrej/sideline/commit/9e421b5ea30984b60f37c132f3a4e2da90801e38) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add web UI for fee management and payment tracking. Captains and treasurers can now define, edit, and archive fees from a new `Fees` page, and the existing finance overview gains an `By assignment` tab listing every fee assignment with filters (status, fee, player, search), inline Record Payment / Mark Waived / Un-waive actions, and per-currency outstanding amounts. Adds query filters (`memberId`, `feeId`, `from`, `to`, `includeVoided`) to `listPayments` and a new `listMemberAssignments` HTTP endpoint scoped by team ownership.

- [#307](https://github.com/maxa-ondrej/sideline/pull/307) [`2f6bd5b`](https://github.com/maxa-ondrej/sideline/commit/2f6bd5b9c480a1fc4ff3a59e7fdd4ad521860bb2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add player-facing payment status view. Adds a new "My payments" page (`/teams/:teamId/my-payments`) with KPI cards (outstanding, overdue count, paid total, next due), filter chips, and per-fee tables with expandable payment history. Adds an outstanding-payments banner on the team dashboard that appears when the current player has pending or overdue fees. Introduces a new `myPaymentHistory` endpoint (`GET /teams/:teamId/finance/my-payments`) that lets any team member view their own payment history without the `finance:view` permission; the endpoint is membership-gated and hardcodes the caller's member id, so a player cannot read another member's payments.

### Patch Changes

- [#303](https://github.com/maxa-ondrej/sideline/pull/303) [`978746c`](https://github.com/maxa-ondrej/sideline/commit/978746ca35b12203a046be017483dbfa968dfaf8) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Captains can now create, update, and delete custom activity types (previously admin-only). The activity types management page is now reachable from the team sidebar (under Coach).

- [#308](https://github.com/maxa-ondrej/sideline/pull/308) [`62db467`](https://github.com/maxa-ondrej/sideline/commit/62db46789598c4ec0b02c0f31dded7a262bca718) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Send payment reminders via Discord DM and surface them in the personal iCal feed. A new server cron emits five reminder cadences per unpaid fee (T-3, T-0, T+3, T+10, T+21); the bot delivers each as a DM and only records "sent" after a successful Discord delivery so transient failures get retried. The personal iCal feed (`GET /ical/:token`) now includes all-day VEVENTs with a 1-day VALARM for unpaid/partial/overdue assignments within a 180-day window, fixing RFC 5545 DTSTAMP omission on existing event VEVENTs along the way.

- [#304](https://github.com/maxa-ondrej/sideline/pull/304) [`54662cf`](https://github.com/maxa-ondrej/sideline/commit/54662cf751cfb8fa740fc11ad99d41532498ad24) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Show app versions (web, server, bot) in the user dropdown menu and add a `/info` slash command to the Discord bot.

- [#305](https://github.com/maxa-ondrej/sideline/pull/305) [`e656e54`](https://github.com/maxa-ondrej/sideline/commit/e656e543f3bb51f9279941d9d7edee529988bfa6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Introduce a built-in `Treasurer` role that holds the money-moving finance permissions (`finance:manage_fees`, `finance:record_payments`) so teams can delegate finance authority without elevating to Admin. Captain's finance scope narrows to `finance:view` only. Admin keeps every permission. Migration `1784000000` creates Treasurer for every existing team and backfills missing finance/activity-type permissions on legacy Admin and Captain rows. The migration is additive — it never deletes existing `role_permissions` rows.

## 0.18.0

### Minor Changes

- [#268](https://github.com/maxa-ondrej/sideline/pull/268) [`1a361c7`](https://github.com/maxa-ondrej/sideline/commit/1a361c7124725e40f0d62e5c546b1dedfcc34535) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add achievement system: players earn badges for their activity, and selected achievements automatically grant Discord roles.
  - Code-defined catalog of 11 V1 achievements covering total activities (1/10/50/100), longest streak (3/7/30 days), cumulative duration (10h/50h), and per-activity-type counts (25 gym / 25 running).
  - `AchievementEvaluator` runs after every activity-log create and update; new badges are inserted idempotently and emit a sync event for the bot to process.
  - Bot polls `Achievement/GetUnprocessedEvents`, optionally grants a per-team Discord role (5 of 11 achievements), and posts a gold embed to the team's welcome channel.
  - Player profile shows an Achievements grid between Roles and Activity Stats; earned badges are highlighted, unearned ones are dimmed.
  - New tables: `earned_achievements`, `achievement_role_mappings`, `achievement_sync_events`.
  - Fix: `TeamsRepository.insert` now persists `welcome_channel_id` instead of silently dropping it.

- [#272](https://github.com/maxa-ondrej/sideline/pull/272) [`22d7c79`](https://github.com/maxa-ondrej/sideline/commit/22d7c7996efa5a3ce9a8c5a11c070ac7d4b156f6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Admins can define custom activity types per team. Each type has a name, emoji,
  and description, scoped to the team. Built-in types (Gym, Run, Stretch, Training)
  remain global and read-only; tenant isolation is enforced at the repository
  layer. The Discord `/makanicko log` command switches from a static choices list
  to autocomplete that pulls the team's effective list (globals + custom). Web
  exposes a new admin page at `/teams/:teamId/activity-types` with create/edit/
  delete (delete is blocked when logs reference the type — rename instead).

- [#266](https://github.com/maxa-ondrej/sideline/pull/266) [`39eadd1`](https://github.com/maxa-ondrej/sideline/commit/39eadd113c4404280d7ab66a389183ef26f5e2a6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Decouple Discord channels from roles for groups. A group's Discord role is now created independently of its channel:
  - The role is always created when a group is created (or lazily on first member-add for legacy groups).
  - The channel is only created when explicitly requested (settings flag or `Create channel` action).
  - Disconnecting a channel keeps the role; re-linking a channel reuses the existing role.
  - Deleting a group removes both role and channel.

  `channel_sync_events` consolidates provisioning into a single `channel_created` event whose payload carries `Option<channel_name>` to distinguish role-only vs. role + channel paths. `discord_channel_id` is now nullable on the mapping (CHECK constraint enforces at least one of channel/role is set), and a partial unique index prevents two groups from being linked to the same channel. The bot processor splits permanent (Discord 403/404, schema decode) from transient errors so structurally broken events don't poison-pill the queue.

- [#270](https://github.com/maxa-ondrej/sideline/pull/270) [`fd7956f`](https://github.com/maxa-ondrej/sideline/commit/fd7956fedd865b0618823cb68c5d9c6a90d7edc6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add admin achievement management: captains can override built-in thresholds, create custom achievements, map achievements to Discord roles (existing or auto-created), and preview qualification impact before saving.
  - New admin page at `/teams/:teamId/achievements` (gated by `team:manage`).
  - Per-team threshold overrides for the 11 built-in achievements via new `achievement_settings` table; `AchievementEvaluator` applies overrides at evaluation time without disturbing the closure-based catalog.
  - New `custom_achievements` table for admin-created achievements (CRUD-only — evaluation/role-granting for customs is a follow-up).
  - Auto-create Discord role flow uses a separate idempotent outbox table (`discord_role_provision_events`) with attempt-based retry; bot reuses same-named existing roles to avoid duplicates.
  - Preview endpoint reports qualifying count, sample of soon-to-be-disqualified players, and whether the bot has Manage Roles permission.
  - `AchievementSlug` stays a closed literal; player-facing `AchievementsGrid` is untouched.

- [#266](https://github.com/maxa-ondrej/sideline/pull/266) [`39eadd1`](https://github.com/maxa-ondrej/sideline/commit/39eadd113c4404280d7ab66a389183ef26f5e2a6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add manual "Sync Discord role" action on the group detail page. Reconciles the Discord role's membership with the group's current member list — useful when the bot was offline, after a manual member import, or when a member joins the Discord guild later. Adds missing role-holders and removes role from team members who left the group. Events are batched into a single multi-row INSERT and wrapped in a transaction for consistency.

- [#273](https://github.com/maxa-ondrej/sideline/pull/273) [`54256fa`](https://github.com/maxa-ondrej/sideline/commit/54256fa02de18a1e422b8a8e0f6db03a744f9699) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Translation CMS: admins can edit UI translations from inside Sideline; changes go live without a redeploy.
  - New `/admin/translations` page (gated by `APP_GLOBAL_ADMIN_DISCORD_IDS`) with inline edit, search, JSON import/export, and per-locale delete-override action. Bot-only keys are flagged with a "requires redeploy" badge.
  - New `translation_overrides` table stores only admin overrides; defaults remain in compiled Paraglide messages. Resolution order: override → compiled default → key. Empty-string override is a valid value; `null` deletes the override.
  - New `tr(key, params)` helper + `TranslationOverridesProvider` (React Query, 30s polling paused when tab hidden). All ~80+ web call sites of `m.foo()` were codemodded to `tr('foo')` so overrides apply across the app.
  - `TranslationCache` service uses Postgres `LISTEN/NOTIFY` on `translation_cache_invalidate` for cross-instance refresh; every mutation bumps `translation_cache_version`.
  - `@sideline/i18n` now exports `./registry` (typed `messagesByKey` + `messageKeys` + `TranslationKey` type) and ships raw `./raw/{en,cs}.json` for the admin UI.
  - New endpoints: `GET /api/translations`, `PATCH /api/translations/:key`, `POST /api/translations/import`, `GET /api/translations/export.json`. All require auth; admin-only operations check `isGlobalAdmin` derived from env.
  - Bot remains on compiled `m.*` (out of scope for v1); editing `bot_*` keys does not affect Discord until next redeploy.

- [#271](https://github.com/maxa-ondrej/sideline/pull/271) [`21fff86`](https://github.com/maxa-ondrej/sideline/commit/21fff86ae25742437e8c7ebae0f2b14e98402f88) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add weekly makáníčko summaries: teams receive an automated weekly recap every Sunday ~20:00 local team time, posted to a configured Discord channel, with a captain-only web page mirroring the data.
  - New `WeeklySummary` domain models (`WeekRange`, `PlayerWeeklySummary`, `TeamWeeklySummary`, `WeeklySummaryResponse`, `WeeklySummaryDigest`) plus `WeeklySummaryApi` HTTP group and `WeeklySummaryRpcGroup` (`Get/Mark` outbox RPCs).
  - New `team_settings.weekly_summary_channel_id` column and `weekly_summary_sync_events` outbox table with `UNIQUE (team_id, week_start)` so cron inserts are idempotent (`ON CONFLICT DO NOTHING`).
  - Server: `WeeklySummaryRepository` (week-scoped activity, achievement, and active-member queries), `WeeklySummarySyncEventsRepository` (outbox with `delivered_at` separate from `processed_at`, attempt-capped retry), `WeeklySummaryService` (`buildPlayerSummary`, `buildTeamSummary`), `WeeklySummaryHandler` (HTTP API gated on team membership; team section requires `roster:manage`), `WeeklySummaryCron` (per-minute, timezone-aware Sunday 20:00 firing with `Effect.exit` per team, `concurrency: 1`).
  - Bot: `buildWeeklySummaryEmbed` (team channel embed with empty-state, top contributors, week-over-week delta), `handleWeeklySummaryReady`, polling `ProcessorService`.
  - Web: `WeeklySummaryPage` with player + team sections (coach-only) and ISO week navigation (handles W53 long years), new `workout.weekly.tsx` route, link from `MakanickoPage`.
  - Tests: 47 new unit tests across domain + server + bot. Integration repo test scaffolded (`.skip`) pending Pg testcontainer wiring.

  MVP boundaries: channel-only delivery, single team embed; per-player DMs, "didn't log this week" callouts, and player rank deferred to v2.

## 0.17.2

### Patch Changes

- [`9d26a29`](https://github.com/maxa-ondrej/sideline/commit/9d26a29e899e57cc85b89aeed06415959ee0a631) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Tolerate missing `is_community_enabled` in the `Guild/RegisterGuild` RPC payload by defaulting the key to `false` during decode. Prevents the server from erroring with `Missing key at ["is_community_enabled"]` when a stale pre-0.12.0 bot replica is still calling `RegisterGuild` mid-deploy. Once the upgraded bot boots, `Guild/SyncCommunityFlags` (fired on `READY`) overwrites the default with the real value from Discord's `guild.features`.

## 0.17.1

### Patch Changes

- [#262](https://github.com/maxa-ondrej/sideline/pull/262) [`91c4c3d`](https://github.com/maxa-ondrej/sideline/commit/91c4c3d073be32833199cbc3c71c5eb6efa195cb) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Extend automatic group assignment with a gender criterion alongside age. Captains can now configure rules like "U12 boys → Mladší žáci" and "U12 girls → Mladší žáci dívky" by combining age thresholds with gender filters, evaluated with AND semantics.

  Highlights:
  1. **Single nullable `gender` enum** on `AgeThresholdRule`, reusing the existing `User.Gender` literal. The request schema uses `Schema.OptionFromOptionalKey` so legacy web bundles that don't send the field continue to validate.
  2. **Composite uniqueness** — the previous `UNIQUE (team_id, group_id)` is replaced by `UNIQUE NULLS NOT DISTINCT (team_id, group_id, min_age, max_age, gender)` so multiple rules can target the same group as long as their criteria differ. Same-criteria duplicates still surface as 409 `AgeThresholdAlreadyExists` on both POST and PATCH.
  3. **All-None rejection** — the API rejects rules where age and gender are all unset (400 `AgeThresholdEmptyCriteria`) on both POST and PATCH; the web form mirrors this with a disabled submit button. A DB CHECK enforces the invariant at the storage layer.
  4. **Option-aware match logic** — `AgeCheckService.detectChanges` now evaluates `ageOk` and `genderOk` separately and ANDs them. As a side effect it fixes a pre-existing bug where members with no birth date could silently match age-only rules through `NaN` comparisons; the SQL filter `WHERE birth_date IS NOT NULL` is dropped so gender-only rules can apply to members with no birth date.
  5. **Inclusive age bounds** (`>=` / `<=`) — `min=12` now includes 12-year-olds, matching the natural reading of "minimum age 12".
  6. **Captain UI** — Shadcn `Select` for gender between the group picker and min-age input, new "Pohlaví / Gender" column with a tooltip explaining match semantics, "members who match all conditions" subtitle, AND-semantics microcopy, `overflow-x-auto` on the table, and the group dropdown no longer hides "already used" groups.
  7. **Notification copy** — softened "based on age threshold" → "based on automatic group rules" across all three paths (member-facing add, admin bulk add, admin bulk remove).
  8. **Migration `1747400000_add_gender_to_age_thresholds`** — adds the column, gender CHECK, deletes pathological pre-existing rows that already had all criteria NULL (with `Effect.logWarning` listing affected team_ids), adds the non-empty CHECK, drops the old unique constraint and installs the new one.

  Adds the `AgeThresholdEmptyCriteria` error class to `@sideline/domain`, exposed on both `createAgeThreshold` and `updateAgeThreshold` endpoints alongside `AgeThresholdAlreadyExists` (409).

  The captain-facing page label is broadened from "Age thresholds" / "Věkové prahy" to "Automatic groups" / "Automatické skupiny". The route URL (`/teams/:teamId/age-thresholds`) and the i18n key names (`ageThreshold_*`) are unchanged.

## 0.17.0

### Minor Changes

- [#259](https://github.com/maxa-ondrej/sideline/pull/259) [`bdc0b0e`](https://github.com/maxa-ondrej/sideline/commit/bdc0b0ed9bcf4de3ca463bf2331a7da931ac5a79) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Sideline-managed Discord native onboarding: Welcome Screen, Server Guide, and a single mandatory "I've read the rules" prompt that grants an entry role.

  Captains configure the rules channel, entry role, and onboarding language in team settings; a new bot poll-loop merges the Sideline-owned prompt into the guild's existing onboarding (preserving any captain-authored prompts) and pushes the Welcome Screen + Server Guide. A `GuildMemberUpdate` handler grants the entry role when Discord flips `pending: false`.

  Adds:
  - `teams.rules_channel_id`, `teams.onboarding_rules_role_id`, `teams.onboarding_rules_prompt_id`, `teams.onboarding_locale` (en/cs), `teams.onboarding_synced_at`, `teams.onboarding_sync_status` (pending/syncing/done/failed), `teams.onboarding_sync_error` (JSON `{code, detail}`)
  - `bot_guilds.is_community_enabled`
  - New `discord_guild_roles` table mirroring `discord_channels`, populated from `GuildCreate`/`GuildRoleCreate/Update/Delete` and `READY` backfill
  - 10 new `Guild/*` RPCs: `PendingOnboardingSyncs`, `MarkOnboardingSyncDone`, `MarkOnboardingSyncFailed`, `MarkOnboardingSyncSkipped`, `RevertOnboardingSync`, `GetOnboardingRulesRoleId`, `SyncCommunityFlags`, `ListGuildRoles`, `SyncGuildRoles`, `UpsertGuildRole`, `DeleteGuildRole`
  - `POST /teams/:teamId/onboarding/retry` HTTP endpoint
  - New web "Onboarding" card on TeamSettingsPage with Discord-role picker, locale toggle, sync status, retry, and Community-feature warning state

  Sync uses a four-state machine (`pending → syncing → done | failed`) with atomic `FOR UPDATE SKIP LOCKED` claims and conditional `MarkSyncDone` to safely tolerate captain re-saves mid-sync. The bot caches the per-guild rules role with a 60s TTL, invalidated on every successful PUT and on failures so captain reconfigurations take effect immediately. Guilds without the Discord Community feature are marked `done` with a `community_disabled` error code (no infinite re-poll); enabling Community in Discord auto-flips the team back to `pending` for re-sync.

  Multi-bot coexistence: we preserve non-Sideline prompts but always set `enabled=true`, `mode=ONBOARDING_ADVANCED`, and rebuild `default_channel_ids`. A typed error classifier walks Discord's structured error tree (looking for `UNKNOWN_ROLE`/`INVALID_ROLE`/`UNKNOWN_CHANNEL`/`INVALID_CHANNEL` codes) so dead-role/dead-channel failures surface actionable copy in the captain UI rather than generic Discord error text.

- [#255](https://github.com/maxa-ondrej/sideline/pull/255) [`9af6d3c`](https://github.com/maxa-ondrej/sideline/commit/9af6d3c99b469f8d50f5fa18c868efc972085e18) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Discord member welcome flow: group-targeted invites, invite-aware welcome messages, and captain audit log.

  Captains can now create multiple invites per team, each optionally bound to a specific group. When a member joins, the bot identifies the invite they used (via `INVITE_CREATE`/`INVITE_DELETE` event tracking + REST diff fallback), the server adds them to the invite's target group automatically, and renders a per-team welcome message template into the configured welcome channel. A separate hidden system-log channel receives a structured audit entry for every join — including vanity-URL and unknown-source joins.

  Adds:
  - `team_invites.group_id` (nullable, `ON DELETE SET NULL`)
  - `teams.welcome_channel_id`, `teams.system_log_channel_id`, `teams.welcome_message_template`
  - `POST /teams/:teamId/invites` (`createInvite`) — multi-invite per team, optional group binding, expiry preset
  - `GET /teams/:teamId/invites` (`listInvitesForTeam`)
  - `POST /teams/:teamId/invites/:inviteId/deactivate` (`deactivateInvite`)
  - New shared package `@sideline/template-renderer` (pure, no Effect deps) — `applyTemplate`, `sanitizeRendered`, `sanitizeHexColor`
  - New web pages: team invites list + create-invite dialog with group picker, welcome-message card on team settings with live preview
  - Bot `InviteCache` service (per-guild Ref-based snapshot) + `InviteCreate`/`InviteDelete` event handlers + `GuildInvites` gateway intent

  `regenerateInvite` is kept as a deprecated alias delegating to `createInvite(None, +14d)` for one release; will be removed in a future minor. Native Discord Onboarding (Welcome Screen + rules-acknowledgement prompt) is deferred to a follow-up bug.

- [#260](https://github.com/maxa-ondrej/sideline/pull/260) [`40b33ef`](https://github.com/maxa-ondrej/sideline/commit/40b33ef26ec3a4d979e9022b1de0506965f037d0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Generate a fresh single-use Discord invite per invite acceptance instead of one shared, reusable invite per team_invite.

  Captains no longer see a "Copy Discord link" affordance — the only shareable link is `/invite/{code}` on the Sideline web. When a recipient clicks "Accept", the server records an `invite_acceptances` row, the bot creates a `max_uses: 1, max_age: 24h` Discord invite on the team's welcome channel within ~1s, and the web polls `GET /invite/acceptances/:acceptanceId` to redirect the user to a Discord URL that's bound to that one accept.

  Schema:
  - New `invite_acceptances(id, team_invite_id, user_id, discord_code, discord_code_error_code, discord_code_error_detail, created_at, generated_at)` with a unique partial index on `discord_code` and a pending-row index
  - `team_invites.discord_code` (and its indexes) dropped

  Server:
  - New `InviteAcceptancesRepository` with `create`, `findById`, `findPending`, `setDiscordCode`, `markFailed`, `findByDiscordCodeWithContext`
  - `joinViaInvite` returns `acceptanceId` instead of a Discord URL; new `getJoinStatus` endpoint exposes the URL once generated
  - `Guild/RegisterMember` welcome-meta lookup now resolves via `invite_acceptances.discord_code` so the welcome message still fires for the consumed code
  - Three replacement RPCs: `Invite/PendingAcceptances`, `Invite/SetAcceptanceDiscordCode`, `Invite/MarkAcceptanceFailed`

  Bot:
  - Invite-generator poll loop retargeted at acceptances; promoted to a 1s cadence so the user's wait after Accept stays short

  Web:
  - TeamInvitesPage: copy-Discord button and "generating…" placeholder removed
  - InvitePage: polls every 1.5s after accept; shows a "Preparing your Discord invite" state, an "Open Discord server" CTA when the URL arrives, or an error card if the bot reports a failure

### Patch Changes

- [#258](https://github.com/maxa-ondrej/sideline/pull/258) [`7422384`](https://github.com/maxa-ondrej/sideline/commit/7422384074804ae42f7ca4b6e4c4ca1d96801b3e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Recover gracefully when a user's Discord OAuth token is missing the `guilds.join` scope (e.g. anyone who logged in before PR #255). Previously these users silently failed the auto-join after accepting a web invite and there was no remediation path short of manual log-out / log-in.

  The fix is layered:
  1. **Detect at login** — the auth callback persists the granted scope list on `oauth_connections.granted_scopes` and, if `guilds.join` is missing, redirects the user back through Discord OAuth once (idempotent, gated on a `scopeRetry` flag in state).
  2. **Detect at join** — `joinViaInvite` checks the stored scopes. If the scope is missing it skips the `pending_guild_joins` enqueue and returns `requiresReauth: true`. The web invite page renders a "One more step — connect Discord access" CTA that re-enters the OAuth flow.
  3. **Retroactive requeue** — when the scope is newly granted on callback, prior `pending_guild_joins` rows that failed for this user are reset to `pending` so the bot picks them up on the next poll.

  Adds:
  - `oauth_connections.granted_scopes TEXT NOT NULL DEFAULT ''` (migration `1746800000`)
  - `Invite.JoinResult.requiresReauth: boolean`
  - `OAuthConnection` helpers: `parseScopes`, `hasScope`, `REQUIRED_DISCORD_SCOPE`
  - `OAuthConnectionsRepository.getGrantedScopes`; `PendingGuildJoinsRepository.requeueFailedForUser`

## 0.16.5

### Patch Changes

- [#246](https://github.com/maxa-ondrej/sideline/pull/246) [`3c63376`](https://github.com/maxa-ondrej/sideline/commit/3c633763b8d7d1db4c474c6786f44d2de68b1057) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - When an event starts, push the original embed up into the past section and apply the started color/banner consistently. Also recover from messages that have been deleted in Discord — `editMessage` and `handleStarted`'s in-place edit fall back to creating a new message and saving the new ID, and the bot runs a one-time scan on connect to recreate any messages that went missing while it was offline.

## 0.16.4

### Patch Changes

- [#244](https://github.com/maxa-ondrej/sideline/pull/244) [`b5ddcc9`](https://github.com/maxa-ondrej/sideline/commit/b5ddcc974359ff7e505e11e652fdcf0a57f0e88f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Render the claimer of a training in the Discord claim-message embed using the same `**Name** (<@discord-id>)` formatter that already powers the events RSVP attendees embed, so claimers now appear with their Discord mention instead of just a plain display name. Identity is resolved at read-time via a join in the sync-event outbox, with a fallback to the snapshotted display name for orphaned rows — no database migration required.

## 0.16.3

### Patch Changes

- [#242](https://github.com/maxa-ondrej/sideline/pull/242) [`4ee7b70`](https://github.com/maxa-ondrej/sideline/commit/4ee7b7029c76a3a17e19bc902a7284aea076f5b0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix a crash that prevented creating or updating events and event series unless every optional field was filled in. The cross-field validation that links the new "location link" feature to the location text was reading internal Option markers without first checking that the field was present, which threw `TypeError: Cannot read properties of undefined (reading '_tag')` whenever the location link or location text was empty. The check now correctly evaluates each field's state and only rejects payloads that set a location link without a location text.

## 0.16.2

### Patch Changes

- [#240](https://github.com/maxa-ondrej/sideline/pull/240) [`57cde28`](https://github.com/maxa-ondrej/sideline/commit/57cde28ef0095cc6b309ab3316967f859cd6b1f2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - You can now attach an optional link to an event's location (e.g. Google Maps, venue page). The location text becomes a clickable link on the website and a markdown hyperlink in Discord posts.

## 0.16.1

### Patch Changes

- [#238](https://github.com/maxa-ondrej/sideline/pull/238) [`2e53d6a`](https://github.com/maxa-ondrej/sideline/commit/2e53d6a4b2a40f222efee89e9a204a66bf33fc4c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - You can now attach a cover image URL to events. Images appear on the event page and as a thumbnail in Discord posts.

## 0.16.0

### Minor Changes

- [#236](https://github.com/maxa-ondrej/sideline/pull/236) [`cb91dc7`](https://github.com/maxa-ondrej/sideline/commit/cb91dc72b9f471511d96ac5604e086a60f4193f5) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - feat: add coach claim training feature

  Coaches can now volunteer to organize trainings via a dedicated Discord message posted to the owners group's channel. The message contains a Claim button that toggles to Release once claimed, and the regular reminder cron also posts a "still no coach" reminder when a training stays unclaimed at reminder time.

## 0.15.6

### Patch Changes

- [#232](https://github.com/maxa-ondrej/sideline/pull/232) [`ee68d21`](https://github.com/maxa-ondrej/sideline/commit/ee68d215ab1a26accc771119c3249b99aa6c9c71) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Improve the reminders feature: configurable reminder time and timezone (per-team), dedicated reminders channel, member-group-aware audience and role mentions, and a new "Starting now" announcement when an event begins.

  Team settings now expose `rsvpReminderDaysBefore`, `rsvpReminderTime` (HH:MM, capped at 23:54 to avoid midnight wrap), `timezone` (any IANA zone, default `Europe/Prague`), and `remindersChannelId`. Reminders fire at the configured time in the team's timezone with a 5-minute tolerance window. The reminder embed and the new "Starting now" post target the reminders channel (falling back to the owner-group channel, then the guild's system channel) and mention the event's member-group role. The reminder's "Going" and "Not yet responded" lists are filtered to the member group when one is set.

## 0.15.5

### Patch Changes

- [#221](https://github.com/maxa-ondrej/sideline/pull/221) [`efca9d7`](https://github.com/maxa-ondrej/sideline/commit/efca9d7556dac7e05fc19d2255b76788c1ed8700) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add discord display name to the name fallback chain in formatName

- [#222](https://github.com/maxa-ondrej/sideline/pull/222) [`f235bf5`](https://github.com/maxa-ondrej/sideline/commit/f235bf5c181ec88cdcd923aca1d71edba46d6a3b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Show Discord mentions alongside names in RSVP reminder messages and the late-RSVP channel
  - RSVP reminder embeds now render attendees as `**Name** (<@id>)` instead of `**Name**` alone, matching the format used in the attendees list.
  - Late-RSVP notifications (posted to the channel configured via `discord_channel_late_rsvp` after the reminder is sent) also now include the user's name alongside the mention, sourced from the new name fields on `SubmitRsvpResult`.
  - Reminder attendee lists now truncate with a localised "…and N more" suffix when the joined text would exceed Discord's 1024-character embed-field limit, preventing `createMessage` from failing for large teams.
  - Closes a related edge case in the attendees list where a user with only `display_name` (no name/nickname/username) would render as mention-only.

## 0.15.4

### Patch Changes

- [#206](https://github.com/maxa-ondrej/sideline/pull/206) [`d99385d`](https://github.com/maxa-ondrej/sideline/commit/d99385d26b7a112f8c632cb020b37de48f4cc9ad) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Store Discord server nickname and use name display priority: DB name → server nickname → username

## 0.15.3

### Patch Changes

- [#199](https://github.com/maxa-ondrej/sideline/pull/199) [`b64c794`](https://github.com/maxa-ondrej/sideline/commit/b64c794005a3249889ea374f4ef13e9419fea6a9) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix unreliable Discord mentions on mobile by showing bold names as primary display instead of @mentions in event embeds, attendees lists, and RSVP reminders. Add /event pending subcommand to list events awaiting the user's RSVP.

- [#203](https://github.com/maxa-ondrej/sideline/pull/203) [`d2d3eb6`](https://github.com/maxa-ondrej/sideline/commit/d2d3eb666c115009d1d24d1d4c80071633ba2e38) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Redesign /event upcoming to show one full event embed per page with per-user RSVP status. Add /event overview command for persistent channel button. Remove /event pending.

- [#195](https://github.com/maxa-ondrej/sideline/pull/195) [`0704c17`](https://github.com/maxa-ondrej/sideline/commit/0704c17897ced04f67ee10a7ed65cd0ec51f74d7) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Reorder attendance channel messages so the nearest upcoming event is the last (most visible) message, and add a divider between past and future events

## 0.15.2

### Patch Changes

- [#193](https://github.com/maxa-ondrej/sideline/pull/193) [`9e6a3ea`](https://github.com/maxa-ondrej/sideline/commit/9e6a3ea57fffc2207ef32f2594476f437566771c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Notify server when Discord channels are created, updated, or deleted so the internal channel list stays in sync.

- [#191](https://github.com/maxa-ondrej/sideline/pull/191) [`c0ec370`](https://github.com/maxa-ondrej/sideline/commit/c0ec3701d6b72c2a0dbba3d216041fd4f1342f41) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix newly created Discord channels not showing their name on the web by upserting the channel into the discord_channels table immediately after creation.

- [#189](https://github.com/maxa-ondrej/sideline/pull/189) [`bfbc107`](https://github.com/maxa-ondrej/sideline/commit/bfbc107dae79520fc5801792b5aede8f05ed4e83) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Remove RSVP buttons from Discord event messages after an event starts and mark events as started via a new cron job.

## 0.15.1

### Patch Changes

- [#182](https://github.com/maxa-ondrej/sideline/pull/182) [`a5c51c1`](https://github.com/maxa-ondrej/sideline/commit/a5c51c1885911f23c41e77e6a3244b950f5380fc) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - RSVP now saves immediately on button click. Ephemeral confirmation shows "Add a message" button (or "Edit message" + "Clear message" if a message already exists). Message is preserved when re-clicking the same RSVP button.

## 0.15.0

### Minor Changes

- [#178](https://github.com/maxa-ondrej/sideline/pull/178) [`24174e9`](https://github.com/maxa-ondrej/sideline/commit/24174e90b31d73c8bf5f5181a087a41c3289ae54) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add late RSVP notifications: when a member responds after the reminder is sent, post a notification to a configurable team channel and show a polite hint in the RSVP confirmation. Also include the list of yes attendees in the reminder embed.

## 0.14.4

### Patch Changes

- [`cc742d8`](https://github.com/maxa-ondrej/sideline/commit/cc742d8f5ae355e7485593255629b5fada51bda0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Show a list of yes attendees on RSVP event embeds

## 0.14.3

### Patch Changes

- [#153](https://github.com/maxa-ondrej/sideline/pull/153) [`690c5c0`](https://github.com/maxa-ondrej/sideline/commit/690c5c0be363ef1461e74a20ad0545ba140282db) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add 3-mode Discord channel cleanup (nothing, delete, archive) with separate settings for groups and rosters

- [#154](https://github.com/maxa-ondrej/sideline/pull/154) [`883189a`](https://github.com/maxa-ondrej/sideline/commit/883189a4c56c2da0c2dcf92544bb72445bbc343a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add configurable Discord channel/role name format templates to team settings

- [#169](https://github.com/maxa-ondrej/sideline/pull/169) [`1e8def9`](https://github.com/maxa-ondrej/sideline/commit/1e8def9790e7b31c9eb15faf81c71641d69e9d2d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add color and emoji support to groups and rosters with Discord role sync

- [#146](https://github.com/maxa-ondrej/sideline/pull/146) [`b871b3c`](https://github.com/maxa-ondrej/sideline/commit/b871b3c3def2b9eb2397a2072e88eb99d9c87170) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add discord channel linking to rosters with auto-creation, role management, and web UI

## 0.14.2

### Patch Changes

- [#140](https://github.com/maxa-ondrej/sideline/pull/140) [`247fa44`](https://github.com/maxa-ondrej/sideline/commit/247fa444ad52fc44796e54ac9231a73221c29ff0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team setting to control whether Discord channels are auto-created for new groups

- [#141](https://github.com/maxa-ondrej/sideline/pull/141) [`e4f8969`](https://github.com/maxa-ondrej/sideline/commit/e4f8969bcaf1278169e6e5a6aa2b3af49701ec78) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix incorrect permissions: add group:manage permission, gate nav items by role, fix avatar rendering and drawer padding

- Updated dependencies [[`dc1ed99`](https://github.com/maxa-ondrej/sideline/commit/dc1ed99d334839bddf17636b48e525b665321a18)]:
  - @sideline/effect-lib@0.0.7

## 0.14.1

### Patch Changes

- [#131](https://github.com/maxa-ondrej/sideline/pull/131) [`0d1567e`](https://github.com/maxa-ondrej/sideline/commit/0d1567eb18fd472e24bc40ac01238c8c6395a983) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Auto-join users to existing teams matching their Discord guilds after profile completion

- [#128](https://github.com/maxa-ondrej/sideline/pull/128) [`b629285`](https://github.com/maxa-ondrej/sideline/commit/b629285a4bfa1e7ff277f5257045bbaf6196148e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Improve website design: dark mode toggle, sidebar sections, hero page, RSVP side panel, leaderboard redesign, workout layout, team logo in switcher, and calendar subscription consistency

## 0.14.0

### Minor Changes

- [#123](https://github.com/maxa-ondrej/sideline/pull/123) [`8d97865`](https://github.com/maxa-ondrej/sideline/commit/8d978654612cab81032e51a3e602ddcf07918ac0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team profile settings (name, description, sport, logo URL) with new API endpoints, card-based settings page, and Discord channel configuration UI improvements

## 0.13.0

### Minor Changes

- [#121](https://github.com/maxa-ondrej/sideline/pull/121) [`737817d`](https://github.com/maxa-ondrej/sideline/commit/737817d36047e914a30f2d2c54b2220b96de21c5) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team leaderboard with activity rankings, streaks, web page, and Discord command

- [#122](https://github.com/maxa-ondrej/sideline/pull/122) [`683e8cb`](https://github.com/maxa-ondrej/sideline/commit/683e8cb3e0098fe2802cab6140f5986707d55136) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add personalized dashboard as the team home page with upcoming events, awaiting RSVP, activity summary, and team management widgets

### Patch Changes

- Updated dependencies [[`c8db130`](https://github.com/maxa-ondrej/sideline/commit/c8db13047b962c021f18aa04941b2d6298f73cf2)]:
  - @sideline/effect-lib@0.0.6

## 0.12.0

### Minor Changes

- [#117](https://github.com/maxa-ondrej/sideline/pull/117) [`1d39492`](https://github.com/maxa-ondrej/sideline/commit/1d394922570fb268808b92b0ceacd555048cc35a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace hardcoded activity types with a global activity_types table, auto-track training attendance via cron after events end, and switch stats to dynamic counts

- [#116](https://github.com/maxa-ondrej/sideline/pull/116) [`0fb3acd`](https://github.com/maxa-ondrej/sideline/commit/0fb3acd1ebf9afa6fc7b4fc6d9e14d5b786df4f1) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add activity logging via web app with quick-log widget, history page, and edit/delete support

- [#115](https://github.com/maxa-ondrej/sideline/pull/115) [`174013c`](https://github.com/maxa-ondrej/sideline/commit/174013ca0e42655ee261423a0bddcebb894e83d2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add player activity streaks and stats — streak calculation, /makanicko stats Discord command, web profile stats card, and HTTP API endpoint

### Patch Changes

- [#114](https://github.com/maxa-ondrej/sideline/pull/114) [`c902f5a`](https://github.com/maxa-ondrej/sideline/commit/c902f5aeb9551c43309f3e70134527dd39c5eb49) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add activity logging via Discord slash command (/makanicko log)

- [#108](https://github.com/maxa-ondrej/sideline/pull/108) [`0fc40b6`](https://github.com/maxa-ondrej/sideline/commit/0fc40b6cb2f3f765e2b65cf2343de39efb53e652) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add training type selection to Discord event creation flow

## 0.11.0

### Minor Changes

- [#103](https://github.com/maxa-ondrej/sideline/pull/103) [`79ca632`](https://github.com/maxa-ondrej/sideline/commit/79ca6325566fc6a2c9e37d4551bcea4f6507d03d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add owner/member group assignment to events, event series, and training types for group-based access control and visibility

### Patch Changes

- [#104](https://github.com/maxa-ondrej/sideline/pull/104) [`5d2979f`](https://github.com/maxa-ondrej/sideline/commit/5d2979f3ee666d24b461994e2ddb51abd2ce7017) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Enforce group membership checks on RSVP endpoints

- [#101](https://github.com/maxa-ondrej/sideline/pull/101) [`9584a67`](https://github.com/maxa-ondrej/sideline/commit/9584a6700fa5dcc86d1ccfed5ed44c07db9f3570) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Hide UI elements from users without required permissions (role and roster management buttons, admin sidebar links, events page for non-admins)

- Updated dependencies [[`79ca632`](https://github.com/maxa-ondrej/sideline/commit/79ca6325566fc6a2c9e37d4551bcea4f6507d03d)]:
  - @sideline/effect-lib@0.0.5

## 0.10.0

### Minor Changes

- [#98](https://github.com/maxa-ondrej/sideline/pull/98) [`c12900d`](https://github.com/maxa-ondrej/sideline/commit/c12900da82a09999081325bccbb29a39f93f3215) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add iCal subscription feature allowing players to subscribe to team events via webcal URL in Google Calendar, Apple Calendar, and Outlook

### Patch Changes

- [#88](https://github.com/maxa-ondrej/sideline/pull/88) [`3b20ab1`](https://github.com/maxa-ondrej/sideline/commit/3b20ab1ed4d61dffc0d136d6ee6a055672e65788) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add client-side age validation with localized error message and preselect birth year to 18 years ago in date picker

- [#91](https://github.com/maxa-ondrej/sideline/pull/91) [`dbe2a0b`](https://github.com/maxa-ondrej/sideline/commit/dbe2a0b480314845e45bcae95ea100ce0d06cf25) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace plain string dates with proper DateTime.Utc types throughout the stack

- [#96](https://github.com/maxa-ondrej/sideline/pull/96) [`b49b814`](https://github.com/maxa-ondrej/sideline/commit/b49b814c7166d2ae2d95b00a95ec87a55cb8e9b6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add /event-list Discord slash command with paginated upcoming events embed

- [#89](https://github.com/maxa-ondrej/sideline/pull/89) [`4d2ce92`](https://github.com/maxa-ondrej/sideline/commit/4d2ce92b94498e0683756fb4e1439cda51001abc) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Use Discord.Snowflake branded type across the entire stack, remove catchAll on unfailable effects, and refactor repository methods to use destructuring with default values

- [#83](https://github.com/maxa-ondrej/sideline/pull/83) [`38381e3`](https://github.com/maxa-ondrej/sideline/commit/38381e3695b8d2d5fc6704df9dfa8d29e55e2e0a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace NoSuchElementException with Option.match, add per-type emit methods to sync repos, and type User.discord_id as Snowflake

- [#83](https://github.com/maxa-ondrej/sideline/pull/83) [`38381e3`](https://github.com/maxa-ondrej/sideline/commit/38381e3695b8d2d5fc6704df9dfa8d29e55e2e0a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add typed business errors for unique constraint violations in repositories

- Updated dependencies [[`dbe2a0b`](https://github.com/maxa-ondrej/sideline/commit/dbe2a0b480314845e45bcae95ea100ce0d06cf25), [`e9809ab`](https://github.com/maxa-ondrej/sideline/commit/e9809ab5ee687de7db088da83a06dce0790adec2), [`38381e3`](https://github.com/maxa-ondrej/sideline/commit/38381e3695b8d2d5fc6704df9dfa8d29e55e2e0a)]:
  - @sideline/effect-lib@0.0.4

## 0.9.0

### Minor Changes

- [#77](https://github.com/maxa-ondrej/sideline/pull/77) [`f71d644`](https://github.com/maxa-ondrej/sideline/commit/f71d644aff2f4d181986b1510467577adb14fadc) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Support multiple days of week for event series (e.g. Mon+Wed+Fri) with toggleable day buttons UI

- [#78](https://github.com/maxa-ondrej/sideline/pull/78) [`5d55e46`](https://github.com/maxa-ondrej/sideline/commit/5d55e463e6be04b01ac87377825a2372caa2713f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add RSVP reminders and threshold warnings with non-responder visibility

### Patch Changes

- [#79](https://github.com/maxa-ondrej/sideline/pull/79) [`7dccd31`](https://github.com/maxa-ondrej/sideline/commit/7dccd31fe72f0063e7092cc4e762698b32a83e34) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add /event-create Discord slash command for creating events via bot modal

## 0.8.0

### Minor Changes

- [#73](https://github.com/maxa-ondrej/sideline/pull/73) [`bbaec4d`](https://github.com/maxa-ondrej/sideline/commit/bbaec4d84940ca8aad14ac650ea6214b3e6ee645) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Rename discord_username/discord_avatar to username/avatar across the codebase and fix RSVP member name display to fall back to username

## 0.7.1

### Patch Changes

- [#69](https://github.com/maxa-ondrej/sideline/pull/69) [`5455854`](https://github.com/maxa-ondrej/sideline/commit/5455854590e40219532403d35dc2e068fd5b62d3) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Reorder Discord event messages by start date after creating or updating events

## 0.7.0

### Minor Changes

- [#66](https://github.com/maxa-ondrej/sideline/pull/66) [`7c483c5`](https://github.com/maxa-ondrej/sideline/commit/7c483c5a68b9ebf115ccd141d487e334fdee4c2e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Extract OAuth into oauth_connections table and auto-register Discord guild members as team members

## 0.6.1

### Patch Changes

- [#58](https://github.com/maxa-ondrej/sideline/pull/58) [`fc4a030`](https://github.com/maxa-ondrej/sideline/commit/fc4a030319bbe581bf1b82b289711ecdb0731dac) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Migrate EventsRepository schemas from NullOr to OptionFromNullOr for consistent Option types across the repository layer

## 0.6.0

### Minor Changes

- [#53](https://github.com/maxa-ondrej/sideline/pull/53) [`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add recurring training events (weekly/biweekly series with materialized instances)

- [#51](https://github.com/maxa-ondrej/sideline/pull/51) [`a2b503c`](https://github.com/maxa-ondrej/sideline/commit/a2b503ce5e7dce8835af0182fa3c8e7242c98355) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add events feature: captains and coaches can create, view, edit, and cancel team events (training, match, tournament, meeting, social, other) with coach scoping via role_training_types

- [#55](https://github.com/maxa-ondrej/sideline/pull/55) [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add configurable Discord channel targeting for events at three levels: per-event/series, per-training-type default, and per-event-type in team settings

### Patch Changes

- [#54](https://github.com/maxa-ondrej/sideline/pull/54) [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Migrate birth_year to birth_date: store full date instead of year, add DatePicker UI

- [#54](https://github.com/maxa-ondrej/sideline/pull/54) [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Refactor event date/time from separate columns to TIMESTAMPTZ and extract DateTimeFromDate schema to effect-lib

- [#54](https://github.com/maxa-ondrej/sideline/pull/54) [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add RSVP feature for team events — players can respond Yes/No/Maybe with optional message via web app

- [#51](https://github.com/maxa-ondrej/sideline/pull/51) [`a2b503c`](https://github.com/maxa-ondrej/sideline/commit/a2b503ce5e7dce8835af0182fa3c8e7242c98355) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix coach scoping to check requesting user instead of event creator, use Option-based UpdateEventRequest schema, and fix Event model updated_at field type

- [#53](https://github.com/maxa-ondrej/sideline/pull/53) [`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix recurring events form interactivity and add recurring schedule management to training type detail page

- [#53](https://github.com/maxa-ondrej/sideline/pull/53) [`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add rolling horizon event generation with configurable per-team horizon days

- [#55](https://github.com/maxa-ondrej/sideline/pull/55) [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add view attendees feature with ephemeral embed and pagination on event RSVP

- Updated dependencies [[`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75)]:
  - @sideline/effect-lib@0.0.3

## 0.5.0

### Minor Changes

- [#47](https://github.com/maxa-ondrej/sideline/pull/47) [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Rework groups and roles: rename subgroups to groups with hierarchical support, assign roles to groups with recursive permission inheritance, scope training types to groups instead of coaches, and update age thresholds to operate on groups

### Patch Changes

- [#48](https://github.com/maxa-ondrej/sideline/pull/48) [`bdacd74`](https://github.com/maxa-ondrej/sideline/commit/bdacd74ce3ef5900ba18b266ef4836b284059428) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Emit channel_created event when linking an existing channel so the bot creates a role, and show channel names instead of raw snowflake IDs

- [#48](https://github.com/maxa-ondrej/sideline/pull/48) [`bdacd74`](https://github.com/maxa-ondrej/sideline/commit/bdacd74ce3ef5900ba18b266ef4836b284059428) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace Discord channel ID input with a select dropdown that fetches guild text channels via the user's OAuth token

- [#47](https://github.com/maxa-ondrej/sideline/pull/47) [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add group hierarchy tree UI with expand/collapse and parent selector, Discord channel mapping HTTP API and group detail section

- [#47](https://github.com/maxa-ondrej/sideline/pull/47) [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add move-group UI and create-channel endpoint for existing groups

- [#45](https://github.com/maxa-ondrej/sideline/pull/45) [`74544b4`](https://github.com/maxa-ondrej/sideline/commit/74544b4ede8dde9539bcb5c76c25afda279d883b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team-scoped authenticated routes and notification filtering

## 0.4.0

### Minor Changes

- [#39](https://github.com/maxa-ondrej/sideline/pull/39) [`eb7fdf3`](https://github.com/maxa-ondrej/sideline/commit/eb7fdf3c4607770baf78df856f450f5f303fdc9f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Remove position and proficiency from player data, move jersey number to team members

- [#37](https://github.com/maxa-ondrej/sideline/pull/37) [`0c98f29`](https://github.com/maxa-ondrej/sideline/commit/0c98f291ee6168e73077feec4cdbc89f0ccdfd3f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add training types CRUD with coach assignment

### Patch Changes

- [#41](https://github.com/maxa-ondrej/sideline/pull/41) [`3a2daa7`](https://github.com/maxa-ondrej/sideline/commit/3a2daa77509b9a1066c48b78e94697db7609e3d6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add coach-scoped permission checks for training type list, get, and update endpoints

- [#44](https://github.com/maxa-ondrej/sideline/pull/44) [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Use Discord roles for channel permissions instead of per-user permission overwrites

- [#44](https://github.com/maxa-ondrej/sideline/pull/44) [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Refactor RPC layer to use RpcGroup with prefix and configurable RPC_PREFIX env var

## 0.3.0

### Minor Changes

- [#35](https://github.com/maxa-ondrej/sideline/pull/35) [`eed4aa3`](https://github.com/maxa-ondrej/sideline/commit/eed4aa3820c6bbad12ff2292bcc92aee5a7460b9) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Discord role sync via @effect/rpc: server emits role change events, bot polls and syncs to Discord

## 0.2.0

### Minor Changes

- [#25](https://github.com/maxa-ondrej/sideline/pull/25) [`11b920c`](https://github.com/maxa-ondrej/sideline/commit/11b920c61ae409100c9bf09221a23929fdf053ef) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add admin roster management: team admins can view, edit, and deactivate team members. Adds `active` flag to team_members, roster API endpoints, and `myTeams` auth endpoint.

- [#27](https://github.com/maxa-ondrej/sideline/pull/27) [`780bca9`](https://github.com/maxa-ondrej/sideline/commit/780bca9d0300030fafd76edc3efd81e5f7a6f88d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Support multiple roles per team member via junction table, with API endpoints to assign and unassign roles

- [#26](https://github.com/maxa-ondrej/sideline/pull/26) [`2b1f4b4`](https://github.com/maxa-ondrej/sideline/commit/2b1f4b460b2d234f026cf658a6b0651f84ef58a9) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add roles and permissions system replacing simple admin/member text role with granular permission-based authorization

- [#25](https://github.com/maxa-ondrej/sideline/pull/25) [`11b920c`](https://github.com/maxa-ondrej/sideline/commit/11b920c61ae409100c9bf09221a23929fdf053ef) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add proper Roster entity with many-to-many team member membership

  Teams can now have multiple named rosters (e.g. per-event). Each roster has a name, active flag, and a set of team members. New API endpoints for full roster CRUD plus add/remove member operations. Player-pool endpoints renamed from /roster/_ to /members/_.

- [#29](https://github.com/maxa-ondrej/sideline/pull/29) [`e8fd1ab`](https://github.com/maxa-ondrej/sideline/commit/e8fd1ab2e0b47aa37fa6ed58e01572d25f90e64d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add subgroups — named groups of team members with associated permissions for fine-grained access control

### Patch Changes

- [#26](https://github.com/maxa-ondrej/sideline/pull/26) [`2b1f4b4`](https://github.com/maxa-ondrej/sideline/commit/2b1f4b460b2d234f026cf658a6b0651f84ef58a9) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add createTeam API endpoint allowing authenticated users to create new teams from the web app

## 0.1.2

### Patch Changes

- [#21](https://github.com/maxa-ondrej/sideline/pull/21) [`fa51b42`](https://github.com/maxa-ondrej/sideline/commit/fa51b42bab5144cc6027a9fafbc5e8b75271df90) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Standardize TypeScript imports to use `~` alias for `src/` and root-only package imports

## 0.1.1

### Patch Changes

- [`8505070`](https://github.com/maxa-ondrej/sideline/commit/850507079ac8e4a9846a34fc365b2c2714ecfa5b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Enable changesets versioning and tagging for private application packages

## 0.1.0

### Minor Changes

- [#5](https://github.com/maxa-ondrej/sideline/pull/5) [`0458277`](https://github.com/maxa-ondrej/sideline/commit/0458277c509fccaa36fefdc7f2d9a8e9833caa83) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Czech + English i18n support with Paraglide JS, language switcher, persistent user locale, and locale-aware formatting

- [`6579f9e`](https://github.com/maxa-ondrej/sideline/commit/6579f9e28eaf8f5ea2ef9d388e092a7cf672198b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Initial project setup
  - Add Discord OAuth login flow with session and user management
  - Add typed frontend runtime with ApiClient context and ClientError
  - Add env-aware runMain for bot and server (JSON logger in production, pretty logger in development)
  - Add Dockerfiles and Docker CI workflow for all applications
  - Migrate Vitest to root test.projects configuration
  - Refactor app layers into AppLive + run.ts pattern
  - Add Swagger UI and OpenAPI docs to server
  - Add shadcn/ui components to web app

- [#4](https://github.com/maxa-ondrej/sideline/pull/4) [`e3a3938`](https://github.com/maxa-ondrej/sideline/commit/e3a393841205f203c16c65dfb0f05a8a5b656cab) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add profile completion flow: migration for profile fields, API endpoint, form UI, and tests

- [#3](https://github.com/maxa-ondrej/sideline/pull/3) [`a89cf75`](https://github.com/maxa-ondrej/sideline/commit/a89cf758025d95caae8a98c4337e9679c8bf301e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add teams, team invites, and profile completion flow

### Patch Changes

- [#4](https://github.com/maxa-ondrej/sideline/pull/4) [`e3a3938`](https://github.com/maxa-ondrej/sideline/commit/e3a393841205f203c16c65dfb0f05a8a5b656cab) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix Discord OAuth Bearer token, improve invite safety, add Effect DevTools, and strengthen type safety

- [`2776ed6`](https://github.com/maxa-ondrej/sideline/commit/2776ed65f129a1206637332b94bdf64a9280cfeb) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Reorganize domain package into models/ and api/ subdirectories and refactor server repositories to use bind/let pattern
