---
"@sideline/server": patch
---

fix: Discord role sync failing when more than one event row is produced

The multi-row batch INSERT helpers in `ChannelSyncEventsRepository` (and
`EmailAttachmentsRepository`) used `sql.join(',')`, whose default `addParens`
wraps the whole `VALUES` list in an extra pair of parens. Single-row inserts
worked, but two or more rows produced `VALUES ((row1),(row2))`, which Postgres
rejects with "INSERT has more target columns than expressions" — surfacing as
"Failed to start Discord role sync" on the group detail page. Switched these
inserts to `sql.join(',', false)`.
