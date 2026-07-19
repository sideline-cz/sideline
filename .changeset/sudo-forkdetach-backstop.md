---
"@sideline/bot": patch
---

Add a terminal `catchCause` backstop to the `SudoLeaveButton` deferred-reply fork. Its inner `ensureSudoRole`/`deleteGuildMemberRole` chain only handled `ErrorResponse` and the outer catch only `RpcClientError`, so a transient `HttpClientError`/`RatelimitedResponse` from the role deletion — or an untagged defect — left the deferred reply unresolved ("Sideline is thinking…"). The backstop always resolves it with the existing `bot_sudo_err_generic` message, mirroring the event-create backstop.
