# Plan: Admin can manage achievements

**Story:** 30693506-0818-819a-b5e2-f495d859cc1b
**Branch:** `feat/manage-achievements`
**Tasks:** 4 (15h total)
**Design spec:** `docs/design/manage-achievements.md`

## Scope decision (after critique)

This story delivers a **minimum viable** admin page where admins can:
- Override the threshold for any built-in achievement (per-team)
- Map any achievement (built-in or custom) to a Discord role — pick existing or auto-create
- Preview the qualification impact of a threshold change (count + sample list of removed players)
- Create / edit / delete custom achievements (CRUD-only — evaluation/earning for customs is a follow-up)

**Out of scope (deferred to follow-ups):**
- Custom achievements being evaluated, earned, or granted Discord roles automatically
- Custom achievements being displayed in the player-facing `AchievementsGrid`
- A new `achievement:manage` permission

## Transport decision

Web admin pages all use HTTP API (`api.<group>.<endpoint>()`), confirmed via `applications/web/src/components/pages/AgeThresholdsPage.tsx`, `RolesListPage.tsx`, `TrainingTypesListPage.tsx`. The existing `AchievementRpcGroup` is bot-only.

**Decision:** add a new `AchievementApiGroup` (HTTP) for admin operations. Keep `AchievementRpcGroup` for bot sync.

## Data model

### `achievement_settings` (new)
Per-team threshold overrides for built-in achievements only.

```sql
CREATE TABLE achievement_settings (
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  achievement_slug TEXT NOT NULL,
  threshold_override INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, achievement_slug)
);
```

### `custom_achievements` (new)
Admin-created achievements.

```sql
CREATE TABLE custom_achievements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  emoji TEXT,
  rule_kind TEXT NOT NULL,
  threshold INTEGER NOT NULL CHECK (threshold > 0),
  activity_type_slug TEXT,
  discord_role_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, name)
);
CREATE INDEX idx_custom_achievements_team ON custom_achievements(team_id);
```

### `team_members.longest_streak_cache` (new column)
Cached longest-streak per member, refreshed by `AchievementEvaluator.evaluate`. Avoids loading all activity rows on every preview keystroke.

### `discord_role_provision_events` (new — outbox)
Idempotent outbox for auto-creating Discord roles.

```sql
CREATE TABLE discord_role_provision_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  desired_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  error TEXT,
  UNIQUE (team_id, kind, ref_id)
);
CREATE INDEX idx_drpe_unprocessed ON discord_role_provision_events(created_at) WHERE processed_at IS NULL;
```

The `UNIQUE (team_id, kind, ref_id)` constraint makes retries idempotent. Bot also reuses existing roles by name (see Task 3) so duplicate Discord roles can never be created.

## Domain catalog change (minimal, non-breaking)

`packages/domain/src/models/Achievement.ts`:

- **`AchievementSlug` stays a closed `Schema.Literals`.** Do not widen.
- Refactor each catalog entry to take `threshold` as a parameter:
  ```ts
  interface AchievementCatalogEntry {
    readonly slug: AchievementSlug;
    readonly grantsDiscordRole: boolean;
    readonly defaultThreshold: number;
    readonly isEarned: (input: AchievementEvaluationInput, threshold: number) => boolean;
  }
  ```
- Add `effectiveThreshold(slug, overrides: ReadonlyMap<AchievementSlug, number>): number`.

This is a strictly additive refactor; closures keep their existing logic, just parameterised on `threshold`.

## API surface

New file `packages/domain/src/api/AchievementApi.ts`, group `'achievement'`:

| Method | Path | Name |
|---|---|---|
| GET | `/teams/:teamId/achievements` | `listAchievements` |
| GET | `/teams/:teamId/achievements/built-in/:slug/preview?threshold=<n>` | `previewBuiltInThreshold` |
| PUT | `/teams/:teamId/achievements/built-in/:slug/threshold` | `setBuiltInThreshold` |
| PUT | `/teams/:teamId/achievements/:keyOrId/role-mapping` | `setRoleMapping` |
| POST | `/teams/:teamId/achievements/custom` | `createCustom` |
| PATCH | `/teams/:teamId/achievements/custom/:customId` | `updateCustom` |
| DELETE | `/teams/:teamId/achievements/custom/:customId` | `deleteCustom` |

`previewBuiltInThreshold` returns:
```ts
{
  qualifyingCount: number;
  removedMembers: ReadonlyArray<{ teamMemberId, memberName }>; // max 100
  botCanManageRoles: boolean;
}
```

`setRoleMapping` payload:
```ts
{ source: 'existing', roleId: Discord.Snowflake }
| { source: 'auto_create' }
| { source: 'none' }
```

`'auto_create'` enqueues a `discord_role_provision_events` row; bot picks it up and writes the role id back via RPC.

**Errors:** `AchievementForbidden` (403), `AchievementNotFound` (404), `CustomAchievementNotFound` (404), `CustomAchievementNameTaken` (409), `InvalidThreshold` (400), `InvalidCustomRule` (400), `NoGuildLinked` (400).

**Permissions:** all endpoints require `'team:manage'` (no new permission).

## Task → file mapping

### Task 1: Domain & migration (3h)

**Create:**
- `packages/migrations/src/before/1747700000_achievement_admin.ts`
- `packages/domain/src/models/CustomAchievement.ts`
- `packages/domain/src/api/AchievementApi.ts`

**Modify:**
- `packages/domain/src/models/Achievement.ts` — parameterise `isEarned`, add `defaultThreshold` + `effectiveThreshold` helper
- `packages/domain/src/index.ts` — re-exports
- `applications/server/src/api/api.ts` — register new API group

After Task 1: `pnpm --filter @sideline/domain build`.

### Task 2: Server (server slice of all tasks — repos, handlers, evaluator, preview)

**Create:**
- `applications/server/src/repositories/AchievementSettingsRepository.ts`
- `applications/server/src/repositories/CustomAchievementsRepository.ts`
- `applications/server/src/repositories/DiscordRoleProvisionEventsRepository.ts`
- `applications/server/src/services/AchievementPreview.ts`
- `applications/server/src/api/achievement.ts` (`AchievementApiLive` — 7 endpoints)

**Modify:**
- `applications/server/src/services/AchievementEvaluator.ts` — wire threshold override (built-ins only); persist `longest_streak_cache`
- `applications/server/src/AppLive.ts` — register new repos
- `applications/server/src/api/index.ts` — provide `AchievementApiLive`

### Task 3: Bot — role provisioning (3h)

**Create:**
- `applications/bot/src/rcp/roleProvision/ProcessorService.ts` (polls outbox)
- `applications/bot/src/rcp/roleProvision/handleProvisionRole.ts` (reuses role by name; falls back to create)

**Modify:**
- `packages/domain/src/rpc/...` — add `RoleProvision/GetUnprocessedEvents`, `MarkProcessed`, `MarkFailed`, plus `UpsertAchievementRoleMapping` & `UpsertCustomAchievementRoleMapping`
- `applications/server/src/rpc/...` — register handlers
- `applications/bot/src/AppLive.ts` — schedule the new ProcessorService

### Task 4: Web admin page (6h)

**Create:**
- `applications/web/src/components/pages/AchievementsAdminPage.tsx`
- `applications/web/src/routes/(authenticated)/teams/$teamId/achievements.tsx`

**Modify:**
- One nav link from `TeamSettingsPage.tsx` (or sidebar) to the new admin page

**UX decisions (from design spec + critique):**
- Threshold change with disqualified players → inline confirmation checkbox (no `window.confirm`)
- Delete custom achievement → `window.confirm` (matches `AgeThresholdsPage.tsx`)
- Auto-create role radio disabled with tooltip when `!botCanManageRoles`
- Activity-type selector only visible when `ruleKind === 'activity_type_count'`

**i18n keys** (en + cs placeholders) under namespace `achievement_admin_*`.

**NOT modified:** `applications/web/src/components/organisms/AchievementsGrid.tsx` (player-facing — out of scope).

## Test specification (~10 tests, not 36)

| # | File | Test |
|---|------|------|
| 1 | `packages/domain/test/Achievement.test.ts` | `AchievementSlug` rejects unknown slugs (regression for closed-literal) |
| 2 | `applications/server/test/Achievement.test.ts` | PUT `setBuiltInThreshold` happy path |
| 3 | " | POST `createCustom` happy path |
| 4 | " | POST `createCustom` duplicate-name → 409 |
| 5 | " | POST `createCustom` invalid rule → 400 |
| 6 | " | GET `previewBuiltInThreshold` shape (qualifyingCount + removedMembers + botCanManageRoles) |
| 7 | " | Permission check — non-admin → 403 |
| 8 | `applications/server/test/services/AchievementEvaluator.test.ts` | Default behaviour unchanged when no override exists |
| 9 | " | Per-team override applied — member with `totalActivities=20` does NOT earn `ten_activities` when override `=25` |
| 10 | `applications/server/test/integration/repositories/DiscordRoleProvisionEventsRepository.test.ts` | `enqueue` is idempotent (uniqueness constraint) |
| 11 | `applications/bot/test/rcp/roleProvision/handleProvisionRole.test.ts` | Reuses existing role with same name (no duplicate create) |

## Risks

- **Catalog refactor** must be rebuilt: `pnpm --filter @sideline/domain build` is mandatory after editing `Achievement.ts`. Consumers symlink to `dist`.
- **`bot_guilds.permissions` source** for `botCanManageRoles`: if no such column, fall back to one Discord REST call cached 60s per (teamId, guildId).
- **Migration ordering**: timestamp `1747700000` runs before existing `1778716800`. If deployed and edited later, apply with `bin/psql --pr <n>` per AGENTS.md.
- **Custom evaluation deferred**: customs are CRUD-only in this story. PR description must call this out so reviewers don't expect role granting for customs.

## Build commands

- After domain edits: `pnpm --filter @sideline/domain build`
- After migration package edits: `pnpm --filter @sideline/migrations build`
- After i18n edits: `pnpm codegen`
- Full check: `pnpm check && pnpm test`
