---
"@sideline/domain": minor
"@sideline/server": minor
"@sideline/bot": minor
"@sideline/web": minor
"@sideline/migrations": minor
"@sideline/i18n": minor
"@sideline/docs": minor
---

Rework the Discord events overview into private per-member event channels plus a single global shared channel.

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
- New admin (ManageEvents) `/refresh-events` slash command: run it inside the global events channel or your own personal events channel to re-render and reorder its messages.
- Removes the old `/event overview` command, the overview-channel team setting, and the SetOverviewChannel RPC. The coaching-status announcement is retained.
