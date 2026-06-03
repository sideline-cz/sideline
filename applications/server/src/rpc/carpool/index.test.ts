// NOTE: These tests were originally written in TDD mode BEFORE the implementation.
// The `carpool:manage` permission gate on CreateCarpool and AddCar returns CarpoolForbidden
// (distinct from CarpoolNotMember, which is returned when the caller is not a team member at all).

import { it as itEffect } from '@effect/vitest';
import type { Carpool, Discord, Event, Team, TeamMember, User } from '@sideline/domain';
import { CarpoolRpcGroup, CarpoolRpcModels } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { CarpoolsRepository } from '~/repositories/CarpoolsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { CarpoolsRpcLive } from '~/rpc/carpool/index.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const GUILD_ID = '500000000000000001' as Discord.Snowflake;
const UNKNOWN_GUILD_ID = '500000000000000099' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000050' as Team.TeamId;
const MANAGER_DISCORD_ID = '500000000000000010' as Discord.Snowflake;
const MEMBER_DISCORD_ID = '500000000000000011' as Discord.Snowflake;
const NON_MEMBER_DISCORD_ID = '500000000000000012' as Discord.Snowflake;
const MANAGER_MEMBER_ID = '00000000-0000-0000-0000-000000000051' as TeamMember.TeamMemberId;
const MEMBER_MEMBER_ID = '00000000-0000-0000-0000-000000000052' as TeamMember.TeamMemberId;
const CHANNEL_ID = '500000000000000020' as Discord.Snowflake;
const CARPOOL_ID = '00000000-0000-0000-0000-000000000060' as Carpool.CarpoolId;
const CAR_ID_1 = '00000000-0000-0000-0000-000000000061' as Carpool.CarpoolCarId;
const CAR_ID_NON_OWNER = '00000000-0000-0000-0000-000000000062' as Carpool.CarpoolCarId;

// ---------------------------------------------------------------------------
// In-memory stores (reset between tests)
// ---------------------------------------------------------------------------

type CarpoolStore = {
  id: Carpool.CarpoolId;
  team_id: Team.TeamId;
  guild_id: Discord.Snowflake;
  channel_id: Discord.Snowflake;
  created_by: TeamMember.TeamMemberId;
};

let carpoolsStore: Map<Carpool.CarpoolId, CarpoolStore>;
let addCarCalls: Array<{
  carpoolId: Carpool.CarpoolId;
  ownerTeamMemberId: TeamMember.TeamMemberId;
}>;
let reserveSeatCalls: Array<{ carId: Carpool.CarpoolCarId; teamMemberId: TeamMember.TeamMemberId }>;
let leaveSeatCalls: Array<{ carId: Carpool.CarpoolCarId; teamMemberId: TeamMember.TeamMemberId }>;
let removeCarCalls: Array<{
  carId: Carpool.CarpoolCarId;
  ownerTeamMemberId: TeamMember.TeamMemberId;
}>;

const makeCarpoolView = (carpoolId: Carpool.CarpoolId): CarpoolRpcModels.CarpoolView =>
  new CarpoolRpcModels.CarpoolView({
    carpool_id: carpoolId,
    discord_channel_id: CHANNEL_ID,
    discord_message_id: Option.none(),
    event_id: Option.none(),
    cars: [],
  });

const makeCarpoolViewWithCar = (
  carpoolId: Carpool.CarpoolId,
  carId: Carpool.CarpoolCarId,
  ownerMemberId: TeamMember.TeamMemberId,
): CarpoolRpcModels.CarpoolView =>
  new CarpoolRpcModels.CarpoolView({
    carpool_id: carpoolId,
    discord_channel_id: CHANNEL_ID,
    discord_message_id: Option.none(),
    event_id: Option.none(),
    cars: [
      new CarpoolRpcModels.CarpoolCarView({
        car_id: carId,
        thread_id: Option.none(),
        capacity: 4,
        note: Option.none(),
        owner: new CarpoolRpcModels.MemberDisplay({
          team_member_id: ownerMemberId,
          discord_id: Option.none(),
          name: Option.some('Owner'),
          nickname: Option.none(),
          display_name: Option.none(),
          username: Option.none(),
        }),
        passengers: [],
      }),
    ],
  });

const resetStores = () => {
  carpoolsStore = new Map();
  addCarCalls = [];
  reserveSeatCalls = [];
  leaveSeatCalls = [];
  removeCarCalls = [];

  carpoolsStore.set(CARPOOL_ID, {
    id: CARPOOL_ID,
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    created_by: MANAGER_MEMBER_ID,
  });
};

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const MockTeamsRepository = Layer.succeed(TeamsRepository, {
  findById: (_id: Team.TeamId) => Effect.succeed(Option.none()),
  findByGuildId: (guildId: Discord.Snowflake) => {
    if (guildId === GUILD_ID) {
      return Effect.succeed(
        Option.some({
          id: TEAM_ID,
          name: 'Test Team',
          guild_id: GUILD_ID,
          created_by: 'user-1',
          created_at: DateTime.nowUnsafe(),
          updated_at: DateTime.nowUnsafe(),
        }),
      );
    }
    return Effect.succeed(Option.none());
  },
  insert: () => Effect.die(new Error('Not implemented')),
} as any);

const MockTeamMembersRepository = Layer.succeed(TeamMembersRepository, {
  findMembershipByIds: (_teamId: Team.TeamId, _userId: User.UserId) =>
    Effect.succeed(Option.none()),
  findMembershipByDiscordAndTeam: (discordId: Discord.Snowflake, teamId: Team.TeamId) => {
    if (teamId !== TEAM_ID) return Effect.succeed(Option.none());
    if (discordId === MANAGER_DISCORD_ID) {
      return Effect.succeed(
        Option.some({
          id: MANAGER_MEMBER_ID,
          team_id: TEAM_ID,
          user_id: 'user-manager',
          active: true,
          role_names: ['Captain'],
          permissions: ['carpool:manage'] as string[],
        }),
      );
    }
    if (discordId === MEMBER_DISCORD_ID) {
      return Effect.succeed(
        Option.some({
          id: MEMBER_MEMBER_ID,
          team_id: TEAM_ID,
          user_id: 'user-member',
          active: true,
          role_names: ['Player'],
          permissions: [] as string[],
        }),
      );
    }
    return Effect.succeed(Option.none());
  },
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  addMember: () => Effect.die(new Error('Not implemented')),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getPlayerRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
} as any);

const MockCarpoolsRepository = Layer.succeed(CarpoolsRepository, {
  createCarpool: (input: {
    teamId: Team.TeamId;
    eventId: Option.Option<Event.EventId>;
    guildId: Discord.Snowflake;
    channelId: Discord.Snowflake;
    createdBy: TeamMember.TeamMemberId;
  }) => {
    const carpool = {
      id: CARPOOL_ID,
      team_id: input.teamId,
      event_id: input.eventId,
      guild_id: input.guildId,
      discord_channel_id: input.channelId,
      discord_message_id: Option.none(),
      created_by: input.createdBy,
      created_at: DateTime.nowUnsafe(),
      updated_at: DateTime.nowUnsafe(),
    };
    carpoolsStore.set(CARPOOL_ID, {
      id: CARPOOL_ID,
      team_id: input.teamId,
      guild_id: input.guildId,
      channel_id: input.channelId,
      created_by: input.createdBy,
    });
    return Effect.succeed(carpool as any);
  },
  saveMessageId: (_carpoolId: Carpool.CarpoolId, _messageId: Discord.Snowflake) => Effect.void,
  findCarpoolView: (carpoolId: Carpool.CarpoolId) => {
    const exists = carpoolsStore.has(carpoolId);
    return Effect.succeed(exists ? Option.some(makeCarpoolView(carpoolId)) : Option.none());
  },
  addCar: (input: {
    carpoolId: Carpool.CarpoolId;
    ownerTeamMemberId: TeamMember.TeamMemberId;
    capacity: number;
    note: Option.Option<string>;
  }) => {
    addCarCalls.push({ carpoolId: input.carpoolId, ownerTeamMemberId: input.ownerTeamMemberId });
    if (!carpoolsStore.has(input.carpoolId)) {
      return Effect.fail(new CarpoolRpcModels.CarpoolNotFound());
    }
    return Effect.succeed({
      car_id: CAR_ID_1,
      view: makeCarpoolViewWithCar(input.carpoolId, CAR_ID_1, input.ownerTeamMemberId),
    } as any);
  },
  saveCarThreadId: (_carId: Carpool.CarpoolCarId, _threadId: Discord.Snowflake) => Effect.void,
  reserveSeat: (input: {
    carId: Carpool.CarpoolCarId;
    teamMemberId: TeamMember.TeamMemberId;
    assignedBy: Option.Option<TeamMember.TeamMemberId>;
  }) => {
    reserveSeatCalls.push({ carId: input.carId, teamMemberId: input.teamMemberId });
    return Effect.void;
  },
  leaveSeat: (input: { carId: Carpool.CarpoolCarId; teamMemberId: TeamMember.TeamMemberId }) => {
    leaveSeatCalls.push({ carId: input.carId, teamMemberId: input.teamMemberId });
    return Effect.void;
  },
  removeCar: (input: {
    carId: Carpool.CarpoolCarId;
    ownerTeamMemberId: TeamMember.TeamMemberId;
  }) => {
    removeCarCalls.push({ carId: input.carId, ownerTeamMemberId: input.ownerTeamMemberId });
    if (input.carId === CAR_ID_NON_OWNER) {
      return Effect.fail(new CarpoolRpcModels.CarpoolNotCarOwner());
    }
    return Effect.succeed({
      thread_id: Option.none<Discord.Snowflake>(),
      view: makeCarpoolView(CARPOOL_ID),
    } as any);
  },
  findCarById: (carId: Carpool.CarpoolCarId) => {
    if (carId === CAR_ID_1) {
      return Effect.succeed(
        Option.some({
          id: CAR_ID_1,
          carpool_id: CARPOOL_ID,
          owner_team_member_id: MANAGER_MEMBER_ID,
          capacity: 4,
          thread_id: Option.none(),
          note: Option.none(),
        }),
      );
    }
    if (carId === CAR_ID_NON_OWNER) {
      return Effect.succeed(
        Option.some({
          id: CAR_ID_NON_OWNER,
          carpool_id: CARPOOL_ID,
          owner_team_member_id: MEMBER_MEMBER_ID,
          capacity: 4,
          thread_id: Option.none(),
          note: Option.none(),
        }),
      );
    }
    return Effect.succeed(Option.none());
  },
} as any);

const TestLayer = CarpoolsRpcLive.pipe(
  Layer.provide(
    Layer.mergeAll(MockTeamsRepository, MockTeamMembersRepository, MockCarpoolsRepository),
  ),
);

// ---------------------------------------------------------------------------
// RPC call helper
// ---------------------------------------------------------------------------

const callRpc = <_K extends keyof (typeof CarpoolRpcGroup.CarpoolRpcGroup)['requests']>(
  method: string,
  payload: Record<string, unknown>,
) =>
  Effect.scoped(
    (RpcTest.makeClient(CarpoolRpcGroup.CarpoolRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap((rpc: any) => rpc[method](payload) as Effect.Effect<any, any, any>),
    ),
  ).pipe(Effect.provide(TestLayer));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  addCarCalls = [];
  reserveSeatCalls = [];
  leaveSeatCalls = [];
  removeCarCalls = [];
});

describe('Carpool/CreateCarpool RPC', () => {
  itEffect.effect('unknown guild_id → CarpoolGuildNotFound', () =>
    callRpc('Carpool/CreateCarpool', {
      guild_id: UNKNOWN_GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      event_id: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('CarpoolGuildNotFound');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('non-member discord_user_id → CarpoolNotMember', () =>
    callRpc('Carpool/CreateCarpool', {
      guild_id: GUILD_ID,
      discord_user_id: NON_MEMBER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      event_id: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('CarpoolNotMember');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect(
    'member without carpool:manage permission → CarpoolForbidden (permission gate)',
    () =>
      callRpc('Carpool/CreateCarpool', {
        guild_id: GUILD_ID,
        discord_user_id: MEMBER_DISCORD_ID,
        discord_channel_id: CHANNEL_ID,
        event_id: Option.none(),
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') {
              expect(result.failure._tag).toBe('CarpoolForbidden');
            }
          }),
        ),
        Effect.asVoid,
      ),
  );

  itEffect.effect('manager with carpool:manage creates carpool → returns CarpoolView', () =>
    callRpc('Carpool/CreateCarpool', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      discord_channel_id: CHANNEL_ID,
      event_id: Option.none(),
    }).pipe(
      Effect.tap((view) =>
        Effect.sync(() => {
          expect(view).toBeInstanceOf(CarpoolRpcModels.CarpoolView);
          expect(view.carpool_id).toBe(CARPOOL_ID);
        }),
      ),
      Effect.asVoid,
    ),
  );
});

describe('Carpool/SaveCarThreadId RPC', () => {
  itEffect.effect('saves car thread id → returns void', () => {
    const THREAD_ID = '500000000000000030' as Discord.Snowflake;
    return callRpc('Carpool/SaveCarThreadId', {
      car_id: CAR_ID_1,
      thread_id: THREAD_ID,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toBeUndefined();
        }),
      ),
      Effect.asVoid,
    );
  });
});

describe('Carpool/AddCar RPC', () => {
  itEffect.effect('unknown guild_id → CarpoolGuildNotFound', () =>
    callRpc('Carpool/AddCar', {
      guild_id: UNKNOWN_GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      carpool_id: CARPOOL_ID,
      capacity: 4,
      note: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('CarpoolGuildNotFound');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('non-member discord_user_id → CarpoolNotMember', () =>
    callRpc('Carpool/AddCar', {
      guild_id: GUILD_ID,
      discord_user_id: NON_MEMBER_DISCORD_ID,
      carpool_id: CARPOOL_ID,
      capacity: 4,
      note: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('CarpoolNotMember');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('manager adds car → returns AddCarResult with post-commit view', () =>
    callRpc('Carpool/AddCar', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      carpool_id: CARPOOL_ID,
      capacity: 4,
      note: Option.none(),
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toBeInstanceOf(CarpoolRpcModels.AddCarResult);
          expect(result.car_id).toBe(CAR_ID_1);
          expect(result.view).toBeInstanceOf(CarpoolRpcModels.CarpoolView);
          expect(addCarCalls).toHaveLength(1);
          expect(addCarCalls[0].ownerTeamMemberId).toBe(MANAGER_MEMBER_ID);
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('repo propagates CarpoolAlreadyOwnsCar as typed error (not raw defect)', () => {
    const MockCarpoolsRepoWithOwnsCar = Layer.succeed(CarpoolsRepository, {
      findCarpoolView: (_carpoolId: Carpool.CarpoolId) =>
        Effect.succeed(Option.some(makeCarpoolView(CARPOOL_ID))),
      addCar: () => Effect.fail(new CarpoolRpcModels.CarpoolAlreadyOwnsCar()),
      createCarpool: () => Effect.die(new Error('Not used')),
      saveMessageId: () => Effect.void,
      saveCarThreadId: () => Effect.void,
      reserveSeat: () => Effect.void,
      leaveSeat: () => Effect.void,
      removeCar: () => Effect.die(new Error('Not used')),
      findCarById: () => Effect.succeed(Option.none()),
    } as any);

    const layerWithOwnsCar = CarpoolsRpcLive.pipe(
      Layer.provide(
        Layer.mergeAll(MockTeamsRepository, MockTeamMembersRepository, MockCarpoolsRepoWithOwnsCar),
      ),
    );

    return callRpc('Carpool/AddCar', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      carpool_id: CARPOOL_ID,
      capacity: 4,
      note: Option.none(),
    }).pipe(
      Effect.provide(layerWithOwnsCar),
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('CarpoolAlreadyOwnsCar');
          }
        }),
      ),
      Effect.asVoid,
    );
  });
});

describe('Carpool/ReserveSeat RPC', () => {
  itEffect.effect(
    'member reserves seat → calls repo with correct memberId, returns ReserveResult',
    () =>
      callRpc('Carpool/ReserveSeat', {
        guild_id: GUILD_ID,
        discord_user_id: MEMBER_DISCORD_ID,
        car_id: CAR_ID_1,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result).toBeInstanceOf(CarpoolRpcModels.ReserveResult);
            expect(reserveSeatCalls).toHaveLength(1);
            expect(reserveSeatCalls[0].teamMemberId).toBe(MEMBER_MEMBER_ID);
            expect(reserveSeatCalls[0].carId).toBe(CAR_ID_1);
          }),
        ),
        Effect.asVoid,
      ),
  );

  itEffect.effect('non-member → CarpoolNotMember', () =>
    callRpc('Carpool/ReserveSeat', {
      guild_id: GUILD_ID,
      discord_user_id: NON_MEMBER_DISCORD_ID,
      car_id: CAR_ID_1,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('CarpoolNotMember');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

describe('Carpool/AssignSeat RPC', () => {
  itEffect.effect('caller != car owner → CarpoolNotCarOwner', () =>
    // MEMBER_DISCORD_ID is a member, not the owner of CAR_ID_1 (which is owned by MANAGER_MEMBER_ID)
    callRpc('Carpool/AssignSeat', {
      guild_id: GUILD_ID,
      discord_user_id: MEMBER_DISCORD_ID,
      car_id: CAR_ID_1,
      target_discord_user_id: MANAGER_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('CarpoolNotCarOwner');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('unknown guild_id → CarpoolGuildNotFound', () =>
    callRpc('Carpool/AssignSeat', {
      guild_id: UNKNOWN_GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      car_id: CAR_ID_1,
      target_discord_user_id: MEMBER_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('CarpoolGuildNotFound');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

describe('Carpool/LeaveSeat RPC', () => {
  itEffect.effect('member leaves seat → calls repo with correct ids', () =>
    callRpc('Carpool/LeaveSeat', {
      guild_id: GUILD_ID,
      discord_user_id: MEMBER_DISCORD_ID,
      car_id: CAR_ID_1,
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(leaveSeatCalls).toHaveLength(1);
          expect(leaveSeatCalls[0].teamMemberId).toBe(MEMBER_MEMBER_ID);
          expect(leaveSeatCalls[0].carId).toBe(CAR_ID_1);
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('non-member → CarpoolNotMember', () =>
    callRpc('Carpool/LeaveSeat', {
      guild_id: GUILD_ID,
      discord_user_id: NON_MEMBER_DISCORD_ID,
      car_id: CAR_ID_1,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('CarpoolNotMember');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

describe('Carpool/RemoveCar RPC', () => {
  itEffect.effect('owner removes own car → repo receives correct ownerTeamMemberId', () =>
    callRpc('Carpool/RemoveCar', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      car_id: CAR_ID_1,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toBeInstanceOf(CarpoolRpcModels.RemoveCarResult);
          expect(removeCarCalls).toHaveLength(1);
          expect(removeCarCalls[0].ownerTeamMemberId).toBe(MANAGER_MEMBER_ID);
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('non-owner → CarpoolNotCarOwner propagated from repo', () =>
    // CAR_ID_NON_OWNER is owned by MEMBER_MEMBER_ID; MANAGER tries to remove it
    callRpc('Carpool/RemoveCar', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      car_id: CAR_ID_NON_OWNER,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('CarpoolNotCarOwner');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('non-member → CarpoolNotMember', () =>
    callRpc('Carpool/RemoveCar', {
      guild_id: GUILD_ID,
      discord_user_id: NON_MEMBER_DISCORD_ID,
      car_id: CAR_ID_1,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('CarpoolNotMember');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

describe('Carpool RPC — mutation returns post-commit view', () => {
  itEffect.effect('AddCar result view includes the just-added car (proves committed read)', () =>
    callRpc('Carpool/AddCar', {
      guild_id: GUILD_ID,
      discord_user_id: MANAGER_DISCORD_ID,
      carpool_id: CARPOOL_ID,
      capacity: 4,
      note: Option.none(),
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toBeInstanceOf(CarpoolRpcModels.AddCarResult);
          // The view is returned after the transaction commits
          expect(result.view).toBeInstanceOf(CarpoolRpcModels.CarpoolView);
          // The car we just added should appear in the view
          expect(
            result.view.cars.some((c: CarpoolRpcModels.CarpoolCarView) => c.car_id === CAR_ID_1),
          ).toBe(true);
        }),
      ),
      Effect.asVoid,
    ),
  );
});
