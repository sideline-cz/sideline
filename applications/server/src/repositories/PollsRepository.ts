import { Discord, Poll, PollRpcModels, Team, TeamMember } from '@sideline/domain';
import { LogicError, Schemas, SqlErrors } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

class PollLockRow extends Schema.Class<PollLockRow>('PollLockRow')({
  id: Poll.PollId,
  status: Poll.PollStatus,
  deadline: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  multiple: Schema.Boolean,
  allowed_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

class PollViewRow extends Schema.Class<PollViewRow>('PollViewRow')({
  poll_id: Poll.PollId,
  discord_channel_id: Discord.Snowflake,
  discord_message_id: Schema.OptionFromNullOr(Discord.Snowflake),
  question: Schema.String,
  status: Poll.PollStatus,
  multiple: Schema.Boolean,
  allowed_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
  deadline: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  total_votes: Schema.Number,
  option_id: Schema.OptionFromNullOr(Poll.PollOptionId),
  label: Schema.OptionFromNullOr(Schema.String),
  position: Schema.OptionFromNullOr(Schema.Number),
  vote_count: Schema.OptionFromNullOr(Schema.Number),
  my_option_ids: Schema.OptionFromNullOr(Schema.Array(Poll.PollOptionId)),
}) {}

class VoteRow extends Schema.Class<VoteRow>('VoteRow')({
  id: Poll.PollVoteId,
  option_id: Poll.PollOptionId,
}) {}

class MyVoteRow extends Schema.Class<MyVoteRow>('MyVoteRow')({
  option_id: Poll.PollOptionId,
}) {}

class OptionBelongsRow extends Schema.Class<OptionBelongsRow>('OptionBelongsRow')({
  id: Poll.PollOptionId,
}) {}

class InsertedOptionRow extends Schema.Class<InsertedOptionRow>('InsertedOptionRow')({
  id: Poll.PollOptionId,
}) {}

class OptionCountRow extends Schema.Class<OptionCountRow>('OptionCountRow')({
  count: Schema.Number,
}) {}

class ExistingOptionRow extends Schema.Class<ExistingOptionRow>('ExistingOptionRow')({
  id: Poll.PollOptionId,
}) {}

class PollIdRow extends Schema.Class<PollIdRow>('PollIdRow')({
  id: Poll.PollId,
}) {}

// ---------------------------------------------------------------------------
// View builder
// ---------------------------------------------------------------------------

const buildPollView = (
  rows: ReadonlyArray<PollViewRow>,
  viewerOptionIds: ReadonlyArray<Poll.PollOptionId>,
): Effect.Effect<PollRpcModels.PollView> => {
  const firstRow = rows[0];
  if (firstRow === undefined) {
    return LogicError.die('poll view has no rows but buildPollView was called');
  }

  const options: PollRpcModels.PollOptionView[] = [];
  for (const row of rows) {
    if (Option.isNone(row.option_id)) continue;
    options.push(
      new PollRpcModels.PollOptionView({
        option_id: row.option_id.value,
        label: Option.getOrElse(row.label, () => ''),
        position: Option.getOrElse(row.position, () => 0),
        vote_count: Option.getOrElse(row.vote_count, () => 0),
      }),
    );
  }

  options.sort((a, b) => a.position - b.position);

  return Effect.succeed(
    new PollRpcModels.PollView({
      poll_id: firstRow.poll_id,
      discord_channel_id: firstRow.discord_channel_id,
      discord_message_id: firstRow.discord_message_id,
      question: firstRow.question,
      status: firstRow.status,
      multiple: firstRow.multiple,
      allowed_role_id: firstRow.allowed_role_id,
      deadline: firstRow.deadline,
      total_votes: firstRow.total_votes,
      options,
      my_option_ids: viewerOptionIds,
    }),
  );
};

/**
 * Build a PollView from view rows that must exist (post-mutation reads). Dies with the given
 * context if the poll resolved to no rows, and derives viewer option ids from the first row.
 */
const buildPollViewOrDie = (
  rows: ReadonlyArray<PollViewRow>,
  dieContext: string,
): Effect.Effect<PollRpcModels.PollView> => {
  const firstRow = rows[0];
  if (firstRow === undefined) return LogicError.die(dieContext);
  const viewerOptionIds: Poll.PollOptionId[] = Option.isSome(firstRow.my_option_ids)
    ? [...firstRow.my_option_ids.value]
    : [];
  return buildPollView(rows, viewerOptionIds);
};

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // ---- findPollViewRows ----

  const findPollViewRowsQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      poll_id: Poll.PollId,
      viewer_id: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
      team_id: Schema.OptionFromNullOr(Team.TeamId),
    }),
    Result: PollViewRow,
    execute: (input) => sql`
      SELECT
        p.id AS poll_id,
        p.discord_channel_id,
        p.discord_message_id,
        p.question,
        p.status,
        p.multiple,
        p.allowed_role_id,
        p.deadline,
        COUNT(DISTINCT pv_total.team_member_id)::int AS total_votes,
        po.id AS option_id,
        po.label,
        po.position,
        COUNT(DISTINCT pv_opt.id)::int AS vote_count,
        CASE
          WHEN ${input.viewer_id}::uuid IS NULL THEN NULL
          ELSE (
            SELECT array_agg(pv_my.option_id::text ORDER BY pv_my.created_at)
            FROM poll_votes pv_my
            WHERE pv_my.poll_id = p.id
              AND pv_my.team_member_id = ${input.viewer_id}::uuid
          )
        END AS my_option_ids
      FROM polls p
      LEFT JOIN poll_options po ON po.poll_id = p.id
      LEFT JOIN poll_votes pv_total ON pv_total.poll_id = p.id
      LEFT JOIN poll_votes pv_opt ON pv_opt.option_id = po.id
      WHERE p.id = ${input.poll_id}
        AND (${input.team_id}::uuid IS NULL OR p.team_id = ${input.team_id}::uuid)
      GROUP BY p.id, po.id
      ORDER BY po.position ASC NULLS LAST
    `,
  });

  // ---- findPollView ----

  const findPollView = (
    pollId: Poll.PollId,
    viewer: Option.Option<TeamMember.TeamMemberId>,
    teamId: Option.Option<Team.TeamId> = Option.none(),
  ) =>
    findPollViewRowsQuery({ poll_id: pollId, viewer_id: viewer, team_id: teamId }).pipe(
      catchSqlErrors,
      Effect.flatMap((rows) => {
        if (rows.length === 0) return Effect.succeed(Option.none<PollRpcModels.PollView>());
        const firstRow = rows[0];
        if (firstRow === undefined) return Effect.succeed(Option.none<PollRpcModels.PollView>());
        const viewerOptionIds: Poll.PollOptionId[] =
          Option.isSome(viewer) && Option.isSome(firstRow.my_option_ids)
            ? [...firstRow.my_option_ids.value]
            : [];
        return buildPollView(rows, viewerOptionIds).pipe(Effect.map(Option.some));
      }),
    );

  // ---- lockPollQuery / readPollQuery ----

  // FOR UPDATE: used by addOption to atomically check status and prevent concurrent races.
  // team_id scoping ensures a poll from another team resolves to None → PollNotFound.
  const lockPollQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({ poll_id: Poll.PollId, team_id: Team.TeamId }),
    Result: PollLockRow,
    execute: (input) =>
      sql`SELECT id, status, deadline, multiple, allowed_role_id FROM polls WHERE id = ${input.poll_id} AND team_id = ${input.team_id} FOR UPDATE`,
  });

  // ---- saveMessageId ----

  const saveMessageIdQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      poll_id: Poll.PollId,
      team_id: Team.TeamId,
      message_id: Discord.Snowflake,
    }),
    Result: PollIdRow,
    execute: (input) => sql`
      UPDATE polls SET discord_message_id = ${input.message_id}, updated_at = now()
      WHERE id = ${input.poll_id} AND team_id = ${input.team_id}
      RETURNING id
    `,
  });

  const saveMessageId = (pollId: Poll.PollId, messageId: Discord.Snowflake, teamId: Team.TeamId) =>
    saveMessageIdQuery({ poll_id: pollId, team_id: teamId, message_id: messageId }).pipe(
      catchSqlErrors,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new PollRpcModels.PollNotFound()),
          onSome: () => Effect.void,
        }),
      ),
    );

  // ---- createPoll ----

  const insertPollQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      guild_id: Discord.Snowflake,
      discord_channel_id: Discord.Snowflake,
      question: Schema.String,
      multiple: Schema.Boolean,
      allowed_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
      created_by: TeamMember.TeamMemberId,
    }),
    Result: Schema.Struct({ id: Poll.PollId }),
    execute: (input) => sql`
      INSERT INTO polls (team_id, guild_id, discord_channel_id, question, multiple, allowed_role_id, created_by)
      VALUES (${input.team_id}, ${input.guild_id}, ${input.discord_channel_id}, ${input.question}, ${input.multiple}, ${input.allowed_role_id}, ${input.created_by})
      RETURNING id
    `,
  });

  const insertPollWithDeadlineQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      guild_id: Discord.Snowflake,
      discord_channel_id: Discord.Snowflake,
      question: Schema.String,
      multiple: Schema.Boolean,
      allowed_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
      created_by: TeamMember.TeamMemberId,
      year: Schema.Number,
      month: Schema.Number,
      day: Schema.Number,
      hour: Schema.Number,
      minute: Schema.Number,
      timezone: Schema.String,
    }),
    Result: Schema.Struct({ id: Poll.PollId, deadline_past: Schema.Boolean }),
    execute: (input) => sql`
      INSERT INTO polls (team_id, guild_id, discord_channel_id, question, multiple, allowed_role_id, created_by, deadline)
      VALUES (
        ${input.team_id}, ${input.guild_id}, ${input.discord_channel_id}, ${input.question},
        ${input.multiple}, ${input.allowed_role_id}, ${input.created_by},
        (make_timestamp(${input.year}, ${input.month}, ${input.day}, ${input.hour}, ${input.minute}, 0) AT TIME ZONE ${input.timezone})
      )
      RETURNING id, (deadline < now()) AS deadline_past
    `,
  });

  const insertOptionsQuery = (
    pollId: Poll.PollId,
    createdBy: TeamMember.TeamMemberId,
    options: string[],
  ) =>
    Effect.forEach(options, (label, index) =>
      sql`
        INSERT INTO poll_options (poll_id, label, position, added_by)
        VALUES (${pollId}, ${label}, ${index}, ${createdBy})
      `.pipe(
        SqlErrors.catchUniqueViolation(() => new PollRpcModels.PollDuplicateOption()),
        catchSqlErrors,
      ),
    );

  const createPoll = (input: {
    readonly teamId: Team.TeamId;
    readonly guildId: Discord.Snowflake;
    readonly channelId: Discord.Snowflake;
    readonly question: string;
    readonly options: string[];
    readonly multiple: boolean;
    readonly allowedRoleId: Option.Option<Discord.Snowflake>;
    readonly deadline: Option.Option<{ y: number; mo: number; d: number; h: number; mi: number }>;
    readonly timezone: string;
    readonly createdBy: TeamMember.TeamMemberId;
  }) =>
    sql
      .withTransaction(
        Effect.Do.pipe(
          Effect.bind('pollRow', () => {
            if (Option.isNone(input.deadline)) {
              return insertPollQuery({
                team_id: input.teamId,
                guild_id: input.guildId,
                discord_channel_id: input.channelId,
                question: input.question,
                multiple: input.multiple,
                allowed_role_id: input.allowedRoleId,
                created_by: input.createdBy,
              }).pipe(
                catchSqlErrors,
                Effect.catchTag('NoSuchElementError', () =>
                  LogicError.die('Poll insert returned no row'),
                ),
                Effect.map((row) => row.id),
              );
            }
            const dl = input.deadline.value;
            return insertPollWithDeadlineQuery({
              team_id: input.teamId,
              guild_id: input.guildId,
              discord_channel_id: input.channelId,
              question: input.question,
              multiple: input.multiple,
              allowed_role_id: input.allowedRoleId,
              created_by: input.createdBy,
              year: dl.y,
              month: dl.mo,
              day: dl.d,
              hour: dl.h,
              minute: dl.mi,
              timezone: input.timezone,
            }).pipe(
              catchSqlErrors,
              Effect.catchTag('NoSuchElementError', () =>
                LogicError.die('Poll insert with deadline returned no row'),
              ),
              Effect.flatMap((row) =>
                row.deadline_past
                  ? Effect.fail(new PollRpcModels.PollDeadlineInPast())
                  : Effect.succeed(row.id),
              ),
            );
          }),
          Effect.tap(({ pollRow: pollId }) =>
            insertOptionsQuery(pollId, input.createdBy, input.options),
          ),
          Effect.flatMap(({ pollRow: pollId }) =>
            findPollViewRowsQuery({
              poll_id: pollId,
              viewer_id: Option.none(),
              team_id: Option.none(),
            }).pipe(
              catchSqlErrors,
              Effect.flatMap((rows) => buildPollView(rows, [])),
            ),
          ),
        ),
      )
      .pipe(catchSqlErrors);

  // ---- castVote ----

  const checkOptionBelongsQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({ poll_id: Poll.PollId, option_id: Poll.PollOptionId }),
    Result: OptionBelongsRow,
    execute: (input) =>
      sql`SELECT id FROM poll_options WHERE id = ${input.option_id} AND poll_id = ${input.poll_id}`,
  });

  // findVote query: used in multi-choice toggle logic within a FOR UPDATE transaction.
  const findVoteQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      poll_id: Poll.PollId,
      option_id: Poll.PollOptionId,
      team_member_id: TeamMember.TeamMemberId,
    }),
    Result: VoteRow,
    execute: (input) =>
      sql`SELECT id, option_id FROM poll_votes WHERE poll_id = ${input.poll_id} AND option_id = ${input.option_id} AND team_member_id = ${input.team_member_id}`,
  });

  const findMemberVotesQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      poll_id: Poll.PollId,
      team_member_id: TeamMember.TeamMemberId,
    }),
    Result: VoteRow,
    execute: (input) =>
      sql`SELECT id, option_id FROM poll_votes WHERE poll_id = ${input.poll_id} AND team_member_id = ${input.team_member_id}`,
  });

  const deleteVoteQuery = SqlSchema.void({
    Request: Poll.PollVoteId,
    execute: (voteId) => sql`DELETE FROM poll_votes WHERE id = ${voteId}`,
  });

  const deleteMemberVotesQuery = SqlSchema.void({
    Request: Schema.Struct({
      poll_id: Poll.PollId,
      team_member_id: TeamMember.TeamMemberId,
    }),
    execute: (input) =>
      sql`DELETE FROM poll_votes WHERE poll_id = ${input.poll_id} AND team_member_id = ${input.team_member_id}`,
  });

  const insertVoteQuery = SqlSchema.void({
    Request: Schema.Struct({
      poll_id: Poll.PollId,
      option_id: Poll.PollOptionId,
      team_member_id: TeamMember.TeamMemberId,
    }),
    execute: (input) =>
      sql`INSERT INTO poll_votes (poll_id, option_id, team_member_id) VALUES (${input.poll_id}, ${input.option_id}, ${input.team_member_id})`,
  });

  const getMyOptionIdsQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      poll_id: Poll.PollId,
      team_member_id: TeamMember.TeamMemberId,
    }),
    Result: MyVoteRow,
    execute: (input) =>
      sql`SELECT option_id FROM poll_votes WHERE poll_id = ${input.poll_id} AND team_member_id = ${input.team_member_id} ORDER BY created_at`,
  });

  const closePollStatusQuery = SqlSchema.findOneOption({
    Request: Poll.PollId,
    Result: PollIdRow,
    execute: (pollId) =>
      sql`UPDATE polls SET status = 'closed', updated_at = now() WHERE id = ${pollId} AND status = 'open' RETURNING id`,
  });

  const castVote = (input: {
    readonly pollId: Poll.PollId;
    readonly optionId: Poll.PollOptionId;
    readonly teamMemberId: TeamMember.TeamMemberId;
    readonly teamId: Team.TeamId;
  }) =>
    sql
      .withTransaction(
        Effect.Do.pipe(
          // Lock the poll row FOR UPDATE so that all castVote transactions on the same poll
          // are serialized. This makes toggle behavior deterministic: the second concurrent
          // identical (member, option) click will see the first transaction's insert and
          // will toggle the vote OFF rather than producing a non-deterministic outcome.
          // team_id scoping ensures cross-team IDOR attempts resolve to PollNotFound.
          Effect.bind('poll', () =>
            lockPollQuery({ poll_id: input.pollId, team_id: input.teamId }).pipe(
              catchSqlErrors,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new PollRpcModels.PollNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.tap(({ poll }) => {
            const isExpired =
              poll.status === 'closed' ||
              (Option.isSome(poll.deadline) && poll.deadline.value.epochMilliseconds < Date.now());
            if (!isExpired) return Effect.void;
            // Lazy-close: idempotent UPDATE (WHERE status='open'), then raise PollClosed
            return closePollStatusQuery(input.pollId).pipe(
              catchSqlErrors,
              Effect.flatMap(() => Effect.fail(new PollRpcModels.PollClosed())),
            );
          }),
          Effect.tap(() =>
            checkOptionBelongsQuery({ poll_id: input.pollId, option_id: input.optionId }).pipe(
              catchSqlErrors,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new PollRpcModels.PollOptionNotFound()),
                  onSome: () => Effect.void,
                }),
              ),
            ),
          ),
          Effect.bind('action', ({ poll }) => {
            if (poll.multiple) {
              // Multi-choice toggle. The FOR UPDATE lock acquired above serializes all
              // castVote transactions on this poll, so findVote always sees an accurate
              // committed state. Concurrent identical (member, option) clicks are handled
              // deterministically: the first transaction adds the vote; the second sees
              // the committed row and removes it (toggle OFF).
              return Effect.Do.pipe(
                Effect.bind('existingVote', () =>
                  findVoteQuery({
                    poll_id: input.pollId,
                    option_id: input.optionId,
                    team_member_id: input.teamMemberId,
                  }).pipe(catchSqlErrors),
                ),
                Effect.flatMap(({ existingVote }) =>
                  Option.match(existingVote, {
                    onSome: (existingVoteRow) =>
                      deleteVoteQuery(existingVoteRow.id).pipe(
                        catchSqlErrors,
                        Effect.map((): PollRpcModels.CastVoteResult['action'] => 'removed'),
                      ),
                    onNone: () =>
                      insertVoteQuery({
                        poll_id: input.pollId,
                        option_id: input.optionId,
                        team_member_id: input.teamMemberId,
                      }).pipe(
                        catchSqlErrors,
                        Effect.map((): PollRpcModels.CastVoteResult['action'] => 'added'),
                      ),
                  }),
                ),
              );
            }
            // Single-choice
            return findMemberVotesQuery({
              poll_id: input.pollId,
              team_member_id: input.teamMemberId,
            }).pipe(
              catchSqlErrors,
              Effect.flatMap((existingVotes) => {
                if (existingVotes.length === 0) {
                  // No existing vote → insert
                  return insertVoteQuery({
                    poll_id: input.pollId,
                    option_id: input.optionId,
                    team_member_id: input.teamMemberId,
                  }).pipe(
                    catchSqlErrors,
                    Effect.map((): PollRpcModels.CastVoteResult['action'] => 'counted'),
                  );
                }
                const sameOptionVote = existingVotes.find((v) => v.option_id === input.optionId);
                if (sameOptionVote !== undefined) {
                  // Same option → retract (delete all)
                  return deleteMemberVotesQuery({
                    poll_id: input.pollId,
                    team_member_id: input.teamMemberId,
                  }).pipe(
                    catchSqlErrors,
                    Effect.map((): PollRpcModels.CastVoteResult['action'] => 'retracted'),
                  );
                }
                // Different option → move (delete all + insert new)
                return deleteMemberVotesQuery({
                  poll_id: input.pollId,
                  team_member_id: input.teamMemberId,
                }).pipe(
                  catchSqlErrors,
                  Effect.flatMap(() =>
                    insertVoteQuery({
                      poll_id: input.pollId,
                      option_id: input.optionId,
                      team_member_id: input.teamMemberId,
                    }).pipe(catchSqlErrors),
                  ),
                  Effect.map((): PollRpcModels.CastVoteResult['action'] => 'moved'),
                );
              }),
            );
          }),
          Effect.bind('myOptionIds', () =>
            getMyOptionIdsQuery({
              poll_id: input.pollId,
              team_member_id: input.teamMemberId,
            }).pipe(
              catchSqlErrors,
              Effect.map((rows) => rows.map((r) => r.option_id)),
            ),
          ),
          Effect.bind('view', () =>
            findPollViewRowsQuery({
              poll_id: input.pollId,
              viewer_id: Option.some(input.teamMemberId),
              team_id: Option.none(),
            }).pipe(
              catchSqlErrors,
              Effect.flatMap((rows) => buildPollViewOrDie(rows, 'Poll not found after castVote')),
            ),
          ),
          Effect.map(({ action, myOptionIds, view }) => ({
            view,
            my_option_ids: myOptionIds,
            action,
          })),
        ),
      )
      .pipe(catchSqlErrors);

  // ---- addOption ----

  const countOptionsQuery = SqlSchema.findOne({
    Request: Poll.PollId,
    Result: OptionCountRow,
    execute: (pollId) =>
      sql`SELECT COUNT(*)::int AS count FROM poll_options WHERE poll_id = ${pollId}`,
  });

  const findExistingOptionQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({ poll_id: Poll.PollId, label: Schema.String }),
    Result: ExistingOptionRow,
    execute: (input) =>
      sql`SELECT id FROM poll_options WHERE poll_id = ${input.poll_id} AND LOWER(label) = LOWER(${input.label})`,
  });

  const insertOptionQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      poll_id: Poll.PollId,
      label: Schema.String,
      position: Schema.Number,
      added_by: TeamMember.TeamMemberId,
    }),
    Result: InsertedOptionRow,
    execute: (input) =>
      sql`
        INSERT INTO poll_options (poll_id, label, position, added_by)
        VALUES (${input.poll_id}, ${input.label}, ${input.position}, ${input.added_by})
        RETURNING id
      `,
  });

  const addOption = (input: {
    readonly pollId: Poll.PollId;
    readonly label: string;
    readonly teamMemberId: TeamMember.TeamMemberId;
    readonly memberRoleIds: ReadonlyArray<Discord.Snowflake>;
    readonly teamId: Team.TeamId;
    readonly isManagerOrCreator: boolean;
  }) =>
    sql
      .withTransaction(
        Effect.Do.pipe(
          Effect.bind('poll', () =>
            lockPollQuery({ poll_id: input.pollId, team_id: input.teamId }).pipe(
              catchSqlErrors,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new PollRpcModels.PollNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.tap(({ poll }) => {
            const isExpired =
              poll.status === 'closed' ||
              (Option.isSome(poll.deadline) && poll.deadline.value.epochMilliseconds < Date.now());
            if (!isExpired) return Effect.void;
            return closePollStatusQuery(input.pollId).pipe(
              catchSqlErrors,
              Effect.flatMap(() => Effect.fail(new PollRpcModels.PollClosed())),
            );
          }),
          Effect.tap(({ poll }) => {
            // Managers/creators bypass the role gate (fix for deleted roles permanently locking add-option)
            if (input.isManagerOrCreator) return Effect.void;
            if (Option.isNone(poll.allowed_role_id)) return Effect.void;
            const allowedRoleId = poll.allowed_role_id.value;
            const hasRole = input.memberRoleIds.includes(allowedRoleId);
            return hasRole ? Effect.void : Effect.fail(new PollRpcModels.PollAddOptionForbidden());
          }),
          Effect.bind('optionCount', () =>
            countOptionsQuery(input.pollId).pipe(
              catchSqlErrors,
              Effect.catchTag('NoSuchElementError', () =>
                LogicError.die('Option count returned no row'),
              ),
              Effect.map((r) => r.count),
            ),
          ),
          Effect.tap(({ optionCount }) =>
            optionCount >= 10
              ? Effect.fail(new PollRpcModels.PollOptionLimitReached())
              : Effect.void,
          ),
          Effect.tap(() =>
            findExistingOptionQuery({ poll_id: input.pollId, label: input.label }).pipe(
              catchSqlErrors,
              Effect.flatMap(
                Option.match({
                  onSome: () => Effect.fail(new PollRpcModels.PollDuplicateOption()),
                  onNone: () => Effect.void,
                }),
              ),
            ),
          ),
          Effect.bind('newOption', ({ optionCount }) =>
            insertOptionQuery({
              poll_id: input.pollId,
              label: input.label,
              position: optionCount,
              added_by: input.teamMemberId,
            }).pipe(
              SqlErrors.catchUniqueViolation(() => new PollRpcModels.PollDuplicateOption()),
              catchSqlErrors,
              Effect.catchTag('NoSuchElementError', () =>
                LogicError.die('Option insert returned no row'),
              ),
            ),
          ),
          Effect.bind('view', () =>
            findPollViewRowsQuery({
              poll_id: input.pollId,
              viewer_id: Option.some(input.teamMemberId),
              team_id: Option.none(),
            }).pipe(
              catchSqlErrors,
              Effect.flatMap((rows) => buildPollViewOrDie(rows, 'Poll not found after addOption')),
            ),
          ),
          Effect.map(({ newOption, view }) => ({ option_id: newOption.id, view })),
        ),
      )
      .pipe(catchSqlErrors);

  // ---- closePoll ----

  const closePollQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({ poll_id: Poll.PollId, team_id: Team.TeamId }),
    Result: PollIdRow,
    execute: (input) =>
      sql`UPDATE polls SET status = 'closed', updated_at = now() WHERE id = ${input.poll_id} AND team_id = ${input.team_id} RETURNING id`,
  });

  const closePoll = (input: { readonly pollId: Poll.PollId; readonly teamId: Team.TeamId }) =>
    Effect.Do.pipe(
      Effect.bind('result', () =>
        closePollQuery({ poll_id: input.pollId, team_id: input.teamId }).pipe(
          catchSqlErrors,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new PollRpcModels.PollNotFound()),
              onSome: Effect.succeed,
            }),
          ),
        ),
      ),
      Effect.flatMap(({ result }) =>
        findPollViewRowsQuery({
          poll_id: result.id,
          viewer_id: Option.none(),
          team_id: Option.none(),
        }).pipe(
          catchSqlErrors,
          Effect.flatMap((rows) => buildPollViewOrDie(rows, 'Poll not found after closePoll')),
        ),
      ),
    ).pipe(catchSqlErrors);

  // ---- findPollVoters ----

  class PollVoterRow extends Schema.Class<PollVoterRow>('PollVoterRow')({
    poll_id: Poll.PollId,
    question: Schema.String,
    status: Poll.PollStatus,
    total_votes: Schema.Number,
    option_id: Poll.PollOptionId,
    label: Schema.String,
    position: Schema.OptionFromNullOr(Schema.Number),
    vote_count: Schema.Number,
    // Voter columns are nullable: NULL when an option has zero votes (LEFT JOIN).
    team_member_id: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
    discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
    name: Schema.OptionFromNullOr(Schema.String),
    username: Schema.OptionFromNullOr(Schema.String),
    nickname: Schema.OptionFromNullOr(Schema.String),
    display_name: Schema.OptionFromNullOr(Schema.String),
  }) {}

  const findPollVotersQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      poll_id: Poll.PollId,
      team_id: Team.TeamId,
    }),
    Result: PollVoterRow,
    execute: (input) => sql`
      WITH
        poll_info AS (
          SELECT p.id, p.question, p.status,
                 COUNT(DISTINCT pv.team_member_id)::int AS total_votes
          FROM polls p
          LEFT JOIN poll_votes pv ON pv.poll_id = p.id
          WHERE p.id = ${input.poll_id} AND p.team_id = ${input.team_id}
          GROUP BY p.id
        ),
        option_counts AS (
          SELECT po.id AS option_id,
                 COUNT(DISTINCT pv.team_member_id)::int AS vote_count
          FROM poll_options po
          LEFT JOIN poll_votes pv ON pv.option_id = po.id
          WHERE po.poll_id = ${input.poll_id}
          GROUP BY po.id
        ),
        ranked_voters AS (
          SELECT
            pv.option_id,
            pv.team_member_id,
            MIN(pv.created_at) AS first_voted_at,
            ROW_NUMBER() OVER (
              PARTITION BY pv.option_id
              ORDER BY MIN(pv.created_at) ASC
            ) AS rn
          FROM poll_votes pv
          WHERE pv.poll_id = ${input.poll_id}
          GROUP BY pv.option_id, pv.team_member_id
        )
      SELECT
        pi.id       AS poll_id,
        pi.question,
        pi.status,
        pi.total_votes,
        po.id       AS option_id,
        po.label,
        po.position,
        oc.vote_count,
        rv.team_member_id,
        u.discord_id,
        u.name,
        u.username,
        u.discord_nickname  AS nickname,
        u.discord_display_name AS display_name
      FROM poll_info pi
      JOIN poll_options po ON po.poll_id = pi.id
      JOIN option_counts oc ON oc.option_id = po.id
      LEFT JOIN ranked_voters rv ON rv.option_id = po.id AND rv.rn <= 60
      LEFT JOIN team_members tm ON tm.id = rv.team_member_id
      LEFT JOIN users u ON u.id = tm.user_id
      ORDER BY po.position ASC NULLS LAST, rv.first_voted_at ASC NULLS LAST
    `,
  });

  const buildPollVotersView = (
    rows: ReadonlyArray<PollVoterRow>,
  ): Effect.Effect<PollRpcModels.PollVotersView> => {
    const firstRow = rows[0];
    if (firstRow === undefined) {
      return LogicError.die('poll voters view has no rows but buildPollVotersView was called');
    }

    // Group rows by option_id, preserving order (rows are already sorted by position ASC NULLS LAST).
    const optionMap = new Map<
      Poll.PollOptionId,
      {
        option_id: Poll.PollOptionId;
        label: string;
        position: number;
        vote_count: number;
        voters: PollRpcModels.PollVoter[];
      }
    >();

    for (const row of rows) {
      let entry = optionMap.get(row.option_id);
      if (entry === undefined) {
        entry = {
          option_id: row.option_id,
          label: row.label,
          position: Option.getOrElse(row.position, () => 0),
          vote_count: row.vote_count,
          voters: [],
        };
        optionMap.set(row.option_id, entry);
      }
      // Only add a voter when this row represents an actual voter (not a zero-vote LEFT JOIN null).
      if (Option.isSome(row.team_member_id)) {
        entry.voters.push(
          new PollRpcModels.PollVoter({
            discord_id: row.discord_id,
            name: row.name,
            username: row.username,
            nickname: row.nickname,
            display_name: row.display_name,
          }),
        );
      }
    }

    const options = [...optionMap.values()].map(
      (entry) =>
        new PollRpcModels.PollOptionVoters({
          option_id: entry.option_id,
          label: entry.label,
          position: entry.position,
          vote_count: entry.vote_count,
          voters: entry.voters,
        }),
    );

    return Effect.succeed(
      new PollRpcModels.PollVotersView({
        poll_id: firstRow.poll_id,
        question: firstRow.question,
        status: firstRow.status,
        total_votes: firstRow.total_votes,
        options,
      }),
    );
  };

  const findPollVoters = (pollId: Poll.PollId, teamId: Team.TeamId) =>
    findPollVotersQuery({ poll_id: pollId, team_id: teamId }).pipe(
      catchSqlErrors,
      Effect.flatMap((rows) => {
        if (rows.length === 0) return Effect.succeed(Option.none<PollRpcModels.PollVotersView>());
        return buildPollVotersView(rows).pipe(Effect.map(Option.some));
      }),
    );

  return {
    createPoll,
    saveMessageId,
    findPollView,
    castVote,
    addOption,
    closePoll,
    findPollVoters,
  };
});

export class PollsRepository extends ServiceMap.Service<
  PollsRepository,
  Effect.Success<typeof make>
>()('api/PollsRepository') {
  static readonly Default = Layer.effect(PollsRepository, make);
}
