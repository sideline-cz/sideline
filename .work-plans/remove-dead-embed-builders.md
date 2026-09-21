# Delete dead embed builders

**Bug:** Smazat mrtvé embed buildery `buildEventEmbed` a `buildEventListEmbed`
**Notion:** 3d89350608188112856dc6a524380a0b · Low · Discord Bot
**Branch:** `fix/remove-dead-embed-builders`

## Why

Neither builder has a production caller. Both were *patched* during the all-day fix
(#640–#647) rather than deleted, so they still carry all-day rendering logic that would
reintroduce the bug if revived. The global events board they rendered was removed in
`32858e3d` (#547) — `ProcessorService.ts:25-32` decodes and no-ops the four event outbox
kinds.

## Death certificate (verified twice, independently)

| Symbol | Live src callers | Verdict |
|---|---|---|
| `buildEventEmbed` | none | dead |
| `buildEventListEmbed` | none | dead |
| `buildCancelledEmbed` | none (board's cancelled renderer) | dead |
| `PAGE_SIZE` (buildEventListEmbed) | none | dead |
| `YES_EMBED_LIMIT` | **4** | must survive |

Checked: repo-wide grep (ts/tsx/md/json/scripts), no dynamic `import(` in bot src,
`src/index.ts` hand-curated barrel does not re-export them, all nested `index.ts` barrels
clean. `event-list-page:` custom_ids have no handler. No collateral dead helpers —
`discordDateInstant`, `locationDisplay`, `formatEventWhen`, `formatName` all keep other users.

**One handler IS orphaned by this deletion**, found in review: `buildEventEmbed` was the only
producer of `rsvp:` custom_ids, so `RsvpButton` (`src/interactions/rsvp.ts`) — and the
`rsvp-add-msg:` / `rsvp-clear-msg:` / `rsvp-modal:` handlers it replies with — is now reachable
only from pre-#547 board messages still sitting in guild channels. Kept deliberately so those
stale buttons keep working, with a source comment saying so. Deleting it is a follow-up.

## Changes

### 1. Delete 5 files
- `applications/bot/src/rest/events/buildEventEmbed.ts`
- `applications/bot/src/rest/events/buildEventListEmbed.ts`
- `applications/bot/test/buildEventEmbed.test.ts`
- `applications/bot/test/buildEventListEmbed.test.ts`
- `applications/bot/test/rest/events/buildEventEmbed.test.ts`

### 2. Move `YES_EMBED_LIMIT` to `applications/bot/src/rest/utils.ts`

Next to the existing `EMBED_FIELD_VALUE_LIMIT` / `POLL_BATCH_SIZE`. It is already the bot's
home for shared Discord render/batch limits; the 4 importers span three trees
(`rest/events/`, `rcp/personalEvents/`, `interactions/`), so a neutral shared module beats
parking it in one sibling builder. No cycle (utils imports only `@sideline/domain`, `effect`,
and a type). Precedent: `ProcessorService.ts:7` already imports `POLL_BATCH_SIZE` from there.

Repoint 4 imports: `sendUpcomingEventFollowups.ts` → `'../utils.js'`;
`reorderPersonalChannel.ts`, `handleReconcile.ts`, `upcoming-rsvp.ts` → `'~/rest/utils.js'`.

### 3. Delete 5 orphaned i18n keys (en.json + cs.json together)
`bot_event_list_title`, `bot_event_list_footer`, `bot_event_list_empty`, `bot_event_cancelled`,
`bot_event_started` — last referencers are the deleted builders. (`bot_event_started` was found
in review; the plan originally undercounted at four.) Both locales must change together or
`keyParity.test.ts` fails. **Do not touch** `bot_event_list_error`, `bot_btn_prev`,
`bot_btn_next` — all live.

### 4. Fix docs that name the deleted code
`applications/bot/AGENTS.md`: drop the tree line (L55); collapse the "two Discord surfaces"
block to the one real surface (L511-519); delete the `Events-Channel Move` section
(L567-584, documents nonexistent `handleChannelMoved.ts`); drop `+ global refresh` from the
header (L586) and the global-refresh clause (L588); delete reconcile step 3 and renumber
(L624); trim `on BOTH surfaces` from rule 2 (L630); `buildEventEmbed.ts` →
`buildUpcomingEventEmbed.ts` (L1013).

`applications/server/AGENTS.md`: delete the `Global shared events channel` table row and
retitle the section (L772-780); note `discord_events_channel_id` is settings-only now.

Plus two hater-found fixes inside hunks we already touch:
- L623 item 2 points at `reorderChannelMessages.ts`, which does not exist → `channelReorderPrefix.ts`.
- One sentence in the Event Sync intro flagging the remaining #547 doc rot.

### 5. Scope expansion — approved during review

The plan originally deferred the wider #547 doc rot to a follow-up ticket. **The user chose to
fix all of it here instead**, so this PR also corrects:

- `applications/bot/AGENTS.md` — file-tree entries for six files deleted in #547; the whole
  `Channel Reorder Algorithm` section, rewritten from source as
  `reorderPersonalChannel` + `channelReorderPrefix` (the old text named `MAX_CHANNEL_EVENTS`,
  `EditOutcome` and `processKeptPrefix`, none of which exist, and was phrased as active
  instruction — "**preserve it**", "**never** re-implement"); the `global` refresh scope, now
  documented as falling through to `bot_refresh_events_none`; the paginated-embed pattern, which
  taught a `PAGE_SIZE` convention that only ever existed in the deleted `buildEventListEmbed.ts`
  (the real constant is `ATTENDEES_LIMIT = 15` in `interactions/attendees.ts`).
- `applications/server/AGENTS.md` — `resolveChannel` documented as deleted, with the three
  functions `EventChannelResolver.ts` actually exports; `Guild/IdentifyEventsChannel`'s
  `'global'` kind documented as a dead schema literal the handler never returns; the
  events-channel-move section replaced by a `Dead-but-present global-board code` table covering
  the four caller-less emitters and RPCs, with an explicit carve-out that
  `Event/GetEventEmbedInfo` is still live.

Corrections found while doing it: `handleCreated.ts`/`handleUpdated.ts` do still exist under
`rcp/channel/` and `rcp/role/` (only the `rcp/event/` copies are gone); `updateTeamSettings` no
longer emits `event_channel_moved`; and the web settings form always sends `Option.none()` for
`discordEventsChannelId`.

### Left alone deliberately
Root `AGENTS.md:908` mentions "Two-surface event model" inside a dated historical changelog
entry — a past-tense record of a prior PR, not a live pointer.

## Regression guard — untouched

`applications/bot/test/check-discord-timestamp.test.ts` keeps the all-day bug out. It imports
only node builtins + vitest and writes the **pre-fix builder sources as inline fixture strings**
into an `mkdtempSync` dir; the builder filenames are temp-dir keys, not real references.
`scripts/check-discord-timestamp.mjs` is filename-agnostic. Survives deletion intact.

## Verification
`pnpm format` · `pnpm lint` (incl. `lint:discord-timestamp`) · `pnpm check` (`tsc -b`, catches
any dangling import) · `pnpm test`. No `pnpm build` — no domain changes.

## Risk
Low. No runtime behaviour change, no migration, no cross-package impact.
