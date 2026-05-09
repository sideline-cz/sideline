---
'@sideline/domain': minor
'@sideline/server': minor
'@sideline/bot': minor
'@sideline/web': minor
'@sideline/migrations': patch
'@sideline/i18n': patch
---

Add Discord member welcome flow: group-targeted invites, invite-aware welcome messages, and captain audit log.

Captains can now create multiple invites per team, each optionally bound to a specific group. When a member joins, the bot identifies the invite they used (via `INVITE_CREATE`/`INVITE_DELETE` event tracking + REST diff fallback), the server adds them to the invite's target group automatically, and renders a per-team welcome message template into the configured welcome channel. A separate hidden system-log channel receives a structured audit entry for every join — including vanity-URL and unknown-source joins.

Adds:
- `team_invites.group_id` (nullable, `ON DELETE SET NULL`)
- `teams.welcome_channel_id`, `teams.system_log_channel_id`, `teams.welcome_message_template`
- `POST /teams/:teamId/invites` (`createInvite`) — multi-invite per team, optional group binding, expiry preset
- `GET /teams/:teamId/invites` (`listInvitesForTeam`)
- `POST /teams/:teamId/invites/:inviteId/deactivate` (`deactivateInvite`)
- New shared package `@sideline/template-renderer` (pure, no Effect deps) — `applyTemplate`, `sanitizeRendered`, `sanitizeHexColor`
- New web pages: team invites list + create-invite dialog with group picker, welcome-message card on team settings with live preview
- Bot `InviteCache` service (per-guild Ref-based snapshot) + `InviteCreate`/`InviteDelete` event handlers + `GuildInvites` gateway intent

`regenerateInvite` is kept as a deprecated alias delegating to `createInvite(None, +14d)` for one release; will be removed in a future minor. Native Discord Onboarding (Welcome Screen + rules-acknowledgement prompt) is deferred to a follow-up bug.
