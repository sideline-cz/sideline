---
"@sideline/bot": patch
---

Close the remaining `/event`-create failure path where a malformed input (event type, snowflake, or training-type id) could kill the modal handler with "This interaction failed". The `decodeUnknownSync` calls previously ran eagerly in the handler body — before the deferred reply was forked — so a decode throw escaped the `catchCause` backstop. They now run inside an `Effect.suspend` on the forked fiber, so any decode failure becomes a defect the backstop resolves with the generic error message. Adds a regression test for the malformed-event-type path.
