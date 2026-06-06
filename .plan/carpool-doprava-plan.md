# Carpool / Transportation Sign-up (`/doprava`) — Implementation Plan

**Story:** Command na zapisování se do dopravy — a captain Discord command for managing carpooling to events.
**Branch:** `feat/command-na-zapisovani-se-do-dopravy`

---

## What it does

1. A captain runs `/doprava` → bot posts a **persistent embed** in the channel.
2. The message has a **➕ Přidat auto** button + one **🚗 Rezervovat** button per car.
3. Adding a car: a modal asks for **capacity (1–8, incl. driver)**. A **private thread** is created per car; the owner is added.
4. Members **reserve a seat**; they are added to that car's private thread.
5. Inside the thread: owner can **👤 Obsadit místo** (assign a teammate via user-select) and **🗑️ Zrušit auto** (remove car). Passengers can **🚪 Odejít**.
6. The embed rebuilds live after every change.

---

## Key design decisions (reconciled after review)

- **Owner = seat #1 (👑), counted in capacity.** `occupied = 1 + passengers`. Car is full when `occupied >= capacity`. Owner has no `carpool_seats` row.
- **Auth on `team_id`**, resolved from `interaction.guild_id` via `teams.guild_id` (same as `/event`). New `carpool:manage` permission → granted to Admin + Captain. Reserve/Leave need only membership; Assign/Remove need car ownership.
- **Owner/passenger management lives in the per-car thread**; main message only holds Add + Reserve buttons (Discord 5×5 component budget; cap ~10 cars in v1).
- **RemoveCar is in v1.** Owner can't "leave" their car — they remove it (cascades seats, archives+locks thread).
- **Private threads + strand-passenger fix:** every reserver is added to the thread; the ephemeral reserve-success message carries a **Odejít** button so a passenger whose thread-add 403'd can still exit. Thread-add failure → log + non-fatal note, no DB rollback.

---

## Data model (new migration `1788000000_create_carpools.ts`)

- **`carpools`** — `id`, `team_id` (FK teams CASCADE), `event_id?` (FK events CASCADE), `guild_id`, `discord_channel_id`, `discord_message_id?`, `created_by`, timestamps.
- **`carpool_cars`** — `id`, `carpool_id` (FK CASCADE), `owner_team_member_id`, `capacity INT CHECK 1..8`, `thread_id?`, `note?`, `UNIQUE(carpool_id, owner_team_member_id)`.
- **`carpool_seats`** — `id`, `car_id` (FK CASCADE), `carpool_id` (denormalized, FK CASCADE), `team_member_id` (FK CASCADE), `assigned_by?`, `created_at`, `UNIQUE(carpool_id, team_member_id)` (one car per member per carpool; enables "already in THIS vs ANOTHER car").
- Plus a permission-grant migration for `carpool:manage` (Admin + Captain).

## RPCs (`CarpoolRpcGroup`, prefix `Carpool/`)

`CreateCarpool`, `SaveCarpoolMessageId`, `GetCarpoolView`, `AddCar`, `ReserveSeat`, `AssignSeat`, `LeaveSeat`, `RemoveCar`.
All payloads carry `guild_id` + `discord_user_id`. Tagged errors: `CarpoolGuildNotFound`, `CarpoolNotMember`, `CarpoolNotFound`, `CarpoolCarNotFound`, `CarpoolFull`, `CarpoolAlreadyInThisCar`, `CarpoolAlreadyInAnotherCar`, `CarpoolAlreadyOwnsCar`, `CarpoolOwnerCannotReserve`, `CarpoolOwnerCannotLeave`, `CarpoolNotInCar`, `CarpoolNotCarOwner`, `CarpoolTargetNotMember`, `CarpoolInvalidCapacity`.
Concurrency: `reserveSeat`/`assignSeat` use `SELECT … FOR UPDATE` on the car row + `count(seats)+1 >= capacity` check inside a transaction. Mutations return **post-commit** view.

## Custom-ID scheme (bot interactions)

| Custom ID | Location | Action | Auth |
|---|---|---|---|
| `carpool-add` | main msg | open capacity modal | member |
| `carpool-add-modal:<carpool_id>` | modal submit | AddCar + create thread + add owner | member |
| `carpool-reserve:<car_id>` | main msg | ReserveSeat + addThreadMember; ephemeral success w/ leave btn | member |
| `carpool-assign:<car_id>` | thread | user-select → AssignSeat + addThreadMember | owner |
| `carpool-leave:<car_id>` | thread + ephemeral | LeaveSeat + removeThreadMember | seat owner |
| `carpool-remove:<car_id>` | thread | RemoveCar + archive/lock thread | owner |

---

## Example embed (Czech)

> **🚗 Doprava — Zápas Brno, sobota 7. 6.**
> Zapiš se do auta níže. Volná místa se aktualizují automaticky.
> Celkem volných míst: **3**
>
> **🚗 Auto 1 · Řidič: Petr Novák · 1/4 volné**
> 1. 👑 Petr Novák  2. Jana Dvořáková  3. Tomáš Černý  4. *volné místo*
>
> **🚗 Auto 2 · Řidič: Lucie Malá · plno**
> 1. 👑 Lucie Malá  2. Martin Veselý

Buttons: `➕ Přidat auto` (Primary) + one `🚗 Auto N` (Success / disabled when full). Color: blurple while seats remain → green when all full → orange when no cars. Full Czech i18n key set (`bot_carpool_*`) for all labels, confirmations, and per-error messages.

---

## Task breakdown (by package, in order)

1. **migrations** — 3 tables + `carpool:manage` grant.
2. **domain** — `models/Carpool.ts`, `rpc/carpool/*` (group + models + tagged errors), `carpool:manage` in `Role.Permission` + defaults, merge into `SyncRpcs`. → `pnpm build`.
3. **server** — `CarpoolsRepository` (transactional reserve/assign/remove), `rpc/carpool/index.ts` handlers (guild→team + member resolution + permission check), register in `AppLive`/`rpc/index.ts`. Add repo mock to test cascade.
4. **bot** — `rest/carpool/buildCarpoolEmbed.ts`, `commands/carpool/index.ts`, `interactions/carpool.ts`; register command + interactions.
5. **i18n** — `bot_carpool_*` keys in `cs.json` + `en.json`.
6. **docs** — `/doprava` end-user page + internal docs (db, api, bot) + changeset (minor).

## Tests (written first, TDD)

- **Repository** (testcontainer): add-car, capacity bounds, duplicate owner, reserve happy/full/duplicate (this vs another car), owner-cannot-reserve, assign auth + target checks, leave (passenger/owner/not-in-car), remove (owner/non-owner cascade), **last-seat concurrency** (FOR UPDATE), safe render for removed member.
- **RPC handlers**: guild/member resolution branches, post-commit view, error-tag mapping (no raw SqlError).
- **Embed builder** (pure): owner-crown ordering, removed-member safety, full/empty states, component limits.
- **Bot interactions**: reserve→addThreadMember + ephemeral leave btn; 403 no rollback; leave from ephemeral; remove→archive/lock; custom-id parsing; localized error mapping.

---

## Edge cases handled

Car-full race (FOR UPDATE) · duplicate reservation (unique → tagged error, THIS vs ANOTHER car) · AddCar re-checks carpool exists in txn (no orphan) · thread-add 403 (log + leave-button escape, no rollback) · owner can't leave (must remove) · DM guard · soft-deactivated member seat (rendered safely via Option fields, not auto-released in v1) · component-limit cap (~10 cars) · one-team-per-guild (matches existing `/event` behavior).
