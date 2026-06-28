---
"@sideline/domain": patch
"@sideline/server": patch
"@sideline/bot": patch
---

fix: backfill members into existing Discord group roles on channel-created

The group channel-created handler provisioned or reused a Discord role but never
re-added existing members to it — the same gap that was fixed for rosters. When a
group's Discord role already existed, the handler logged "skipped" and added no
one, so members who joined before the role existed (or were dropped by a past sync
failure) never regained access.

The handler now resolves a single role id across all branches and then runs one
shared, idempotent member-backfill step (retry-while-not-permanent, per-member
failure isolation, concurrency 1), mirroring the roster handler. Backfill is
descendant-aware: a group's role includes members of the group plus all descendant
subgroups, matching how adding a member emits `member_added` for the group and
every ancestor. Adds a team-scoped `Channel/GetGroupMembers` RPC backed by a
recursive descendant query. No database migration.
