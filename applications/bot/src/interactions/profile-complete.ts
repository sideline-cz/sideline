import { Auth, Discord as DiscordSchemas, TeamMember, User } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction, ModalSubmitData } from 'dfx/Interactions/index';
import * as Discord from 'dfx/types';
import { Effect, Metric, Option, Result, Schema } from 'effect';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);
const decodeGender = Schema.decodeUnknownResult(User.Gender);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Required — `None` (blank) is rejected. Decodes with the same
 * `Auth.BirthDateString` rule the server uses, so the bot-side check can never
 * drift from the authoritative validation (format, real date, 1900-01-01 floor,
 * future dates, `Auth.MIN_AGE`). */
export const parseBirthDate = (raw: Option.Option<string>): Result.Result<string, 'invalid'> =>
  Option.match(raw, {
    onNone: () => Result.fail('invalid' as const),
    onSome: (value) =>
      Schema.decodeUnknownResult(Auth.BirthDateString)(value).pipe(
        Result.map(() => value),
        Result.mapError(() => 'invalid' as const),
      ),
  });

/** Optional — `None` or blank means "leave unchanged" (`Option.none()`), which is
 * a success, not a failure. The `^\d{1,2}$` guard rejects 3+ digit strings,
 * negative numbers, decimals and non-canonical (leading-zero) input before the
 * value ever reaches `TeamMember.JerseyNumber`. */
export const parseJerseyNumber = (
  raw: Option.Option<string>,
): Result.Result<Option.Option<number>, 'invalid'> =>
  Option.match(raw, {
    onNone: () => Result.succeed(Option.none<number>()),
    onSome: (value) => {
      if (value === '') return Result.succeed(Option.none<number>());
      if (!/^\d{1,2}$/.test(value)) return Result.fail('invalid' as const);
      return Schema.decodeUnknownResult(TeamMember.JerseyNumber)(Number(value)).pipe(
        Result.map((n) => Option.some(n)),
        Result.mapError(() => 'invalid' as const),
      );
    },
  });

/** Required — `None` (blank) is rejected. Trimming and blank-detection already
 * happen in `modalValueOption`, so this is a thin wrapper that turns the
 * `Option` into the same `Result` shape as the other field parsers. */
export const parseName = (raw: Option.Option<string>): Result.Result<string, 'invalid'> =>
  Option.match(raw, {
    onNone: () => Result.fail('invalid' as const),
    onSome: (value) => Result.succeed(value),
  });

/** `profile-complete:{gender}` → `{gender}` (`undefined` for a malformed custom_id
 * with no `:` segment). This helper itself never throws — the resulting value
 * still needs to be decoded against `User.Gender` (with a non-throwing decode)
 * before it can be trusted, since `undefined` (or any other garbage) is not a
 * valid `Gender`. */
export const decodeGenderFromCustomId = (customId: string): string => customId.split(':')[1];

// ---------------------------------------------------------------------------
// Modal submit handler
// ---------------------------------------------------------------------------

const modalValueOption = (
  submission: Discord.APIModalSubmission,
  customId: string,
): Option.Option<string> => {
  for (const row of submission.components ?? []) {
    if (row.type !== 1) continue;
    for (const comp of row.components) {
      if (comp.custom_id === customId) {
        return comp.value && comp.value.trim().length > 0
          ? Option.some(comp.value.trim())
          : Option.none();
      }
    }
  }
  return Option.none();
};

const genderLabel = (gender: User.Gender, locale: 'en' | 'cs'): string => {
  switch (gender) {
    case 'male':
      return m.gender_male({}, { locale });
    case 'female':
      return m.gender_female({}, { locale });
    case 'other':
      return m.gender_other({}, { locale });
  }
};

export const ProfileCompleteModal = Ix.modalSubmit(
  Ix.idStartsWith('profile-complete:'),
  Effect.Do.pipe(
    Effect.tap(() =>
      Metric.update(
        Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'modal' }),
        1,
      ),
    ),
    Effect.bind('data', () => ModalSubmitData.asEffect()),
    Effect.bind('interaction', () => Interaction.asEffect()),
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.flatMap(({ data, interaction, rpc, rest }) => {
      const locale = userLocale(interaction);
      const guildId = interaction.guild_id;
      const discordUserId = interactionUserId(interaction);

      if (!guildId || Option.isNone(discordUserId)) {
        return Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: m.bot_complete_no_guild({}, { locale }),
              flags: Discord.MessageFlags.Ephemeral,
            },
          }),
        );
      }

      const genderResult = decodeGender(decodeGenderFromCustomId(data.custom_id));
      if (Result.isFailure(genderResult)) {
        return Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: m.bot_complete_error({}, { locale }),
              flags: Discord.MessageFlags.Ephemeral,
            },
          }),
        );
      }
      const gender = Result.getOrThrow(genderResult);

      const nameResult = parseName(modalValueOption(data, 'profile_name'));
      if (Result.isFailure(nameResult)) {
        return Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: m.bot_complete_invalid_name({}, { locale }),
              flags: Discord.MessageFlags.Ephemeral,
            },
          }),
        );
      }

      const birthDateResult = parseBirthDate(modalValueOption(data, 'profile_birth_date'));
      if (Result.isFailure(birthDateResult)) {
        return Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: m.bot_complete_invalid_date({}, { locale }),
              flags: Discord.MessageFlags.Ephemeral,
            },
          }),
        );
      }

      const jerseyNumberResult = parseJerseyNumber(modalValueOption(data, 'profile_jersey_number'));
      if (Result.isFailure(jerseyNumberResult)) {
        return Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: m.bot_complete_invalid_jersey({}, { locale }),
              flags: Discord.MessageFlags.Ephemeral,
            },
          }),
        );
      }

      const name = Result.getOrThrow(nameResult);
      const birthDate = Result.getOrThrow(birthDateResult);
      const jerseyNumber = Result.getOrThrow(jerseyNumberResult);

      const work = rpc['Guild/CompleteMemberProfile']({
        guild_id: decodeSnowflake(guildId),
        discord_user_id: decodeSnowflake(discordUserId.value),
        name,
        birth_date: birthDate,
        gender,
        jersey_number: jerseyNumber,
      }).pipe(
        Effect.map((result) =>
          Option.match(result.jersey_number, {
            onNone: () =>
              m.bot_complete_success(
                {
                  name: result.name,
                  birthDate: result.birth_date,
                  gender: genderLabel(result.gender, locale),
                },
                { locale },
              ),
            onSome: (jersey) =>
              m.bot_complete_success_with_jersey(
                {
                  name: result.name,
                  birthDate: result.birth_date,
                  gender: genderLabel(result.gender, locale),
                  jersey: String(jersey),
                },
                { locale },
              ),
          }),
        ),
        Effect.catchTag(['CompleteProfileNotMember', 'CompleteProfileGuildNotFound'], () =>
          Effect.succeed(m.bot_complete_not_member({}, { locale })),
        ),
        Effect.catchTag('CompleteProfileInvalidInput', () =>
          Effect.succeed(m.bot_complete_error({}, { locale })),
        ),
        Effect.catchTag('RpcClientError', () =>
          Effect.succeed(m.bot_complete_error({}, { locale })),
        ),
        Effect.flatMap((content) =>
          rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
            payload: { content },
          }),
        ),
        Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
          Effect.logError('Failed to update profile complete response', error),
        ),
        // Defensive backstop: the RPC call (or anything above it) may surface a
        // server-side defect (e.g. a `LogicError.die` from `catchSqlErrors`, or a
        // died `NoSuchElementError`) instead of a tagged error. Without this, the
        // forked fiber below would die silently and the ephemeral defer would
        // never resolve, leaving the user stuck on "Sideline is thinking…"
        // forever. This must always resolve the deferred ephemeral response.
        Effect.catchCause((cause) =>
          Effect.logError('profile-complete: unexpected failure completing profile', cause).pipe(
            Effect.andThen(
              rest
                .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
                  payload: { content: m.bot_complete_error({}, { locale }) },
                })
                .pipe(
                  Effect.catchTag(
                    ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'],
                    (error) => Effect.logError('Failed to update profile complete response', error),
                  ),
                ),
            ),
          ),
        ),
      );

      const deferred: Discord.CreateMessageInteractionCallbackRequest = {
        type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: Discord.MessageFlags.Ephemeral },
      };
      return Effect.as(Effect.forkDetach(work), deferred);
    }),
    Effect.withSpan('interaction/profile-complete-modal'),
  ),
);
