---
'@sideline/bot': patch
---

Fix `reorderChannelMessages` corruption that wrote event A's content into event B's Discord message and persisted the wrong `discord_message_id`. Replaced the zip-and-edit strategy with a longest strictly-increasing tail-dominating prefix algorithm: keep prefix entries whose snowflakes already form a valid display order, recreate the suffix in display order so new snowflakes increase monotonically. Added a startup healing pass via bulk `listMessages` that detects missing Discord messages and forces their entries into the recreate set. Added an in-process `Effect.Semaphore` registry per channel ID to serialise concurrent reorders. Capped channel events at 10, with cap-dropped Discord messages cleaned up. Refactored `editMessage` to surface a typed `EditOutcome = 'edited' | 'message_gone'` instead of self-healing 10008 inline.
