# Fix: role-only groups never provisioned → channel-access grants silently skipped

**Bug ID:** 37b93506-… (High, Production) · **Branch:** `fix/channel-management-multi-group` · **PR #404**

## Real root cause (confirmed via prod logs + DB)
- Group "Návštěva" (`17b3287c…`, team `e2686d09…`, guild-linked, 56 members) is a **role-only** group (role, no channel — intended). It has **no `discord_channel_mappings` row at all** → no resolvable Discord role.
- `setAccess` therefore silently skips its grants: prod log `setAccess: skipping grant … no discord_role_id resolved` (multiple times). The DB grant in `team_channel_access` persists; no Discord overwrite is ever emitted → "nothing happens".
- It was never provisioned (no `channel_created` event ever) — its members predate provisioning, and **nothing re-provisions a pre-existing group**. 11 sibling groups in the team ARE provisioned.
- Two prior passes missed that **backfilling the role is not enough**: the stored grant must also be **re-applied**, and the only existing reconcile is keyed on channels, not groups.

## The fix (approved: full scope, bot-cron trigger, fold #404 in)

**Task 1 — Bot role-only idempotency.** Make the role-only branch in `applications/bot/src/rcp/channel/handleCreated.ts` `GetMapping`-first (mirror `handleMemberAdded.ts`): if the group already has a `discord_role_id`, no-op; if it has a channel but no role, `createRoleForChannel`; else `createRoleOnly`. Prevents duplicate Discord roles on re-emit.

**Task 2 — Detection query.** Add `findGroupsMissingRole(teamId?)` to `DiscordChannelMappingRepository`: groups in guild-linked teams with no mapping row OR `discord_role_id IS NULL` (skip archived). Same set whose grants get skipped.

**Task 3a — Grant reapply on role none→set (the missing piece).** Internal server helper (invoked from the `Channel/UpsertMappingRoleOnly` and `Channel/UpsertMapping` RPC handlers, gated on a none→Some `discord_role_id` transition): read `team_channel_access` grants for the group, resolve the now-existing role, and `emitManagedAccessGrantedBatch` for each provisioned channel. Reuses `buildManagedAccessGrantEntries`. Generalizes the channel-axis reconcile to the group axis; makes backfill + member-add self-heal + createChannel all grant-correcting. Needs `findGrantsByGroup(groupId)` on `TeamChannelAccessRepository`.

**Task 3b — Backfill emitter.** `Channel/BackfillMissingGroupRoles({ teamId?, limit })`: for each detected group, compute name/role/color like `createGroup` (reuse `applyDiscordFormat`, team `create_discord_channel_on_group` setting), then `emitChannelCreated(…, channelName = setting ? Some : None, …)`. Double-protected against duplicate roles (Task 2 predicate + Task 1 idempotency).

**Trigger:** low-cadence tick in the bot's existing channel poller (`ProcessorService`) invoking `Channel/BackfillMissingGroupRoles`.

**Task 4 — Lazy heal in `setAccess`.** When a grant hits a role-less group, also enqueue provisioning (best-effort, don't fail the request) so it self-heals on next edit. Grant re-applied automatically via 3a once the role lands.

**#404 work (already committed on branch):** keep the `roleResolvable` surfacing ("Not yet active in Discord"); with this fix it becomes a brief transient state. One coherent PR (#404 grows into the full fix).

## Idempotency
3 layers: detection predicate targets only role-less groups; bot GetMapping-first no-ops duplicates; mapping upsert `ON CONFLICT`. Grant reapply gated strictly on none→Some transition (avoid spurious re-emit on every member-add). Confirm `handleManagedAccessGranted` is an upsert (idempotent).

## RESOLVED DESIGN DECISIONS (post-hater / verified specifics)

- **Archived column:** `groups.is_archived BOOLEAN` → detection uses `g.is_archived = false` (NOT `IS NULL`).
- **Transition detection (3a), race-safe, single statement:** change `insertRoleOnly` & `insert` in `DiscordChannelMappingRepository` from `SqlSchema.void` to `SqlSchema.findOne` returning `{ old_role_id: Schema.OptionFromNullOr(Discord.Snowflake) }` via a CTE:
  `WITH prev AS (SELECT discord_role_id AS old_role_id FROM discord_channel_mappings WHERE team_id=$ AND group_id=$) INSERT … ON CONFLICT (team_id,group_id) WHERE group_id IS NOT NULL DO UPDATE SET … RETURNING (SELECT old_role_id FROM prev) AS old_role_id`.
  The `Channel/UpsertMappingRoleOnly` and `Channel/UpsertMapping` handlers fire the grant-reapply helper ONLY when `Option.isNone(old_role_id)` and the new role is set. Preserves upsert semantics (role re-mapping still works). Rare concurrent double-fire is harmless — `handleManagedAccessGranted` is an idempotent `PUT /channels/:id/permissions/:overwriteId` (confirmed).
- **In-flight guard (MANDATORY) for 3b + Task 4:** before emitting `channel_created`, exclude groups that already have an unprocessed event. Reuse existing `ChannelSyncEventsRepository.hasUnprocessedForGroups` / add `AND NOT EXISTS (SELECT 1 FROM channel_sync_events WHERE group_id=g.id AND event_type IN ('channel_created','channel_updated',…) AND processed_at IS NULL AND error IS NULL)` to `findGroupsMissingRole`. Prevents duplicate Discord roles across repeated ticks/retries (`createRoleOnly` is unconditional — `createRoleOnly.ts:14-17`).
- **3a channel guard:** filter the group's grants to channels with a resolvable `discord_channel_id`; log+skip the rest (mirror `UpsertManagedChannel` reconcile, `rpc/channel/index.ts:329-351`).
- **Backfill bounding:** `Channel/BackfillMissingGroupRoles({ team_id?, limit })` — default `limit` ~20 per tick so a first-deploy backlog drains gradually (avoid Discord 429). Bot processes events at existing `concurrency: 1`.
- **Bot cron trigger:** add `slowPollLoop = (t) => resilientTick(t).pipe(Effect.repeat(Schedule.spaced('5 minutes')))` in `applications/bot/src/Bot.ts` (alongside `pollLoop`/`fastPollLoop`, lines 44-48) wired into the `Effect.all([...], {concurrency:'unbounded'})` (lines 89-110). New service exposes a `processTick` that calls `rpc['Channel/BackfillMissingGroupRoles']({})` with `Effect.tap` (log count) + `Effect.tapError`. Pattern: `weeklySummary/ProcessorService.ts:71`.
- **Domain:** add `Rpc.make('BackfillMissingGroupRoles', { payload: { team_id: optional Team.TeamId, limit: optional Number }, success: Schema.Number })` to `packages/domain/src/rpc/channel/ChannelRpcGroup.ts` (merged via `SyncRpcs.ts`). Run `pnpm build` after. 3a stays an INTERNAL server helper (no RPC).
- **Server handler registration:** add `Effect.let('Channel/BackfillMissingGroupRoles', …)` in `applications/server/src/rpc/channel/index.ts`; acquire extra repos LAZILY inside the handler via `Repo.asEffect()` (like `Channel/UpsertManagedChannel` at 267-358) to avoid the TS pipe-depth issue noted at lines 265-266.
- **createGroup mirror (3b):** `applyDiscordFormat(settings.discord_channel_format ?? DEFAULT_CHANNEL_FORMAT, name, emoji)` for channel name; `applyDiscordFormat(settings.discord_role_format ?? DEFAULT_ROLE_FORMAT, …)` for role; `Option.map(group.color, hexColorToDiscordInt)`; `createChannel = settings.create_discord_channel_on_group ?? true`; then `emitChannelCreated(teamId, groupId, name, Option.none(), createChannel ? channelName : undefined, roleName, color)`. Settings via `TeamSettingsRepository.findByTeamId` (field `create_discord_channel_on_group`).
- **Repo `make` may use `Effect.gen`** (established repo idiom, e.g. GroupsRepository/TeamSettingsRepository) — match existing style for repo methods; use `Effect.Do.pipe` in RPC handlers.

## Out of scope / notes
- The lone stuck `member_removed` event (06-11 08:31, no backlog) — minor, separate; note but don't fix here.
- No domain RPC additions if 3a is an internal helper; `BackfillMissingGroupRoles` can be server-internal cron-invoked.
- Verify `groups` archived column name before writing the detection SQL.
