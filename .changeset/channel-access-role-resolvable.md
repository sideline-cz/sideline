---
"@sideline/domain": patch
"@sideline/server": patch
"@sideline/bot": patch
"@sideline/web": patch
"@sideline/i18n": patch
---

Fix channel access for groups that were never provisioned with a Discord role.

Granting channel access to such a group silently saved the grant but never
applied a Discord permission overwrite and gave no feedback — so the group
appeared to "do nothing" (confirmed in production for role-only groups created
before their team's Discord provisioning, which had no `discord_channel_mappings`
row and thus no resolvable role).

The server now backfills missing group roles (a low-cadence bot tick calls a new
`Channel/BackfillMissingGroupRoles` RPC; role-only groups get a role, groups that
already have a channel get the role attached to it — no duplicate channels), and
re-applies a group's stored channel-access grants automatically the moment its
Discord role first appears (group-axis reconcile on the role none→present
transition, generalising the existing channel-axis reconcile). `setAccess` also
best-effort enqueues provisioning when it encounters a role-less group, and the
bot's role provisioning is now idempotent (no duplicate roles on retry).

Channel detail responses also expose a per-grant `roleResolvable` flag, and the
channel access sheet shows a "Not yet active in Discord" badge, info notice, and
clearer toast so the saved-but-pending state is visible until it self-heals.
