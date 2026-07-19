---
"@sideline/bot": patch
---

Add a terminal `catchCause` backstop to the `/finance status` command's deferred-reply fork. It caught `RpcClientError` + REST but not defects, so a server-side `LogicError.die` could leave the deferred reply unresolved ("Sideline is thinking…"). Resolves it with the existing `bot_finance_error_generic`, mirroring the event-create backstop.
