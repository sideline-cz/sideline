---
title: Changelog
description: User-facing changes to Sideline.
---

This page lists user-visible changes to Sideline. For developer-level release notes, see the GitHub repository.

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
