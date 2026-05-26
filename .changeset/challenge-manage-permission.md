---
'@sideline/domain': patch
'@sideline/server': patch
'@sideline/migrations': patch
---

Add a dedicated `challenge:manage` permission for the Weekly Challenges feature, granted to both Admin and Captain roles by default. Previously the team-challenge HTTP API checked the admin-only `team:manage` permission, blocking captains from creating / editing / deleting challenges. The new migration backfills the permission for all existing teams' built-in Admin and Captain roles.
