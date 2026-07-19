---
"@sideline/bot": patch
---

Add a terminal `catchCause` backstop to the roster-approval interaction fork. It caught `RpcClientError` + REST but not defects, so a server-side `LogicError.die` (or renderer throw) surfaced as a defect could leave the deferred reply unresolved ("Sideline is thinking…"). Resolves it with the existing `bot_roster_ephemeral_error`, mirroring the event-create backstop.
