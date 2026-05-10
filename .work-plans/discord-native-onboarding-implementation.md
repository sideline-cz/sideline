# Discord Native Onboarding — Implementation Plan (Revised)

## Overview

We are wiring Discord's native first-run experience (Welcome Screen +
Server Guide + a single mandatory rules-acknowledgement Onboarding
prompt) into Sideline. The captain configures three knobs in the web
team-settings page (rules channel, entry role, locale); the server
persists them on `teams`; a new bot poll-loop service syncs the merged
configuration into Discord (read-modify-write so manually authored
prompts are preserved); a `GuildMemberUpdate` handler grants the entry
role when `pending` flips to `false`.

Apps touched: `packages/migrations`, `packages/domain`,
`packages/i18n`, `applications/server`, `applications/bot`,
`applications/web`. Spec: `.work-plans/discord-native-onboarding.md`.
UX spec: `.work-plans/discord-native-onboarding-design.md`.

**Deployment order (mandatory):** server first (handles new RPCs:
`Guild/SyncCommunityFlags`, `Guild/ListGuildRoles`, etc.) → bot second
(calls `SyncCommunityFlags` on `READY`, exposes `ListGuildRoles` data
to the server). The web tier can ship anytime after server.

## 1. Schema & migration

**New file:** `packages/migrations/src/before/1747000000_add_onboarding_columns.ts`
(slot the timestamp after the latest migration
`packages/migrations/src/before/1746800000_add_oauth_granted_scopes.ts`).
Use the existing template style — `Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) => sql\`…\`)` —
exactly as in
`packages/migrations/src/before/1746500000_add_invite_groups_and_welcome.ts:4-17`.

```sql
ALTER TABLE teams
  ADD COLUMN rules_channel_id            TEXT,
  ADD COLUMN onboarding_rules_role_id    TEXT,
  ADD COLUMN onboarding_rules_prompt_id  TEXT,
  ADD COLUMN onboarding_locale           TEXT NOT NULL DEFAULT 'en'
                                         CHECK (onboarding_locale IN ('en','cs')),
  ADD COLUMN onboarding_synced_at        TIMESTAMPTZ,
  ADD COLUMN onboarding_sync_status      TEXT NOT NULL DEFAULT 'pending'
                                         CHECK (onboarding_sync_status
                                           IN ('pending','syncing','done','failed')),
  ADD COLUMN onboarding_sync_error       TEXT;

ALTER TABLE bot_guilds
  ADD COLUMN is_community_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE discord_guild_roles (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    TEXT NOT NULL REFERENCES bot_guilds(guild_id) ON DELETE CASCADE,
  role_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  color       INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL DEFAULT 0,
  managed     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, role_id)
);
CREATE INDEX idx_discord_guild_roles_guild_id ON discord_guild_roles (guild_id);

CREATE INDEX idx_teams_pending_onboarding
  ON teams (updated_at)
  WHERE onboarding_sync_status = 'pending';

CREATE INDEX idx_teams_syncing_onboarding
  ON teams (updated_at)
  WHERE onboarding_sync_status = 'syncing';
```

**Status machine (4 states):**

| State | Set by | Cleared by |
|---|---|---|
| `pending` | initial default; HTTP `updateTeamInfo` (when an onboarding-relevant field actually changes); HTTP `retryOnboardingSync`; conditional flip-back in `MarkSyncDone/Failed` if a captain re-saved mid-sync | bot pollLoop's atomic claim |
| `syncing` | bot pollLoop atomic claim (`UPDATE teams SET onboarding_sync_status='syncing' WHERE onboarding_sync_status='pending' RETURNING ...`) | `MarkOnboardingSyncDone` / `MarkOnboardingSyncFailed` (conditional UPDATE — see §4) |
| `done` | `MarkOnboardingSyncDone` (only if row is still in `syncing`) | next captain re-save flips back to `pending` |
| `failed` | `MarkOnboardingSyncFailed` (only if row is still in `syncing`) | captain hits Retry → `pending` |

The atomic claim + conditional MarkDone protects against (a) concurrent
captain saves mid-sync (the row flips from `syncing` back to `pending`
during PUT; MarkDone's `WHERE … AND status='syncing'` becomes a no-op,
leaving the row `pending` so the next pollLoop tick picks it up with
fresh config) and (b) horizontally-scaled bot replicas (only one
replica wins the claim per row).

The `CHECK` clauses mirror the convention of
`packages/migrations/src/before/1746700000_create_pending_guild_joins.ts:11`.
Both partial indexes mirror the same file line 19. Existing rows
default to `onboarding_sync_status = 'pending'`, which makes the
pollLoop pick them up on the next tick (acceptance criterion in
`discord-native-onboarding.md:227-234`). The migration deliberately
does **not** backfill `is_community_enabled` — the bot's `READY`
handler does that via `Guild/SyncCommunityFlags` (see §5).

## 2. Domain package (`@sideline/domain`)

### `packages/domain/src/models/Team.ts:9-22`

Extend `Team.Class` with seven new fields. Match the
`Schema.OptionFromNullOr(...)` pattern already used for `description`,
`welcome_channel_id` etc.

```ts
rules_channel_id: Schema.OptionFromNullOr(Snowflake),
onboarding_rules_role_id: Schema.OptionFromNullOr(Snowflake),
onboarding_rules_prompt_id: Schema.OptionFromNullOr(Snowflake),
onboarding_locale: OnboardingLocale,
onboarding_synced_at: Schema.OptionFromNullOr(Schema.DateTimeFromDate),
onboarding_sync_status: OnboardingSyncStatus,
onboarding_sync_error: Schema.OptionFromNullOr(Schema.String),
```

### New file: `packages/domain/src/models/Onboarding.ts`

```ts
import { Schema } from 'effect';

export const OnboardingLocale = Schema.Literal('en', 'cs').pipe(
  Schema.brand('OnboardingLocale'),
);
export type OnboardingLocale = typeof OnboardingLocale.Type;

export const OnboardingSyncStatus = Schema.Literal(
  'pending', 'syncing', 'done', 'failed',
).pipe(Schema.brand('OnboardingSyncStatus'));
export type OnboardingSyncStatus = typeof OnboardingSyncStatus.Type;

/** Typed error code stored in teams.onboarding_sync_error. */
export const OnboardingSyncErrorCode = Schema.Literal(
  'community_not_enabled',
  'role_deleted',
  'channel_deleted',
  'rate_limited',
  'discord_error',
  'network_error',
  'unknown',
).pipe(Schema.brand('OnboardingSyncErrorCode'));
export type OnboardingSyncErrorCode = typeof OnboardingSyncErrorCode.Type;
```

The web layer renders actionable copy keyed by `OnboardingSyncErrorCode`.
The DB column stays `TEXT` and stores the code as-is (free-text fallback
`unknown` for anything we don't classify).

Re-export from the package barrel.

### `packages/domain/src/api/TeamApi.ts:8-39`

- Extend `TeamInfo` with: `rulesChannelId`, `onboardingRulesRoleId`,
  `onboardingLocale`, `onboardingSyncStatus`, `onboardingSyncedAt`,
  `onboardingSyncError`, `isCommunityEnabled` (read-only flag from
  joined `bot_guilds`).
- Extend `UpdateTeamRequest` (line 20-38) with the three captain-
  editable fields:

  ```ts
  rulesChannelId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  onboardingRulesRoleId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  onboardingLocale: Schema.OptionFromOptional(OnboardingLocale),
  ```

- Add a third endpoint (after the existing `updateTeamInfo` at line 50):

  ```ts
  .add(
    HttpApiEndpoint.post('retryOnboardingSync', '/teams/:teamId/onboarding/retry', {
      success: TeamInfo,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  ```

### `packages/domain/src/rpc/guild/GuildRpcGroup.ts:5-108`

Six new RPCs. Follow the existing `Rpc.make(...)` style and keep the
`'Guild/'` prefix at line 108.

```ts
Rpc.make('PendingOnboardingSyncs', {
  payload: { limit: Schema.Number },                    // batch cap, see §5
  success: Schema.Array(
    Schema.Struct({
      team_id: Team.TeamId,
      guild_id: Discord.Snowflake,
      team_name: Schema.String,
      onboarding_locale: OnboardingLocale,
      rules_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
      welcome_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
      training_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
      onboarding_rules_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
      onboarding_rules_prompt_id: Schema.OptionFromNullOr(Discord.Snowflake),
      is_community_enabled: Schema.Boolean,
    }),
  ),
}),
Rpc.make('MarkOnboardingSyncDone', {
  payload: {
    team_id: Team.TeamId,
    prompt_id: Schema.OptionFromNullOr(Discord.Snowflake),
  },
  success: Schema.Struct({ updated: Schema.Boolean }),  // false if row left pending
}),
Rpc.make('MarkOnboardingSyncFailed', {
  payload: {
    team_id: Team.TeamId,
    error_code: OnboardingSyncErrorCode,
    error_detail: Schema.String,
  },
  success: Schema.Struct({ updated: Schema.Boolean }),
}),
Rpc.make('GetOnboardingRulesRoleId', {
  payload: { guild_id: Discord.Snowflake },
  success: Schema.OptionFromNullOr(Discord.Snowflake),
}),
Rpc.make('SyncCommunityFlags', {
  payload: {
    guilds: Schema.Array(
      Schema.Struct({
        guild_id: Discord.Snowflake,
        is_community_enabled: Schema.Boolean,
      }),
    ),
  },
}),
Rpc.make('ListGuildRoles', {
  payload: { guild_id: Discord.Snowflake },
  success: Schema.Array(
    Schema.Struct({
      id: Discord.Snowflake,
      name: Schema.String,
      color: Schema.Number,
      position: Schema.Number,
      managed: Schema.Boolean,
    }),
  ),
}),
// Read from `discord_guild_roles` table (kept in sync by the bot via
// `GuildRoleCreate/Update/Delete` events plus a READY-time bulk
// upsert). NOT a live REST proxy. See §5 below.
Rpc.make('SyncGuildRoles', {
  payload: {
    guild_id: Discord.Snowflake,
    roles: Schema.Array(
      Schema.Struct({
        role_id: Discord.Snowflake,
        name: Schema.String,
        color: Schema.Number,
        position: Schema.Number,
        managed: Schema.Boolean,
      }),
    ),
  },
}),
Rpc.make('UpsertGuildRole', {
  payload: {
    guild_id: Discord.Snowflake,
    role_id: Discord.Snowflake,
    name: Schema.String,
    color: Schema.Number,
    position: Schema.Number,
    managed: Schema.Boolean,
  },
}),
Rpc.make('DeleteGuildRole', {
  payload: {
    guild_id: Discord.Snowflake,
    role_id: Discord.Snowflake,
  },
}),
```

`PendingOnboardingSyncs` is now an atomic-claim RPC: server-side it
runs the `UPDATE … RETURNING` against rows in `pending` (limited by
`limit`) and returns the claimed batch already flipped to `syncing`.

Also extend the existing `RegisterGuild` payload (line 6-8) with
`is_community_enabled: Schema.Boolean`.

The `training_channel_id` comes from `team_settings.discord_channel_training`
(verified at `applications/server/src/repositories/TeamSettingsRepository.ts:16,40,83`)
joined in the server handler — it is *not* added to `teams`.

After all schema changes: `pnpm -C packages/domain build`.

## 3. i18n strings (`@sideline/i18n`)

Two files: `packages/i18n/messages/en.json` and `cs.json`. Run
`pnpm -C packages/i18n codegen` after editing.

### Bot-side keys (snake_case `bot_onboarding_*` to match
`bot_rsvp_*` convention at `packages/i18n/messages/en.json:444-452`).
Each description must be ≤140 chars (Discord welcome-screen limit per
`WelcomeScreenPatchRequestPartial` at
`node_modules/.pnpm/dfx@1.0.11_effect@4.0.0-beta.40/node_modules/dfx/dist/DiscordREST/Generated.d.ts:4391`).

| Key | en | cs |
|---|---|---|
| `bot_onboarding_welcomeScreen_description` | Welcome to {teamName}! Read the rules, then explore the server. | Vítejte v {teamName}! Přečtěte si pravidla a prozkoumejte server. |
| `bot_onboarding_welcomeScreen_channels_rules` | Read and acknowledge the team rules. | Přečtěte si a potvrďte týmová pravidla. |
| `bot_onboarding_welcomeScreen_channels_welcome` | Say hi and meet the team. | Pozdravte a seznamte se s týmem. |
| `bot_onboarding_welcomeScreen_channels_training` | Latest training calls and announcements. | Aktuální tréninky a oznámení. |
| `bot_onboarding_rulesPrompt_title` | Read the rules to join | Přečtěte pravidla pro vstup |
| `bot_onboarding_rulesPrompt_option_title` | I have read the rules | Přečetl(a) jsem si pravidla |
| `bot_onboarding_rulesPrompt_option_description` | Grants access to the rest of the server. | Otevře přístup ke zbytku serveru. |

**No `[Sideline]` prefix.** Prompt identity is tracked exclusively by
`teams.onboarding_rules_prompt_id` (see §7).

### Web-side keys (camelCase `teamSettings_onboarding*`, mirroring
`teamSettings_welcome*` at `packages/i18n/messages/en.json:386-451`).
The full table is given in `discord-native-onboarding-design.md:117-138`.
Adopt those keys verbatim; in addition the implementation needs:

| Key | en | cs |
|---|---|---|
| `teamSettings_onboardingNoChannels` | No text channels found yet. Create one in Discord first. | Zatím žádné textové kanály. Nejprve vytvořte kanál v Discordu. |
| `teamSettings_onboardingNoRoles` | No roles available. Create a role in Discord first. | Žádné role. Vytvořte roli v Discordu. |
| `teamSettings_onboardingError_role_deleted` | The configured role no longer exists. Pick another. | Nakonfigurovaná role již neexistuje. Vyberte jinou. |
| `teamSettings_onboardingError_channel_deleted` | The configured rules channel was deleted. Pick another. | Kanál s pravidly byl smazán. Vyberte jiný. |
| `teamSettings_onboardingError_community_not_enabled` | Enable Discord Community in your server settings, then retry. | Aktivujte Discord Community v nastavení serveru a zkuste znovu. |
| `teamSettings_onboardingError_rate_limited` | Discord is rate-limiting us. We'll retry shortly. | Discord nás dočasně omezil. Zkusíme to za chvíli znovu. |
| `teamSettings_onboardingError_unknown` | Sync failed: {detail} | Synchronizace selhala: {detail} |

## 4. Server-side

### `applications/server/src/repositories/TeamsRepository.ts`

- Extend `TeamUpdateInput` (line 7-16) with the three new
  captain-editable columns; extend the `update` arg type at line 85-94
  and the `UPDATE` statement at line 70-82 to write them.
- Add five new methods. All use `SqlSchema.findAll` / `SqlSchema.void`
  / `SqlSchema.findOne` per existing convention.
  - `claimPendingOnboardingSyncs(limit: number)` — atomic claim:
    ```sql
    UPDATE teams t SET onboarding_sync_status='syncing', updated_at=now()
    FROM (
      SELECT id FROM teams
      WHERE onboarding_sync_status='pending'
      ORDER BY updated_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    ) c
    WHERE t.id = c.id
    RETURNING t.id, t.guild_id, t.name, t.onboarding_locale,
              t.rules_channel_id, t.welcome_channel_id,
              t.onboarding_rules_role_id, t.onboarding_rules_prompt_id;
    ```
    Then a second query joins `team_settings` for
    `discord_channel_training` and `bot_guilds` for `is_community_enabled`
    keyed by the returned ids. `FOR UPDATE SKIP LOCKED` makes the claim
    safe across multiple bot replicas.
  - `markOnboardingSyncPending(teamId)` — `UPDATE teams SET
    onboarding_sync_status='pending', onboarding_sync_error=NULL,
    updated_at=now() WHERE id = $1`. (Used by HTTP retry + auto-flip
    on captain saves.)
  - `markOnboardingSyncDoneIfSyncing(teamId, promptId)` — **conditional**:
    ```sql
    UPDATE teams SET onboarding_sync_status='done', onboarding_sync_error=NULL,
      onboarding_synced_at=now(), onboarding_rules_prompt_id=$2
    WHERE id=$1 AND onboarding_sync_status='syncing'
    RETURNING id;
    ```
    Returns `{updated: rowCount === 1}`. If the row was flipped back to
    `pending` by a captain save during the sync, this is a no-op and
    `updated=false`; the next pollLoop tick picks the row up with the
    fresh config.
  - `markOnboardingSyncFailedIfSyncing(teamId, errorCode, errorDetail)` —
    same conditional pattern, persists a JSON string
    `JSON.stringify({code: errorCode, detail: errorDetail})` to
    `onboarding_sync_error`. Storing a structured object (rather than
    `"code: detail"`) avoids parser ambiguity when `detail` itself
    contains a colon (typical for `discord_error` where Discord error
    bodies often include URLs or status lines). The column is brand
    new in this migration so there is no backwards-compatibility
    concern. `teamToInfo` does the inverse parse — see below.
  - `getOnboardingRulesRoleId(guildId): Effect<Option<Snowflake>>` —
    `SELECT onboarding_rules_role_id FROM teams WHERE guild_id = $1`.

  Wire them into the returned object at line 103-109.

- **Add a no-op detection helper** for `updateTeamInfo` use:
  `hasOnboardingFieldChange(existing, next): boolean` — returns true if
  any of the following actually differ:
  - `existing.rules_channel_id` vs `next.rules_channel_id`
  - `existing.onboarding_rules_role_id` vs `next.onboarding_rules_role_id`
  - `existing.onboarding_locale` vs `next.onboarding_locale`
  - `existing.welcome_channel_id` vs `next.welcome_channel_id`

  Uses `Option.getOrElse(opt, () => null)` for comparison so
  Option-equality is value-equality. Pure function, lives next to the
  repository; export it.

### `applications/server/src/repositories/BotGuildsRepository.ts`

- Add `is_community_enabled` to `UpsertInput` (line 7-10) and to
  `BotGuildRow` (line 12-15).
- Update `_upsertGuild` (line 24-31) to write the column on both INSERT
  and UPDATE.
- Change the `upsert` signature at line 54-55 from
  `(guildId, guildName)` → `(guildId, guildName, isCommunityEnabled)`.
- Add `bulkUpdateCommunityFlags(rows: ReadonlyArray<{guild_id, is_community_enabled}>)`:
  uses `sql.in(...)` plus a `CASE WHEN` UPDATE in a single statement.
  This is what `Guild/SyncCommunityFlags` calls — atomic across the
  batch so no partial state if the bot crashes mid-sync.

### New file: `applications/server/src/repositories/DiscordRolesRepository.ts`

Mirror the structure of
`applications/server/src/repositories/DiscordChannelsRepository.ts`
verbatim:
- `syncRoles(guildId, roles)` — `DELETE FROM discord_guild_roles WHERE
  guild_id = $1` then bulk INSERT (or single multi-row INSERT) the
  provided rows. Wrapped in a transaction.
- `upsertRole(guildId, {role_id, name, color, position, managed})` —
  `INSERT … ON CONFLICT (guild_id, role_id) DO UPDATE SET name=…,
  color=…, position=…, managed=…, updated_at=now()`.
- `deleteRole(guildId, roleId)` — `DELETE FROM discord_guild_roles
  WHERE guild_id=$1 AND role_id=$2`.
- `listByGuild(guildId): ReadonlyArray<{id, name, color, position,
  managed}>` — `SELECT … FROM discord_guild_roles WHERE guild_id=$1
  ORDER BY position DESC` (returning `role_id AS id` so the RPC shape
  matches §2). The web filter strips `@everyone` (id === guild_id) and
  `managed=true` rows client-side; we return all rows so the server
  remains a thin pass-through.

Wire into `deps` (next to `discordChannels`) and use from the new
RPC handlers in `rpc/guild/index.ts` (see §4 above).

### `applications/server/src/repositories/TeamSettingsRepository.ts`

Add a query helper used by `claimPendingOnboardingSyncs`:
`findManyByTeamIds(teamIds): Map<TeamId, {discord_channel_training}>`.
(Or fold the join into the claim query directly — slight preference for
the join, but document both options for the developer.)

### `applications/server/src/rpc/guild/index.ts`

- Update the `Guild/RegisterGuild` handler (line 252-258) to accept
  and forward `is_community_enabled` to `botGuilds.upsert`.
- Add six handlers in the returned record (after line 361):

  ```ts
  'Guild/PendingOnboardingSyncs': ({ limit }) =>
    deps.teams.claimPendingOnboardingSyncs(limit),
  'Guild/MarkOnboardingSyncDone': ({ team_id, prompt_id }) =>
    deps.teams.markOnboardingSyncDoneIfSyncing(team_id, prompt_id),
  'Guild/MarkOnboardingSyncFailed': ({ team_id, error_code, error_detail }) =>
    deps.teams.markOnboardingSyncFailedIfSyncing(team_id, error_code, error_detail),
  'Guild/GetOnboardingRulesRoleId': ({ guild_id }) =>
    deps.teams.getOnboardingRulesRoleId(guild_id),
  'Guild/SyncCommunityFlags': ({ guilds }) =>
    deps.botGuilds.bulkUpdateCommunityFlags(guilds),
  'Guild/ListGuildRoles': ({ guild_id }) =>
    deps.discordRoles.listByGuild(guild_id),
  'Guild/SyncGuildRoles': ({ guild_id, roles }) =>
    deps.discordRoles.syncRoles(guild_id, roles),
  'Guild/UpsertGuildRole': ({ guild_id, role_id, name, color, position, managed }) =>
    deps.discordRoles.upsertRole(guild_id, { role_id, name, color, position, managed }),
  'Guild/DeleteGuildRole': ({ guild_id, role_id }) =>
    deps.discordRoles.deleteRole(guild_id, role_id),
  ```

  **`Guild/ListGuildRoles` placement (decided — option (b), table sync).**
  The server reads from a new `discord_guild_roles` table (migration
  in §1). The bot keeps that table in sync via gateway events
  (`GuildRoleCreate/Update/Delete`) plus a READY-time bulk upsert (see §5).
  Rationale:
  - **Consistency with the existing pattern.** `Guild/SyncGuildChannels`
    + `Guild/UpsertChannel` + `Guild/DeleteChannel` at
    `applications/server/src/rpc/guild/index.ts:266-307` already follow
    this exact shape, fed by `ChannelCreate/Update/Delete` handlers in
    `applications/bot/src/events/index.ts:348-470` + a bulk sync on
    `GuildCreate` at `:41-65`. Reusing that pattern keeps the codebase
    homogenous and makes the implementation a near-copy.
  - **Lower latency for the web user.** The role select renders from a
    plain DB query — no cross-process RPC on the request path.
  - **Resilience.** Roles are available even when the bot is briefly
    offline, and the page loader is one less point of failure.
  - **No new RPC channel direction.** Existing SyncRpc traffic is
    bot → server (SyncGuildChannels-style). Option (a) would have
    required adding server → bot RPC, which doesn't exist today.

  Add a new `DiscordRolesRepository` mirroring
  `DiscordChannelsRepository` (delete-then-bulk-insert in `syncRoles`,
  upsert-on-conflict in `upsertRole`, scoped delete in `deleteRole`,
  guild-scoped `findByGuild` returning rows ordered by position desc
  for `listByGuild`). Wire it into `deps` next to `discordChannels`.

### `applications/server/src/api/team.ts`

- Extend `teamToInfo` (line 11-22). Because `is_community_enabled` and
  the typed error fields live outside `teams`, the handler needs to
  fetch `BotGuildsRepository` and pass the resolved boolean into a
  refactored `teamToInfo(team, isCommunityEnabled)` helper. Parse
  `team.onboarding_sync_error` from JSON into `{code, detail}` using
  `Schema.decodeUnknownEither(Schema.parseJson(Schema.Struct({code: OnboardingSyncErrorCode, detail: Schema.String})))`
  before placing on `TeamInfo`. On parse failure (defensive — should
  never happen since the column is freshly introduced and only ever
  written by `markOnboardingSyncFailedIfSyncing`), fall back to
  `{code: 'unknown', detail: rawString}`. A round-trip test (write
  via the failed-sync path → read via `getTeamInfo`) covers this — see §9.

- In the `updateTeamInfo` handler (line 52-92):
  1. Fetch `existing` (already done at line 59).
  2. Apply the update (already done at line 60-89).
  3. **Use the new `hasOnboardingFieldChange(existing, updated)`
     helper** (see TeamsRepository section above) — only call
     `teams.markOnboardingSyncPending(teamId)` when the helper returns
     true. **A no-op save (e.g. captain edits only `name`) MUST NOT
     churn the status.**
  4. Note: `welcome_channel_id` lives on `teams`, but
     `discord_channel_training` lives on `team_settings`. Captain saves
     to team-settings go through `applications/server/src/api/team-settings.ts`
     which must apply the SAME auto-flip narrowing — wire identical
     logic there comparing
     `existing.discord_channel_training` vs the new value.

- Add a third handler `retryOnboardingSync`:

  ```ts
  .handle('retryOnboardingSync', ({ params: { teamId } }) =>
    Effect.Do.pipe(
      Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
      Effect.bind('membership', ({ currentUser }) =>
        requireMembership(members, teamId, currentUser.id, forbidden),
      ),
      Effect.tap(({ membership }) => requirePermission(membership, 'team:manage', forbidden)),
      Effect.tap(() => teams.markOnboardingSyncPending(teamId)),
      Effect.flatMap(() => getTeamOrForbidden(teams, teamId)),
      Effect.flatMap((team) => /* resolve isCommunityEnabled, return teamToInfo */),
    ),
  )
  ```

## 5. Bot-side

### `applications/bot/src/events/index.ts`

#### `READY` handler (new) — Community-flag backfill

Add a new `Effect.let('ready', ...)` binding alongside the existing
event handlers. The READY payload exposes the bot's guild list as
`payload.guilds: ReadonlyArray<UnavailableGuild>` (without `features`).
Since `features` aren't on the unavailable-guild record, the
recommended approach is:

```ts
Effect.let('ready', ({ gateway, rest, rpc }) =>
  gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.Ready, () =>
    Effect.Do.pipe(
      // 1) Paginate: /users/@me/guilds caps each page at 200. Loop with `after`
      //    until a page is shorter than the limit (definitive end-of-list).
      Effect.bind('allGuilds', () =>
        Effect.iterate(
          { acc: [] as ReadonlyArray<DiscordTypes.RESTGetAPICurrentUserGuildsResult[number]>, after: undefined as string | undefined, done: false },
          {
            while: (s) => !s.done,
            body: (s) =>
              rest.listCurrentUserGuilds({ limit: 200, after: s.after }).pipe(
                Effect.map((page) => ({
                  acc: [...s.acc, ...page],
                  after: page.length === 0 ? s.after : page[page.length - 1].id,
                  done: page.length < 200,
                })),
              ),
          },
        ).pipe(Effect.map((s) => s.acc)),
      ),
      Effect.let('rows', ({ allGuilds }) =>
        Arr.map(allGuilds, (g) => ({
          guild_id: decodeSnowflake(g.id),
          is_community_enabled: g.features.includes('COMMUNITY'),
        })),
      ),
      // 2) Chunk to ~500 entries per RPC call so a fleet of 5 000 guilds
      //    doesn't ship a single oversized RPC payload (Effect-RPC over
      //    HTTP has practical body-size limits and we want predictable
      //    DB write batches).
      Effect.tap(({ rows }) =>
        rows.length === 0
          ? Effect.void
          : Effect.forEach(
              Arr.chunksOf(rows, 500),
              (chunk) => rpc['Guild/SyncCommunityFlags']({ guilds: chunk }),
              { concurrency: 1, discard: true },
            ),
      ),
      Effect.tapError((e) => Effect.logWarning('SyncCommunityFlags on READY failed', e)),
      Effect.catchTags({
        HttpClientError: () => Effect.void,
        RatelimitedResponse: () => Effect.void,
        ErrorResponse: () => Effect.void,
        RpcClientError: () => Effect.void,
      }),
      Effect.withSpan('discord/ready'),
    ),
  ),
),
```

Without this, every existing team's first onboarding sync after
migration would fail with "community not enabled" until `GuildCreate`
re-fires (which only happens on bot reconnect/rejoin) — bad first
impression. The READY backfill closes that gap.

Also update the merge of handler bindings at line 450-475 to include
the new `ready` entry.

#### `READY` handler (cont.) — Roles backfill

Inside the same READY effect, after `SyncCommunityFlags` succeeds,
iterate over the same paginated guild list and, for each guild, call
`rest.listGuildRoles(guild.id)` and push the result through
`Guild/SyncGuildRoles({guild_id, roles})`. Roles are part of the
`GuildCreate` payload (`guild.roles`), so on a cold start (READY +
GuildCreate dispatches) we'll get a refresh anyway — but the
`SyncGuildRoles` call here covers the case where the bot reconnects
without re-receiving GuildCreate (e.g. RESUME). Cap concurrency to
~5 and `Effect.catchTags` rate-limit / network errors to logWarning
so a single bad guild does not abort the loop.

Alternatively (preferred, simpler): rely on the existing
`GuildCreate` handler — see below — to push the full role list per
guild on every cold start, and skip a separate roles backfill in
READY. dfx fires GuildCreate for every guild after READY on a cold
connect, so this covers the cold-start case. The READY-time path
above is only needed for RESUME-without-GuildCreate, which is rare;
document and pick whichever the developer finds cleaner.

#### `guildCreate` (cont.) — Roles bulk sync

In the `guildCreate` handler at line 24-105, alongside the existing
`Guild/SyncGuildChannels` call at line 55-58, add a parallel
`Guild/SyncGuildRoles` push using `guild.roles` (already present on
the `GuildCreate` payload, no extra REST call needed):

```ts
Effect.tap(() =>
  rpc['Guild/SyncGuildRoles']({
    guild_id: decodeSnowflake(guild.id),
    roles: Arr.map(guild.roles, (r) => ({
      role_id: decodeSnowflake(r.id),
      name: r.name,
      color: r.color,
      position: r.position,
      managed: r.managed,
    })),
  }),
),
```

#### `GuildRoleCreate` / `GuildRoleUpdate` / `GuildRoleDelete` (new)

Three new handlers, mirroring `ChannelCreate/Update/Delete` at
`applications/bot/src/events/index.ts:348-470`:

```ts
Effect.let('guildRoleCreate', ({ gateway, rpc }) =>
  gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.GuildRoleCreate, (payload) =>
    rpc['Guild/UpsertGuildRole']({
      guild_id: decodeSnowflake(payload.guild_id),
      role_id: decodeSnowflake(payload.role.id),
      name: payload.role.name,
      color: payload.role.color,
      position: payload.role.position,
      managed: payload.role.managed,
    }).pipe(
      Effect.catchTags({ RpcClientError: (e) => Effect.logWarning('UpsertGuildRole failed', e) }),
      Effect.withSpan('discord/guild_role_create'),
    ),
  ),
),
Effect.let('guildRoleUpdate', ({ gateway, rpc }) =>
  gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.GuildRoleUpdate, (payload) =>
    rpc['Guild/UpsertGuildRole']({ /* same as Create */ }).pipe(/* same */),
  ),
),
Effect.let('guildRoleDelete', ({ gateway, rpc }) =>
  gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.GuildRoleDelete, (payload) =>
    rpc['Guild/DeleteGuildRole']({
      guild_id: decodeSnowflake(payload.guild_id),
      role_id: decodeSnowflake(payload.role_id),
    }).pipe(
      Effect.catchTags({ RpcClientError: (e) => Effect.logWarning('DeleteGuildRole failed', e) }),
      Effect.withSpan('discord/guild_role_delete'),
    ),
  ),
),
```

Add all three to the merged handler bindings at line 450-475.

#### `guildCreate` (line 24-105)

At the `Guild/RegisterGuild` call (line 35-38), add the community flag:

```ts
rpc['Guild/RegisterGuild']({
  guild_id: decodeSnowflake(guild.id),
  guild_name: guild.name,
  is_community_enabled: guild.features.includes('COMMUNITY'),
}),
```

#### `guildMemberUpdate` (line 329-346) — replace placeholder with cached, idempotent logic

**Load profile:** a 100-member guild with normal activity may emit
1000s of GuildMemberUpdate events/day. The implementation must remain
effectively zero-cost on the no-op path — no RPC, no allocations
beyond the metric tag, ideally no async work.

**Add an in-bot cache layer:** new file
`applications/bot/src/services/OnboardingRoleCache.ts`:

```ts
// Effect Service (Effect.Tag) wrapping a Map<GuildId, {value: Option<Snowflake>, expiresAt: number}>.
// Methods:
//   get(guildId) → Effect<Option<Snowflake>>  // resolves cached value if non-stale; else fetches via SyncRpc + populates; TTL = 60s.
//   invalidate(guildId): Effect<void>  // drops the cache entry (called by ProcessorService at the end of every successful sync so a freshly-PUT role is observed within milliseconds, not up to 60s later).
// Lives in services/ next to InviteCache.ts.
```

Wire it into `AppLive.ts` next to `InviteCache.Default` and bind it
into `eventHandlers` via `Effect.bind('roleCache', () => OnboardingRoleCache.asEffect())`.

**Handler skeleton** (replaces lines 329-346):

```ts
Effect.let('guildMemberUpdate', ({ gateway, rest, roleCache }) =>
  gateway.handleDispatch(DiscordTypes.GatewayDispatchEvents.GuildMemberUpdate, (member) => {
    // Cheap early bail: skip immediately if member.pending isn't strictly false.
    // (Most events have pending=true or undefined.)
    if (member.pending !== false) {
      return Metric.update(
        Metric.withAttributes(discordEventsTotal, { event_type: 'guild_member_update' }),
        1,
      );
    }
    return Effect.Do.pipe(
      Effect.tap(() =>
        Metric.update(
          Metric.withAttributes(discordEventsTotal, { event_type: 'guild_member_update' }),
          1,
        ),
      ),
      Effect.bind('roleId', () =>
        roleCache.get(decodeSnowflake(member.guild_id)),
      ),
      Effect.tap(({ roleId }) =>
        Option.match(roleId, {
          onNone: () => Effect.void,
          onSome: (rid) =>
            // Idempotency check: already in member.roles? skip.
            member.roles.includes(rid)
              ? Effect.void
              : rest.addGuildMemberRole(member.guild_id, member.user.id, rid).pipe(
                  Effect.tap(() =>
                    Metric.update(onboardingRoleAssignedTotal, 1),
                  ),
                  Effect.catchTags({
                    HttpClientError: (e) => Effect.logWarning('addGuildMemberRole failed', e),
                    RatelimitedResponse: (e) => Effect.logWarning('Rate-limited', e),
                    ErrorResponse: (e) => Effect.logWarning('Discord error', e),
                  }),
                ),
        }),
      ),
      Effect.withSpan('discord/guild_member_update', {
        attributes: { 'guild.id': member.guild_id },
      }),
    );
  }),
),
```

Three layers of cost-minimisation:
1. **Cheap early bail** — `member.pending !== false` short-circuits
   before any Effect runs (covers ~95% of events).
2. **Cache hit** — TTL 60s in-memory `Map`, no RPC.
3. **Idempotency check** — `member.roles.includes(roleId)` skips the
   REST call when role is already assigned (e.g. retransmits, restart
   replays).

Bot restart is safe because state is recovered organically on the next
event.

### Metrics — `applications/bot/src/metrics.ts`

Append three new metrics next to the existing four:

```ts
/** Total onboarding sync attempts, tagged with { status } where status ∈ {success, failed, skipped_no_community} */
export const onboardingSyncTotal = Metric.counter('onboarding_sync_total', {
  description: 'Total onboarding sync attempts',
  incremental: true,
});

/** Histogram of onboarding sync duration in ms */
export const onboardingSyncDurationMs = Metric.histogram(
  'onboarding_sync_duration_ms',
  MetricBoundaries.exponential({ start: 50, factor: 2, count: 12 }),
);

/** Total onboarding rules role assignments via GuildMemberUpdate */
export const onboardingRoleAssignedTotal = Metric.counter('onboarding_role_assigned_total', {
  description: 'Total onboarding rules-role assignments',
  incremental: true,
});
```

`onboardingSyncTotal` is incremented in `OnboardingSyncService` for each
team processed (with the appropriate status tag);
`onboardingSyncDurationMs` is updated per team via
`Metric.trackDuration`; `onboardingRoleAssignedTotal` is incremented in
the `guildMemberUpdate` handler.

### New file: `applications/bot/src/rcp/onboarding/payloadBuilders.ts`

Pure functions, no Effect — easy to unit-test. The shapes are taken
from `dfx/dist/DiscordREST/Generated.d.ts` interfaces
`WelcomeScreenPatchRequestPartial` (line 4391-4395),
`UpdateGuildOnboardingRequest` (line 4120-4125),
`UpdateOnboardingPromptRequest` (line 4100-4108), and the dfx
constants `GuildOnboardingMode` (line 4109-4119) +
`OnboardingPromptType` (line 4064-4074).

```ts
export const buildWelcomeScreenPayload = (
  team: PendingOnboardingSync,
  strings: WelcomeScreenStrings, // resolved per onboarding_locale
): Option<WelcomeScreenPatchRequestPartial> => { /* … */ };

export const mergeOnboardingPayload = (
  current: UserGuildOnboardingResponse,
  team: PendingOnboardingSync,
  strings: RulesPromptStrings,
): { merged: UpdateGuildOnboardingRequest; usedExistingId: boolean } => { /* see §7 */ };
```

### New file: `applications/bot/src/rcp/onboarding/ProcessorService.ts`

Mirror `applications/bot/src/rcp/guildJoin/ProcessorService.ts:1-87`
verbatim in structure: `processEvent` is a per-team Effect, the
returned `processTick` calls
`rpc['Guild/PendingOnboardingSyncs']({ limit: 20 })`, then runs each
event with `concurrency: 1` and returns. The next pollLoop tick
(5s cadence — `Schedule.spaced('5 seconds')` at
`applications/bot/src/Bot.ts:26-27`) picks up the next batch.

**Rate-limit handling.** dfx ships an internal token-bucket rate
limiter — `RateLimitStore` and `RateLimiter` services in
`node_modules/.pnpm/dfx@1.0.11_effect@4.0.0-beta.40/node_modules/dfx/dist/RateLimit.d.ts`
(types: `BucketDetails`, `RateLimitStoreService.incrementCounter`).
The default `MemoryRateLimitStoreLive` layer is wired into
`DiscordREST` via dfx's standard layer composition — every REST call
goes through the bucket queue, so bursts are queued in-memory and a
short-term burst of `LIMIT 20` calls per tick will be smoothed by dfx
without us issuing parallel requests. Conclusion: `LIMIT 20` per tick
+ `concurrency: 1` is safe; we do NOT need an in-bot cooldown for the
sync loop. (The HTTP RatelimitedResponse error tag is still classified
as a typed failure — see §8.)

**`processEvent` body:**
1. Open span + start `Metric.trackDuration(onboardingSyncDurationMs)`.
2. **Skip-no-community guard:** if `!team.is_community_enabled`,
   increment `onboardingSyncTotal{status='skipped_no_community'}`,
   leave the row in `syncing` and call **a special no-op `MarkSyncDone`
   alternative** — actually we CANNOT mark it done (it's not done) and
   we MUST NOT mark it failed (per the requirements: "leave row in
   pending, re-check next tick"). Therefore:

   - Add a sixth method on TeamsRepository (and matching RPC):
     `revertOnboardingSyncIfSyncing(teamId)` — `UPDATE teams SET
     onboarding_sync_status='pending' WHERE id=$1 AND
     onboarding_sync_status='syncing'`. The pollLoop calls this when
     `is_community_enabled=false` so the team is re-tried next tick.
   - Add a corresponding RPC `Guild/RevertOnboardingSync(team_id)` to
     the GuildRpcGroup list in §2.
   - Document: this guard is the second line of defence; the READY
     backfill should make the flag accurate before any sync runs, but
     if the flag is stale we re-check rather than fail.

3. `discord.getGuildsOnboarding(guild_id)` → `current`.
4. `{merged, usedExistingId} = mergeOnboardingPayload(current, team, strings)`.
5. `discord.putGuildsOnboarding(guild_id, merged)` →
   `GuildOnboardingResponse` (line 4126-4129).
6. **Stale-id retry:** if PUT fails with `ErrorResponse` AND the error
   references our prompt id (see §7 step 5), strip `id` from our
   prompt, re-merge, PUT once more. Cap at 1 retry.
7. Locate our prompt id in the response (by matching the freshly-put
   payload — see §7). If we omitted the prompt (insufficient config),
   `prompt_id = Option.none()`.
8. If `team.welcome_channel_id` is `Some`, also
   `discord.updateGuildWelcomeScreen(guild_id, buildWelcomeScreenPayload(...))`.
9. `Guild/MarkOnboardingSyncDone(team_id, prompt_id)` →
   `{updated: bool}`. If `updated=false` (captain re-saved mid-sync,
   row already flipped back to pending), log info and skip the success
   metric — the next tick will resync with fresh config.
10. On success, increment `onboardingSyncTotal{status='success'}`
    AND call `roleCache.invalidate(team.guild_id)` so the next
    `GuildMemberUpdate` re-fetches the freshly-persisted
    `onboarding_rules_role_id` instead of the now-stale cached value
    (closes the up-to-60s staleness window after a captain role
    change). Also call `roleCache.invalidate(team.guild_id)` on the
    skipped-no-community path (step 2) so an admin enabling Community
    + retrying immediately picks up the new role binding.
11. **Error path** (catchTags): classify via §8 → call
    `Guild/MarkOnboardingSyncFailed` with the typed code +
    `onboardingSyncTotal{status='failed'}`. The `IfSyncing` suffix on
    the RPC handler ensures we don't clobber a captain's mid-sync
    re-save.

### New file: `applications/bot/src/rcp/onboarding/index.ts`

Verbatim shape of `applications/bot/src/rcp/guildJoin/index.ts:1-12`,
just renamed to `OnboardingSyncService`.

### Wiring

- `applications/bot/src/AppLive.ts:14-19`: add
  `OnboardingSyncService.Default` and `OnboardingRoleCache.Default` to
  the `Layer.mergeAll(...)`.
- `applications/bot/src/Bot.ts:9-14` import line: add
  `OnboardingSyncService` to the named imports from `./index.js`.
- `applications/bot/src/Bot.ts:33-44`: add an
  `Effect.bind('onboarding', () => OnboardingSyncService.asEffect())`
  binding and a `pollLoop(onboarding.processTick)` line in the
  `Effect.all(...)` array.
- Re-export `OnboardingSyncService` from
  `applications/bot/src/rcp/index.ts`.

### Multi-bot coexistence (Carl-bot etc.)

**Documented limitation, no code change in v1.** Our `mergeOnboardingPayload`:
- **Preserves** non-Sideline prompts in `current.prompts` (we only
  touch the prompt matched by `teams.onboarding_rules_prompt_id`; all
  others pass through unchanged).
- **Replaces** top-level `enabled`, `mode`, and `default_channel_ids` —
  we always set `enabled=true`,
  `mode=GuildOnboardingMode.ONBOARDING_ADVANCED` (1), and our chosen
  default-channel list (welcome + training + rules, deduped). We need
  `ONBOARDING_ADVANCED` so prompts (not just default_channels) gate
  access — confirmed by dfx Generated.d.ts:4109-4119 ("ONBOARDING_DEFAULT
  considers only default channels in constraints; ONBOARDING_ADVANCED
  considers default channels AND prompts").
- If the captain has a different setup via Carl-bot or manual edits to
  `enabled`/`mode`/`default_channel_ids`, our PUT replaces them.
  Acceptable for v1; revisit if a captain reports friction.

### Captain-edits-our-prompt

**Documented behaviour, no code change in v1.** Sideline owns the
prompt referenced by `teams.onboarding_rules_prompt_id`. Captain edits
to that prompt's title/options/role bindings WILL be reverted on the
next sync. To opt out, captains delete the prompt — we'll recreate it
on next sync (a fresh id is then persisted via `MarkSyncDone`). Future
work could add an `onboarding_rules_disabled` boolean flag.

### Private-rules-channel warning (deferred)

Skipped in v1. Implementing this requires fetching channel permission
overwrites via `dfx.getChannelPermissions` and resolving the
`@everyone` permission against the `VIEW_CHANNEL` bit — a non-trivial
amount of code for a UX nicety. Document as a follow-up.

## 6. Web-side

Reference `.work-plans/discord-native-onboarding-design.md` end-to-end.
All field/component decisions there are normative.

### Route loader: `applications/web/src/routes/(authenticated)/teams/$teamId/settings.tsx:17-27`

Loader must additionally call `api.guild.listGuildRoles({ guild_id })`
(or the equivalent through the team-info endpoint) so the new
`SearchableSelect` for roles has data. Add this call in parallel with
the existing channel list call.

### Component: `applications/web/src/components/pages/TeamSettingsPage.tsx`

Slot the new card immediately after the Welcome Message `Card` at
line 850-940. Re-use `Card / CardHeader / CardContent` exactly as in
that block. Add a new lucide import: `ShieldCheck`.

State (mirroring the welcome-channel pattern at line 123-137):

```ts
const [rulesChannel, setRulesChannel] = React.useState(
  Option.getOrElse(teamInfo.rulesChannelId, () => NONE_VALUE),
);
const [onboardingRoleId, setOnboardingRoleId] = React.useState(
  Option.getOrElse(teamInfo.onboardingRulesRoleId, () => NONE_VALUE),
);
const [onboardingLocale, setOnboardingLocale] = React.useState<'en' | 'cs'>(
  teamInfo.onboardingLocale,
);
const [savingOnboarding, setSavingOnboarding] = React.useState(false);
```

UI per the design spec:
- Rules channel: existing `SearchableSelect` (channel filter
  `ch.type === DISCORD_CHANNEL_TYPE_TEXT` — same as line 877). Empty allowed.
- **Onboarding role: `SearchableSelect`** populated from the new
  `Guild/ListGuildRoles` RPC (filter out `@everyone` (id ===
  guild_id) and managed roles like Twitch/Nitro
  (`role.managed === true`) before binding). Empty allowed. Drop the
  free-text input entirely.
- Locale: shadcn `ToggleGroup` (`pnpm -C applications/web dlx
  shadcn@latest add toggle-group`).
- Status: `Badge` with new `success` variant added to
  `applications/web/src/components/ui/badge.tsx:9-19`. Wrap in
  `<div role='status' aria-live='polite'>`. Adds `syncing` rendering
  (e.g. `Badge variant='secondary'` with spinner icon).
- Error display: when status is `failed`, render copy keyed by
  `OnboardingSyncErrorCode` (see i18n table in §3).
- Retry button: `Button variant='outline' size='sm'`, visible only
  when status is `failed`. Calls
  `api.team.retryOnboardingSync({ params: { teamId } })`, then
  `router.invalidate()`.
- Community-required `Alert` (`pnpm -C applications/web dlx
  shadcn@latest add alert`) when `!teamInfo.isCommunityEnabled`,
  wrapping fields in `<fieldset disabled>`.

Save handler is structurally identical to `handleSaveWelcome` at
line 294-328: builds an `UpdateTeamRequest` with only the three new
fields populated (others `Option.none()`), calls
`api.team.updateTeamInfo(...)`, toasts, invalidates the route.

### Badge `success` variant

Single edit at `applications/web/src/components/ui/badge.tsx:10-19`,
adding to the `variant` map:

```ts
success:
  'border-transparent bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200',
```

## 7. Read-modify-write merge algorithm

Code outline for `mergeOnboardingPayload(current, team, strings)`:

1. **GET current onboarding**: `discord.getGuildsOnboarding(guildId)`
   returns `UserGuildOnboardingResponse` (Generated.d.ts:4084-4089).
2. **Locate our prompt** in `current.prompts` (Generated.d.ts:4075-4083)
   by id only:
   - If `team.onboarding_rules_prompt_id` is `Some(id)`, find by
     `prompt.id === id`. If found → reuse the id, update in place.
   - If `team.onboarding_rules_prompt_id` is `None` OR id doesn't match
     any current prompt → omit `id` from our prompt payload. Discord
     assigns a fresh id; we read it back from the PUT response and
     persist it via `MarkOnboardingSyncDone`.
   - **No title-prefix matching.** This is the single canonical
     identity strategy — the only thing that identifies "our" prompt
     is the snowflake we stored. If the captain renames our prompt's
     title, we still recognise it; if the captain deletes it, we
     create a new one (one-time duplicate possible — see step 5).
3. **Build our prompt** as `UpdateOnboardingPromptRequest`
   (Generated.d.ts:4100-4108):
   ```ts
   {
     id: existingId,                     // omit when fresh
     title: strings.title,               // plain title — no prefix
     type: OnboardingPromptType.MULTIPLE_CHOICE, // 0
     single_select: true,
     required: true,
     in_onboarding: true,
     options: [{
       title: strings.optionTitle,
       description: strings.optionDescription,
       emoji_name: '✅',
       role_ids: [team.onboarding_rules_role_id],
       channel_ids: [],
     }],
   }
   ```
4. **Merge prompts array**:
   - Take every `current.prompts` entry whose id ≠ our stored id.
   - Append our prompt **only if** both `team.rules_channel_id` and
     `team.onboarding_rules_role_id` are `Some`. Otherwise omit it
     entirely (per `discord-native-onboarding.md:127-129`).
5. **PUT merged**: `discord.putGuildsOnboarding(guildId, {
     enabled: true, mode: GuildOnboardingMode.ONBOARDING_ADVANCED,
     default_channel_ids: [...rules, …welcome, …training (deduped)],
     prompts: merged,
   })`.

   **Stale-id recovery.** Two scenarios:
   - PUT succeeds with our (now orphaned) id present → unlikely; if
     Discord regenerates the id, step 6 picks it up.
   - PUT fails with `ErrorResponse` referencing our id (e.g. captain
     deleted the prompt; Discord rejects the orphan-id reference) → the
     ProcessorService strips `id` from our prompt and retries once.

   **One-time duplicate edge case.** If the captain deleted our prompt
   AND the merge step found no match by id, we add a new prompt; PUT
   may succeed (no duplicate) or may fail (Discord rejects orphan id
   reference). On failure, retry with id stripped — same path as
   above. Documented; cap retries at 1 to avoid loops.

6. **Read prompt id from response**: `GuildOnboardingResponse`
   (Generated.d.ts:4126-4129). Find our prompt by matching options'
   `title === strings.optionTitle` AND `role_ids` containing
   `onboarding_rules_role_id` (the unique fingerprint of our prompt
   contents — survives Discord assigning a fresh id). Pass that id to
   `Guild/MarkOnboardingSyncDone({team_id, prompt_id})`. If we omitted
   the prompt in step 4, pass `Option.none()`.

`buildWelcomeScreenPayload` is straightforward: produces
`{enabled: true, description: strings.description, welcome_channels:
[…1-3 entries…]}`. Each entry is a `GuildWelcomeChannel`
(Generated.d.ts:4385-4390). Skip a slot if its channel id is `None`.

## 8. Error classification

Inside the bot's `processEvent` Effect, wrap the Discord calls with
`Effect.catch(...)`. The error union from
`putGuildsOnboarding` / `updateGuildWelcomeScreen` /
`getGuildsOnboarding` is exactly
`HttpClientError | DiscordRestError<'RatelimitedResponse', …> |
DiscordRestError<'ErrorResponse', …>` (Generated.d.ts:5424-5466).

Add a Discord-error-parser helper:
**New file:** `applications/bot/src/rcp/onboarding/errorClassifier.ts`

```ts
export type ClassifiedOnboardingError =
  | { code: 'community_not_enabled'; detail: string }
  | { code: 'role_deleted'; detail: string }
  | { code: 'channel_deleted'; detail: string }
  | { code: 'rate_limited'; detail: string }
  | { code: 'discord_error'; detail: string }
  | { code: 'network_error'; detail: string };

export const classifyOnboardingError = (
  err: HttpClientError | RatelimitedResponse | ErrorResponse,
  team: { rules_channel_id: Option<Snowflake>; onboarding_rules_role_id: Option<Snowflake> },
): ClassifiedOnboardingError => { /* see table */ };
```

| Failure | Detection | Code | Notes |
|---|---|---|---|
| Community feature not enabled | `team.is_community_enabled === false` (cheap pre-check before any HTTP call) **OR** `ErrorResponse.code === 50013` on onboarding endpoint | `community_not_enabled` | Pre-check now triggers `RevertOnboardingSync` (leave pending), not `MarkFailed`. The `50013` runtime path still uses `MarkFailed`. |
| Rate limit | `RatelimitedResponse` tag | `rate_limited` | dfx already queues; this fires only when the queue itself hits the cap. PollLoop will only re-attempt the team on the next captain re-save (pending-flip pattern). |
| **Deleted role** | `ErrorResponse.code === 50035` (Invalid Form Body) AND error body references `team.onboarding_rules_role_id` (substring match against `err.errors` JSON for the snowflake) | `role_deleted` | Web shows actionable copy "The configured role no longer exists. Pick another." |
| **Deleted channel** | `50035` AND error body references `team.rules_channel_id` (or `welcome_channel_id`/`training_channel_id`) | `channel_deleted` | Same actionable-copy pattern. |
| Other Discord error | `ErrorResponse` tag (not above) | `discord_error` | `detail = \`${err.code}: ${err.message}\`` |
| Network error | `HttpClientError` tag | `network_error` | `detail = String(err)` |

Use `Effect.catchTags({...})` per the existing convention at
`applications/bot/src/events/index.ts:158-164` and `:225-232`. Stale-id
recovery (§7 step 5) is caught **inside** the merge function before
this classifier sees it.

## 9. Test specification

### Unit (`applications/bot/test/onboarding/payloadBuilders.test.ts`)

10 cases for `buildWelcomeScreenPayload`:
1. all three channels set → 3 welcome_channels
2. only rules + welcome → 2
3. only welcome → 1
4. no channels → `Option.none()`
5. en locale strings used
6. cs locale strings used
7. description ≤140 chars (assert)
8. emoji_name fields populated
9. enabled === true
10. unknown locale → fallback to en

### Unit (`applications/bot/test/onboarding/mergeAlgorithm.test.ts`)

5 cases for `mergeOnboardingPayload`:
1. fresh guild, no existing prompts, no stored id → 1 prompt with no id; flag `usedExistingId=false`
2. captain has 2 unrelated prompts, no stored id → 3 prompts merged, theirs preserved verbatim, ours appended without id
3. existing Sideline prompt by stored id → updated in place, id preserved; flag `usedExistingId=true`
4. stored id is stale (no match in current.prompts) → id omitted on our prompt; ours appended; captain's other prompts preserved
5. `rules_channel_id === None` OR `onboarding_rules_role_id === None` → our prompt omitted, others preserved verbatim

### Unit (`applications/bot/test/onboarding/errorClassifier.test.ts`)

6 cases:
1. `RatelimitedResponse` → `rate_limited`
2. `ErrorResponse{code:50013}` → `community_not_enabled`
3. `ErrorResponse{code:50035, errors referencing role id}` → `role_deleted`
4. `ErrorResponse{code:50035, errors referencing channel id}` → `channel_deleted`
5. `ErrorResponse{code:99999}` (unknown) → `discord_error`
6. `HttpClientError` → `network_error`

### Server RPC integration (`applications/server/test/rpc/onboardingRpc.test.ts`)

12 cases:
1. `Guild/PendingOnboardingSyncs({limit:20})` atomically claims, returns at most 20, flips claimed rows to `syncing` (verify with second SELECT)
2. `Guild/PendingOnboardingSyncs` with a row in `syncing` is NOT re-claimed
3. **Concurrent claim from two callers** (use two parallel SqlClients in a single test): each row appears in exactly one batch — `FOR UPDATE SKIP LOCKED` proven
4. `Guild/MarkOnboardingSyncDone` on a `syncing` row → flips to `done`, sets `prompt_id` and `onboarding_synced_at`, returns `{updated:true}`
5. **`MarkOnboardingSyncDone` on a row that was flipped to `pending` mid-sync** (manually UPDATE the row to `pending` between claim and MarkDone) → no-op, returns `{updated:false}`, row stays `pending`
6. `Guild/MarkOnboardingSyncFailed` on a `syncing` row → flips to `failed` with typed `error_code`
7. `Guild/RevertOnboardingSync` on a `syncing` row → flips back to `pending`
8. `Guild/GetOnboardingRulesRoleId` returns the role id when set, `None` otherwise
9. `Guild/SyncCommunityFlags({guilds:[...]})` upserts the boolean for all listed guilds atomically
10. `Guild/ListGuildRoles({guild_id})` returns the full role list (including `@everyone` and managed roles — filtering happens client-side); rows ordered by position desc
11. `Guild/SyncGuildRoles` performs a delete-then-bulk-insert (rows not in the new payload disappear); `Guild/UpsertGuildRole` ON CONFLICT updates name/color/position/managed; `Guild/DeleteGuildRole` removes only the specified row
12. **JSON round-trip on `onboarding_sync_error`**: call `MarkOnboardingSyncFailed({error_code:'discord_error', error_detail:'10004: Unknown Channel: https://discord.com/api/v10/guilds/x'})` (detail contains multiple colons), then `getTeamInfo` via the HTTP API → returned `onboardingSyncError` is parsed as `{code:'discord_error', detail:'10004: Unknown Channel: https://discord.com/api/v10/guilds/x'}` with the colons preserved verbatim — proves the JSON delimiter fix

### Server HTTP integration (`applications/server/test/api/teamOnboarding.test.ts`)

5 cases:
1. `PATCH /teams/:id` with a change to `rules_channel_id` → status flips `done` → `pending`
2. `PATCH /teams/:id` with a change to `onboarding_rules_role_id` → flips
3. `PATCH /teams/:id` with a change to `onboarding_locale` → flips
4. `PATCH /teams/:id` with a change to `welcome_channel_id` → flips
5. **No-op save** (e.g. only `name` changes; onboarding fields identical) → status does NOT change. Assert with `SELECT onboarding_sync_status, onboarding_synced_at FROM teams` before+after — both columns unchanged.
6. `PATCH /teams/:id/settings` with a change to `discord_channel_training` → flips
7. `POST /teams/:id/onboarding/retry` → status flips, requires `team:manage`, returns 403 otherwise

### Bot pollLoop (`applications/bot/test/onboarding/ProcessorService.test.ts`)

8 cases:
1. Empty pending list → no Discord calls
2. Happy path → claim → GET → PUT (merged) → updateGuildWelcomeScreen → MarkOnboardingSyncDone with prompt_id; metric `onboarding_sync_total{status='success'}` incremented
3. `is_community_enabled === false` → **`RevertOnboardingSync` called (NOT `MarkFailed`)**; metric `onboarding_sync_total{status='skipped_no_community'}`; row left in `pending`
4. Stale prompt id → first PUT 404, second PUT (id stripped) succeeds; final status `done`
5. `RatelimitedResponse` → `MarkOnboardingSyncFailed(code='rate_limited')`; metric `failed`
6. `ErrorResponse{50035}` referencing role id → `MarkOnboardingSyncFailed(code='role_deleted')`; metric `failed`
7. **MarkSyncDone returns `{updated:false}`** (captain re-saved mid-sync) → ProcessorService logs info, does NOT increment success metric, does NOT clobber the pending state; next tick re-syncs
8. **`OnboardingRoleCache.invalidate(guildId)` is called** on the success path (case 2) and on the skipped-no-community path (case 3); assert with a spy/mock that the cache entry for that guild is dropped before the test ends. This proves a captain role-change is observable to `GuildMemberUpdate` within milliseconds rather than up to 60 seconds.

### Bot guildMemberUpdate (`applications/bot/test/events/guildMemberUpdate.test.ts`)

9 cases:
1. `pending: true` → no-op (cheap early bail; no RPC, no REST)
2. `pending: undefined` → no-op (cheap early bail)
3. `pending: false`, **cache hit** with `roleId === None` → no RPC fired, no REST fired
4. `pending: false`, **cache hit** with `roleId === Some(rid)`, member already has rid in `member.roles` → no RPC, no REST (idempotency)
5. `pending: false`, cache miss, RPC returns `Some(rid)`, member missing → cache populated, `addGuildMemberRole` called once, metric `onboarding_role_assigned_total` incremented
6. `pending: false`, cache miss, RPC returns `None` → cache populated, no REST
7. **Cache TTL expiry**: same guild, second event after >60s → RPC re-fired
8. RPC errors / REST errors → swallowed, logged
9. **Cache invalidation visibility**: cache populated with `Some(roleA)`. Simulate a sync (call `roleCache.invalidate(guildId)`). Next event for the same guild re-fetches via RPC (mocked to now return `Some(roleB)`) and assigns `roleB`, NOT `roleA`. Proves the staleness fix end-to-end.

### Bot READY backfill (`applications/bot/test/events/ready.test.ts`)

5 cases:
1. READY with 3 guilds (mix of COMMUNITY + non-COMMUNITY) → `SyncCommunityFlags` called once with all 3 entries, correct booleans
2. READY with 0 guilds → no RPC fired
3. RPC failure → swallowed, logged
4. **Pagination**: first page returns 200 guilds (full), second page returns 47 (short → loop terminates). Assert `listCurrentUserGuilds` called twice with the expected `after` cursor and that `SyncCommunityFlags` payload contains all 247 guild entries.
5. **Chunking**: 1 234 guilds returned across pages → `SyncCommunityFlags` called 3 times with chunk sizes 500/500/234.

### Bot guild_role events (`applications/bot/test/events/guildRoleEvents.test.ts`)

4 cases:
1. `GuildRoleCreate` → `Guild/UpsertGuildRole` called with the role's id/name/color/position/managed
2. `GuildRoleUpdate` → same `UpsertGuildRole` shape (the upsert handles both)
3. `GuildRoleDelete` → `Guild/DeleteGuildRole` called with `{guild_id, role_id}`
4. `GuildCreate` → `Guild/SyncGuildRoles` called once with the full role list from `guild.roles` (alongside the existing `SyncGuildChannels` call)

### Web e2e (`applications/web/test/teamSettings.onboarding.spec.ts`)

5 cases:
1. Card renders with current values, status badge correct
2. Save flips status to "Pending sync" (optimistic), invalidates loader
3. Failed (`role_deleted`) → typed copy shown ("The configured role no longer exists…"); Retry now → status flips to "Pending sync"
4. `!isCommunityEnabled` → fields disabled, Alert visible
5. Role select renders the list from `ListGuildRoles` with `@everyone` and managed roles filtered out

## 10. Open questions for user

_All previously-listed open questions have been resolved._

**Resolved — migration backfill aggressiveness:** all existing teams
default to `onboarding_sync_status='pending'` (the column's default).
Each team triggers exactly one PUT to Discord on the next pollLoop
tick after deployment, and the dfx in-memory token-bucket smooths the
burst (see §5 rate-limit-handling). One-time PUT-per-team is
acceptable and the simplest path; an opt-out is unnecessary because
teams that have no `rules_channel_id` / `onboarding_rules_role_id`
configured produce a no-op merge (our prompt is omitted per §7
step 4) and a successful PUT that just sets `enabled/mode/default_channel_ids`
based on whatever the captain already had.

**Resolved — `Guild/ListGuildRoles` execution path:** option (b),
table sync via `discord_guild_roles`. See §1 (migration), §2 (RPCs
`SyncGuildRoles` / `UpsertGuildRole` / `DeleteGuildRole`), §4
(`DiscordRolesRepository`), §5 (`guildCreate` bulk push +
`GuildRoleCreate/Update/Delete` handlers).

## 11. Final task list (numbered)

**Migrations & domain (1-5)**
1. Add `packages/migrations/src/before/1747000000_add_onboarding_columns.ts`
   with the 4-state CHECK + both partial indexes + `is_community_enabled`
   on `bot_guilds` + the new `discord_guild_roles` table (with
   `UNIQUE(guild_id, role_id)` + `idx_discord_guild_roles_guild_id`).
2. Extend `packages/domain/src/models/Team.ts` with 7 new fields.
3. Add `packages/domain/src/models/Onboarding.ts` (`OnboardingLocale`,
   `OnboardingSyncStatus`, `OnboardingSyncErrorCode`).
4. Extend `packages/domain/src/api/TeamApi.ts`: `TeamInfo`,
   `UpdateTeamRequest`, `retryOnboardingSync` endpoint.
5. Extend `packages/domain/src/rpc/guild/GuildRpcGroup.ts` with the
   ten new RPCs (`PendingOnboardingSyncs`, `MarkOnboardingSyncDone`,
   `MarkOnboardingSyncFailed`, `RevertOnboardingSync`,
   `GetOnboardingRulesRoleId`, `SyncCommunityFlags`, `ListGuildRoles`,
   `SyncGuildRoles`, `UpsertGuildRole`, `DeleteGuildRole`) and the
   `RegisterGuild.is_community_enabled` payload field;
   `pnpm -C packages/domain build`.

**i18n (6)**
6. Add bot + web keys (including the 5 typed-error copy keys) to
   `packages/i18n/messages/{en,cs}.json`; `pnpm -C packages/i18n codegen`.

**Server (7-12)**
7. Extend `applications/server/src/repositories/TeamsRepository.ts`:
   new update fields, atomic-claim `claimPendingOnboardingSyncs`, the
   conditional `markOnboardingSyncDoneIfSyncing` (writes JSON
   `{code, detail}` to `onboarding_sync_error`) /
   `markOnboardingSyncFailedIfSyncing`, the `revertOnboardingSyncIfSyncing`,
   `markOnboardingSyncPending`, `getOnboardingRulesRoleId`, plus the
   pure `hasOnboardingFieldChange` helper.
8. Extend `applications/server/src/repositories/BotGuildsRepository.ts`
   for `is_community_enabled` + `bulkUpdateCommunityFlags`.
9. **New** `applications/server/src/repositories/DiscordRolesRepository.ts`:
   `syncRoles` (delete-then-insert), `upsertRole` (ON CONFLICT),
   `deleteRole`, `listByGuild` — mirrors `DiscordChannelsRepository`.
10. Add 10 new RPC handlers + extend `RegisterGuild` in
    `applications/server/src/rpc/guild/index.ts`. The
    `Guild/ListGuildRoles` handler reads from `discord_guild_roles`
    (resolved option (b)).
11. Update `applications/server/src/api/team.ts`: extend `teamToInfo`
    with `isCommunityEnabled` + JSON-parsed `{code, detail}` from
    `onboarding_sync_error` (with `unknown` fallback), gate auto-flip
    to `pending` behind `hasOnboardingFieldChange(...)`, add
    `retryOnboardingSync` handler.
12. Update `applications/server/src/api/team-settings.ts`: gate the
    onboarding auto-flip on `discord_channel_training` actually
    changing (parallel to step 11).

**Bot (13-19)**
13. Add `applications/bot/src/services/OnboardingRoleCache.ts`
    (Effect.Tag, 60s TTL Map, exposing `get` + **`invalidate`**).
14. Add `applications/bot/src/rcp/onboarding/payloadBuilders.ts`
    (pure functions).
15. Add `applications/bot/src/rcp/onboarding/errorClassifier.ts`
    (typed error parser).
16. Add `applications/bot/src/rcp/onboarding/ProcessorService.ts` +
    `index.ts` (poll loop, mirrors guildJoin; rate-limit-aware via
    dfx; **calls `roleCache.invalidate(team.guild_id)` on every
    success and on the skipped-no-community path** so role-id
    staleness window collapses to milliseconds).
17. Wire `OnboardingSyncService` + `OnboardingRoleCache` into
    `applications/bot/src/AppLive.ts`, `applications/bot/src/Bot.ts`,
    `applications/bot/src/rcp/index.ts`.
18. Update `applications/bot/src/events/index.ts`:
    - `guildCreate.is_community_enabled` on `Guild/RegisterGuild`,
    - new bulk `Guild/SyncGuildRoles` push from `guild.roles` in `guildCreate`,
    - new `READY` handler with **paginated `listCurrentUserGuilds`
      loop using `after` cursor** + **chunked `SyncCommunityFlags`
      calls (≤500 guilds per RPC)**,
    - new `GuildRoleCreate` / `GuildRoleUpdate` / `GuildRoleDelete`
      handlers calling `Guild/UpsertGuildRole` / `Guild/DeleteGuildRole`,
    - live `guildMemberUpdate` handler with cheap early bail +
      cache + idempotency check.
19. Append `onboardingSyncTotal` (counter, labelled by status),
    `onboardingSyncDurationMs` (histogram), `onboardingRoleAssignedTotal`
    (counter) to `applications/bot/src/metrics.ts`.

**Web (20-23)**
20. `pnpm -C applications/web dlx shadcn@latest add alert toggle-group`.
21. Add `success` variant to
    `applications/web/src/components/ui/badge.tsx`.
22. Add the Onboarding card to
    `applications/web/src/components/pages/TeamSettingsPage.tsx`
    (state, save handler, retry handler, `SearchableSelect` for roles
    fed by `ListGuildRoles` — filter `@everyone` (id === guild_id)
    and `managed===true` client-side, Alert, ToggleGroup, typed-error
    copy rendering).
23. Update the loader at
    `applications/web/src/routes/(authenticated)/teams/$teamId/settings.tsx`
    to fetch the role list in parallel with the channel list.

**Tests (24-31)**
24. Unit tests for `payloadBuilders.ts` (10 cases).
25. Unit tests for `mergeOnboardingPayload` (5 cases — id-only identity).
26. Unit tests for `errorClassifier.ts` (6 cases — typed deleted-role
    / channel detection).
27. Server RPC integration tests (12 cases — atomic claim, conditional
    MarkDone, concurrent claim, SyncCommunityFlags, ListGuildRoles,
    SyncGuildRoles/Upsert/Delete, JSON error round-trip).
28. Server HTTP integration tests (7 cases — including no-op save
    doesn't churn status).
29. Bot `ProcessorService` (8 cases — including cache-invalidate on
    success + skipped-no-community) + `guildMemberUpdate` (9 cases —
    cache hit, cache miss, TTL expiry, **invalidation visibility**) +
    READY (5 cases — including pagination + chunking) + `guildRole*`
    events (4 cases).
30. Web e2e tests on the new card (5 cases — including role select).

**Verification (31)**
31. Manual run-through against the acceptance list at
    `discord-native-onboarding.md:243-252`; bump changesets if needed.
