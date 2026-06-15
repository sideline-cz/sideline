# Carpool fixes: persistent Leave button (thread + board) & unbolded thread title

## Task 1 — Persistent "Leave" button in BOTH the car thread and the main board

Today the only Leave button lives in the **ephemeral** reserve-confirmation message — once it
scrolls away/dismisses, a passenger has no way to leave. We add a persistent Leave affordance in
both places (per your choice).

### 1a. Car private thread — reuse existing handler
The thread welcome message currently shows owner controls: **Assign** (primary) + **Remove** (danger).
Add a **Leave** button between them:

```
[ 👤 Assign seat ]  [ 🚪 Leave car ]  [ 🗑️ Remove car ]
   primary (1)        secondary (2)       danger (4)
   carpool-assign     carpool-leave       carpool-remove
```

- Reuses the existing `carpool-leave:<carId>` handler and the existing `bot_carpool_btn_leave` label — **no new code or key**.
- Secondary (grey) + middle placement so it doesn't visually compete with the destructive red **Remove**.
- An owner who taps it gets the existing "owner cannot leave" ephemeral message (acceptable — the thread message is shared, can't be per-user).

### 1b. Main board — single "Leave my car" button (Option A)
The board is a **single shared message** (same buttons for everyone, no per-user buttons) limited to
5 rows × 5 buttons. Since a member can be in **only one car per carpool** (the invariant we just
enforced), one shared button suffices — no need to know which car up front.

```
Row 1 (global):   [ ➕ Add car ]   [ 🚪 Leave my car ]
                     primary (1)      danger (4)
                     carpool-add      carpool-leave-mine:<carpool_id>
Rows 2-5:         [ 🚗 Reserve 1 ] [ 🚗 Reserve 2 ] ...   (unchanged, up to 10 cars)
```

- Adds 1 button to row 1 → reserve rows untouched, still up to 10 cars. No layout regression.
- **Disabled** when the carpool has no cars (`view.cars.length === 0`) — keeps row 1 stable.
- Non-occupants who tap it get a clean "you're not in a car" ephemeral; owners get "owner cannot leave". No data risk.

#### Backend for the board button (resolve the car server-side)
A member is in exactly one car, so the server finds & removes their seat by `carpool_id`.

- **Domain** (`packages/domain/.../CarpoolRpcGroup.ts`): new RPC
  `Carpool/LeaveCarpool({ guild_id, discord_user_id, carpool_id })`
  → success **`{ car_id, view }`** (small result model so the bot knows which thread to clean up),
  errors `Union(CarpoolGuildNotFound, CarpoolNotMember, CarpoolNotInCar, CarpoolOwnerCannotLeave)`.
- **Server handler** (`applications/server/src/rpc/carpool/index.ts`): mirror `LeaveSeat` —
  `resolveTeamByGuild(guild_id)` → `resolveMember(discord_user_id, team.id)` →
  `carpools.leaveSeatByCarpool({ carpoolId, teamMemberId })` → return `{ car_id, view }` via `requireCarpoolView`.
- **Repository** (`CarpoolsRepository.ts`): new `leaveSeatByCarpool({ carpoolId, teamMemberId })`:
  1. `findOwnedCarQuery` → if they own a car in the carpool, fail `CarpoolOwnerCannotLeave` (owner has no seat row, so this must come first).
  2. `findExistingSeatQuery` (by `carpool_id` + `team_member_id`, returns `car_id`) → if none, `CarpoolNotInCar`.
  3. `deleteSeatQuery(car_id, team_member_id)` → if 0 rows deleted, `CarpoolNotInCar`. Return the `car_id`.
  - Reuses queries already in `make` scope. **No transaction needed** (mirrors existing non-transactional `leaveSeat`; the one-car invariant makes the owner-check + delete race-free) — documented in a comment.
- **Bot handler** (`applications/bot/src/interactions/carpool.ts`): new `CarpoolLeaveMineButton`
  on `Ix.idStartsWith('carpool-leave-mine:')`. Parses `carpool_id`, calls `Carpool/LeaveCarpool`,
  finds the returned `car_id` in the view to get its `thread_id` + index, removes the user from **that one thread**,
  rebuilds the board, and replies with the existing `bot_carpool_left { n }`. Reuses the same error→message mappings as `CarpoolLeaveButton`.
  Registered in `interactions/index.ts`.
  - `custom_id` disjointness verified: `carpool-leave-mine:` does **not** start with `carpool-leave:` (next char is `-`, not `:`), matching existing `carpool-add` vs `carpool-add-modal` precedent.

### i18n (Task 1)
One new key only — **`bot_carpool_btn_leave_mine`** (e.g. EN "🚪 Leave my car", CS "🚪 Opustit auto"),
added to **both** `en.json` and `cs.json` (the only two locales). No `bot_carpool_left_generic` needed.

## Task 2 — Remove markdown bold (`**`) from carpool thread titles

`pickName`/`formatName` wrap names in `**...**` (correct for embeds, which render markdown). The thread
**title** reuses that bolded name via `bot_carpool_thread_name`, but Discord thread titles render as plain
text → literal asterisks (`🚗 Car 1 — **Name**`).

- Add `formatNamePlain` to `applications/bot/src/rest/utils.ts` — same as `formatName` but via
  `DisplayName.pickDisplayName` **without** the `**` wrap.
- In `carpool.ts`, compute both `ownerName` (bold) and `ownerNamePlain`. Use **`ownerNamePlain` for the
  thread title only**; keep bold `ownerName` for the thread welcome embed **body** (embeds render markdown).
- Verified the carpool thread is the only Discord title/channel-name site fed a member name (training-claim
  threads use the event title).

## Tests
- **Repository** (`CarpoolsRepository.test.ts`): `leaveSeatByCarpool` — (1) passenger leaves happy path; (2) resolves the correct car among multiple; (3) non-occupant → `CarpoolNotInCar`; (4) car owner → `CarpoolOwnerCannotLeave`; (5) member seated only in a *different* carpool → `CarpoolNotInCar` (carpool_id scoping).
- **Bot utils** (`utils.test.ts`): `formatNamePlain` — name/nickname/display/username precedence, "Unknown" fallback, and a regression assertion that where `formatName` → `**Alice**`, `formatNamePlain` → `Alice`.
- **(optional) RPC handler**: `Carpool/LeaveCarpool` happy path + `CarpoolGuildNotFound` / `CarpoolNotMember` / `CarpoolNotInCar`.

## Build order
1. Edit domain RPC (`LeaveCarpool` + result model) → build `@sideline/domain`.
2. Add `bot_carpool_btn_leave_mine` to en.json + cs.json.
3. Repo method → server handler → bot handlers + registration → board button → `formatNamePlain` + call-site.
4. format / check / test (incl. i18n lint), then ship.

No migration, no schema change.
