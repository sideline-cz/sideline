# @sideline/bot

## 0.30.3

### Patch Changes

- [#488](https://github.com/maxa-ondrej/sideline/pull/488) [`0509f78`](https://github.com/maxa-ondrej/sideline/commit/0509f78d3f546f6f21db55d38003f98b8b695b9b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix the `/event`-create modal hanging on "Sideline is thinking…" when event creation fails in the background fork with an untagged defect. The detached fork that resolves the deferred ephemeral reply now has a `catchCause` backstop (mirroring the profile-complete handler) that always updates the original webhook message, so a server-side defect (e.g. a `LogicError.die` surfaced from the `Event/CreateEvent` RPC) can no longer leave the interaction unresolved. Adds handler-level tests covering the success and defect paths.

- [#490](https://github.com/maxa-ondrej/sideline/pull/490) [`0893574`](https://github.com/maxa-ondrej/sideline/commit/0893574bff3e2c9335c0fdadf31cccaef05bf1f5) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Close the remaining `/event`-create failure path where a malformed input (event type, snowflake, or training-type id) could kill the modal handler with "This interaction failed". The `decodeUnknownSync` calls previously ran eagerly in the handler body — before the deferred reply was forked — so a decode throw escaped the `catchCause` backstop. They now run inside an `Effect.suspend` on the forked fiber, so any decode failure becomes a defect the backstop resolves with the generic error message. Adds a regression test for the malformed-event-type path.

- [#494](https://github.com/maxa-ondrej/sideline/pull/494) [`0d576b0`](https://github.com/maxa-ondrej/sideline/commit/0d576b0069a968b71aab623126ea6caf2db56f0b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Brand the `team_member_id` fields in the PersonalEvents and Guild RPC groups as `TeamMember.TeamMemberId` instead of raw `Schema.String` (14 fields across request payloads and success responses). This lets the server RPC handlers drop their two `Schema.decodeSync(TeamMember.TeamMemberId)` helpers and 9 per-call-site decodes — the decoded payload is now branded end-to-end — and removes a latent brand-stripping `String(...)` coercion in `IdentifyEventsChannel`. The bot's personal-channel reconcile/reorder types are branded to match so the ids flow through without widening. The brand is refinement-free so the wire format is unchanged; this is a type-safety tightening with no runtime or protocol change.

- Updated dependencies [[`0d576b0`](https://github.com/maxa-ondrej/sideline/commit/0d576b0069a968b71aab623126ea6caf2db56f0b)]:
  - @sideline/domain@0.37.2

## 0.30.2

### Patch Changes

- [#486](https://github.com/maxa-ondrej/sideline/pull/486) [`95e4fc9`](https://github.com/maxa-ondrej/sideline/commit/95e4fc9c85029a67520a943bd99cb191d7657405) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add an admin "Remove option" button to polls. Captains/admins can remove one or
  more options from an open poll via an ephemeral select menu; votes for removed
  options are deleted and the remaining options are renumbered so their letters stay
  contiguous. A poll always keeps at least two options.
- Updated dependencies [[`95e4fc9`](https://github.com/maxa-ondrej/sideline/commit/95e4fc9c85029a67520a943bd99cb191d7657405)]:
  - @sideline/domain@0.37.1
  - @sideline/i18n@0.18.2

## 0.30.1

### Patch Changes

- [#472](https://github.com/maxa-ondrej/sideline/pull/472) [`88af047`](https://github.com/maxa-ondrej/sideline/commit/88af047906ad2085afe109a599e9a735308e5f1f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Build the `/complete` profile modal with dfx `UI.row`/`UI.textInput` builders instead of raw component object literals, and replace magic-number text-input `style:` values with the `TextInputStyleTypes` enum in the `/complete` and `/event create` modals. Adds a shape-regression test for the `/complete` modal. Behavior-preserving (identical Discord API payload).

- [#468](https://github.com/maxa-ondrej/sideline/pull/468) [`77aff73`](https://github.com/maxa-ondrej/sideline/commit/77aff73f96fc38d0b6956f0bd80e1520d4871be5) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Model raw dfx Discord REST failures as semantic tagged Effect errors and eliminate ad-hoc casts. New `~/rest/discordErrors.ts` tagged errors (`DiscordPermissionError` / `DiscordNotFoundError` / `DiscordPermanentError` / `DiscordTransientError`) with a total `toDiscordError` mapper and `failAsDiscordError` combinator, so command/component handlers branch with `Effect.catchTag` instead of re-inlining `err.response.status === 403 || err.data.code === 50013` checks. `summon`, `summarize`, and `carpool` now use the tagged errors. Cast-free shape-probing primitives (`isRecord` / `asRecord` / `numberProp`) extracted to `~/rest/recordProbe.ts`, removing `value as Record<string, unknown>` / `record[key] as number` casts from `discordErrors.ts`, `Bot.ts`, and `rcp/channel/ProcessorService.ts`. The permanent/transient classifier (`isPermanentError`) now lives in `discordErrors.ts` (re-exported from `ProcessorService.ts`), sharing one source of truth with the mapper. No behavior change.

- [#473](https://github.com/maxa-ondrej/sideline/pull/473) [`88db415`](https://github.com/maxa-ondrej/sideline/commit/88db415533f144170dd3e9f3c35d01076e10a905) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace magic-number button `style:` literals with the `Discord.ButtonStyleTypes` enum across the `rest/events/*` embed/message builders (buildEventEmbed, buildEventListEmbed, buildClaimMessage, buildAttendeesEmbed, buildRosterApprovalMessage), matching the existing buildUpcomingEventEmbed convention. Behavior-preserving (identical Discord API payload).

- [#475](https://github.com/maxa-ondrej/sideline/pull/475) [`d4485ef`](https://github.com/maxa-ondrej/sideline/commit/d4485ef9d4bce9cc7d7a91f12d2156ce931fcbd6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace magic-number `style:` literals with dfx enums across the `interactions/*` handlers (carpool, poll, roster-approval, rsvp, upcoming-rsvp, email-approval). Button styles use `ButtonStyleTypes` and text-input styles use `TextInputStyleTypes`, each mapped per its kind (the same integer means different things on a button vs a modal text input). Behavior-preserving (identical Discord API payload).

- [#471](https://github.com/maxa-ondrej/sideline/pull/471) [`ce758f5`](https://github.com/maxa-ondrej/sideline/commit/ce758f5cffd59995a5ae7b36b00eba9ed57347d8) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Eliminate remaining `as` casts in bot personalEvents/event/carpool: replace `Snowflake` casts with `Discord.Snowflake.makeUnsafe`, use explicit `Option` type args instead of widening casts, and drop redundant no-op `InteractionCallbackTypes` enum self-casts.

- [#470](https://github.com/maxa-ondrej/sideline/pull/470) [`56f5b52`](https://github.com/maxa-ondrej/sideline/commit/56f5b52810526d8f5b8e0744f6456c46e0057267) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - DRY up the RCP sync-event failure handling: extract the identical log-then-metric tail (`Effect.logWarning` + `syncEventsFailedTotal` bump) that ten ProcessorServices ran after marking an event failed into a shared `recordSyncFailure` helper. Each processor's `Effect.catch` now calls `recordSyncFailure(rpc['<Domain>/Mark…Failed']({…}), { syncType, message, error })`; the mark-failed RPC call stays at the call site (its method, id field, and error stringification vary per domain, including the channel processor's permanent/transient branch). No behavior change. inviteGenerator/onboarding (custom counters + classified errors) and personalEvents (no mark-failed path) are intentionally left as-is.

- [#474](https://github.com/maxa-ondrej/sideline/pull/474) [`305ea7f`](https://github.com/maxa-ondrej/sideline/commit/305ea7f025254bf2141f6ff4441e3256bd72722c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace magic-number button `style:` literals with the `Discord.ButtonStyleTypes` enum across the `rest/` poll, email, and carpool builders (buildPollEmbed, buildPollPrivateView, buildEmailEmbeds, buildCarpoolEmbed), including the ternary-derived styles. Behavior-preserving (identical Discord API payload).

- [#469](https://github.com/maxa-ondrej/sideline/pull/469) [`82e8b72`](https://github.com/maxa-ondrej/sideline/commit/82e8b72cdf452147697d5ce4c4380c7e2f00060b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Eliminate the `channel.id as Snowflake` / `role.id as Snowflake` casts across the bot's Discord REST helpers (`rest/channels/*`, `rest/roles/createGuildRole`) by using the sanctioned refinement-free brand constructor `Discord.Snowflake.makeUnsafe(...)` — the same pattern already used for `parent_id`. No behavior change (`makeUnsafe` produces the identical branded value the cast asserted).

- [#476](https://github.com/maxa-ondrej/sideline/pull/476) [`6e4db12`](https://github.com/maxa-ondrej/sideline/commit/6e4db1263ff75910c0eec19d300c003b9969fe99) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace the last magic-number button `style:` literal with `Discord.ButtonStyleTypes.DANGER` in the `/sudo` handler, completing the removal of raw button/text-input style numbers across the bot. Behavior-preserving (identical Discord API payload).

## 0.30.0

### Minor Changes

- [#463](https://github.com/maxa-ondrej/sideline/pull/463) [`d9c0bf8`](https://github.com/maxa-ondrej/sideline/commit/d9c0bf89d61a51d4886fd071293316d138cfd9c0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a `/complete` Discord slash command that lets a team member complete their profile without leaving Discord: it captures name, date of birth, gender, and jersey number. Gender is a native command choice; name, date of birth, and jersey number are collected via a modal. Name, birth date, and gender persist on the user and mark the profile complete (`is_profile_complete = true`, the same as web onboarding); jersey number persists on the team membership. Adds a `Guild/CompleteMemberProfile` RPC with defensive server-side validation and transactional writes, and tightens the shared birth-date schema to strict `YYYY-MM-DD` (rejecting rolled-over dates like `2005-02-30`).

### Patch Changes

- [#462](https://github.com/maxa-ondrej/sideline/pull/462) [`5278a23`](https://github.com/maxa-ondrej/sideline/commit/5278a235314a490c9b22cd645822c6bc15dd8001) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Adopt dfx `UI.*` builders (`UI.row`, `UI.button`, `UI.textInput`, `UI.userSelect`) for Discord message component construction across the bot, replacing hand-built component JSON. Behaviour-preserving refactor — the emitted component payloads (custom ids, styles, labels, disabled flags, urls, placeholders, min/max, required) are unchanged.

- Updated dependencies [[`d9c0bf8`](https://github.com/maxa-ondrej/sideline/commit/d9c0bf89d61a51d4886fd071293316d138cfd9c0)]:
  - @sideline/domain@0.37.0
  - @sideline/i18n@0.18.1

## 0.29.0

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

### Patch Changes

- [#461](https://github.com/maxa-ondrej/sideline/pull/461) [`945371d`](https://github.com/maxa-ondrej/sideline/commit/945371ddd81f8e3cf4febcccd7532bafe1b0ad89) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - fix: name personal-events overflow categories the same as the base category

  When the personal-events category hits Discord's 50-channel limit and the bot
  creates an overflow category, it now reuses the base category's exact name
  instead of appending a ` (N)` sequence suffix.

- Updated dependencies [[`53a8a87`](https://github.com/maxa-ondrej/sideline/commit/53a8a87c7eba97553f21cf554b7a43790ef840a6)]:
  - @sideline/domain@0.36.0

## 0.28.0

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

### Patch Changes

- [#456](https://github.com/maxa-ondrej/sideline/pull/456) [`8e564ed`](https://github.com/maxa-ondrej/sideline/commit/8e564eda0a82cae7641bc63ab2964a3681a7ce9d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - fix: personal-events channel provisioning never spilled into an overflow category

  The category-full detection in `handleProvision` checked for Discord error
  code `30013`, which is not the code Discord returns when a category hits its
  50-channel limit. The real response is `50035` (Invalid Form Body) with a
  nested `parent_id` error `CHANNEL_PARENT_MAX_CHANNELS`. Because the check never
  matched, the overflow-category creation branch was unreachable: members past
  the 50th in a category failed to provision on every poll tick and never got a
  personal channel. Detection now keys on `50035` plus the nested
  `CHANNEL_PARENT_MAX_CHANNELS` sub-code, so an overflow category is created and
  the channel is retried as intended.

- Updated dependencies [[`b970c70`](https://github.com/maxa-ondrej/sideline/commit/b970c70d9fd4e21db28a8d53436c2cfb259a6e8c)]:
  - @sideline/domain@0.35.0

## 0.27.0

### Minor Changes

- [#454](https://github.com/maxa-ondrej/sideline/pull/454) [`d5812ff`](https://github.com/maxa-ondrej/sideline/commit/d5812ff3a9b88433aec2f9d59a392969cca1a95a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a Discord `/sudo` command that lets team admins temporarily elevate to Discord Administrator.
  - `/sudo` is a toggle: an admin running it grants themselves a shared `Sideline Sudo` role (carrying the Discord Administrator permission) and posts an audit entry with a "Leave sudo" button to the team's system channel; running it again while elevated revokes the role.
  - Any admin can press "Leave sudo" to end another admin's session; the audit message is edited to a resolved state showing who was in sudo, who ended it, and — from start to end — how long the session lasted. Non-admins clicking it get an ephemeral denial and the shared message is left untouched.
  - Both exit paths (the "Leave sudo" button and re-running `/sudo`) now close the same audit message and record the duration. A new `sudo_sessions` table persists the active session (audit message location + start time) so either path can find and resolve the message; entries are cleaned up on team deletion.
  - Access is enforced server-side via a new `Guild/CheckTeamAdmin` RPC (resolves the caller's team membership and `team:manage` permission), not via Discord `default_member_permissions` — so the command stays visible to team admins regardless of their Discord-native permissions.
  - The interaction is deferred and the elevation work is forked so Discord's 3-second acknowledgement window is respected; role-assign/revoke permission errors (bot role hierarchy) are surfaced clearly on both exit paths, and a missing system channel still grants sudo with an ephemeral notice (re-run `/sudo` to step down).
  - No auto-expiry in this version: sudo persists until the invoker toggles it off or an admin presses "Leave sudo".

### Patch Changes

- [#453](https://github.com/maxa-ondrej/sideline/pull/453) [`8e6d58f`](https://github.com/maxa-ondrej/sideline/commit/8e6d58f0978051cd2410783e8112e54bcc70cb74) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Move the "Attendees" button to the second action row of the upcoming-event RSVP message

  The Attendees button now shares the second row with the RSVP message buttons (Add/Edit/Clear message) instead of sitting alongside Yes/No/Maybe. The second row always renders the Attendees button — including for members who haven't responded yet — with the message buttons appended when the member has an RSVP.

- Updated dependencies [[`d5812ff`](https://github.com/maxa-ondrej/sideline/commit/d5812ff3a9b88433aec2f9d59a392969cca1a95a), [`61cc064`](https://github.com/maxa-ondrej/sideline/commit/61cc06420c759ef9312abfb0778a9460ebeb6467)]:
  - @sideline/domain@0.34.0
  - @sideline/i18n@0.18.0

## 0.26.0

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

### Patch Changes

- Updated dependencies [[`f30f493`](https://github.com/maxa-ondrej/sideline/commit/f30f4938ebbc8096f8d175f47fd30c0a2032682f)]:
  - @sideline/domain@0.33.0
  - @sideline/i18n@0.17.0

## 0.25.0

### Minor Changes

- [#444](https://github.com/maxa-ondrej/sideline/pull/444) [`a20acad`](https://github.com/maxa-ondrej/sideline/commit/a20acad5dd92081758ce5ae070556f01735d413d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a "Who voted?" button to the `/poll` public board

  Members can now click **👥 Who voted?** on a poll (open or closed) to get an ephemeral message listing each option with the people who voted for it, rendered as `Name (@mention)` without pinging anyone. Backed by a new `Poll/GetPollVoters` RPC and a team-scoped `findPollVoters` query that returns the true per-option vote counts (the displayed voter list is capped at 60 per option, with the remainder shown as "…and N more"). Voter identities are visible to all team members.

### Patch Changes

- Updated dependencies [[`a20acad`](https://github.com/maxa-ondrej/sideline/commit/a20acad5dd92081758ce5ae070556f01735d413d)]:
  - @sideline/domain@0.32.0
  - @sideline/i18n@0.16.1

## 0.24.1

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

- Updated dependencies [[`64488ad`](https://github.com/maxa-ondrej/sideline/commit/64488ad91e4d3859fe79b3ad4900564bda827298), [`0bae4c3`](https://github.com/maxa-ondrej/sideline/commit/0bae4c302b4114adb20e476d5ed2472b7ddb374b), [`defddbd`](https://github.com/maxa-ondrej/sideline/commit/defddbd3ce5650450753aa21c3cc320525ecd815)]:
  - @sideline/domain@0.31.0
  - @sideline/i18n@0.16.0

## 0.24.0

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

- [#436](https://github.com/maxa-ondrej/sideline/pull/436) [`1eb4e9a`](https://github.com/maxa-ondrej/sideline/commit/1eb4e9a3199f38c2613373b40b38c13d4b2bd637) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add an optional `private` flag to `/summarize`

  `/summarize` now takes an optional `private` boolean (default true). Left at the
  default the summary stays ephemeral (only the invoker sees it, as before); set
  `private: false` to post the summary publicly to the channel so the whole team
  can read it. Because Discord's defer flag is fixed for the rest of the
  interaction, the chosen visibility applies to the summary and any post-fetch
  status messages alike; pre-defer input errors (no channel, invalid `since`)
  remain ephemeral regardless. `allowed_mentions` is still cleared in all cases, so
  a public summary never pings anyone. Available in English and Czech.

- Updated dependencies [[`2f92bbc`](https://github.com/maxa-ondrej/sideline/commit/2f92bbc547a1d70c14c1b7641565d7b2c69ee883), [`72f3a3b`](https://github.com/maxa-ondrej/sideline/commit/72f3a3bad411aab4fcd4eeea78fafa9647116e77), [`e61cfd9`](https://github.com/maxa-ondrej/sideline/commit/e61cfd996344ee3f05ce70017b7f491ad5ac7a9a), [`3a85212`](https://github.com/maxa-ondrej/sideline/commit/3a852129456d030bf7fe68f3b7fc633af234fce1), [`1eb4e9a`](https://github.com/maxa-ondrej/sideline/commit/1eb4e9a3199f38c2613373b40b38c13d4b2bd637), [`1eb4e9a`](https://github.com/maxa-ondrej/sideline/commit/1eb4e9a3199f38c2613373b40b38c13d4b2bd637)]:
  - @sideline/domain@0.30.0
  - @sideline/i18n@0.15.0

## 0.23.2

### Patch Changes

- [#430](https://github.com/maxa-ondrej/sideline/pull/430) [`a828d64`](https://github.com/maxa-ondrej/sideline/commit/a828d643a0d8546256146bb86e0571c4fb7f8389) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - fix: downgrade transient sync-poll upstream errors from Error to Warning

  When the server/proxy returned a 502 with a non-JSON body, the bot's NDJSON RPC
  deserializer threw a `SyntaxError` that surfaced as `Sync poll tick failed`
  logged at Error with a full stack, even though the poll loop self-heals on the
  next tick. Poll ticks now classify NDJSON parse failures and 5xx upstream
  responses as transient: they log at Warning and increment
  `syncEventsFailedTotal{sync_type:"poll_tick_transient"}` so a sustained outage
  stays alertable, while genuine errors still log at Error.

- [#429](https://github.com/maxa-ondrej/sideline/pull/429) [`5572d3a`](https://github.com/maxa-ondrej/sideline/commit/5572d3ae9356a5d244fa1bc12e7e50b42e5b4c8e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - fix: channel sync events looping forever on permanent Discord errors

  `isPermanentError` in the channel sync processor read the Discord error code
  and HTTP status from the top level of the error (`e.code` / `e.status`), but
  dfx's `DiscordRestError` nests them at `e.data.code` and `e.response.status`.
  Both reads were therefore `undefined`, so every Discord REST failure — including
  permanent ones like `10007 Unknown Member`, `10008 Unknown Message` and
  `50013 Missing Permissions` — was misclassified as transient and marked
  `MarkEventFailed` (no `processed_at`), causing the event to be re-polled every
  ~5s forever. Fixed to read the nested fields and treat any non-429 4xx plus the
  known Discord error codes as permanent (`MarkEventPermanentlyFailed`), so a
  poison event is acknowledged once instead of looping.

## 0.23.1

### Patch Changes

- [#421](https://github.com/maxa-ondrej/sideline/pull/421) [`cfa325c`](https://github.com/maxa-ondrej/sideline/commit/cfa325c80c44b6701c52383e700d8f602d76d32f) Thanks [@dependabot](https://github.com/apps/dependabot)! - deps: bump the npm group across 1 directory with 27 updates

- Updated dependencies [[`cfa325c`](https://github.com/maxa-ondrej/sideline/commit/cfa325c80c44b6701c52383e700d8f602d76d32f)]:
  - @sideline/i18n@0.14.1

## 0.23.0

### Minor Changes

- [#416](https://github.com/maxa-ondrej/sideline/pull/416) [`39f23d6`](https://github.com/maxa-ondrej/sideline/commit/39f23d6fde5b1d997e22ea8c802def2e41d72141) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a balanced training team generator. Captains and admins (any member with `member:edit`) can generate two balanced teams for a training event based on player Elo ratings, with optional gender-mix weighting, then review, manually swap players, and post the result to Discord.

  The core is a pure, deterministic engine (`TeamGenerator`) that seeds teams via snake-draft and refines them with hill-climbing local search over a normalized weighted cost function (Elo spread, team size, gender distribution), surfacing warnings for uneven team sizes, Elo outliers, and insufficient gender mix. Per-team balancing weights are configurable per team (`team_generation_config` table). The web `TeamGeneratorSection` provides generation, live balance feedback, and accessible select-two-to-swap manual adjustment; the `/training generate` Discord command deep-links to it. Posting to Discord goes through the event-sync outbox (`teams_generated` event) and re-derives all embed content server-side from the trusted roster. MVP ships two teams with an N-ready API and engine.

- [#415](https://github.com/maxa-ondrej/sideline/pull/415) [`30166b5`](https://github.com/maxa-ondrej/sideline/commit/30166b5b0245a31414028d2a8be06a2afdc8ddb7) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add training game result logging. Coaches (any member with `member:edit`) open a training event and split the RSVP-yes attendees into Team A / Team B, then record the winner (Team A / Team B / Draw); multiple games (rounds) can be logged per session. Saving a result applies an incremental Elo update via the existing rating engine — the new game's id is recorded on each `player_rating_history` row — and best-effort auto-logs training attendance for all RSVP-yes members (deduplicated per UTC day). Two new tables (`training_games`, `training_game_participants`) back the feature. The `/training result` Discord command is a convenience deep-link: it replies with an ephemeral link to the web result editor, listing loggable trainings (including just-finished ones) via the new `Event/GetLoggableTrainingEvents` RPC. Logged games are immutable for now.

### Patch Changes

- Updated dependencies [[`bf0716c`](https://github.com/maxa-ondrej/sideline/commit/bf0716cd86155c06bf0ca16b8207ba5e30f86e4e), [`51f1048`](https://github.com/maxa-ondrej/sideline/commit/51f1048a4182556c315ee4b278253b8f597a2d32), [`dd91e63`](https://github.com/maxa-ondrej/sideline/commit/dd91e634678c34742ca8224fb7c9c9ced1c098f0), [`39f23d6`](https://github.com/maxa-ondrej/sideline/commit/39f23d6fde5b1d997e22ea8c802def2e41d72141), [`30166b5`](https://github.com/maxa-ondrej/sideline/commit/30166b5b0245a31414028d2a8be06a2afdc8ddb7)]:
  - @sideline/domain@0.29.0
  - @sideline/i18n@0.14.0

## 0.22.2

### Patch Changes

- [#405](https://github.com/maxa-ondrej/sideline/pull/405) [`ff0a8aa`](https://github.com/maxa-ondrej/sideline/commit/ff0a8aa32b3bed9235110368a6de7fb77abbeb2f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix the original/detailed email preview buttons hanging on a perpetual "loading" state for very large emails. The ephemeral interaction is now always resolved even when fetching/rendering fails, and oversized email bodies are capped at 20 pages with a truncation notice (plus a Sideline deep link when configured).

- Updated dependencies [[`ff0a8aa`](https://github.com/maxa-ondrej/sideline/commit/ff0a8aa32b3bed9235110368a6de7fb77abbeb2f), [`57b267f`](https://github.com/maxa-ondrej/sideline/commit/57b267f2ba806dc0e3cf0ac8c91d0e4145631b12)]:
  - @sideline/i18n@0.13.0
  - @sideline/domain@0.28.0

## 0.22.1

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

- Updated dependencies [[`1681e50`](https://github.com/maxa-ondrej/sideline/commit/1681e5075b9f824075fcda935bd3dcf5b5a65410), [`717bf0c`](https://github.com/maxa-ondrej/sideline/commit/717bf0c90f40c933951532327df4a5211311d0b2)]:
  - @sideline/domain@0.27.1
  - @sideline/i18n@0.12.5

## 0.22.0

### Minor Changes

- [#399](https://github.com/maxa-ondrej/sideline/pull/399) [`58b7a5a`](https://github.com/maxa-ondrej/sideline/commit/58b7a5aa2954faa5925bdcf0f3e9334b5d102d2e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Link a tournament event to a real roster with a per-pair auto-approve toggle. An
  RSVP "yes" drives roster membership: with auto-approve on, the member is added
  automatically; with it off, an Approve/Decline request is posted to a dedicated
  per-event thread in the owner group's channel and is also actionable on the web
  roster detail page. Withdrawing a "yes" removes flow-added members (manual members
  are protected) and cancels pending requests; enabling auto-approve backfills current
  "yes" responders. Configure and approve from either Discord or the web.

### Patch Changes

- [#400](https://github.com/maxa-ondrej/sideline/pull/400) [`dbdf1b7`](https://github.com/maxa-ondrej/sideline/commit/dbdf1b71f3f46566de01e8c270bb38bc05442c32) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Make the bot's sync poll loops resilient to transient failures. Every poller
  (`roles`, `channels`, `events`, `email`, `finance`, …) ran as
  `processTick.pipe(Effect.repeat(Schedule.spaced(...)))`, and `Effect.repeat`
  stops on the first failure — so a single transient error (e.g. an RPC blip
  while the server is redeploying) would silently kill that poller until the bot
  was restarted. The shared `pollLoop`/`fastPollLoop` now catch and log the whole
  cause of a failed tick (including defects) so the loop keeps ticking, while
  per-service `tapError` logging still records the specific failure.
- Updated dependencies [[`58b7a5a`](https://github.com/maxa-ondrej/sideline/commit/58b7a5aa2954faa5925bdcf0f3e9334b5d102d2e)]:
  - @sideline/domain@0.27.0
  - @sideline/i18n@0.12.4

## 0.21.2

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

- Updated dependencies [[`aeffab9`](https://github.com/maxa-ondrej/sideline/commit/aeffab928c7ccfdd80101d024e13c5fea5885b2c)]:
  - @sideline/domain@0.26.2
  - @sideline/i18n@0.12.2

## 0.21.1

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

- Updated dependencies [[`a924f26`](https://github.com/maxa-ondrej/sideline/commit/a924f269c0917b65bcca6c7d4ec8c57bdba6b893)]:
  - @sideline/domain@0.26.1
  - @sideline/i18n@0.12.1

## 0.21.0

### Minor Changes

- [#383](https://github.com/maxa-ondrej/sideline/pull/383) [`741f36a`](https://github.com/maxa-ondrej/sideline/commit/741f36adbbbc7f77b43e4a9ab400003418e13d7f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - feat(email): two-tier summaries (short + detailed) with ephemeral paginated Discord previews and dual-summary web editing

  Every forwarded email now gets a SHORT summary (a plain opening sentence plus ~6 emoji-led bullets) and a DETAILED summary (the existing balanced one), generated in a single OpenAI JSON-mode call. The coach approval message shows both summaries inline; the posted team message shows the short summary with buttons that open ephemeral, paginated previews of the detailed summary and the original email (no Sideline redirect). The Sideline web email page edits both summaries. Adds a nullable `short_summary` column (legacy rows fall back to the detailed summary, then the body) and a team-ownership + posted-status-guarded `Email/GetEmailContent` RPC for the member-facing previews.

### Patch Changes

- Updated dependencies [[`741f36a`](https://github.com/maxa-ondrej/sideline/commit/741f36adbbbc7f77b43e4a9ab400003418e13d7f)]:
  - @sideline/domain@0.26.0
  - @sideline/i18n@0.12.0

## 0.20.1

### Patch Changes

- [#381](https://github.com/maxa-ondrej/sideline/pull/381) [`63944c0`](https://github.com/maxa-ondrej/sideline/commit/63944c055606415b955344313fe7e8cb3af87d5d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - fix(rpc): preserve UTF-8 multi-byte characters across NDJSON stream chunk boundaries

  Patches the `effect` NDJSON RPC serializer to decode streamed response chunks with a streaming `TextDecoder` (`{ stream: true }`). Previously, when an HTTP response body was split mid-character across network chunks, multi-byte UTF-8 sequences (e.g. Czech accented letters, emoji) were flushed as U+FFFD replacement characters, corrupting forwarded email summaries posted to Discord.

## 0.20.0

### Minor Changes

- [#376](https://github.com/maxa-ondrej/sideline/pull/376) [`4f2d818`](https://github.com/maxa-ondrej/sideline/commit/4f2d818a03acf47d15e1a74eabf06136c84f1c94) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add email forwarding with AI summarization and coach approval. Teams can forward organizational emails to a unique inbound address (secured by a per-team token plus HMAC signature verification, body-size cap, and rate limiting). Each email is summarized via an `effect/unstable/ai` LLM client (config-gated, with a deterministic stub when no provider is configured), then an approval request with Approve/Reject buttons and a "Review & edit in Sideline" link is posted to a configurable coach channel. On approval the AI summary posts to the team's target channel; on rejection the original email posts instead. Both posts link back to a new web Email Detail page where coaches can review the original message, download attachments, edit the summary before approving, and members can view posted emails. Adds the `email_forwarding_config`, `email_messages`, `email_post_sync_events`, and `email_attachments` tables, the `EmailForwardingApi` endpoints, the `Email` RPC group, an email summarization cron, and the `EmailSyncService` bot worker. New env vars: `EMAIL_WEBHOOK_SIGNING_SECRET` (required) and optional `LLM_API_URL`/`LLM_API_KEY`/`LLM_MODEL`.

### Patch Changes

- Updated dependencies [[`4f2d818`](https://github.com/maxa-ondrej/sideline/commit/4f2d818a03acf47d15e1a74eabf06136c84f1c94), [`5e0a4a0`](https://github.com/maxa-ondrej/sideline/commit/5e0a4a0c781ee8574eb62c69fe613cae13515118)]:
  - @sideline/domain@0.25.0
  - @sideline/i18n@0.11.0

## 0.19.0

### Minor Changes

- [#367](https://github.com/maxa-ondrej/sideline/pull/367) [`7479b19`](https://github.com/maxa-ondrej/sideline/commit/7479b1992514f9eec87456e09ad93e4ebb2f754e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Improve the coach assigning feature:
  - **Configurable claim lead-time** — training claim-request messages now post a configurable number of days before the training (new per-team setting `claim_request_days_before`, default 3) instead of at event creation time, which could be up to the event horizon (~2 weeks) ahead. A new `TrainingClaimRequestCron` drives the scheduled posting; the on-creation emitter only fires immediately when the training already falls inside the lead-time window.
  - **Training-day coaching status** — a new `CoachingStatusCron` posts a "today's coach is X" announcement to the member-visible training channel on the training day, only when the training is already claimed (to avoid notification spam).
  - **Thread-based claim management** — the claim message now spawns a Discord thread (tracked via the new `events.claim_thread_id` column); the claim embed and buttons remain on the starter message.

  Includes an idempotent migration adding `team_settings.claim_request_days_before`, `events.claim_request_sent_at`, `events.coaching_status_sent_at`, and `events.claim_thread_id`, extending the `event_sync_events` type check with `coaching_status`, partial indexes for the new cron scans, and a backfill that marks existing trainings as already-handled so there is no first-deploy notification blast.

### Patch Changes

- Updated dependencies [[`8d5c386`](https://github.com/maxa-ondrej/sideline/commit/8d5c38680e82293b1bca226da837be0749115c66), [`7479b19`](https://github.com/maxa-ondrej/sideline/commit/7479b1992514f9eec87456e09ad93e4ebb2f754e)]:
  - @sideline/domain@0.24.0
  - @sideline/i18n@0.10.0

## 0.18.0

### Minor Changes

- [#356](https://github.com/maxa-ondrej/sideline/pull/356) [`8e17378`](https://github.com/maxa-ondrej/sideline/commit/8e173785eb8ce2a74f6a9bd729e51e6de252102b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - feat(events): hide started/cancelled events by default and support all-day / multi-day events
  - The events list now hides `started` and `cancelled` events by default, with a "Show past & cancelled" toggle. The calendar view continues to show all events.
  - Events can be marked **all day** (no time), including multi-day spans such as tournaments. An "All day" toggle on the create/edit forms hides the time inputs. All-day events render as date(s) only across the web list, detail, and calendar views, in Discord embeds (date-style timestamps), and in the iCal feed (`VALUE=DATE`).

### Patch Changes

- Updated dependencies [[`8e17378`](https://github.com/maxa-ondrej/sideline/commit/8e173785eb8ce2a74f6a9bd729e51e6de252102b)]:
  - @sideline/domain@0.23.0
  - @sideline/i18n@0.9.0

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

### Patch Changes

- Updated dependencies [[`e22ccc5`](https://github.com/maxa-ondrej/sideline/commit/e22ccc5c9f367efca2e26956b6abcb9f351f3878), [`e22ccc5`](https://github.com/maxa-ondrej/sideline/commit/e22ccc5c9f367efca2e26956b6abcb9f351f3878)]:
  - @sideline/domain@0.22.0
  - @sideline/i18n@0.8.0
  - @sideline/effect-lib@0.0.8

## 0.16.0

### Minor Changes

- [#342](https://github.com/maxa-ondrej/sideline/pull/342) [`f4f0e3f`](https://github.com/maxa-ondrej/sideline/commit/f4f0e3f9a33a200c58e02c45949489cf8f7a226b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Discord carpool board feature (`/doprava` / `/carpool`). Captains post a live-updating board; members add cars (capacity 1–8 including driver), reserve seats via buttons, and manage passengers in a per-car private thread. Introduces three new database tables (`carpools`, `carpool_cars`, `carpool_seats`), eight new `Carpool/*` RPC methods, and a new `carpool:manage` permission granted to Admin and Captain roles by default.

### Patch Changes

- [#343](https://github.com/maxa-ondrej/sideline/pull/343) [`4345dd3`](https://github.com/maxa-ondrej/sideline/commit/4345dd3fec03ac134c8ad22e4ef9d16ec63a7052) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Show a consistent, server-resolved display name for users across the website. The name-selection logic that previously lived only in the Discord bot is now a shared `DisplayName.pickDisplayName` helper in `@sideline/domain`, computed server-side and returned as a `displayName` field on the `CurrentUser`, `RosterPlayer`, `LeaderboardEntry`, RSVP (`RsvpEntry`/`NonResponderEntry`), and group-member API responses. The web app now renders that field everywhere it shows a person's name (nav menu, profile, leaderboard, rosters, team members, player detail, group members, RSVP panel, fee/challenge assignee pickers) instead of ad-hoc fallbacks — fixing the leaderboard, which previously showed the raw Discord username with no fallback to the user's real name.

  Precedence is profile name → Discord nickname → Discord display name → username. Empty/whitespace-only Discord name strings are now skipped (also fixes a latent bot bug). Also fixes the weekly-summary top-contributor name, which was previously a placeholder team-member id.

- Updated dependencies [[`f4f0e3f`](https://github.com/maxa-ondrej/sideline/commit/f4f0e3f9a33a200c58e02c45949489cf8f7a226b), [`32f598b`](https://github.com/maxa-ondrej/sideline/commit/32f598b8c8c83471b38d5221ac2eaced1da634d5), [`c50e57f`](https://github.com/maxa-ondrej/sideline/commit/c50e57f4e00c9b46fefbd3241917f4a1d214a435), [`4345dd3`](https://github.com/maxa-ondrej/sideline/commit/4345dd3fec03ac134c8ad22e4ef9d16ec63a7052), [`a48c644`](https://github.com/maxa-ondrej/sideline/commit/a48c644e56bcae9a615bf7f3273fb77810141f5f)]:
  - @sideline/domain@0.21.0
  - @sideline/i18n@0.7.0

## 0.15.0

### Minor Changes

- [#332](https://github.com/maxa-ondrej/sideline/pull/332) [`fbc2627`](https://github.com/maxa-ondrej/sideline/commit/fbc2627fd07a378f1a11c6ae3d1ec3b4a2fe83e7) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Discord bot processor for Weekly Challenges (Part 2/3 of Týdenní výzvy). The bot now drains the `weekly_challenge_sync_events` outbox introduced in Part 1 and posts a localized announcement embed in the team's announcement channel when the captain-scheduled week begins (Monday 09:00 in the team's timezone). Embeds are color-coded (emerald 🥏 for throwing challenges, amber 🏃 for sport) with inline `Druh` and `Týden` fields, an optional description, and an optional deep-link URL (controlled by the new optional `WEB_URL` env var). When Discord returns 404 (channel deleted) the row is marked processed with an audit log; other Discord errors retry with exponential backoff and surface as `MarkFailed` so the server-side 5-attempt cap can terminate them. Adds 7 new `weeklyChallenge_embed_*` i18n keys in cs/en. The web UI and user-facing HTTP API will land in Part 3.

### Patch Changes

- Updated dependencies [[`7fe28e8`](https://github.com/maxa-ondrej/sideline/commit/7fe28e84facfe9b4bef5b70c8627710fea5eb690), [`d7513dc`](https://github.com/maxa-ondrej/sideline/commit/d7513dc8615ea3b28d905493c050d461adc8a4c9), [`fbc2627`](https://github.com/maxa-ondrej/sideline/commit/fbc2627fd07a378f1a11c6ae3d1ec3b4a2fe83e7), [`e953389`](https://github.com/maxa-ondrej/sideline/commit/e9533899780a0983329bbb8acdd159c4f1e71cc8)]:
  - @sideline/domain@0.20.0
  - @sideline/i18n@0.6.0

## 0.14.2

### Patch Changes

- [#323](https://github.com/maxa-ondrej/sideline/pull/323) [`f1fd0cd`](https://github.com/maxa-ondrej/sideline/commit/f1fd0cda5578907f85e49efdb240fd48adb9f070) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Achievement notifications are now posted to a configurable per-team Achievement channel. Existing teams continue posting to their welcome channel by default; set the channel to "None" on the team settings page to disable achievement notifications.

- Updated dependencies [[`f1fd0cd`](https://github.com/maxa-ondrej/sideline/commit/f1fd0cda5578907f85e49efdb240fd48adb9f070)]:
  - @sideline/domain@0.19.4
  - @sideline/i18n@0.5.3

## 0.14.1

### Patch Changes

- [#318](https://github.com/maxa-ondrej/sideline/pull/318) [`eac2e36`](https://github.com/maxa-ondrej/sideline/commit/eac2e365aedadbe052174e202700392bef507a7b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Allow backdating and future-dating activity (makánicko) logs. Previously, activities could only be recorded for the current day; users now choose any date within ±2 years when logging or editing an activity, both on the web app and via the `/makanicko log` Discord command.
  - **Web**: the activity log create form and edit sheet show a date picker. The picker defaults to "today" (empty submission) for create; on edit it pre-fills with the existing log's date and only overrides the stored timestamp when the user explicitly changes it.
  - **Discord**: `/makanicko log` accepts an optional `date` (`YYYY-MM-DD`) parameter; omitting it keeps the original "log now" behaviour.
  - Picked dates anchor at 12:00 Europe/Prague (DST-safe), so they always land in the correct day-bucket for streaks, stats and the leaderboard. Same-day display ordering gets a stable `id` tiebreaker so two logs sharing a noon timestamp don't jitter on refresh.
  - Out-of-range or malformed dates surface a clear "Invalid date" toast (web) or ephemeral reply (bot) instead of failing silently.

- [#320](https://github.com/maxa-ondrej/sideline/pull/320) [`344dcb8`](https://github.com/maxa-ondrej/sideline/commit/344dcb8b542f57b360e186a8b09a63645855f933) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a `/summon` slash command (Czech: `/přivolat`) that adds a user and/or a role's members to the current Discord thread.
  - Restricted to users with the **Manage Threads** permission (declared via `default_member_permissions` so Discord hides it for everyone else, and re-checked at runtime as a safety net).
  - `user` and `role` are both optional; at least one is required.
  - When `role` is provided, the bot lists the guild's members, filters those with the role, and adds each to the thread (with bounded concurrency to respect Discord rate limits).
  - When both are provided, the user is deduplicated against the role expansion so the final count is exact.
  - Reports outcomes ephemerally: per-user success, per-role count, the combined "user + N members" message, "no members with role" when the role expansion is empty, "bot lacks permission" for Discord 403 / code 50013, or a generic error otherwise.
  - The command is rejected outside threads (text channel, category, DM) with a localized "not a thread" message. Czech and English translations are included.

- Updated dependencies [[`eac2e36`](https://github.com/maxa-ondrej/sideline/commit/eac2e365aedadbe052174e202700392bef507a7b), [`344dcb8`](https://github.com/maxa-ondrej/sideline/commit/344dcb8b542f57b360e186a8b09a63645855f933)]:
  - @sideline/domain@0.19.3
  - @sideline/i18n@0.5.2

## 0.14.0

### Minor Changes

- [#289](https://github.com/maxa-ondrej/sideline/pull/289) [`6abf99c`](https://github.com/maxa-ondrej/sideline/commit/6abf99c886c1e5b43fed364699e1f0ee947c4a9c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add fee management and payment tracking MVP. Admins can define fees, assign them to members, and record manual payments (cash or bank transfer); members see their outstanding fees via `/finance status` in Discord and captains get a team-wide overview in the web app. Introduces `finance:view`, `finance:manage_fees`, and `finance:record_payments` permissions (treasurer pattern).

### Patch Changes

- [#308](https://github.com/maxa-ondrej/sideline/pull/308) [`62db467`](https://github.com/maxa-ondrej/sideline/commit/62db46789598c4ec0b02c0f31dded7a262bca718) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Send payment reminders via Discord DM and surface them in the personal iCal feed. A new server cron emits five reminder cadences per unpaid fee (T-3, T-0, T+3, T+10, T+21); the bot delivers each as a DM and only records "sent" after a successful Discord delivery so transient failures get retried. The personal iCal feed (`GET /ical/:token`) now includes all-day VEVENTs with a 1-day VALARM for unpaid/partial/overdue assignments within a 180-day window, fixing RFC 5545 DTSTAMP omission on existing event VEVENTs along the way.

- [#304](https://github.com/maxa-ondrej/sideline/pull/304) [`54662cf`](https://github.com/maxa-ondrej/sideline/commit/54662cf751cfb8fa740fc11ad99d41532498ad24) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Show app versions (web, server, bot) in the user dropdown menu and add a `/info` slash command to the Discord bot.

- Updated dependencies [[`978746c`](https://github.com/maxa-ondrej/sideline/commit/978746ca35b12203a046be017483dbfa968dfaf8), [`2f5291f`](https://github.com/maxa-ondrej/sideline/commit/2f5291f5a2b6643ee5bd6bed922b208c669c3f09), [`6abf99c`](https://github.com/maxa-ondrej/sideline/commit/6abf99c886c1e5b43fed364699e1f0ee947c4a9c), [`9e421b5`](https://github.com/maxa-ondrej/sideline/commit/9e421b5ea30984b60f37c132f3a4e2da90801e38), [`2f6bd5b`](https://github.com/maxa-ondrej/sideline/commit/2f6bd5b9c480a1fc4ff3a59e7fdd4ad521860bb2), [`62db467`](https://github.com/maxa-ondrej/sideline/commit/62db46789598c4ec0b02c0f31dded7a262bca718), [`54662cf`](https://github.com/maxa-ondrej/sideline/commit/54662cf751cfb8fa740fc11ad99d41532498ad24), [`e656e54`](https://github.com/maxa-ondrej/sideline/commit/e656e543f3bb51f9279941d9d7edee529988bfa6)]:
  - @sideline/domain@0.19.0
  - @sideline/i18n@0.5.0

## 0.13.0

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

- [#271](https://github.com/maxa-ondrej/sideline/pull/271) [`21fff86`](https://github.com/maxa-ondrej/sideline/commit/21fff86ae25742437e8c7ebae0f2b14e98402f88) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add weekly makáníčko summaries: teams receive an automated weekly recap every Sunday ~20:00 local team time, posted to a configured Discord channel, with a captain-only web page mirroring the data.
  - New `WeeklySummary` domain models (`WeekRange`, `PlayerWeeklySummary`, `TeamWeeklySummary`, `WeeklySummaryResponse`, `WeeklySummaryDigest`) plus `WeeklySummaryApi` HTTP group and `WeeklySummaryRpcGroup` (`Get/Mark` outbox RPCs).
  - New `team_settings.weekly_summary_channel_id` column and `weekly_summary_sync_events` outbox table with `UNIQUE (team_id, week_start)` so cron inserts are idempotent (`ON CONFLICT DO NOTHING`).
  - Server: `WeeklySummaryRepository` (week-scoped activity, achievement, and active-member queries), `WeeklySummarySyncEventsRepository` (outbox with `delivered_at` separate from `processed_at`, attempt-capped retry), `WeeklySummaryService` (`buildPlayerSummary`, `buildTeamSummary`), `WeeklySummaryHandler` (HTTP API gated on team membership; team section requires `roster:manage`), `WeeklySummaryCron` (per-minute, timezone-aware Sunday 20:00 firing with `Effect.exit` per team, `concurrency: 1`).
  - Bot: `buildWeeklySummaryEmbed` (team channel embed with empty-state, top contributors, week-over-week delta), `handleWeeklySummaryReady`, polling `ProcessorService`.
  - Web: `WeeklySummaryPage` with player + team sections (coach-only) and ISO week navigation (handles W53 long years), new `workout.weekly.tsx` route, link from `MakanickoPage`.
  - Tests: 47 new unit tests across domain + server + bot. Integration repo test scaffolded (`.skip`) pending Pg testcontainer wiring.

  MVP boundaries: channel-only delivery, single team embed; per-player DMs, "didn't log this week" callouts, and player rank deferred to v2.

### Patch Changes

- Updated dependencies [[`1a361c7`](https://github.com/maxa-ondrej/sideline/commit/1a361c7124725e40f0d62e5c546b1dedfcc34535), [`22d7c79`](https://github.com/maxa-ondrej/sideline/commit/22d7c7996efa5a3ce9a8c5a11c070ac7d4b156f6), [`39eadd1`](https://github.com/maxa-ondrej/sideline/commit/39eadd113c4404280d7ab66a389183ef26f5e2a6), [`fd7956f`](https://github.com/maxa-ondrej/sideline/commit/fd7956fedd865b0618823cb68c5d9c6a90d7edc6), [`39eadd1`](https://github.com/maxa-ondrej/sideline/commit/39eadd113c4404280d7ab66a389183ef26f5e2a6), [`54256fa`](https://github.com/maxa-ondrej/sideline/commit/54256fa02de18a1e422b8a8e0f6db03a744f9699), [`21fff86`](https://github.com/maxa-ondrej/sideline/commit/21fff86ae25742437e8c7ebae0f2b14e98402f88)]:
  - @sideline/domain@0.18.0
  - @sideline/i18n@0.4.0

## 0.12.1

### Patch Changes

- [`ea68112`](https://github.com/maxa-ondrej/sideline/commit/ea68112e859e3f25407c8f0403e575d0be4f6144) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Trigger bot and server deploys to pick up `@sideline/domain@0.17.2`, which makes `is_community_enabled` optional in the `Guild/RegisterGuild` RPC payload (defaults to `false` when absent). Resolves the production `Missing key at ["is_community_enabled"]` decode errors caused by deploy-window skew between bot and server replicas.

## 0.12.0

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

- Updated dependencies [[`bdc0b0e`](https://github.com/maxa-ondrej/sideline/commit/bdc0b0ed9bcf4de3ca463bf2331a7da931ac5a79), [`9af6d3c`](https://github.com/maxa-ondrej/sideline/commit/9af6d3c99b469f8d50f5fa18c868efc972085e18), [`7422384`](https://github.com/maxa-ondrej/sideline/commit/7422384074804ae42f7ca4b6e4c4ca1d96801b3e), [`40b33ef`](https://github.com/maxa-ondrej/sideline/commit/40b33ef26ec3a4d979e9022b1de0506965f037d0)]:
  - @sideline/domain@0.17.0
  - @sideline/i18n@0.3.17

## 0.11.6

### Patch Changes

- [#253](https://github.com/maxa-ondrej/sideline/pull/253) [`152bfb7`](https://github.com/maxa-ondrej/sideline/commit/152bfb74bb39112e71a3dda2cb0eeaebd6c5db59) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix `reorderChannelMessages` corruption that wrote event A's content into event B's Discord message and persisted the wrong `discord_message_id`. Replaced the zip-and-edit strategy with a longest strictly-increasing tail-dominating prefix algorithm: keep prefix entries whose snowflakes already form a valid display order, recreate the suffix in display order so new snowflakes increase monotonically. Added a startup healing pass via bulk `listMessages` that detects missing Discord messages and forces their entries into the recreate set. Added an in-process `Effect.Semaphore` registry per channel ID to serialise concurrent reorders. Capped channel events at 10, with cap-dropped Discord messages cleaned up. Refactored `editMessage` to surface a typed `EditOutcome = 'edited' | 'message_gone'` instead of self-healing 10008 inline.

## 0.11.5

### Patch Changes

- [#246](https://github.com/maxa-ondrej/sideline/pull/246) [`3c63376`](https://github.com/maxa-ondrej/sideline/commit/3c633763b8d7d1db4c474c6786f44d2de68b1057) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - When an event starts, push the original embed up into the past section and apply the started color/banner consistently. Also recover from messages that have been deleted in Discord — `editMessage` and `handleStarted`'s in-place edit fall back to creating a new message and saving the new ID, and the bot runs a one-time scan on connect to recreate any messages that went missing while it was offline.

- Updated dependencies [[`3c63376`](https://github.com/maxa-ondrej/sideline/commit/3c633763b8d7d1db4c474c6786f44d2de68b1057)]:
  - @sideline/domain@0.16.5

## 0.11.4

### Patch Changes

- [#244](https://github.com/maxa-ondrej/sideline/pull/244) [`b5ddcc9`](https://github.com/maxa-ondrej/sideline/commit/b5ddcc974359ff7e505e11e652fdcf0a57f0e88f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Render the claimer of a training in the Discord claim-message embed using the same `**Name** (<@discord-id>)` formatter that already powers the events RSVP attendees embed, so claimers now appear with their Discord mention instead of just a plain display name. Identity is resolved at read-time via a join in the sync-event outbox, with a fallback to the snapshotted display name for orphaned rows — no database migration required.

- Updated dependencies [[`b5ddcc9`](https://github.com/maxa-ondrej/sideline/commit/b5ddcc974359ff7e505e11e652fdcf0a57f0e88f)]:
  - @sideline/domain@0.16.4

## 0.11.3

### Patch Changes

- [#242](https://github.com/maxa-ondrej/sideline/pull/242) [`4ee7b70`](https://github.com/maxa-ondrej/sideline/commit/4ee7b7029c76a3a17e19bc902a7284aea076f5b0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix a crash that prevented creating or updating events and event series unless every optional field was filled in. The cross-field validation that links the new "location link" feature to the location text was reading internal Option markers without first checking that the field was present, which threw `TypeError: Cannot read properties of undefined (reading '_tag')` whenever the location link or location text was empty. The check now correctly evaluates each field's state and only rejects payloads that set a location link without a location text.

- Updated dependencies [[`4ee7b70`](https://github.com/maxa-ondrej/sideline/commit/4ee7b7029c76a3a17e19bc902a7284aea076f5b0)]:
  - @sideline/domain@0.16.3
  - @sideline/i18n@0.3.16

## 0.11.2

### Patch Changes

- [#240](https://github.com/maxa-ondrej/sideline/pull/240) [`57cde28`](https://github.com/maxa-ondrej/sideline/commit/57cde28ef0095cc6b309ab3316967f859cd6b1f2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - You can now attach an optional link to an event's location (e.g. Google Maps, venue page). The location text becomes a clickable link on the website and a markdown hyperlink in Discord posts.

- Updated dependencies [[`57cde28`](https://github.com/maxa-ondrej/sideline/commit/57cde28ef0095cc6b309ab3316967f859cd6b1f2)]:
  - @sideline/domain@0.16.2
  - @sideline/i18n@0.3.15

## 0.11.1

### Patch Changes

- [#238](https://github.com/maxa-ondrej/sideline/pull/238) [`2e53d6a`](https://github.com/maxa-ondrej/sideline/commit/2e53d6a4b2a40f222efee89e9a204a66bf33fc4c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - You can now attach a cover image URL to events. Images appear on the event page and as a thumbnail in Discord posts.

- Updated dependencies [[`2e53d6a`](https://github.com/maxa-ondrej/sideline/commit/2e53d6a4b2a40f222efee89e9a204a66bf33fc4c)]:
  - @sideline/domain@0.16.1
  - @sideline/i18n@0.3.14

## 0.11.0

### Minor Changes

- [#236](https://github.com/maxa-ondrej/sideline/pull/236) [`cb91dc7`](https://github.com/maxa-ondrej/sideline/commit/cb91dc72b9f471511d96ac5604e086a60f4193f5) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - feat: add coach claim training feature

  Coaches can now volunteer to organize trainings via a dedicated Discord message posted to the owners group's channel. The message contains a Claim button that toggles to Release once claimed, and the regular reminder cron also posts a "still no coach" reminder when a training stays unclaimed at reminder time.

### Patch Changes

- [#234](https://github.com/maxa-ondrej/sideline/pull/234) [`62db409`](https://github.com/maxa-ondrej/sideline/commit/62db409f482d724157dbab513171b41fa7259248) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - fix: drop member-group role mention from RSVP reminder posts

- Updated dependencies [[`cb91dc7`](https://github.com/maxa-ondrej/sideline/commit/cb91dc72b9f471511d96ac5604e086a60f4193f5)]:
  - @sideline/domain@0.16.0
  - @sideline/i18n@0.3.13

## 0.10.8

### Patch Changes

- [#232](https://github.com/maxa-ondrej/sideline/pull/232) [`ee68d21`](https://github.com/maxa-ondrej/sideline/commit/ee68d215ab1a26accc771119c3249b99aa6c9c71) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Improve the reminders feature: configurable reminder time and timezone (per-team), dedicated reminders channel, member-group-aware audience and role mentions, and a new "Starting now" announcement when an event begins.

  Team settings now expose `rsvpReminderDaysBefore`, `rsvpReminderTime` (HH:MM, capped at 23:54 to avoid midnight wrap), `timezone` (any IANA zone, default `Europe/Prague`), and `remindersChannelId`. Reminders fire at the configured time in the team's timezone with a 5-minute tolerance window. The reminder embed and the new "Starting now" post target the reminders channel (falling back to the owner-group channel, then the guild's system channel) and mention the event's member-group role. The reminder's "Going" and "Not yet responded" lists are filtered to the member group when one is set.

- Updated dependencies [[`ee68d21`](https://github.com/maxa-ondrej/sideline/commit/ee68d215ab1a26accc771119c3249b99aa6c9c71), [`13f887c`](https://github.com/maxa-ondrej/sideline/commit/13f887ced827ab2425a279da00281b183c15a1ea)]:
  - @sideline/domain@0.15.6
  - @sideline/i18n@0.3.12

## 0.10.7

### Patch Changes

- [#216](https://github.com/maxa-ondrej/sideline/pull/216) [`8c98ef5`](https://github.com/maxa-ondrej/sideline/commit/8c98ef5f0d7ed231eb8e57dec9400521211e3e24) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Extract shared `formatName` helper for attendee display names

- [#221](https://github.com/maxa-ondrej/sideline/pull/221) [`efca9d7`](https://github.com/maxa-ondrej/sideline/commit/efca9d7556dac7e05fc19d2255b76788c1ed8700) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add discord display name to the name fallback chain in formatName

- [`1fb9223`](https://github.com/maxa-ondrej/sideline/commit/1fb92239f66c1205710133f38a031790dc838d52) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Paginate RSVP reminder attendee and non-responder lists across multiple embed fields

  Previously the reminder message failed for large teams because the non-responder list exceeded Discord's 1024-character embed field limit, causing every reminder to be rejected with `BASE_TYPE_MAX_LENGTH`. The previous fix truncated the list with "…and N more"; this replaces that with full pagination: names are split across as many consecutive embed fields as needed so all members are always shown.

- [#222](https://github.com/maxa-ondrej/sideline/pull/222) [`f235bf5`](https://github.com/maxa-ondrej/sideline/commit/f235bf5c181ec88cdcd923aca1d71edba46d6a3b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Show Discord mentions alongside names in RSVP reminder messages and the late-RSVP channel
  - RSVP reminder embeds now render attendees as `**Name** (<@id>)` instead of `**Name**` alone, matching the format used in the attendees list.
  - Late-RSVP notifications (posted to the channel configured via `discord_channel_late_rsvp` after the reminder is sent) also now include the user's name alongside the mention, sourced from the new name fields on `SubmitRsvpResult`.
  - Reminder attendee lists now truncate with a localised "…and N more" suffix when the joined text would exceed Discord's 1024-character embed-field limit, preventing `createMessage` from failing for large teams.
  - Closes a related edge case in the attendees list where a user with only `display_name` (no name/nickname/username) would render as mention-only.

- Updated dependencies [[`efca9d7`](https://github.com/maxa-ondrej/sideline/commit/efca9d7556dac7e05fc19d2255b76788c1ed8700), [`f235bf5`](https://github.com/maxa-ondrej/sideline/commit/f235bf5c181ec88cdcd923aca1d71edba46d6a3b)]:
  - @sideline/domain@0.15.5
  - @sideline/i18n@0.3.11

## 0.10.6

### Patch Changes

- [`8833ee2`](https://github.com/maxa-ondrej/sideline/commit/8833ee2c58481b1801da0bb5fcd213d4d8c38eff) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Restore Discord mentions alongside names in attendees list

## 0.10.5

### Patch Changes

- [#206](https://github.com/maxa-ondrej/sideline/pull/206) [`d99385d`](https://github.com/maxa-ondrej/sideline/commit/d99385d26b7a112f8c632cb020b37de48f4cc9ad) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Store Discord server nickname and use name display priority: DB name → server nickname → username

- Updated dependencies [[`d99385d`](https://github.com/maxa-ondrej/sideline/commit/d99385d26b7a112f8c632cb020b37de48f4cc9ad)]:
  - @sideline/domain@0.15.4

## 0.10.4

### Patch Changes

- [#204](https://github.com/maxa-ondrej/sideline/pull/204) [`2c66246`](https://github.com/maxa-ondrej/sideline/commit/2c66246b2ee985a7fea2a40a2762367a7d928336) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Send ephemeral event messages sequentially to preserve chronological order

## 0.10.3

### Patch Changes

- [#199](https://github.com/maxa-ondrej/sideline/pull/199) [`b64c794`](https://github.com/maxa-ondrej/sideline/commit/b64c794005a3249889ea374f4ef13e9419fea6a9) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix unreliable Discord mentions on mobile by showing bold names as primary display instead of @mentions in event embeds, attendees lists, and RSVP reminders. Add /event pending subcommand to list events awaiting the user's RSVP.

- [#203](https://github.com/maxa-ondrej/sideline/pull/203) [`d2d3eb6`](https://github.com/maxa-ondrej/sideline/commit/d2d3eb666c115009d1d24d1d4c80071633ba2e38) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Redesign /event upcoming to show one full event embed per page with per-user RSVP status. Add /event overview command for persistent channel button. Remove /event pending.

- [#195](https://github.com/maxa-ondrej/sideline/pull/195) [`0704c17`](https://github.com/maxa-ondrej/sideline/commit/0704c17897ced04f67ee10a7ed65cd0ec51f74d7) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Reorder attendance channel messages so the nearest upcoming event is the last (most visible) message, and add a divider between past and future events

- Updated dependencies [[`b64c794`](https://github.com/maxa-ondrej/sideline/commit/b64c794005a3249889ea374f4ef13e9419fea6a9), [`19d94f2`](https://github.com/maxa-ondrej/sideline/commit/19d94f2bb999bd6465b2a41955d7cae1a2dc7135), [`d2d3eb6`](https://github.com/maxa-ondrej/sideline/commit/d2d3eb666c115009d1d24d1d4c80071633ba2e38), [`0704c17`](https://github.com/maxa-ondrej/sideline/commit/0704c17897ced04f67ee10a7ed65cd0ec51f74d7)]:
  - @sideline/domain@0.15.3
  - @sideline/i18n@0.3.10

## 0.10.2

### Patch Changes

- [#193](https://github.com/maxa-ondrej/sideline/pull/193) [`9e6a3ea`](https://github.com/maxa-ondrej/sideline/commit/9e6a3ea57fffc2207ef32f2594476f437566771c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Notify server when Discord channels are created, updated, or deleted so the internal channel list stays in sync.

- [#191](https://github.com/maxa-ondrej/sideline/pull/191) [`c0ec370`](https://github.com/maxa-ondrej/sideline/commit/c0ec3701d6b72c2a0dbba3d216041fd4f1342f41) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix newly created Discord channels not showing their name on the web by upserting the channel into the discord_channels table immediately after creation.

- [#189](https://github.com/maxa-ondrej/sideline/pull/189) [`bfbc107`](https://github.com/maxa-ondrej/sideline/commit/bfbc107dae79520fc5801792b5aede8f05ed4e83) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Remove RSVP buttons from Discord event messages after an event starts and mark events as started via a new cron job.

- Updated dependencies [[`9e6a3ea`](https://github.com/maxa-ondrej/sideline/commit/9e6a3ea57fffc2207ef32f2594476f437566771c), [`16192c7`](https://github.com/maxa-ondrej/sideline/commit/16192c762bbef950c6eb587a74c5925cec954cf3), [`c0ec370`](https://github.com/maxa-ondrej/sideline/commit/c0ec3701d6b72c2a0dbba3d216041fd4f1342f41), [`bfbc107`](https://github.com/maxa-ondrej/sideline/commit/bfbc107dae79520fc5801792b5aede8f05ed4e83), [`12fb74d`](https://github.com/maxa-ondrej/sideline/commit/12fb74d22d5c0c118dc803bc6cbbdfd3faeb9271)]:
  - @sideline/domain@0.15.2
  - @sideline/i18n@0.3.9

## 0.10.1

### Patch Changes

- [#182](https://github.com/maxa-ondrej/sideline/pull/182) [`a5c51c1`](https://github.com/maxa-ondrej/sideline/commit/a5c51c1885911f23c41e77e6a3244b950f5380fc) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - RSVP now saves immediately on button click. Ephemeral confirmation shows "Add a message" button (or "Edit message" + "Clear message" if a message already exists). Message is preserved when re-clicking the same RSVP button.

- Updated dependencies [[`a5c51c1`](https://github.com/maxa-ondrej/sideline/commit/a5c51c1885911f23c41e77e6a3244b950f5380fc)]:
  - @sideline/domain@0.15.1
  - @sideline/i18n@0.3.8

## 0.10.0

### Minor Changes

- [#178](https://github.com/maxa-ondrej/sideline/pull/178) [`24174e9`](https://github.com/maxa-ondrej/sideline/commit/24174e90b31d73c8bf5f5181a087a41c3289ae54) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add late RSVP notifications: when a member responds after the reminder is sent, post a notification to a configurable team channel and show a polite hint in the RSVP confirmation. Also include the list of yes attendees in the reminder embed.

### Patch Changes

- Updated dependencies [[`24174e9`](https://github.com/maxa-ondrej/sideline/commit/24174e90b31d73c8bf5f5181a087a41c3289ae54)]:
  - @sideline/domain@0.15.0
  - @sideline/i18n@0.3.7

## 0.9.5

### Patch Changes

- [`e62e1d4`](https://github.com/maxa-ondrej/sideline/commit/e62e1d4ca51fb24c5bb0bd6c26885dca1739edff) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Increase the event embed yes attendees display limit from 10 to 20

## 0.9.4

### Patch Changes

- [`cc742d8`](https://github.com/maxa-ondrej/sideline/commit/cc742d8f5ae355e7485593255629b5fada51bda0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Show a list of yes attendees on RSVP event embeds

- Updated dependencies [[`cc742d8`](https://github.com/maxa-ondrej/sideline/commit/cc742d8f5ae355e7485593255629b5fada51bda0)]:
  - @sideline/domain@0.14.4
  - @sideline/i18n@0.3.6

## 0.9.3

### Patch Changes

- [#153](https://github.com/maxa-ondrej/sideline/pull/153) [`690c5c0`](https://github.com/maxa-ondrej/sideline/commit/690c5c0be363ef1461e74a20ad0545ba140282db) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add 3-mode Discord channel cleanup (nothing, delete, archive) with separate settings for groups and rosters

- [#154](https://github.com/maxa-ondrej/sideline/pull/154) [`883189a`](https://github.com/maxa-ondrej/sideline/commit/883189a4c56c2da0c2dcf92544bb72445bbc343a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add configurable Discord channel/role name format templates to team settings

- [#169](https://github.com/maxa-ondrej/sideline/pull/169) [`1e8def9`](https://github.com/maxa-ondrej/sideline/commit/1e8def9790e7b31c9eb15faf81c71641d69e9d2d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add color and emoji support to groups and rosters with Discord role sync

- [#146](https://github.com/maxa-ondrej/sideline/pull/146) [`b871b3c`](https://github.com/maxa-ondrej/sideline/commit/b871b3c3def2b9eb2397a2072e88eb99d9c87170) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add discord channel linking to rosters with auto-creation, role management, and web UI

- Updated dependencies [[`690c5c0`](https://github.com/maxa-ondrej/sideline/commit/690c5c0be363ef1461e74a20ad0545ba140282db), [`2284bea`](https://github.com/maxa-ondrej/sideline/commit/2284bea83d34f7f93768457ca401fc45dfe6d4e2), [`883189a`](https://github.com/maxa-ondrej/sideline/commit/883189a4c56c2da0c2dcf92544bb72445bbc343a), [`1e8def9`](https://github.com/maxa-ondrej/sideline/commit/1e8def9790e7b31c9eb15faf81c71641d69e9d2d), [`b871b3c`](https://github.com/maxa-ondrej/sideline/commit/b871b3c3def2b9eb2397a2072e88eb99d9c87170)]:
  - @sideline/domain@0.14.3
  - @sideline/i18n@0.3.5

## 0.9.2

### Patch Changes

- [#136](https://github.com/maxa-ondrej/sideline/pull/136) [`dc1ed99`](https://github.com/maxa-ondrej/sideline/commit/dc1ed99d334839bddf17636b48e525b665321a18) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add comprehensive observability with tracing spans, metrics (HTTP, cron, Discord, sync, RSVP), and improve error handling with explicit catchTag patterns and descriptive LogicError messages

- Updated dependencies [[`247fa44`](https://github.com/maxa-ondrej/sideline/commit/247fa444ad52fc44796e54ac9231a73221c29ff0), [`e4f8969`](https://github.com/maxa-ondrej/sideline/commit/e4f8969bcaf1278169e6e5a6aa2b3af49701ec78), [`dc1ed99`](https://github.com/maxa-ondrej/sideline/commit/dc1ed99d334839bddf17636b48e525b665321a18)]:
  - @sideline/domain@0.14.2
  - @sideline/i18n@0.3.4
  - @sideline/effect-lib@0.0.7

## 0.9.1

### Patch Changes

- Updated dependencies [[`4a471dc`](https://github.com/maxa-ondrej/sideline/commit/4a471dc4bc0000168c25fef000ded1ecfd11fd09), [`8d97865`](https://github.com/maxa-ondrej/sideline/commit/8d978654612cab81032e51a3e602ddcf07918ac0)]:
  - @sideline/i18n@0.3.2
  - @sideline/domain@0.14.0

## 0.9.0

### Minor Changes

- [#121](https://github.com/maxa-ondrej/sideline/pull/121) [`737817d`](https://github.com/maxa-ondrej/sideline/commit/737817d36047e914a30f2d2c54b2220b96de21c5) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team leaderboard with activity rankings, streaks, web page, and Discord command

### Patch Changes

- [#119](https://github.com/maxa-ondrej/sideline/pull/119) [`c8db130`](https://github.com/maxa-ondrej/sideline/commit/c8db13047b962c021f18aa04941b2d6298f73cf2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add OpenTelemetry monitoring support via @effect/opentelemetry Otlp module for traces, metrics, and logs export to SigNoz

- Updated dependencies [[`737817d`](https://github.com/maxa-ondrej/sideline/commit/737817d36047e914a30f2d2c54b2220b96de21c5), [`683e8cb`](https://github.com/maxa-ondrej/sideline/commit/683e8cb3e0098fe2802cab6140f5986707d55136), [`c8db130`](https://github.com/maxa-ondrej/sideline/commit/c8db13047b962c021f18aa04941b2d6298f73cf2)]:
  - @sideline/domain@0.13.0
  - @sideline/i18n@0.3.1
  - @sideline/effect-lib@0.0.6

## 0.8.0

### Minor Changes

- [#115](https://github.com/maxa-ondrej/sideline/pull/115) [`174013c`](https://github.com/maxa-ondrej/sideline/commit/174013ca0e42655ee261423a0bddcebb894e83d2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add player activity streaks and stats — streak calculation, /makanicko stats Discord command, web profile stats card, and HTTP API endpoint

### Patch Changes

- [#117](https://github.com/maxa-ondrej/sideline/pull/117) [`1d39492`](https://github.com/maxa-ondrej/sideline/commit/1d394922570fb268808b92b0ceacd555048cc35a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace hardcoded activity types with a global activity_types table, auto-track training attendance via cron after events end, and switch stats to dynamic counts

- [#114](https://github.com/maxa-ondrej/sideline/pull/114) [`c902f5a`](https://github.com/maxa-ondrej/sideline/commit/c902f5aeb9551c43309f3e70134527dd39c5eb49) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add activity logging via Discord slash command (/makanicko log)

- [#111](https://github.com/maxa-ondrej/sideline/pull/111) [`66a30b3`](https://github.com/maxa-ondrej/sideline/commit/66a30b3b88b907f16dd84bf6304ab82e1204622c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Refactor block-body arrow functions to expression-body arrows and replace nested calls with pipe chains

- [#108](https://github.com/maxa-ondrej/sideline/pull/108) [`0fc40b6`](https://github.com/maxa-ondrej/sideline/commit/0fc40b6cb2f3f765e2b65cf2343de39efb53e652) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add training type selection to Discord event creation flow

- Updated dependencies [[`1d39492`](https://github.com/maxa-ondrej/sideline/commit/1d394922570fb268808b92b0ceacd555048cc35a), [`c902f5a`](https://github.com/maxa-ondrej/sideline/commit/c902f5aeb9551c43309f3e70134527dd39c5eb49), [`0fb3acd`](https://github.com/maxa-ondrej/sideline/commit/0fb3acd1ebf9afa6fc7b4fc6d9e14d5b786df4f1), [`174013c`](https://github.com/maxa-ondrej/sideline/commit/174013ca0e42655ee261423a0bddcebb894e83d2), [`0fc40b6`](https://github.com/maxa-ondrej/sideline/commit/0fc40b6cb2f3f765e2b65cf2343de39efb53e652)]:
  - @sideline/domain@0.12.0
  - @sideline/i18n@0.3.0

## 0.7.2

### Patch Changes

- [#104](https://github.com/maxa-ondrej/sideline/pull/104) [`5d2979f`](https://github.com/maxa-ondrej/sideline/commit/5d2979f3ee666d24b461994e2ddb51abd2ce7017) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Enforce group membership checks on RSVP endpoints

- [#103](https://github.com/maxa-ondrej/sideline/pull/103) [`79ca632`](https://github.com/maxa-ondrej/sideline/commit/79ca6325566fc6a2c9e37d4551bcea4f6507d03d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Remove inline event embed update from RSVP handler (now handled by event channel routing) and add Option toEffect utility

- Updated dependencies [[`79ca632`](https://github.com/maxa-ondrej/sideline/commit/79ca6325566fc6a2c9e37d4551bcea4f6507d03d), [`5d2979f`](https://github.com/maxa-ondrej/sideline/commit/5d2979f3ee666d24b461994e2ddb51abd2ce7017), [`9584a67`](https://github.com/maxa-ondrej/sideline/commit/9584a6700fa5dcc86d1ccfed5ed44c07db9f3570), [`79ca632`](https://github.com/maxa-ondrej/sideline/commit/79ca6325566fc6a2c9e37d4551bcea4f6507d03d)]:
  - @sideline/domain@0.11.0
  - @sideline/i18n@0.2.1
  - @sideline/effect-lib@0.0.5

## 0.7.1

### Patch Changes

- [#91](https://github.com/maxa-ondrej/sideline/pull/91) [`dbe2a0b`](https://github.com/maxa-ondrej/sideline/commit/dbe2a0b480314845e45bcae95ea100ce0d06cf25) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace plain string dates with proper DateTime.Utc types throughout the stack

- [#90](https://github.com/maxa-ondrej/sideline/pull/90) [`c885234`](https://github.com/maxa-ondrej/sideline/commit/c885234c8f89088b1cc49a4619b69a617a8e9976) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace native JS array methods with Effect Array module in server and bot

- [#96](https://github.com/maxa-ondrej/sideline/pull/96) [`b49b814`](https://github.com/maxa-ondrej/sideline/commit/b49b814c7166d2ae2d95b00a95ec87a55cb8e9b6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add /event-list Discord slash command with paginated upcoming events embed

- [#100](https://github.com/maxa-ondrej/sideline/pull/100) [`b63f5b0`](https://github.com/maxa-ondrej/sideline/commit/b63f5b017ace088eca0480b814252e2d268137ca) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Group /event-create and /event-list into /event create and /event list subcommands

- [#89](https://github.com/maxa-ondrej/sideline/pull/89) [`4d2ce92`](https://github.com/maxa-ondrej/sideline/commit/4d2ce92b94498e0683756fb4e1439cda51001abc) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Use Discord.Snowflake branded type across the entire stack, remove catchAll on unfailable effects, and refactor repository methods to use destructuring with default values

- [#81](https://github.com/maxa-ondrej/sideline/pull/81) [`e9809ab`](https://github.com/maxa-ondrej/sideline/commit/e9809ab5ee687de7db088da83a06dce0790adec2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add LOG_LEVEL environment variable to override default log levels

- [#97](https://github.com/maxa-ondrej/sideline/pull/97) [`0230c98`](https://github.com/maxa-ondrej/sideline/commit/0230c98db317f20800485a0ad758020236ff2f77) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Remove /ping slash command from Discord bot

- Updated dependencies [[`3b20ab1`](https://github.com/maxa-ondrej/sideline/commit/3b20ab1ed4d61dffc0d136d6ee6a055672e65788), [`dbe2a0b`](https://github.com/maxa-ondrej/sideline/commit/dbe2a0b480314845e45bcae95ea100ce0d06cf25), [`b49b814`](https://github.com/maxa-ondrej/sideline/commit/b49b814c7166d2ae2d95b00a95ec87a55cb8e9b6), [`c12900d`](https://github.com/maxa-ondrej/sideline/commit/c12900da82a09999081325bccbb29a39f93f3215), [`3b16731`](https://github.com/maxa-ondrej/sideline/commit/3b1673170ea6bb9b44b298fc3566415f016ea654), [`4d2ce92`](https://github.com/maxa-ondrej/sideline/commit/4d2ce92b94498e0683756fb4e1439cda51001abc), [`e9809ab`](https://github.com/maxa-ondrej/sideline/commit/e9809ab5ee687de7db088da83a06dce0790adec2), [`0230c98`](https://github.com/maxa-ondrej/sideline/commit/0230c98db317f20800485a0ad758020236ff2f77), [`38381e3`](https://github.com/maxa-ondrej/sideline/commit/38381e3695b8d2d5fc6704df9dfa8d29e55e2e0a), [`381d85d`](https://github.com/maxa-ondrej/sideline/commit/381d85d6f47deb87f68bcebd5a266e0f29bb71f3), [`38381e3`](https://github.com/maxa-ondrej/sideline/commit/38381e3695b8d2d5fc6704df9dfa8d29e55e2e0a)]:
  - @sideline/i18n@0.2.0
  - @sideline/domain@0.10.0
  - @sideline/effect-lib@0.0.4

## 0.7.0

### Minor Changes

- [#78](https://github.com/maxa-ondrej/sideline/pull/78) [`5d55e46`](https://github.com/maxa-ondrej/sideline/commit/5d55e463e6be04b01ac87377825a2372caa2713f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add RSVP reminders and threshold warnings with non-responder visibility

### Patch Changes

- [#79](https://github.com/maxa-ondrej/sideline/pull/79) [`7dccd31`](https://github.com/maxa-ondrej/sideline/commit/7dccd31fe72f0063e7092cc4e762698b32a83e34) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add /event-create Discord slash command for creating events via bot modal

- [#78](https://github.com/maxa-ondrej/sideline/pull/78) [`5d55e46`](https://github.com/maxa-ondrej/sideline/commit/5d55e463e6be04b01ac87377825a2372caa2713f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Send RSVP reminder DMs to non-responders who have a Discord account

- Updated dependencies [[`7dccd31`](https://github.com/maxa-ondrej/sideline/commit/7dccd31fe72f0063e7092cc4e762698b32a83e34), [`f21c610`](https://github.com/maxa-ondrej/sideline/commit/f21c61061b8b67faa87a2cadfec3f728603cae1f), [`f71d644`](https://github.com/maxa-ondrej/sideline/commit/f71d644aff2f4d181986b1510467577adb14fadc), [`5d55e46`](https://github.com/maxa-ondrej/sideline/commit/5d55e463e6be04b01ac87377825a2372caa2713f), [`5d55e46`](https://github.com/maxa-ondrej/sideline/commit/5d55e463e6be04b01ac87377825a2372caa2713f)]:
  - @sideline/domain@0.9.0
  - @sideline/i18n@0.1.2

## 0.6.0

### Minor Changes

- [#73](https://github.com/maxa-ondrej/sideline/pull/73) [`bbaec4d`](https://github.com/maxa-ondrej/sideline/commit/bbaec4d84940ca8aad14ac650ea6214b3e6ee645) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Rename discord_username/discord_avatar to username/avatar across the codebase and fix RSVP member name display to fall back to username

### Patch Changes

- Updated dependencies [[`bbaec4d`](https://github.com/maxa-ondrej/sideline/commit/bbaec4d84940ca8aad14ac650ea6214b3e6ee645)]:
  - @sideline/domain@0.8.0

## 0.5.2

### Patch Changes

- [#69](https://github.com/maxa-ondrej/sideline/pull/69) [`5455854`](https://github.com/maxa-ondrej/sideline/commit/5455854590e40219532403d35dc2e068fd5b62d3) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Reorder Discord event messages by start date after creating or updating events

- Updated dependencies [[`5455854`](https://github.com/maxa-ondrej/sideline/commit/5455854590e40219532403d35dc2e068fd5b62d3)]:
  - @sideline/domain@0.7.1

## 0.5.1

### Patch Changes

- Updated dependencies [[`ca6db57`](https://github.com/maxa-ondrej/sideline/commit/ca6db57efc94442f6a690322ea1ae52355e1d903)]:
  - @sideline/i18n@0.1.0

## 0.5.0

### Minor Changes

- [#60](https://github.com/maxa-ondrej/sideline/pull/60) [`48648de`](https://github.com/maxa-ondrej/sideline/commit/48648dea12e25843ce93dadf1275ea06ee3395d8) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add i18n support to Discord bot with shared translation package

- [#66](https://github.com/maxa-ondrej/sideline/pull/66) [`7c483c5`](https://github.com/maxa-ondrej/sideline/commit/7c483c5a68b9ebf115ccd141d487e334fdee4c2e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Extract OAuth into oauth_connections table and auto-register Discord guild members as team members

### Patch Changes

- Updated dependencies [[`7c483c5`](https://github.com/maxa-ondrej/sideline/commit/7c483c5a68b9ebf115ccd141d487e334fdee4c2e)]:
  - @sideline/domain@0.7.0

## 0.4.1

### Patch Changes

- [#58](https://github.com/maxa-ondrej/sideline/pull/58) [`fc4a030`](https://github.com/maxa-ondrej/sideline/commit/fc4a030319bbe581bf1b82b289711ecdb0731dac) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Migrate EventsRepository schemas from NullOr to OptionFromNullOr for consistent Option types across the repository layer

- Updated dependencies [[`fc4a030`](https://github.com/maxa-ondrej/sideline/commit/fc4a030319bbe581bf1b82b289711ecdb0731dac)]:
  - @sideline/domain@0.6.1

## 0.4.0

### Minor Changes

- [#55](https://github.com/maxa-ondrej/sideline/pull/55) [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add configurable Discord channel targeting for events at three levels: per-event/series, per-training-type default, and per-event-type in team settings

### Patch Changes

- [#55](https://github.com/maxa-ondrej/sideline/pull/55) [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add view attendees feature with ephemeral embed and pagination on event RSVP

- Updated dependencies [[`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0), [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75), [`a2b503c`](https://github.com/maxa-ondrej/sideline/commit/a2b503ce5e7dce8835af0182fa3c8e7242c98355), [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f), [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75), [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75), [`a2b503c`](https://github.com/maxa-ondrej/sideline/commit/a2b503ce5e7dce8835af0182fa3c8e7242c98355), [`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0), [`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0), [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f)]:
  - @sideline/domain@0.6.0
  - @sideline/effect-lib@0.0.3

## 0.3.1

### Patch Changes

- [`90b50bb`](https://github.com/maxa-ondrej/sideline/commit/90b50bbf8317901cedaa7cda8216ecef12be9acc) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Patch bump all applications

## 0.3.0

### Minor Changes

- [#47](https://github.com/maxa-ondrej/sideline/pull/47) [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Rework groups and roles: rename subgroups to groups with hierarchical support, assign roles to groups with recursive permission inheritance, scope training types to groups instead of coaches, and update age thresholds to operate on groups

### Patch Changes

- Updated dependencies [[`bdacd74`](https://github.com/maxa-ondrej/sideline/commit/bdacd74ce3ef5900ba18b266ef4836b284059428), [`bdacd74`](https://github.com/maxa-ondrej/sideline/commit/bdacd74ce3ef5900ba18b266ef4836b284059428), [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd), [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd), [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd), [`74544b4`](https://github.com/maxa-ondrej/sideline/commit/74544b4ede8dde9539bcb5c76c25afda279d883b)]:
  - @sideline/domain@0.5.0

## 0.2.1

### Patch Changes

- [#44](https://github.com/maxa-ondrej/sideline/pull/44) [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix double commitChanges in age check, pass subgroup name in member sync events, remove spurious subgroup_name check on member_removed, fix copy-paste log messages in role sync, and prevent duplicate channel creation when mapping lacks role_id

- [#44](https://github.com/maxa-ondrej/sideline/pull/44) [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Use Discord roles for channel permissions instead of per-user permission overwrites

- [#44](https://github.com/maxa-ondrej/sideline/pull/44) [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Refactor RPC layer to use RpcGroup with prefix and configurable RPC_PREFIX env var

- Updated dependencies [[`3a2daa7`](https://github.com/maxa-ondrej/sideline/commit/3a2daa77509b9a1066c48b78e94697db7609e3d6), [`eb7fdf3`](https://github.com/maxa-ondrej/sideline/commit/eb7fdf3c4607770baf78df856f450f5f303fdc9f), [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb), [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb), [`0c98f29`](https://github.com/maxa-ondrej/sideline/commit/0c98f291ee6168e73077feec4cdbc89f0ccdfd3f)]:
  - @sideline/domain@0.4.0

## 0.2.0

### Minor Changes

- [#35](https://github.com/maxa-ondrej/sideline/pull/35) [`eed4aa3`](https://github.com/maxa-ondrej/sideline/commit/eed4aa3820c6bbad12ff2292bcc92aee5a7460b9) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Discord role sync via @effect/rpc: server emits role change events, bot polls and syncs to Discord

### Patch Changes

- [#33](https://github.com/maxa-ondrej/sideline/pull/33) [`018b413`](https://github.com/maxa-ondrej/sideline/commit/018b413fc26bd25b011c05f13456dcd8fd34475a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add modular command, interaction, and event framework with gateway health checks

- Updated dependencies [[`eed4aa3`](https://github.com/maxa-ondrej/sideline/commit/eed4aa3820c6bbad12ff2292bcc92aee5a7460b9)]:
  - @sideline/domain@0.3.0

## 0.1.7

### Patch Changes

- Updated dependencies [[`11b920c`](https://github.com/maxa-ondrej/sideline/commit/11b920c61ae409100c9bf09221a23929fdf053ef), [`2b1f4b4`](https://github.com/maxa-ondrej/sideline/commit/2b1f4b460b2d234f026cf658a6b0651f84ef58a9), [`780bca9`](https://github.com/maxa-ondrej/sideline/commit/780bca9d0300030fafd76edc3efd81e5f7a6f88d), [`2b1f4b4`](https://github.com/maxa-ondrej/sideline/commit/2b1f4b460b2d234f026cf658a6b0651f84ef58a9), [`11b920c`](https://github.com/maxa-ondrej/sideline/commit/11b920c61ae409100c9bf09221a23929fdf053ef), [`e8fd1ab`](https://github.com/maxa-ondrej/sideline/commit/e8fd1ab2e0b47aa37fa6ed58e01572d25f90e64d)]:
  - @sideline/domain@0.2.0

## 0.1.6

### Patch Changes

- [#21](https://github.com/maxa-ondrej/sideline/pull/21) [`fa51b42`](https://github.com/maxa-ondrej/sideline/commit/fa51b42bab5144cc6027a9fafbc5e8b75271df90) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Standardize TypeScript imports to use `~` alias for `src/` and root-only package imports

- Updated dependencies [[`fa51b42`](https://github.com/maxa-ondrej/sideline/commit/fa51b42bab5144cc6027a9fafbc5e8b75271df90)]:
  - @sideline/domain@0.1.2
  - @sideline/effect-lib@0.0.2

## 0.1.5

### Patch Changes

- [`0685679`](https://github.com/maxa-ondrej/sideline/commit/06856798d01a669df8ac7ec38b64aca076e2b888) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Split migrations into before/after lifecycle, decompose DATABASE_URL into individual connection params, and update docker-compose for full-stack deployment.

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
  - @sideline/effect-lib@0.0.1

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

### Patch Changes

- [#7](https://github.com/maxa-ondrej/sideline/pull/7) [`156389b`](https://github.com/maxa-ondrej/sideline/commit/156389b1ede03fb5922aaeebdf0a8ac1e6e402ee) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Bot ping command now responds in the server's configured language by reading `guild_locale` from the Discord interaction.

- [`8a9287b`](https://github.com/maxa-ondrej/sideline/commit/8a9287bca2a249267cf1133802c656e8c489d4cd) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Centralize environment variable validation with @t3-oss/env-core

- [#5](https://github.com/maxa-ondrej/sideline/pull/5) [`0458277`](https://github.com/maxa-ondrej/sideline/commit/0458277c509fccaa36fefdc7f2d9a8e9833caa83) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add dev scripts for watch-mode development; fix HealthServerLive port and log address

- [#5](https://github.com/maxa-ondrej/sideline/pull/5) [`0458277`](https://github.com/maxa-ondrej/sideline/commit/0458277c509fccaa36fefdc7f2d9a8e9833caa83) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Czech + English i18n support with Paraglide JS, language switcher, persistent user locale, and locale-aware formatting

- Updated dependencies [[`e3a3938`](https://github.com/maxa-ondrej/sideline/commit/e3a393841205f203c16c65dfb0f05a8a5b656cab), [`0458277`](https://github.com/maxa-ondrej/sideline/commit/0458277c509fccaa36fefdc7f2d9a8e9833caa83), [`6579f9e`](https://github.com/maxa-ondrej/sideline/commit/6579f9e28eaf8f5ea2ef9d388e092a7cf672198b), [`e3a3938`](https://github.com/maxa-ondrej/sideline/commit/e3a393841205f203c16c65dfb0f05a8a5b656cab), [`2776ed6`](https://github.com/maxa-ondrej/sideline/commit/2776ed65f129a1206637332b94bdf64a9280cfeb), [`a89cf75`](https://github.com/maxa-ondrej/sideline/commit/a89cf758025d95caae8a98c4337e9679c8bf301e)]:
  - @sideline/domain@0.1.0
