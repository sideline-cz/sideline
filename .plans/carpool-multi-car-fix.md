# Fix: a user can be in multiple cars at once (carpool)

## The bug

In a carpool, a member should occupy exactly one role: either **own one car** or **sit
in one car** — never both, never two. Today the **owner of car A can reserve (or be
assigned) a passenger seat in car B** in the same carpool, ending up in two cars at once.

### Why it happens

Carpool membership spans two tables, each with its own unique constraint:

| Table           | Unique constraint                     | Prevents                  |
| --------------- | ------------------------------------- | ------------------------- |
| `carpool_cars`  | `(carpool_id, owner_team_member_id)`  | owning two cars           |
| `carpool_seats` | `(carpool_id, team_member_id)`        | sitting in two cars       |

There is **no constraint spanning both tables**, so "owns a car *and* holds a seat" is
not caught by the database. The application is supposed to guard it:

- `addCar` **does** guard it — `checkOwnerIsPassengerQuery` stops a passenger from creating
  their own car.
- `reserveSeat` (used by **both** the reserve-seat and assign-seat flows) **does not** —
  it only checks whether the member owns the *target* car and whether they already hold a
  *seat*. It never checks whether they already **own a different car**.

### A concurrency hole too

Even with a proactive check added, a race remains: `addCar` locks the **carpool row**
while `reserveSeat` locked only the **car row** — different rows, no shared lock. A
concurrent `addCar` + `reserveSeat` for the same member could slip past both checks and
commit the corrupt state. The fix must serialize the two operations.

## The fix (surgical, in `applications/server/src/repositories/CarpoolsRepository.ts`)

### 1. Serialize on the carpool row

Add a lock query that locks the **same `carpools` row** `addCar` locks, resolved from the
car id:

```ts
const lockCarpoolByCarQuery = SqlSchema.findOneOption({
  Request: Carpool.CarpoolCarId,
  Result: Schema.Struct({ id: Carpool.CarpoolId }),
  execute: (carId) => sql`
    SELECT id FROM carpools
    WHERE id = (SELECT carpool_id FROM carpool_cars WHERE id = ${carId})
    FOR UPDATE
  `,
});
```

### 2. Proactive owns-another-car check

```ts
const findOwnedCarQuery = SqlSchema.findOneOption({
  Request: Schema.Struct({ carpool_id: Carpool.CarpoolId, team_member_id: TeamMember.TeamMemberId }),
  Result: Schema.Struct({ id: Carpool.CarpoolCarId }),
  execute: (input) =>
    sql`SELECT id FROM carpool_cars WHERE carpool_id = ${input.carpool_id} AND owner_team_member_id = ${input.team_member_id}`,
});
```

### 3. Reorder the `reserveSeat` transaction

1. **Lock the carpool row first** (`lockCarpoolByCarQuery`) — shared lock with `addCar`; `none` falls through.
2. Lock the car row (`lockCarQuery`) → `CarpoolCarNotFound` if missing.
3. Owner-of-target-car check → `CarpoolOwnerCannotReserve`.
4. **NEW** owns-another-car check (`findOwnedCarQuery`) → `CarpoolAlreadyInAnotherCar` — *before* the capacity check, so it wins over `CarpoolFull`.
5. Existing-seat check → `CarpoolAlreadyInThisCar` / `CarpoolAlreadyInAnotherCar`.
6. Capacity check → `CarpoolFull`.
7. Insert seat, with the existing unique-violation fallback as a safety net.

### 4. Make `removeCar`'s carpool lock mandatory

Add `lockCarpoolByCarQuery` as the first step of `removeCar` so reserve-vs-remove fully
serializes (prevents a seat being inserted into a car being concurrently deleted, which
would otherwise leak a raw FK error instead of a clean domain error).

## Why this closes the race

`addCar`, `reserveSeat`, and `removeCar` all take a `FOR UPDATE` lock on the **same
carpool row** before reading any cross-table state. They can no longer interleave between
check and commit — whichever commits first, the other's post-lock read sees it (Postgres
READ COMMITTED re-reads after the lock is released). **Global lock order is uniform:
carpool row first, then car row → no ABBA deadlock** (verified: `removeCar` only ever holds
a single car lock and waits on nothing; `addCar`/`reserveSeat` both go carpool→car).

## No domain / schema / migration changes

`CarpoolAlreadyInAnotherCar` already exists and is in both the `ReserveSeat` and
`AssignSeat` RPC error unions; the bot interaction handlers already surface it for both
flows. `assignSeat` is just `reserveSeat` with `assignedBy` set, so it inherits the fix.

## Tests (`applications/server/test/integration/repositories/CarpoolsRepository.test.ts`)

1. Owner of car A **cannot reserve** a seat in car B → `CarpoolAlreadyInAnotherCar`.
2. Owner of car A **cannot be assigned** a seat in car B → `CarpoolAlreadyInAnotherCar`.
3. Precedence: owns-another-car beats `CarpoolFull` (target car full) → `CarpoolAlreadyInAnotherCar`.
4. Regression: owner reserving their **own** car still returns `CarpoolOwnerCannotReserve`.
5. All existing carpool tests stay green (happy path, full, same-car dup, passenger-in-another-car, add/leave/remove, concurrency).

The race itself is closed by the serialization argument (it can't be forced
deterministically in the integration harness); the deterministic tests verify the check
logic and the existing concurrency test confirms no regression.
