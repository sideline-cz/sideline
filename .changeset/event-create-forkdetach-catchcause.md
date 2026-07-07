---
"@sideline/bot": patch
---

Fix `/event`-create modal hanging on "Sideline is thinking…" when event creation fails with an untagged defect. The detached fork that resolves the deferred ephemeral reply now has a `catchCause` backstop (mirroring the profile-complete handler) that always updates the original webhook message, so a server-side defect (e.g. a `LogicError.die`) can no longer leave the interaction unresolved.
