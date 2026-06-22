---
"@sideline/domain": minor
"@sideline/server": minor
"@sideline/web": minor
"@sideline/i18n": minor
---

Add an admin-only "All groups" toggle to the team events list. By default members see only events for the groups they belong to; admins (members with `team:manage`) can now flip a toggle to see every team event regardless of group. The toggle is driven by a URL search param so it refetches from the server, and the server re-checks the `team:manage` permission — a non-admin cannot bypass group filtering by sending the flag. It composes with the existing client-side "Show past & cancelled" filter, and the calendar view inherits the broadened scope.
