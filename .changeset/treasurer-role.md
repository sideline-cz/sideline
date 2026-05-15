---
'@sideline/domain': patch
'@sideline/migrations': patch
'@sideline/server': patch
---

Introduce a built-in `Treasurer` role that holds the money-moving finance permissions (`finance:manage_fees`, `finance:record_payments`) so teams can delegate finance authority without elevating to Admin. Captain's finance scope narrows to `finance:view` only. Admin keeps every permission. Migration `1784000000` creates Treasurer for every existing team and backfills missing finance/activity-type permissions on legacy Admin and Captain rows. The migration is additive — it never deletes existing `role_permissions` rows.
