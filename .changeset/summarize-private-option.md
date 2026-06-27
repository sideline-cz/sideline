---
"@sideline/bot": patch
"@sideline/i18n": patch
---

Add an optional `private` flag to `/summarize`

`/summarize` now takes an optional `private` boolean (default true). Left at the
default the summary stays ephemeral (only the invoker sees it, as before); set
`private: false` to post the summary publicly to the channel so the whole team
can read it. Because Discord's defer flag is fixed for the rest of the
interaction, the chosen visibility applies to the summary and any post-fetch
status messages alike; pre-defer input errors (no channel, invalid `since`)
remain ephemeral regardless. `allowed_mentions` is still cleared in all cases, so
a public summary never pings anyone. Available in English and Czech.
