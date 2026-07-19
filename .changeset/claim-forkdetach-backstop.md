---
"@sideline/bot": patch
"@sideline/i18n": patch
---

Add a terminal `catchCause` backstop to the two deferred-reply-resolving claim interaction forks (`ClaimButton`, `UnclaimButton`). Previously they only caught the REST error tags, so a transient `RpcClientError` or an untagged server-side defect left the ephemeral reply unresolved and the user stuck on "Sideline is thinking…". Adds a `bot_claim_error` generic message and a `withBackstop` helper that always resolves the reply, mirroring the profile-complete / event-create backstop.
