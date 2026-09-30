import {
  type Discord,
  type MembershipPlan,
  MembershipRpcGroup,
  MembershipRpcModels,
  type Team,
  type TeamMember,
} from '@sideline/domain';
import { Array, DateTime, Effect, Option } from 'effect';
import { MembershipPlansRepository } from '~/repositories/MembershipPlansRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';

// Same two resolvers as `rpc/poll/index.ts` — a bot RPC has no session, so the guild and the
// Discord user id ARE the credentials.
const resolveTeamByGuild = (guildId: Discord.Snowflake) =>
  TeamsRepository.asEffect().pipe(
    Effect.flatMap((teams) => teams.findByGuildId(guildId)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new MembershipRpcModels.MembershipGuildNotFound()),
        onSome: Effect.succeed,
      }),
    ),
  );

const resolveMember = (discordId: Discord.Snowflake, teamId: Team.TeamId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.flatMap((members) => members.findMembershipByDiscordAndTeam(discordId, teamId)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new MembershipRpcModels.MembershipNotMember()),
        onSome: Effect.succeed,
      }),
    ),
  );

// `finance:manage_fees` and nothing weaker, matching `api/membership-plan.ts` — `finance:view` is
// held by every Captain AND Treasurer, and posting the fee board is a pricing act.
const MANAGE_PERMISSION = 'finance:manage_fees';

// The explicit `new` is REQUIRED — `Schema.Class` is nominal, so a repo row type-checks here and
// then dies at encode. `scripts/check-rpc-encoding.mjs` enforces it on the `success:` schema.
const toPlanView = (row: {
  readonly id: MembershipPlan.MembershipPlanId;
  readonly name: MembershipRpcModels.MembershipPlanView['name'];
  readonly price_minor: MembershipRpcModels.MembershipPlanView['price_minor'];
  readonly currency: MembershipRpcModels.MembershipPlanView['currency'];
  readonly price_per_training_minor: MembershipRpcModels.MembershipPlanView['price_per_training_minor'];
  readonly free_trainings_included: MembershipRpcModels.MembershipPlanView['free_trainings_included'];
  readonly is_default: boolean;
}) =>
  new MembershipRpcModels.MembershipPlanView({
    plan_id: row.id,
    name: row.name,
    price_minor: row.price_minor,
    currency: row.currency,
    price_per_training_minor: row.price_per_training_minor,
    free_trainings_included: row.free_trainings_included,
    is_default: row.is_default,
  });

// One read shape for every handler: the picker, the board and the post-write reply all render
// from this, so none of them can drift out of sync with the others.
const buildView = (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId, canManage: boolean) =>
  Effect.Do.pipe(
    Effect.bind('plans', () => MembershipPlansRepository.asEffect()),
    Effect.bind('list', ({ plans }) => plans.findMembershipPlansByTeamId(teamId)),
    Effect.bind('selection', ({ plans }) => plans.findMemberSelection(memberId, teamId)),
    Effect.map(
      ({ list, selection }) =>
        new MembershipRpcModels.MembershipSelectionView({
          plans: Array.map(list, toPlanView),
          selected_plan_id: Option.flatMap(selection, (row) => row.membership_plan_id),
          deadline: Option.flatMap(selection, (row) => row.membership_selection_deadline),
          can_manage: canManage,
        }),
    ),
  );

const rpcHandlers = Effect.Do.pipe(
  Effect.let(
    'Membership/GetMembershipSelection',
    () =>
      ({
        guild_id,
        discord_user_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () => resolveTeamByGuild(guild_id)),
          Effect.bind('membership', ({ team }) => resolveMember(discord_user_id, team.id)),
          Effect.flatMap(({ team, membership }) =>
            buildView(team.id, membership.id, membership.permissions.includes(MANAGE_PERMISSION)),
          ),
        ),
  ),
  Effect.let(
    'Membership/SelectMembershipPlan',
    () =>
      ({
        guild_id,
        discord_user_id,
        plan_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly plan_id: MembershipPlan.MembershipPlanId;
      }) =>
        Effect.Do.pipe(
          Effect.bind('plans', () => MembershipPlansRepository.asEffect()),
          Effect.bind('team', () => resolveTeamByGuild(guild_id)),
          Effect.bind('membership', ({ team }) => resolveMember(discord_user_id, team.id)),
          // The SAME repository call the HTTP `selectMembershipPlan` handler uses, deadline guard
          // and all — that guard lives inside the UPDATE's own WHERE, so the bot cannot bypass
          // the deadline even by accident and the two surfaces can never disagree.
          Effect.bind('rowsAffected', ({ plans, team, membership }) =>
            plans.selectMembershipPlan({
              member_id: membership.id,
              team_id: team.id,
              plan_id,
            }),
          ),
          // 0 rows = the UPDATE's combined guard result. Re-read ONCE only to pick the better
          // error tag, exactly as `api/membership-plan.ts` does; best-effort under concurrency,
          // and it can never produce a wrong WRITE.
          Effect.tap(({ plans, team, membership, rowsAffected }) =>
            rowsAffected === 0
              ? plans.findMemberSelection(membership.id, team.id).pipe(
                  Effect.flatMap(
                    (
                      selection,
                    ): Effect.Effect<
                      never,
                      | MembershipRpcModels.MembershipNotMember
                      | MembershipRpcModels.MembershipPlanUnavailable
                      | MembershipRpcModels.MembershipSelectionLocked
                    > =>
                      Option.match(selection, {
                        onNone: () => Effect.fail(new MembershipRpcModels.MembershipNotMember()),
                        onSome: (row) =>
                          Option.isSome(row.membership_selection_deadline) &&
                          DateTime.isLessThanOrEqualTo(
                            row.membership_selection_deadline.value,
                            DateTime.nowUnsafe(),
                          )
                            ? Effect.fail(new MembershipRpcModels.MembershipSelectionLocked())
                            : Effect.fail(new MembershipRpcModels.MembershipPlanUnavailable()),
                      }),
                  ),
                )
              : Effect.void,
          ),
          Effect.flatMap(({ team, membership }) =>
            buildView(team.id, membership.id, membership.permissions.includes(MANAGE_PERMISSION)),
          ),
        ),
  ),
  (handlers) => MembershipRpcGroup.MembershipRpcGroup.toLayer(handlers),
);

export const MembershipRpcLive = rpcHandlers;
