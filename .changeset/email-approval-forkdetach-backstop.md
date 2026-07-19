---
"@sideline/bot": patch
"@sideline/i18n": patch
---

Add a terminal `catchCause` backstop to the email-decision interaction fork (shared by `EmailApproveButton`, `EmailRejectButton`, `EmailSendOriginalButton`). Previously it caught `EmailApprovalForbidden`/`EmailRpcMessageNotFound`/REST but not `RpcClientError` or defects, so a transient RPC failure or a server-side defect left the moderator's deferred reply unresolved ("Sideline is thinking…"). Adds a `bot_email_error` generic message; the backstop always resolves the reply, mirroring the event-create backstop.
