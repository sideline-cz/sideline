# Discord Native Onboarding (Welcome Screen + Server Guide + Rules Prompt)

**Status:** Backlog (deferred from slim v1 of bug 35993506-0818-81cc-a39c-ea1b82f64090)
**Type:** Bug / feature follow-up

## Problem

When a new member joins a Sideline-managed Discord guild for the first
time, Discord renders its native **Welcome Screen** + **Server Guide**
based on the guild's onboarding configuration. We currently push no
configuration, so members see Discord's default empty experience.

We also don't enforce a "read the rules" gate before granting access
to the rest of the server — anyone with the bot's entry role can post
immediately. Captains have no Sideline-managed way to require
acknowledgement.

## Goal

Sideline owns the per-team onboarding configuration:

1. **Welcome Screen** — short server description + 3 featured channels
   (rules, welcome, training) with emoji and one-line copy.
2. **Server Guide** — per-channel emoji + descriptions for the same
   featured channels (Discord renders these as the "first steps" cards).
3. **Single rules-acknowledgement prompt** — required, single-select,
   one option ("I've read the rules") that grants the team's entry
   role. No other prompts (per memory: roles/positions are
   captain-assigned, no member self-select).

Configuration is **server-side state** (in our DB), pushed to Discord
whenever the team's settings change. The bot enforces the
configuration; captains never edit raw onboarding JSON.

## Out of scope (explicitly)

- Multi-prompt onboarding (group selection, position picker, etc.)
- Member self-service role selection
- Custom rules text per server (use the captain's existing #rules
  channel; we just point at it)
- Localizing onboarding copy per joining-user locale (Discord ties
  copy to the server's primary language; pick the team locale at sync
  time)

## Constraints from project memory

- System channel = hidden captain join log; welcome channel =
  per-team-configurable, member-visible.
- Roles/positions are captain-assigned post-join; **no member
  self-select** — so the rules prompt is the *only* prompt.
- Availability is NOT captured at join.

## Architecture

### Schema additions

| Column | Type | Purpose |
|---|---|---|
| `teams.onboarding_rules_role_id` | `TEXT` (Snowflake), nullable | Discord role ID granted when a member completes the rules prompt. Captain picks it from a Discord-roles dropdown in team settings. |
| `teams.onboarding_locale` | `TEXT` (`en`/`cs`), default `en` | Drives the language of Welcome Screen + Server Guide copy. |
| `teams.onboarding_synced_at` | `TIMESTAMPTZ`, nullable | Last time we successfully PUT the config to Discord. Used by the sync poll loop to dedupe. |
| `teams.onboarding_sync_status` | `TEXT` (`pending`/`done`/`failed`) default `pending` | Mirrors the pending-guild-joins pattern. |
| `teams.onboarding_sync_error` | `TEXT`, nullable | Last failure reason (e.g. "Community feature not enabled"). |

Alternatively store the sync state in a separate `onboarding_sync_events`
table — see decision in the implementation plan. Recommended:
in-row columns since at most one sync per team is ever needed.

### Bot ↔ server flow

Mirrors the existing `pending_guild_joins` queue pattern:

1. Server flips `teams.onboarding_sync_status = 'pending'` whenever
   any onboarding-relevant column changes (welcome_channel_id,
   onboarding_rules_role_id, onboarding_locale, etc.). Trigger: an
   `AFTER UPDATE` SQL trigger OR explicit call site in the
   `updateTeamInfo` handler.
2. New bot pollLoop service `OnboardingSyncService` calls a new RPC
   `Guild/PendingOnboardingSyncs` returning teams whose status is
   pending.
3. For each team: bot calls
   - `dfx.putGuildsOnboarding(guildId, payload)`
   - `dfx.updateGuildWelcomeScreen(guildId, payload)`
4. Bot calls `Guild/MarkOnboardingSyncDone` or
   `Guild/MarkOnboardingSyncFailed` with the error.

### Read-modify-write semantics (CRITICAL)

`PUT /guilds/{id}/onboarding` **replaces all prompts**. If a captain
manually configured prompts via Discord's UI, our PUT nukes them.

**Mitigation:** GET current onboarding first, find or create the
"Sideline managed: rules acknowledgement" prompt by a stable marker
(prompt title prefix `[Sideline] ` or a known emoji), preserve all
other prompts unchanged, PUT the merged set back.

The marker is a convention, not a Discord-supported tag — document the
edge cases:
- Captain renames our prompt → next sync recreates it as a duplicate.
  Decision: tolerate, log a warning. Alternative: store the prompt's
  `id` in `teams.onboarding_rules_prompt_id` so we update the same
  row. Recommended: store the id.
- Captain deletes our prompt → next sync recreates it. Acceptable.

### Welcome Screen payload

```ts
{
  enabled: true,
  description: t('onboarding.welcomeScreen.description', {teamName}), // ≤140 chars
  welcome_channels: [
    { channel_id: rulesChannelId, description: t('...'), emoji_name: '📜' },
    { channel_id: welcomeChannelId, description: t('...'), emoji_name: '👋' },
    { channel_id: trainingChannelId, description: t('...'), emoji_name: '🏃' },
  ],  // 1–5 channels; omit a slot if its channel is unset
}
```

Channel ids come from existing team settings:
- `rulesChannelId` — needs a new `teams.rules_channel_id` column (analogous to welcome).
- `welcomeChannelId` — `teams.welcome_channel_id` (already exists).
- `trainingChannelId` — derive from the team's existing
  training-channel config (likely already in `team_settings` or
  `discord_channels`).

If `rules_channel_id` is `None`, the rules prompt is also disabled
(can't acknowledge rules you don't have).

### Onboarding payload

```ts
{
  enabled: true,
  mode: GuildOnboardingMode.ONBOARDING_DEFAULT, // 0
  default_channel_ids: [welcomeChannelId, ...otherPublicChannelIds],
  prompts: [
    /* ...preserved non-Sideline prompts... */
    {
      id: teams.onboarding_rules_prompt_id ?? <new>,
      title: t('onboarding.rulesPrompt.title'),
      type: GuildOnboardingPromptType.MULTIPLE_CHOICE, // 0
      single_select: true,
      required: true,
      in_onboarding: true,
      options: [{
        title: t('onboarding.rulesPrompt.option.title'),
        description: t('onboarding.rulesPrompt.option.description'),
        emoji_name: '✅',
        role_ids: [teams.onboarding_rules_role_id],
        channel_ids: [],
      }],
    },
  ],
}
```

### `pending: true → false` detection

Discord doesn't fire a "onboarding completed" event. We infer it from
`GuildMemberUpdate` with `pending: false`.

Stateless implementation (avoid `MemberPendingCache` from the original
plan — it broke on bot restart):
- On `GuildMemberUpdate`, check `member.pending === false` AND the
  member does NOT yet have `onboarding_rules_role_id`. If both, assign
  the role.
- Idempotent: a duplicate event is a no-op because the role is
  already assigned.

This deliberately decouples role-assignment from onboarding-completion
metadata, which is what makes it bot-restart-safe.

### Permissions / preconditions

- Bot needs `MANAGE_GUILD` to call `putGuildsOnboarding`.
- Guild must have **Community features enabled** — `putGuildsOnboarding`
  returns a specific error otherwise.
- On `GuildCreate`, capture `guild.features.includes('COMMUNITY')` into
  `bot_guilds.is_community_enabled`. If false, surface a captain-
  visible warning on team settings: "Onboarding can't be configured
  until you enable Community features in Discord."

## Web UI

Extend `TeamSettingsPage` with an "Onboarding" card:

- **Rules channel** — channel select (text channels only)
- **Onboarding role** — Discord role select (which role members get
  after rules acknowledgement)
- **Locale** — segment control (en / cs)
- **Status** — read-only: "Pending sync", "✅ Synced X minutes ago",
  "❌ Failed: <error>". Manual "Retry now" button when failed.
- Conditional disabled state when `bot_guilds.is_community_enabled === false`,
  with the warning copy above.

## Testing

- Unit: payload-builder pure functions for Welcome Screen + Onboarding
- Unit: read-modify-write merge logic — given existing prompts X, Y
  and our prompt Z, the merged output preserves X+Y and updates Z
- Integration: server `Guild/PendingOnboardingSyncs` returns teams
  whose status is pending, joined with channel/role config
- Bot pollLoop test: mocks listGuildOnboarding + putGuildOnboarding
  and asserts mark-done is called
- E2E: settings page renders the card, save flips status to pending,
  Discord sync status shown after a poll cycle (via mock)

## Risks & open questions

1. **Community-feature requirement** is a hard precondition with no
   programmatic enable. Captain has to do it in Discord first.
   Decision: warn loudly on the settings page; don't block save.
2. **Rate limit on `putGuildsOnboarding`** is aggressive
   (specifics: 10 per minute per guild, per Discord docs). For a small
   server this is irrelevant; for fleet-wide rollouts it's a foot-gun.
   Decision: the pollLoop's 5s cadence + per-team de-duplication
   (`onboarding_sync_status = 'pending'` only) keeps us well under.
3. **Preserved prompts surviving an `id` change** — Discord allows
   captains to delete and recreate prompts; the `id` changes. If our
   stored `onboarding_rules_prompt_id` is stale, we get a 404 on the
   PUT. Decision: on 404, treat as "create new prompt", regenerate id,
   continue.
4. **Locale strings** must be authored once per locale and managed in
   `@sideline/i18n`. Bot reads `teams.onboarding_locale` and resolves
   strings server-side; the bot does NOT hold its own locale state.

## Migration path for existing teams

- Existing teams: `onboarding_sync_status = 'pending'` after migration
  applies. The pollLoop syncs them on next tick.
- Teams without `rules_channel_id` configured: skip the rules prompt
  entirely; only push the Welcome Screen (or skip both if no welcome
  channel either).
- Bot restart-safe: pending status persists in the DB.

## Estimate

- Migration + 2 new RPCs + bot service + web card + tests + i18n
- ~400-600 LOC across server/bot/web
- 1-2 sessions

## Acceptance

- [ ] Captain can configure rules channel + onboarding role + locale
- [ ] Saving the form triggers a sync within 5s (pollLoop cadence)
- [ ] On a fresh team, the Welcome Screen renders with 3 featured channels
- [ ] On a fresh team, the rules prompt blocks access until acknowledged
- [ ] Member completing the prompt receives the entry role
- [ ] Captain who manually adds a 2nd prompt to onboarding does not
      lose it after a Sideline sync
- [ ] Disabling the Community feature shows a warning, doesn't crash
- [ ] Existing manually-configured prompts on a guild are preserved
