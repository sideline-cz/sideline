---
"@sideline/bot": patch
---

fix: downgrade transient sync-poll upstream errors from Error to Warning

When the server/proxy returned a 502 with a non-JSON body, the bot's NDJSON RPC
deserializer threw a `SyntaxError` that surfaced as `Sync poll tick failed`
logged at Error with a full stack, even though the poll loop self-heals on the
next tick. Poll ticks now classify NDJSON parse failures and 5xx upstream
responses as transient: they log at Warning and increment
`syncEventsFailedTotal{sync_type:"poll_tick_transient"}` so a sustained outage
stays alertable, while genuine errors still log at Error.
