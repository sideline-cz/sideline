---
'@sideline/server': patch
'@sideline/web': patch
'@sideline/domain': patch
'@sideline/migrations': patch
'@sideline/i18n': patch
---

Recover gracefully when a user's Discord OAuth token is missing the `guilds.join` scope (e.g. anyone who logged in before PR #255). Previously these users silently failed the auto-join after accepting a web invite and there was no remediation path short of manual log-out / log-in.

The fix is layered:

1. **Detect at login** — the auth callback persists the granted scope list on `oauth_connections.granted_scopes` and, if `guilds.join` is missing, redirects the user back through Discord OAuth once (idempotent, gated on a `scopeRetry` flag in state).
2. **Detect at join** — `joinViaInvite` checks the stored scopes. If the scope is missing it skips the `pending_guild_joins` enqueue and returns `requiresReauth: true`. The web invite page renders a "One more step — connect Discord access" CTA that re-enters the OAuth flow.
3. **Retroactive requeue** — when the scope is newly granted on callback, prior `pending_guild_joins` rows that failed for this user are reset to `pending` so the bot picks them up on the next poll.

Adds:
- `oauth_connections.granted_scopes TEXT NOT NULL DEFAULT ''` (migration `1746800000`)
- `Invite.JoinResult.requiresReauth: boolean`
- `OAuthConnection` helpers: `parseScopes`, `hasScope`, `REQUIRED_DISCORD_SCOPE`
- `OAuthConnectionsRepository.getGrantedScopes`; `PendingGuildJoinsRepository.requeueFailedForUser`
