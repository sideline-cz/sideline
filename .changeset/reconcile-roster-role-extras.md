---
"@sideline/domain": patch
"@sideline/server": patch
"@sideline/bot": patch
"@sideline/web": patch
"@sideline/i18n": patch
"@sideline/migrations": patch
---

fix: "Sync roster roles with Discord" button now also removes extras

The existing team-wide "Sync roster roles with Discord" button (formerly
labelled "Re-sync roster role members") now performs a bidirectional
reconcile: it re-adds roster members who are missing their Discord role
AND removes the roster Discord role from users who are no longer active
members of any roster that shares that role.

Implementation details:

- A new `roster_role_reconcile` channel-sync event is emitted once per
  active roster role when the sync is triggered and is processed
  asynchronously by the bot.
- The bot reads the live list of Discord role holders (paginated),
  computes the union of active roster members across all rosters sharing
  that role, diffs the two sets, and removes anyone in the holder set but
  not in the union set.
- Removal is retried on transient Discord errors. The bot is fail-closed:
  if the guild member list cannot be read, no removals are performed so
  legitimate members are never accidentally stripped.
- A new database migration extends the channel-sync event-type CHECK
  constraint to include `roster_role_reconcile`.
- The `roster_backfillRoles` / `roster_backfillRolesHelp` i18n keys are
  updated in both English and Czech to reflect the two-way sync.
