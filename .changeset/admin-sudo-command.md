---
"@sideline/domain": minor
"@sideline/server": minor
"@sideline/bot": minor
"@sideline/i18n": minor
"@sideline/docs": minor
---

Add a Discord `/sudo` command that lets team admins temporarily elevate to Discord Administrator.

- `/sudo` is a toggle: an admin running it grants themselves a shared `Sideline Sudo` role (carrying the Discord Administrator permission) and posts an audit entry with a "Leave sudo" button to the team's system channel; running it again while elevated revokes the role.
- Any admin can press "Leave sudo" to end another admin's session; the audit message is edited to a resolved state. Non-admins clicking it get an ephemeral denial and the shared message is left untouched.
- Access is enforced server-side via a new `Guild/CheckTeamAdmin` RPC (resolves the caller's team membership and `team:manage` permission), not via Discord `default_member_permissions` — so the command stays visible to team admins regardless of their Discord-native permissions.
- The interaction is deferred and the elevation work is forked so Discord's 3-second acknowledgement window is respected; role-assign/revoke permission errors (bot role hierarchy) are surfaced clearly, and a missing system channel still grants sudo with an ephemeral notice (re-run `/sudo` to step down).
- No auto-expiry in this version: sudo persists until the invoker toggles it off or an admin presses "Leave sudo".
