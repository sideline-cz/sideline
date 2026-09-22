import { Auth, Discord as DiscordSchemas, TeamMember, User } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction, ModalSubmitData } from 'dfx/Interactions/index';
import * as Discord from 'dfx/types';
import { Effect, Metric, Option, Result, Schema } from 'effect';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { findUnverifiedRole } from '~/rest/roles/ensureUnverifiedRole.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);
const decodeGender = Schema.decodeUnknownResult(User.Gender);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const CZECH_DATE_PATTERN = /^(\d{1,2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{4})$/;

/** Normalises `24. 8. 2005` / `24.8.2005` to ISO `2005-08-24` before the value ever
 * reaches `Auth.BirthDateString`. A Czech member types a Czech date, not ISO —
 * `Auth.BirthDateString` stays the sole authority on validity; this only reshapes the
 * string (Task 6, architect ask #3). Anything that does not match the Czech pattern
 * (including a well-formed ISO string, or garbage) passes through unchanged and is
 * left to the schema below to accept or reject.
 *
 * Dot-separated only — `/` is deliberately NOT a separator. `31/12/2005` is DD/MM to a
 * Czech reader and MM/DD to an American one, and `01/02/2005` is a valid date under
 * both readings, so accepting slashes would silently store the wrong birth date with
 * no error for anyone typing the US order. The dotted form is unambiguous in Czech
 * convention, and it is the only non-ISO form the member-facing copy offers
 * (`bot_verify_invalid_date`: "Write it like 24. 8. 2005 or 2005-08-24"). A slashed
 * date falls through to the schema and is rejected with that same hint. */
const normalizeBirthDateInput = (raw: string): string => {
  const trimmed = raw.trim();
  const match = CZECH_DATE_PATTERN.exec(trimmed);
  if (match === null) return trimmed;
  const [, day, month, year] = match;
  return `${year}-${month?.padStart(2, '0')}-${day?.padStart(2, '0')}`;
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Re-runs `Auth.BirthDateString`'s own "younger than `MIN_AGE`" check in isolation,
 * so a well-formed-but-too-young date can be tagged `'too_young'` instead of the
 * generic `'invalid'` (Task 6, architect ask #4). Mirrors the schema's real-date and
 * rollover checks first, so this only ever returns `true` for a date that would
 * otherwise have cleared every other check — a garbage string or an out-of-range
 * date (e.g. "2005-02-30") is `'invalid'`, never `'too_young'`. */
const isTooYoung = (value: string): boolean => {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  if (d.toISOString().slice(0, 10) !== value) return false;
  const minDate = new Date();
  minDate.setFullYear(minDate.getFullYear() - Auth.MIN_AGE);
  return d > minDate;
};

export type BirthDateError = 'invalid' | 'too_young';

/** Required — `None` (blank) is rejected. Decodes with the same
 * `Auth.BirthDateString` rule the server uses, so the bot-side check can never
 * drift from the authoritative validation (format, real date, 1900-01-01 floor,
 * future dates, `Auth.MIN_AGE`) — only the input shaping (Czech date normalisation)
 * and the failure tag (`'invalid'` vs `'too_young'`) are bot-side additions. */
export const parseBirthDate = (raw: Option.Option<string>): Result.Result<string, BirthDateError> =>
  Option.match(raw, {
    onNone: () => Result.fail('invalid' as const),
    onSome: (value) => {
      const normalized = normalizeBirthDateInput(value);
      return Schema.decodeUnknownResult(Auth.BirthDateString)(normalized).pipe(
        Result.map(() => normalized),
        Result.mapError(() =>
          isTooYoung(normalized) ? ('too_young' as const) : ('invalid' as const),
        ),
      );
    },
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

// ---------------------------------------------------------------------------
// Modal submit handler
// ---------------------------------------------------------------------------

/** Reads a field's value out of a modal submission, walking BOTH shapes a modal can
 * carry: `type: 1` action rows (text inputs — the three original fields) and
 * `type: 18` Label components wrapping a select (the gender field added by Task 6).
 * Gender no longer rides in the `custom_id` — it arrives here like every other field.
 *
 * This copy is deliberately NOT shared with the near-identical loops in
 * `interactions/event-create.ts` and `interactions/report.ts` — see Task 6's plan
 * entry for why extracting a helper would be scope creep onto two modals that have
 * no select field at all. */
export const modalValueOption = (
  submission: Discord.APIModalSubmission,
  customId: string,
): Option.Option<string> => {
  for (const row of submission.components ?? []) {
    if (row.type === 1) {
      for (const comp of row.components) {
        if (comp.custom_id === customId) {
          return comp.value && comp.value.trim().length > 0
            ? Option.some(comp.value.trim())
            : Option.none();
        }
      }
      continue;
    }
    if (row.type === 18) {
      const comp = row.component;
      if (comp.custom_id !== customId) continue;
      const value = 'values' in comp ? comp.values[0] : undefined;
      return value !== undefined && value.trim().length > 0
        ? Option.some(value.trim())
        : Option.none();
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
  Ix.id('profile-complete'),
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

      const genderOption = modalValueOption(data, 'profile_gender');
      if (Option.isNone(genderOption)) {
        return Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: m.bot_verify_gender_missing({}, { locale }),
              flags: Discord.MessageFlags.Ephemeral,
            },
          }),
        );
      }

      const genderResult = decodeGender(genderOption.value);
      if (Result.isFailure(genderResult)) {
        return Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: m.bot_verify_gender_missing({}, { locale }),
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
        const tag = Option.getOrElse(Result.getFailure(birthDateResult), () => 'invalid' as const);
        return Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content:
                tag === 'too_young'
                  ? m.bot_verify_too_young({}, { locale })
                  : m.bot_verify_invalid_date({}, { locale }),
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

      // Revoke the unverified role on success (Task 10). Resolve-only —
      // `findUnverifiedRole` never creates — and a failed revoke must never fail
      // the member-facing success reply: it is cosmetic, there is no reconciler,
      // and the member's next `guildMemberAdd` or `/dokoncit` self-heals it.
      // ponytail: no active sweep for a stuck revoke; add one if it is ever observed.
      const revokeUnverifiedRole = findUnverifiedRole(decodeSnowflake(guildId)).pipe(
        Effect.flatMap((roleIdOption) =>
          Option.match(roleIdOption, {
            onNone: () => Effect.void,
            onSome: (roleId) =>
              rest.deleteGuildMemberRole(guildId, discordUserId.value, roleId).pipe(Effect.asVoid),
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning('profile-complete: failed to revoke unverified role', cause),
        ),
      );

      const work = rpc['Guild/CompleteMemberProfile']({
        guild_id: decodeSnowflake(guildId),
        discord_user_id: decodeSnowflake(discordUserId.value),
        name,
        birth_date: birthDate,
        gender,
        jersey_number: jerseyNumber,
      }).pipe(
        Effect.tap(() => revokeUnverifiedRole),
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
        Effect.catchTag('CompleteProfileNotMember', () =>
          Effect.succeed(m.bot_verify_not_member({}, { locale })),
        ),
        Effect.catchTag('CompleteProfileGuildNotFound', () =>
          Effect.succeed(m.bot_verify_guild_not_registered({}, { locale })),
        ),
        Effect.catchTag('CompleteProfileInvalidInput', () =>
          Effect.succeed(m.bot_complete_error({}, { locale })),
        ),
        Effect.catchTag('RpcClientError', () =>
          Effect.succeed(m.bot_verify_unavailable({}, { locale })),
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
