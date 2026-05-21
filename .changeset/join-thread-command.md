---
'@sideline/bot': patch
'@sideline/i18n': patch
---

Add a `/join` slash command that adds a user to the current Discord thread. The command is available in public, private, and announcement threads; running it elsewhere (text/voice channel, category, DM) replies with an ephemeral "not a thread" message. The command requires a `user` option (defaulting to nobody) and replies ephemerally with success, a permissions error if the bot lacks `Manage Threads`, or a generic error fallback. Czech and English translations are included.
