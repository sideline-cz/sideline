---
'@sideline/bot': patch
---

Build the `/complete` profile modal with dfx `UI.row`/`UI.textInput` builders instead of raw component object literals, and replace magic-number text-input `style:` values with the `TextInputStyleTypes` enum in the `/complete` and `/event create` modals. Adds a shape-regression test for the `/complete` modal. Behavior-preserving (identical Discord API payload).
