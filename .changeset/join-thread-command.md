---
'@sideline/bot': patch
'@sideline/i18n': patch
---

Add a `/join` slash command that adds a user and/or a role's members to the current Discord thread.

- `user` and `role` are both optional; at least one is required.
- When `role` is provided, the bot lists the guild's members, filters those with the role, and adds each to the thread (with bounded concurrency to respect Discord rate limits).
- When both are provided, the user is deduplicated against the role expansion so the final count is exact.
- Reports outcomes ephemerally: per-user success, per-role count, the combined "user + N members" message, "no members with role" when the role expansion is empty, "bot lacks permission" for Discord 403 / code 50013, or a generic error otherwise.
- The command is rejected outside threads (text channel, category, DM) with a localized "not a thread" message. Czech and English translations are included.
