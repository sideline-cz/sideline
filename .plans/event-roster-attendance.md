# Event ↔ Roster Attendance (REDO)

**Story:** As a captain, I can track tournament attendance interactively (Epic 8.3)
Supersedes the closed PR #394. Links a tournament event to a **real roster**, with a
per-pair **auto-approve** toggle that drives roster membership from RSVP "yes".

## Behavior (your spec + decisions)

| RSVP event | Auto-approve ON | Auto-approve OFF |
|---|---|---|
| **Yes** | Member added to the linked roster (no thread) | Approve/Decline request posted to a **dedicated per-event thread** in the owner group's channel; an owner-group member approves → member added |
| **Withdraw (yes→no/maybe)** | Remove member **iff this flow added them** (provenance) | Cancel a pending request (disable its thread message); if already approved-by-flow, remove member |
| **No owner group** | n/a | Skip + **warn in web UI** (approvals impossible) |
| **Toggle OFF→ON** | — | **Backfill**: add all current yes-responders (member-group-scoped) + cancel pending requests (confirmed in UI) |

- **Unlink / event cancel:** keep already-approved members (do not mass-remove); cancel pending; delete the thread.
- **Link/toggle/unlink permission:** `roster:manage` (UI + API, consistent).
- **Approve/decline permission:** owner-group membership (Discord).

## Data model (new)

`event_rosters` — one roster link per event:
```
id, event_id UNIQUE REFERENCES events ON DELETE CASCADE,
roster_id REFERENCES rosters ON DELETE CASCADE,
auto_approve BOOLEAN NOT NULL DEFAULT false,
owners_thread_id TEXT,            -- dedicated per-event approval thread
created_at, updated_at
```

`event_roster_requests` — per-candidate state + **provenance**:
```
id, event_id, roster_id, team_member_id,
status TEXT CHECK (pending|approved|declined|cancelled),
source TEXT CHECK (auto|approval),
was_member_before BOOLEAN NOT NULL,   -- TRUE if already on roster when flow first touched them → NEVER auto-remove
discord_message_id TEXT,              -- approval message in the thread
decided_by, decided_at, created_at, updated_at,
UNIQUE (event_id, team_member_id)
```

Migration `1789500000+` (verify max+1): create both tables (with `was_member_before` at
creation), DROP+re-ADD the named `event_sync_events_event_type_check` with the **full
current 9-value list + 3 new** types (`event_roster_approval_request`,
`event_roster_approval_cancel`, `event_roster_thread_delete`). `IF NOT EXISTS` throughout.

## The RSVP hook (the blocker the hater caught)

Discord RSVPs go through the **bot RPC** `Event/SubmitRsvp` (`rpc/event/index.ts`); web RSVPs
go through the **HTTP API** `submitRsvp` (`api/event-rsvp.ts`). Both call
`EventRsvpsRepository.upsertRsvp`. Fix:
- `upsertRsvp` returns `{ row, priorResponse }` (single statement) — no separate racy read.
- Extract `EventRosterProvisioningService.onRsvp({ teamId, event, memberId, priorResponse, newResponse, displayName })` and call it from **BOTH** handlers, best-effort (`Effect.catchCause` → log) so a provisioning failure never fails the RSVP write.

## State machine (provisioning service)

T1 yes+autoON → upsert approved(`was_member_before` = isMember); add iff not member.
T2 yes+autoOFF+ownerGroup → upsert pending; emit approval-request sync event.
T3 yes+autoOFF+noOwnerGroup → no-op + log (UI warns).
T4/T5 duplicate yes (approved/pending) → no-op (idempotent).
T6 approve (guarded `UPDATE … WHERE status='pending' RETURNING`) → add member (gated on row returned).
T7 decline (guarded) → no add.
T8 withdraw + pending → cancel (guarded) → emit cancel sync (disable thread message).
T9 withdraw + approved + `was_member_before=false` → remove member + emit member-removed.
T10 withdraw + (no row OR `was_member_before=true`) → **no removal** (provenance protects manual members).
T11 re-RSVP yes after declined/cancelled → reopen (T1/T2).
T12 backfill (toggle OFF→ON): member-group-scoped yes-responders → ensure approved+added; cancel all pending; per-member resilient; returns `{ added, cancelled }`.
T13 unlink/cancel: keep approved members; cancel pending; delete thread.

All transitions are atomic conditional UPDATEs; side effects gated on the returned row.

## Components

**Domain:** `EventRosterModel`; sync events `event_roster_approval_request|_cancel|_thread_delete` (added to `UnprocessedEventSyncEvent`); RPCs `Link/Unlink/Get/SetAutoApprove EventRoster`, `Save/ClearEventRosterThread`, `SaveApprovalRequestMessageId`, `Approve/DeclineRosterRequest`; HTTP `EventRosterApi` — link/create/get/patch/unlink **plus** `GET /teams/:teamId/rosters/:rosterId/requests` (pending requests across events linked to this roster, with candidate + event info) and `POST .../requests/:id/{approve,decline}` (web approval). Outbox carries new types via documented column overloads (precedent: training-claim).

**Web approval (new):** approve/decline is reachable from BOTH the Discord thread AND the web. Both call the same `EventRosterProvisioningService.approve/decline`, so a web approval disables the Discord thread message (emits the cancel/disable sync) and a Discord approval shows up live on the web list. Web approve/decline gated on `roster:manage` (the roster detail page is already a management surface); Discord gated on owner-group membership. (Flag: these two authority models can be unified to "owner-group OR roster:manage" on both surfaces if preferred.)

**Server:** `EventRostersRepository`, `EventRosterRequestsRepository` (atomic upserts/claims, `cancel` returns prior row), `EventRosterProvisioningService` (the state machine + provenance-safe add/remove via `ChannelSyncEventsRepository.emitRosterMember{Added,Removed}`), RPC + HTTP handlers, `EventSyncEventsRepository` emitters, `constructEvent` mapping, AppLive wiring. `upsertRsvp` returns prior response.

**Bot:** `handleEventRosterApprovalRequest` (atomic per-event thread create/reuse/recreate-on-10003, name truncated to 100 chars), `handleEventRosterApprovalCancel` (disable/delete message), `handleEventRosterThreadDelete`; `buildRosterApprovalMessage` (orange/green/red states, Approve=green/Decline=red, custom_id `rsv-approve:{eventId}:{memberId}`); `interactions/roster-approval.ts` (defer-ephemeral + forkDetach + typed-error ephemerals + disable-in-place); `ProcessorService` Match tags.

**Web:**
- `EventDetailPage` "Attendance roster" section (gated `roster:manage`): link existing / create new (color+emoji), auto-approve `Switch` with **backfill AlertDialog** on enable, Unlink, **amber no-owner-group warning**.
- `RosterDetailPage` **"Pending approval requests" section** (gated `roster:manage`): live list of pending `event_roster_requests` for events linked to this roster — candidate name, linked event, requested time — each with **Approve / Decline** buttons calling the new HTTP endpoints. Empty state when none. Optional "Linked to event" badge on the Rosters list.
- `tr(...)` keys for both.

**i18n:** `bot_roster_*` + `eventRoster_*` keys (en + cs).

## Tests (TDD)
State-machine unit tests T1–T13 (incl. **T10 provenance protection** as a hard gate, and the manual-then-RSVP `was_member_before` case); repository atomicity (thread save-if-absent, guarded claim/cancel, no-downgrade upsert, already-linked); RSVP convergence (both bot RPC and web API call the service; withdraw uses prior response); bot handlers (thread lifecycle, cancel, interactions); web (warning banner, backfill dialog, unlink). Migration integration tests.

## Build order
migrations → domain (`pnpm build`) → i18n (rebuild) → server → bot → web. Affected: server, bot, web, domain, migrations, i18n. Changeset: minor. Docs matrix updated.
