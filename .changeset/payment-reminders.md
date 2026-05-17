---
'@sideline/domain': patch
'@sideline/migrations': patch
'@sideline/server': patch
'@sideline/bot': patch
---

Send payment reminders via Discord DM and surface them in the personal iCal feed. A new server cron emits five reminder cadences per unpaid fee (T-3, T-0, T+3, T+10, T+21); the bot delivers each as a DM and only records "sent" after a successful Discord delivery so transient failures get retried. The personal iCal feed (`GET /ical/:token`) now includes all-day VEVENTs with a 1-day VALARM for unpaid/partial/overdue assignments within a 180-day window, fixing RFC 5545 DTSTAMP omission on existing event VEVENTs along the way.
