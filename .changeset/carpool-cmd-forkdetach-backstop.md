---
"@sideline/bot": patch
---

Add a terminal `catchCause` backstop to the `/carpool` command's deferred-reply fork. Previously it caught `CarpoolForbidden`/`CarpoolGuildNotFound`/`CarpoolNotMember`/REST but not `RpcClientError` from `CreateCarpool`/`SaveCarpoolMessageId` or defects, so a transient RPC failure left the deferred reply unresolved ("Sideline is thinking…"). The backstop always resolves the reply with the existing `bot_carpool_err_generic` message, mirroring the event-create backstop.
