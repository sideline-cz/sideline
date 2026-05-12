---
title: Changelog
description: User-facing changes to Sideline.
---

This page lists user-visible changes to Sideline. For developer-level release notes, see the GitHub repository.

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
