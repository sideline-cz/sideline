---
"@sideline/bot": patch
---

Add a terminal `catchDefect` backstop to the four remaining deferred-reply poll interaction forks (`PollOpenButton`, `PollVoteButton`, `PollAddModalSubmit`, `PollCloseButton`). They already caught `RpcClientError` + REST, but an untagged defect (a renderer throw or a server-side `LogicError.die`) would die in the forked fiber and leave the deferred reply blank ("Sideline is thinking…"). Resolves it with the existing `bot_poll_err_generic`, mirroring the poll-voters / poll-remove defect backstops already in the file.
