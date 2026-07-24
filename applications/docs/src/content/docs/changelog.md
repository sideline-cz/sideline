---
title: Changelog
description: User-facing changes to Sideline.
---

This page lists user-visible changes to Sideline. For developer-level release notes, see the GitHub repository.

## 2026-07-24 — RSVP "Maybe" is now "Coming later" and counts as attending

The **Maybe** RSVP response has been renamed to **Coming later** and now means something more useful: "I'll be there, just running late" — not "I'm undecided".

- **Coming later** now counts as full attendance, exactly like **Yes** — for roster headcounts, event roster auto-approval, training team generation, training attendance auto-logging, and player ratings.
- Choosing **Coming later** requires a short note (reason/ETA) — on the web a required note field appears and **Save** stays disabled until you fill it in; in Discord the button opens a pop-up asking for the note instead of saving instantly.
- Because the note is mandatory, the **Clear message** option is not offered while your response is **Coming later** — clearing it would leave the note blank. Switch to a different response first if you want to remove the note.
- See the [RSVP guide](/guides/rsvp-to-an-event/) for the full rundown of what each response means.
- API integrators: `SubmitRsvpRequest.response` now also accepts `"coming_later"`, which requires a non-blank `message` (submitted or already stored) or the request fails with `400 EventRsvpMessageRequired`. Read endpoints (`GET .../rsvps`, the dashboard, and RPC read surfaces) still report `"coming_later"` as `"maybe"` this release for compatibility with already-deployed clients; `maybeCount` includes both.

## 2026-07-23 — Removed the shared team events board

Events no longer post to a single shared Discord channel. The **Events channel** ("Global events channel") team setting is gone — every member's own private **personal events channel** (and the web app) is now the only place events appear in Discord.

- If your team hadn't set up personal event channels yet, do so now in **Team settings → Discord integration → Personal events category** so members keep seeing events in Discord. See the [Discord integration guide](/guides/discord-integration/#personal-event-channels).
- `/event refresh` now only works inside a personal events channel.
- RSVP reminder DMs now link each non-responder to **their own personal events channel** instead of the old shared board message; if a member has no personal channel, the link falls back to the reminders channel.
- "Starting now" announcements, late-RSVP notices, training claims, coaching announcements, roster approval flows, the web app, the public API, and the iCal feed are all unaffected.
- If your team had a shared events channel before this change, its old event messages are left exactly as they were — Sideline no longer updates them, but they're otherwise harmless. Feel free to delete them manually whenever you like.

## 2026-07-22 — Removed per-event-type Discord channel settings

The six per-event-type channel settings (training, match, tournament, meeting, social, other) have been removed from **Team settings → Discord integration**. They had been unused for event routing since events channel — all event embeds already post to the single global **Events channel** — so removing them simplifies the settings page with no change to where events are posted.

- The **Events channel**, **Late-RSVP channel**, and all other Discord integration settings are unaffected.
- The Discord onboarding welcome screen no longer includes a training-channel entry.
- **Coaching status announcements** ("today's coach is X") now post to the training's owner-group channel only — the training-channel fallback is gone. If your team relied on the training channel setting without a channel configured for the owners group, you'll stop receiving these announcements. To keep receiving them, set a Discord channel for the training's owner group.

## 2026-07-22 — Fix: finished events now disappear from your personal events channel

Previously, when an event started, its message could linger in members' personal events channels instead of being removed like it is in the global events channel.

- The bot now removes an event from your personal channel as soon as it starts, matching the global events channel's behaviour.
- A background self-healing check also cleans up any older events that were missed by this fix before it shipped — no manual action is needed.

## 2026-07-20 — Security hardening: auto-created Discord roles no longer carry server-wide permissions

Discord roles that Sideline creates automatically — for groups, rosters, and achievements — are now created with no global Discord permissions of their own.

- Access to private channels is unaffected: it continues to come entirely from the channel-specific permission overwrites Sideline sets up for the role, exactly as before.
- This applies to newly created roles going forward. No action is needed and no existing role assignments or channel access change.

## 2026-07-20 — Carpool board: drivers can add a route note

Car owners can now attach a short free-text route note (up to 200 characters) to their car — for example, where and when you're leaving from.

- Set it when adding your car (a new optional field in the **Add a car** form), or anytime afterwards via the new **📝 Route note** button in your car's private thread. Opening the button prefills your current note, if any; submitting an empty note clears it.
- The note appears on the public carpool board directly below your car's title, e.g. `📍 leaving from Main Station at 17:30, via Brno`.

See the [Carpool board guide](/guides/carpool/) for full details.

## 2026-07-19 — Carpool board: owners can change seat count and remove a passenger

Car owners now have two new tools in their car's private thread, alongside the existing Assign, Leave, and Remove car buttons:

- **Change seats** — update your car's total capacity (1–8, including yourself as the driver) at any time. You cannot reduce it below the number of people already in the car.
- **Kick passenger** — remove a specific passenger from your car using a Discord user-select menu, same as **Assign passenger**. They are also removed from the private thread.

See the [Carpool board guide](/guides/carpool/) for full details.

## 2026-07-19 — Fix: carpool board car numbers no longer shuffle when adding a car

Cars on the carpool board are now numbered in the order they were added — the first car offered is always **Car 1**, and new cars append as the next number. Previously the order was effectively random, so adding a new car could renumber the existing cars on the board.

## 2026-07-19 — Fix: the carpool board's "Add a car" form now opens reliably

Clicking **Add a car** on the carpool board could fail with a Discord interaction error (and "Sideline didn't respond in time") instead of opening the capacity form, on English-locale teams.

- The bug was an over-length label on the capacity input, which Discord rejected before the form could open. The label now uses a short dedicated text and the form opens as expected.
- No action is needed — this is fixed automatically.

## 2026-07-19 — Carpool board now renders in your team's language

The public carpool board embed posted by `/carpool` (`/doprava`) now uses your team's configured language (set during onboarding) instead of the Discord server's language.

- This matters if your Discord server's locale doesn't match your team's language — for example, a Czech-language team on an English-locale Discord server now sees the board in Czech, matching the rest of the team's Sideline experience.

## 2026-07-06 — Admins can now remove options from a poll

Captains and admins (anyone with the `poll:manage` permission) can now remove one or more options from an open poll directly in Discord.

- Click **➖ Remove option** on the poll embed.
- An ephemeral drop-down lists the current options. Select the ones to remove (at most total minus 2, so at least 2 always remain).
- Votes cast for removed options are permanently deleted. Remaining options are renumbered so their 🇦🇧🇨 letters stay consecutive.

## 2026-07-02 — Fixed a bug where some members never received their personal events channel

Previously, if creating a member's private personal events channel failed on the first attempt (for example a transient Discord error), that member could be permanently skipped on every later provisioning check — they would never get a channel until an admin intervened.

- The provisioning check now automatically retries a member whose channel creation didn't complete, instead of skipping them forever.
- No action is needed from admins or affected members — this is fixed automatically on the next provisioning check (within about 15 minutes).

## 2026-07-02 — New `/complete` Discord command completes your profile

You can now complete your profile straight from Discord with the new `/complete` slash command (Czech: `/dokoncit`) — an alternative to the one-time web onboarding form.

- Pick your gender when running the command, then fill in the pop-up form for name, date of birth, and (optionally) jersey number.
- The reply is always ephemeral — visible only to you.
- Run it again any time to update these details.

## 2026-07-01 — Changing the events channel now moves existing event posts automatically

When a captain or admin changes the **Events channel** in **Team settings → Discord integration**, the bot now automatically migrates all upcoming event posts to the new channel.

- The bot removes each event's message from the old channel and re-posts it in the new channel within seconds.
- Both channels are reordered after the move, so upcoming events are still sorted with the soonest event nearest the input box.
- Past and cancelled events are not affected — only upcoming active events are moved.
- No manual `/event refresh` is needed after changing the channel.
## 2026-07-01 — Automatic member deactivation when leaving Discord

When a member **leaves, is kicked, or is banned** from your Discord server, Sideline now deactivates them automatically — no manual action from admins is required.

- The member is removed from all groups and rosters.
- Their Discord roles and channel access are revoked within seconds.
- If they had a personal events channel, it is cleaned up on the next bot tick.
- Their event attendance and RSVP history are preserved for captain review.
- **Last-admin protection:** the last active team admin is never auto-deactivated to prevent the team from becoming unmanageable.
- **Rejoin is a blank slate:** if the member rejoins and accepts a new invite, they are re-registered as a fresh member. A captain must re-add them to any groups or rosters manually.

## 2026-07-01 — Manage group/roster memberships and deactivate members from the member page

The member detail page (**Team → Members → a member**) now supports full member lifecycle management for captains and admins.

- The profile card now has a clear **view/edit toggle** — click the edit icon to switch to the editable form, or **Cancel** to discard changes and return to the read-only view.
- A new **Memberships** card lets you add or remove the member's **groups** and **rosters** directly from their profile, without navigating to each group or roster individually.
- A **Danger zone** section (visible to admins with permission to remove members) lets you **deactivate** a member, and **reactivate** them later. Deactivating a member also removes their Discord roster/group role and channel access; reactivating restores it.
- API integrators: `RosterPlayer` now includes an `active` field on `GET /teams/{teamId}/members`, `GET /teams/{teamId}/members/{memberId}`, and `PATCH /teams/{teamId}/members/{memberId}`. `GET /teams/{teamId}/members/{memberId}` now also returns deactivated members. New endpoints: `POST /teams/{teamId}/members/{memberId}/reactivate`, `GET /teams/{teamId}/members/{memberId}/rosters`, and `GET /teams/{teamId}/members/{memberId}/groups`.

## 2026-07-01 — Redesigned member detail page

The member detail page (**Team → Members → a member**) has a new card-based layout that's easier to scan, especially on mobile.

- A **summary header** at the top shows the member's avatar, name, `@username`, jersey number, the date they joined the team, and their primary role as a badge (with a `+N` badge if they hold more than one role). Their raw Discord ID and full permission list remain visible only to captains/admins who can manage roles.
- **Removing a role** now asks for confirmation in a dialog before it takes effect, preventing accidental clicks.
- The **edit form** validates the display name (80 characters max) and rejects a birth date in the future. While you have unsaved changes, the form shows how many fields changed and a **Cancel** button to discard them; changed fields are also marked individually.
- Empty sections (stats, activity log, achievements) now show a friendlier message with a call-to-action instead of a blank area.
- API integrators: `RosterPlayer` now includes a `joinedAt` field (ISO 8601 UTC timestamp) on `GET /teams/{teamId}/members`, `GET /teams/{teamId}/members/{memberId}`, and `PATCH /teams/{teamId}/members/{memberId}`.

## 2026-07-01 — New Discord command: `/sudo`

Team admins can now temporarily elevate to Discord Administrator without leaving Discord.

- Run `/sudo` to toggle a shared **Sideline Sudo** Discord role (carrying the Administrator permission) on or off for yourself. Requires the `team:manage` permission — the command is visible to everyone, but only admins can actually use it.
- Entering sudo mode posts an audit entry with a **Leave sudo** button to your team's system log channel, so it's always clear who is elevated and when they started.
- Any admin can click **Leave sudo** to end someone else's session — the audit message updates in place to show it was resolved. Re-running `/sudo` yourself closes it the same way.
- The resolved audit entry shows when the session started, when it ended, and how long it lasted.
- Sudo mode has no automatic expiry in this release; step down by re-running `/sudo` or clicking **Leave sudo**.

## 2026-06-30 — New Discord sub-command: `/event refresh`

Force an immediate re-sync of an events channel without waiting for the next reconcile cycle.

- Run `/event refresh` (Czech: `/event obnovit`) inside **your own personal events channel** — any member can do this, no special permission needed. The bot triggers a fresh content render for all your upcoming events and reorders your personal channel.
- Run it inside the **global events channel** or **another member's personal channel** to re-render and reorder that channel. This requires the `team:manage` permission (team admins only).
- The sub-command is visible to all members under `/event`. Members without the required permission for the channel they are in receive a quiet ephemeral notice.
- The bot always replies ephemerally (visible only to you) and does the heavy work in the background, so the response is instant.
- If used in any other channel the bot replies with a quiet "not an events channel" notice.

## 2026-06-30 — Personal event channels: instant backfill and automatic rename on format change

Two further improvements to personal event channels:

- **New channels show existing events immediately.** When the bot creates a personal channel for a member, it immediately backfills all of that member's upcoming events into the new channel. The channel is populated within seconds of provisioning — no waiting for the next reconcile cycle.
- **Changing the channel-name format renames existing channels.** When a captain updates the **Personal channel name format** setting, the bot automatically renames every existing personal channel to match the new format. Channels are processed one at a time to respect Discord rate limits, so renaming a large team may take a few seconds.

## 2026-06-30 — Personal event channels: group restriction, custom names, Going list, and smart mentions

Personal event channels — private per-member Discord channels showing that member's upcoming events — now have several new capabilities:

- **Group restriction.** Captains can limit personal channels to a specific group (and its sub-groups) by setting **Personal events group** in **Team settings → Discord integration**. Members outside the group use the global events channel instead. If an existing personal channel falls outside the group after a restriction is applied, the bot removes it automatically.
- **Custom channel name format.** The default channel name `events-{discord_id}` can now be changed via **Personal channel name format** in **Team settings → Discord integration**. The format must include `{name}` (member's display name) or `{discord_id}`. Example: `events-{name}`.
- **Going list and Attendees button.** Each event message in a personal channel now shows the same **Going** attendee list and **Attendees** button as the global events channel, so you always see who else is coming without switching channels.
- **Quiet mention on unanswered events.** When a new event appears in your personal channel and you have not yet responded, the message silently highlights as unread (no actual ping). The highlight clears as soon as you respond.
- **Ordered like the global channel.** Events inside your personal channel are now sorted in the same order as the global events channel — soonest upcoming event nearest the input box.

## 2026-06-28 — New: "Who voted?" button on Discord polls

Any team member can now see who voted for each option by clicking the **👥 Who voted?** button on any poll embed — open or closed.

- The result is a private (ephemeral) message visible only to you, so it does not clutter the channel.
- Each option is listed with its vote count and the names of voters, formatted as `Name (@mention)` (no real Discord pings are sent).
- When more than 60 people voted for the same option, the first 60 voters are shown followed by "…and N more".
- On closed polls the Vote and Close buttons are gone, but the Who voted? button stays so you can still review the final breakdown.
- No permission is required — any team member can click it.

## 2026-06-28 — Fix: group channel creation now backfills existing members onto the Discord role

When a Discord channel was created or linked for a group, existing group members were never added to the group's Discord role — only members added _after_ channel creation received it. This is now fixed: the bot backfills all current members (including members of any nested subgroups) onto the role as soon as the channel is provisioned.

- Applies to all three creation paths: creating a new channel, linking an existing channel, and the role-only provisioning flow.
- Members of subgroups nested under the group are included — because adding a member to any subgroup also emits an event on every ancestor, the full descendant membership is used to ensure the role assignment is complete.
- The backfill is add-only: existing role assignments are not touched, and members who no longer belong to the group are not removed. Automatic pruning of stale role-holders is planned for a future release.

## 2026-06-28 — RSVP reminders now stop for disengaged members

The bot no longer sends reminder DMs to Players who have consistently not responded to recent events.

- Each member with the built-in **Player** role has a consecutive missed-RSVP counter. The counter goes up by 1 each time an event starts and they had not responded (yes, no, or maybe). It resets to 0 the moment they respond to any event.
- When the counter reaches the team's **"Stop reminding after N missed RSVPs"** threshold (default: 4), the member is excluded from:
  - Personal RSVP reminder DMs sent by the bot.
  - The public "who hasn't responded yet" list in the reminder embed.
  - The non-responder list captains see on the event detail page.
- Captains and admins can change the threshold in **Team settings → RSVP reminders → Stop reminding after N missed RSVPs** (range 1–50). Setting it higher means the bot waits longer before giving up; setting it lower stops reminders more aggressively.
- Only the built-in Player role is affected. Members without a Player role are never included in reminder lists regardless of this setting.
- No action is needed — existing members start with a counter of 0 and the threshold defaults to 4.

## 2026-06-27 — New Discord command: `/summarize`

Members can now ask the bot to summarize recent conversation in any channel or thread.

- Run `/summarize` to get an AI-generated summary of the last 50 messages, visible only to you.
- Use the `messages` option (1–200) to change how many messages are included.
- Use the `since` option to cover a time window instead — for example `since:24h`, `since:7d`, or `since:2026-06-20`. Multi-unit durations like `3d12h` are also accepted.
- Use the `private` option to control who sees the result: the default (`true`) shows the summary only to you; set `private:false` to post it publicly to the channel.
- The bot skips bot messages and empty posts, labels the result with participant count and time range, and marks the footer as "(capped)" when the window was truncated.
- If the AI is temporarily unavailable the bot says so rather than showing a partial result.
- The command is available in English and Czech (`/shrnout`). No additional configuration or permissions are needed — any member with access to the channel can use it.

## 2026-06-28 — Fix: "Sync roster roles with Discord" now removes extras too

The team-wide roster role sync button now performs a full bidirectional reconcile — it re-adds missing members AND removes the roster Discord role from anyone who is no longer an active member of any roster sharing that role.

- Previously the sync was add-only; former members who were removed from a roster kept their Discord role until it was cleared manually.
- The reconcile reads the live list of Discord role holders, computes the union of active roster members across all rosters that share a given role, and removes anyone present in Discord but absent from the union.
- The sync is **fail-closed**: if the bot cannot read the current guild member list for a roster, it skips the removal step for that roster so no legitimate member is accidentally stripped.
- The button label is updated to **Sync roster roles with Discord** to reflect the bidirectional behaviour.
- Requires the **roster:manage** permission (Captain or Admin).

## 2026-06-27 — New: team-wide "Re-sync roster role members" tool

Admins and captains can now re-sync Discord role membership across all rosters at once, without visiting each roster individually.

- A new **Re-sync roster role members** button appears on the rosters list page (visible to anyone with the **roster:manage** permission).
- It sweeps every active roster that already has a Discord role and re-queues the member sync for each one — useful after a Discord outage or any other situation where multiple rosters have drifted out of sync simultaneously.
- Processes up to 50 rosters per click. If more than 50 rosters qualify, the button reports how many remain and can be clicked again to process the next batch.
- The tool re-adds missing members only. It does not create roles for rosters that have none, and it does not remove former members from existing roles.

## 2026-06-27 — PWA crash recovery: Reload and Reset app

The web app now recovers automatically from blank/white-screen crashes instead of leaving the browser stuck on an empty page.

- A **pre-mount watchdog** detects startup failures (e.g. a stale service-worker cache after a deployment serving an outdated JS bundle) and displays a recovery screen within 10 seconds.
- An **app-level error boundary** catches React render crashes and shows the same recovery screen.
- The recovery screen offers two actions: **Reload** (retries the page, up to a safe limit) and **Reset app** (unregisters the service worker and clears the offline cache, then reloads a fresh copy — your account and data are unaffected).
- Automatic reloads are capped so a persistent crash does not loop forever.
- All crash events are reported to our monitoring system so we can investigate and fix root causes.
- The recovery screen respects your chosen dark/light theme even when the theme system itself has crashed.
- TanStack developer tools are no longer bundled in production builds, reducing the JavaScript payload for all users.

## 2026-06-26 — Fix: roster reactivation now re-adds members to the Discord role

When a roster was reactivated, the bot re-created its Discord role but never re-added the roster's members — so the role came back empty. This is now fixed: on reactivation (and on any manual sync) the bot backfills all current roster members onto the role automatically.

- A new **Sync with Discord** button on the roster detail page lets captains re-apply the roster role on demand — useful after manually adjusting membership or if the role ever drifts out of sync.
- The sync is add-only in this release: it adds or heals members, but does not remove former members who still hold the role. Automatic pruning is planned for a follow-up.
- Requires the **roster:manage** permission (Captain or Admin).

## 2026-06-26 — Discord category for new roster channels

Captains can now choose which Discord category new roster channels are created in.

- Open **Team settings → Discord integration** and set the new **Roster category** dropdown to any category channel in your Discord server.
- New roster channels — created automatically when a roster is added, or when a deactivated roster is reactivated — are placed inside that category.
- Leave the setting as **None** (the default) to place roster channels at the guild root without a category, preserving the previous behaviour.
- If the configured category is deleted or becomes unavailable, the bot falls back to guild-root placement automatically — no manual action is needed.

## 2026-06-22 — Fix: admins can now open event detail pages for any group

Admins (members with the **Admin** role) can now open the detail page of any event on the team — including events in groups they do not belong to. Previously the event detail endpoint returned a 404 for those events, even though admins could already see them in the **All groups** events list. Both surfaces now behave consistently.

## 2026-06-22 — Admins can view all team events across every group

Admins (members with the **Admin** role) can now see every team event in the events list — not just those for groups they belong to.

- A new **All groups** toggle appears on the Events list page for admin users. Enable it to see every event on the team, regardless of which group owns the event. Disable it to return to the normal group-filtered view.
- The toggle is only visible to members with the `team:manage` permission. All other members continue to see only events for their own groups and are unaffected by this change.
- The toggle state is reflected in the URL (`?all=true`) so it persists on page refresh.

## 2026-06-21 — AI rating insight and AI-assisted starting Elo for unrated players

Captains and admins can now use two new AI-powered tools on the player Elo rating card (captain-only). Both features use the same AI assistant as email forwarding and degrade gracefully to a built-in fallback when the AI is unavailable — so they always return a result.

**AI form insight**

- On any member's rating card, click **Get AI insight** to generate a short plain-language summary of the player's current form: their trend (improving, declining, or stable), win/loss/draw record, and whether they are still in calibration.
- The card shows a badge indicating whether the text was AI-generated or produced by the built-in fallback.

**ELO from description (suggest and confirm)**

- For a player who has never played a rated game, click **Estimate rating from description**, enter a short free-text description of their skill level, and the AI suggests a starting Elo (between 800 and 1800) with a rationale.
- Review the suggested number, adjust it if needed, and click **Apply** to seed the player's rating. The player re-enters calibration (first 10 games use the higher K-factor of 40), so early game results will quickly refine the estimate.
- The seed is blocked if the player already has rated games recorded — use the normal game-result flow instead.

Both tools require the `member:edit` permission (Captain or Admin role).

## 2026-06-16 — Balanced training team generator

Captains and coaches can now generate balanced training teams directly from an event detail page — the algorithm splits RSVP-yes attendees into equal-skill groups using each player's Elo rating.

- Open any active or started training event and scroll to the new **Team Generator** section.
- Click **Generate** to split the attendees into two balanced teams. The algorithm seeds the teams with a snake-draft by rating, then runs a deterministic local-search optimisation (up to 1 000 swap iterations) that minimises the average-rating spread and gender imbalance. The same roster always produces the same teams.
- Player cards show each person's current rating and a **calibrating** badge for members who have fewer than 10 rated games.
- Regenerate as many times as you like — nothing is posted until you explicitly click **Post to Discord**.
- When you click **Post to Discord**, the bot posts a formatted embed to the event's configured Discord channel listing all teams, their members, and each team's average Elo.
- Adjust the **balancing weights** (Elo, size, gender) and default team count in **Team settings → Team generator** (`GET/PATCH /teams/:teamId/generation-config`). Higher weight values push the algorithm to care more about that dimension; setting all three equal gives each equal importance.

**Discord shortcut:** Captains with the `ManageEvents` Discord permission can use the new **`/training generate`** command (Czech: `/training generovat`) to get a direct link to the Team Generator section for a recent training event. The command's `event` autocomplete shows only training events from the past 2 days.

**What triggers a warning:**
- **Uneven team sizes** — the player count is not evenly divisible by the team count, so some teams have one fewer member.
- **Insufficient gender mix** — not enough gender diversity in the RSVP pool to balance gender across all teams.
- **Elo outlier** — a specific player has a rating far outside the team average, which inflates the spread regardless of placement.

## 2026-06-16 — Log training game results and track Elo per training event

Captains and coaches can now log the result of each internal scrimmage round directly on the **event detail page** — no more switching between pages.

- Open any training event and scroll to the new **Training results** section.
- Assign RSVP-yes attendees to **Team A** and **Team B**, pick the outcome (Team A wins / Team B wins / Draw), and click **Save**. Elo ratings update immediately.
- Log as many rounds as you need — each is saved as an independent round (Round 1, Round 2, …). Logged rounds are shown in a read-only list below the form.
- Only members who RSVPed "yes" can be placed on a team. The server rejects any other member IDs.
- Logging a round also auto-records attendance for all RSVP-yes attendees (best-effort, once per calendar day).
- Game results are **immutable** — there is no edit or delete in this release.

**Discord shortcut:** Captains with the `ManageEvents` Discord permission can use the new **`/training result`** command (Czech: `/training výsledek`) to get a direct link to the event result editor. The command's `event` autocomplete shows only training events from the past 2 days.

## 2026-06-15 — Global admin management page

Global admins can now manage the list of other global admins directly from the Sideline web app — no database access or environment-variable change required.

- Navigate to **Administration → Global admins** to see the full list of current global admins, showing the source of each entry (database flag or `APP_GLOBAL_ADMIN_DISCORD_IDS` env variable).
- **Grant admin access** by entering a Discord user ID in the form on the page. The user must have signed in to Sideline at least once.
- **Revoke admin access** by clicking **Revoke** next to any DB-managed entry (env-managed entries show an **Env-managed** badge and cannot be revoked here).
- Self-revoke and last-admin removal are blocked by the server to prevent lockout.

See [Admin quick start](/quick-start/admins/#manage-global-admins) for step-by-step instructions.

## 2026-06-12 — Email preview pages no longer hang and very long emails are capped

When clicking **Detailed summary** or **Original email** on an approved email post in Discord, the ephemeral preview now always resolves — even if an error occurs mid-render. Previously, an unexpected failure left the interaction in a permanent "loading" state.

Additionally, emails that would span more than 20 Discord embed pages are now truncated at page 20. The last page shows a notice that the message was too long, with a link to the full email on the Sideline web app (when the web app is configured).

## 2026-06-11 — Channel access grants for unprovisioned groups now auto-heal

When you grant channel access to a group that does not yet have a Discord role, Sideline saves the grant and makes it take effect automatically once the group is provisioned — including for groups that were created before the team's Discord server was linked.

- A **"Not yet active in Discord"** badge appears next to the group name in the channel Access sheet.
- An info alert at the top of the Access sheet tells you that some grants are waiting for Discord to catch up.
- When you add such a grant, you receive an informational toast (instead of the usual success toast) so you know the grant is saved but not yet active.
- **Automatic backfill:** a background process runs every 5 minutes and automatically provisions any group that is missing a Discord role (for example, role-only groups created before the team's Discord link was established). No manual action is needed.
- **Immediate best-effort provisioning:** when you save an access grant for an unprovisioned group, Sideline also enqueues provisioning right away, so you typically do not need to wait for the background cycle.
- **Stored grants applied on provisioning:** when a group's Discord role is first created, all previously stored channel-access grants for that group are re-applied to every already-provisioned managed channel automatically.

## 2026-06-11 — Any team member can now add a car to the carpool board

Previously, adding a car required the `carpool:manage` permission (Admin and Captain roles only). Now **any team member** can volunteer as a driver by clicking **Add a car** on the carpool board — no special role needed. Posting the board itself (`/doprava`) still requires `carpool:manage`.

## 2026-06-10 — Event roster attendance: link a roster to a tournament event

Captains can now link any named roster directly to an event (e.g. a tournament), then choose how "yes" RSVPs are handled:

- **Auto-approve ON** — any member who RSVPs "yes" is added to the roster automatically. Withdrawing the RSVP removes them from the roster (unless they were already a member before the link was set up).
- **Auto-approve OFF** — a "yes" RSVP creates a pending request. The event's owner group receives an **Approve / Decline** embed in a dedicated Discord thread. Owners can also approve or decline from the **roster detail page** in the web app.

Other things to know:

- You can link an existing roster or create a new one directly from the event detail page.
- Toggling auto-approve ON after the fact immediately backfills: all current "yes" RSVPs from non-members are approved and any pending approval requests are cancelled.
- Removing the roster link cancels all pending requests and removes members who were added by the flow (pre-existing roster members are never removed).
- The approval thread is automatically cleaned up when the event–roster link is removed.

## 2026-06-09 — Training-start announcement @-mentions the assigned coach

- When a training starts, the **"Starting now"** announcement in Discord now **@-mentions the assigned coach directly** instead of the member-group role, so the coach is notified the moment their session begins.
- If no coach has claimed the training (or the claimer has no linked Discord account), the announcement **@-mentions the owners-group role** and includes the message "No coach claimed this training." so the coaching team is aware.
- For non-training events (matches, tournaments, etc.) the announcement still @-mentions the member-group role as before.
- The claim embed is automatically **removed from the "Training claims" thread** when the training starts, keeping the thread tidy.

## 2026-06-09 — Training claim embeds now use one persistent thread per owner group

- All training claim embeds for the same owner group are now posted into a single persistent **"Training claims" thread** rather than each training getting its own separate thread.
- The bot creates the thread the first time a claim-request is processed for an owner group and reuses it for all subsequent trainings. If the thread is ever deleted, the bot recreates it automatically on the next claim-request.
- This change reduces channel clutter and makes it easier for the coaching team to see all open and past training claims in one place.

## 2026-06-09 — Persistent "Leave my car" button on carpool board

- Members can now leave their car in two new persistent ways, not just from the ephemeral confirmation after reserving:
  - A **Leave** button is always visible in the car's private thread (between the Assign and Remove car buttons).
  - A **Leave my car** button appears directly on the public carpool board — the server resolves your current car automatically, so you can leave without opening the thread.
- Car owners still cannot leave their own car; use **Remove car** in the private thread instead.

## 2026-06-09 — Two-tier AI summaries for email forwarding

- The AI assistant now produces **two summaries** for every inbound email: a **short summary** (one opening sentence plus up to 6 emoji-led bullet points) and a **detailed summary** (fuller bullet-point breakdown). Both can be edited on the Email detail page before approval.
- The coach approval embed in Discord now shows **both summaries**: an amber embed with the short version and email metadata, followed by a blurple embed with the detailed version.
- After approval, the **short summary** is posted to the team channel. Members can tap **Detailed summary** or **Original email** to view the full text as an ephemeral (private) paginated preview — only visible to the person who clicked.
- The **Approve** button is disabled until the short summary is non-empty, preventing accidental approvals with no Discord-visible text.
- The "Send original" button on the coach approval embed has been removed; posting the original is handled via the **Reject** flow.

## 2026-06-08 — Email forwarding with AI summarization

- Captains can now connect a team email address to Sideline via **Team settings → Email forwarding**. When enabled, inbound emails are automatically summarised by an AI assistant and posted to a Discord channel of your choice.
- A dedicated **coach channel** receives an approval embed first. Coaches review the draft summary (and can edit it on the **Email detail page** in the web app), then click **Approve** or **Reject** in Discord. Approving posts the summary to the team channel; rejecting posts the original email text.
- The **Email detail page** (`/teams/{teamId}/emails/{emailId}`) lets coaches edit the AI summary and download any attached files. Team members with any role can view and download attachments.
- Supported attachment formats: any file up to 10 MB per attachment, 25 MB total per email.
- New **regenerate token** action rotates the inbound webhook URL if the token is ever compromised.
- Requires the `team:manage` permission to configure settings, approve, reject, or edit summaries. Any team member can view an email and its attachments.
- **V1 limitation:** stored email bodies and attachments have no automatic retention policy; purging is a follow-up feature.
- See the [Email forwarding guide](/guides/email-forwarding/) for setup instructions.

## 2026-06-08 — Configurable coach claim-request lead time in Team Settings

- Captains can now set how many days before a training the bot posts the coach claim-request message, directly from **Team settings → Coach assignment → Days before training** (range 0–30; default 3).
- Previously this setting required a database change. It is now fully self-service.
- Setting the value to **0** posts the message on the day of the training. If the value exceeds the team's event horizon, the message may never appear because the training has not been generated yet when the cron runs.

## 2026-06-07 — Improved coach assigning

- The training claim-board message is now posted a configurable number of **days before** the training (default: 3 days), rather than immediately when the training is created. This gives the coaching team time to coordinate in advance.
- When the bot posts the claim-board message, it now automatically opens a **Discord thread** on that message so coaches can discuss preparation without cluttering the main channel.
- On the day of the training, if a coach has claimed it, the bot posts a **"today's coach is X"** announcement to the member training channel. Players see at a glance who is running the session.
- The lead time (how many days before the training the claim message is posted) is a per-team setting. Contact your Sideline administrator to change the default of 3 days.

## 2026-06-05 — Channel management: restore archived channels + channel emoji

- **Restore archived channels:** archived channels can now be moved back out of the archive category directly from Sideline. Open the channel's detail sheet and click **Restore**, or use multi-select to **Restore selected** channels in bulk. For Sideline-managed channels the existing Discord link is re-used — no new channel is created. Channels that are already active, are categories, or cannot be found are listed as skipped.
- **Channel emoji:** when creating a managed channel you can now set an optional emoji. The emoji is stored separately from the logical channel name and composed into the Discord channel name via the team's channel format template (e.g. `{emoji}│{name}`). The team's current format is shown on the **Team → Channels** page.

## 2026-06-05 — Channel management: take over any Discord channel + bulk archive

- **Take over any Discord channel:** you can now bring an existing Discord text channel under Sideline management without recreating it. Open the channel's detail sheet and click **Take over channel**. The bot makes the channel private (replaces all existing Discord permission overwrites with `@everyone deny ViewChannel`), then you control access from the **Access** panel as usual. Only text channels (type 0) can be adopted; categories and voice channels are not supported.
- **Bulk archive:** select multiple channels on the **Team → Channels** page and archive them all in one action. Channels that are already archived, are categories, or cannot be found are skipped with a reason; unexpected errors for individual channels are reported without blocking the rest. Requires the archive category to be configured in **Team settings → Discord integration**.

## 2026-06-04 — Channel management: full Discord channel list + archive any channel

- **Team → Channels** now shows your team's _entire_ Discord channel list — not just channels Sideline created. Every text channel in your server is visible, grouped by its Discord category, so you can see and act on your whole Discord structure from one place.
- Channels under the team's configured **archive category** are automatically shown with an *Archived* badge.
- **Archive any Discord channel:** you can now move any channel — including ones you created manually in Discord — to the archive category directly from Sideline. The channel is moved, never deleted. Requires the archive category to be configured in **Team settings → Discord integration**.
- The original channel management features remain: create, rename, control access, and archive Sideline-managed channels. Access management (per-group permission overwrites) is still limited to managed channels only.

## 2026-06-04 — Web-based Discord channel management

- Admins and captains with the `group:manage` permission can now create, rename, archive, and control access for **managed Discord text channels** directly from the web app — no manual Discord configuration needed.
- Open **Team → Channels** to see the full channel list. Channels show their name, Sideline-side category, current Discord link status, and the number of access grants.
- **Create a channel:** click **New channel**, enter a name and an optional category, then save. Sideline queues the Discord channel for creation; the bot provisions it within seconds and writes the Discord link back automatically.
- **Control access:** open a channel's detail sheet and use the **Access** panel to grant groups one of three permission tiers:
  - **View** — members can read the channel but not write.
  - **Edit** — members can send messages, react, attach files, and use threads.
  - **Admin** — all Edit permissions plus the ability to manage messages, threads, and pin messages. Does _not_ grant Discord's Manage Channel permission.
- **Rename a channel:** updates the Sideline label. Discord channel rename is planned for a future release.
- **Archive a channel:** removes it from the active list and, if an archive category is configured in team settings, moves the Discord channel to that category. Falls back to deleting the Discord channel when no archive category is set.
- Access changes take effect in Discord within seconds via the existing channel-sync pipeline.

## 2026-06-04 — Fix crash immediately after Discord login

- Fixed an `Uncaught undefined` error that appeared in the browser immediately after completing Discord OAuth login. The crash was caused by the post-login redirect (which strips the `?token=` parameter from the URL) interrupting an in-flight page load, allowing a bare `undefined` to escape to the router.
- No user data was affected. You may have seen a blank or broken page on first login; reloading the page worked around it. This is now resolved.

## 2026-06-03 — Consistent display names across the app

- All name fields across the app now follow a single precedence rule: **profile name → Discord server nickname → Discord display name → Discord username**. Whichever is set and non-blank is shown first.
- The leaderboard, RSVP attendee lists, event non-responder lists, group member lists, roster member lists, and the nav user menu all benefit from this change — names are now consistent everywhere.
- API integrators: a new `displayName` field (always a non-empty string) is now included on `CurrentUser`, `RosterPlayer`, `LeaderboardEntry`, `RsvpEntry`, `NonResponderEntry`, and group member objects inside `GroupDetail`. The existing `name` / `memberName` fields are unchanged.

## 2026-06-03 — Onboarding-token page overlay fix

- Fixed a bug on the **Administration → Team onboarding** page where generating a link left a dark modal overlay stuck on screen after closing the dialog.
- The **Copy** button on the generated-link dialog no longer shows an error page when the clipboard API is unavailable; it silently falls back and the link remains visible for manual copying.

## 2026-06-02 — Discord carpool board (/doprava)

- Captains and admins can now post a live-updating **carpool board** in any Discord channel with the `/doprava` command (English alias: `/carpool`).
- Any team member can **add a car** by clicking the **Add a car** button and entering the total capacity (1–8, driver included). The bot creates a private Discord thread for each car where the owner can manage their passengers.
- Members **reserve a seat** using the per-car **Reserve** button on the public board. The bot adds them to the car's private thread automatically.
- Car owners can **assign a passenger** from the private thread using a Discord user-select menu — useful when someone asks for a lift but cannot click the button themselves.
- Members who no longer need a lift can **leave** their reserved seat via the **Leave** button that appears in the reservation confirmation.
- Owners remove their car using the **Remove car** button in the private thread. All passengers are ejected and the thread is archived.
- The board message updates live after every action.
- New `carpool:manage` permission controls who can post a board. Admin and Captain roles receive this permission automatically — no manual configuration needed.
- See the [Carpool board guide](/guides/carpool/) for full details.

## 2026-05-28 — Configurable team dashboard

- You can now personalise the widgets shown on your team dashboard. Open the **Customise dashboard** panel on any team dashboard page to reorder and show or hide the four widgets: **Stats**, **Upcoming events**, **Activity**, and **Team management**.
- Use the **Move up** / **Move down** buttons to change the order, and the toggle switch on each row to hide a widget you don't use.
- Click **Save** to apply your changes. The dashboard refreshes immediately.
- Your layout is personal — changing it does not affect other team members. Each team has an independent layout, so you can configure them differently.
- Pinned banners (such as outstanding fee warnings) always appear above the widget area and are not affected by layout settings.
- API integrators: two new endpoints are available — `GET /teams/{teamId}/dashboard-layout` and `PUT /teams/{teamId}/dashboard-layout`. Both require team membership. See the [API overview](/api/overview/) for details.

## 2026-05-26 — Automatic global-admin promotion for first registered user

- The very first person to sign in to a fresh Sideline installation is now automatically granted **global-admin** access. No environment variable change is needed for self-hosted deployments — the bootstrap admin can immediately mint onboarding links and access the admin pages.
- Global admins who are not yet a member of any team are now redirected to **Administration → Team onboarding** (`/admin/onboarding-tokens`) instead of the "no team" error page.
- Global-admin access continues to work via the `APP_GLOBAL_ADMIN_DISCORD_IDS` environment allowlist (unchanged). Both sources are combined: you are a global admin if either your account has the DB flag set or your Discord ID appears in the env list.

## 2026-05-26 — Graceful handling when a member is removed from a team

- When a captain removes you from a team, navigating to that team's URL now shows a **"You're no longer a member of your team"** notice page instead of a generic error. You can log out or wait to be re-invited.
- If you are no longer an active member of a team, notifications for that team are now inaccessible — list, mark-as-read, and mark-all-as-read requests return a 403 error, preventing stale notification access after removal.
- Payment reminder DMs and iCal fee events now only target active members — removed members stop receiving reminders and their payment entries disappear from the shared iCal feed on the next refresh.
- Logging in via Discord OAuth no longer accidentally reactivates a previously removed membership; inactive memberships stay inactive unless a captain explicitly re-invites the member.

## 2026-05-25 — Weekly challenges web UI and HTTP API

- **Captains** can now create, edit, and delete weekly challenges directly from the web app. Go to **Team → Weekly challenges** (`/teams/{teamId}/challenges`) and click **Nová týdenní výzva**.
- Each challenge has a **kind** (Házecí / Sportovní), a title (max 120 characters), an optional description, and a target week. At most one challenge can exist per team per week.
- **Members** tick off their own completion for the current week's challenge directly on the same page. The grid shows all members across the last 12 weeks with their completion status. Completed cells show **Splněno ✓**; past and future weeks are read-only.
- On desktop, the page renders as a sticky-column grid (weeks as columns, members as rows). On mobile, each challenge is shown as a vertical card.
- The challenges page is linked from the team sidebar navigation.
- API integrators: six new endpoints are available under `GET/POST /teams/{teamId}/weekly-challenges`, `PATCH/DELETE /teams/{teamId}/weekly-challenges/{challengeId}`, and `POST/DELETE /teams/{teamId}/weekly-challenges/{challengeId}/complete`. See the [API overview](/api/overview/) for details.

## 2026-05-25 — Weekly challenge Discord announcements

- Every Monday at 09:00 in your team's configured timezone, the bot now posts a **weekly challenge embed** to a Discord channel of your choice.
- The embed shows the challenge title, its kind (**Házecí** for throwing / **Sportovní** for sport), and the week date range. When a description is provided it is shown as an additional field.
- Throwing challenges use an emerald-green embed; sport challenges use amber.
- When `WEB_URL` is configured on the bot, the embed title links directly to **Team → Weekly challenges** in the web app.
- Configure the channel in **Team settings → Discord integration → Weekly challenge channel**. When no channel is set the bot skips the team — enabling the feature is opt-in.

## 2026-05-22 — Team onboarding flow

- Global Sideline admins can now mint **one-time onboarding links** from **Administration → Team onboarding**. Each link is bound to a specific captain's Discord account and expires after a configurable window (24 hours, 3 days, or 7 days).
- Captains who receive a link complete team setup in a two-step wizard: first they enter the team name, sport, description, and logo URL; then they link their Discord server and pick the welcome channel, system log channel, and language.
- The link is shown only once at creation time. If the captain loses the link before using it, the global admin can revoke the token and issue a new one.
- Token status (**Active / Used / Expired / Revoked**) is visible in the token list at **Administration → Team onboarding**.
- The **Create team** page now shows a banner directing users without an onboarding link to contact a Sideline admin.
- See [Team onboarding guide](/guides/team-onboarding/) and [Admin quick start](/quick-start/admins/#onboarding-new-teams-global-admin) for details.

## 2026-05-22 — Event date range display fix

- Same-day events (start and end on the same date) now show the end time only, e.g. **2026-05-23 14:00 – 16:00**. Previously the end date was repeated unnecessarily.
- Multi-day events continue to show the full end date alongside the end time, e.g. **2026-05-23 09:00 – 2026-05-24 18:00**.
- The fix applies to the event list, the event detail page, and the week-view calendar cards.

## 2026-05-21 — Configurable achievement notification channel

- Captains can now choose which Discord channel receives achievement congratulatory embeds. Go to **Team settings → Discord integration** and set the **Achievement channel** field.
- Select **None** to stop posting achievement notifications entirely.
- Teams that already had a welcome channel configured before this release continue to post achievement embeds there — no action is needed unless you want to change it.

## 2026-05-21 — Backdate and future-date activity log entries

- You can now choose **any date** when logging a physical activity, instead of always using today. The limit is ±2 years from the current date.
- In the **web app** (Workout page and member profile Activity tab), the create form and the edit sheet both have a new **Date** field. Leave it blank to keep the default of today.
- In Discord, the **`/makanicko log`** command accepts a new optional `date` argument (`YYYY-MM-DD`). Omitting it continues to log against today.
- Dates are anchored at noon Europe/Prague time so they always count toward the correct daily streak and stats bucket.
- Auto-logged entries (created when a training event ends) are unaffected and still cannot be edited.

## 2026-05-18 — Expense tracking

- Admins and Treasurers can now record **team expenditures** — pitch hire, equipment purchases, travel costs, tournament entry fees, and other team spending.
- Go to **Team → Finances** and open the **Expenses tab** to add, edit, or delete expenses. Each expense has a category (`fields`, `equipment`, `travel`, `tournaments`, or `other`), an amount, a currency, a date, and a free-text description.
- The **Overview tab** on the Finances page now shows three balance KPI tiles — **Income** (total non-voided payments received), **Expenses** (total recorded expenditures), and **Net** (Income minus Expenses) — aggregated per currency. This tab is now the default when you open the Finances page.
- Every change to an expense is written to an internal audit log; deletions are permanent from the UI but the audit record is retained.
- API: six new endpoints under `/api/teams/{teamId}/expenses` (list, get, create, update, delete) and `GET /api/teams/{teamId}/finances/balance-summary`.

## 2026-05-17 — Payment reminders via Discord DM and iCal

- Sideline now sends you a **Discord DM** when a fee assignment reaches a reminder threshold: 3 days before due, on the due date, then at 3, 10, and 21 days overdue. Each DM shows the fee name, amount, outstanding balance, and due date with a colour-coded embed (blue = due soon, yellow = due today, red = overdue).
- Each reminder is sent **at most once per threshold** — reminders stop automatically once the assignment is paid or waived.
- Your personal **iCal feed** now includes an all-day event for each unpaid or overdue fee assignment, with a built-in alarm one day before the due date. Older than 180 days or already paid/waived assignments are excluded. Overdue assignments are prefixed with `[Overdue]` in the calendar title.
- The iCal feed previously only contained team events. No action is required — if you already have the feed subscribed, the payment entries will appear on the next refresh.

## 2026-05-17 — My Payments page for all members

- Every team member can now visit **Team → My Payments** (`/teams/:teamId/my-payments`) to see their own fee history. No special permission required — each member sees only their own data.
- Four KPI cards show total outstanding balance, number of overdue assignments, total amount paid, and the next upcoming due date.
- Use the filter chips (**All / Outstanding / Paid / Waived**) to narrow the assignment list. Click the chevron on any row to expand the full payment history for that assignment.
- A banner appears at the top of the **Team Dashboard** when you have outstanding or overdue fees, with a direct link to the My Payments page.

## 2026-05-16 — Fee management web UI and payment filters

- **Fee management page** (`/teams/:teamId/finances/fees`) is now available in the web app. Admins and Treasurers can create fees, assign them to members, edit or archive fees, waive individual assignments, and record payments — all without touching the API.
- **By assignment tab** added to the Finance overview page. Displays a filterable flat list of payment records. Filter by member, fee, date range, or toggle to show voided payments.
- **`GET /teams/:teamId/payments`** now accepts optional query parameters: `memberId`, `feeId`, `from`, `to`, and `includeVoided`.
- **`GET /teams/:teamId/members/:memberId/assignments`** — new API endpoint returning all fee assignments for a single team member. Requires `finance:view`.

## 2026-05-15 — Built-in Treasurer role

- Introduced a built-in `Treasurer` role available on every team. Treasurer holds `finance:view`, `finance:manage_fees`, and `finance:record_payments` by default. Use it to give a non-captain member finance authority without elevating them to Admin.
- Captain no longer receives `finance:manage_fees` when a new team is created. Any team whose Captain role was previously granted `finance:manage_fees` keeps it — the migration is additive, not destructive. Going forward, assign the Treasurer role (or a custom role with the perm) to whoever should manage fees.
- Existing teams are upgraded automatically via migration: Treasurer is created on every team, and Admin/Captain receive any finance read perms they were previously missing.

## 2026-05-15 — Version display in web app and Discord

- The **user menu** in the web app (bottom-left corner) now shows the running versions of the web frontend, the server, and the Discord bot. Useful when reporting a bug or confirming a deployment landed.
- The new **`/info`** Discord slash command shows the same bot and server version information as an ephemeral embed — visible only to you.

## 2026-05-15 — Captains can now manage activity types

- **Captains** can now create, update, and delete team-specific activity types, in addition to admins. No configuration required — the `activity-type:create` and `activity-type:delete` permissions are granted to all Captain roles automatically via a backfill migration.
- The **Team → Activity types** page in the web app is now accessible to captains.
- Custom types created or deleted by a captain follow the same rules as admin-managed ones: built-in global types cannot be modified, and types with existing log entries cannot be deleted.

## 2026-05-14 — Fee Management & Payment Tracking (MVP)

- Admins and captains can now create **fees** (e.g. membership dues, kit fees, tournament entry) and assign them to individual members via the API. Full web UI is coming in a follow-up release.
- Each member assignment tracks how much is owed and how much has been paid. The status updates automatically: **Pending** → **Partial** → **Paid** (or **Overdue** if the due date passes unpaid). Assignments can also be **Waived** with a reason.
- Admins with the `finance:record_payments` permission can record payments as `cash` or `bank_transfer`, specifying the date and an optional note. Payments can be voided if entered in error — the voided record is kept for audit purposes.
- The **Finance overview page** (`/teams/:teamId/finances`) shows all members' outstanding balances at a glance, with KPI cards for total due and paid amounts.
- Members can check their own outstanding fees using the new **`/finance status`** Discord slash command. The bot replies with an ephemeral colour-coded embed: green (all clear), amber (pending/partial), or red (overdue).
- Finance permissions follow a treasurer pattern: `finance:view` (read), `finance:manage_fees` (create/assign/archive), and `finance:record_payments` (record/void). The built-in Treasurer role holds all three; admins get all three; captains get view only (see the 2026-05-15 release note).
- **Not yet available:** per-fee detail page, and auto-monthly recurring fees. (Reminder DMs and iCal payment events were added in the 2026-05-17 release.)

## 2026-05-14 — Translation CMS for global admins

- Global admins can now manage UI translations without a code deployment, at `/admin/translations`.
- The page lists every translation key with its compiled English and Czech defaults alongside editable override fields. Edits save on blur or Enter.
- Saving an empty string suppresses the compiled default; deleting an override restores it.
- Bulk changes are supported via **Import JSON** (locale-keyed object or flat array format) and **Export JSON** (full merged bundle including overrides).
- Unknown keys are rejected with a clear error listing the bad keys so you can fix the file and retry.
- Keys whose names start with `bot_` are used by the Discord bot. Override values are stored immediately, but the bot only picks them up after it is redeployed. These keys are marked with a warning badge in the CMS table.

## 2026-05-13 — Custom activity types

- Team admins can now define **custom activity types** from the **Team → Activity types** page in the web app. (Captains gained the same access in the 2026-05-15 release.)
- Each type has a name (unique within the team, max 50 characters), an optional emoji, and an optional short description.
- Custom types appear alongside the four global built-ins (Gym, Running, Stretching, Training) in the activity log form and as autocomplete choices in the `/makanicko log` Discord command.
- Built-in types now have their own emoji (🏋️ Gym, 🏃 Running, 🧘 Stretching, ⚽ Training).
- Types that have been used in at least one activity log entry cannot be deleted — the API returns the current usage count in the error so you can decide what to do.

## 2026-05-13 — Weekly makáníčko summary in Discord

- Every Sunday at 20:00 in your team's configured timezone, the bot posts a **weekly activity summary embed** to a Discord channel of your choice.
- The embed shows the team's total activities and total logged duration for the week, the number of active members, a leaderboard of top contributors (with their activity count and duration), the number of new achievements earned, and a comparison with the previous week.
- Captains can configure the summary channel in **Team settings → Discord integration** by setting the **Weekly summary channel** field.
- When no channel is set the cron skips the team — enabling the feature is opt-in.
- Members can view their own personal weekly summary (activities by type, streak info, new achievements) at **Workout → Weekly summary** in the web app. Captains also see the full team breakdown on the same page.

## 2026-05-13 — Achievement management for admins

- Captains can now manage achievements from the **Team → Achievements** page in the web app.
- **Adjust thresholds** for any of the 11 built-in achievements. A preview shows how many members would qualify at the new threshold before you save.
- **Create custom achievements** with a name, description, rule type (total activities, longest streak, total duration, or per-activity-type count), and threshold. Custom achievements are evaluated automatically alongside built-in ones every time a member logs an activity.
- **Link Discord roles** to any achievement (built-in or custom). Pick an existing Discord role by ID, or choose **Auto-create** — the bot will find a role with the achievement's name in your server or create one if it doesn't exist yet.

## 2026-05-13 — Achievement system

- Members now earn **achievements** automatically as they log physical activity. Milestones include first activity, activity count milestones (10, 50, 100), streak lengths (3, 7, 30 days), total duration milestones (600 and 3000 minutes), and per-type counts (25 gym sessions, 25 runs).
- Achievements marked with a star ⭐ can be linked to a Discord role. When a member earns one of these achievements, the bot automatically grants the configured role on your team's Discord server.
- The bot also posts a congratulatory embed in your team's **achievement channel** (if one is configured), tagging the member and the newly granted role. See the 2026-05-21 release for how to configure or disable this channel independently.
- The `GET /teams/:teamId/members/:memberId/activity-stats` API endpoint now includes an `achievements` array listing each earned achievement and the time it was earned.
- The `/makanicko stats` Discord command continues to show streak and count stats; the web app member profile shows the full achievement list.
- Admins can configure which Discord roles are granted for achievement milestones in **Team settings → Achievements**.

## 2026-05-12 — Group Discord role and channel are now independent

- A Discord **role** is now always created for a group (when the group is first provisioned or when a member is first added). The role exists independently of any channel.
- A Discord **channel** is only created when you explicitly request it — via the **Create channel** button on the group detail page, or by enabling the "create Discord channel on group" team setting.
- **Unlinking a channel no longer removes the Discord role.** Members keep their role assignment; you can link a new channel later and they will automatically regain access.
- The group detail page now shows a **Create channel** button when a mapping exists but has no channel yet, making it easy to add a channel to a previously role-only group.
- Permanent errors (Discord permission denied, deleted resource) are now distinguished from transient errors: they are marked as permanently failed and not retried, preventing repeated failed attempts from blocking the sync queue.

## 2026-05-12 — Gender-based automatic group assignment

- Automatic group rules can now include a **gender** condition in addition to (or instead of) an age range. Members are only moved into the group when all criteria on a rule match (AND semantics).
- A rule must now have at least one criterion set — rules with no age bounds and no gender are rejected.
- The same group can have multiple rules with different criteria (e.g. a "Under-18 Male" rule and an "Under-18 Female" rule for the same group).
- The **Automatic Groups** settings page now has a Gender column and a gender selector in the create-rule form.
- Rules can now include a **Required group** condition: only members who are already in the specified group will be auto-assigned. This lets you combine group eligibility with age or gender criteria.
- A rule cannot require its own target group — the form and the API both reject this configuration.
- The settings page label has been renamed from "Age Thresholds" to "Automatic groups" (route URL and i18n key names are unchanged).

## 2026-05-11 — Personalised Discord invites per acceptance

- Each member who clicks "Accept" on an invite link now receives their own unique, single-use Discord invite. The invite is generated within about a second and the browser redirects them directly to the server.
- The Discord invite is valid for 24 hours and can only be used once, so it cannot be forwarded or reused.
- Captains share only the `/invite/{code}` web link — there is no longer a separate "Copy Discord link" button on the invite management page.

## 2026-05-09 — Automatic Discord server join for returning users

- Fixed: existing users who logged in before the welcome-flow update were not being added to the team's Discord server automatically when accepting a team invite. They will now be auto-joined on next login.
- If re-authorisation is still needed (for example, the browser session was saved before the fix), the invite page now shows a **"Re-connect Discord"** button. Clicking it re-runs the Discord login and completes the Discord server join without any further action.

## 2026-05 — Discord welcome flow and group-targeted invites

- When a new player joins your team's Discord server, the bot can now post a **welcome message** to a channel of your choice and a **system log** (join audit) to a private captain-only channel.
- The welcome message is fully customisable with a template. Available placeholders: `{memberMention}`, `{memberName}`, `{inviterMention}`, `{inviterName}`, `{groupName}`, and `{teamName}`.
- Captains can now create **group-targeted invites** — each invite can be scoped to a group, so new members who use it are automatically added to that group on join.
- Multiple active invites can now coexist (one per group, for example). Individual invites can be deactivated without affecting the others.
- The welcome embed uses the group's colour and displays the group name, so new members immediately see where they belong.
- Configure the welcome channel, system log channel, and welcome message template in **Team settings → Discord integration**.

## 2026-05 — Bot recovers deleted event messages on startup

- If a Discord event embed is deleted while the bot is offline, the bot automatically recreates the missing message the next time it starts up.
- When an event transitions to "started", the bot now reorders the channel so the started event moves to the top of the past-events section and the next upcoming event becomes the most recent message.
- Each event channel now shows at most **10 events** at a time (the most-recent past events plus the soonest upcoming events). Older events beyond that limit are removed from the channel automatically.

## 2026-05 — Claimer shown with Discord handle on training claim board

- The claim-board message now shows the claiming coach as **Name** (@DiscordHandle) instead of just a display name, matching the format used for RSVP attendee lists.

## 2026-04 — Location links for events

- You can now add a URL to any event's location field. When a URL is set, the location text becomes a clickable link on the event detail page and in Discord event embeds.
- The URL must be a public `https://` address (no private/local addresses). A location text must also be provided — a URL alone is not accepted.
- To add or change the link, open the event in the web app and edit the **Location URL** field next to the location text. The `/event create` Discord modal does not include this field; add the link via the web app after creating the event.

## 2026-04 — Cover images for events

- You can now attach a cover image URL to any event. The image appears as a banner on the event detail page.
- The image is also shown as a small thumbnail in Discord event embeds.
- Paste any public `https://` image URL into the new **Image URL** field when creating or editing an event.

## 2026-04 — Training claim board

- When a training event is created, the bot now posts a **claim-board message** to the owner group's Discord channel with a **Claim** button.
- A coach (any member of the training's owner group or a sub-group) can claim or release responsibility for the training directly from Discord.
- The claimed state is shown in the embed: orange when unclaimed, green with the coach's name when claimed.
- If no coach has claimed a training by the time the RSVP reminder fires, the bot posts an additional **unclaimed training reminder** to the owner group's channel.

## 2026-04 — RSVP reminder no longer pings a role

- The RSVP reminder post is now a quiet embed. It no longer @-mentions the member group's Discord role. The bot still sends a direct message to each non-responder who has a linked Discord account.
- The **"Starting now"** event-start announcement continues to @-mention the member group's Discord role as before.

## 2026-04 — Configurable reminders

- Reminders are now fully configurable per team. You can set how many days before an event the reminder fires, what time of day (evaluated in the team's timezone), and which Discord channel receives it.
- Reminders and event-start announcements now go to a dedicated **reminders channel** you configure in Team settings. If no channel is set, the bot falls back to the event's owner-group channel.
- When an event starts, the bot posts a fresh **"Starting now"** announcement to the reminders channel with the going list and a role @-mention — in addition to updating the original event embed.

## 2026-04 — Documentation site launched

- New `/docs` site with role-based quick starts, guides, FAQ, and API overview.
- English content is the source of truth. Czech translations fall back to English with a notice and will be added page-by-page.
