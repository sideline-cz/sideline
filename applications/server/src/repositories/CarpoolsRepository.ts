import {
  Carpool,
  CarpoolRpcModels,
  Discord,
  Event,
  Onboarding,
  Team,
  TeamMember,
} from '@sideline/domain';
import { LogicError, SqlErrors } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

class CarpoolRow extends Schema.Class<CarpoolRow>('CarpoolRow')({
  id: Carpool.CarpoolId,
  team_id: Team.TeamId,
  event_id: Schema.OptionFromNullOr(Event.EventId),
  guild_id: Discord.Snowflake,
  discord_channel_id: Discord.Snowflake,
  discord_message_id: Schema.OptionFromNullOr(Discord.Snowflake),
  created_by: TeamMember.TeamMemberId,
}) {}

class CarpoolCarRow extends Schema.Class<CarpoolCarRow>('CarpoolCarRow')({
  id: Carpool.CarpoolCarId,
  carpool_id: Carpool.CarpoolId,
  owner_team_member_id: TeamMember.TeamMemberId,
  capacity: Schema.Number,
  thread_id: Schema.OptionFromNullOr(Discord.Snowflake),
  note: Schema.OptionFromNullOr(Schema.String),
}) {}

class CarpoolViewRow extends Schema.Class<CarpoolViewRow>('CarpoolViewRow')({
  // carpool fields
  carpool_id: Carpool.CarpoolId,
  team_locale: Onboarding.OnboardingLocale,
  discord_channel_id: Discord.Snowflake,
  discord_message_id: Schema.OptionFromNullOr(Discord.Snowflake),
  event_id: Schema.OptionFromNullOr(Event.EventId),
  // car fields
  car_id: Schema.OptionFromNullOr(Carpool.CarpoolCarId),
  car_capacity: Schema.OptionFromNullOr(Schema.Number),
  car_thread_id: Schema.OptionFromNullOr(Discord.Snowflake),
  car_note: Schema.OptionFromNullOr(Schema.String),
  owner_team_member_id: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
  owner_discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
  owner_name: Schema.OptionFromNullOr(Schema.String),
  owner_nickname: Schema.OptionFromNullOr(Schema.String),
  owner_display_name: Schema.OptionFromNullOr(Schema.String),
  owner_username: Schema.OptionFromNullOr(Schema.String),
  // seat fields (null when owner row)
  seat_team_member_id: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
  seat_discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
  seat_name: Schema.OptionFromNullOr(Schema.String),
  seat_nickname: Schema.OptionFromNullOr(Schema.String),
  seat_display_name: Schema.OptionFromNullOr(Schema.String),
  seat_username: Schema.OptionFromNullOr(Schema.String),
  row_kind: Schema.String,
}) {}

class SeatCountRow extends Schema.Class<SeatCountRow>('SeatCountRow')({
  count: Schema.Number,
}) {}

class ExistingSeatRow extends Schema.Class<ExistingSeatRow>('ExistingSeatRow')({
  car_id: Carpool.CarpoolCarId,
}) {}

class CarLockRow extends Schema.Class<CarLockRow>('CarLockRow')({
  capacity: Schema.Number,
  carpool_id: Carpool.CarpoolId,
  owner_team_member_id: TeamMember.TeamMemberId,
}) {}

// ---------------------------------------------------------------------------
// View builder
// ---------------------------------------------------------------------------

const buildCarpoolView = (
  carpoolId: Carpool.CarpoolId,
  rows: ReadonlyArray<CarpoolViewRow>,
): Effect.Effect<CarpoolRpcModels.CarpoolView> => {
  const firstRow = rows[0];

  if (firstRow === undefined) {
    // Should never happen: caller checks rows.length > 0 before calling buildCarpoolView
    return LogicError.die('carpool view has no rows but buildCarpoolView was called');
  }

  const eventId = firstRow.event_id;
  const discordChannelId = firstRow.discord_channel_id;
  const discordMessageId = firstRow.discord_message_id;

  // Group rows by car_id
  const carMap = new Map<
    Carpool.CarpoolCarId,
    { carRow: CarpoolViewRow; passengers: CarpoolViewRow[] }
  >();

  for (const row of rows) {
    if (Option.isNone(row.car_id)) continue;
    const carId = row.car_id.value;

    if (!carMap.has(carId)) {
      carMap.set(carId, { carRow: row, passengers: [] });
    }

    if (row.row_kind === 'passenger') {
      carMap.get(carId)?.passengers.push(row);
    }
  }

  return Effect.Do.pipe(
    Effect.bind('cars', () =>
      Effect.forEach(Array.from(carMap.values()), ({ carRow, passengers }) => {
        // car_id and owner_team_member_id are always Some here because the loop
        // above guards on Option.isNone(row.car_id) before inserting into the map.
        if (Option.isNone(carRow.car_id)) {
          return LogicError.die('carpool view row missing car_id after guard');
        }
        if (Option.isNone(carRow.owner_team_member_id)) {
          return LogicError.die('carpool view row missing owner_team_member_id after guard');
        }

        const carId = carRow.car_id.value;
        const ownerId = carRow.owner_team_member_id.value;

        const owner = new CarpoolRpcModels.MemberDisplay({
          team_member_id: ownerId,
          discord_id: carRow.owner_discord_id,
          name: carRow.owner_name,
          nickname: carRow.owner_nickname,
          display_name: carRow.owner_display_name,
          username: carRow.owner_username,
        });

        return Effect.forEach(passengers, (p) => {
          if (Option.isNone(p.seat_team_member_id)) {
            return LogicError.die('carpool view passenger row missing seat_team_member_id');
          }
          return Effect.succeed(
            new CarpoolRpcModels.MemberDisplay({
              team_member_id: p.seat_team_member_id.value,
              discord_id: p.seat_discord_id,
              name: p.seat_name,
              nickname: p.seat_nickname,
              display_name: p.seat_display_name,
              username: p.seat_username,
            }),
          );
        }).pipe(
          Effect.map(
            (passengerList) =>
              new CarpoolRpcModels.CarpoolCarView({
                car_id: carId,
                thread_id: carRow.car_thread_id,
                capacity: Option.getOrElse(carRow.car_capacity, () => 0),
                note: carRow.car_note,
                owner,
                passengers: passengerList,
              }),
          ),
        );
      }),
    ),
    Effect.map(
      ({ cars }) =>
        new CarpoolRpcModels.CarpoolView({
          carpool_id: carpoolId,
          language: firstRow.team_locale,
          discord_channel_id: discordChannelId,
          discord_message_id: discordMessageId,
          event_id: eventId,
          cars,
        }),
    ),
  );
};

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // ---- createCarpool ----

  const insertCarpoolQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      event_id: Schema.OptionFromNullOr(Event.EventId),
      guild_id: Discord.Snowflake,
      discord_channel_id: Discord.Snowflake,
      created_by: TeamMember.TeamMemberId,
    }),
    Result: CarpoolRow,
    execute: (input) => sql`
      INSERT INTO carpools (team_id, event_id, guild_id, discord_channel_id, created_by)
      VALUES (${input.team_id}, ${input.event_id}, ${input.guild_id}, ${input.discord_channel_id}, ${input.created_by})
      RETURNING id, team_id, event_id, guild_id, discord_channel_id, discord_message_id, created_by
    `,
  });

  const createCarpool = (input: {
    readonly teamId: Team.TeamId;
    readonly eventId: Option.Option<Event.EventId>;
    readonly guildId: Discord.Snowflake;
    readonly channelId: Discord.Snowflake;
    readonly createdBy: TeamMember.TeamMemberId;
  }) =>
    insertCarpoolQuery({
      team_id: input.teamId,
      event_id: input.eventId,
      guild_id: input.guildId,
      discord_channel_id: input.channelId,
      created_by: input.createdBy,
    }).pipe(
      catchSqlErrors,
      Effect.catchTag('NoSuchElementError', () => LogicError.die('Carpool insert returned no row')),
    );

  // ---- saveMessageId ----

  const saveMessageIdQuery = SqlSchema.void({
    Request: Schema.Struct({
      carpool_id: Carpool.CarpoolId,
      message_id: Discord.Snowflake,
    }),
    execute: (input) => sql`
      UPDATE carpools SET discord_message_id = ${input.message_id}, updated_at = now()
      WHERE id = ${input.carpool_id}
    `,
  });

  const saveMessageId = (carpoolId: Carpool.CarpoolId, messageId: Discord.Snowflake) =>
    saveMessageIdQuery({ carpool_id: carpoolId, message_id: messageId }).pipe(catchSqlErrors);

  // ---- findCarpoolView ----

  const findCarpoolViewQuery = SqlSchema.findAll({
    Request: Carpool.CarpoolId,
    Result: CarpoolViewRow,
    execute: (carpoolId) => sql`
      SELECT
        c.id AS carpool_id,
        t.onboarding_locale AS team_locale,
        c.discord_channel_id,
        c.discord_message_id,
        c.event_id,
        cc.id AS car_id,
        cc.capacity AS car_capacity,
        cc.thread_id AS car_thread_id,
        cc.note AS car_note,
        cc.created_at AS car_created_at,
        -- owner info
        cc.owner_team_member_id AS owner_team_member_id,
        owner_user.discord_id AS owner_discord_id,
        owner_user.name AS owner_name,
        owner_user.discord_nickname AS owner_nickname,
        owner_user.discord_display_name AS owner_display_name,
        owner_user.username AS owner_username,
        -- passenger/seat info
        NULL::uuid AS seat_team_member_id,
        NULL::text AS seat_discord_id,
        NULL::text AS seat_name,
        NULL::text AS seat_nickname,
        NULL::text AS seat_display_name,
        NULL::text AS seat_username,
        'owner' AS row_kind
      FROM carpools c
      JOIN teams t ON t.id = c.team_id
      LEFT JOIN carpool_cars cc ON cc.carpool_id = c.id
      LEFT JOIN team_members owner_tm ON owner_tm.id = cc.owner_team_member_id
      LEFT JOIN users owner_user ON owner_user.id = owner_tm.user_id
      WHERE c.id = ${carpoolId}

      UNION ALL

      SELECT
        c.id AS carpool_id,
        t.onboarding_locale AS team_locale,
        c.discord_channel_id,
        c.discord_message_id,
        c.event_id,
        cc.id AS car_id,
        cc.capacity AS car_capacity,
        cc.thread_id AS car_thread_id,
        cc.note AS car_note,
        cc.created_at AS car_created_at,
        -- owner info (repeated for join)
        cc.owner_team_member_id AS owner_team_member_id,
        owner_user.discord_id AS owner_discord_id,
        owner_user.name AS owner_name,
        owner_user.discord_nickname AS owner_nickname,
        owner_user.discord_display_name AS owner_display_name,
        owner_user.username AS owner_username,
        -- passenger info
        cs.team_member_id AS seat_team_member_id,
        seat_user.discord_id AS seat_discord_id,
        seat_user.name AS seat_name,
        seat_user.discord_nickname AS seat_nickname,
        seat_user.discord_display_name AS seat_display_name,
        seat_user.username AS seat_username,
        'passenger' AS row_kind
      FROM carpools c
      JOIN teams t ON t.id = c.team_id
      JOIN carpool_cars cc ON cc.carpool_id = c.id
      JOIN carpool_seats cs ON cs.car_id = cc.id
      LEFT JOIN team_members seat_tm ON seat_tm.id = cs.team_member_id
      LEFT JOIN users seat_user ON seat_user.id = seat_tm.user_id
      LEFT JOIN team_members owner_tm ON owner_tm.id = cc.owner_team_member_id
      LEFT JOIN users owner_user ON owner_user.id = owner_tm.user_id
      WHERE c.id = ${carpoolId}

      ORDER BY car_created_at NULLS LAST, row_kind
    `,
  });

  const findCarpoolView = (carpoolId: Carpool.CarpoolId) =>
    findCarpoolViewQuery(carpoolId).pipe(
      catchSqlErrors,
      Effect.flatMap((rows) => {
        // If no rows returned at all, carpool doesn't exist
        if (rows.length === 0) return Effect.succeed(Option.none<CarpoolRpcModels.CarpoolView>());
        return buildCarpoolView(carpoolId, rows).pipe(Effect.map(Option.some));
      }),
    );

  // ---- addCar ----

  const lockCarpoolQuery = SqlSchema.findOneOption({
    Request: Carpool.CarpoolId,
    Result: Schema.Struct({ id: Carpool.CarpoolId }),
    execute: (carpoolId) => sql`SELECT id FROM carpools WHERE id = ${carpoolId} FOR UPDATE`,
  });

  const checkOwnerIsPassengerQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      carpool_id: Carpool.CarpoolId,
      team_member_id: TeamMember.TeamMemberId,
    }),
    Result: Schema.Struct({ car_id: Carpool.CarpoolCarId }),
    execute: (input) =>
      sql`SELECT cs.car_id FROM carpool_seats cs WHERE cs.carpool_id = ${input.carpool_id} AND cs.team_member_id = ${input.team_member_id}`,
  });

  const insertCarQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      carpool_id: Carpool.CarpoolId,
      owner_team_member_id: TeamMember.TeamMemberId,
      capacity: Schema.Number,
      note: Schema.OptionFromNullOr(Schema.String),
    }),
    Result: Schema.Struct({ id: Carpool.CarpoolCarId }),
    execute: (input) => sql`
      INSERT INTO carpool_cars (carpool_id, owner_team_member_id, capacity, note)
      VALUES (${input.carpool_id}, ${input.owner_team_member_id}, ${input.capacity}, ${input.note})
      RETURNING id
    `,
  });

  const addCar = (input: {
    readonly carpoolId: Carpool.CarpoolId;
    readonly ownerTeamMemberId: TeamMember.TeamMemberId;
    readonly capacity: number;
    readonly note: Option.Option<string>;
  }) =>
    sql
      .withTransaction(
        Effect.Do.pipe(
          Effect.bind('_lock', () =>
            lockCarpoolQuery(input.carpoolId).pipe(
              catchSqlErrors,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new CarpoolRpcModels.CarpoolNotFound()),
                  onSome: () => Effect.void,
                }),
              ),
            ),
          ),
          Effect.bind('_passengerCheck', () =>
            checkOwnerIsPassengerQuery({
              carpool_id: input.carpoolId,
              team_member_id: input.ownerTeamMemberId,
            }).pipe(
              catchSqlErrors,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.void,
                  onSome: () => Effect.fail(new CarpoolRpcModels.CarpoolAlreadyInAnotherCar()),
                }),
              ),
            ),
          ),
          Effect.bind('car', () =>
            insertCarQuery({
              carpool_id: input.carpoolId,
              owner_team_member_id: input.ownerTeamMemberId,
              capacity: input.capacity,
              note: input.note,
            }).pipe(
              SqlErrors.catchUniqueViolation(() => new CarpoolRpcModels.CarpoolAlreadyOwnsCar()),
              catchSqlErrors,
              Effect.catchTag('NoSuchElementError', () =>
                LogicError.die('Car insert returned no row'),
              ),
            ),
          ),
          Effect.bind('view', ({ car: _car }) =>
            findCarpoolViewQuery(input.carpoolId).pipe(
              catchSqlErrors,
              Effect.flatMap((rows) => buildCarpoolView(input.carpoolId, rows)),
            ),
          ),
          Effect.map(({ car, view }) => ({ car_id: car.id, view })),
        ),
      )
      .pipe(catchSqlErrors);

  // ---- saveCarThreadId ----

  const saveCarThreadIdQuery = SqlSchema.void({
    Request: Schema.Struct({
      car_id: Carpool.CarpoolCarId,
      thread_id: Discord.Snowflake,
    }),
    execute: (input) => sql`
      UPDATE carpool_cars SET thread_id = ${input.thread_id}, updated_at = now()
      WHERE id = ${input.car_id}
    `,
  });

  const saveCarThreadId = (carId: Carpool.CarpoolCarId, threadId: Discord.Snowflake) =>
    saveCarThreadIdQuery({ car_id: carId, thread_id: threadId }).pipe(catchSqlErrors);

  // ---- reserveSeat / assignSeat ----

  const lockCarQuery = SqlSchema.findOneOption({
    Request: Carpool.CarpoolCarId,
    Result: CarLockRow,
    execute: (carId) =>
      sql`SELECT capacity, carpool_id, owner_team_member_id FROM carpool_cars WHERE id = ${carId} FOR UPDATE`,
  });

  // Locks the carpools row resolved from a car id via subquery.
  // Serializes reserveSeat (and removeCar) against addCar, matching addCar's
  // lockCarpoolQuery — closing the race between addCar and reserveSeat.
  const lockCarpoolByCarQuery = SqlSchema.findOneOption({
    Request: Carpool.CarpoolCarId,
    Result: Schema.Struct({ id: Carpool.CarpoolId }),
    execute: (carId) => sql`
      SELECT id FROM carpools
      WHERE id = (SELECT carpool_id FROM carpool_cars WHERE id = ${carId})
      FOR UPDATE
    `,
  });

  const countSeatsQuery = SqlSchema.findOne({
    Request: Carpool.CarpoolCarId,
    Result: SeatCountRow,
    execute: (carId) =>
      sql`SELECT COUNT(*)::int AS count FROM carpool_seats WHERE car_id = ${carId}`,
  });

  const findExistingSeatQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      carpool_id: Carpool.CarpoolId,
      team_member_id: TeamMember.TeamMemberId,
    }),
    Result: ExistingSeatRow,
    execute: (input) =>
      sql`SELECT car_id FROM carpool_seats WHERE carpool_id = ${input.carpool_id} AND team_member_id = ${input.team_member_id}`,
  });

  // Mirrors addCar's checkOwnerIsPassengerQuery guard in the opposite direction:
  // prevents a car owner from taking a passenger seat in another car of the same carpool.
  const findOwnedCarQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      carpool_id: Carpool.CarpoolId,
      team_member_id: TeamMember.TeamMemberId,
    }),
    Result: Schema.Struct({ id: Carpool.CarpoolCarId }),
    execute: (input) =>
      sql`SELECT id FROM carpool_cars WHERE carpool_id = ${input.carpool_id} AND owner_team_member_id = ${input.team_member_id}`,
  });

  const insertSeatQuery = SqlSchema.void({
    Request: Schema.Struct({
      car_id: Carpool.CarpoolCarId,
      carpool_id: Carpool.CarpoolId,
      team_member_id: TeamMember.TeamMemberId,
      assigned_by: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
    }),
    execute: (input) => sql`
      INSERT INTO carpool_seats (car_id, carpool_id, team_member_id, assigned_by)
      VALUES (${input.car_id}, ${input.carpool_id}, ${input.team_member_id}, ${input.assigned_by})
    `,
  });

  const reserveSeat = (input: {
    readonly carId: Carpool.CarpoolCarId;
    readonly teamMemberId: TeamMember.TeamMemberId;
    readonly assignedBy: Option.Option<TeamMember.TeamMemberId>;
  }) =>
    sql
      .withTransaction(
        Effect.Do.pipe(
          // Lock the carpool row first — shared lock with addCar's lockCarpoolQuery —
          // to serialize reserveSeat against addCar and close the addCar/reserveSeat race.
          // A None result (car not found yet) simply falls through; the next step raises
          // CarpoolCarNotFound.
          Effect.tap(() => lockCarpoolByCarQuery(input.carId).pipe(catchSqlErrors)),
          Effect.bind('car', () =>
            lockCarQuery(input.carId).pipe(
              catchSqlErrors,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new CarpoolRpcModels.CarpoolCarNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.tap(({ car }) =>
            car.owner_team_member_id === input.teamMemberId
              ? Effect.fail(new CarpoolRpcModels.CarpoolOwnerCannotReserve())
              : Effect.void,
          ),
          // Mirrors addCar's checkOwnerIsPassengerQuery guard: prevents a car owner from
          // taking a passenger seat in another car of the same carpool.
          // Placed before the capacity check so CarpoolAlreadyInAnotherCar wins over CarpoolFull.
          Effect.tap(({ car }) =>
            findOwnedCarQuery({
              carpool_id: car.carpool_id,
              team_member_id: input.teamMemberId,
            }).pipe(
              catchSqlErrors,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.void,
                  onSome: () => Effect.fail(new CarpoolRpcModels.CarpoolAlreadyInAnotherCar()),
                }),
              ),
            ),
          ),
          // Proactive duplicate check — runs while the transaction is still clean
          // (before any INSERT that could abort it). This handles the deterministic
          // cases: same-car duplicate and already-in-another-car (as a passenger).
          Effect.tap(({ car }) =>
            findExistingSeatQuery({
              carpool_id: car.carpool_id,
              team_member_id: input.teamMemberId,
            }).pipe(
              catchSqlErrors,
              Effect.flatMap(
                (
                  opt,
                ): Effect.Effect<
                  void,
                  | CarpoolRpcModels.CarpoolAlreadyInThisCar
                  | CarpoolRpcModels.CarpoolAlreadyInAnotherCar
                > => {
                  if (Option.isNone(opt)) return Effect.void;
                  const existingSeat = opt.value;
                  if (existingSeat.car_id === input.carId) {
                    return Effect.fail(new CarpoolRpcModels.CarpoolAlreadyInThisCar());
                  }
                  return Effect.fail(new CarpoolRpcModels.CarpoolAlreadyInAnotherCar());
                },
              ),
            ),
          ),
          Effect.bind('seatCount', () =>
            countSeatsQuery(input.carId).pipe(
              catchSqlErrors,
              Effect.catchTag('NoSuchElementError', () =>
                LogicError.die('Seat count returned no row'),
              ),
              Effect.map((r) => r.count),
            ),
          ),
          Effect.tap(({ car, seatCount }) =>
            // owner occupies no seat row; seatCount is passengers only;
            // seatCount + 1 (new passenger) >= capacity means full
            seatCount + 1 >= car.capacity
              ? Effect.fail(new CarpoolRpcModels.CarpoolFull())
              : Effect.void,
          ),
          Effect.flatMap(({ car }) =>
            insertSeatQuery({
              car_id: input.carId,
              carpool_id: car.carpool_id,
              team_member_id: input.teamMemberId,
              assigned_by: input.assignedBy,
            }).pipe(
              // The proactive check above handles deterministic duplicates.
              // This catches the rare concurrent-insert race where two parallel
              // transactions for the same member slip past each other's proactive
              // checks. In that race both insert into different cars, so map to
              // CarpoolAlreadyInAnotherCar without running a follow-up SELECT
              // (which would fail because the transaction is now aborted).
              SqlErrors.catchUniqueViolation(
                () => new CarpoolRpcModels.CarpoolAlreadyInAnotherCar(),
              ),
              catchSqlErrors,
            ),
          ),
        ),
      )
      .pipe(catchSqlErrors);

  // ---- leaveSeat ----

  const findCarForLeaveQuery = SqlSchema.findOneOption({
    Request: Carpool.CarpoolCarId,
    Result: Schema.Struct({
      owner_team_member_id: TeamMember.TeamMemberId,
    }),
    execute: (carId) => sql`SELECT owner_team_member_id FROM carpool_cars WHERE id = ${carId}`,
  });

  const deleteSeatQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      car_id: Carpool.CarpoolCarId,
      team_member_id: TeamMember.TeamMemberId,
    }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: (input) => sql`
      DELETE FROM carpool_seats
      WHERE car_id = ${input.car_id} AND team_member_id = ${input.team_member_id}
      RETURNING id
    `,
  });

  const leaveSeat = (input: {
    readonly carId: Carpool.CarpoolCarId;
    readonly teamMemberId: TeamMember.TeamMemberId;
  }) =>
    Effect.Do.pipe(
      Effect.bind('car', () =>
        findCarForLeaveQuery(input.carId).pipe(
          catchSqlErrors,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new CarpoolRpcModels.CarpoolCarNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        ),
      ),
      Effect.tap(({ car }) =>
        car.owner_team_member_id === input.teamMemberId
          ? Effect.fail(new CarpoolRpcModels.CarpoolOwnerCannotLeave())
          : Effect.void,
      ),
      Effect.bind('deleted', () =>
        deleteSeatQuery({
          car_id: input.carId,
          team_member_id: input.teamMemberId,
        }).pipe(catchSqlErrors),
      ),
      Effect.flatMap(({ deleted }) =>
        deleted.length === 0 ? Effect.fail(new CarpoolRpcModels.CarpoolNotInCar()) : Effect.void,
      ),
    );

  // ---- leaveSeatByCarpool ----

  // No transaction needed: each member has at most one seat across all cars in a carpool
  // (enforced by the unique index on carpool_seats(carpool_id, team_member_id)), so the
  // carpool_id-scoped lookup + delete is effectively race-free — no two concurrent calls
  // for the same (carpool_id, team_member_id) pair can interleave in a harmful way.
  const leaveSeatByCarpool = (input: {
    readonly carpoolId: Carpool.CarpoolId;
    readonly teamMemberId: TeamMember.TeamMemberId;
  }) =>
    Effect.Do.pipe(
      // Owner check FIRST: owners have no seat row, so we must check before the seat
      // lookup to give the correct error rather than wrongly returning CarpoolNotInCar.
      Effect.tap(() =>
        findOwnedCarQuery({
          carpool_id: input.carpoolId,
          team_member_id: input.teamMemberId,
        }).pipe(
          catchSqlErrors,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: () => Effect.fail(new CarpoolRpcModels.CarpoolOwnerCannotLeave()),
            }),
          ),
        ),
      ),
      Effect.bind('seat', () =>
        findExistingSeatQuery({
          carpool_id: input.carpoolId,
          team_member_id: input.teamMemberId,
        }).pipe(
          catchSqlErrors,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new CarpoolRpcModels.CarpoolNotInCar()),
              onSome: Effect.succeed,
            }),
          ),
        ),
      ),
      Effect.bind('deleted', ({ seat }) =>
        deleteSeatQuery({
          car_id: seat.car_id,
          team_member_id: input.teamMemberId,
        }).pipe(catchSqlErrors),
      ),
      Effect.flatMap(({ seat, deleted }) =>
        deleted.length === 0
          ? Effect.fail(new CarpoolRpcModels.CarpoolNotInCar())
          : Effect.succeed(seat.car_id),
      ),
    );

  // ---- removeCar ----

  const findCarOwnerQuery = SqlSchema.findOneOption({
    Request: Carpool.CarpoolCarId,
    Result: Schema.Struct({
      owner_team_member_id: TeamMember.TeamMemberId,
      thread_id: Schema.OptionFromNullOr(Discord.Snowflake),
    }),
    execute: (carId) =>
      sql`SELECT owner_team_member_id, thread_id FROM carpool_cars WHERE id = ${carId}`,
  });

  const deleteCarQuery = SqlSchema.void({
    Request: Carpool.CarpoolCarId,
    execute: (carId) => sql`DELETE FROM carpool_cars WHERE id = ${carId}`,
  });

  const removeCar = (input: {
    readonly carId: Carpool.CarpoolCarId;
    readonly ownerTeamMemberId: TeamMember.TeamMemberId;
  }) =>
    sql
      .withTransaction(
        Effect.Do.pipe(
          // Lock the carpool row first so that removeCar serializes against reserveSeat
          // on the same carpool row (matching reserveSeat's lockCarpoolByCarQuery).
          Effect.tap(() => lockCarpoolByCarQuery(input.carId).pipe(catchSqlErrors)),
          Effect.bind('car', () =>
            findCarOwnerQuery(input.carId).pipe(
              catchSqlErrors,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new CarpoolRpcModels.CarpoolCarNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.tap(({ car }) =>
            car.owner_team_member_id !== input.ownerTeamMemberId
              ? Effect.fail(new CarpoolRpcModels.CarpoolNotCarOwner())
              : Effect.void,
          ),
          Effect.tap(() => deleteCarQuery(input.carId).pipe(catchSqlErrors)),
          Effect.map(({ car }) => ({ thread_id: car.thread_id })),
        ),
      )
      .pipe(catchSqlErrors);

  // ---- findCarById ----

  const findCarByIdQuery = SqlSchema.findOneOption({
    Request: Carpool.CarpoolCarId,
    Result: CarpoolCarRow,
    execute: (carId) =>
      sql`SELECT id, carpool_id, owner_team_member_id, capacity, thread_id, note FROM carpool_cars WHERE id = ${carId}`,
  });

  const findCarById = (carId: Carpool.CarpoolCarId) => findCarByIdQuery(carId).pipe(catchSqlErrors);

  // ---- updateCarCapacity ----

  const setCarCapacityQuery = SqlSchema.void({
    Request: Schema.Struct({
      car_id: Carpool.CarpoolCarId,
      capacity: Schema.Number,
    }),
    execute: (input) => sql`
      UPDATE carpool_cars SET capacity = ${input.capacity}, updated_at = now()
      WHERE id = ${input.car_id}
    `,
  });

  const updateCarCapacity = (input: {
    readonly carId: Carpool.CarpoolCarId;
    readonly ownerTeamMemberId: TeamMember.TeamMemberId;
    readonly capacity: number;
  }) =>
    sql
      .withTransaction(
        Effect.Do.pipe(
          Effect.bind('car', () =>
            lockCarQuery(input.carId).pipe(
              catchSqlErrors,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new CarpoolRpcModels.CarpoolCarNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.tap(({ car }) =>
            car.owner_team_member_id !== input.ownerTeamMemberId
              ? Effect.fail(new CarpoolRpcModels.CarpoolNotCarOwner())
              : Effect.void,
          ),
          Effect.bind('seatCount', () =>
            countSeatsQuery(input.carId).pipe(
              catchSqlErrors,
              Effect.catchTag('NoSuchElementError', () =>
                LogicError.die('Seat count returned no row'),
              ),
              Effect.map((r) => r.count),
            ),
          ),
          Effect.tap(({ seatCount }) =>
            // owner occupies no seat row; occupants = passengers + owner
            input.capacity < seatCount + 1
              ? Effect.fail(new CarpoolRpcModels.CarpoolCapacityBelowOccupancy())
              : Effect.void,
          ),
          Effect.tap(() =>
            setCarCapacityQuery({ car_id: input.carId, capacity: input.capacity }).pipe(
              catchSqlErrors,
            ),
          ),
        ),
      )
      .pipe(catchSqlErrors, Effect.asVoid);

  // ---- updateCarNote ----

  const setCarNoteQuery = SqlSchema.void({
    Request: Schema.Struct({
      car_id: Carpool.CarpoolCarId,
      note: Schema.OptionFromNullOr(Schema.String),
    }),
    execute: (input) => sql`
      UPDATE carpool_cars SET note = ${input.note}, updated_at = now()
      WHERE id = ${input.car_id}
    `,
  });

  const updateCarNote = (input: {
    readonly carId: Carpool.CarpoolCarId;
    readonly ownerTeamMemberId: TeamMember.TeamMemberId;
    readonly note: Option.Option<string>;
  }) =>
    sql
      .withTransaction(
        Effect.Do.pipe(
          Effect.bind('car', () =>
            lockCarQuery(input.carId).pipe(
              catchSqlErrors,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new CarpoolRpcModels.CarpoolCarNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.tap(({ car }) =>
            car.owner_team_member_id !== input.ownerTeamMemberId
              ? Effect.fail(new CarpoolRpcModels.CarpoolNotCarOwner())
              : Effect.void,
          ),
          Effect.tap(() =>
            setCarNoteQuery({ car_id: input.carId, note: input.note }).pipe(catchSqlErrors),
          ),
        ),
      )
      .pipe(catchSqlErrors, Effect.asVoid);

  // ---- kickPassenger ----

  const kickPassenger = (input: {
    readonly carId: Carpool.CarpoolCarId;
    readonly targetTeamMemberId: TeamMember.TeamMemberId;
  }) =>
    deleteSeatQuery({
      car_id: input.carId,
      team_member_id: input.targetTeamMemberId,
    }).pipe(
      catchSqlErrors,
      Effect.map((deleted) => deleted.length > 0),
    );

  return {
    createCarpool,
    saveMessageId,
    findCarpoolView,
    addCar,
    saveCarThreadId,
    reserveSeat,
    leaveSeat,
    leaveSeatByCarpool,
    removeCar,
    findCarById,
    updateCarCapacity,
    updateCarNote,
    kickPassenger,
  };
});

export class CarpoolsRepository extends ServiceMap.Service<
  CarpoolsRepository,
  Effect.Success<typeof make>
>()('api/CarpoolsRepository') {
  static readonly Default = Layer.effect(CarpoolsRepository, make);
}
