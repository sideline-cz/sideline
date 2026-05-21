---
'@sideline/domain': patch
'@sideline/server': patch
'@sideline/bot': patch
'@sideline/web': patch
'@sideline/i18n': patch
---

Allow backdating and future-dating activity (makánicko) logs. Previously, activities could only be recorded for the current day; users now choose any date within ±2 years when logging or editing an activity, both on the web app and via the `/makanicko log` Discord command.

- **Web**: the activity log create form and edit sheet show a date picker. The picker defaults to "today" (empty submission) for create; on edit it pre-fills with the existing log's date and only overrides the stored timestamp when the user explicitly changes it.
- **Discord**: `/makanicko log` accepts an optional `date` (`YYYY-MM-DD`) parameter; omitting it keeps the original "log now" behaviour.
- Picked dates anchor at 12:00 Europe/Prague (DST-safe), so they always land in the correct day-bucket for streaks, stats and the leaderboard. Same-day display ordering gets a stable `id` tiebreaker so two logs sharing a noon timestamp don't jitter on refresh.
- Out-of-range or malformed dates surface a clear "Invalid date" toast (web) or ephemeral reply (bot) instead of failing silently.
