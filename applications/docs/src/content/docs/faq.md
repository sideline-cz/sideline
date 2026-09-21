---
title: Frequently asked questions
description: Quick answers to the most common Sideline questions.
---

## General

### Is Sideline free?

Yes. Sideline is free to use and open source. The hosted instance at sideline.majksa.net is free for all amateur teams. You can also self-host — see the GitHub repo for instructions.

### Does it work without Discord?

Partially. The web app works standalone, but you lose the best part of Sideline — the in-Discord event posts, RSVP buttons, and reminders. We strongly recommend using Discord alongside the web app.

### What happens to my data?

Your data stays yours. Sideline stores what's needed for the product to work: your Discord profile, team membership, roster entries, events, and RSVPs.

To get a copy of your data or have it deleted, contact us — there is no self-service button for it yet, so these requests are handled by a person. Leaving a team deletes your team-scoped data.

## Troubleshooting

### The app shows a blank or white screen — what do I do?

The app will usually recover on its own. If it detects a problem during startup it shows a recovery screen with two buttons:

- **Reload** — retries the page. Try this first.
- **Reset app** — unregisters the app's offline cache and downloads a fresh copy. Your account and all your data stay intact; you just need to be online for the first load after a reset.

If the app just shows a blank page with no recovery screen, reload your browser tab manually. If that does not help, open your browser settings, clear site data for the Sideline domain (cookies, cache, and service workers), and reload.

## For players

### Why did I get a payment reminder DM from the bot?

Sideline sends a direct message on your Discord account as soon as a fee is assigned to you, and again when it's approaching or past its due date. The reminder points after assignment are: 3 days before due, on the due date itself, then at 3, 10, and 21 days overdue. Each reminder is sent once per threshold and stops automatically once the fee is paid or waived.

### Why does the QR code / payment message in my reminder look weird — no accents, all uppercase?

That's expected, not a bug. The text encoded *inside* a payment QR code follows a banking standard (SPAYD) that requires unaccented, uppercase characters — so "Příspěvek podzim 2026" becomes `PRISPEVEK PODZIM 2026` in the scannable code itself. The rest of the message around the QR code keeps normal Czech text with full diacritics.

### I paid by bank transfer but my fee still shows as unpaid — why?

Your club's Sideline instance matches bank payments to your fee using a **variable symbol** — a short number tied to your member profile. If you don't have one yet, paid without entering it, or your bank's app dropped/changed it, Sideline can't match the payment automatically and it sits in the treasurer's manual queue until they resolve it. Ask your treasurer to check your variable symbol is set, or to look for your payment in the bank movements queue.

### What happens if I have Discord DMs disabled?

If your Discord privacy settings block DMs from server members, the bot cannot reach you and the reminder is silently skipped. To enable DMs: open **Discord User Settings → Privacy & Safety** and turn on **Allow direct messages from server members**. You can also check your upcoming payment due dates in your [iCal feed](/guides/calendar-subscription/) as an alternative.

### Can I turn off payment reminder DMs?

There is no per-member opt-out at this time. Reminders are sent automatically to all members with unpaid assignments. Contact your captain if you believe a reminder was sent in error (e.g. you paid but the payment was not recorded yet).

### How do I change my RSVP after I submitted it?

Click a different button — Yes, No, or Coming later. The new answer overwrites the old one. You can change it as many times as you like until the event starts. Switching to **Coming later** requires a short note (reason/ETA).

### Why didn't I get a Discord notification?

RSVP reminders are sent as a direct message, not a channel post. Common causes:

- Your Discord account isn't linked to your Sideline profile, so the bot doesn't know who to DM.
- Your Discord privacy settings block DMs from server members (see [What happens if I have Discord DMs disabled?](#what-happens-if-i-have-discord-dms-disabled) above).
- You already RSVPed — reminders only go to members who haven't responded yet.
- Your team has reminders disabled in their notification settings.

### Can I hide events from groups I'm not in?

Events are only posted to the groups they target, so you should only see events you're actually invited to. If you're seeing extra posts, check with your captain — you may be assigned to groups you shouldn't be.

## AI assistant

### Can the assistant create or change things for me?

No. The assistant is read-only — it can only answer questions about your team's events, training types, members, groups, and rosters. To create or change anything, use the normal pages (events, roster, groups, and so on).

### Why doesn't the assistant show me a group/roster I know exists?

The assistant only shows you what you could already see elsewhere in the app. If you don't have permission to view a group or roster, the assistant won't show it to you either — it isn't a way around your normal permissions.

### Why do I see "The assistant isn't available"?

The assistant is a deployment-wide setting, not something your team turns on itself — either it isn't enabled on your Sideline instance, or the host hasn't configured an AI provider yet. Ask whoever runs your instance if you'd like it enabled.

## Weekly challenges

### How do I mark a challenge done?

Open **Team → Weekly challenges** in the sidebar. Find your row in the grid (or your card on mobile) and click the tick cell in the current week's column. The cell updates to show **Splněno ✓**. Click it again to undo.

You can only mark the **current week's** challenge. The current week is calculated using your team's configured timezone.

### Can my captain mark the challenge done for me?

No. Each member marks their own completion. If you marked it by mistake, click the cell again to unmark it.

### Why can't I tick a past week's challenge?

Completion is only allowed during the challenge's week. Past and future weeks are read-only in the grid.

## For captains

### Can I RSVP on behalf of a player?

No. RSVPs are always the player's own action — we don't want captains to fake headcounts. You can manually record attendance after the event from the event page if someone forgot to click.

### How far in advance are recurring events posted?

By default, the next 4 weeks. Change it from **Team settings → Events → Scheduling window**.

### Can I move an event to a different time without editing the whole series?

Yes. Edit the individual event (not the series). The change applies to that occurrence only. See [Create recurring events](/guides/create-recurring-events/#one-off-changes).

## For admins

### Can I change a team's name after creation?

Yes, from **Team settings → General**. The change is immediate and applies everywhere.

### How do I transfer admin rights to someone else?

Promote them to admin from the roster. They'll have full access immediately. You can then demote yourself if you're stepping down.

### What if someone leaves Discord — do I lose their history?

No. If someone leaves your Discord server, their Sideline roster entry is archived automatically. RSVP and attendance history is preserved. If they rejoin later, their entry can be reactivated.

### Can I use one Sideline account for multiple teams?

Yes. One Discord account can be in any number of teams. The dashboard aggregates events across all of them.

### My Fio bank connection stopped importing payments — what do I do?

The most common cause is an expired token: Fio tokens last at most 180 days and only renew when someone signs in to Fio Internetbanking or Smartbanking. Open the bank connection card on your team's settings page — it explains exactly what's wrong (an expired/invalid token, a temporary Fio outage Sideline is already retrying, or a token still "activating" if you just created it) and what to do next. See [Connecting a bank account](/guides/finances/#connecting-a-bank-account-fio) for the full setup and troubleshooting steps.
