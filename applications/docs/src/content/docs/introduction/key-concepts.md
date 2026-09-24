---
title: Key concepts
description: Glossary of the core terms used throughout Sideline.
---

A quick tour of the vocabulary you'll see across the app and these docs. Each term links to its own anchor so guides can refer back to this page.

## Team

The top-level unit. A Team corresponds to one amateur sports club (or one section of a larger club). Each team is connected to one Discord server. Members, events, and rosters all belong to a specific team.

## Roster

The list of people who play for the team. A roster entry links a person to their Discord account, jersey number, and groups. Archived roster entries stay searchable but don't count toward active headcounts.

## Group

A subdivision within a team's roster — "first team", "reserves", "under-17s", "Thursday pickup". Events can be targeted at specific groups so only the right people get notified and asked to RSVP.

## Role

Permissions attached to a person within a team. Built-in roles are `player`, `captain`, `admin`, and `treasurer`. Roles control what actions are allowed (creating events, editing roster, changing team settings, managing fees). A role can also be attached directly to a member, or granted to a whole [group](#group) — every member of that group (and any of its sub-groups) then holds the role too, shown on their profile as "inherited". Archiving a group revokes the roles it granted.

One role per team is the **default role**: whichever role a new member gets when they join, whether through an [invite](#invite) or by joining the linked Discord server directly. Every team starts out with `player` as the default; an admin can point it at a different role from **Team → Roles**. See [Invite members](/guides/invite-members/).

## Event

A single happening at a specific date and time — a training, a game, a team dinner. Events have a location, a group (audience), an RSVP deadline, and an [event type](#event-type).

## Event series

A repeating pattern (e.g. "every Tuesday at 19:00") that generates individual Events on a schedule. Edit the series to change all future occurrences at once, or edit a single event to make a one-off change.

## RSVP

A player's response to an event: **Yes**, **Coming later**, **Not sure**, or **No**. "Coming later" means the player will attend but arrive after the start time — it counts as full attendance, same as **Yes**. "Not sure" means the player hasn't decided yet — unlike the other three, it does **not** count as attendance (no roster slot, no auto-logged training attendance, not included in team generation). Both "Coming later" and "Not sure" require a short note (an ETA for one, what the decision depends on for the other) and open a note step instead of saving instantly; **Yes** and **No** save immediately with an optional note. RSVPs can be changed until the event starts; switching away from "Coming later" or "Not sure" clears its note, since the note only makes sense for the response it was written for. Captains see live counts; reminders target players who haven't replied.

## Event type

A category for events, shown as a coloured badge on every event card. Sideline ships six built-in kinds — training, match, tournament, meeting, social, other — but each team owns its own list: an admin can rename any of them (e.g. "Training" → "Practice"), pick its colour, add new types built on the same six kinds (so a team can have both "League match" and "Friendly", both behaving like "match"), and reorder the list. See **Team → Event types** (admins only). This is a different thing from a training's [training type](#training-type) below (Strength, Tactical, and so on) — an event's type says *what kind of event this is*; a training's training type says *what the training focuses on*.

## Training type

A category specific to training events — "Strength", "Tactical", or any other custom label a team defines. Used for filtering training sessions and stats; unrelated to the six built-in [event types](#event-type) above.

## Age threshold

Optional rule on a team that hides events from players below a cutoff age. Useful for junior/senior splits.

## Achievement

A milestone badge earned automatically when a member's activity stats cross a threshold (for example: first logged activity, 7-day streak, 50 total sessions). Each achievement is awarded once. Sideline ships 11 built-in achievements whose thresholds captains can adjust; teams can also create fully custom achievements with their own names, descriptions, and rules. Some achievements grant a Discord role if a team admin has configured a role mapping. See the [Activity tracking guide](/guides/activity-tracking/) for the full list and admin instructions.

## Invite

A link captains share so new people can join the team. Expires after first use (by default) and can be scoped to a specific group or role.

## Complete profile

A member's name, date of birth, and gender. Finished either through the web onboarding form or with `/complete` in Discord — including for a member who joined straight from a plain Discord server invite, without ever visiting the web app. Teams can turn on **Require a complete profile** to block RSVPing, claiming a training, or taking a carpool seat until a member's profile is finished; off by default. See [Onboarding through Discord](/guides/discord-integration/#onboarding-through-discord).

## Fee

A named charge defined at the team level — for example, a membership subscription, a kit levy, or a tournament entry fee. Each fee has a default amount, a currency, and an optional due date. Admins or Treasurers create fees and assign them to individual members.

## Fee assignment

The record that ties a specific fee to a specific member. An assignment tracks how much is owed and how much has been paid. The **status** is computed automatically: pending, partial, paid, overdue, or waived.

## Membership plan

A named pricing tier a team offers — for example "Adult membership" or "Junior membership". Every team starts with one free, unnamed default plan. Admins or Treasurers can add more plans, edit pricing, promote a different plan to be the team's default, and archive a plan that's no longer offered. Today this covers pricing and lifecycle only — nothing assigns a plan to a member yet. See [Membership plans](/guides/finances/#membership-plans).

## Payment

Money received against a fee assignment. Payments are recorded by admins or treasurers (anyone with `finance:record_payments`) and can be voided if entered in error. The voided record is kept for auditing. A payment can be recorded by hand (cash or bank transfer) or created automatically by matching a bank movement. See the [Finances guide](/guides/finances/) for the full workflow.

## Credit

Money a member has paid that isn't (yet) owed against any fee, tracked per currency. Built up either by paying more than what's currently outstanding, by paying in advance of any fee being assigned, or — if the club has turned on auto-crediting — as the leftover from a bank transfer a member sent via their standing top-up QR code. Applied automatically the next time that member is settled. See [Settling a member's balance and paying in advance](/guides/finances/#settling-a-members-balance-and-paying-in-advance).

## Variable symbol

A short number (1–10 digits) attached to a member, used to identify their bank payments — the standard way Czech and Slovak bank transfers carry this information. Sideline uses it to automatically match a member's incoming bank payments to their fee assignments and to build their payment QR codes. Unique per team; a member with no variable symbol can't be auto-matched. See [Setting up variable symbols](/guides/finances/#setting-up-variable-symbols).

## Bank movement

One transaction read from a club's connected bank account (currently Fio banka only). Sideline imports movements automatically, tries to match each one to a member's outstanding fee by variable symbol, and queues anything it can't confidently match for a treasurer to resolve by hand. If the club has turned on auto-crediting, a movement that identifies exactly one member is instead applied automatically — paying their oldest fees first and turning any remainder into credit — even when its amount doesn't exactly match one fee. See [Connecting a bank account](/guides/finances/#connecting-a-bank-account-fio).

## Weekly challenge

A shared goal set by a captain for a single ISO week (Monday–Sunday). A challenge has a **kind** (Házecí / throwing or Sportovní / sport), a title, and an optional description. Each member marks their own completion during the active week. At most one challenge can exist per team per week. See the [Weekly challenges guide](/guides/weekly-challenges/) for instructions.

## AI assistant

A read-only chat panel, scoped to one team, that answers questions about the team's own events, training types, members, groups, and rosters. It respects the asking member's own permissions exactly — it never shows data that member couldn't already see elsewhere in the app — and it cannot create, edit, or delete anything. See the [AI assistant guide](/guides/ai-assistant/).

## Email forwarding

An opt-in feature that routes inbound emails to a Discord channel. When a new email arrives, Sideline generates an AI summary and posts an approval request to a private coach channel. A coach reviews the summary — editing it on the **Email detail page** if needed — then approves or rejects it from Discord. Approved emails post the summary; rejected emails post the original text. All attached files are stored and downloadable from the Email detail page. See the [Email forwarding guide](/guides/email-forwarding/) for setup instructions.
