---
"@sideline/bot": patch
---

Add a terminal `catchCause` backstop to the `/makanicko leaderboard` command's deferred-reply fork. It caught its `Activity*` errors + `RpcClientError` + REST but not defects, so a server-side `LogicError.die` could leave the deferred reply unresolved ("Sideline is thinking…"). Resolves it with the existing `bot_makanicko_leaderboard_error`, mirroring the event-create backstop.
