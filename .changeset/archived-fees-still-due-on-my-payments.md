---
'@sideline/server': patch
---

Stop archived fees reading as due on My Payments.

`FeeAssignmentsRepository.findByTeamMember` — which feeds both `finance.myStatus` and
`finance.listMemberAssignments` — never filtered `fees.archived_at`. Archiving a fee therefore
silenced its reminders (#726) and excluded it from settle and bank matching, but the member kept
seeing it listed as awaiting payment with no way to clear it.

Assignments on an archived fee are now hidden unless `paid_minor > 0`, so what a member actually
paid stays visible as history rather than last season's dues vanishing from their own record.
