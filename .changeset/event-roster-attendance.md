---
"@sideline/domain": minor
"@sideline/server": minor
"@sideline/bot": minor
"@sideline/web": minor
"@sideline/migrations": minor
"@sideline/i18n": patch
---

Link a tournament event to a real roster with a per-pair auto-approve toggle. An
RSVP "yes" drives roster membership: with auto-approve on, the member is added
automatically; with it off, an Approve/Decline request is posted to a dedicated
per-event thread in the owner group's channel and is also actionable on the web
roster detail page. Withdrawing a "yes" removes flow-added members (manual members
are protected) and cancels pending requests; enabling auto-approve backfills current
"yes" responders. Configure and approve from either Discord or the web.
