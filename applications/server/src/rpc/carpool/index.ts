import {
  type Carpool,
  CarpoolRpcGroup,
  CarpoolRpcModels,
  type Discord,
  type Event,
  type Team,
} from '@sideline/domain';
import { Bind, LogicError } from '@sideline/effect-lib';
import { Effect, Option } from 'effect';
import { CarpoolsRepository } from '~/repositories/CarpoolsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const resolveTeamByGuild = (guildId: Discord.Snowflake) =>
  TeamsRepository.asEffect().pipe(
    Effect.flatMap((teams) => teams.findByGuildId(guildId)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new CarpoolRpcModels.CarpoolGuildNotFound()),
        onSome: Effect.succeed,
      }),
    ),
  );

const resolveMember = (discordId: Discord.Snowflake, teamId: Team.TeamId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.flatMap((members) => members.findMembershipByDiscordAndTeam(discordId, teamId)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new CarpoolRpcModels.CarpoolNotMember()),
        onSome: Effect.succeed,
      }),
    ),
  );

const requireCarpoolView = (
  carpoolId: Carpool.CarpoolId,
  findCarpoolView: (
    id: Carpool.CarpoolId,
  ) => Effect.Effect<Option.Option<CarpoolRpcModels.CarpoolView>>,
) =>
  findCarpoolView(carpoolId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => LogicError.die('Carpool not found after successful mutation'),
        onSome: Effect.succeed,
      }),
    ),
  );

// ---------------------------------------------------------------------------
// RPC handlers
// ---------------------------------------------------------------------------

const rpcHandlers = Effect.Do.pipe(
  Effect.bind('carpools', () => CarpoolsRepository.asEffect()),
  Effect.let(
    'Carpool/CreateCarpool',
    ({ carpools }) =>
      ({
        guild_id,
        discord_user_id,
        discord_channel_id,
        event_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly discord_channel_id: Discord.Snowflake;
        readonly event_id: Option.Option<Event.EventId>;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () => resolveTeamByGuild(guild_id)),
          Effect.bind('membership', ({ team }) => resolveMember(discord_user_id, team.id)),
          Effect.tap(({ membership }) =>
            membership.permissions.includes('carpool:manage')
              ? Effect.void
              : Effect.fail(new CarpoolRpcModels.CarpoolForbidden()),
          ),
          Effect.bind('carpool', ({ team, membership }) =>
            carpools.createCarpool({
              teamId: team.id,
              eventId: event_id,
              guildId: guild_id,
              channelId: discord_channel_id,
              createdBy: membership.id,
            }),
          ),
          Effect.flatMap(({ carpool }) => requireCarpoolView(carpool.id, carpools.findCarpoolView)),
        ),
  ),
  Effect.let(
    'Carpool/SaveCarThreadId',
    ({ carpools }) =>
      ({
        car_id,
        thread_id,
      }: {
        readonly car_id: Carpool.CarpoolCarId;
        readonly thread_id: Discord.Snowflake;
      }) =>
        carpools.saveCarThreadId(car_id, thread_id),
  ),
  Effect.let(
    'Carpool/SaveCarpoolMessageId',
    ({ carpools }) =>
      ({
        carpool_id,
        discord_message_id,
      }: {
        readonly carpool_id: Carpool.CarpoolId;
        readonly discord_message_id: Discord.Snowflake;
      }) =>
        carpools.saveMessageId(carpool_id, discord_message_id),
  ),
  Effect.let(
    'Carpool/GetCarpoolView',
    ({ carpools }) =>
      ({ carpool_id }: { readonly carpool_id: Carpool.CarpoolId }) =>
        carpools.findCarpoolView(carpool_id),
  ),
  Effect.let(
    'Carpool/AddCar',
    ({ carpools }) =>
      ({
        guild_id,
        discord_user_id,
        carpool_id,
        capacity,
        note,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly carpool_id: Carpool.CarpoolId;
        readonly capacity: number;
        readonly note: Option.Option<string>;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () => resolveTeamByGuild(guild_id)),
          Effect.bind('membership', ({ team }) => resolveMember(discord_user_id, team.id)),
          Effect.bind('addResult', ({ membership }) =>
            carpools.addCar({
              carpoolId: carpool_id,
              ownerTeamMemberId: membership.id,
              capacity,
              note,
            }),
          ),
          Effect.map(
            ({ addResult }) =>
              new CarpoolRpcModels.AddCarResult({
                car_id: addResult.car_id,
                view: addResult.view,
              }),
          ),
        ),
  ),
  Effect.let(
    'Carpool/ReserveSeat',
    ({ carpools }) =>
      ({
        guild_id,
        discord_user_id,
        car_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly car_id: Carpool.CarpoolCarId;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () => resolveTeamByGuild(guild_id)),
          Effect.bind('membership', ({ team }) => resolveMember(discord_user_id, team.id)),
          Effect.tap(({ membership }) =>
            carpools.reserveSeat({
              carId: car_id,
              teamMemberId: membership.id,
              assignedBy: Option.none(),
            }),
          ),
          Effect.bind('car', () =>
            carpools.findCarById(car_id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new CarpoolRpcModels.CarpoolCarNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.bind('view', ({ car }) =>
            requireCarpoolView(car.carpool_id, carpools.findCarpoolView),
          ),
          Effect.map(
            ({ car, view }) =>
              new CarpoolRpcModels.ReserveResult({
                thread_id: car.thread_id,
                view,
              }),
          ),
        ),
  ),
  Effect.let(
    'Carpool/AssignSeat',
    ({ carpools }) =>
      ({
        guild_id,
        discord_user_id,
        car_id,
        target_discord_user_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly car_id: Carpool.CarpoolCarId;
        readonly target_discord_user_id: Discord.Snowflake;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () => resolveTeamByGuild(guild_id)),
          Effect.bind('callerMembership', ({ team }) => resolveMember(discord_user_id, team.id)),
          Effect.bind('car', () =>
            carpools.findCarById(car_id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new CarpoolRpcModels.CarpoolCarNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.tap(({ callerMembership, car }) =>
            callerMembership.id !== car.owner_team_member_id
              ? Effect.fail(new CarpoolRpcModels.CarpoolNotCarOwner())
              : Effect.void,
          ),
          Effect.bind('targetMembership', ({ team }) =>
            resolveMember(target_discord_user_id, team.id).pipe(
              Effect.catchTag('CarpoolNotMember', () =>
                Effect.fail(new CarpoolRpcModels.CarpoolTargetNotMember()),
              ),
            ),
          ),
          Effect.tap(({ targetMembership, callerMembership }) =>
            carpools.reserveSeat({
              carId: car_id,
              teamMemberId: targetMembership.id,
              assignedBy: Option.some(callerMembership.id),
            }),
          ),
          Effect.bind('view', ({ car }) =>
            requireCarpoolView(car.carpool_id, carpools.findCarpoolView),
          ),
          Effect.map(
            ({ car, view }) =>
              new CarpoolRpcModels.ReserveResult({
                thread_id: car.thread_id,
                view,
              }),
          ),
        ),
  ),
  Effect.let(
    'Carpool/LeaveSeat',
    ({ carpools }) =>
      ({
        guild_id,
        discord_user_id,
        car_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly car_id: Carpool.CarpoolCarId;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () => resolveTeamByGuild(guild_id)),
          Effect.bind('membership', ({ team }) => resolveMember(discord_user_id, team.id)),
          Effect.bind('car', () =>
            carpools.findCarById(car_id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new CarpoolRpcModels.CarpoolCarNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.tap(({ membership }) =>
            carpools.leaveSeat({
              carId: car_id,
              teamMemberId: membership.id,
            }),
          ),
          Effect.flatMap(({ car }) => requireCarpoolView(car.carpool_id, carpools.findCarpoolView)),
        ),
  ),
  Effect.let(
    'Carpool/LeaveCarpool',
    ({ carpools }) =>
      ({
        guild_id,
        discord_user_id,
        carpool_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly carpool_id: Carpool.CarpoolId;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () => resolveTeamByGuild(guild_id)),
          Effect.bind('membership', ({ team }) => resolveMember(discord_user_id, team.id)),
          Effect.bind('car_id', ({ membership }) =>
            carpools.leaveSeatByCarpool({
              carpoolId: carpool_id,
              teamMemberId: membership.id,
            }),
          ),
          Effect.bind('view', () => requireCarpoolView(carpool_id, carpools.findCarpoolView)),
          Effect.map(
            ({ car_id, view }) =>
              new CarpoolRpcModels.LeaveCarpoolResult({
                car_id,
                view,
              }),
          ),
        ),
  ),
  Effect.let(
    'Carpool/RemoveCar',
    ({ carpools }) =>
      ({
        guild_id,
        discord_user_id,
        car_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly car_id: Carpool.CarpoolCarId;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () => resolveTeamByGuild(guild_id)),
          Effect.bind('membership', ({ team }) => resolveMember(discord_user_id, team.id)),
          Effect.bind('car', () =>
            carpools.findCarById(car_id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new CarpoolRpcModels.CarpoolCarNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.bind('removeResult', ({ membership }) =>
            carpools.removeCar({
              carId: car_id,
              ownerTeamMemberId: membership.id,
            }),
          ),
          Effect.bind('view', ({ car }) =>
            requireCarpoolView(car.carpool_id, carpools.findCarpoolView),
          ),
          Effect.map(
            ({ removeResult, view }) =>
              new CarpoolRpcModels.RemoveCarResult({
                thread_id: removeResult.thread_id,
                view,
              }),
          ),
        ),
  ),
  Bind.remove('carpools'),
  (handlers) => CarpoolRpcGroup.CarpoolRpcGroup.toLayer(handlers),
);

export const CarpoolsRpcLive = rpcHandlers;
