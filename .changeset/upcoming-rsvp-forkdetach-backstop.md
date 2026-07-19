---
"@sideline/bot": patch
---

Add a terminal `catchCause` backstop to the three deferred-reply-resolving upcoming-RSVP interaction forks. They caught `RpcClientError` + REST but not defects (and drive several extra RPCs via `postRsvpDiscordUpdates` / `renderUpcomingPagePayload` that could die), so a server-side defect could leave the deferred reply unresolved ("Sideline is thinking…"). Resolves it with the existing `bot_event_list_error`, mirroring the event-create backstop.
