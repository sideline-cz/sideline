---
"@sideline/domain": minor
"@sideline/migrations": minor
"@sideline/server": minor
"@sideline/web": minor
"@sideline/i18n": minor
---

feat: rework RSVP reminder notifications with missed-RSVP threshold

RSVP reminders now only notify built-in "Player" role members whose consecutive
missed-RSVP streak is below a per-team configurable threshold (`max_missed_rsvps`,
default 4). A `missed_rsvps` counter on `team_members` increments when an event
starts and an invited Player hadn't responded; it resets to 0 on any RSVP response
(both via the web UI and Discord buttons). Captains can adjust the threshold in team
settings.
