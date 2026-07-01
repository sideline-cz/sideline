---
"@sideline/bot": patch
---

fix: personal-events channel provisioning never spilled into an overflow category

The category-full detection in `handleProvision` checked for Discord error
code `30013`, which is not the code Discord returns when a category hits its
50-channel limit. The real response is `50035` (Invalid Form Body) with a
nested `parent_id` error `CHANNEL_PARENT_MAX_CHANNELS`. Because the check never
matched, the overflow-category creation branch was unreachable: members past
the 50th in a category failed to provision on every poll tick and never got a
personal channel. Detection now keys on `50035` plus the nested
`CHANNEL_PARENT_MAX_CHANNELS` sub-code, so an overflow category is created and
the channel is retried as intended.
