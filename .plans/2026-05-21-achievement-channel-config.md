# Plan — Configurable achievement notification channel

**Bug:** Achievements se posílají do welcome kanálu, přidej nastavení ať si můžu vybrat kam (a jestli vůbec) to posílat
**Notion:** https://www.notion.so/3679350608188046aeaff7abb5189061
**Branch:** `fix/achievement-notification-config`

## Goal

Decouple achievement-earned Discord notifications from the team's welcome channel. Add a per-team `achievement_channel_id`. When `Some(channelId)`, post there. When `None`, posting is disabled entirely (role grants still work).

## Behaviour

| `achievement_channel_id` | `discord_role_id` | Result |
|---|---|---|
| `Some` | `Some` | Embed posted to channel + role granted |
| `Some` | `None` | Embed posted to channel |
| `None` | `Some` | **Role granted, embed skipped** (logged explicitly) |
| `None` | `None` | No-op (already covered) |

Backfill on migration: copy `welcome_channel_id → achievement_channel_id` for existing teams (single transaction, idempotent via `WHERE achievement_channel_id IS NULL`).

## Migration

`packages/migrations/src/before/1786200000_add_achievement_channel.ts`:

```ts
ALTER TABLE teams ADD COLUMN IF NOT EXISTS achievement_channel_id TEXT;
UPDATE teams SET achievement_channel_id = welcome_channel_id WHERE achievement_channel_id IS NULL;
```

Both statements in the same `Effect.Do` chain (SqlClient migration runner wraps each migration file in a transaction).

## Domain (`packages/domain/`)

- `models/Team.ts` — add `achievement_channel_id: Schema.OptionFromNullOr(Snowflake)` after `overview_channel_id`.
- `api/TeamApi.ts`:
  - `TeamInfo`: `achievementChannelId: Schema.OptionFromNullOr(Snowflake)`.
  - `UpdateTeamRequest`: `achievementChannelId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake))`.
- `rpc/achievement/AchievementRpcEvents.ts` — **rename** `welcome_channel_id` → `achievement_channel_id` (audit confirmed no other consumers of the field on this event).

Then run `pnpm build` to refresh the domain dist.

## Server (`applications/server/`)

- `repositories/TeamsRepository.ts`:
  - Extend `TeamUpdateInput` with `achievement_channel_id`.
  - Extend `updateTeamQuery` SQL.
  - Extend the `update()` function input type.
  - `insertQuery` does **not** need the new column — new teams default to NULL (consistent with how `system_log_channel_id`, `rules_channel_id`, `overview_channel_id` are handled today).
- `repositories/AchievementSyncEventsRepository.ts`:
  - Row schema: rename `welcome_channel_id` → `achievement_channel_id`.
  - JOIN query: `t.achievement_channel_id AS achievement_channel_id`.
- `rpc/achievement/events.ts` — `constructEvent` passes the renamed field.
- `api/team.ts`:
  - `teamToInfo` exposes `achievementChannelId`.
  - `updateTeamInfo` mirrors the `welcome_channel_id` Option-match pattern.
  - Do **not** add to `hasOnboardingFieldChange` — achievement channel is not onboarding.
- `api/auth.ts` (`createTeam`) — pass `achievement_channel_id: Option.none()` to satisfy the `Team.Team.insert` schema shape.

## Bot (`applications/bot/`)

- `rcp/achievement/handleAchievementEarned.ts`:
  - Switch reads from `event.welcome_channel_id` to `event.achievement_channel_id` (lines ~82, 88).
  - Update inline log strings ("welcome channel" → "achievement channel").
  - When `achievement_channel_id` is None and `discord_role_id` is Some, emit an explicit log: `"Granted achievement role <id>; skipped embed (achievement channel not configured)"`.

## Web (`applications/web/`)

- `components/pages/TeamSettingsPage.tsx`:
  - Add state `achievementChannel` mirroring `welcomeChannel`/`systemLogChannel`.
  - Add SearchableSelect in the existing **Welcome Message** card, **after the system-log-channel block**, before the welcome template Textarea. (Keeping it here matches the existing visual grouping of channel selectors. Copy is explicit so it's unambiguous.)
  - Wire into `hasWelcomeChanges` and `handleSaveWelcome`.
  - Add `achievementChannelId: Option.none()` to the other partial-update callers (`handleSaveProfile`, `handleSaveOnboarding`, `handleRetryOnboarding`) to follow the established convention.
- `packages/i18n/messages/{en,cs}.json`:
  - `teamSettings_achievementChannel`: "Achievement channel" / "Kanál pro úspěchy"
  - `teamSettings_achievementChannelHelp`: "Discord channel where members are notified when they earn an achievement. Select 'None' to stop posting achievement notifications." / Czech equivalent.
  - `teamSettings_achievementChannelDisabled`: "None — don't post achievements" / "Žádný — neposílat oznámení o úspěších"

## Tests (TDD)

### `applications/bot/test/rcp/achievement/handleAchievementEarned.test.ts`
- Rename `welcome_channel_id` references → `achievement_channel_id`.
- Existing "posts embed" / "skips embed" tests are renamed (assertions unchanged).
- **New**: `'role still granted when achievement_channel_id is None'` — asserts `addGuildMemberRole` called, `createMessage` not called.
- Update regression-guard list to include `welcome_channel_id` as a field that must NOT exist on `AchievementEarnedEvent`.

### `applications/server/test/integration/repositories/AchievementSyncEventsRepository.test.ts`
- Rename test names + assertions: `welcome_channel_id` → `achievement_channel_id`.
- `createTeam` helper: accept `achievementChannelId` parameter.
- **New**: `'findUnprocessed returns achievement_channel_id=None when team has it disabled'`.

### `applications/server/test/api/teamOnboarding.test.ts`
- Update the in-memory `teamState` mock to include `achievement_channel_id`.
- **New**: `'updating only achievementChannelId does NOT enqueue an onboarding sync'`.

### Test fixture fanout (~20 files)
Add `achievement_channel_id: Option.none()` to every `createTeam` / `repo.insert` literal that exhaustively lists all Team fields. List of affected files (from grep):
- `applications/server/test/Team.test.ts`
- `applications/server/test/RsvpReminder.test.ts`
- `applications/server/test/rpc/RegisterMember.test.ts`, `OnboardingSync.test.ts`
- All `applications/server/test/integration/repositories/*.test.ts`

Mechanical change — no shared helper extraction (out of scope).

## Risks & non-goals

- **Rolling deploy race**: window between migration and code rollout. Backfill is idempotent (`WHERE achievement_channel_id IS NULL`). Worst case: a captain who changes welcome channel during the deploy window ends up with the *old* welcome channel as their achievement channel until they explicitly set it. Acceptable — single-tenant SaaS scale.
- **No callout/banner** in UI for the migration. Behaviour is preserved by the backfill; helper text is self-documenting.
- **`welcome_channel_id` remains** on `teams` and is still used by invite generator, onboarding payloads, guild RPC, etc. Only the achievement consumer moves.
- **No Discord slash command** to set this — consistent with how every other channel setting is configured.

## Changeset

`patch` for: `@sideline/domain`, `@sideline/server`, `@sideline/bot`, `@sideline/web`, `@sideline/migrations`, `@sideline/i18n`.

## Docs

- `docs/database.md` — note new `teams.achievement_channel_id` column.
- `docs/thesis/er-diagram.md` — add the column to the `teams` entity.
- Skip `applications/docs` updates unless an existing page directly enumerates per-team channel settings.

## Step order for the developer

1. Write all failing tests first (TDD).
2. Create migration.
3. Update domain (`Team`, `TeamApi`, `AchievementRpcEvents`).
4. `pnpm build` (mandatory before server/bot type-check).
5. Update server (`TeamsRepository`, `AchievementSyncEventsRepository`, `rpc/achievement/events.ts`, `api/team.ts`, `api/auth.ts`).
6. Update bot (`handleAchievementEarned.ts`).
7. Update web (`TeamSettingsPage.tsx` + i18n).
8. Fan out test fixtures.
9. `pnpm codegen && pnpm check && pnpm test`.
10. Optionally `pnpm test:integration` (Docker).
11. Add changeset and docs updates.
