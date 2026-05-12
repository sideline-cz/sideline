---
'@sideline/domain': minor
'@sideline/server': minor
'@sideline/web': patch
'@sideline/i18n': patch
---

Add manual "Sync Discord role" action on the group detail page. Reconciles the Discord role's membership with the group's current member list — useful when the bot was offline, after a manual member import, or when a member joins the Discord guild later. Adds missing role-holders and removes role from team members who left the group. Events are batched into a single multi-row INSERT and wrapped in a transaction for consistency.
