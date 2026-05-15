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

Permissions attached to a person within a team. Built-in roles are `player`, `captain`, `admin`, and `treasurer`. Roles control what actions are allowed (creating events, editing roster, changing team settings, managing fees).

## Event

A single happening at a specific date and time — a training, a game, a team dinner. Events have a location, a group (audience), an RSVP deadline, and a training type.

## Event series

A repeating pattern (e.g. "every Tuesday at 19:00") that generates individual Events on a schedule. Edit the series to change all future occurrences at once, or edit a single event to make a one-off change.

## RSVP

A player's response to an event: **Yes**, **No**, or **Maybe**. RSVPs can be changed until the event starts. Captains see live counts; reminders target players who haven't replied.

## Training type

A category for events — "training", "match", "tournament", "friendly", "other". Used for filtering, stats, and colour coding.

## Age threshold

Optional rule on a team that hides events from players below a cutoff age. Useful for junior/senior splits.

## Achievement

A milestone badge earned automatically when a member's activity stats cross a threshold (for example: first logged activity, 7-day streak, 50 total sessions). Each achievement is awarded once. Sideline ships 11 built-in achievements whose thresholds captains can adjust; teams can also create fully custom achievements with their own names, descriptions, and rules. Some achievements grant a Discord role if a team admin has configured a role mapping. See the [Activity tracking guide](/guides/activity-tracking/) for the full list and admin instructions.

## Invite

A link captains share so new people can join the team. Expires after first use (by default) and can be scoped to a specific group or role.

## Fee

A named charge defined at the team level — for example, a membership subscription, a kit levy, or a tournament entry fee. Each fee has a default amount, a currency, and an optional due date. Admins or Treasurers create fees and assign them to individual members.

## Fee assignment

The record that ties a specific fee to a specific member. An assignment tracks how much is owed and how much has been paid. The **status** is computed automatically: pending, partial, paid, overdue, or waived.

## Payment

Money received against a fee assignment. Payments are recorded by admins or treasurers (anyone with `finance:record_payments`) and can be voided if entered in error. The voided record is kept for auditing. See the [Finances guide](/guides/finances/) for the full workflow.
