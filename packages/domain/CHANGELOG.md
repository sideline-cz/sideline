# @sideline/domain

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
