// TDD mode — written BEFORE the implementation exists.
// Tests will fail to import until ~/interactions/profile-complete.ts is created.
// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").
//
// Note on "Either": the test spec describes these helpers using generic FP "Either"
// terminology, but this repo's Effect v4 beta does not export an `Either` module —
// the equivalent is `Result<A, E>` (success type first, error type second; see
// node_modules/effect/src/Result.ts, and packages/domain/test/Achievement.test.ts's
// use of `Schema.decodeUnknownEffect(...).pipe(Effect.flip, ...)` for the closest
// existing convention). We therefore expect:
//   parseBirthDate: (raw: Option<string>) => Result<string, 'invalid'>
//   parseJerseyNumber: (raw: Option<string>) => Result<Option<number>, 'invalid'>
//   decodeGenderFromCustomId: (customId: string) => string
//
// vi.mock is hoisted before imports by Vitest. The factory mocks ~/env.js so
// that @t3-oss/env-core does not throw during module load, in case
// profile-complete.ts pulls it in transitively (matches poll.test.ts convention —
// the interaction handlers colocated with these pure helpers will need SyncRpc,
// which itself does not import env.js today, but this guards against future
// coupling the same way poll.test.ts already does).

import { Auth } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction, ModalSubmitData } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer, Option, Result } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import {
  modalValueOption,
  ProfileCompleteModal,
  parseBirthDate,
  parseJerseyNumber,
  parseName,
} from '~/interactions/profile-complete.js';
import { SyncRpc } from '~/services/SyncRpc.js';

vi.mock('~/env.js', () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get: (_target: Record<string, unknown>, prop: string) => {
      if (prop === 'NODE_ENV') return 'test';
      if (prop === 'SERVER_URL') return 'http://localhost:3000';
      if (prop === 'APP_ENV') return 'test';
      if (prop === 'APP_ORIGIN') return 'localhost';
      if (prop === 'OTEL_EXPORTER_OTLP_ENDPOINT') return 'http://localhost:4318';
      if (prop === 'OTEL_SERVICE_NAME') return 'sideline-bot';
      if (prop === 'WEB_URL') return Option.none();
      return undefined;
    },
  }),
}));

// ---------------------------------------------------------------------------
// Date-boundary helpers
//
// Computed relative to the real current date (UTC — matches how a plain
// 'YYYY-MM-DD' string is parsed by `new Date(s)`) rather than hardcoded years,
// so these keep testing the right boundary no matter when the suite runs.
// Same methodology as packages/domain/test/CompleteMemberProfile.test.ts, which
// exercises the same Auth.MIN_AGE guard via Auth.BirthDateString directly —
// keeping both aligned means a regression shows up consistently in either file.
// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');
const nowUtc = new Date();
// Avoid constructing a Feb-29 date in a non-leap target year.
const todayMonth = pad2(nowUtc.getUTCMonth() + 1);
const todayDay =
  nowUtc.getUTCMonth() === 1 && nowUtc.getUTCDate() === 29 ? '28' : pad2(nowUtc.getUTCDate());
// Comfortably under MIN_AGE (not just off-by-one), so the "clearly too young"
// case can't be confused with the exact-boundary case below.
const UNDER_AGE_MARGIN_YEARS = 2;

// ---------------------------------------------------------------------------
// parseBirthDate
// ---------------------------------------------------------------------------

describe('parseBirthDate', () => {
  it('Some(valid date string) → Success with the same string', () => {
    const result = parseBirthDate(Option.some('1990-05-01'));
    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.getOrThrow(result)).toBe('1990-05-01');
  });

  it('None → Failure("invalid") — birth date is required, blank is not allowed', () => {
    const result = parseBirthDate(Option.none());
    expect(Result.isFailure(result)).toBe(true);
    expect(Option.getOrNull(Result.getFailure(result))).toBe('invalid');
  });

  it('Some("31/12/2005") — wrong format (not ISO) → Failure("invalid")', () => {
    const result = parseBirthDate(Option.some('31/12/2005'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some("abc") — garbage string → Failure("invalid")', () => {
    const result = parseBirthDate(Option.some('abc'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some("2000-13-40") — invalid month/day → Failure("invalid")', () => {
    const result = parseBirthDate(Option.some('2000-13-40'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some("2005-02-30") — rolls over to 2005-03-02 → Failure("invalid")', () => {
    const result = parseBirthDate(Option.some('2005-02-30'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some(future date) → Failure("invalid")', () => {
    // Fixed, clearly-out-of-range constant (matches the convention already used
    // for "far future" dates elsewhere in this repo's test suite, e.g.
    // applications/server/test/EventRpc.test.ts's '2099-06-01T18:00:00Z').
    const result = parseBirthDate(Option.some('2099-01-01'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some("1900-01-01") → Success (lower boundary — must not be off-by-one)', () => {
    const result = parseBirthDate(Option.some('1900-01-01'));
    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.getOrThrow(result)).toBe('1900-01-01');
  });

  it('Some("1899-12-31") — one day before the 1900-01-01 cutoff → Failure("invalid")', () => {
    const result = parseBirthDate(Option.some('1899-12-31'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it(`Some(date exactly MIN_AGE=${Auth.MIN_AGE} years ago today) → Success (upper boundary — must not be off-by-one)`, () => {
    const year = nowUtc.getUTCFullYear() - Auth.MIN_AGE;
    const dateString = `${year}-${todayMonth}-${todayDay}`;
    const result = parseBirthDate(Option.some(dateString));
    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.getOrThrow(result)).toBe(dateString);
  });

  it(`Some(date under MIN_AGE=${Auth.MIN_AGE} years ago) → Failure("invalid")`, () => {
    const year = nowUtc.getUTCFullYear() - (Auth.MIN_AGE - UNDER_AGE_MARGIN_YEARS);
    const result = parseBirthDate(Option.some(`${year}-${todayMonth}-${todayDay}`));
    expect(Result.isFailure(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseName
// ---------------------------------------------------------------------------

describe('parseName', () => {
  it('Some("Jane Doe") → Success("Jane Doe")', () => {
    const result = parseName(Option.some('Jane Doe'));
    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.getOrThrow(result)).toBe('Jane Doe');
  });

  it('None → Failure("invalid") — name is required, blank is not allowed', () => {
    const result = parseName(Option.none());
    expect(Result.isFailure(result)).toBe(true);
    expect(Option.getOrNull(Result.getFailure(result))).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// parseJerseyNumber
// ---------------------------------------------------------------------------

describe('parseJerseyNumber', () => {
  it('Some("10") → Success(Some(10))', () => {
    const result = parseJerseyNumber(Option.some('10'));
    expect(Result.isSuccess(result)).toBe(true);
    expect(Option.getOrNull(Result.getOrThrow(result))).toBe(10);
  });

  it('Some("0") → Success(Some(0)) (lower boundary)', () => {
    const result = parseJerseyNumber(Option.some('0'));
    expect(Result.isSuccess(result)).toBe(true);
    expect(Option.getOrNull(Result.getOrThrow(result))).toBe(0);
  });

  it('Some("99") → Success(Some(99)) (upper boundary)', () => {
    const result = parseJerseyNumber(Option.some('99'));
    expect(Result.isSuccess(result)).toBe(true);
    expect(Option.getOrNull(Result.getOrThrow(result))).toBe(99);
  });

  it('None → Success(None) — no input means "leave unchanged"', () => {
    const result = parseJerseyNumber(Option.none());
    expect(Result.isSuccess(result)).toBe(true);
    expect(Option.isNone(Result.getOrThrow(result))).toBe(true);
  });

  it('Some("") → Success(None) — blank string also means "leave unchanged"', () => {
    const result = parseJerseyNumber(Option.some(''));
    expect(Result.isSuccess(result)).toBe(true);
    expect(Option.isNone(Result.getOrThrow(result))).toBe(true);
  });

  it('Some("100") — above upper boundary → Failure("invalid")', () => {
    const result = parseJerseyNumber(Option.some('100'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some("-1") — below lower boundary → Failure("invalid")', () => {
    const result = parseJerseyNumber(Option.some('-1'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some("1.5") — not an integer → Failure("invalid")', () => {
    const result = parseJerseyNumber(Option.some('1.5'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some("abc") — not a number at all → Failure("invalid")', () => {
    const result = parseJerseyNumber(Option.some('abc'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some("007") — leading zeros not accepted as canonical input → Failure("invalid")', () => {
    const result = parseJerseyNumber(Option.some('007'));
    expect(Result.isFailure(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// decodeGenderFromCustomId is DELETED by Task 6 — gender now arrives in the
// modal payload (`profile_gender`), not encoded in the `custom_id`. The
// `profile-complete:{gender}` scheme goes with it: the modal `custom_id`
// becomes the stateless `profile-complete` (see the `ProfileCompleteModal`
// describe blocks below). There is intentionally no test importing
// `decodeGenderFromCustomId` here any more — importing a deleted export would
// itself be the regression signal once Task 6 lands.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// modalValueOption — Task 6 walks BOTH shapes: `type: 1` action rows (text
// inputs, unchanged) and `type: 18` Label components (the new gender select,
// read via `.component.values[0]`). Only the local copy in THIS file changes —
// the plan is explicit that the other two copies (`interactions/event-create.ts`,
// the inline loop in `interactions/report.ts`) are deliberately left alone.
// ---------------------------------------------------------------------------

describe('modalValueOption', () => {
  it('reads a text input out of an action row (type: 1) — existing behaviour, unbroken', () => {
    const submission = {
      custom_id: 'profile-complete',
      components: [
        {
          type: 1,
          components: [{ type: 4, custom_id: 'profile_name', value: 'Jana Nováková' }],
        },
      ],
    } as unknown as DiscordTypes.APIModalSubmission;

    expect(Option.getOrNull(modalValueOption(submission, 'profile_name'))).toBe('Jana Nováková');
  });

  it('reads a select out of a Label component (type: 18) via component.values[0]', () => {
    const submission = {
      custom_id: 'profile-complete',
      components: [
        {
          type: 18,
          label: 'Pohlaví',
          component: { type: 3, custom_id: 'profile_gender', values: ['female'] },
        },
      ],
    } as unknown as DiscordTypes.APIModalSubmission;

    expect(Option.getOrNull(modalValueOption(submission, 'profile_gender'))).toBe('female');
  });

  it('a blank text-input value in an action row still yields None (unchanged)', () => {
    const submission = {
      custom_id: 'profile-complete',
      components: [{ type: 1, components: [{ type: 4, custom_id: 'profile_name', value: '   ' }] }],
    } as unknown as DiscordTypes.APIModalSubmission;

    expect(Option.isNone(modalValueOption(submission, 'profile_name'))).toBe(true);
  });

  it('a custom_id present in neither an action row nor a label component yields None', () => {
    const submission = {
      custom_id: 'profile-complete',
      components: [{ type: 1, components: [{ type: 4, custom_id: 'profile_name', value: 'X' }] }],
    } as unknown as DiscordTypes.APIModalSubmission;

    expect(Option.isNone(modalValueOption(submission, 'profile_gender'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseBirthDate — Task 6 architect asks #3/#4: normalise Czech date input to
// ISO before `Auth.BirthDateString`, and split the failure tag into
// 'invalid' | 'too_young' so an under-MIN_AGE date does not read as a format
// error. `Auth.BirthDateString` stays the authority; only the input shaping
// and the failure tag change.
// ---------------------------------------------------------------------------

describe('parseBirthDate — Czech date normalisation (Task 6, architect ask #3)', () => {
  it.each([
    ['24. 8. 2005', '2005-08-24'],
    ['24.8.2005', '2005-08-24'],
    ['2005-08-24', '2005-08-24'],
  ] as const)('%s normalises to %s before hitting Auth.BirthDateString', (input, expected) => {
    const result = parseBirthDate(Option.some(input));
    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.getOrThrow(result)).toBe(expected);
  });

  it('"32. 1. 2005" (no such day) still fails \'invalid\' after normalisation', () => {
    const result = parseBirthDate(Option.some('32. 1. 2005'));
    expect(Result.isFailure(result)).toBe(true);
    expect(Option.getOrNull(Result.getFailure(result))).toBe('invalid');
  });
});

describe("parseBirthDate — 'too_young' is a distinct tag from 'invalid' (Task 6, architect ask #4)", () => {
  it("a well-formed date six months ago fails the tagged 'too_young', not 'invalid'", () => {
    const sixMonthsAgo = new Date(
      Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth() - 6, nowUtc.getUTCDate()),
    );
    const dateString = `${sixMonthsAgo.getUTCFullYear()}-${pad2(sixMonthsAgo.getUTCMonth() + 1)}-${pad2(sixMonthsAgo.getUTCDate())}`;

    const result = parseBirthDate(Option.some(dateString));
    expect(Result.isFailure(result)).toBe(true);
    expect(Option.getOrNull(Result.getFailure(result))).toBe('too_young');
  });

  it("a garbage / unparseable date still fails the tagged 'invalid', not 'too_young'", () => {
    const result = parseBirthDate(Option.some('not-a-date'));
    expect(Result.isFailure(result)).toBe(true);
    expect(Option.getOrNull(Result.getFailure(result))).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// Full-flow ProfileCompleteModal tests (Task 6 items 5 + 8, Task 10's revoke).
// Pattern mirrors test/interactions/rsvp.test.ts's runModalHandler: stub
// DiscordREST + SyncRpc layers, run the bare `.handle` effect, flush
// microtasks so the `Effect.forkDetach`'d background work completes.
// ---------------------------------------------------------------------------

const PC_GUILD_ID = '700000000000000001' as DiscordTypes.Snowflake;
const PC_CHANNEL_ID = '700000000000000010' as DiscordTypes.Snowflake;
const PC_USER_ID = '700000000000000030' as DiscordTypes.Snowflake;
const PC_APP_ID = '700000000000000040' as DiscordTypes.Snowflake;
const PC_TOKEN = 'pc-interaction-token';

type ModalField = {
  name?: string;
  birthDate?: string;
  jersey?: string;
  gender?: string;
};

const makeProfileModalInteraction = (
  fields: ModalField,
  locale = 'en-US',
): DiscordTypes.APIInteraction => {
  const components: unknown[] = [];
  if (fields.name !== undefined) {
    components.push({
      type: 1,
      components: [{ type: 4, custom_id: 'profile_name', value: fields.name }],
    });
  }
  if (fields.birthDate !== undefined) {
    components.push({
      type: 1,
      components: [{ type: 4, custom_id: 'profile_birth_date', value: fields.birthDate }],
    });
  }
  components.push({
    type: 1,
    components: [{ type: 4, custom_id: 'profile_jersey_number', value: fields.jersey ?? '' }],
  });
  if (fields.gender !== undefined) {
    components.push({
      type: 18,
      label: 'Pohlaví',
      component: { type: 3, custom_id: 'profile_gender', values: [fields.gender] },
    });
  }

  return {
    id: '1234567899' as DiscordTypes.Snowflake,
    application_id: PC_APP_ID,
    token: PC_TOKEN,
    version: 1,
    type: DiscordTypes.InteractionTypes.MODAL_SUBMIT,
    guild_id: PC_GUILD_ID,
    channel_id: PC_CHANNEL_ID,
    member: {
      user: {
        id: PC_USER_ID,
        username: 'testuser',
        discriminator: '0001',
        global_name: null,
        avatar: null,
      },
      roles: [],
      joined_at: '2024-01-01T00:00:00Z',
      deaf: false,
      mute: false,
      permissions: '8',
    },
    locale,
    data: { custom_id: 'profile-complete', components },
  } as unknown as DiscordTypes.APIInteraction;
};

const makeProfileRestStub = (overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) => {
  const updateOriginalWebhookMessage =
    overrides.updateOriginalWebhookMessage ?? vi.fn(() => Effect.succeed(undefined));
  const rest = new Proxy({} as DiscordRestService, {
    get: (_target, prop: string) => {
      if (prop === 'updateOriginalWebhookMessage') return updateOriginalWebhookMessage;
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      return () => Effect.succeed(undefined);
    },
  }) as unknown as DiscordRestService;
  return { layer: Layer.succeed(DiscordREST, rest), updateOriginalWebhookMessage };
};

const makeProfileRpcLayer = (
  overrides: Record<string, ReturnType<typeof vi.fn>>,
): Layer.Layer<SyncRpc> => {
  const rpc = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop: string) => {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
      return overrides[prop] ?? vi.fn(() => Effect.succeed(undefined));
    },
  });
  return Layer.succeed(SyncRpc, rpc as unknown as InstanceType<typeof SyncRpc>);
};

const runProfileModalHandler = async (
  interaction: DiscordTypes.APIInteraction,
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
) => {
  const response = await Effect.runPromise(
    ProfileCompleteModal.handle.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(
        Layer.succeed(
          ModalSubmitData,
          interaction.data as unknown as InstanceType<typeof ModalSubmitData>,
        ),
      ),
      Effect.provide(restLayer),
      Effect.provide(rpcLayer),
    ) as Effect.Effect<unknown, never, never>,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
};

describe('ProfileCompleteModal — gender comes from the payload, not the custom_id (Task 6 item 5)', () => {
  it('custom_id "profile-complete" (no gender suffix) with profile_gender: [\'male\'] completes successfully', async () => {
    const completeMemberProfile = vi.fn(() =>
      Effect.succeed({
        name: 'Jana Nováková',
        birth_date: '2005-08-24',
        gender: 'male' as const,
        jersey_number: Option.none<number>(),
      }),
    );
    const restStub = makeProfileRestStub();
    const rpcLayer = makeProfileRpcLayer({ 'Guild/CompleteMemberProfile': completeMemberProfile });
    const interaction = makeProfileModalInteraction({
      name: 'Jana Nováková',
      birthDate: '2005-08-24',
      gender: 'male',
    });

    const response = await runProfileModalHandler(interaction, restStub.layer, rpcLayer);

    expect((response as { type: number }).type).toBe(
      DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
    expect(completeMemberProfile).toHaveBeenCalledTimes(1);
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalledTimes(1);
    const call = restStub.updateOriginalWebhookMessage.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { payload: { content: string } },
    ];
    expect(call[2].payload.content).toBe(
      m.bot_complete_success(
        {
          name: 'Jana Nováková',
          birthDate: '2005-08-24',
          gender: m.gender_male({}, { locale: 'en' }),
        },
        { locale: 'en' },
      ),
    );
  });

  it('a submission with no gender component fails bot_verify_gender_missing (no RPC call)', async () => {
    const completeMemberProfile = vi.fn(() =>
      Effect.succeed({
        name: 'Jana Nováková',
        birth_date: '2005-08-24',
        gender: 'male' as const,
        jersey_number: Option.none<number>(),
      }),
    );
    const restStub = makeProfileRestStub();
    const rpcLayer = makeProfileRpcLayer({ 'Guild/CompleteMemberProfile': completeMemberProfile });
    const interaction = makeProfileModalInteraction({
      name: 'Jana Nováková',
      birthDate: '2005-08-24',
      // gender omitted entirely
    });

    const response = await runProfileModalHandler(interaction, restStub.layer, rpcLayer);

    expect(completeMemberProfile).not.toHaveBeenCalled();
    const typed = response as { type: number; data: { content: string } };
    expect(typed.data.content).toBe(m.bot_verify_gender_missing({}, { locale: 'en' }));
  });
});

describe('ProfileCompleteModal — CompleteProfileNotMember vs CompleteProfileGuildNotFound (Task 6 item 8)', () => {
  const validInteraction = makeProfileModalInteraction({
    name: 'Jana Nováková',
    birthDate: '2005-08-24',
    gender: 'male',
  });

  it('CompleteProfileNotMember gets bot_verify_not_member', async () => {
    const restStub = makeProfileRestStub();
    const rpcLayer = makeProfileRpcLayer({
      'Guild/CompleteMemberProfile': vi.fn(() => Effect.fail({ _tag: 'CompleteProfileNotMember' })),
    });

    await runProfileModalHandler(validInteraction, restStub.layer, rpcLayer);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalledTimes(1);
    const call = restStub.updateOriginalWebhookMessage.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { payload: { content: string } },
    ];
    expect(call[2].payload.content).toBe(m.bot_verify_not_member({}, { locale: 'en' }));
  });

  it('CompleteProfileGuildNotFound gets bot_verify_guild_not_registered — a DIFFERENT string from not_member', async () => {
    const restStub = makeProfileRestStub();
    const rpcLayer = makeProfileRpcLayer({
      'Guild/CompleteMemberProfile': vi.fn(() =>
        Effect.fail({ _tag: 'CompleteProfileGuildNotFound' }),
      ),
    });

    await runProfileModalHandler(validInteraction, restStub.layer, rpcLayer);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalledTimes(1);
    const call = restStub.updateOriginalWebhookMessage.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { payload: { content: string } },
    ];
    expect(call[2].payload.content).toBe(m.bot_verify_guild_not_registered({}, { locale: 'en' }));
    expect(call[2].payload.content).not.toBe(m.bot_verify_not_member({}, { locale: 'en' }));
  });
});

// ---------------------------------------------------------------------------
// Task 10 — successful completion revokes the unverified role. Bot-owned role,
// resolved by name (`findUnverifiedRole`, list → find by name, never creates),
// then `rest.deleteGuildMemberRole`. A failed revoke must never fail the
// member-facing success reply (`Effect.catchCause(logWarning)`).
// ---------------------------------------------------------------------------

const UNVERIFIED_ROLE_ID = '700000000000000099';

describe('ProfileCompleteModal — Task 10: revokes the unverified role on success', () => {
  const successRpc = () =>
    makeProfileRpcLayer({
      'Guild/CompleteMemberProfile': vi.fn(() =>
        Effect.succeed({
          name: 'Jana Nováková',
          birth_date: '2005-08-24',
          gender: 'male' as const,
          jersey_number: Option.none<number>(),
        }),
      ),
    });

  const interaction = makeProfileModalInteraction({
    name: 'Jana Nováková',
    birthDate: '2005-08-24',
    gender: 'male',
  });

  it('successful completion calls deleteGuildMemberRole with the resolved unverified role id', async () => {
    const listGuildRoles = vi.fn(() =>
      Effect.succeed([{ id: UNVERIFIED_ROLE_ID, name: 'Sideline Unverified' }]),
    );
    const deleteGuildMemberRole = vi.fn(() => Effect.succeed(undefined));
    const restStub = makeProfileRestStub({ listGuildRoles, deleteGuildMemberRole });

    await runProfileModalHandler(interaction, restStub.layer, successRpc());

    expect(deleteGuildMemberRole).toHaveBeenCalledTimes(1);
    expect(deleteGuildMemberRole).toHaveBeenCalledWith(PC_GUILD_ID, PC_USER_ID, UNVERIFIED_ROLE_ID);
  });

  it('a failed deleteGuildMemberRole still returns the success reply (never fails the reply)', async () => {
    const listGuildRoles = vi.fn(() =>
      Effect.succeed([{ id: UNVERIFIED_ROLE_ID, name: 'Sideline Unverified' }]),
    );
    const deleteGuildMemberRole = vi.fn(() => Effect.fail({ _tag: 'ErrorResponse' }));
    const restStub = makeProfileRestStub({ listGuildRoles, deleteGuildMemberRole });

    await runProfileModalHandler(interaction, restStub.layer, successRpc());

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalledTimes(1);
    const call = restStub.updateOriginalWebhookMessage.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { payload: { content: string } },
    ];
    expect(call[2].payload.content).toBe(
      m.bot_complete_success(
        {
          name: 'Jana Nováková',
          birthDate: '2005-08-24',
          gender: m.gender_male({}, { locale: 'en' }),
        },
        { locale: 'en' },
      ),
    );
  });
});
