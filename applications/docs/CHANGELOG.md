# @sideline/docs

## 0.4.5

### Patch Changes

- [#501](https://github.com/maxa-ondrej/sideline/pull/501) [`9933852`](https://github.com/maxa-ondrej/sideline/commit/9933852e34ed10e43a0a90fded2dc59ed5cf8f60) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Carpool improvements:

  - **Stable car ordering** — cars are now numbered in creation order (oldest is car 1, newly added cars append as the next number). Previously the board sorted by a random UUID, so adding a car could renumber the existing one.
  - **Change seats** — a car's owner can update the seat count from the car thread. Reducing below the number of people already in the car is blocked.
  - **Kick passenger** — a car's owner can remove a specific passenger from their car (also removes them from the car thread).

## 0.4.4

### Patch Changes

- [#499](https://github.com/maxa-ondrej/sideline/pull/499) [`df6359f`](https://github.com/maxa-ondrej/sideline/commit/df6359fc427fbe0d9d421edcf0b4d153b7818455) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix the `/carpool` "add car" modal failing with an interaction error (and "Sideline didn't respond in time") on English-locale teams. The capacity input reused a 53-character placeholder string as its Discord input label, exceeding Discord's 45-character label limit and getting the whole modal rejected before it could open. The label now uses a dedicated short message key.

  Also render the carpool board embed in the Sideline team's configured language (`teams.onboarding_locale`) instead of the Discord guild locale: `CarpoolView` now carries the team `language`, the server populates it from the team row, and `buildCarpoolEmbed` reads it directly.

## 0.4.3

### Patch Changes

- [#486](https://github.com/maxa-ondrej/sideline/pull/486) [`95e4fc9`](https://github.com/maxa-ondrej/sideline/commit/95e4fc9c85029a67520a943bd99cb191d7657405) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add an admin "Remove option" button to polls. Captains/admins can remove one or
  more options from an open poll via an ephemeral select menu; votes for removed
  options are deleted and the remaining options are renumbered so their letters stay
  contiguous. A poll always keeps at least two options.

## 0.4.2

### Patch Changes

- [#465](https://github.com/maxa-ondrej/sideline/pull/465) [`d2fa636`](https://github.com/maxa-ondrej/sideline/commit/d2fa636529fceb35f2d50c6701f6fade580273e9) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix personal channel provisioning permanently skipping members after a failed first attempt. The reservation query used `INSERT ... ON CONFLICT DO NOTHING`, so a stale NULL reservation left behind by a failed attempt made every subsequent reserve return `reserved=false`, permanently skipping the member. Reservation is now a lease-based conditional re-claim that re-claims a stale NULL reservation older than 15 minutes while preserving cross-replica mutual exclusion for in-flight reservations and never touching already-provisioned rows.

## 0.4.1

### Patch Changes

- [#463](https://github.com/maxa-ondrej/sideline/pull/463) [`d9c0bf8`](https://github.com/maxa-ondrej/sideline/commit/d9c0bf89d61a51d4886fd071293316d138cfd9c0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a `/complete` Discord slash command that lets a team member complete their profile without leaving Discord: it captures name, date of birth, gender, and jersey number. Gender is a native command choice; name, date of birth, and jersey number are collected via a modal. Name, birth date, and gender persist on the user and mark the profile complete (`is_profile_complete = true`, the same as web onboarding); jersey number persists on the team membership. Adds a `Guild/CompleteMemberProfile` RPC with defensive server-side validation and transactional writes, and tightens the shared birth-date schema to strict `YYYY-MM-DD` (rejecting rolled-over dates like `2005-02-30`).

## 0.4.0

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

## 0.3.0

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

## 0.2.4

### Patch Changes

- [#444](https://github.com/maxa-ondrej/sideline/pull/444) [`a20acad`](https://github.com/maxa-ondrej/sideline/commit/a20acad5dd92081758ce5ae070556f01735d413d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add a "Who voted?" button to the `/poll` public board

  Members can now click **👥 Who voted?** on a poll (open or closed) to get an ephemeral message listing each option with the people who voted for it, rendered as `Name (@mention)` without pinging anyone. Backed by a new `Poll/GetPollVoters` RPC and a team-scoped `findPollVoters` query that returns the true per-option vote counts (the displayed voter list is capped at 60 per option, with the remainder shown as "…and N more"). Voter identities are visible to all team members.

## 0.2.3

### Patch Changes

- [#421](https://github.com/maxa-ondrej/sideline/pull/421) [`cfa325c`](https://github.com/maxa-ondrej/sideline/commit/cfa325c80c44b6701c52383e700d8f602d76d32f) Thanks [@dependabot](https://github.com/apps/dependabot)! - deps: bump the npm group across 1 directory with 27 updates

## 0.2.2

### Patch Changes

- [#420](https://github.com/maxa-ondrej/sideline/pull/420) [`3c2207d`](https://github.com/maxa-ondrej/sideline/commit/3c2207d056d6ec46032d2a0cc33f953950c58ef1) Thanks [@dependabot](https://github.com/apps/dependabot)! - Bump astro from 6.4.6 to 6.4.8 in the astro group

## 0.2.1

### Patch Changes

- [#408](https://github.com/maxa-ondrej/sideline/pull/408) [`bee5d1d`](https://github.com/maxa-ondrej/sideline/commit/bee5d1dd461cde1e8cefd0f2b79146623f5192a8) Thanks [@dependabot](https://github.com/apps/dependabot)! - Bump @astrojs/mdx from 6.0.2 to 6.0.3

- [#408](https://github.com/maxa-ondrej/sideline/pull/408) [`bee5d1d`](https://github.com/maxa-ondrej/sideline/commit/bee5d1dd461cde1e8cefd0f2b79146623f5192a8) Thanks [@dependabot](https://github.com/apps/dependabot)! - Bump @astrojs/starlight from 0.39.3 to 0.40.0

- [#408](https://github.com/maxa-ondrej/sideline/pull/408) [`bee5d1d`](https://github.com/maxa-ondrej/sideline/commit/bee5d1dd461cde1e8cefd0f2b79146623f5192a8) Thanks [@dependabot](https://github.com/apps/dependabot)! - Bump astro from 6.4.4 to 6.4.6

## 0.2.0

### Minor Changes

- [#223](https://github.com/maxa-ondrej/sideline/pull/223) [`5298870`](https://github.com/maxa-ondrej/sideline/commit/52988703e2827ed558b3cf15a7e7c902fab46a38) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Scaffold `@sideline/docs`, an Astro + Starlight static documentation site served at `/docs` on the main domain. Includes EN-first landing page, introduction, role-based quick starts, guides, API overview, FAQ, changelog, and about pages. CZ locale ships with zero files — Starlight's built-in fallback banner renders EN content for any `/docs/cs/*` URL. The docs container is a two-stage build producing a `nginx:alpine` image that serves static files, with `/health` exposed for healthchecks. The proxy routes `/docs/*` to the new docs container via a new `$var_docs_upstream` map.
