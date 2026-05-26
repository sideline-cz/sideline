import { User } from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

const UpsertDiscordInput = Schema.Struct({
  discord_id: Schema.String,
  username: Schema.String,
  avatar: Schema.OptionFromNullOr(Schema.String),
  discord_nickname: Schema.OptionFromNullOr(Schema.String),
  discord_display_name: Schema.OptionFromNullOr(Schema.String),
});

const CompleteProfileInput = Schema.Struct({
  id: User.UserId,
  name: Schema.OptionFromNullOr(Schema.String),
  birth_date: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  gender: Schema.OptionFromNullOr(User.Gender),
});

const AdminUpdateProfileInput = Schema.Struct({
  id: User.UserId,
  name: Schema.OptionFromNullOr(Schema.String),
  birth_date: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  gender: Schema.OptionFromNullOr(User.Gender),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByDiscordIdQuery = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: User.User,
    execute: (discordId) => sql`SELECT * FROM users WHERE discord_id = ${discordId}`,
  });

  const findByDiscordId = (discordId: string) =>
    findByDiscordIdQuery(discordId).pipe(catchSqlErrors);

  const findByIdQuery = SqlSchema.findOneOption({
    Request: User.UserId,
    Result: User.User,
    execute: (id) => sql`SELECT * FROM users WHERE id = ${id}`,
  });

  const findById = (id: User.UserId) => findByIdQuery(id).pipe(catchSqlErrors);

  // First-user promotion: NOT EXISTS is evaluated before the new row is inserted,
  // so the very first user in an empty table gets is_global_admin = true. ON CONFLICT
  // deliberately omits is_global_admin so subsequent logins never demote/promote it.
  // Two simultaneous first-registrations under READ COMMITTED could both get true —
  // accepted as a negligible race on a brand-new database.
  const upsertFromDiscordQuery = SqlSchema.findOne({
    Request: UpsertDiscordInput,
    Result: User.User,
    execute: (input) => sql`
      INSERT INTO users (discord_id, username, avatar, discord_nickname, discord_display_name, is_global_admin)
      VALUES (${input.discord_id}, ${input.username}, ${input.avatar}, ${input.discord_nickname}, ${input.discord_display_name}, (NOT EXISTS (SELECT 1 FROM users)))
      ON CONFLICT (discord_id) DO UPDATE SET
        username = ${input.username},
        avatar = ${input.avatar},
        discord_nickname = ${input.discord_nickname},
        discord_display_name = ${input.discord_display_name},
        updated_at = now()
      RETURNING *
    `,
  });

  const upsertFromDiscord = (input: Schema.Schema.Type<typeof UpsertDiscordInput>) =>
    upsertFromDiscordQuery(input).pipe(catchSqlErrors);

  const completeProfileQuery = SqlSchema.findOne({
    Request: CompleteProfileInput,
    Result: User.User,
    execute: (input) => sql`
      UPDATE users SET
        name = ${input.name},
        birth_date = ${input.birth_date},
        gender = ${input.gender},
        is_profile_complete = true,
        updated_at = now()
      WHERE id = ${input.id}
      RETURNING *
    `,
  });

  const completeProfile = (input: Schema.Schema.Type<typeof CompleteProfileInput>) =>
    completeProfileQuery(input).pipe(catchSqlErrors);

  const updateLocaleQuery = SqlSchema.findOne({
    Request: Schema.Struct({ id: User.UserId, locale: User.Locale }),
    Result: User.User,
    execute: (input) => sql`
      UPDATE users SET
        locale = ${input.locale},
        updated_at = now()
      WHERE id = ${input.id}
      RETURNING *
    `,
  });

  const updateLocale = (input: { readonly id: User.UserId; readonly locale: User.Locale }) =>
    updateLocaleQuery(input).pipe(catchSqlErrors);

  const updateAdminProfileQuery = SqlSchema.findOne({
    Request: AdminUpdateProfileInput,
    Result: User.User,
    execute: (input) => sql`
      UPDATE users SET
        name = ${input.name},
        birth_date = ${input.birth_date},
        gender = ${input.gender},
        updated_at = now()
      WHERE id = ${input.id}
      RETURNING *
    `,
  });

  const updateAdminProfile = (input: Schema.Schema.Type<typeof AdminUpdateProfileInput>) =>
    updateAdminProfileQuery(input).pipe(catchSqlErrors);

  return {
    findByDiscordId,
    findById,
    upsertFromDiscord,
    completeProfile,
    updateLocale,
    updateAdminProfile,
  };
});

export class UsersRepository extends ServiceMap.Service<
  UsersRepository,
  Effect.Success<typeof make>
>()('api/UsersRepository') {
  static readonly Default = Layer.effect(UsersRepository, make);
}
