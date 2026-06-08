---
"@sideline/domain": patch
"@sideline/server": patch
"@sideline/web": patch
"@sideline/i18n": patch
---

Expose the training claim-request lead time (`claim_request_days_before`) in the web Team Settings UI. Captains can now configure, in a new "Coach assignment" card, how many days before a training the coach claim request is posted (0–30, default 3) — previously only changeable directly in the database. Adds the field to the team-settings API contract (response + partial-update request, bounded 0–30), maps it through the server handler, and renders a number input that is independent of the RSVP reminder toggle.
