# @sideline/migrations

## 0.23.0

### Minor Changes

- [#413](https://github.com/maxa-ondrej/sideline/pull/413) [`dd91e63`](https://github.com/maxa-ondrej/sideline/commit/dd91e634678c34742ca8224fb7c9c9ced1c098f0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a team-average Elo rating system. Captains and admins (any member with `member:edit`) can record game results via `POST /teams/:teamId/ratings/games`; the server applies K=40 during calibration (first 10 games) and K=20 thereafter. Current standings are readable by all team members via `GET /teams/:teamId/ratings`; individual rating details and full game history are available per-member. Two new database tables (`player_ratings`, `player_rating_history`) back the feature. A `MemberRatingCard` component surfaces ratings on the player profile page.

- [#416](https://github.com/maxa-ondrej/sideline/pull/416) [`39f23d6`](https://github.com/maxa-ondrej/sideline/commit/39f23d6fde5b1d997e22ea8c802def2e41d72141) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a balanced training team generator. Captains and admins (any member with `member:edit`) can generate two balanced teams for a training event based on player Elo ratings, with optional gender-mix weighting, then review, manually swap players, and post the result to Discord.

  The core is a pure, deterministic engine (`TeamGenerator`) that seeds teams via snake-draft and refines them with hill-climbing local search over a normalized weighted cost function (Elo spread, team size, gender distribution), surfacing warnings for uneven team sizes, Elo outliers, and insufficient gender mix. Per-team balancing weights are configurable per team (`team_generation_config` table). The web `TeamGeneratorSection` provides generation, live balance feedback, and accessible select-two-to-swap manual adjustment; the `/training generate` Discord command deep-links to it. Posting to Discord goes through the event-sync outbox (`teams_generated` event) and re-derives all embed content server-side from the trusted roster. MVP ships two teams with an N-ready API and engine.

- [#415](https://github.com/maxa-ondrej/sideline/pull/415) [`30166b5`](https://github.com/maxa-ondrej/sideline/commit/30166b5b0245a31414028d2a8be06a2afdc8ddb7) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add training game result logging. Coaches (any member with `member:edit`) open a training event and split the RSVP-yes attendees into Team A / Team B, then record the winner (Team A / Team B / Draw); multiple games (rounds) can be logged per session. Saving a result applies an incremental Elo update via the existing rating engine — the new game's id is recorded on each `player_rating_history` row — and best-effort auto-logs training attendance for all RSVP-yes members (deduplicated per UTC day). Two new tables (`training_games`, `training_game_participants`) back the feature. The `/training result` Discord command is a convenience deep-link: it replies with an ephemeral link to the web result editor, listing loggable trainings (including just-finished ones) via the new `Event/GetLoggableTrainingEvents` RPC. Logged games are immutable for now.

## 0.22.0

### Minor Changes

- [#410](https://github.com/maxa-ondrej/sideline/pull/410) [`57b267f`](https://github.com/maxa-ondrej/sideline/commit/57b267f2ba806dc0e3cf0ac8c91d0e4145631b12) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a global-admin management area so existing global admins can view, grant, and revoke global-admin status from the web admin section. Grants are recorded with a new `global_admin_granted_at` timestamp. Safeguards prevent self-revocation and removing the last effective admin (counting both database admins and the `APP_GLOBAL_ADMIN_DISCORD_IDS` env allowlist); env-allowlisted admins are surfaced as non-revocable. The last-admin check uses a TOCTOU-safe guarded update.

## 0.21.0

### Minor Changes

- [#399](https://github.com/maxa-ondrej/sideline/pull/399) [`58b7a5a`](https://github.com/maxa-ondrej/sideline/commit/58b7a5aa2954faa5925bdcf0f3e9334b5d102d2e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Link a tournament event to a real roster with a per-pair auto-approve toggle. An
  RSVP "yes" drives roster membership: with auto-approve on, the member is added
  automatically; with it off, an Approve/Decline request is posted to a dedicated
  per-event thread in the owner group's channel and is also actionable on the web
  roster detail page. Withdrawing a "yes" removes flow-added members (manual members
  are protected) and cancels pending requests; enabling auto-approve backfills current
  "yes" responders. Configure and approve from either Discord or the web.

## 0.20.2

### Patch Changes

- [#396](https://github.com/maxa-ondrej/sideline/pull/396) [`4f69c4c`](https://github.com/maxa-ondrej/sideline/commit/4f69c4ce586911ad828844928ec4a393e5f39678) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add per-team IMAP email ingestion alongside the existing inbound webhook. Teams can now
  configure an IMAP mailbox in Team Settings; a UID-tracked cron poller fetches new mail every
  few minutes, parses it, and feeds the same summarize → coach-approval → Discord pipeline the
  webhook uses. Mailbox credentials are stored encrypted at rest (AES-256-GCM with an app-held
  key), never returned by the API, and entered via a write-only password field. Message-ID
  deduplication prevents double-processing when both ingestion methods run at once, and the
  watermark only advances past mail that was successfully ingested so transient failures retry
  rather than lose messages.

## 0.20.1

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

## 0.20.0

### Minor Changes

- [#383](https://github.com/maxa-ondrej/sideline/pull/383) [`741f36a`](https://github.com/maxa-ondrej/sideline/commit/741f36adbbbc7f77b43e4a9ab400003418e13d7f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - feat(email): two-tier summaries (short + detailed) with ephemeral paginated Discord previews and dual-summary web editing

  Every forwarded email now gets a SHORT summary (a plain opening sentence plus ~6 emoji-led bullets) and a DETAILED summary (the existing balanced one), generated in a single OpenAI JSON-mode call. The coach approval message shows both summaries inline; the posted team message shows the short summary with buttons that open ephemeral, paginated previews of the detailed summary and the original email (no Sideline redirect). The Sideline web email page edits both summaries. Adds a nullable `short_summary` column (legacy rows fall back to the detailed summary, then the body) and a team-ownership + posted-status-guarded `Email/GetEmailContent` RPC for the member-facing previews.

## 0.19.0

### Minor Changes

- [#367](https://github.com/maxa-ondrej/sideline/pull/367) [`7479b19`](https://github.com/maxa-ondrej/sideline/commit/7479b1992514f9eec87456e09ad93e4ebb2f754e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Improve the coach assigning feature:
  - **Configurable claim lead-time** — training claim-request messages now post a configurable number of days before the training (new per-team setting `claim_request_days_before`, default 3) instead of at event creation time, which could be up to the event horizon (~2 weeks) ahead. A new `TrainingClaimRequestCron` drives the scheduled posting; the on-creation emitter only fires immediately when the training already falls inside the lead-time window.
  - **Training-day coaching status** — a new `CoachingStatusCron` posts a "today's coach is X" announcement to the member-visible training channel on the training day, only when the training is already claimed (to avoid notification spam).
  - **Thread-based claim management** — the claim message now spawns a Discord thread (tracked via the new `events.claim_thread_id` column); the claim embed and buttons remain on the starter message.

  Includes an idempotent migration adding `team_settings.claim_request_days_before`, `events.claim_request_sent_at`, `events.coaching_status_sent_at`, and `events.claim_thread_id`, extending the `event_sync_events` type check with `coaching_status`, partial indexes for the new cron scans, and a backfill that marks existing trainings as already-handled so there is no first-deploy notification blast.

## 0.18.1

### Patch Changes

- [#362](https://github.com/maxa-ondrej/sideline/pull/362) [`a103105`](https://github.com/maxa-ondrej/sideline/commit/a103105f7db7b468fa3dbf82dbf02cac971468ec) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add idempotent migration to create `team_onboarding_tokens` table on production databases where migration `1747700000` was silently skipped. The Effect SQL migrator only runs migrations with ID greater than the latest applied ID, so any migration added with an older timestamp than what is already in the database will never execute. This `IF NOT EXISTS` migration at a higher ID ensures the table is created correctly regardless of migration history.

## 0.18.0

### Minor Changes

- [#356](https://github.com/maxa-ondrej/sideline/pull/356) [`8e17378`](https://github.com/maxa-ondrej/sideline/commit/8e173785eb8ce2a74f6a9bd729e51e6de252102b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - feat(events): hide started/cancelled events by default and support all-day / multi-day events
  - The events list now hides `started` and `cancelled` events by default, with a "Show past & cancelled" toggle. The calendar view continues to show all events.
  - Events can be marked **all day** (no time), including multi-day spans such as tournaments. An "All day" toggle on the create/edit forms hides the time inputs. All-day events render as date(s) only across the web list, detail, and calendar views, in Discord embeds (date-style timestamps), and in the iCal feed (`VALUE=DATE`).

## 0.17.0

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

## 0.16.0

### Minor Changes

- [#342](https://github.com/maxa-ondrej/sideline/pull/342) [`f4f0e3f`](https://github.com/maxa-ondrej/sideline/commit/f4f0e3f9a33a200c58e02c45949489cf8f7a226b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Discord carpool board feature (`/doprava` / `/carpool`). Captains post a live-updating board; members add cars (capacity 1–8 including driver), reserve seats via buttons, and manage passengers in a per-car private thread. Introduces three new database tables (`carpools`, `carpool_cars`, `carpool_seats`), eight new `Carpool/*` RPC methods, and a new `carpool:manage` permission granted to Admin and Captain roles by default.

- [#338](https://github.com/maxa-ondrej/sideline/pull/338) [`c50e57f`](https://github.com/maxa-ondrej/sideline/commit/c50e57f4e00c9b46fefbd3241917f4a1d214a435) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Team members can now customize their dashboard: show/hide and reorder the four non-urgent widgets (stats, upcoming events, activity, team management) per team. The layout is persisted server-side in a new `dashboard_layouts` table so it syncs across devices. The two urgency banners (awaiting RSVP, outstanding payments) stay pinned and are intentionally not user-hideable so members never silently miss alerts. New `GET`/`PUT /teams/:teamId/dashboard-layout` endpoints; the dashboard read endpoint is unchanged and the layout loads as a graceful-degradation arm so the dashboard never breaks if the config call fails.

### Patch Changes

- [#335](https://github.com/maxa-ondrej/sideline/pull/335) [`32f598b`](https://github.com/maxa-ondrej/sideline/commit/32f598b8c8c83471b38d5221ac2eaced1da634d5) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a dedicated `challenge:manage` permission for the Weekly Challenges feature, granted to both Admin and Captain roles by default. Previously the team-challenge HTTP API checked the admin-only `team:manage` permission, blocking captains from creating / editing / deleting challenges. The new migration backfills the permission for all existing teams' built-in Admin and Captain roles.

- [#337](https://github.com/maxa-ondrej/sideline/pull/337) [`a48c644`](https://github.com/maxa-ondrej/sideline/commit/a48c644e56bcae9a615bf7f3273fb77810141f5f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix removed users retaining access to old teams. `TeamMembersRepository.findMembershipByIds` now filters inactive memberships by default, closing access through every endpoint that gates on team membership. Notification endpoints (`listNotifications`, `markAsRead`, `markAllAsRead`) now require active membership. iCal fee feed and payment-reminder cron exclude inactive members. `auth.autoJoinTeams` treats deactivation as terminal — removed users must rejoin via fresh invite. Web shows a new `/no-team` page for 0-team users with an optional "you were removed" banner; team-detail routes redirect removed users instead of 404ing.

  Add global-admin bootstrap: the first registered user is automatically granted global admin (new `users.is_global_admin` column, set atomically on first insert). `isGlobalAdmin` now resolves from the DB flag OR the `APP_GLOBAL_ADMIN_DISCORD_IDS` env allowlist via a shared `toCurrentUser` helper. Global admins with no teams are routed to `/admin/onboarding-tokens` (where they can onboard the first team) instead of the `/no-team` page.

## 0.15.0

### Minor Changes

- [#326](https://github.com/maxa-ondrej/sideline/pull/326) [`7fe28e8`](https://github.com/maxa-ondrej/sideline/commit/7fe28e84facfe9b4bef5b70c8627710fea5eb690) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add an admin-mediated team onboarding flow. Global admins now mint single-use, time-limited onboarding links bound to a specific Discord user; captains complete team setup (identity, Discord server, channels) via a 2-step wizard that authenticates with their bound Discord account. Team provisioning runs in a SQL transaction so the token is only consumed if the team is fully provisioned. As part of this work, `TeamsRepository.insertQuery` now persists all 16 team columns (previously silently dropped 6).

- [#331](https://github.com/maxa-ondrej/sideline/pull/331) [`d7513dc`](https://github.com/maxa-ondrej/sideline/commit/d7513dc8615ea3b28d905493c050d461adc8a4c9) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add backend foundation for Weekly Challenges (Týdenní výzvy). Captains can create one challenge per week per team with a kind discriminator (`throwing` or `sport`), title, and optional description; team members can self-mark completion on the current ISO week only. Includes 3 new tables (`weekly_challenges`, `weekly_challenge_completions`, `weekly_challenge_sync_events`), domain schemas, RPC group with 5 typed error tags, repository with transactional FOR UPDATE mark/unmark, timezone-aware Monday-date helpers, and an outbox table populated at create time so the bot can announce the challenge on its start Monday at 09:00 team-local. The Discord bot drain and web UI will land in follow-up PRs.

## 0.14.2

### Patch Changes

- [#323](https://github.com/maxa-ondrej/sideline/pull/323) [`f1fd0cd`](https://github.com/maxa-ondrej/sideline/commit/f1fd0cda5578907f85e49efdb240fd48adb9f070) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Achievement notifications are now posted to a configurable per-team Achievement channel. Existing teams continue posting to their welcome channel by default; set the channel to "None" on the team settings page to disable achievement notifications.

## 0.14.1

### Patch Changes

- [#316](https://github.com/maxa-ondrej/sideline/pull/316) [`f2a41c3`](https://github.com/maxa-ondrej/sideline/commit/f2a41c3a0210dd1d300df24e2038272d97981faf) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add explicit `rsvp_reminders_enabled` toggle to team settings and fix `daysBefore = 0` to mean "remind on the day of the event" (was silently treated as "disabled" because the cron filtered on `rsvp_reminder_days_before > 0`). With this change:
  - Teams that had `rsvp_reminder_days_before = 0` expecting same-day reminders will now actually receive them at `rsvp_reminder_time` on the day of the event (and the late-RSVP and unclaimed-training reminders that depend on this same cron path will fire too).
  - A new `rsvp_reminders_enabled` boolean (default `true`) is the explicit way to disable RSVP reminders. Surface in `Team Settings` as the "Enable RSVP reminders" checkbox.

  Migrate-up only — defaults to `TRUE` for all existing teams.

## 0.14.0

### Minor Changes

- [#311](https://github.com/maxa-ondrej/sideline/pull/311) [`2f5291f`](https://github.com/maxa-ondrej/sideline/commit/2f5291f5a2b6643ee5bd6bed922b208c669c3f09) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team expense tracking. Admins and treasurers can log, edit, and delete team expenses across five categories (fields, equipment, travel, tournaments, other) via a new `/teams/:teamId/finances/expenses` page. The Finances overview gains a new default "Overview" tab with an income vs. expense balance dashboard — KPI strip for income, expenses, and net balance, plus a category breakdown — driven by a multi-currency `balance-summary` endpoint. Every write is captured in an `expense_history` audit table via a Postgres trigger. Reuses existing `finance:view` (read) and `finance:manage_fees` (write) permissions — no new permission literal.

- [#289](https://github.com/maxa-ondrej/sideline/pull/289) [`6abf99c`](https://github.com/maxa-ondrej/sideline/commit/6abf99c886c1e5b43fed364699e1f0ee947c4a9c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add fee management and payment tracking MVP. Admins can define fees, assign them to members, and record manual payments (cash or bank transfer); members see their outstanding fees via `/finance status` in Discord and captains get a team-wide overview in the web app. Introduces `finance:view`, `finance:manage_fees`, and `finance:record_payments` permissions (treasurer pattern).

### Patch Changes

- [#303](https://github.com/maxa-ondrej/sideline/pull/303) [`978746c`](https://github.com/maxa-ondrej/sideline/commit/978746ca35b12203a046be017483dbfa968dfaf8) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Captains can now create, update, and delete custom activity types (previously admin-only). The activity types management page is now reachable from the team sidebar (under Coach).

- [#308](https://github.com/maxa-ondrej/sideline/pull/308) [`62db467`](https://github.com/maxa-ondrej/sideline/commit/62db46789598c4ec0b02c0f31dded7a262bca718) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Send payment reminders via Discord DM and surface them in the personal iCal feed. A new server cron emits five reminder cadences per unpaid fee (T-3, T-0, T+3, T+10, T+21); the bot delivers each as a DM and only records "sent" after a successful Discord delivery so transient failures get retried. The personal iCal feed (`GET /ical/:token`) now includes all-day VEVENTs with a 1-day VALARM for unpaid/partial/overdue assignments within a 180-day window, fixing RFC 5545 DTSTAMP omission on existing event VEVENTs along the way.

- [#305](https://github.com/maxa-ondrej/sideline/pull/305) [`e656e54`](https://github.com/maxa-ondrej/sideline/commit/e656e543f3bb51f9279941d9d7edee529988bfa6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Introduce a built-in `Treasurer` role that holds the money-moving finance permissions (`finance:manage_fees`, `finance:record_payments`) so teams can delegate finance authority without elevating to Admin. Captain's finance scope narrows to `finance:view` only. Admin keeps every permission. Migration `1784000000` creates Treasurer for every existing team and backfills missing finance/activity-type permissions on legacy Admin and Captain rows. The migration is additive — it never deletes existing `role_permissions` rows.

## 0.13.0

### Minor Changes

- [#272](https://github.com/maxa-ondrej/sideline/pull/272) [`22d7c79`](https://github.com/maxa-ondrej/sideline/commit/22d7c7996efa5a3ce9a8c5a11c070ac7d4b156f6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Admins can define custom activity types per team. Each type has a name, emoji,
  and description, scoped to the team. Built-in types (Gym, Run, Stretch, Training)
  remain global and read-only; tenant isolation is enforced at the repository
  layer. The Discord `/makanicko log` command switches from a static choices list
  to autocomplete that pulls the team's effective list (globals + custom). Web
  exposes a new admin page at `/teams/:teamId/activity-types` with create/edit/
  delete (delete is blocked when logs reference the type — rename instead).

### Patch Changes

- [#268](https://github.com/maxa-ondrej/sideline/pull/268) [`1a361c7`](https://github.com/maxa-ondrej/sideline/commit/1a361c7124725e40f0d62e5c546b1dedfcc34535) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add achievement system: players earn badges for their activity, and selected achievements automatically grant Discord roles.
  - Code-defined catalog of 11 V1 achievements covering total activities (1/10/50/100), longest streak (3/7/30 days), cumulative duration (10h/50h), and per-activity-type counts (25 gym / 25 running).
  - `AchievementEvaluator` runs after every activity-log create and update; new badges are inserted idempotently and emit a sync event for the bot to process.
  - Bot polls `Achievement/GetUnprocessedEvents`, optionally grants a per-team Discord role (5 of 11 achievements), and posts a gold embed to the team's welcome channel.
  - Player profile shows an Achievements grid between Roles and Activity Stats; earned badges are highlighted, unearned ones are dimmed.
  - New tables: `earned_achievements`, `achievement_role_mappings`, `achievement_sync_events`.
  - Fix: `TeamsRepository.insert` now persists `welcome_channel_id` instead of silently dropping it.

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

## 0.12.15

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

## 0.12.14

### Patch Changes

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

## 0.12.13

### Patch Changes

- [#242](https://github.com/maxa-ondrej/sideline/pull/242) [`4ee7b70`](https://github.com/maxa-ondrej/sideline/commit/4ee7b7029c76a3a17e19bc902a7284aea076f5b0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix a crash that prevented creating or updating events and event series unless every optional field was filled in. The cross-field validation that links the new "location link" feature to the location text was reading internal Option markers without first checking that the field was present, which threw `TypeError: Cannot read properties of undefined (reading '_tag')` whenever the location link or location text was empty. The check now correctly evaluates each field's state and only rejects payloads that set a location link without a location text.

## 0.12.12

### Patch Changes

- [#240](https://github.com/maxa-ondrej/sideline/pull/240) [`57cde28`](https://github.com/maxa-ondrej/sideline/commit/57cde28ef0095cc6b309ab3316967f859cd6b1f2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - You can now attach an optional link to an event's location (e.g. Google Maps, venue page). The location text becomes a clickable link on the website and a markdown hyperlink in Discord posts.

## 0.12.11

### Patch Changes

- [#238](https://github.com/maxa-ondrej/sideline/pull/238) [`2e53d6a`](https://github.com/maxa-ondrej/sideline/commit/2e53d6a4b2a40f222efee89e9a204a66bf33fc4c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - You can now attach a cover image URL to events. Images appear on the event page and as a thumbnail in Discord posts.

## 0.12.10

### Patch Changes

- [#236](https://github.com/maxa-ondrej/sideline/pull/236) [`cb91dc7`](https://github.com/maxa-ondrej/sideline/commit/cb91dc72b9f471511d96ac5604e086a60f4193f5) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - feat: add coach claim training feature

  Coaches can now volunteer to organize trainings via a dedicated Discord message posted to the owners group's channel. The message contains a Claim button that toggles to Release once claimed, and the regular reminder cron also posts a "still no coach" reminder when a training stays unclaimed at reminder time.

## 0.12.9

### Patch Changes

- [#232](https://github.com/maxa-ondrej/sideline/pull/232) [`ee68d21`](https://github.com/maxa-ondrej/sideline/commit/ee68d215ab1a26accc771119c3249b99aa6c9c71) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Improve the reminders feature: configurable reminder time and timezone (per-team), dedicated reminders channel, member-group-aware audience and role mentions, and a new "Starting now" announcement when an event begins.

  Team settings now expose `rsvpReminderDaysBefore`, `rsvpReminderTime` (HH:MM, capped at 23:54 to avoid midnight wrap), `timezone` (any IANA zone, default `Europe/Prague`), and `remindersChannelId`. Reminders fire at the configured time in the team's timezone with a 5-minute tolerance window. The reminder embed and the new "Starting now" post target the reminders channel (falling back to the owner-group channel, then the guild's system channel) and mention the event's member-group role. The reminder's "Going" and "Not yet responded" lists are filtered to the member group when one is set.

## 0.12.8

### Patch Changes

- [#221](https://github.com/maxa-ondrej/sideline/pull/221) [`efca9d7`](https://github.com/maxa-ondrej/sideline/commit/efca9d7556dac7e05fc19d2255b76788c1ed8700) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add discord display name to the name fallback chain in formatName

## 0.12.7

### Patch Changes

- [#206](https://github.com/maxa-ondrej/sideline/pull/206) [`d99385d`](https://github.com/maxa-ondrej/sideline/commit/d99385d26b7a112f8c632cb020b37de48f4cc9ad) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Store Discord server nickname and use name display priority: DB name → server nickname → username

## 0.12.6

### Patch Changes

- [#195](https://github.com/maxa-ondrej/sideline/pull/195) [`0704c17`](https://github.com/maxa-ondrej/sideline/commit/0704c17897ced04f67ee10a7ed65cd0ec51f74d7) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Reorder attendance channel messages so the nearest upcoming event is the last (most visible) message, and add a divider between past and future events

## 0.12.5

### Patch Changes

- [#189](https://github.com/maxa-ondrej/sideline/pull/189) [`bfbc107`](https://github.com/maxa-ondrej/sideline/commit/bfbc107dae79520fc5801792b5aede8f05ed4e83) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Remove RSVP buttons from Discord event messages after an event starts and mark events as started via a new cron job.

## 0.12.4

### Patch Changes

- [#178](https://github.com/maxa-ondrej/sideline/pull/178) [`24174e9`](https://github.com/maxa-ondrej/sideline/commit/24174e90b31d73c8bf5f5181a087a41c3289ae54) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add late RSVP notifications: when a member responds after the reminder is sent, post a notification to a configurable team channel and show a polite hint in the RSVP confirmation. Also include the list of yes attendees in the reminder embed.

## 0.12.3

### Patch Changes

- [#153](https://github.com/maxa-ondrej/sideline/pull/153) [`690c5c0`](https://github.com/maxa-ondrej/sideline/commit/690c5c0be363ef1461e74a20ad0545ba140282db) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add 3-mode Discord channel cleanup (nothing, delete, archive) with separate settings for groups and rosters

- [#154](https://github.com/maxa-ondrej/sideline/pull/154) [`883189a`](https://github.com/maxa-ondrej/sideline/commit/883189a4c56c2da0c2dcf92544bb72445bbc343a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add configurable Discord channel/role name format templates to team settings

- [#169](https://github.com/maxa-ondrej/sideline/pull/169) [`1e8def9`](https://github.com/maxa-ondrej/sideline/commit/1e8def9790e7b31c9eb15faf81c71641d69e9d2d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add color and emoji support to groups and rosters with Discord role sync

- [#146](https://github.com/maxa-ondrej/sideline/pull/146) [`b871b3c`](https://github.com/maxa-ondrej/sideline/commit/b871b3c3def2b9eb2397a2072e88eb99d9c87170) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add discord channel linking to rosters with auto-creation, role management, and web UI

## 0.12.2

### Patch Changes

- [#140](https://github.com/maxa-ondrej/sideline/pull/140) [`247fa44`](https://github.com/maxa-ondrej/sideline/commit/247fa444ad52fc44796e54ac9231a73221c29ff0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team setting to control whether Discord channels are auto-created for new groups

- [#141](https://github.com/maxa-ondrej/sideline/pull/141) [`e4f8969`](https://github.com/maxa-ondrej/sideline/commit/e4f8969bcaf1278169e6e5a6aa2b3af49701ec78) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix incorrect permissions: add group:manage permission, gate nav items by role, fix avatar rendering and drawer padding

## 0.12.1

### Patch Changes

- [#123](https://github.com/maxa-ondrej/sideline/pull/123) [`8d97865`](https://github.com/maxa-ondrej/sideline/commit/8d978654612cab81032e51a3e602ddcf07918ac0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team profile settings (name, description, sport, logo URL) with new API endpoints, card-based settings page, and Discord channel configuration UI improvements

## 0.12.0

### Minor Changes

- [#117](https://github.com/maxa-ondrej/sideline/pull/117) [`1d39492`](https://github.com/maxa-ondrej/sideline/commit/1d394922570fb268808b92b0ceacd555048cc35a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace hardcoded activity types with a global activity_types table, auto-track training attendance via cron after events end, and switch stats to dynamic counts

### Patch Changes

- [#114](https://github.com/maxa-ondrej/sideline/pull/114) [`c902f5a`](https://github.com/maxa-ondrej/sideline/commit/c902f5aeb9551c43309f3e70134527dd39c5eb49) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add activity logging via Discord slash command (/makanicko log)

## 0.11.0

### Minor Changes

- [#103](https://github.com/maxa-ondrej/sideline/pull/103) [`79ca632`](https://github.com/maxa-ondrej/sideline/commit/79ca6325566fc6a2c9e37d4551bcea4f6507d03d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add owner/member group assignment to events, event series, and training types for group-based access control and visibility

## 0.10.0

### Minor Changes

- [#98](https://github.com/maxa-ondrej/sideline/pull/98) [`c12900d`](https://github.com/maxa-ondrej/sideline/commit/c12900da82a09999081325bccbb29a39f93f3215) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add iCal subscription feature allowing players to subscribe to team events via webcal URL in Google Calendar, Apple Calendar, and Outlook

## 0.9.0

### Minor Changes

- [#77](https://github.com/maxa-ondrej/sideline/pull/77) [`f71d644`](https://github.com/maxa-ondrej/sideline/commit/f71d644aff2f4d181986b1510467577adb14fadc) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Support multiple days of week for event series (e.g. Mon+Wed+Fri) with toggleable day buttons UI

- [#78](https://github.com/maxa-ondrej/sideline/pull/78) [`5d55e46`](https://github.com/maxa-ondrej/sideline/commit/5d55e463e6be04b01ac87377825a2372caa2713f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add RSVP reminders and threshold warnings with non-responder visibility

## 0.8.0

### Minor Changes

- [#73](https://github.com/maxa-ondrej/sideline/pull/73) [`bbaec4d`](https://github.com/maxa-ondrej/sideline/commit/bbaec4d84940ca8aad14ac650ea6214b3e6ee645) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Rename discord_username/discord_avatar to username/avatar across the codebase and fix RSVP member name display to fall back to username

## 0.7.0

### Minor Changes

- [#66](https://github.com/maxa-ondrej/sideline/pull/66) [`7c483c5`](https://github.com/maxa-ondrej/sideline/commit/7c483c5a68b9ebf115ccd141d487e334fdee4c2e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Extract OAuth into oauth_connections table and auto-register Discord guild members as team members

## 0.6.0

### Minor Changes

- [#53](https://github.com/maxa-ondrej/sideline/pull/53) [`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add recurring training events (weekly/biweekly series with materialized instances)

- [#51](https://github.com/maxa-ondrej/sideline/pull/51) [`a2b503c`](https://github.com/maxa-ondrej/sideline/commit/a2b503ce5e7dce8835af0182fa3c8e7242c98355) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add events feature: captains and coaches can create, view, edit, and cancel team events (training, match, tournament, meeting, social, other) with coach scoping via role_training_types

- [#55](https://github.com/maxa-ondrej/sideline/pull/55) [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add configurable Discord channel targeting for events at three levels: per-event/series, per-training-type default, and per-event-type in team settings

### Patch Changes

- [#54](https://github.com/maxa-ondrej/sideline/pull/54) [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Migrate birth_year to birth_date: store full date instead of year, add DatePicker UI

- [#54](https://github.com/maxa-ondrej/sideline/pull/54) [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Refactor event date/time from separate columns to TIMESTAMPTZ and extract DateTimeFromDate schema to effect-lib

- [#54](https://github.com/maxa-ondrej/sideline/pull/54) [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add RSVP feature for team events — players can respond Yes/No/Maybe with optional message via web app

- [#53](https://github.com/maxa-ondrej/sideline/pull/53) [`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add rolling horizon event generation with configurable per-team horizon days

## 0.5.0

### Minor Changes

- [#47](https://github.com/maxa-ondrej/sideline/pull/47) [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Rework groups and roles: rename subgroups to groups with hierarchical support, assign roles to groups with recursive permission inheritance, scope training types to groups instead of coaches, and update age thresholds to operate on groups

## 0.4.0

### Minor Changes

- [#39](https://github.com/maxa-ondrej/sideline/pull/39) [`eb7fdf3`](https://github.com/maxa-ondrej/sideline/commit/eb7fdf3c4607770baf78df856f450f5f303fdc9f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Remove position and proficiency from player data, move jersey number to team members

### Patch Changes

- [#44](https://github.com/maxa-ondrej/sideline/pull/44) [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Use Discord roles for channel permissions instead of per-user permission overwrites

- [#44](https://github.com/maxa-ondrej/sideline/pull/44) [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Soft-delete subgroups and roles via is_archived flag instead of hard deleting rows

- [#37](https://github.com/maxa-ondrej/sideline/pull/37) [`0c98f29`](https://github.com/maxa-ondrej/sideline/commit/0c98f291ee6168e73077feec4cdbc89f0ccdfd3f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add training types CRUD with coach assignment

## 0.3.0

### Minor Changes

- [#35](https://github.com/maxa-ondrej/sideline/pull/35) [`eed4aa3`](https://github.com/maxa-ondrej/sideline/commit/eed4aa3820c6bbad12ff2292bcc92aee5a7460b9) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Discord role sync via @effect/rpc: server emits role change events, bot polls and syncs to Discord

## 0.2.0

### Minor Changes

- [#27](https://github.com/maxa-ondrej/sideline/pull/27) [`780bca9`](https://github.com/maxa-ondrej/sideline/commit/780bca9d0300030fafd76edc3efd81e5f7a6f88d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Support multiple roles per team member via junction table, with API endpoints to assign and unassign roles

- [#26](https://github.com/maxa-ondrej/sideline/pull/26) [`2b1f4b4`](https://github.com/maxa-ondrej/sideline/commit/2b1f4b460b2d234f026cf658a6b0651f84ef58a9) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add roles and permissions system replacing simple admin/member text role with granular permission-based authorization

- [#25](https://github.com/maxa-ondrej/sideline/pull/25) [`11b920c`](https://github.com/maxa-ondrej/sideline/commit/11b920c61ae409100c9bf09221a23929fdf053ef) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add proper Roster entity with many-to-many team member membership

  Teams can now have multiple named rosters (e.g. per-event). Each roster has a name, active flag, and a set of team members. New API endpoints for full roster CRUD plus add/remove member operations. Player-pool endpoints renamed from /roster/_ to /members/_.

- [#29](https://github.com/maxa-ondrej/sideline/pull/29) [`e8fd1ab`](https://github.com/maxa-ondrej/sideline/commit/e8fd1ab2e0b47aa37fa6ed58e01572d25f90e64d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add subgroups — named groups of team members with associated permissions for fine-grained access control

### Patch Changes

- [#25](https://github.com/maxa-ondrej/sideline/pull/25) [`11b920c`](https://github.com/maxa-ondrej/sideline/commit/11b920c61ae409100c9bf09221a23929fdf053ef) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add admin roster management: team admins can view, edit, and deactivate team members. Adds `active` flag to team_members, roster API endpoints, and `myTeams` auth endpoint.

## 0.1.3

### Patch Changes

- [`8505070`](https://github.com/maxa-ondrej/sideline/commit/850507079ac8e4a9846a34fc365b2c2714ecfa5b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Enable changesets versioning and tagging for private application packages

## 0.1.2

### Patch Changes

- [`744d79a`](https://github.com/maxa-ondrej/sideline/commit/744d79a7e2f827ccfc136e79c2a8b5f5b0872ced) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Decouple NodeFileSystem from Migrator export, allowing consumers to provide their own filesystem layer

## 0.1.1

### Patch Changes

- [#9](https://github.com/maxa-ondrej/sideline/pull/9) [`851b9b2`](https://github.com/maxa-ondrej/sideline/commit/851b9b247e8b5f39db63a7d5c1748f3febc47f5a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Decouple NodeFileSystem from Migrator export, allowing consumers to provide their own filesystem layer

## 0.1.0

### Minor Changes

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

- [#5](https://github.com/maxa-ondrej/sideline/pull/5) [`0458277`](https://github.com/maxa-ondrej/sideline/commit/0458277c509fccaa36fefdc7f2d9a8e9833caa83) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Czech + English i18n support with Paraglide JS, language switcher, persistent user locale, and locale-aware formatting
