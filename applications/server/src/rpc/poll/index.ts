import { type Discord, type Poll, PollRpcGroup, PollRpcModels, type Team } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { Effect, Option } from 'effect';
import { PollsRepository } from '~/repositories/PollsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const resolveTeamByGuild = (guildId: Discord.Snowflake) =>
  TeamsRepository.asEffect().pipe(
    Effect.flatMap((teams) => teams.findByGuildId(guildId)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new PollRpcModels.PollGuildNotFound()),
        onSome: Effect.succeed,
      }),
    ),
  );

const resolveMember = (discordId: Discord.Snowflake, teamId: Team.TeamId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.flatMap((members) => members.findMembershipByDiscordAndTeam(discordId, teamId)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new PollRpcModels.PollNotMember()),
        onSome: Effect.succeed,
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Pure validators
// ---------------------------------------------------------------------------

const parseOptions = (
  raw: string,
): Effect.Effect<
  string[],
  | PollRpcModels.PollTooFewOptions
  | PollRpcModels.PollTooManyOptions
  | PollRpcModels.PollOptionTooLong
  | PollRpcModels.PollDuplicateOption
> => {
  const items = raw
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (items.length < 2) return Effect.fail(new PollRpcModels.PollTooFewOptions());
  if (items.length > 10) return Effect.fail(new PollRpcModels.PollTooManyOptions());

  for (const label of items) {
    if (label.length > 80) return Effect.fail(new PollRpcModels.PollOptionTooLong());
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  let hadDuplicate = false;
  for (const label of items) {
    const lower = label.toLowerCase();
    if (seen.has(lower)) {
      hadDuplicate = true;
    } else {
      seen.add(lower);
      deduped.push(label);
    }
  }

  if (hadDuplicate) return Effect.fail(new PollRpcModels.PollDuplicateOption());

  return Effect.succeed(deduped);
};

const parseDeadline = (
  raw: string,
): Effect.Effect<
  { y: number; mo: number; d: number; h: number; mi: number },
  PollRpcModels.PollInvalidDeadline
> => {
  const match = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!match) return Effect.fail(new PollRpcModels.PollInvalidDeadline());
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr] = match;
  const y = Number.parseInt(yearStr, 10);
  const mo = Number.parseInt(monthStr, 10);
  const d = Number.parseInt(dayStr, 10);
  const h = Number.parseInt(hourStr, 10);
  const mi = Number.parseInt(minuteStr, 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) {
    return Effect.fail(new PollRpcModels.PollInvalidDeadline());
  }
  // Validate the calendar date is real — catch cases like Feb 31 that pass the range checks
  // but would cause make_timestamp() to either error or silently overflow in Postgres.
  const dateCheck = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  if (
    dateCheck.getUTCFullYear() !== y ||
    dateCheck.getUTCMonth() + 1 !== mo ||
    dateCheck.getUTCDate() !== d ||
    dateCheck.getUTCHours() !== h ||
    dateCheck.getUTCMinutes() !== mi
  ) {
    return Effect.fail(new PollRpcModels.PollInvalidDeadline());
  }
  return Effect.succeed({ y, mo, d, h, mi });
};

// ---------------------------------------------------------------------------
// RPC handlers
// ---------------------------------------------------------------------------

const rpcHandlers = Effect.Do.pipe(
  Effect.bind('polls', () => PollsRepository.asEffect()),
  Effect.let(
    'Poll/CreatePoll',
    ({ polls }) =>
      ({
        guild_id,
        discord_user_id,
        discord_channel_id,
        question,
        options_raw,
        multiple,
        allowed_role_id,
        deadline_raw,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly discord_channel_id: Discord.Snowflake;
        readonly question: string;
        readonly options_raw: string;
        readonly multiple: boolean;
        readonly allowed_role_id: Option.Option<Discord.Snowflake>;
        readonly deadline_raw: Option.Option<string>;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () => resolveTeamByGuild(guild_id)),
          Effect.bind('membership', ({ team }) => resolveMember(discord_user_id, team.id)),
          Effect.tap(({ membership }) =>
            membership.permissions.includes('poll:manage')
              ? Effect.void
              : Effect.fail(new PollRpcModels.PollForbidden()),
          ),
          Effect.bind('options', () => parseOptions(options_raw)),
          Effect.bind('deadline', () =>
            Option.isNone(deadline_raw)
              ? Effect.succeed(
                  Option.none<{ y: number; mo: number; d: number; h: number; mi: number }>(),
                )
              : parseDeadline(deadline_raw.value).pipe(Effect.map(Option.some)),
          ),
          Effect.bind('timezone', ({ team }) =>
            TeamSettingsRepository.asEffect().pipe(
              Effect.flatMap((settings) => settings.findByTeamId(team.id)),
              Effect.map(
                Option.match({
                  onNone: () => 'Europe/Prague',
                  onSome: (s) => s.timezone,
                }),
              ),
            ),
          ),
          Effect.flatMap(({ team, membership, options, deadline, timezone }) =>
            polls.createPoll({
              teamId: team.id,
              guildId: guild_id,
              channelId: discord_channel_id,
              question,
              options,
              multiple,
              allowedRoleId: allowed_role_id,
              deadline,
              timezone,
              createdBy: membership.id,
            }),
          ),
        ),
  ),
  Effect.let(
    'Poll/SavePollMessageId',
    ({ polls }) =>
      ({
        guild_id,
        poll_id,
        discord_message_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly poll_id: Poll.PollId;
        readonly discord_message_id: Discord.Snowflake;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () => resolveTeamByGuild(guild_id)),
          Effect.flatMap(({ team }) => polls.saveMessageId(poll_id, discord_message_id, team.id)),
        ),
  ),
  Effect.let(
    'Poll/CastVote',
    ({ polls }) =>
      ({
        guild_id,
        discord_user_id,
        poll_id,
        option_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly poll_id: Poll.PollId;
        readonly option_id: Poll.PollOptionId;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () => resolveTeamByGuild(guild_id)),
          Effect.bind('membership', ({ team }) => resolveMember(discord_user_id, team.id)),
          Effect.bind('result', ({ team, membership }) =>
            polls.castVote({
              pollId: poll_id,
              optionId: option_id,
              teamMemberId: membership.id,
              teamId: team.id,
            }),
          ),
          Effect.map(
            ({ result }) =>
              new PollRpcModels.CastVoteResult({
                view: result.view,
                my_option_ids: result.my_option_ids,
                action: result.action,
              }),
          ),
        ),
  ),
  Effect.let(
    'Poll/AddOption',
    ({ polls }) =>
      ({
        guild_id,
        discord_user_id,
        poll_id,
        label,
        member_role_ids,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly poll_id: Poll.PollId;
        readonly label: string;
        readonly member_role_ids: ReadonlyArray<Discord.Snowflake>;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () => resolveTeamByGuild(guild_id)),
          Effect.bind('membership', ({ team }) => resolveMember(discord_user_id, team.id)),
          Effect.bind('result', ({ team, membership }) =>
            polls.addOption({
              pollId: poll_id,
              label,
              teamMemberId: membership.id,
              memberRoleIds: member_role_ids,
              teamId: team.id,
              // Managers (poll:manage) and the poll creator bypass the allowed_role_id gate.
              // This prevents a deleted Discord role from permanently locking add-option.
              // NOTE: created_by check is done at the repo level via this flag; the poll
              // creator's TeamMemberId is not available here without an extra query, so we
              // grant the bypass to anyone with poll:manage permission (captains/admins).
              isManagerOrCreator: membership.permissions.includes('poll:manage'),
            }),
          ),
          Effect.map(
            ({ result }) =>
              new PollRpcModels.AddOptionResult({
                option_id: result.option_id,
                view: result.view,
              }),
          ),
        ),
  ),
  Effect.let(
    'Poll/ClosePoll',
    ({ polls }) =>
      ({
        guild_id,
        discord_user_id,
        poll_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly poll_id: Poll.PollId;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () => resolveTeamByGuild(guild_id)),
          Effect.bind('membership', ({ team }) => resolveMember(discord_user_id, team.id)),
          Effect.tap(({ membership }) =>
            membership.permissions.includes('poll:manage')
              ? Effect.void
              : Effect.fail(new PollRpcModels.PollForbidden()),
          ),
          Effect.flatMap(({ team }) => polls.closePoll({ pollId: poll_id, teamId: team.id })),
        ),
  ),
  Effect.let(
    'Poll/GetPollView',
    ({ polls }) =>
      ({
        guild_id,
        discord_user_id,
        poll_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly poll_id: Poll.PollId;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () => resolveTeamByGuild(guild_id)),
          Effect.bind('membership', ({ team }) => resolveMember(discord_user_id, team.id)),
          Effect.flatMap(({ team, membership }) =>
            polls.findPollView(poll_id, Option.some(membership.id), Option.some(team.id)),
          ),
        ),
  ),
  Effect.let(
    'Poll/GetPollVoters',
    ({ polls }) =>
      ({
        guild_id,
        discord_user_id,
        poll_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly poll_id: Poll.PollId;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () => resolveTeamByGuild(guild_id)),
          Effect.tap(({ team }) => resolveMember(discord_user_id, team.id)),
          Effect.flatMap(({ team }) => polls.findPollVoters(poll_id, team.id)),
        ),
  ),
  Bind.remove('polls'),
  (handlers) => PollRpcGroup.PollRpcGroup.toLayer(handlers),
);

export const PollsRpcLive = rpcHandlers;
