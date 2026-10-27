---
"@sideline/server": minor
"@sideline/bot": minor
"@sideline/domain": minor
"@sideline/migrations": minor
"@sideline/web": patch
"@sideline/i18n": patch
---

Add `/login` — a Discord slash command that hands you a one-time link opening the web app already signed in, with no OAuth round-trip.

The link carries a **single-use exchange token**, not a session token. 32 bytes from `randomBytes`, stored only as `sha256` in the new `discord_login_tokens` table, swapped server-side at `GET /auth/link/:token` for a real session. There is no secret comparison anywhere: the lookup is on the hash, so no constant-time compare is needed.

The link lives 5 minutes and redeems once — the claim is one `UPDATE ... WHERE consumed_at IS NULL`, so a second redemption matches zero rows. The session it mints lasts 7 days, shorter than the OAuth path's 30, because this path has no interactive consent step. Issuing a link revokes every outstanding one for that user, so "that went to the wrong place" is answered by running `/login` again, and a spammed command still leaves exactly one live token.

Delivery is enforced by ordering, not by care: the handler returns a deferred **ephemeral** ack before the RPC that mints the token runs, so no token can exist while a public response is still reachable. The link rides in a link button and an inline code span and never as bare message content — Discord's unfurler would otherwise GET it and redeem it before the user clicked. Covered by tests asserting the response flags, that the channel-posting REST call is never reached, and that the URL never appears bare.

Issuance is rate limited to 5/hour and 20/day per user, and recorded in the log and the token row — deliberately not announced to the team system channel, unlike `/sudo`: this is someone reaching their own account, and a broadcast would tell a channel the moment a fresh credential exists.
