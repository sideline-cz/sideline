# Tournament Attendance Tracking (Epic 8.3)

**Story:** As a captain, I can track tournament attendance interactively
**Branch:** `feat/tournament-attendance-tracking`

## Summary

Mirror the shipped **training-claim flow** to add a member-initiated
**join-request → captain accept/decline → attendance** flow for tournament events.
Attendance lives in a dedicated `event_join_requests` table keyed by `event_id`
— we do NOT touch the existing `rosters` table (it would leak into the web UI).

## Reconciled scope (post-critique)

- **RPC naming:** `Event/*` only — `SubmitJoinRequest`, `AcceptJoinRequest`,
  `DeclineJoinRequest`, `GetAttendanceOverview`, `SaveJoinRequestMessageId`.
- **Data model:** one new table `event_join_requests`. No `event_rosters` table,
  no reuse of `rosters`/`roster_members`, no cap/capacity column.
- **No createEvent change** — attendance is keyed on the event via the new table.
- **Event embed untouched** — post a SEPARATE join board message (claim-flow pattern),
  so existing tournament RSVPs are not orphaned.
- **Atomic accept/decline** — guarded `UPDATE ... WHERE status='pending' RETURNING id`;
  no row → `JoinRequestAlreadyDecided`. Idempotent sync handlers keyed off `discord_message_id`.
- **Captain auth** — members with `roster:manage` (effective/inherited permissions).
- **CUT from v1:** roster cap, withdraw, remove-from-roster, notes modal, paginated review panel.

## Packages affected

domain → i18n → migrations → server + bot (parallel). Web NOT touched.

## Domain
- `EventRpcModels.ts`: `JoinRequestId`, `JoinRequestStatus`, `JoinRequestEntry`,
  `AttendanceOverview`, `SubmitJoinRequestResult`, `DecideJoinRequestResult`, and tagged
  errors `JoinRequestEventNotFound`, `JoinRequestNotTournament`, `JoinRequestEventInactive`,
  `JoinRequestNotMember`, `JoinRequestForbidden`, `JoinRequestAlreadyDecided`.
- `EventRpcEvents.ts`: `TournamentJoinRequestEvent`, `TournamentAttendanceUpdateEvent`
  added to `UnprocessedEventSyncEvent` union.
- `EventRpcGroup.ts`: five `Event/*` RPCs.

## Migrations — `1789400006_create_event_join_requests.ts` (verify max+1 at PR open)
```sql
CREATE TABLE IF NOT EXISTS event_join_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  message TEXT,
  decided_by UUID REFERENCES team_members(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  discord_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, team_member_id)
);
CREATE INDEX IF NOT EXISTS idx_event_join_requests_event_status ON event_join_requests (event_id, status);

ALTER TABLE event_sync_events DROP CONSTRAINT IF EXISTS event_sync_events_event_type_check;
ALTER TABLE event_sync_events ADD CONSTRAINT event_sync_events_event_type_check
  CHECK (event_type IN (
    'event_created','event_updated','event_cancelled','rsvp_reminder','event_started',
    'training_claim_request','training_claim_update','unclaimed_training_reminder',
    'coaching_status','tournament_join_request','tournament_attendance_update'));

ALTER TABLE event_sync_events ADD COLUMN IF NOT EXISTS join_request_id UUID;
ALTER TABLE event_sync_events ADD COLUMN IF NOT EXISTS join_request_message_id TEXT;
ALTER TABLE event_sync_events ADD COLUMN IF NOT EXISTS requester_display_name TEXT;
ALTER TABLE event_sync_events ADD COLUMN IF NOT EXISTS request_message TEXT;
ALTER TABLE event_sync_events ADD COLUMN IF NOT EXISTS decided_by_display_name TEXT;
```
Literals must stay in sync in 3 places: migration CHECK, `EventSyncEventsRepository`
`Schema.Literals`, `EventRpcEvents.ts` tags.

## i18n — new `bot_join_*` keys in en.json + cs.json; run i18n build.

## Server
- NEW `EventJoinRequestsRepository.ts`: `submit` (ON CONFLICT DO NOTHING idempotent),
  `accept`/`decline` (guarded atomic UPDATE), `saveDiscordMessageId`, `findOverview`,
  `findRequestById`, permission-aware member lookup (`roster:manage`).
- MODIFY `EventSyncEventsRepository.ts`: new literals + typed columns + two emitters.
- MODIFY `rpc/event/events.ts`: `constructEvent` branches for the two new sync events.
- MODIFY `rpc/event/index.ts`: five handlers; **no createEvent change**.
- Wire `EventJoinRequestsRepository.Default` into AppLive.

## Bot
- NEW `buildJoinBoardMessage.ts`: board ("Request to join" button) + review message
  (Accept/Decline; buttons stripped when decided).
- MODIFY `handleCreated.ts`: post the join board for tournament events.
- NEW `handleTournamentJoinRequest.ts`: post review message → `SaveJoinRequestMessageId`.
- NEW `handleTournamentAttendanceUpdate.ts`: idempotent edit of the review message.
- MODIFY `ProcessorService.ts`: two `Match.tag` entries.
- NEW `interactions/joinRequest.ts`: `JoinRequestButton`, `JoinAcceptButton`, `JoinDeclineButton`.
- MODIFY `interactions/index.ts`: register the three handlers.

## Tests (TDD)
- Server `test/rpc/EventJoinRequest.test.ts`: 14 cases (submit happy/duplicate/non-member/
  non-tournament/inactive/not-found; accept happy/race/forbidden/not-member; decline
  happy/already-decided; overview; save-message-id).
- Bot `test/buildJoinBoardMessage.test.ts`: board button; review pending/accepted/declined states.
- Bot `test/joinRequest.test.ts` (optional): handlers call correct RPC with parsed ids.
