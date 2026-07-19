---
"@sideline/bot": patch
---

Add a terminal `catchCause` backstop to the `/training generate` command's deferred-reply fork. It caught `RpcClientError` + REST but not defects, so a server-side `LogicError.die` could leave the deferred reply unresolved ("Sideline is thinking…"). Resolves it with the existing `bot_training_generate_error`, mirroring the event-create backstop.
