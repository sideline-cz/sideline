---
'@sideline/bot': patch
---

Replace magic-number `style:` literals with dfx enums across the `interactions/*` handlers (carpool, poll, roster-approval, rsvp, upcoming-rsvp, email-approval). Button styles use `ButtonStyleTypes` and text-input styles use `TextInputStyleTypes`, each mapped per its kind (the same integer means different things on a button vs a modal text input). Behavior-preserving (identical Discord API payload).
