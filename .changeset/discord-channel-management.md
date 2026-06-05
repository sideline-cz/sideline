---
"@sideline/domain": minor
"@sideline/server": minor
"@sideline/bot": minor
"@sideline/web": minor
"@sideline/i18n": minor
"@sideline/migrations": minor
"@sideline/effect-lib": patch
---

Add web-based Discord channel management for admins

Admins (with `group:manage`) can now create, rename, and archive Discord text
channels directly from Sideline, organize them with Sideline-side categories and
ordering, and grant existing groups VIEW/EDIT/ADMIN access to each channel
(mapped to Discord permission overwrites). The ADMIN tier is bounded — it grants
message/thread moderation but never channel rename or delete. Introduces a new
`managed` channel entity that reuses the existing channel-sync pipeline, backed
by new `team_channels` and `team_channel_access` tables and a new channel HTTP
API. v1 scope: text channels only; ordering/categories are Sideline-side.

The channel list reflects the team's actual Discord channels (synced from the
`discord_channels` mirror, merged with managed channels still provisioning),
grouped by their Discord category. Channels in the team's configured archive
category are shown as archived, and admins can archive any Discord channel — not
just Sideline-created ones — moving it into the archive category.

Admins can also **bulk-archive** channels (multi-select) and **manage permissions
for any Discord channel**, not just Sideline-created ones: managing access on a
previously-unmanaged channel "adopts" it — making it private and replacing its
existing Discord permissions with the Sideline access model (after a clear
confirmation). A partial unique index keeps adoption idempotent.

Also hardens `Runtime.runMain` so unsatisfied layer dependencies fail `pnpm check`
at the call site instead of crashing the app at startup (the previous `as never`
cast hid them). This surfaced and fixed a pre-existing missing dependency in
`EventStartCron` (`DiscordChannelMappingRepository`).
