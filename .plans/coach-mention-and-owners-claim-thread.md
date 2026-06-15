# Plan: Coach mention on "Starting now" + single owners claim thread

Two related changes to the coach-claiming / event-start flow, shipped together.

---

## Change A — "Starting now" post mentions the assigned coach, not the member group

**Today:** when a training starts, the "Starting now" post (`applications/bot/src/rcp/event/handleStarted.ts:199-209`) pings the **member-group role** via `content: <@&${event.discord_role_id}>`. That role ping is how everyone learns training is starting.

**Confirmed product decisions:**
- Coach assigned → ping the **coach only** (`<@coachId>`), replacing the group ping. Embed still posts to the member channel (members still see it; only the ping changes).
- No coach assigned → ping the **owners group** (a *distinct* role) with a warning that no coach claimed the training.
- Just the mention — **no** new "Coach" embed field.
- Non-training events keep today's behavior (member-group ping).

### Server
1. **`packages/domain/.../EventRpcEvents.ts`** — add ONE field to `EventStartedEvent`: `claimed_by_discord_id: Schema.OptionFromNullOr(Discord.Snowflake)`. (The owners role rides on the existing `discord_role_id` field — see below.)
2. **`EventsRepository.findStartable`** — add `e.claimed_by` to the SELECT + Result schema (`Schema.OptionFromNullOr(TeamMember.TeamMemberId)`).
3. **`EventStartCron.ts`** — branch on `event.event_type`:
   - `training` → resolve the **owners** role via `resolveGroupRoleId(team_id, owner_group_id)` and pass it in the existing `discordRoleId` slot; pass `event.claimed_by` as the new `claimedByMemberId`.
   - non-training → unchanged: member-group role in `discordRoleId`, no coach.
4. **`EventSyncEventsRepository.emitEventStarted`** — add trailing `claimedByMemberId: Option<TeamMemberId> = Option.none()` param and forward it to `_emitIfGuildLinked` (already inserts `claimed_by_member_id`; the `findUnprocessed` JOIN already resolves `claimed_by_discord_id`). Mind positional arg order at the call site.
5. **`rpc/event/events.ts`** (`event_started` branch) — map `claimed_by_discord_id: r.claimed_by_discord_id`. `discord_role_id` mapping stays (now carries owners role for trainings).

### Bot — `handleStarted.ts` (replace the `roleMention` block)
Three-way decision, gated on `event.event_type === 'training'`:
1. coach has Discord id → `content: <@coachId>`, `allowed_mentions: { parse: [], users: [coachId] }`.
2. no coach (or coach has no linked Discord) **and** owners role present → `content: <@&ownersRoleId> <warning>`, `allowed_mentions: { parse: [], roles: [ownersRoleId] }`.
3. neither → `content: <warning>`, no `allowed_mentions`.
Non-training → unchanged member-group ping.

> Edge case: coach claimed but no linked Discord account → `claimed_by_discord_id` is `None` → falls into case 2 (owners warning). Documented + logged.

### i18n
Add `bot_event_started_no_coach_warning` to `en.json` / `cs.json` (e.g. "No coach claimed this training." / "Tento trénink si nezabral žádný trenér.").

---

## Change B — one persistent owners claim thread; delete claim on start

**Today:** each training claim posts an embed to the owner-group channel (`handleTrainingClaimRequest.ts:56-60`), then spins off a **per-training thread** via `createThreadFromMessage` (lines 76-121). Claim msg id/channel persisted on `events`.

**Desired:** ONE persistent thread **per owners group** holds ALL claim embeds (channel-like). When a training starts, its claim message is **deleted** from that thread to avoid spam.

### Migration
- New migration (timestamp > `1789300000`): `ALTER TABLE discord_channel_mappings ADD COLUMN IF NOT EXISTS claim_thread_id TEXT` (nullable, created lazily). Keyed per `(team_id, group_id)` → naturally one thread per owners group.

### Server
1. **`DiscordChannelMappingRepository`** — add `claim_thread_id` to `MappingRow` + all SELECTs. Add:
   - read via existing `findByGroupId`.
   - **`saveClaimThreadIfAbsent(teamId, groupId, threadId)`** — atomic: `UPDATE ... SET claim_thread_id = ${threadId} WHERE team_id=... AND group_id=... AND claim_thread_id IS NULL RETURNING claim_thread_id`. Returns the winning thread id (the just-set one, or the pre-existing one). **This resolves the duplicate-thread race.**
   - **`clearClaimThread(teamId, groupId)`** — for recreate-on-delete.
2. **New RPCs** in `EventRpcGroup.ts` + `rpc/event/index.ts`:
   - `Event/GetOwnerClaimThread({ team_id, owner_group_id }) -> Option<Snowflake>`
   - `Event/SaveOwnerClaimThread({ team_id, owner_group_id, thread_id }) -> Option<Snowflake>` (returns winner via `saveClaimThreadIfAbsent`).
   - `Event/ClearOwnerClaimThread({ team_id, owner_group_id })`.
3. **`TrainingClaimRequestEvent`** (domain) — add `owner_group_id: Schema.OptionFromNullOr(GroupModel.GroupId)`.
4. **`emitTrainingClaimRequest`** — carry `owner_group_id` via the existing **`member_group_id`** column (unused for claim-request rows today). **`events.ts`** claim-request branch maps `owner_group_id: r.member_group_id`. (Documented column overload — avoids an event_sync migration.)

### Bot — `handleTrainingClaimRequest.ts` (rewrite steps 1-3)
1. `owner_group_id` none / no owner channel → log + skip (as today).
2. `GetOwnerClaimThread`. If `some` → use it. If `none` → `rest.createThread(ownerChannelId, { name: m.bot_claim_thread_name(), type: 11 PUBLIC_THREAD, auto_archive_duration: <max> })`, then `SaveOwnerClaimThread`:
   - if the returned winner ≠ the thread we just made (lost the race) → `rest.deleteMessage`/delete our orphan thread and use the winner.
3. Post the claim embed via `rest.createMessage(threadId, { embeds, components })`.
4. On `10003 Unknown Channel` (thread deleted) → `ClearOwnerClaimThread`, recreate, retry once. (Archived threads auto-unarchive on post — **not** treated as failure.)
5. `SaveClaimDiscordMessageId({ event_id, channel_id: threadId, message_id })` — store the **thread id** as the claim channel. `handleTrainingClaimUpdate` keeps working unchanged (a thread id *is* a channel id).
6. **Remove** the old `createThreadFromMessage` per-training block + `buildThreadName`; stop calling per-event `SaveClaimThreadId`. (`events.claim_thread_id` becomes dead — left in place, no longer written.)

### Bot — `handleStarted.ts` delete-on-start
Add a third independent best-effort branch (`safeDeleteClaim`) to the existing `Effect.all([...], { concurrency: 'unbounded' })`, **separate from** the Change-A edits:
- gate on `event.event_type === 'training'`.
- `Event/GetClaimInfo({ event_id })`; if `claim_discord_channel_id` (thread id) + `claim_discord_message_id` present → `rest.deleteMessage(threadId, msgId)`.
- swallow `10008 Unknown Message` (already gone). Never fail the handler.

> Old in-flight claims (stored `channel_id` = owner channel, not a thread) still delete correctly because the stored `channel_id` is self-describing — no backfill needed.

### i18n
Add `bot_claim_thread_name` (e.g. "Training claims" / "Nábor trenérů").

---

## Edge cases (both changes)
- Coach without linked Discord → owners-group warning ping (Change A case 2).
- No owners group / no mapped owner channel → skip thread creation; "Starting now" shows warning text with no ping.
- Owners thread deleted by a user → recreate on next claim (history loss logged); archived → auto-unarchives on post.
- Concurrent bulk claim emits for one group → atomic `saveClaimThreadIfAbsent` guarantees a single thread.
- Both changes edit `handleStarted.ts`: land Change A's mention edit and Change B's `safeDeleteClaim` as separate, independent branches in the same `Effect.all`.

## Build / order
- `packages/domain` changed → `pnpm build` before bot/server typecheck.
- `packages/i18n` changed → rebuild (paraglide) so new `m.*` keys exist.
- New migration auto-runs; timestamp must exceed `1789300000`.

## Tests
- **Change A bot** (`handleStarted.test.ts`): coach→user ping; no-coach→owners role ping + warning; neither→warning only; non-training→member-group ping unchanged; coach-no-discord→owners warning.
- **Change A server** (`EventStartCron.test.ts`): training emits `claimed_by_member_id` + owners role in `discord_role_id`; non-training emits member-group role; `events.ts` maps `claimed_by_discord_id`.
- **Change B bot** (`handleTrainingClaimRequest.test.ts`): no thread→create+save+post into thread; existing thread→post, no create; lost race→delete orphan, use winner; 10003→recreate+retry; no owner channel→skip.
- **Change B start** (`handleStarted.test.ts`): claim present→deleteMessage once; none→no delete; 10008→swallowed; non-training→no delete.
- **Change B server**: `saveClaimThreadIfAbsent` atomicity (second caller gets first's id); RPC round-trips; claim-request emits `owner_group_id`.
- **Migration**: `claim_thread_id` column exists + nullable.

## Risks
- `discord_role_id` semantics for `event_started` rows now depend on `event_type` (owners role for trainings, member-group otherwise) — branch lives in cron + bot; covered by tests.
- `member_group_id` column overloaded to carry `owner_group_id` for claim-request rows — documented.
- `claim_discord_channel_id` now stores a thread id — fine for update/delete/jump-link; any analytics assuming it equals the parent channel would be wrong.
- Removing per-training threads: verified nothing else reads `events.claim_thread_id`.
