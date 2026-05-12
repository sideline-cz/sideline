# @sideline/web

## 0.11.1

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

- Updated dependencies [[`91c4c3d`](https://github.com/maxa-ondrej/sideline/commit/91c4c3d073be32833199cbc3c71c5eb6efa195cb)]:
  - @sideline/domain@0.17.1
  - @sideline/i18n@0.3.18

## 0.11.0

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

- Updated dependencies [[`bdc0b0e`](https://github.com/maxa-ondrej/sideline/commit/bdc0b0ed9bcf4de3ca463bf2331a7da931ac5a79), [`9af6d3c`](https://github.com/maxa-ondrej/sideline/commit/9af6d3c99b469f8d50f5fa18c868efc972085e18), [`7422384`](https://github.com/maxa-ondrej/sideline/commit/7422384074804ae42f7ca4b6e4c4ca1d96801b3e), [`40b33ef`](https://github.com/maxa-ondrej/sideline/commit/40b33ef26ec3a4d979e9022b1de0506965f037d0)]:
  - @sideline/domain@0.17.0
  - @sideline/i18n@0.3.17

## 0.10.7

### Patch Changes

- [#242](https://github.com/maxa-ondrej/sideline/pull/242) [`4ee7b70`](https://github.com/maxa-ondrej/sideline/commit/4ee7b7029c76a3a17e19bc902a7284aea076f5b0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix a crash that prevented creating or updating events and event series unless every optional field was filled in. The cross-field validation that links the new "location link" feature to the location text was reading internal Option markers without first checking that the field was present, which threw `TypeError: Cannot read properties of undefined (reading '_tag')` whenever the location link or location text was empty. The check now correctly evaluates each field's state and only rejects payloads that set a location link without a location text.

- Updated dependencies [[`4ee7b70`](https://github.com/maxa-ondrej/sideline/commit/4ee7b7029c76a3a17e19bc902a7284aea076f5b0)]:
  - @sideline/domain@0.16.3
  - @sideline/i18n@0.3.16

## 0.10.6

### Patch Changes

- [#240](https://github.com/maxa-ondrej/sideline/pull/240) [`57cde28`](https://github.com/maxa-ondrej/sideline/commit/57cde28ef0095cc6b309ab3316967f859cd6b1f2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - You can now attach an optional link to an event's location (e.g. Google Maps, venue page). The location text becomes a clickable link on the website and a markdown hyperlink in Discord posts.

- Updated dependencies [[`57cde28`](https://github.com/maxa-ondrej/sideline/commit/57cde28ef0095cc6b309ab3316967f859cd6b1f2)]:
  - @sideline/domain@0.16.2
  - @sideline/i18n@0.3.15

## 0.10.5

### Patch Changes

- [#238](https://github.com/maxa-ondrej/sideline/pull/238) [`2e53d6a`](https://github.com/maxa-ondrej/sideline/commit/2e53d6a4b2a40f222efee89e9a204a66bf33fc4c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - You can now attach a cover image URL to events. Images appear on the event page and as a thumbnail in Discord posts.

- Updated dependencies [[`2e53d6a`](https://github.com/maxa-ondrej/sideline/commit/2e53d6a4b2a40f222efee89e9a204a66bf33fc4c)]:
  - @sideline/domain@0.16.1
  - @sideline/i18n@0.3.14

## 0.10.4

### Patch Changes

- Updated dependencies [[`cb91dc7`](https://github.com/maxa-ondrej/sideline/commit/cb91dc72b9f471511d96ac5604e086a60f4193f5)]:
  - @sideline/domain@0.16.0
  - @sideline/i18n@0.3.13

## 0.10.3

### Patch Changes

- [#232](https://github.com/maxa-ondrej/sideline/pull/232) [`ee68d21`](https://github.com/maxa-ondrej/sideline/commit/ee68d215ab1a26accc771119c3249b99aa6c9c71) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Improve the reminders feature: configurable reminder time and timezone (per-team), dedicated reminders channel, member-group-aware audience and role mentions, and a new "Starting now" announcement when an event begins.

  Team settings now expose `rsvpReminderDaysBefore`, `rsvpReminderTime` (HH:MM, capped at 23:54 to avoid midnight wrap), `timezone` (any IANA zone, default `Europe/Prague`), and `remindersChannelId`. Reminders fire at the configured time in the team's timezone with a 5-minute tolerance window. The reminder embed and the new "Starting now" post target the reminders channel (falling back to the owner-group channel, then the guild's system channel) and mention the event's member-group role. The reminder's "Going" and "Not yet responded" lists are filtered to the member group when one is set.

- [#227](https://github.com/maxa-ondrej/sideline/pull/227) [`13f887c`](https://github.com/maxa-ondrej/sideline/commit/13f887ced827ab2425a279da00281b183c15a1ea) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Documentation and Report a bug links to the user menu in the web navigation sidebar. Both open in a new tab: Documentation points to the hosted Starlight docs, Report a bug opens a fresh GitHub issue.

- Updated dependencies [[`ee68d21`](https://github.com/maxa-ondrej/sideline/commit/ee68d215ab1a26accc771119c3249b99aa6c9c71), [`13f887c`](https://github.com/maxa-ondrej/sideline/commit/13f887ced827ab2425a279da00281b183c15a1ea)]:
  - @sideline/domain@0.15.6
  - @sideline/i18n@0.3.12

## 0.10.2

### Patch Changes

- [#197](https://github.com/maxa-ondrej/sideline/pull/197) [`19d94f2`](https://github.com/maxa-ondrej/sideline/commit/19d94f2bb999bd6465b2a41955d7cae1a2dc7135) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Remove RSVP confirmation step on web — clicking Yes/No/Maybe now immediately submits the response, matching the Discord bot behavior

- [#202](https://github.com/maxa-ondrej/sideline/pull/202) [`b669fed`](https://github.com/maxa-ondrej/sideline/commit/b669fedf293e95575e8488f91687ae94a24ce5a0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Show attendees list on web even after event has started — the RSVP panel now remains visible for started events (with RSVP buttons hidden)

- Updated dependencies [[`b64c794`](https://github.com/maxa-ondrej/sideline/commit/b64c794005a3249889ea374f4ef13e9419fea6a9), [`19d94f2`](https://github.com/maxa-ondrej/sideline/commit/19d94f2bb999bd6465b2a41955d7cae1a2dc7135), [`d2d3eb6`](https://github.com/maxa-ondrej/sideline/commit/d2d3eb666c115009d1d24d1d4c80071633ba2e38), [`0704c17`](https://github.com/maxa-ondrej/sideline/commit/0704c17897ced04f67ee10a7ed65cd0ec51f74d7)]:
  - @sideline/domain@0.15.3
  - @sideline/i18n@0.3.10

## 0.10.1

### Patch Changes

- [#189](https://github.com/maxa-ondrej/sideline/pull/189) [`bfbc107`](https://github.com/maxa-ondrej/sideline/commit/bfbc107dae79520fc5801792b5aede8f05ed4e83) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Remove RSVP buttons from Discord event messages after an event starts and mark events as started via a new cron job.

- [#190](https://github.com/maxa-ondrej/sideline/pull/190) [`e62b7c8`](https://github.com/maxa-ondrej/sideline/commit/e62b7c83223ae2dd7790f62f47bab8262769d02f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix "Invalid date" crash on training type detail page caused by PostgreSQL TIME columns returning HH:mm:ss format, which broke utcTimeToLocal when it appended :00Z.

- [#188](https://github.com/maxa-ondrej/sideline/pull/188) [`12fb74d`](https://github.com/maxa-ondrej/sideline/commit/12fb74d22d5c0c118dc803bc6cbbdfd3faeb9271) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add searchable select component with search filtering and alphabetical sorting to all dynamic select boxes (channels, groups, members, roles, training types) across the web app.

- Updated dependencies [[`9e6a3ea`](https://github.com/maxa-ondrej/sideline/commit/9e6a3ea57fffc2207ef32f2594476f437566771c), [`16192c7`](https://github.com/maxa-ondrej/sideline/commit/16192c762bbef950c6eb587a74c5925cec954cf3), [`c0ec370`](https://github.com/maxa-ondrej/sideline/commit/c0ec3701d6b72c2a0dbba3d216041fd4f1342f41), [`bfbc107`](https://github.com/maxa-ondrej/sideline/commit/bfbc107dae79520fc5801792b5aede8f05ed4e83), [`12fb74d`](https://github.com/maxa-ondrej/sideline/commit/12fb74d22d5c0c118dc803bc6cbbdfd3faeb9271)]:
  - @sideline/domain@0.15.2
  - @sideline/i18n@0.3.9

## 0.10.0

### Minor Changes

- [#178](https://github.com/maxa-ondrej/sideline/pull/178) [`24174e9`](https://github.com/maxa-ondrej/sideline/commit/24174e90b31d73c8bf5f5181a087a41c3289ae54) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add late RSVP notifications: when a member responds after the reminder is sent, post a notification to a configurable team channel and show a polite hint in the RSVP confirmation. Also include the list of yes attendees in the reminder embed.

### Patch Changes

- [#180](https://github.com/maxa-ondrej/sideline/pull/180) [`0bd7e64`](https://github.com/maxa-ondrej/sideline/commit/0bd7e64c932b435ca0afdc052b5e9a2aa2451304) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix event series time display and storage: convert local times to UTC on submit and UTC back to local on display/edit.

- Updated dependencies [[`24174e9`](https://github.com/maxa-ondrej/sideline/commit/24174e90b31d73c8bf5f5181a087a41c3289ae54)]:
  - @sideline/domain@0.15.0
  - @sideline/i18n@0.3.7

## 0.9.4

### Patch Changes

- [`ecdebf6`](https://github.com/maxa-ondrej/sideline/commit/ecdebf6dbac861b9ddb133ab6f1bba54ebc79b96) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Redirect to home page when the last saved team no longer exists instead of navigating to a 404

## 0.9.3

### Patch Changes

- [`a5b5aea`](https://github.com/maxa-ondrej/sideline/commit/a5b5aea8aecab3f572a92d6c64ce929861983bc9) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Redirect to home page after completing profile instead of prompting to create a team

## 0.9.2

### Patch Changes

- [#153](https://github.com/maxa-ondrej/sideline/pull/153) [`690c5c0`](https://github.com/maxa-ondrej/sideline/commit/690c5c0be363ef1461e74a20ad0545ba140282db) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add 3-mode Discord channel cleanup (nothing, delete, archive) with separate settings for groups and rosters

- [#150](https://github.com/maxa-ondrej/sideline/pull/150) [`2820c4a`](https://github.com/maxa-ondrej/sideline/commit/2820c4ad2d2773aee3240c98ef7adc508851d680) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix calendar components to use the app's selected language instead of browser locale

- [#168](https://github.com/maxa-ondrej/sideline/pull/168) [`2284bea`](https://github.com/maxa-ondrej/sideline/commit/2284bea83d34f7f93768457ca401fc45dfe6d4e2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Display Discord channels as clickable links that open the actual channel in Discord

- [#154](https://github.com/maxa-ondrej/sideline/pull/154) [`883189a`](https://github.com/maxa-ondrej/sideline/commit/883189a4c56c2da0c2dcf92544bb72445bbc343a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add configurable Discord channel/role name format templates to team settings

- [#169](https://github.com/maxa-ondrej/sideline/pull/169) [`1e8def9`](https://github.com/maxa-ondrej/sideline/commit/1e8def9790e7b31c9eb15faf81c71641d69e9d2d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add color and emoji support to groups and rosters with Discord role sync

- [#149](https://github.com/maxa-ondrej/sideline/pull/149) [`34785f7`](https://github.com/maxa-ondrej/sideline/commit/34785f7d59bdf4116e70ca8f0cbc4991564cab25) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Open Graph and Twitter Card meta tags for rich link preview embeds on Discord, Slack, Twitter, and other platforms

- [#152](https://github.com/maxa-ondrej/sideline/pull/152) [`c2c0b8a`](https://github.com/maxa-ondrej/sideline/commit/c2c0b8a6ce767f1238c164cbf3725744160bc774) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Redesign profile editing page to match profile complete page UI with card-based centered layout

- [#146](https://github.com/maxa-ondrej/sideline/pull/146) [`b871b3c`](https://github.com/maxa-ondrej/sideline/commit/b871b3c3def2b9eb2397a2072e88eb99d9c87170) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add discord channel linking to rosters with auto-creation, role management, and web UI

- Updated dependencies [[`690c5c0`](https://github.com/maxa-ondrej/sideline/commit/690c5c0be363ef1461e74a20ad0545ba140282db), [`2284bea`](https://github.com/maxa-ondrej/sideline/commit/2284bea83d34f7f93768457ca401fc45dfe6d4e2), [`883189a`](https://github.com/maxa-ondrej/sideline/commit/883189a4c56c2da0c2dcf92544bb72445bbc343a), [`1e8def9`](https://github.com/maxa-ondrej/sideline/commit/1e8def9790e7b31c9eb15faf81c71641d69e9d2d), [`b871b3c`](https://github.com/maxa-ondrej/sideline/commit/b871b3c3def2b9eb2397a2072e88eb99d9c87170)]:
  - @sideline/domain@0.14.3
  - @sideline/i18n@0.3.5

## 0.9.1

### Patch Changes

- [#140](https://github.com/maxa-ondrej/sideline/pull/140) [`247fa44`](https://github.com/maxa-ondrej/sideline/commit/247fa444ad52fc44796e54ac9231a73221c29ff0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team setting to control whether Discord channels are auto-created for new groups

- [#141](https://github.com/maxa-ondrej/sideline/pull/141) [`e4f8969`](https://github.com/maxa-ondrej/sideline/commit/e4f8969bcaf1278169e6e5a6aa2b3af49701ec78) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix incorrect permissions: add group:manage permission, gate nav items by role, fix avatar rendering and drawer padding

- [#136](https://github.com/maxa-ondrej/sideline/pull/136) [`dc1ed99`](https://github.com/maxa-ondrej/sideline/commit/dc1ed99d334839bddf17636b48e525b665321a18) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add comprehensive observability with tracing spans, metrics (HTTP, cron, Discord, sync, RSVP), and improve error handling with explicit catchTag patterns and descriptive LogicError messages

- [#144](https://github.com/maxa-ondrej/sideline/pull/144) [`126d784`](https://github.com/maxa-ondrej/sideline/commit/126d7848dd926d5ae8f285cdff335a9af6f56d0d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add owner group authorization for training type event creation and enhance list page with group selectors

- Updated dependencies [[`247fa44`](https://github.com/maxa-ondrej/sideline/commit/247fa444ad52fc44796e54ac9231a73221c29ff0), [`e4f8969`](https://github.com/maxa-ondrej/sideline/commit/e4f8969bcaf1278169e6e5a6aa2b3af49701ec78)]:
  - @sideline/domain@0.14.2
  - @sideline/i18n@0.3.4

## 0.9.0

### Minor Changes

- [#128](https://github.com/maxa-ondrej/sideline/pull/128) [`b629285`](https://github.com/maxa-ondrej/sideline/commit/b629285a4bfa1e7ff277f5257045bbaf6196148e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Improve website design: dark mode toggle, sidebar sections, hero page, RSVP side panel, leaderboard redesign, workout layout, team logo in switcher, and calendar subscription consistency

### Patch Changes

- [#131](https://github.com/maxa-ondrej/sideline/pull/131) [`0d1567e`](https://github.com/maxa-ondrej/sideline/commit/0d1567eb18fd472e24bc40ac01238c8c6395a983) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Auto-join users to existing teams matching their Discord guilds after profile completion

- [#130](https://github.com/maxa-ondrej/sideline/pull/130) [`d689595`](https://github.com/maxa-ondrej/sideline/commit/d6895955ebb2f1a8de72fdf6d18e9035ee022eee) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add success toast notifications to all user actions and fix runtime to decouple loading/success toasts

- Updated dependencies [[`0d1567e`](https://github.com/maxa-ondrej/sideline/commit/0d1567eb18fd472e24bc40ac01238c8c6395a983), [`d689595`](https://github.com/maxa-ondrej/sideline/commit/d6895955ebb2f1a8de72fdf6d18e9035ee022eee), [`b629285`](https://github.com/maxa-ondrej/sideline/commit/b629285a4bfa1e7ff277f5257045bbaf6196148e)]:
  - @sideline/domain@0.14.1
  - @sideline/i18n@0.3.3

## 0.8.0

### Minor Changes

- [#125](https://github.com/maxa-ondrej/sideline/pull/125) [`4a471dc`](https://github.com/maxa-ondrej/sideline/commit/4a471dc4bc0000168c25fef000ded1ecfd11fd09) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add responsive design and PWA support for mobile devices. Auto-close sidebar on navigation, sticky header, responsive table-to-card layouts, touch target optimization, PWA manifest with service worker, and install prompt.

- [#123](https://github.com/maxa-ondrej/sideline/pull/123) [`8d97865`](https://github.com/maxa-ondrej/sideline/commit/8d978654612cab81032e51a3e602ddcf07918ac0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team profile settings (name, description, sport, logo URL) with new API endpoints, card-based settings page, and Discord channel configuration UI improvements

### Patch Changes

- Updated dependencies [[`4a471dc`](https://github.com/maxa-ondrej/sideline/commit/4a471dc4bc0000168c25fef000ded1ecfd11fd09), [`8d97865`](https://github.com/maxa-ondrej/sideline/commit/8d978654612cab81032e51a3e602ddcf07918ac0)]:
  - @sideline/i18n@0.3.2
  - @sideline/domain@0.14.0

## 0.7.0

### Minor Changes

- [#121](https://github.com/maxa-ondrej/sideline/pull/121) [`737817d`](https://github.com/maxa-ondrej/sideline/commit/737817d36047e914a30f2d2c54b2220b96de21c5) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team leaderboard with activity rankings, streaks, web page, and Discord command

- [#122](https://github.com/maxa-ondrej/sideline/pull/122) [`683e8cb`](https://github.com/maxa-ondrej/sideline/commit/683e8cb3e0098fe2802cab6140f5986707d55136) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add personalized dashboard as the team home page with upcoming events, awaiting RSVP, activity summary, and team management widgets

### Patch Changes

- Updated dependencies [[`737817d`](https://github.com/maxa-ondrej/sideline/commit/737817d36047e914a30f2d2c54b2220b96de21c5), [`683e8cb`](https://github.com/maxa-ondrej/sideline/commit/683e8cb3e0098fe2802cab6140f5986707d55136)]:
  - @sideline/domain@0.13.0
  - @sideline/i18n@0.3.1

## 0.6.0

### Minor Changes

- [#117](https://github.com/maxa-ondrej/sideline/pull/117) [`1d39492`](https://github.com/maxa-ondrej/sideline/commit/1d394922570fb268808b92b0ceacd555048cc35a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace hardcoded activity types with a global activity_types table, auto-track training attendance via cron after events end, and switch stats to dynamic counts

- [#116](https://github.com/maxa-ondrej/sideline/pull/116) [`0fb3acd`](https://github.com/maxa-ondrej/sideline/commit/0fb3acd1ebf9afa6fc7b4fc6d9e14d5b786df4f1) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add activity logging via web app with quick-log widget, history page, and edit/delete support

- [#115](https://github.com/maxa-ondrej/sideline/pull/115) [`174013c`](https://github.com/maxa-ondrej/sideline/commit/174013ca0e42655ee261423a0bddcebb894e83d2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add player activity streaks and stats — streak calculation, /makanicko stats Discord command, web profile stats card, and HTTP API endpoint

### Patch Changes

- [#112](https://github.com/maxa-ondrej/sideline/pull/112) [`cfd11e4`](https://github.com/maxa-ondrej/sideline/commit/cfd11e4c639f69d0bffb9fb432edb2478f28f627) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix timezone mismatch between web and Discord by using browser local timezone for event datetime input and display instead of raw UTC

- Updated dependencies [[`1d39492`](https://github.com/maxa-ondrej/sideline/commit/1d394922570fb268808b92b0ceacd555048cc35a), [`c902f5a`](https://github.com/maxa-ondrej/sideline/commit/c902f5aeb9551c43309f3e70134527dd39c5eb49), [`0fb3acd`](https://github.com/maxa-ondrej/sideline/commit/0fb3acd1ebf9afa6fc7b4fc6d9e14d5b786df4f1), [`174013c`](https://github.com/maxa-ondrej/sideline/commit/174013ca0e42655ee261423a0bddcebb894e83d2), [`0fc40b6`](https://github.com/maxa-ondrej/sideline/commit/0fc40b6cb2f3f765e2b65cf2343de39efb53e652)]:
  - @sideline/domain@0.12.0
  - @sideline/i18n@0.3.0

## 0.5.0

### Minor Changes

- [#103](https://github.com/maxa-ondrej/sideline/pull/103) [`79ca632`](https://github.com/maxa-ondrej/sideline/commit/79ca6325566fc6a2c9e37d4551bcea4f6507d03d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add owner/member group assignment to events, event series, and training types for group-based access control and visibility

### Patch Changes

- [#101](https://github.com/maxa-ondrej/sideline/pull/101) [`9584a67`](https://github.com/maxa-ondrej/sideline/commit/9584a6700fa5dcc86d1ccfed5ed44c07db9f3570) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Hide UI elements from users without required permissions (role and roster management buttons, admin sidebar links, events page for non-admins)

- Updated dependencies [[`79ca632`](https://github.com/maxa-ondrej/sideline/commit/79ca6325566fc6a2c9e37d4551bcea4f6507d03d), [`5d2979f`](https://github.com/maxa-ondrej/sideline/commit/5d2979f3ee666d24b461994e2ddb51abd2ce7017), [`9584a67`](https://github.com/maxa-ondrej/sideline/commit/9584a6700fa5dcc86d1ccfed5ed44c07db9f3570)]:
  - @sideline/domain@0.11.0
  - @sideline/i18n@0.2.1

## 0.4.0

### Minor Changes

- [#98](https://github.com/maxa-ondrej/sideline/pull/98) [`c12900d`](https://github.com/maxa-ondrej/sideline/commit/c12900da82a09999081325bccbb29a39f93f3215) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add iCal subscription feature allowing players to subscribe to team events via webcal URL in Google Calendar, Apple Calendar, and Outlook

### Patch Changes

- [#88](https://github.com/maxa-ondrej/sideline/pull/88) [`3b20ab1`](https://github.com/maxa-ondrej/sideline/commit/3b20ab1ed4d61dffc0d136d6ee6a055672e65788) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add client-side age validation with localized error message and preselect birth year to 18 years ago in date picker

- [#94](https://github.com/maxa-ondrej/sideline/pull/94) [`3c51350`](https://github.com/maxa-ondrej/sideline/commit/3c51350f4f069f12241369ffe027471079c3b7f6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Set calendar date picker week start to Monday

- [#91](https://github.com/maxa-ondrej/sideline/pull/91) [`dbe2a0b`](https://github.com/maxa-ondrej/sideline/commit/dbe2a0b480314845e45bcae95ea100ce0d06cf25) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace plain string dates with proper DateTime.Utc types throughout the stack

- [#92](https://github.com/maxa-ondrej/sideline/pull/92) [`fe5c2ac`](https://github.com/maxa-ondrej/sideline/commit/fe5c2ac0acd4b9d3ad39baf7961e2127373a6d47) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Disable name editing for built-in roles to prevent rejected save attempts

- [#93](https://github.com/maxa-ondrej/sideline/pull/93) [`7fe506e`](https://github.com/maxa-ondrej/sideline/commit/7fe506e367762bd084ca1d5c7d8604b48efd5c62) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Move Save changes button to bottom of team settings page so it clearly applies to all fields

- [#89](https://github.com/maxa-ondrej/sideline/pull/89) [`4d2ce92`](https://github.com/maxa-ondrej/sideline/commit/4d2ce92b94498e0683756fb4e1439cda51001abc) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Use Discord.Snowflake branded type across the entire stack, remove catchAll on unfailable effects, and refactor repository methods to use destructuring with default values

- [#84](https://github.com/maxa-ondrej/sideline/pull/84) [`b1d7909`](https://github.com/maxa-ondrej/sideline/commit/b1d79090d6d9b001f6fe2b60341c7862c709be91) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Improve client error handling with loading/success/error toast transitions, rich colors, close button, and top-right positioning

- Updated dependencies [[`3b20ab1`](https://github.com/maxa-ondrej/sideline/commit/3b20ab1ed4d61dffc0d136d6ee6a055672e65788), [`dbe2a0b`](https://github.com/maxa-ondrej/sideline/commit/dbe2a0b480314845e45bcae95ea100ce0d06cf25), [`b49b814`](https://github.com/maxa-ondrej/sideline/commit/b49b814c7166d2ae2d95b00a95ec87a55cb8e9b6), [`c12900d`](https://github.com/maxa-ondrej/sideline/commit/c12900da82a09999081325bccbb29a39f93f3215), [`3b16731`](https://github.com/maxa-ondrej/sideline/commit/3b1673170ea6bb9b44b298fc3566415f016ea654), [`4d2ce92`](https://github.com/maxa-ondrej/sideline/commit/4d2ce92b94498e0683756fb4e1439cda51001abc), [`0230c98`](https://github.com/maxa-ondrej/sideline/commit/0230c98db317f20800485a0ad758020236ff2f77), [`38381e3`](https://github.com/maxa-ondrej/sideline/commit/38381e3695b8d2d5fc6704df9dfa8d29e55e2e0a), [`381d85d`](https://github.com/maxa-ondrej/sideline/commit/381d85d6f47deb87f68bcebd5a266e0f29bb71f3), [`38381e3`](https://github.com/maxa-ondrej/sideline/commit/38381e3695b8d2d5fc6704df9dfa8d29e55e2e0a)]:
  - @sideline/i18n@0.2.0
  - @sideline/domain@0.10.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`7dccd31`](https://github.com/maxa-ondrej/sideline/commit/7dccd31fe72f0063e7092cc4e762698b32a83e34), [`f21c610`](https://github.com/maxa-ondrej/sideline/commit/f21c61061b8b67faa87a2cadfec3f728603cae1f), [`f71d644`](https://github.com/maxa-ondrej/sideline/commit/f71d644aff2f4d181986b1510467577adb14fadc), [`5d55e46`](https://github.com/maxa-ondrej/sideline/commit/5d55e463e6be04b01ac87377825a2372caa2713f), [`5d55e46`](https://github.com/maxa-ondrej/sideline/commit/5d55e463e6be04b01ac87377825a2372caa2713f)]:
  - @sideline/domain@0.9.0
  - @sideline/i18n@0.1.2

## 0.3.0

### Minor Changes

- [#73](https://github.com/maxa-ondrej/sideline/pull/73) [`bbaec4d`](https://github.com/maxa-ondrej/sideline/commit/bbaec4d84940ca8aad14ac650ea6214b3e6ee645) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Rename discord_username/discord_avatar to username/avatar across the codebase and fix RSVP member name display to fall back to username

### Patch Changes

- Updated dependencies [[`bbaec4d`](https://github.com/maxa-ondrej/sideline/commit/bbaec4d84940ca8aad14ac650ea6214b3e6ee645)]:
  - @sideline/domain@0.8.0

## 0.2.2

### Patch Changes

- Updated dependencies [[`ca6db57`](https://github.com/maxa-ondrej/sideline/commit/ca6db57efc94442f6a690322ea1ae52355e1d903)]:
  - @sideline/i18n@0.1.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`7c483c5`](https://github.com/maxa-ondrej/sideline/commit/7c483c5a68b9ebf115ccd141d487e334fdee4c2e)]:
  - @sideline/domain@0.7.0

## 0.2.0

### Minor Changes

- [#55](https://github.com/maxa-ondrej/sideline/pull/55) [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add configurable Discord channel targeting for events at three levels: per-event/series, per-training-type default, and per-event-type in team settings

### Patch Changes

- [#53](https://github.com/maxa-ondrej/sideline/pull/53) [`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add edit UI for recurring schedules and change event ordering to ascending

- [#54](https://github.com/maxa-ondrej/sideline/pull/54) [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add RSVP feature for team events — players can respond Yes/No/Maybe with optional message via web app

- Updated dependencies [[`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0), [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75), [`a2b503c`](https://github.com/maxa-ondrej/sideline/commit/a2b503ce5e7dce8835af0182fa3c8e7242c98355), [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f), [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75), [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75), [`a2b503c`](https://github.com/maxa-ondrej/sideline/commit/a2b503ce5e7dce8835af0182fa3c8e7242c98355), [`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0), [`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0), [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f)]:
  - @sideline/domain@0.6.0

## 0.1.9

### Patch Changes

- [`90b50bb`](https://github.com/maxa-ondrej/sideline/commit/90b50bbf8317901cedaa7cda8216ecef12be9acc) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Patch bump all applications

## 0.1.8

### Patch Changes

- Updated dependencies [[`bdacd74`](https://github.com/maxa-ondrej/sideline/commit/bdacd74ce3ef5900ba18b266ef4836b284059428), [`bdacd74`](https://github.com/maxa-ondrej/sideline/commit/bdacd74ce3ef5900ba18b266ef4836b284059428), [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd), [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd), [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd), [`74544b4`](https://github.com/maxa-ondrej/sideline/commit/74544b4ede8dde9539bcb5c76c25afda279d883b)]:
  - @sideline/domain@0.5.0

## 0.1.7

### Patch Changes

- Updated dependencies [[`3a2daa7`](https://github.com/maxa-ondrej/sideline/commit/3a2daa77509b9a1066c48b78e94697db7609e3d6), [`eb7fdf3`](https://github.com/maxa-ondrej/sideline/commit/eb7fdf3c4607770baf78df856f450f5f303fdc9f), [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb), [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb), [`0c98f29`](https://github.com/maxa-ondrej/sideline/commit/0c98f291ee6168e73077feec4cdbc89f0ccdfd3f)]:
  - @sideline/domain@0.4.0

## 0.1.6

### Patch Changes

- Updated dependencies [[`eed4aa3`](https://github.com/maxa-ondrej/sideline/commit/eed4aa3820c6bbad12ff2292bcc92aee5a7460b9)]:
  - @sideline/domain@0.3.0

## 0.1.5

### Patch Changes

- Updated dependencies [[`11b920c`](https://github.com/maxa-ondrej/sideline/commit/11b920c61ae409100c9bf09221a23929fdf053ef), [`2b1f4b4`](https://github.com/maxa-ondrej/sideline/commit/2b1f4b460b2d234f026cf658a6b0651f84ef58a9), [`780bca9`](https://github.com/maxa-ondrej/sideline/commit/780bca9d0300030fafd76edc3efd81e5f7a6f88d), [`2b1f4b4`](https://github.com/maxa-ondrej/sideline/commit/2b1f4b460b2d234f026cf658a6b0651f84ef58a9), [`11b920c`](https://github.com/maxa-ondrej/sideline/commit/11b920c61ae409100c9bf09221a23929fdf053ef), [`e8fd1ab`](https://github.com/maxa-ondrej/sideline/commit/e8fd1ab2e0b47aa37fa6ed58e01572d25f90e64d)]:
  - @sideline/domain@0.2.0

## 0.1.4

### Patch Changes

- [`894c836`](https://github.com/maxa-ondrej/sideline/commit/894c836d65dc885a94d25d4f280c04c74b4866d0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Simplify version extraction in Docker release workflow

## 0.1.3

### Patch Changes

- [`79f2e9e`](https://github.com/maxa-ondrej/sideline/commit/79f2e9e7271e5ab82acdcff1b72f2e2a3b77f59f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix Docker build: add BuildKit setup and version-based image tags

## 0.1.2

### Patch Changes

- [`e1389ba`](https://github.com/maxa-ondrej/sideline/commit/e1389ba855a70a285581639d349908570456659c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Build and push Docker images for changed applications as part of the release workflow

## 0.1.1

### Patch Changes

- [`8505070`](https://github.com/maxa-ondrej/sideline/commit/850507079ac8e4a9846a34fc365b2c2714ecfa5b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Enable changesets versioning and tagging for private application packages

- Updated dependencies [[`8505070`](https://github.com/maxa-ondrej/sideline/commit/850507079ac8e4a9846a34fc365b2c2714ecfa5b)]:
  - @sideline/domain@0.1.1
