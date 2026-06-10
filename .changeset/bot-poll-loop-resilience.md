---
"@sideline/bot": patch
---

Make the bot's sync poll loops resilient to transient failures. Every poller
(`roles`, `channels`, `events`, `email`, `finance`, …) ran as
`processTick.pipe(Effect.repeat(Schedule.spaced(...)))`, and `Effect.repeat`
stops on the first failure — so a single transient error (e.g. an RPC blip
while the server is redeploying) would silently kill that poller until the bot
was restarted. The shared `pollLoop`/`fastPollLoop` now catch and log the whole
cause of a failed tick (including defects) so the loop keeps ticking, while
per-service `tapError` logging still records the specific failure.
