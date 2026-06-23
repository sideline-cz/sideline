---
"@sideline/bot": patch
---

fix: channel sync events looping forever on permanent Discord errors

`isPermanentError` in the channel sync processor read the Discord error code
and HTTP status from the top level of the error (`e.code` / `e.status`), but
dfx's `DiscordRestError` nests them at `e.data.code` and `e.response.status`.
Both reads were therefore `undefined`, so every Discord REST failure — including
permanent ones like `10007 Unknown Member`, `10008 Unknown Message` and
`50013 Missing Permissions` — was misclassified as transient and marked
`MarkEventFailed` (no `processed_at`), causing the event to be re-polled every
~5s forever. Fixed to read the nested fields and treat any non-429 4xx plus the
known Discord error codes as permanent (`MarkEventPermanentlyFailed`), so a
poison event is acknowledged once instead of looping.
