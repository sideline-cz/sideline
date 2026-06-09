---
"@sideline/domain": minor
"@sideline/server": minor
"@sideline/bot": minor
"@sideline/migrations": minor
"@sideline/i18n": patch
---

Add interactive tournament attendance tracking. Tournament events now post a
"Request to join" board; members request a spot, captains (with `roster:manage`)
review each request with Accept/Decline buttons, and accepted members are tracked
as the event's attendance. Backed by a new `event_join_requests` table and two
new sync events, mirroring the training-claim flow.
