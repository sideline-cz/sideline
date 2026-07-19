---
"@sideline/bot": patch
---

Add a terminal `catchCause` backstop to the two deferred-reply-resolving attendees interaction forks. They caught `RpcClientError` + REST but not defects (and `buildAttendeesEmbed` is an extra defect source), so a server-side defect could leave the deferred reply unresolved ("Sideline is thinking…"). Resolves it with the existing `bot_attendees_load_error`, mirroring the event-create backstop.
