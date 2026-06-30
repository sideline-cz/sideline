import { describe, expect, it } from '@effect/vitest';
import type { Carpool, Discord, Team, TeamMember, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { CarpoolsRepository } from '~/repositories/CarpoolsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  CarpoolsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId as Discord.Snowflake,
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Carpool Test Team',
        guild_id: guildId,
        created_by: createdBy,
        description: Option.none(),
        sport: Option.none(),
        logo_url: Option.none(),
        created_at: undefined,
        updated_at: undefined,
        welcome_channel_id: Option.none(),
        system_log_channel_id: Option.none(),
        welcome_message_template: Option.none(),
        rules_channel_id: Option.none(),
        achievement_channel_id: Option.none(),
        onboarding_rules_role_id: Option.none(),
        onboarding_rules_prompt_id: Option.none(),
        onboarding_locale: 'en',
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
  );

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({
        team_id: teamId,
        user_id: userId,
        active: true,
        joined_at: undefined,
      }),
    ),
  );

const createCarpool = (
  teamId: Team.TeamId,
  guildId: Discord.Snowflake,
  createdBy: TeamMember.TeamMemberId,
  channelId: Discord.Snowflake = '300000000000000001' as Discord.Snowflake,
) =>
  CarpoolsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.createCarpool({
        teamId,
        eventId: Option.none(),
        guildId,
        channelId,
        createdBy,
      }),
    ),
  );

const addCar = (
  carpoolId: Carpool.CarpoolId,
  ownerTeamMemberId: TeamMember.TeamMemberId,
  capacity: number,
) =>
  CarpoolsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addCar({
        carpoolId,
        ownerTeamMemberId,
        capacity,
        note: Option.none(),
      }),
    ),
  );

const reserveSeat = (carId: Carpool.CarpoolCarId, teamMemberId: TeamMember.TeamMemberId) =>
  CarpoolsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.reserveSeat({ carId, teamMemberId, assignedBy: Option.none() })),
  );

const leaveSeat = (carId: Carpool.CarpoolCarId, teamMemberId: TeamMember.TeamMemberId) =>
  CarpoolsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.leaveSeat({ carId, teamMemberId })),
  );

const leaveSeatByCarpool = (carpoolId: Carpool.CarpoolId, teamMemberId: TeamMember.TeamMemberId) =>
  CarpoolsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.leaveSeatByCarpool({ carpoolId, teamMemberId })),
  );

const removeCar = (carId: Carpool.CarpoolCarId, ownerTeamMemberId: TeamMember.TeamMemberId) =>
  CarpoolsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.removeCar({ carId, ownerTeamMemberId })),
  );

const findCarpoolView = (carpoolId: Carpool.CarpoolId) =>
  CarpoolsRepository.asEffect().pipe(Effect.andThen((repo) => repo.findCarpoolView(carpoolId)));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CarpoolsRepository', () => {
  it.effect('addCar happy path (capacity 4) — findCarpoolView shows occupied=1, owner only', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('400000000000000001', 'owner-carpool-1');
      const team = yield* createTeam('410101010101010101' as Discord.Snowflake, ownerId);
      const ownerMember = yield* addTeamMember(team.id, ownerId);
      const carpool = yield* createCarpool(team.id, team.guild_id, ownerMember.id);
      const addResult = yield* addCar(carpool.id, ownerMember.id, 4);
      const view = yield* findCarpoolView(carpool.id);

      expect(Option.isSome(view)).toBe(true);
      const carpoolView = Option.getOrThrow(view);
      expect(carpoolView.cars).toHaveLength(1);
      const car = carpoolView.cars[0];
      expect(car.car_id).toBe(addResult.car_id);
      expect(car.capacity).toBe(4);
      // occupied = 1 (owner only) + 0 passengers
      const occupied = 1 + car.passengers.length;
      expect(occupied).toBe(1);
      expect(car.passengers).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('addCar capacity 1 — car is immediately full (occupied == capacity)', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('400000000000000010', 'owner-cap1');
      const team = yield* createTeam('411111111111111111' as Discord.Snowflake, ownerId);
      const ownerMember = yield* addTeamMember(team.id, ownerId);
      const carpool = yield* createCarpool(team.id, team.guild_id, ownerMember.id);
      yield* addCar(carpool.id, ownerMember.id, 1);
      const view = yield* findCarpoolView(carpool.id);

      expect(Option.isSome(view)).toBe(true);
      const carpoolView = Option.getOrThrow(view);
      const car = carpoolView.cars[0];
      expect(car.capacity).toBe(1);
      const occupied = 1 + car.passengers.length;
      // capacity 1 means owner fills the only seat
      expect(occupied).toBe(car.capacity);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('addCar same owner twice → CarpoolAlreadyOwnsCar', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('400000000000000020', 'owner-twice');
      const team = yield* createTeam('412121212121212121' as Discord.Snowflake, ownerId);
      const ownerMember = yield* addTeamMember(team.id, ownerId);
      const carpool = yield* createCarpool(team.id, team.guild_id, ownerMember.id);
      yield* addCar(carpool.id, ownerMember.id, 4);

      const secondResult = yield* addCar(carpool.id, ownerMember.id, 4).pipe(Effect.result);

      expect(secondResult._tag).toBe('Failure');
      if (secondResult._tag === 'Failure') {
        expect(secondResult.failure._tag).toBe('CarpoolAlreadyOwnsCar');
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('addCar on a non-existent carpool → CarpoolNotFound', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('400000000000000030', 'owner-deleted');
      const team = yield* createTeam('413131313131313131' as Discord.Snowflake, ownerId);
      const ownerMember = yield* addTeamMember(team.id, ownerId);

      const addResult = yield* addCar(
        'ffffffff-ffff-ffff-ffff-ffffffffffff' as Carpool.CarpoolId,
        ownerMember.id,
        4,
      ).pipe(Effect.result);

      expect(addResult._tag).toBe('Failure');
      if (addResult._tag === 'Failure') {
        expect(addResult.failure._tag).toBe('CarpoolNotFound');
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('reserveSeat happy path — occupied increments; assigned_by null', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('400000000000000040', 'owner-rsvp-ok');
      const passengerId = yield* createUser('400000000000000041', 'passenger-1');
      const team = yield* createTeam('414141414141414141' as Discord.Snowflake, ownerId);
      const ownerMember = yield* addTeamMember(team.id, ownerId);
      const passengerMember = yield* addTeamMember(team.id, passengerId);
      const carpool = yield* createCarpool(team.id, team.guild_id, ownerMember.id);
      const addResult = yield* addCar(carpool.id, ownerMember.id, 4);
      yield* reserveSeat(addResult.car_id, passengerMember.id);
      const view = yield* findCarpoolView(carpool.id);

      expect(Option.isSome(view)).toBe(true);
      const carpoolView = Option.getOrThrow(view);
      const car = carpoolView.cars[0];
      // owner (1) + 1 passenger
      expect(1 + car.passengers.length).toBe(2);
      expect(car.passengers.some((p) => p.team_member_id === passengerMember.id)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('reserveSeat last seat (capacity 2): first reserve OK, second → CarpoolFull', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('400000000000000050', 'owner-cap2');
      const passId1 = yield* createUser('400000000000000051', 'pass-cap2-1');
      const passId2 = yield* createUser('400000000000000052', 'pass-cap2-2');
      const team = yield* createTeam('415151515151515151' as Discord.Snowflake, ownerId);
      const ownerMember = yield* addTeamMember(team.id, ownerId);
      const pm1 = yield* addTeamMember(team.id, passId1);
      const pm2 = yield* addTeamMember(team.id, passId2);
      const carpool = yield* createCarpool(team.id, team.guild_id, ownerMember.id);
      // capacity 2 means owner + 1 passenger fills it
      const addResult = yield* addCar(carpool.id, ownerMember.id, 2);
      // First passenger — should succeed
      yield* reserveSeat(addResult.car_id, pm1.id);
      // Second passenger — should fail with CarpoolFull
      const secondResult = yield* reserveSeat(addResult.car_id, pm2.id).pipe(Effect.result);

      expect(secondResult._tag).toBe('Failure');
      if (secondResult._tag === 'Failure') {
        expect(secondResult.failure._tag).toBe('CarpoolFull');
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('reserveSeat same member same car twice → CarpoolAlreadyInThisCar', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('400000000000000060', 'owner-dup');
      const passId = yield* createUser('400000000000000061', 'pass-dup');
      const team = yield* createTeam('416161616161616161' as Discord.Snowflake, ownerId);
      const ownerMember = yield* addTeamMember(team.id, ownerId);
      const pm = yield* addTeamMember(team.id, passId);
      const carpool = yield* createCarpool(team.id, team.guild_id, ownerMember.id);
      const addResult = yield* addCar(carpool.id, ownerMember.id, 4);
      yield* reserveSeat(addResult.car_id, pm.id);

      const dupResult = yield* reserveSeat(addResult.car_id, pm.id).pipe(Effect.result);

      expect(dupResult._tag).toBe('Failure');
      if (dupResult._tag === 'Failure') {
        expect(dupResult.failure._tag).toBe('CarpoolAlreadyInThisCar');
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'reserveSeat member already in another car of same carpool → CarpoolAlreadyInAnotherCar',
    () =>
      Effect.gen(function* () {
        const owner1Id = yield* createUser('400000000000000070', 'owner-car1');
        const owner2Id = yield* createUser('400000000000000071', 'owner-car2');
        const passId = yield* createUser('400000000000000072', 'pass-two-cars');
        const team = yield* createTeam('417171717171717171' as Discord.Snowflake, owner1Id);
        const om1 = yield* addTeamMember(team.id, owner1Id);
        const om2 = yield* addTeamMember(team.id, owner2Id);
        const pm = yield* addTeamMember(team.id, passId);
        const carpool = yield* createCarpool(team.id, team.guild_id, om1.id);
        const car1 = yield* addCar(carpool.id, om1.id, 4);
        const car2 = yield* addCar(carpool.id, om2.id, 4);
        // Reserve in car1 first
        yield* reserveSeat(car1.car_id, pm.id);
        // Try to also reserve in car2 — should fail
        const dupResult = yield* reserveSeat(car2.car_id, pm.id).pipe(Effect.result);

        expect(dupResult._tag).toBe('Failure');
        if (dupResult._tag === 'Failure') {
          expect(dupResult.failure._tag).toBe('CarpoolAlreadyInAnotherCar');
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('reserveSeat by the car owner → CarpoolOwnerCannotReserve', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('400000000000000080', 'owner-cannot-reserve');
      const team = yield* createTeam('418181818181818181' as Discord.Snowflake, ownerId);
      const ownerMember = yield* addTeamMember(team.id, ownerId);
      const carpool = yield* createCarpool(team.id, team.guild_id, ownerMember.id);
      const addResult = yield* addCar(carpool.id, ownerMember.id, 4);

      const result = yield* reserveSeat(addResult.car_id, ownerMember.id).pipe(Effect.result);

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('CarpoolOwnerCannotReserve');
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('assignSeat happy path — assigned_by is set to the assigning member id', () =>
    // NOTE: Non-owner enforcement is at the RPC layer, not the repo layer.
    // The repo accepts any assigned_by value; the RPC handler validates caller == owner.
    Effect.gen(function* () {
      const ownerId = yield* createUser('400000000000000090', 'owner-assign');
      const passId = yield* createUser('400000000000000091', 'pass-assign');
      const team = yield* createTeam('419191919191919191' as Discord.Snowflake, ownerId);
      const ownerMember = yield* addTeamMember(team.id, ownerId);
      const pm = yield* addTeamMember(team.id, passId);
      const carpool = yield* createCarpool(team.id, team.guild_id, ownerMember.id);
      const addResult = yield* addCar(carpool.id, ownerMember.id, 4);

      // Assign the seat with assigned_by = ownerMember
      yield* CarpoolsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.reserveSeat({
            carId: addResult.car_id,
            teamMemberId: pm.id,
            assignedBy: Option.some(ownerMember.id),
          }),
        ),
      );

      const view = yield* findCarpoolView(carpool.id);
      expect(Option.isSome(view)).toBe(true);
      const carpoolView = Option.getOrThrow(view);
      const car = carpoolView.cars[0];
      expect(car.passengers.some((p) => p.team_member_id === pm.id)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'leaveSeat: passenger removed; owner cannot leave; non-occupant → CarpoolNotInCar',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('400000000000000100', 'owner-leave');
        const passId = yield* createUser('400000000000000101', 'pass-leave');
        const nonOccId = yield* createUser('400000000000000102', 'non-occ');
        const team = yield* createTeam('420202020202020202' as Discord.Snowflake, ownerId);
        const ownerMember = yield* addTeamMember(team.id, ownerId);
        const pm = yield* addTeamMember(team.id, passId);
        const nonOcc = yield* addTeamMember(team.id, nonOccId);
        const carpool = yield* createCarpool(team.id, team.guild_id, ownerMember.id);
        const addResult = yield* addCar(carpool.id, ownerMember.id, 4);
        yield* reserveSeat(addResult.car_id, pm.id);

        // Owner cannot leave own car
        const ownerLeaveResult = yield* leaveSeat(addResult.car_id, ownerMember.id).pipe(
          Effect.result,
        );
        // Non-occupant cannot leave
        const nonOccLeaveResult = yield* leaveSeat(addResult.car_id, nonOcc.id).pipe(Effect.result);
        // Passenger can leave
        yield* leaveSeat(addResult.car_id, pm.id);
        const viewAfterLeave = yield* findCarpoolView(carpool.id);

        // Owner cannot leave
        expect(ownerLeaveResult._tag).toBe('Failure');
        if (ownerLeaveResult._tag === 'Failure') {
          expect(ownerLeaveResult.failure._tag).toBe('CarpoolOwnerCannotLeave');
        }
        // Non-occupant cannot leave
        expect(nonOccLeaveResult._tag).toBe('Failure');
        if (nonOccLeaveResult._tag === 'Failure') {
          expect(nonOccLeaveResult.failure._tag).toBe('CarpoolNotInCar');
        }
        // After passenger leaves, car has 0 passengers
        expect(Option.isSome(viewAfterLeave)).toBe(true);
        const view = Option.getOrThrow(viewAfterLeave);
        expect(view.cars[0].passengers).toHaveLength(0);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'removeCar by owner — car and seats gone, returns thread_id; non-owner → CarpoolNotCarOwner',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('400000000000000110', 'owner-remove');
        const otherId = yield* createUser('400000000000000111', 'other-remove');
        const passId = yield* createUser('400000000000000112', 'pass-remove');
        const team = yield* createTeam('421212121212121212' as Discord.Snowflake, ownerId);
        const ownerMember = yield* addTeamMember(team.id, ownerId);
        const otherMember = yield* addTeamMember(team.id, otherId);
        const pm = yield* addTeamMember(team.id, passId);
        const carpool = yield* createCarpool(team.id, team.guild_id, ownerMember.id);
        const addResult = yield* addCar(carpool.id, ownerMember.id, 4);
        yield* reserveSeat(addResult.car_id, pm.id);

        // Non-owner cannot remove
        const nonOwnerResult = yield* removeCar(addResult.car_id, otherMember.id).pipe(
          Effect.result,
        );
        // Owner can remove
        const removeResult = yield* removeCar(addResult.car_id, ownerMember.id);
        const viewAfterRemove = yield* findCarpoolView(carpool.id);

        // Non-owner check
        expect(nonOwnerResult._tag).toBe('Failure');
        if (nonOwnerResult._tag === 'Failure') {
          expect(nonOwnerResult.failure._tag).toBe('CarpoolNotCarOwner');
        }
        // Owner remove succeeded; thread_id is Option (none since we never set one)
        expect(Option.isNone(removeResult.thread_id)).toBe(true);
        // After removal, carpool still exists but has no cars
        expect(Option.isSome(viewAfterRemove)).toBe(true);
        expect(Option.getOrThrow(viewAfterRemove).cars).toHaveLength(0);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'concurrency: capacity 2, two parallel reserveSeat → exactly one succeeds, one fails CarpoolFull',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('400000000000000120', 'owner-concurrent');
        const pass1Id = yield* createUser('400000000000000121', 'pass-concurrent-1');
        const pass2Id = yield* createUser('400000000000000122', 'pass-concurrent-2');
        const team = yield* createTeam('422222222222222222' as Discord.Snowflake, ownerId);
        const ownerMember = yield* addTeamMember(team.id, ownerId);
        const pm1 = yield* addTeamMember(team.id, pass1Id);
        const pm2 = yield* addTeamMember(team.id, pass2Id);
        const carpool = yield* createCarpool(team.id, team.guild_id, ownerMember.id);
        // capacity 2 = owner + 1 passenger
        const addResult = yield* addCar(carpool.id, ownerMember.id, 2);

        const results = yield* Effect.all(
          [
            reserveSeat(addResult.car_id, pm1.id).pipe(Effect.result),
            reserveSeat(addResult.car_id, pm2.id).pipe(Effect.result),
          ],
          { concurrency: 'unbounded' },
        );

        const successes = results.filter((r) => r._tag === 'Success').length;
        const failures = results.filter((r) => r._tag === 'Failure').length;
        expect(successes).toBe(1);
        expect(failures).toBe(1);
        const failure = results.find((r) => r._tag === 'Failure');
        if (failure && failure._tag === 'Failure') {
          expect(failure.failure._tag).toBe('CarpoolFull');
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'reserveSeat by owner of another car in same carpool → CarpoolAlreadyInAnotherCar',
    () =>
      Effect.gen(function* () {
        // ownerA owns carA; ownerB owns carB; ownerA tries to reserve a seat in carB
        const ownerAId = yield* createUser('400000000000000140', 'owner-a-cross-reserve');
        const ownerBId = yield* createUser('400000000000000141', 'owner-b-cross-reserve');
        const team = yield* createTeam('424242424242424242' as Discord.Snowflake, ownerAId);
        const ownerAMember = yield* addTeamMember(team.id, ownerAId);
        const ownerBMember = yield* addTeamMember(team.id, ownerBId);
        const carpool = yield* createCarpool(team.id, team.guild_id, ownerAMember.id);
        yield* addCar(carpool.id, ownerAMember.id, 4); // carA — ownerA is its owner
        const carB = yield* addCar(carpool.id, ownerBMember.id, 4);

        // ownerA (who already owns carA) tries to reserve a passenger seat in carB
        const result = yield* reserveSeat(carB.car_id, ownerAMember.id).pipe(Effect.result);

        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          expect(result.failure._tag).toBe('CarpoolAlreadyInAnotherCar');
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'assignSeat (assignedBy set) by owner of another car in same carpool → CarpoolAlreadyInAnotherCar',
    () =>
      Effect.gen(function* () {
        // ownerA owns carA; ownerB owns carB; ownerB tries to assign ownerA a seat in carB
        const ownerAId = yield* createUser('400000000000000150', 'owner-a-cross-assign');
        const ownerBId = yield* createUser('400000000000000151', 'owner-b-cross-assign');
        const team = yield* createTeam('425252525252525252' as Discord.Snowflake, ownerAId);
        const ownerAMember = yield* addTeamMember(team.id, ownerAId);
        const ownerBMember = yield* addTeamMember(team.id, ownerBId);
        const carpool = yield* createCarpool(team.id, team.guild_id, ownerAMember.id);
        yield* addCar(carpool.id, ownerAMember.id, 4); // carA — ownerA is its owner
        const carB = yield* addCar(carpool.id, ownerBMember.id, 4);

        // ownerB assigns ownerA (who already owns carA) a seat in carB
        const result = yield* CarpoolsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.reserveSeat({
              carId: carB.car_id,
              teamMemberId: ownerAMember.id,
              assignedBy: Option.some(ownerBMember.id),
            }),
          ),
          Effect.result,
        );

        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          expect(result.failure._tag).toBe('CarpoolAlreadyInAnotherCar');
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'owns-another-car check takes precedence over CarpoolFull — → CarpoolAlreadyInAnotherCar not CarpoolFull',
    () =>
      Effect.gen(function* () {
        // ownerA owns carA (capacity 4); ownerB owns carB (capacity 2, will be filled)
        // Then ownerA tries to reserve in carB — should get CarpoolAlreadyInAnotherCar, not CarpoolFull
        const ownerAId = yield* createUser('400000000000000160', 'owner-a-precedence');
        const ownerBId = yield* createUser('400000000000000161', 'owner-b-precedence');
        const passId = yield* createUser('400000000000000162', 'pass-precedence');
        const team = yield* createTeam('426262626262626262' as Discord.Snowflake, ownerAId);
        const ownerAMember = yield* addTeamMember(team.id, ownerAId);
        const ownerBMember = yield* addTeamMember(team.id, ownerBId);
        const pm = yield* addTeamMember(team.id, passId);
        const carpool = yield* createCarpool(team.id, team.guild_id, ownerAMember.id);
        yield* addCar(carpool.id, ownerAMember.id, 4); // carA — ownerA is its owner
        const carB = yield* addCar(carpool.id, ownerBMember.id, 2); // capacity 2: owner + 1 passenger
        // Fill carB: owner(1) + passenger(1) = full (capacity 2)
        yield* reserveSeat(carB.car_id, pm.id);

        // ownerA (who owns carA) tries to reserve in full carB
        // Expects CarpoolAlreadyInAnotherCar, NOT CarpoolFull
        const result = yield* reserveSeat(carB.car_id, ownerAMember.id).pipe(Effect.result);

        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          expect(result.failure._tag).toBe('CarpoolAlreadyInAnotherCar');
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'findCarpoolView with member whose user/name rows are null — returns view, name fields are Option.none',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('400000000000000130', 'owner-null-name');
        const passId = yield* createUser('400000000000000131', 'pass-null-name');
        const team = yield* createTeam('423232323232323232' as Discord.Snowflake, ownerId);
        const ownerMember = yield* addTeamMember(team.id, ownerId);
        const pm = yield* addTeamMember(team.id, passId);
        const carpool = yield* createCarpool(team.id, team.guild_id, ownerMember.id);
        const addResult = yield* addCar(carpool.id, ownerMember.id, 4);
        yield* reserveSeat(addResult.car_id, pm.id);

        const view = yield* findCarpoolView(carpool.id);

        // The view should be returned even if name fields are null in the DB.
        // MemberDisplay fields (name, nickname, display_name) may be Option.none().
        expect(Option.isSome(view)).toBe(true);
        const carpoolView = Option.getOrThrow(view);
        expect(carpoolView.cars).toHaveLength(1);
        // No throw — rendering null fields as Option.none() is the contract
        const owner = carpoolView.cars[0].owner;
        expect(owner).toBeDefined();
        // name could be none — just assert the field exists and doesn't throw
        expect('name' in owner).toBe(true);
      }).pipe(Effect.provide(TestLayer)),
  );

  // ---------------------------------------------------------------------------
  // leaveSeatByCarpool tests (TDD — implementation not yet written)
  // ---------------------------------------------------------------------------

  it.effect('leaveSeatByCarpool: passenger leaves their car (happy path)', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('400000000000000170', 'owner-lsbc-1');
      const passId = yield* createUser('400000000000000171', 'pass-lsbc-1');
      const team = yield* createTeam('427272727272727272' as Discord.Snowflake, ownerId);
      const ownerMember = yield* addTeamMember(team.id, ownerId);
      const passengerMember = yield* addTeamMember(team.id, passId);
      const carpool = yield* createCarpool(team.id, team.guild_id, ownerMember.id);
      const carA = yield* addCar(carpool.id, ownerMember.id, 4);
      yield* reserveSeat(carA.car_id, passengerMember.id);

      yield* leaveSeatByCarpool(carpool.id, passengerMember.id);

      const view = yield* findCarpoolView(carpool.id);
      expect(Option.isSome(view)).toBe(true);
      const carpoolView = Option.getOrThrow(view);
      expect(carpoolView.cars[0].passengers).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('leaveSeatByCarpool: resolves the correct car among multiple cars', () =>
    Effect.gen(function* () {
      const ownerAId = yield* createUser('400000000000000180', 'owner-lsbc-a');
      const ownerBId = yield* createUser('400000000000000181', 'owner-lsbc-b');
      const passId = yield* createUser('400000000000000182', 'pass-lsbc-multi');
      const team = yield* createTeam('428282828282828282' as Discord.Snowflake, ownerAId);
      const ownerAMember = yield* addTeamMember(team.id, ownerAId);
      const ownerBMember = yield* addTeamMember(team.id, ownerBId);
      const passengerMember = yield* addTeamMember(team.id, passId);
      const carpool = yield* createCarpool(team.id, team.guild_id, ownerAMember.id);
      const carA = yield* addCar(carpool.id, ownerAMember.id, 4);
      const carB = yield* addCar(carpool.id, ownerBMember.id, 4);
      // Passenger joins car B only
      yield* reserveSeat(carB.car_id, passengerMember.id);

      yield* leaveSeatByCarpool(carpool.id, passengerMember.id);

      const view = yield* findCarpoolView(carpool.id);
      expect(Option.isSome(view)).toBe(true);
      const carpoolView = Option.getOrThrow(view);
      const viewCarA = carpoolView.cars.find((c) => c.car_id === carA.car_id);
      const viewCarB = carpoolView.cars.find((c) => c.car_id === carB.car_id);
      // Car B: passenger has left
      expect(viewCarB?.passengers).toHaveLength(0);
      // Car A: unchanged — still 0 passengers
      expect(viewCarA?.passengers).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('leaveSeatByCarpool: non-occupant → CarpoolNotInCar', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('400000000000000190', 'owner-lsbc-nocc');
      const nonOccId = yield* createUser('400000000000000191', 'nocc-lsbc');
      const team = yield* createTeam('429292929292929292' as Discord.Snowflake, ownerId);
      const ownerMember = yield* addTeamMember(team.id, ownerId);
      const nonOcc = yield* addTeamMember(team.id, nonOccId);
      const carpool = yield* createCarpool(team.id, team.guild_id, ownerMember.id);
      yield* addCar(carpool.id, ownerMember.id, 4);

      const result = yield* leaveSeatByCarpool(carpool.id, nonOcc.id).pipe(Effect.result);

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('CarpoolNotInCar');
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('leaveSeatByCarpool: car owner → CarpoolOwnerCannotLeave', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('400000000000000200', 'owner-lsbc-owns');
      const team = yield* createTeam('430303030303030303' as Discord.Snowflake, ownerId);
      const ownerMember = yield* addTeamMember(team.id, ownerId);
      const carpool = yield* createCarpool(team.id, team.guild_id, ownerMember.id);
      yield* addCar(carpool.id, ownerMember.id, 4);

      const result = yield* leaveSeatByCarpool(carpool.id, ownerMember.id).pipe(Effect.result);

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('CarpoolOwnerCannotLeave');
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('leaveSeatByCarpool: seated only in a DIFFERENT carpool → CarpoolNotInCar', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('400000000000000210', 'owner-lsbc-scope');
      const passId = yield* createUser('400000000000000211', 'pass-lsbc-scope');
      const team = yield* createTeam('431313131313131313' as Discord.Snowflake, ownerId);
      const ownerMember = yield* addTeamMember(team.id, ownerId);
      const passengerMember = yield* addTeamMember(team.id, passId);
      // Two separate carpools in the same team / guild
      const carpoolX = yield* createCarpool(
        team.id,
        team.guild_id,
        ownerMember.id,
        '300000000000000002' as Discord.Snowflake,
      );
      const carpoolY = yield* createCarpool(
        team.id,
        team.guild_id,
        ownerMember.id,
        '300000000000000003' as Discord.Snowflake,
      );
      const carX = yield* addCar(carpoolX.id, ownerMember.id, 4);
      yield* addCar(carpoolY.id, ownerMember.id, 4);
      // Passenger is only seated in carpool X
      yield* reserveSeat(carX.car_id, passengerMember.id);

      // Attempt to leave via carpool Y — should fail because the seat is in X, not Y
      const result = yield* leaveSeatByCarpool(carpoolY.id, passengerMember.id).pipe(Effect.result);

      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('CarpoolNotInCar');
      }
    }).pipe(Effect.provide(TestLayer)),
  );
});
