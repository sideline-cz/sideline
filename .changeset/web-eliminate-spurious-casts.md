---
'@sideline/web': patch
---

Eliminate two unnecessary `as` casts in the web app: drop the redundant `'role:manage' as Role.Permission` cast (the literal is already a valid `Permission`), and replace the create-team `guildId as Snowflake` cast with `Discord.Snowflake.makeUnsafe`. Behavior-preserving.
