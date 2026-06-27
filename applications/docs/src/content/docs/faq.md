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

Your data stays yours. Sideline stores what's needed for the product to work: your Discord profile, team membership, roster entries, events, and RSVPs. You can export or delete your data from **Profile → Settings** at any time.

## Troubleshooting

### The app shows a blank or white screen — what do I do?

The app will usually recover on its own. If it detects a problem during startup it shows a recovery screen with two buttons:

- **Reload** — retries the page. Try this first.
- **Reset app** — unregisters the app's offline cache and downloads a fresh copy. Your account and all your data stay intact; you just need to be online for the first load after a reset.

If the app just shows a blank page with no recovery screen, reload your browser tab manually. If that does not help, open your browser settings, clear site data for the Sideline domain (cookies, cache, and service workers), and reload.

## For players

### Why did I get a payment reminder DM from the bot?

Sideline sends a direct message on your Discord account when a fee assignment is approaching or past its due date. The five reminder points are: 3 days before due, on the due date itself, then at 3, 10, and 21 days overdue. Each reminder is sent once per threshold and stops automatically once the fee is paid or waived.

### What happens if I have Discord DMs disabled?

If your Discord privacy settings block DMs from server members, the bot cannot reach you and the reminder is silently skipped. To enable DMs: open **Discord User Settings → Privacy & Safety** and turn on **Allow direct messages from server members**. You can also check your upcoming payment due dates in your [iCal feed](/guides/calendar-subscription/) as an alternative.

### Can I turn off payment reminder DMs?

There is no per-member opt-out at this time. Reminders are sent automatically to all members with unpaid assignments. Contact your captain if you believe a reminder was sent in error (e.g. you paid but the payment was not recorded yet).

### How do I change my RSVP after I submitted it?

Click a different button — Yes, No, or Maybe. The new answer overwrites the old one. You can change it as many times as you like until the event starts.

### Why didn't I get a Discord notification?

Common causes:

- The bot doesn't have permission to @-mention you in the reminders channel.
- You have Discord notifications turned off for that channel.
- Your team has reminders disabled in their notification settings.

### Can I hide events from groups I'm not in?

Events are only posted to the groups they target, so you should only see events you're actually invited to. If you're seeing extra posts, check with your captain — you may be assigned to groups you shouldn't be.

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
