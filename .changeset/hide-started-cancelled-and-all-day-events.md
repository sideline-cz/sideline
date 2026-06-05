---
"@sideline/domain": minor
"@sideline/server": minor
"@sideline/web": minor
"@sideline/bot": minor
"@sideline/migrations": minor
"@sideline/i18n": minor
---

feat(events): hide started/cancelled events by default and support all-day / multi-day events

- The events list now hides `started` and `cancelled` events by default, with a "Show past & cancelled" toggle. The calendar view continues to show all events.
- Events can be marked **all day** (no time), including multi-day spans such as tournaments. An "All day" toggle on the create/edit forms hides the time inputs. All-day events render as date(s) only across the web list, detail, and calendar views, in Discord embeds (date-style timestamps), and in the iCal feed (`VALUE=DATE`).
