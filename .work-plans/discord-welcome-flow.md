# Discord Welcome Flow — Slim V1

**Bug:** 35993506-0818-81cc-a39c-ea1b82f64090
**Branch:** `feat/discord-member-onboarding`

## Goal
Members joining via web-app invites get a deliberate, branded welcome
in their team's welcome channel and a structured audit log entry in
the captain-only system channel. Invites are bound to a target group;
joining members are auto-added to that group.

## Scope (cuts vs. original)

**In:**
- `team_invites.group_id` → group-targeted invites
- Team welcome-channel + system-log-channel + welcome-message-template
- Welcome embed (member-visible) on join
- System-log embed (captain-only) on join
- Invite-use cache in bot (lazy seed, gateway events keep live, REST diff on join)
- Web: new TeamInvitesPage, group picker on create, welcome card on team settings

**Out (deferred to follow-up bugs):**
- Discord native Onboarding (PUT /guilds/{id}/onboarding)
- Welcome Screen / Server Guide / rules-ack prompt
- `OnboardingSyncService`, `MemberPendingCache`, `onboarding_sync_events` table
- `maxUses` per-invite, QR codes
- `teams.locale` column (bot strings hardcode 'en' for v1 system-log labels;
  welcome message body is captain-authored anyway)

## Tasks (implementation order)

1. **Migration** `1746500000_add_invite_groups_and_welcome.ts`
   - `team_invites.group_id UUID REFERENCES groups(id) ON DELETE SET NULL`
   - `teams.welcome_channel_id TEXT`
   - `teams.system_log_channel_id TEXT`
   - `teams.welcome_message_template TEXT`

2. **New shared package** `@sideline/template-renderer`
   - Pure (no Effect deps, web-friendly)
   - `applyTemplate(template, vars)` — `{memberMention, memberName, inviterMention, inviterName, groupName, teamName}` substitution; unknown placeholders left intact
   - `sanitizeRendered(rendered)` — neuters `@everyone`/`@here`, hard-truncates to 4096
   - `sanitizeHexColor(hex)` — validates `^#[0-9a-f]{6}$`, falls back to Discord blurple

3. **Domain** (`@sideline/domain`)
   - `TeamInvite.group_id: Option<GroupId>`
   - `Team` adds three Option fields above
   - `Invite` API: new `createInvite`, `listInvitesForTeam`; extended `getInvite` (returns `groupName`, `inviterName`); `regenerateInvite` kept as deprecated alias
   - `RegisterMember` RPC: `invite_code: Option<string>` payload; success returns `Option<{welcome_channel_id, system_log_channel_id, welcome_message_rendered, group_name, group_color_int, inviter_discord_id, team_locale}>`

4. **Server**
   - `TeamInvitesRepository.findByCodeWithContext` (joins users + teams + groups)
   - `TeamInvitesRepository.listForTeam`
   - `Invite` API: `createInvite` validates group belongs to team (`InvalidGroup` 400); `regenerateInvite` becomes alias delegating to `createInvite(None, +14d)` + existing deactivation sweep
   - `registerMemberLogic`: extended with invite-code resolution; idempotent group-join via `catchUniqueViolation`; pre-renders + sanitizes welcome message server-side; resolves inviter Discord ID from `invite.created_by → users.discord_id`

5. **Bot**
   - `services/InviteCache.ts` — `Ref<Map<guildId, Map<code, uses>>>`. Lazy seed (no eager fetch on `GUILD_CREATE`). Coalesce concurrent fetches per guild.
   - `services/inviteDiff.ts` — pure `(before, after) → Option<code>`. Replace-on-diff strategy; returns `None` on first-add since boot or on multi-candidate ambiguity.
   - `services/welcomeRenderer.ts` — pure embed builders consuming RPC payload + `@sideline/i18n` for labels.
   - `events/index.ts` — add `inviteCreate`, `inviteDelete`. `guildMemberAdd` now: list invites → diff → pass `invite_code` to RPC → on `Some` welcome metadata, post embed to welcome channel + system-log embed to system channel. `allowed_mentions: { parse: [], users: [memberId, inviterId] }`. Discord post failures never block member registration.

6. **i18n** keys for invite list, create dialog, team settings welcome card, bot embed labels (en + cs).

7. **Web**
   - New route `/teams/$teamId/invites` (ssr: false) with `TeamInvitesPage`
   - `CreateInviteDialog` (group picker + expiry preset)
   - Welcome message card on `TeamSettingsPage` (channel selects + textarea + live preview using shared `applyTemplate`/`sanitizeRendered`)
   - `InvitePage` shows resolved group name when present

8. **Tests** (TDD — written before implementation)
   - `template-renderer`: applyTemplate (10), sanitize (5), color (7)
   - `bot`: inviteDiff (7 cases), InviteCache, welcomeRenderer
   - `server`: TeamInvitesRepository integration, Invite API integration, RegisterMember RPC integration
   - Bot event registration (extend existing — `inviteCreate`/`inviteDelete` present)

9. **Docs**
   - `docs/database.md` — new columns + FK
   - `docs/discord-bot.md` — invite events + welcome flow
   - `applications/docs/.../guides/discord-integration.mdx` — captain-facing copy
   - `docs/thesis/{er-diagram,sequence-diagrams}.md` — diagrams

## Key design decisions

| # | Decision |
|---|----------|
| 1 | Inviter Discord ID = `invite.created_by` user's Discord ID; surfaced via RPC payload |
| 2 | `regenerateInvite` kept as alias one release; removal noted in changelog |
| 3 | `team_invites.group_id` ON DELETE SET NULL (group delete clears the link; invite still resolves with no group) |
| 4 | InviteCache: lazy seed + coalesced REST + replace-on-diff (no thundering herd on bot start) |
| 5 | Rendering safety: server-side `sanitizeRendered` + bot `allowed_mentions` belt-and-braces |
| 6 | Group color: `sanitizeHexColor` single source of truth, blurple fallback |
| 7 | Shared renderer in new `packages/template-renderer` (web doesn't pull Effect transitively) |
| 8 | Migration timestamp `1746500000` (strictly larger than current max `1746100000`) |
| 9 | Group join idempotent via `SqlErrors.catchUniqueViolation` |
| 10 | Bot strings hardcode 'en' for v1; team-locale column deferred |
| 11 | Existing single-invite teams: `group_id` defaults NULL; UI renders "All members" |

## Risks (accepted)

- **Stale browser tabs hitting `regenerateInvite`** → alias keeps working
- **Bot startup misses `INVITE_CREATE` events fired before connect** → lazy seed recovers; one-time cache miss → `None` from diff → server still registers member, no welcome posted that one time
- **Single-use invite race (deleted before GuildMemberAdd)** → diff sees code missing in fresh fetch; fall back to vanity check; if still no match → `None`. Member still registered, no welcome.

## Open questions resolved

- **Team locale source**: deferred. Hardcode 'en' for v1 system-log labels.
- **Channel verification**: skip; log + continue on missing channel.
- **`InviteListItem.createdByUsername`**: yes, server JOINs users for inviter username.
