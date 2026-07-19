---
"@sideline/bot": patch
---

Add a terminal `catchCause` backstop to every deferred-reply-resolving carpool interaction fork (add-car, reserve, leave, leave-mine, remove, capacity, assign-pick, kick-pick). Previously these detached forks only caught tagged domain errors, so a transient `RpcClientError` (e.g. a server restart) or an untagged server-side defect left the ephemeral reply unresolved and the user stuck on "Sideline is thinking…". The shared `withBackstop` helper now always resolves the reply with a generic error message on any unhandled failure or defect, mirroring the profile-complete / event-create backstop.
