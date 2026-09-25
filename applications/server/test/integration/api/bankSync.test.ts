// TDD mode — tests written BEFORE `BankSyncApiLive` (`src/api/bank-sync.ts`) exists.
//
// Plan `.work-plans/fio-transaction-matching.md` §3.1.3 / §7.2 tests 157-166. Uses the
// lightweight "SmallApi" harness (`teamSettingsReanchor.test.ts` / `dashboardTimezoneGuard.test.ts`
// precedent): an `HttpApi` containing ONLY `BankSyncApi.BankSyncApiGroup`, served over REAL
// repositories against `TestPgClient`, with a hand-rolled `SessionsRepository` mock (token ->
// userId map) standing in for cookie-based auth. This deliberately does NOT pull in the full
// `ApiLive` (~40 mocked repositories) — that cross-cutting wiring is T6's implementation work,
// not this test file's job.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { BankSyncApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { BankSyncApiLive } from '~/api/bank-sync.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { BankSyncConfigRepository } from '~/repositories/BankSyncConfigRepository.js';
import { BankTransactionsRepository } from '~/repositories/BankTransactionsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { FioSecretCrypto, makeWithKey } from '~/services/FioSecretCrypto.js';
import {
  createFeeAndAssignment,
  createTeamMember,
  enableBankSync,
  encryptFioTestToken,
  FIO_TEST_ENCRYPTION_KEY_B64,
  insertBankTransaction,
  nextDiscordId,
  setMemberVariableSymbol,
  setTeamTimezone,
} from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const SmallApi = HttpApi.make('api').add(BankSyncApi.BankSyncApiGroup);

let sessionsStore: Map<string, User.UserId>;

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  findByToken: (token: string) => {
    const userId = sessionsStore.get(token);
    if (!userId) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        id: 'session-1',
        user_id: userId,
        token,
        expires_at: DateTime.nowUnsafe(),
        created_at: DateTime.nowUnsafe(),
      }),
    );
  },
  create: () => Effect.die(new Error('Not implemented')),
  deleteByToken: () => Effect.void,
} as never);

const FioSecretCryptoTestLayer = Layer.effect(
  FioSecretCrypto,
  makeWithKey(Option.some(FIO_TEST_ENCRYPTION_KEY_B64)),
);

// B3 — a SECOND crypto layer whose key is genuinely absent, for T16 (`misconfigured`), kept
// separate from the ciphertext-that-won't-decrypt case (T17, which uses the normal key-present
// `FioSecretCryptoTestLayer` above plus a garbage blob).
const FioSecretCryptoNoKeyLayer = Layer.effect(FioSecretCrypto, makeWithKey(Option.none()));

const RealRepos = Layer.mergeAll(
  UsersRepository.Default,
  TeamsRepository.Default,
  TeamMembersRepository.Default,
  RolesRepository.Default,
  BankSyncConfigRepository.Default,
  BankTransactionsRepository.Default,
  FeesRepository.Default,
  PaymentsRepository.Default,
  FioSecretCryptoTestLayer,
);

const RealReposNoKey = Layer.mergeAll(
  UsersRepository.Default,
  TeamsRepository.Default,
  TeamMembersRepository.Default,
  RolesRepository.Default,
  BankSyncConfigRepository.Default,
  BankTransactionsRepository.Default,
  FeesRepository.Default,
  PaymentsRepository.Default,
  FioSecretCryptoNoKeyLayer,
);

// ---------------------------------------------------------------------------
// Mock Fio HttpClient — module-level mutable, swapped per test (plan §6.3 harness note): the
// group is built ONCE in `beforeAll` (`HttpRouter.toWebHandler(TestLayer)`), so the responder
// cannot be a per-test `Layer.succeed` closure — it has to be a variable the running handler's
// already-built layer graph reads from at CALL time, not at layer-construction time.
// ---------------------------------------------------------------------------

let fioResponder: (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;
let fioCalls: number;

const MockFioHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    fioCalls += 1;
    return fioResponder(request);
  }),
);

const statusResponse = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(request, new Response('', { status }));

const jsonResponse = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );

/**
 * A minimal, well-formed Fio statement. Deliberately DIVERGES from `FioApiClient.test.ts` /
 * `fioColumns.test.ts`'s `CZ65…` vector — this file runs the account cross-check
 * (`services/bankSyncAccount.ts`), so `info` must agree with `enableBankSync`'s default account
 * (`2703474850/2010` -> `CZ7120100000002703474850`, plan `.work-plans/iban-cross-check.md` §9.D),
 * or every probe test in this file that expects `status: 'ok'` becomes a mismatch test instead.
 * `FioApiClient.test.ts`/`fioColumns.test.ts` keep the `CZ65…` vector because no comparison runs
 * there. `info.iban` is the value T8 asserts the endpoint echoes back as `accountIban`.
 */
const validRawStatement = {
  accountStatement: {
    info: {
      accountId: '2703474850',
      bankId: '2010',
      currency: 'CZK',
      iban: 'CZ7120100000002703474850',
      bic: 'GIBACZPX',
      openingBalance: 1000.0,
      closingBalance: 1000.0,
      dateStart: '2024-01-01+0100',
      dateEnd: '2024-01-14+0100',
      yearList: null,
      idList: null,
      idFrom: null,
      idTo: null,
      idLastDownload: null,
    },
    transactionList: { transaction: [] },
  },
};

const TEST_TOKEN = 'a'.repeat(64);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(BankSyncApiLive),
  Layer.provideMerge(MockFioHttpClientLayer),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provideMerge(RealRepos),
  Layer.provideMerge(TestPgClient),
);

// T16's second harness — everything the same except the `FioSecretCrypto` layer has NO key.
const TestLayerNoKey = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(BankSyncApiLive),
  Layer.provideMerge(MockFioHttpClientLayer),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provideMerge(RealReposNoKey),
  Layer.provideMerge(TestPgClient),
);

const SeedLayer = RealRepos.pipe(Layer.provideMerge(TestPgClient));

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let handlerNoKey: (request: Request) => Promise<Response>;
let disposeNoKey: () => Promise<void>;

beforeAll(() => {
  const app = HttpRouter.toWebHandler(TestLayer);
  handler = app.handler;
  dispose = app.dispose;
  const appNoKey = HttpRouter.toWebHandler(TestLayerNoKey);
  handlerNoKey = appNoKey.handler;
  disposeNoKey = appNoKey.dispose;
});

afterAll(async () => {
  await dispose();
  await disposeNoKey();
});

beforeEach(async () => {
  await cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise);
  sessionsStore = new Map();
  fioCalls = 0;
  fioResponder = () => Effect.die(new Error('fioResponder: no responder set for this test'));
});

const HOST = 'http://localhost';

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
        name: 'Bank Sync Test Team',
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

const addMemberWithRole = (teamId: Team.TeamId, userId: User.UserId, roleName: string) =>
  Effect.Do.pipe(
    Effect.bind('tm', () => createTeamMember(teamId, userId)),
    Effect.tap(() =>
      RolesRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(teamId)),
      ),
    ),
    Effect.bind('role', () =>
      RolesRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findRoleByTeamAndName(teamId, roleName)),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die(new Error(`role ${roleName} not found`)),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.tap(({ tm, role }) =>
      TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.assignRole((tm as { id: TeamMember.TeamMemberId }).id, role.id),
        ),
      ),
    ),
    Effect.map(({ tm }) => (tm as { id: TeamMember.TeamMemberId }).id),
  );

const setup = (guildId: string) =>
  Effect.gen(function* () {
    const treasurerId = yield* createUser(nextDiscordId(), `treasurer-${guildId}`);
    const team = yield* createTeam(guildId as Discord.Snowflake, treasurerId);
    yield* setTeamTimezone(team.id, 'Europe/Prague');
    yield* addMemberWithRole(team.id, treasurerId, 'Treasurer');
    sessionsStore.set('treasurer-token', treasurerId);

    const captainId = yield* createUser(nextDiscordId(), `captain-${guildId}`);
    yield* addMemberWithRole(team.id, captainId, 'Captain');
    sessionsStore.set('captain-token', captainId);

    const outsiderId = yield* createUser(nextDiscordId(), `outsider-${guildId}`);
    sessionsStore.set('outsider-token', outsiderId);

    return { teamId: team.id, treasurerId, captainId, outsiderId };
  }).pipe(Effect.provide(SeedLayer), Effect.runPromise);

const get = (path: string, token: string) =>
  handler(new Request(`${HOST}${path}`, { headers: { Authorization: `Bearer ${token}` } }));

const putJson = (path: string, token: string, body: unknown) =>
  handler(
    new Request(`${HOST}${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const post = (path: string, token: string, body?: unknown) =>
  handler(
    new Request(`${HOST}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const validUpsertPayload = {
  enabled: false,
  auto_match_enabled: true,
  auto_create_expenses: false,
  account_prefix: null,
  account_number: '2703474850',
  bank_code: '2010',
  currency: 'CZK',
  recipient_name: 'Klub',
  registered_id: null,
  registered_address: null,
  bank_name: null,
};

// ---------------------------------------------------------------------------
// Shared helpers for the /bank-sync/test suite (T8-T26)
// ---------------------------------------------------------------------------

/** Distinct from the hardcoded guild ids the older describe blocks above use — a counter avoids
 * ever having to hand-track the next free literal. */
let guildIdCounter = 340_100_000_000_000_200n;
const nextGuildId = (): string => (guildIdCounter++).toString();

interface PostTestResult {
  readonly status: number;
  readonly text: string;
  readonly body: unknown;
}

const postTestAgainst =
  (h: (request: Request) => Promise<Response>) =>
  async (teamId: Team.TeamId): Promise<PostTestResult> => {
    const response = await h(
      new Request(`${HOST}/teams/${teamId}/bank-sync/test`, {
        method: 'POST',
        headers: { Authorization: 'Bearer treasurer-token', 'Content-Type': 'application/json' },
      }),
    );
    const text = await response.text();
    return { status: response.status, text, body: text.length > 0 ? JSON.parse(text) : undefined };
  };

/** Runs the probe through the MAIN harness (key-present `FioSecretCrypto`, `MockFioHttpClientLayer`
 * responding via the module-level `fioResponder`). */
const postTest = (teamId: Team.TeamId) => postTestAgainst(handler)(teamId);

/** T16 only — runs the probe through the second harness whose `FioSecretCrypto` has NO key. */
const postTestNoKey = (teamId: Team.TeamId) => postTestAgainst(handlerNoKey)(teamId);

// ---------------------------------------------------------------------------
// 157 — non-member -> 403
// ---------------------------------------------------------------------------

describe('bank-sync API — authorization (157, 158, 159)', () => {
  it.effect('a non-member gets 403 on the config GET', () =>
    Effect.gen(function* () {
      const { teamId } = yield* Effect.promise(() => setup('340100000000000001'));
      const strangerId = yield* createUser(nextDiscordId(), 'stranger').pipe(
        Effect.provide(SeedLayer),
      );
      sessionsStore.set('stranger-token', strangerId);
      const response = yield* Effect.promise(() =>
        get(`/teams/${teamId}/bank-sync`, 'stranger-token'),
      );
      expect(response.status).toBe(403);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect(
    'a Captain (finance:view, no finance:record_payments) gets 403 on the transaction queue (158)',
    () =>
      Effect.gen(function* () {
        const { teamId } = yield* Effect.promise(() => setup('340100000000000002'));
        const response = yield* Effect.promise(() =>
          get(`/teams/${teamId}/bank-transactions`, 'captain-token'),
        );
        expect(response.status).toBe(403);
      }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('a Captain gets 403 on the CSV export (158)', () =>
    Effect.gen(function* () {
      const { teamId } = yield* Effect.promise(() => setup('340100000000000003'));
      const response = yield* Effect.promise(() =>
        get(`/teams/${teamId}/bank-transactions/export.csv`, 'captain-token'),
      );
      expect(response.status).toBe(403);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect(
    'PUT (upsert config) requires finance:manage_fees — a Captain without it gets 403 (159)',
    () =>
      Effect.gen(function* () {
        const { teamId } = yield* Effect.promise(() => setup('340100000000000004'));
        const response = yield* Effect.promise(() =>
          putJson(`/teams/${teamId}/bank-sync`, 'captain-token', validUpsertPayload),
        );
        expect(response.status).toBe(403);
      }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('the treasurer (finance:manage_fees) can PUT the config', () =>
    Effect.gen(function* () {
      const { teamId } = yield* Effect.promise(() => setup('340100000000000005'));
      const response = yield* Effect.promise(() =>
        putJson(`/teams/${teamId}/bank-sync`, 'treasurer-token', validUpsertPayload),
      );
      expect(response.status).toBe(200);
    }).pipe(Effect.provide(SeedLayer)),
  );

  // Deploy order is bot -> server -> web, so a new server serves old web bundles for a window.
  // A bundle predating either flag omits its key; a required field would 400 every such save.
  it.effect('a payload omitting auto_create_expenses and auto_credit_enabled is accepted', () =>
    Effect.gen(function* () {
      const { teamId } = yield* Effect.promise(() => setup('340100000000000010'));
      const { auto_create_expenses: _omitted, ...stalePayload } = validUpsertPayload;
      const response = yield* Effect.promise(() =>
        putJson(`/teams/${teamId}/bank-sync`, 'treasurer-token', stalePayload),
      );
      expect(response.status).toBe(200);
    }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// 160 / 161 — the token never appears in any response; fioTokenSet flips; omission preserves it
// ---------------------------------------------------------------------------

describe('bank-sync API — write-only token (160, 161)', () => {
  it.effect('the token never appears in the PUT response body, and fioTokenSet flips true', () =>
    Effect.gen(function* () {
      const { teamId } = yield* Effect.promise(() => setup('340100000000000006'));
      const secretToken = 'a'.repeat(64);
      const response = yield* Effect.promise(() =>
        putJson(`/teams/${teamId}/bank-sync`, 'treasurer-token', {
          ...validUpsertPayload,
          fio_token: secretToken,
        }),
      );
      expect(response.status).toBe(200);
      const bodyText = yield* Effect.promise(() => response.text());
      expect(bodyText).not.toContain(secretToken);
      const body = JSON.parse(bodyText) as { fioTokenSet: boolean };
      expect(body.fioTokenSet).toBe(true);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('a PUT omitting fio_token preserves the stored one (fioTokenSet stays true)', () =>
    Effect.gen(function* () {
      const { teamId } = yield* Effect.promise(() => setup('340100000000000007'));
      const secretToken = 'b'.repeat(64);
      yield* Effect.promise(() =>
        putJson(`/teams/${teamId}/bank-sync`, 'treasurer-token', {
          ...validUpsertPayload,
          fio_token: secretToken,
        }),
      );

      const second = yield* Effect.promise(() =>
        putJson(`/teams/${teamId}/bank-sync`, 'treasurer-token', {
          ...validUpsertPayload,
          recipient_name: 'Nový název',
        }),
      );
      expect(second.status).toBe(200);
      const body = (yield* Effect.promise(() => second.json())) as { fioTokenSet: boolean };
      expect(body.fioTokenSet).toBe(true);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('the token never appears in an error response body either', () =>
    Effect.gen(function* () {
      const { teamId } = yield* Effect.promise(() => setup('340100000000000008'));
      const secretToken = 'c'.repeat(64);
      // An invalid bank_code (not 4 digits) forces a 400, while the payload still carries the
      // token — the token must not leak into the error body either.
      const response = yield* Effect.promise(() =>
        putJson(`/teams/${teamId}/bank-sync`, 'treasurer-token', {
          ...validUpsertPayload,
          bank_code: '1',
          fio_token: secretToken,
        }),
      );
      const bodyText = yield* Effect.promise(() => response.text());
      expect(bodyText).not.toContain(secretToken);
    }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// 162 / 163 — export content types
// ---------------------------------------------------------------------------

describe('bank-sync API — export content types (162, 163)', () => {
  // No `bank_statement_periods` are seeded, so the requested range is entirely a coverage gap —
  // `acknowledgeGaps=true` bypasses D13's gate so this test can focus on content-type/filename
  // safety; the gate itself is test 164 below.
  it.effect('export.csv responds text/csv; UTF-8 with a sane content-disposition filename', () =>
    Effect.gen(function* () {
      const { teamId } = yield* Effect.promise(() => setup('340100000000000009'));
      const response = yield* Effect.promise(() =>
        get(
          `/teams/${teamId}/bank-transactions/export.csv?acknowledgeGaps=true`,
          'treasurer-token',
        ),
      );
      expect(response.headers.get('content-type')).toContain('text/csv');
      const disposition = response.headers.get('content-disposition') ?? '';
      // `attachment; filename=...` legitimately contains a `;` and a space as structural
      // separators between the disposition type and the `filename` parameter — checking the
      // WHOLE header value against `/[\r\n";,]/` rejects every valid content-disposition header,
      // including this well-formed one. The property actually worth asserting is that the
      // FILENAME value itself carries no header-injection or quoting-breakout characters (CR/LF,
      // `"`, `;`, `,`) — those are the characters that would let untrusted data escape the
      // `filename=` parameter, and `disposition` must start with the expected structural prefix.
      expect(disposition.startsWith('attachment; filename=')).toBe(true);
      const filename = disposition.slice('attachment; filename='.length);
      expect(filename.length).toBeGreaterThan(0);
      expect(filename).not.toMatch(/[\r\n";,]/);

      // The body itself must still be a well-formed CSV: header row first, no leading BOM/prose
      // that would make a spreadsheet app misread the header (mirrors the check in test 164).
      const text = yield* Effect.promise(() => response.text());
      const withoutBom = text.startsWith('﻿') ? text.slice(1) : text;
      const firstLine = withoutBom.split(/\r\n|\n/)[0] ?? '';
      expect(firstLine.startsWith('Datum')).toBe(true);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('export.pdf responds application/pdf, body starts %PDF-', () =>
    Effect.gen(function* () {
      const { teamId } = yield* Effect.promise(() => setup('340100000000000010'));
      const response = yield* Effect.promise(() =>
        get(`/teams/${teamId}/bank-transactions/export.pdf`, 'treasurer-token'),
      );
      expect(response.headers.get('content-type')).toContain('application/pdf');
      const buf = yield* Effect.promise(() => response.arrayBuffer());
      const head = Buffer.from(buf.slice(0, 5)).toString('ascii');
      expect(head).toBe('%PDF-');
    }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// 164 — the CSV coverage gate (D13)
// ---------------------------------------------------------------------------

describe('bank-sync API — CSV coverage gate (164)', () => {
  it.effect(
    'a coverage gap -> 409 ExportCoverageIncomplete; ?acknowledgeGaps=true -> 200 with the gap header',
    () =>
      Effect.gen(function* () {
        const { teamId } = yield* Effect.promise(() => setup('340100000000000013'));

        const blocked = yield* Effect.promise(() =>
          get(`/teams/${teamId}/bank-transactions/export.csv`, 'treasurer-token'),
        );
        expect(blocked.status).toBe(409);

        const acknowledged = yield* Effect.promise(() =>
          get(
            `/teams/${teamId}/bank-transactions/export.csv?acknowledgeGaps=true`,
            'treasurer-token',
          ),
        );
        expect(acknowledged.status).toBe(200);
        expect(acknowledged.headers.get('x-export-coverage-gaps')).not.toBeNull();

        // Blocker 3: no comment/free-text line precedes the header row (a BOM followed by prose
        // would make Excel treat that line as the header).
        const text = yield* Effect.promise(() => acknowledged.text());
        const withoutBom = text.startsWith('﻿') ? text.slice(1) : text;
        const firstLine = withoutBom.split(/\r\n/)[0] ?? '';
        expect(firstLine.startsWith('Datum')).toBe(true);
      }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// 165 — /rematch twice concurrently -> the second gets 409 BankSyncBusy
// ---------------------------------------------------------------------------

describe('bank-sync API — /rematch lease (165)', () => {
  it.effect('two concurrent /rematch calls: the second gets 409 BankSyncBusy', () =>
    Effect.gen(function* () {
      const { teamId } = yield* Effect.promise(() => setup('340100000000000011'));
      yield* Effect.promise(() =>
        putJson(`/teams/${teamId}/bank-sync`, 'treasurer-token', validUpsertPayload),
      );

      const [first, second] = yield* Effect.all(
        [
          Effect.promise(() =>
            post(`/teams/${teamId}/bank-transactions/rematch`, 'treasurer-token'),
          ),
          Effect.promise(() =>
            post(`/teams/${teamId}/bank-transactions/rematch`, 'treasurer-token'),
          ),
        ],
        { concurrency: 'unbounded' },
      );
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);
    }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// 166 — qr.png containment, including the cross-fee case
// ---------------------------------------------------------------------------

describe('bank-sync API — qr.png containment (166)', () => {
  it.effect("a member requesting ANOTHER member's assignment under a fee they can see -> 403", () =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup('340100000000000012'));
      const secretToken = yield* encryptFioTestToken('qr-test-token');
      yield* enableBankSync(teamId, treasurerId, {
        recipientName: 'Klub',
        fioTokenEncrypted: Option.some(secretToken),
      });

      const victimUserId = yield* createUser(nextDiscordId(), 'victim');
      const victimMember = yield* createTeamMember(teamId, victimUserId);
      yield* setMemberVariableSymbol(victimMember.id, '55555');
      const { fee, assignment } = yield* createFeeAndAssignment(teamId, victimMember.id, 1500);

      const attackerUserId = yield* createUser(nextDiscordId(), 'attacker');
      yield* createTeamMember(teamId, attackerUserId);
      sessionsStore.set('attacker-token', attackerUserId);

      const response = yield* Effect.promise(() =>
        get(
          `/teams/${teamId}/fees/${fee.id}/assignments/${assignment.id}/qr.png`,
          'attacker-token',
        ),
      );
      expect(response.status).toBe(403);
    }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// BLOCKER 1 — manual /match had ZERO test coverage. This endpoint records money; every guard
// below is a same-connection re-read under the `bank_transactions` row lock `performManualMatch`
// (`src/api/bank-sync.ts`) already holds, so these tests exercise the REAL HTTP handler, not the
// SQL in isolation.
// ---------------------------------------------------------------------------

describe('bank-sync API — manual /match guards (BLOCKER 1)', () => {
  const seedMatchable = (guildId: string, txAmountMinor: number, outstandingMinor: number) =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup(guildId));
      const memberUserId = yield* createUser(nextDiscordId(), 'member').pipe(
        Effect.provide(SeedLayer),
      );
      const { member, assignment } = yield* Effect.gen(function* () {
        const m = yield* createTeamMember(teamId, memberUserId);
        yield* setMemberVariableSymbol(m.id, '12345');
        const { assignment: a } = yield* createFeeAndAssignment(teamId, m.id, outstandingMinor);
        return { member: m, assignment: a };
      }).pipe(Effect.provide(SeedLayer));
      const txId = yield* insertBankTransaction(teamId, {
        fioMovementId: Math.floor(Math.random() * 1_000_000),
        bookedOn: '2024-03-01',
        amountMinor: txAmountMinor,
      }).pipe(Effect.provide(SeedLayer));
      return { teamId, treasurerId, memberId: member.id, assignmentId: assignment.id, txId };
    });

  it.effect(
    'rejects a split allocation set whose sum exceeds the transaction amount (unbalanced)',
    () =>
      Effect.gen(function* () {
        const { teamId, memberId, assignmentId, txId } = yield* seedMatchable(
          '340100000000000101',
          3000,
          5000,
        );
        // A second assignment to split against, so this is a genuine multi-row allocation.
        const secondAssignment = yield* createFeeAndAssignment(teamId, memberId, 5000, {
          name: 'Druhý příspěvek',
        }).pipe(Effect.provide(SeedLayer));

        const response = yield* Effect.promise(() =>
          post(`/teams/${teamId}/bank-transactions/${txId}/match`, 'treasurer-token', {
            allocations: [
              { assignmentId, amountMinor: 2000 },
              { assignmentId: secondAssignment.assignment.id, amountMinor: 2000 },
            ],
          }),
        );
        // 2000 + 2000 = 4000 > the transaction's 3000.
        expect(response.status).toBe(409);
        const bodyText = yield* Effect.promise(() => response.text());
        expect(bodyText).toContain('AllocationExceedsTransaction');
      }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect(
    'rejects a single allocation whose amount exceeds the transaction amount (over-allocation)',
    () =>
      Effect.gen(function* () {
        const { teamId, assignmentId, txId } = yield* seedMatchable(
          '340100000000000102',
          1000,
          5000,
        );

        const response = yield* Effect.promise(() =>
          post(`/teams/${teamId}/bank-transactions/${txId}/match`, 'treasurer-token', {
            allocations: [{ assignmentId, amountMinor: 1500 }],
          }),
        );
        expect(response.status).toBe(409);
        const bodyText = yield* Effect.promise(() => response.text());
        expect(bodyText).toContain('AllocationExceedsTransaction');
      }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect(
    'double-submit on a partially-matched transaction is rejected, not double-recorded',
    () =>
      Effect.gen(function* () {
        const { teamId, assignmentId, txId } = yield* seedMatchable(
          '340100000000000103',
          1000,
          5000,
        );

        const firstPayload = {
          allocations: [{ assignmentId, amountMinor: 600 }],
        };
        const first = yield* Effect.promise(() =>
          post(`/teams/${teamId}/bank-transactions/${txId}/match`, 'treasurer-token', firstPayload),
        );
        expect(first.status).toBe(200);

        // The row is now 'partially_matched' — the OLD guard (`match_state IN
        // ('unmatched','partially_matched')`) alone would let a second, identical request
        // through, inserting a second payment for the same money.
        const second = yield* Effect.promise(() =>
          post(`/teams/${teamId}/bank-transactions/${txId}/match`, 'treasurer-token', firstPayload),
        );
        expect(second.status).toBe(409);
        const bodyText = yield* Effect.promise(() => second.text());
        expect(bodyText).toContain('AllocationExceedsTransaction');

        const sql = yield* SqlClient.SqlClient.asEffect();
        const rows = yield* sql<{ readonly count: string }>`
          SELECT count(*)::text AS count FROM payments
          WHERE bank_transaction_id = ${txId} AND voided_at IS NULL
        `;
        expect(rows[0]?.count).toBe('1');
      }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('rejects a request with two allocations pointing at the SAME assignmentId', () =>
    Effect.gen(function* () {
      const { teamId, assignmentId, txId } = yield* seedMatchable('340100000000000104', 3000, 5000);

      const response = yield* Effect.promise(() =>
        post(`/teams/${teamId}/bank-transactions/${txId}/match`, 'treasurer-token', {
          allocations: [
            { assignmentId, amountMinor: 1000 },
            { assignmentId, amountMinor: 1000 },
          ],
        }),
      );
      expect(response.status).toBe(400);
      const bodyText = yield* Effect.promise(() => response.text());
      expect(bodyText).toContain('DuplicateAllocationAssignment');

      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ readonly count: string }>`
        SELECT count(*)::text AS count FROM payments WHERE bank_transaction_id = ${txId}
      `;
      expect(rows[0]?.count).toBe('0');
    }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// T8-T14 — POST /bank-sync/test: the six-way status mapping table (plan §3.4/§6.3)
// ---------------------------------------------------------------------------

describe('bank-sync API — POST /bank-sync/test — status mapping (T8-T14)', () => {
  it.effect(
    "T8 — ok: a live token returns ok, Fio's IBAN, and the responder WAS invoked (M6 wiring guard)",
    () =>
      Effect.gen(function* () {
        const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
        const token = yield* encryptFioTestToken(TEST_TOKEN);
        yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) });
        fioResponder = (request) => Effect.succeed(jsonResponse(request, 200, validRawStatement));

        const { status, body } = yield* Effect.promise(() => postTest(teamId));
        expect(status).toBe(200);
        expect(body).toEqual({
          ok: true,
          status: 'ok',
          message: null,
          accountIban: 'CZ7120100000002703474850',
        });
        expect(fioCalls).toBe(1);
      }).pipe(Effect.provide(SeedLayer)),
  );

  // Plan `.work-plans/iban-cross-check.md` §9.D — T8b-T8f, the account cross-check.
  it.effect("T8b — account_mismatch: Fio's own IBAN disagrees with the configured account", () =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
      const token = yield* encryptFioTestToken(TEST_TOKEN);
      yield* enableBankSync(teamId, treasurerId, {
        fioTokenEncrypted: Option.some(token),
        accountNumber: '1265098001',
        bankCode: '5500',
      });
      fioResponder = (request) => Effect.succeed(jsonResponse(request, 200, validRawStatement));

      const { body } = yield* Effect.promise(() => postTest(teamId));
      expect(body).toEqual({
        ok: false,
        status: 'account_mismatch',
        message: null,
        accountIban: 'CZ7120100000002703474850',
      });
      expect(fioCalls).toBe(1);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect(
    'T8c — case/whitespace-insensitive: a spaced, lower-cased matching IBAN is still ok',
    () =>
      Effect.gen(function* () {
        const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
        const token = yield* encryptFioTestToken(TEST_TOKEN);
        yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) });
        fioResponder = (request) =>
          Effect.succeed(
            jsonResponse(request, 200, {
              accountStatement: {
                ...validRawStatement.accountStatement,
                info: {
                  ...validRawStatement.accountStatement.info,
                  iban: 'cz71 2010 0000 0027 0347 4850',
                },
              },
            }),
          );

        const { body } = yield* Effect.promise(() => postTest(teamId));
        expect(body).toMatchObject({ status: 'ok', ok: true });
      }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('T8d — no configured account -> ok (no comparison is possible)', () =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
      const token = yield* encryptFioTestToken(TEST_TOKEN);
      // Migration `1792000001:57` forbids `enabled = true` with a null account, so the config is
      // seeded disabled first and the account fields are nulled afterwards.
      yield* enableBankSync(teamId, treasurerId, {
        enabled: false,
        fioTokenEncrypted: Option.some(token),
      });
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`UPDATE bank_sync_config SET account_number = NULL, bank_code = NULL WHERE team_id = ${teamId}`;
      fioResponder = (request) => Effect.succeed(jsonResponse(request, 200, validRawStatement));

      const { body } = yield* Effect.promise(() => postTest(teamId));
      expect(body).toEqual({
        ok: true,
        status: 'ok',
        message: null,
        accountIban: 'CZ7120100000002703474850',
      });
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('T8e — Fio sent no iban at all -> ok (the absent side is not an accusation)', () =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
      const token = yield* encryptFioTestToken(TEST_TOKEN);
      yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) });
      fioResponder = (request) =>
        Effect.succeed(
          jsonResponse(request, 200, {
            accountStatement: {
              ...validRawStatement.accountStatement,
              info: { ...validRawStatement.accountStatement.info, iban: null },
            },
          }),
        );

      const { body } = yield* Effect.promise(() => postTest(teamId));
      expect(body).toEqual({ ok: true, status: 'ok', message: null, accountIban: null });
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect(
    'T8f — a mismatch verdict writes NOTHING: the probe never un-gates clearPollBackoff',
    () =>
      Effect.gen(function* () {
        const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
        const token = yield* encryptFioTestToken(TEST_TOKEN);
        yield* enableBankSync(teamId, treasurerId, {
          fioTokenEncrypted: Option.some(token),
          accountNumber: '1265098001',
          bankCode: '5500',
        });
        const sql = yield* SqlClient.SqlClient.asEffect();
        yield* sql`
          UPDATE bank_sync_config SET
            last_error_code = 'too_many_movements',
            consecutive_failure_count = 2,
            last_error_at = now(),
            next_attempt_at = now() + interval '2 hours',
            coverage_warning = 'x'
          WHERE team_id = ${teamId}
        `;
        const beforeRows = yield* sql<
          Record<string, unknown>
        >`SELECT * FROM bank_sync_config WHERE team_id = ${teamId}`;

        fioResponder = (request) => Effect.succeed(jsonResponse(request, 200, validRawStatement));
        const { body } = yield* Effect.promise(() => postTest(teamId));
        expect(body).toMatchObject({ status: 'account_mismatch' });

        const afterRows = yield* sql<
          Record<string, unknown>
        >`SELECT * FROM bank_sync_config WHERE team_id = ${teamId}`;
        const before = beforeRows[0]!;
        const after = afterRows[0]!;
        // Same diff idiom as T19 — `updated_at` excluded, everything else must be identical. In
        // particular `next_attempt_at` is UNCHANGED at ~+2h: this is the test that fails if
        // someone un-gates `clearPollBackoff` for an `account_mismatch` verdict.
        const changedKeys = Object.keys(before)
          .filter((key) => key !== 'updated_at')
          .filter((key) => {
            const b = before[key];
            const a = after[key];
            if (b instanceof Date && a instanceof Date) return b.getTime() !== a.getTime();
            return b !== a;
          });
        expect(changedKeys).toEqual([]);
      }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('T9 — invalid: a dead token (HTTP 500) is NOT reported ok (the bug)', () =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
      const token = yield* encryptFioTestToken(TEST_TOKEN);
      yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) });
      fioResponder = (request) => Effect.succeed(statusResponse(request, 500));

      const { body } = yield* Effect.promise(() => postTest(teamId));
      expect(body).toEqual({ ok: false, status: 'invalid', message: null, accountIban: null });
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect("T10 — rate_limited: Fio's own 409, never invalid, exactly one request", () =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
      const token = yield* encryptFioTestToken(TEST_TOKEN);
      yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) });
      fioResponder = (request) => Effect.succeed(statusResponse(request, 409));

      const { body } = yield* Effect.promise(() => postTest(teamId));
      expect(body).toMatchObject({ status: 'rate_limited', ok: false });
      // No 90s ladder here — `probeFio` builds its client with `retryRateLimited: false`.
      expect(fioCalls).toBe(1);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('T11 — history_locked: HTTP 422', () =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
      const token = yield* encryptFioTestToken(TEST_TOKEN);
      yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) });
      fioResponder = (request) => Effect.succeed(statusResponse(request, 422));

      const { body } = yield* Effect.promise(() => postTest(teamId));
      expect(body).toMatchObject({ status: 'history_locked', ok: false });
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('T12 — unreachable: a transport failure is NOT reported invalid', () =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
      const token = yield* encryptFioTestToken(TEST_TOKEN);
      yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) });
      fioResponder = (request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error('ECONNRESET'),
            }),
          }),
        );

      const { body } = yield* Effect.promise(() => postTest(teamId));
      const parsed = body as { status: string };
      expect(parsed.status).toBe('unreachable');
      expect(parsed.status).not.toBe('invalid');
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('T13 — unreachable: HTTP 200 with an undecodable body', () =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
      const token = yield* encryptFioTestToken(TEST_TOKEN);
      yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) });
      fioResponder = (request) =>
        Effect.succeed(jsonResponse(request, 200, { not: 'a statement' }));

      const { body } = yield* Effect.promise(() => postTest(teamId));
      expect(body).toMatchObject({ status: 'unreachable', ok: false });
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('T14 — unreachable: HTTP 404', () =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
      const token = yield* encryptFioTestToken(TEST_TOKEN);
      yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) });
      fioResponder = (request) => Effect.succeed(statusResponse(request, 404));

      const { body } = yield* Effect.promise(() => postTest(teamId));
      expect(body).toMatchObject({ status: 'unreachable', ok: false });
    }).pipe(Effect.provide(SeedLayer)),
  );

  // T14b — the regression guard for the `FioServerError`/`FioUnreachable` split (coverage-gap
  // review): a non-500 5xx (a Fio maintenance blip, a gateway timeout — nothing to do with the
  // token) must NOT be reported `invalid`. Without this, re-collapsing
  // `FioApiClient.ts`'s `decodeContained` back to `status !== 200 -> FioServerError` ships the
  // "revoke your good token during a Fio outage" bug this whole fix exists to prevent, and only
  // T9 (which always sends 500) would still be green.
  it.effect('T14b — unreachable: HTTP 503 (a non-500 5xx status), NOT reported invalid', () =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
      const token = yield* encryptFioTestToken(TEST_TOKEN);
      yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) });
      fioResponder = (request) => Effect.succeed(statusResponse(request, 503));

      const { body } = yield* Effect.promise(() => postTest(teamId));
      expect(body).toMatchObject({ status: 'unreachable', ok: false });
    }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// T15-T17 — no_token / misconfigured (key missing) / invalid (undecryptable ciphertext) (B3)
// ---------------------------------------------------------------------------

describe('bank-sync API — POST /bank-sync/test — no_token / misconfigured / invalid decrypt (T15-T17)', () => {
  it.effect('T15 — no_token: a config with no stored token, responder never called', () =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
      yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.none() });
      fioResponder = () => Effect.die(new Error('must not be called — no token to probe'));

      const { body } = yield* Effect.promise(() => postTest(teamId));
      expect(body).toEqual({ ok: false, status: 'no_token', message: null, accountIban: null });
      expect(fioCalls).toBe(0);
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect(
    'T16 — misconfigured: the encryption key is genuinely missing (B3, split from T17)',
    () =>
      Effect.gen(function* () {
        const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
        const token = yield* encryptFioTestToken(TEST_TOKEN);
        yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) });
        fioResponder = () => Effect.die(new Error('must not be called — key is missing'));

        const { body } = yield* Effect.promise(() => postTestNoKey(teamId));
        expect(body).toMatchObject({ status: 'misconfigured', ok: false });
        expect(fioCalls).toBe(0);
      }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('T17 — invalid: a ciphertext the (present) key cannot decrypt (B3)', () =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
      yield* enableBankSync(teamId, treasurerId, {});
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`UPDATE bank_sync_config SET fio_token_encrypted = 'v1.aaaa.bbbb.cccc' WHERE team_id = ${teamId}`;
      fioResponder = () => Effect.die(new Error('must not be called — decrypt fails first'));

      const { body } = yield* Effect.promise(() => postTest(teamId));
      // NOT 'misconfigured' — that copy says "your token is fine", which is false here.
      expect(body).toMatchObject({ status: 'invalid', ok: false });
      expect(fioCalls).toBe(0);
    }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// T18/T19 — B1 regression guard: a successful probe must not whitewash a failing 14-day poll
// ---------------------------------------------------------------------------

describe('bank-sync API — POST /bank-sync/test — B1 masking regression guard (T18/T19)', () => {
  it.effect(
    'T18 — a 200 on the 2-day probe window does not clear the D11 failing-poll bookkeeping',
    () =>
      Effect.gen(function* () {
        const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
        const token = yield* encryptFioTestToken(TEST_TOKEN);
        yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) });
        const sql = yield* SqlClient.SqlClient.asEffect();
        yield* sql`
          UPDATE bank_sync_config SET
            last_error_code = 'too_many_movements',
            consecutive_failure_count = 2,
            last_error_at = now(),
            next_attempt_at = now() + interval '2 hours',
            coverage_warning = 'x'
          WHERE team_id = ${teamId}
        `;

        fioResponder = (request) => Effect.succeed(jsonResponse(request, 200, validRawStatement));
        const { body } = yield* Effect.promise(() => postTest(teamId));
        // Exposed by the account cross-check: this only stays 'ok' because `validRawStatement`'s
        // `info` was fixed above to agree with `enableBankSync`'s default account.
        expect(body).toMatchObject({ status: 'ok', ok: true });

        const rows = yield* sql<{
          last_error_code: string | null;
          consecutive_failure_count: number;
          last_success_at: Date | null;
          coverage_warning: string | null;
          next_attempt_at: Date | null;
        }>`
          SELECT last_error_code, consecutive_failure_count, last_success_at, coverage_warning,
                 next_attempt_at
          FROM bank_sync_config WHERE team_id = ${teamId}
        `;
        expect(rows[0]?.last_error_code).toBe('too_many_movements');
        expect(rows[0]?.consecutive_failure_count).toBe(2);
        expect(rows[0]?.coverage_warning).toBe('x');
        // Never touched by `recordSuccess` (never called) or `clearPollBackoff` (only clears
        // `next_attempt_at`) — still NULL, exactly as it was before the probe.
        expect(rows[0]?.last_success_at).toBeNull();
        expect(rows[0]?.next_attempt_at).toBeNull();

        const configResponse = yield* Effect.promise(() =>
          get(`/teams/${teamId}/bank-sync`, 'treasurer-token'),
        );
        const configBody = (yield* Effect.promise(() => configResponse.json())) as {
          status: string;
        };
        // `last_error_code = 'too_many_movements'` is not `'fio_error'`, so `isFioError` is false
        // and D11 lands the config at rank 5 regardless of `consecutive_failure_count` — the
        // green test result above must not have changed that.
        expect(configBody.status).toBe('sync_failing');
      }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('T19 — success clears ONLY the poll backoff (next_attempt_at), nothing else', () =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
      const token = yield* encryptFioTestToken(TEST_TOKEN);
      yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) });
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`
        UPDATE bank_sync_config SET
          last_error_code = 'too_many_movements',
          consecutive_failure_count = 2,
          last_error_at = now(),
          next_attempt_at = now() + interval '2 hours',
          coverage_warning = 'x'
        WHERE team_id = ${teamId}
      `;
      const beforeRows = yield* sql<
        Record<string, unknown>
      >`SELECT * FROM bank_sync_config WHERE team_id = ${teamId}`;

      fioResponder = (request) => Effect.succeed(jsonResponse(request, 200, validRawStatement));
      yield* Effect.promise(() => postTest(teamId));

      const afterRows = yield* sql<
        Record<string, unknown>
      >`SELECT * FROM bank_sync_config WHERE team_id = ${teamId}`;
      const before = beforeRows[0]!;
      const after = afterRows[0]!;
      // `updated_at` is excluded from the diff on purpose — EVERY write (including the
      // `clearPollBackoff` UPDATE) bumps it, so it is not a "business field" for this
      // assertion's purpose; the property under test is which of `next_attempt_at`,
      // `last_error_code`, `consecutive_failure_count`, `coverage_warning`, `last_success_at`
      // etc. actually moved.
      const changedKeys = Object.keys(before)
        .filter((key) => key !== 'updated_at')
        .filter((key) => {
          const b = before[key];
          const a = after[key];
          if (b instanceof Date && a instanceof Date) return b.getTime() !== a.getTime();
          return b !== a;
        });
      expect(changedKeys).toEqual(['next_attempt_at']);
      expect(before.next_attempt_at).not.toBeNull();
      expect(after.next_attempt_at).toBeNull();
    }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// T20 — a failing probe writes NOTHING (B4 — separate cleanDatabase per case via it.effect.each)
// ---------------------------------------------------------------------------

const T20_CASES: ReadonlyArray<{
  readonly label: string;
  readonly status: string;
  readonly respond: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;
}> = [
  {
    label: 'HTTP 500',
    status: 'invalid',
    respond: (request) => Effect.succeed(statusResponse(request, 500)),
  },
  {
    label: 'HTTP 409',
    status: 'rate_limited',
    respond: (request) => Effect.succeed(statusResponse(request, 409)),
  },
  {
    label: 'HTTP 422',
    status: 'history_locked',
    respond: (request) => Effect.succeed(statusResponse(request, 422)),
  },
  {
    label: 'HTTP 404',
    status: 'unreachable',
    respond: (request) => Effect.succeed(statusResponse(request, 404)),
  },
  {
    label: 'transport failure',
    status: 'unreachable',
    respond: (request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new Error('ECONNRESET') }),
        }),
      ),
  },
];

describe('bank-sync API — POST /bank-sync/test — a failing probe writes nothing (T20)', () => {
  // Coverage-gap review: the original body only asserted the three DB columns were untouched,
  // which would ALSO pass if the endpoint short-circuited before ever calling `fioResponder` (the
  // exact B-2 failure mode). Asserting `fioCalls` and the returned `status` first proves the
  // probe actually ran its course before the "nothing written" claim means anything.
  it.effect.each(T20_CASES)(
    '$label leaves consecutive_failure_count / next_attempt_at / last_error_code untouched',
    ({ respond, status }) =>
      Effect.gen(function* () {
        const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
        const token = yield* encryptFioTestToken(TEST_TOKEN);
        yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) });
        fioResponder = respond;

        const sql = yield* SqlClient.SqlClient.asEffect();
        const { body } = yield* Effect.promise(() => postTest(teamId));
        expect(body).toMatchObject({ status });
        expect(fioCalls).toBe(1);

        const rows = yield* sql<{
          consecutive_failure_count: number;
          next_attempt_at: Date | null;
          last_error_code: string | null;
        }>`
          SELECT consecutive_failure_count, next_attempt_at, last_error_code
          FROM bank_sync_config WHERE team_id = ${teamId}
        `;
        expect(rows[0]?.consecutive_failure_count).toBe(0);
        // `next_attempt_at IS NULL`, so `findPollableQuery` still considers this team eligible.
        expect(rows[0]?.next_attempt_at).toBeNull();
        expect(rows[0]?.last_error_code).toBeNull();
      }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// T21 — throttle pre-check: a second probe within 30s answers rate_limited INSTANTLY (M1)
// ---------------------------------------------------------------------------

describe('bank-sync API — POST /bank-sync/test — throttle pre-check (T21)', () => {
  it.effect('a second probe on the same token within 30s answers rate_limited with no sleep', () =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
      const token = yield* encryptFioTestToken(TEST_TOKEN);
      yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) });
      fioResponder = (request) => Effect.succeed(jsonResponse(request, 200, validRawStatement));

      const first = yield* Effect.promise(() => postTest(teamId));
      // Also exposed by the account cross-check — same reason as T18's note above.
      expect(first.body).toMatchObject({ status: 'ok' });

      const second = yield* Effect.promise(() => postTest(teamId));
      expect(second.body).toMatchObject({ status: 'rate_limited', ok: false });

      // The throttle budget check is ATOMIC with the reservation itself
      // (`FioApiClient.ts`'s `maxThrottleWaitSeconds`-guarded UPSERT `WHERE` clause): the second
      // call's reservation attempt finds the slot the first call took still busy well beyond the
      // 2s precheck budget, so the guarded conflict UPDATE takes no action and returns zero rows
      // — no slot is burned, and the second call never reaches Fio. Only the FIRST call ever hits
      // Fio.
      expect(fioCalls).toBe(1);
    }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// T22 — token containment: no response field carries the token or the Fio host
// ---------------------------------------------------------------------------

// B-2 (BLOCKER, coverage-gap review) — the original version of this test ran all six cases inside
// ONE `it.effect` sharing ONE `TEST_TOKEN`, so `cleanDatabase` ran once and every case shared the
// SAME throttle fingerprint: case 1 reserved the 30s slot and actually called `fioResponder`,
// cases 2-6 short-circuited to `rate_limited` WITHOUT ever invoking it, so their assertions
// passed vacuously against a `rate_limited` body that never exercised the 500/409/422/404/
// transport containment paths at all. Each case below now gets its OWN distinct 64-char token
// (-> its own throttle fingerprint) and its own `cleanDatabase` via `it.effect.each` (the same
// idiom T20/T26 already use correctly), and asserts `fioCalls === 1` so this test can never again
// pass without actually exercising its path.
const T22_CASES: ReadonlyArray<{
  readonly label: string;
  readonly token: string;
  readonly respond: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;
}> = [
  {
    label: 'ok (200)',
    token: 'c'.repeat(64),
    respond: (request) => Effect.succeed(jsonResponse(request, 200, validRawStatement)),
  },
  {
    label: 'HTTP 500',
    token: 'd'.repeat(64),
    respond: (request) => Effect.succeed(statusResponse(request, 500)),
  },
  {
    label: 'HTTP 409',
    token: 'e'.repeat(64),
    respond: (request) => Effect.succeed(statusResponse(request, 409)),
  },
  {
    label: 'HTTP 422',
    token: 'f'.repeat(64),
    respond: (request) => Effect.succeed(statusResponse(request, 422)),
  },
  {
    label: 'HTTP 404',
    token: 'g'.repeat(64),
    respond: (request) => Effect.succeed(statusResponse(request, 404)),
  },
  {
    label: 'transport failure',
    token: 'h'.repeat(64),
    respond: (request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            cause: new Error('boom'),
          }),
        }),
      ),
  },
];

describe('bank-sync API — POST /bank-sync/test — token containment (T22)', () => {
  it.effect.each(T22_CASES)(
    '$label — no token or Fio host leaks into the response body, and the responder actually ran',
    ({ token, respond }) =>
      Effect.gen(function* () {
        const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
        const encrypted = yield* encryptFioTestToken(token);
        yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(encrypted) });
        fioResponder = respond;

        const { text } = yield* Effect.promise(() => postTest(teamId));
        // Proves the responder for THIS case's status actually ran — the B-2 short-circuit
        // failure mode (a stale throttle slot from a different case) would leave this at 0.
        expect(fioCalls).toBe(1);
        expect(text).not.toContain(token);
        expect(text).not.toContain('fioapi.fio.cz');
      }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// T23 — the probe asks for exactly a two-day window ending today (UTC) (B6-safe capture)
// ---------------------------------------------------------------------------

/** `{ from, to }` the endpoint's `PROBE_WINDOW_BACK_DAYS` window ought to produce for a request
 * issued "now" (UTC). Pulled into a helper because T23 below must call this TWICE — once before
 * the request and once after — and accept either result. */
const expectedProbeWindow = (): { readonly from: string; readonly to: string } => {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return { from: yesterday.toISOString().slice(0, 10), to };
};

describe('bank-sync API — POST /bank-sync/test — probe window (T23)', () => {
  it.effect(
    'probes exactly [yesterday(UTC), today(UTC)] — captured redacted, never the raw URL',
    () =>
      Effect.gen(function* () {
        const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
        const token = yield* encryptFioTestToken(TEST_TOKEN);
        yield* enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) });

        // Captured BEFORE the request too: computing the expected pair only AFTER issuing the
        // request (as this test originally did) can straddle UTC midnight — a run landing there
        // would compare a server-computed `D` against a locally-computed `D+1`. This repo has
        // already shipped that exact flake class once (commit 2258ceef). Accept either the
        // before- or after-request pair rather than picking one arbitrarily.
        const before = expectedProbeWindow();

        // B6 — redact AT CAPTURE TIME: only the date path segments are ever stored. The raw
        // `request.url` (which embeds the 64-char token) never reaches a variable this test
        // diffs, asserts on, or that vitest could print in a failure message.
        let captured: { from?: string; to?: string } = {};
        fioResponder = (request) => {
          const seg = new URL(request.url).pathname.split('/');
          captured = { from: seg[5], to: seg[6] };
          return Effect.succeed(jsonResponse(request, 200, validRawStatement));
        };

        yield* Effect.promise(() => postTest(teamId));

        const after = expectedProbeWindow();

        expect([before.from, after.from]).toContain(captured.from);
        expect([before.to, after.to]).toContain(captured.to);
      }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// T24/T25 — prologue unchanged: 403 without permission, 404 without a config row
// ---------------------------------------------------------------------------

describe('bank-sync API — POST /bank-sync/test — prologue (T24/T25)', () => {
  it.effect('T24 — 403 for a member without finance:manage_fees', () =>
    Effect.gen(function* () {
      const { teamId } = yield* Effect.promise(() => setup(nextGuildId()));
      const response = yield* Effect.promise(() =>
        post(`/teams/${teamId}/bank-sync/test`, 'captain-token'),
      );
      expect(response.status).toBe(403);
      const text = yield* Effect.promise(() => response.text());
      expect(text).toContain('BankSyncForbidden');
    }).pipe(Effect.provide(SeedLayer)),
  );

  it.effect('T25 — 404 when no bank_sync_config row exists', () =>
    Effect.gen(function* () {
      const { teamId } = yield* Effect.promise(() => setup(nextGuildId()));
      const response = yield* Effect.promise(() =>
        post(`/teams/${teamId}/bank-sync/test`, 'treasurer-token'),
      );
      expect(response.status).toBe(404);
      const text = yield* Effect.promise(() => response.text());
      expect(text).toContain('BankSyncNotConfigured');
    }).pipe(Effect.provide(SeedLayer)),
  );
});

// ---------------------------------------------------------------------------
// T26 — contract invariant: ok === (status === 'ok'), across the T8/T9/T10/T15/T17 setups
// ---------------------------------------------------------------------------

const T26_CASES: ReadonlyArray<{
  readonly label: string;
  readonly seed: (
    teamId: Team.TeamId,
    treasurerId: User.UserId,
  ) => Effect.Effect<unknown, unknown, SqlClient.SqlClient>;
}> = [
  {
    label: 'ok (T8 setup)',
    seed: (teamId, treasurerId) =>
      encryptFioTestToken(TEST_TOKEN).pipe(
        Effect.flatMap((token) =>
          enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            fioResponder = (request) =>
              Effect.succeed(jsonResponse(request, 200, validRawStatement));
          }),
        ),
      ),
  },
  {
    label: 'invalid — dead token (T9 setup)',
    seed: (teamId, treasurerId) =>
      encryptFioTestToken(TEST_TOKEN).pipe(
        Effect.flatMap((token) =>
          enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            fioResponder = (request) => Effect.succeed(statusResponse(request, 500));
          }),
        ),
      ),
  },
  {
    label: 'rate_limited (T10 setup)',
    seed: (teamId, treasurerId) =>
      encryptFioTestToken(TEST_TOKEN).pipe(
        Effect.flatMap((token) =>
          enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.some(token) }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            fioResponder = (request) => Effect.succeed(statusResponse(request, 409));
          }),
        ),
      ),
  },
  {
    label: 'no_token (T15 setup)',
    seed: (teamId, treasurerId) =>
      enableBankSync(teamId, treasurerId, { fioTokenEncrypted: Option.none() }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            fioResponder = () => Effect.die(new Error('must not be called'));
          }),
        ),
      ),
  },
  {
    label: 'invalid — undecryptable ciphertext (T17 setup)',
    seed: (teamId, treasurerId) =>
      enableBankSync(teamId, treasurerId, {}).pipe(
        Effect.flatMap(() => SqlClient.SqlClient.asEffect()),
        Effect.flatMap(
          (sql) =>
            sql`UPDATE bank_sync_config SET fio_token_encrypted = 'v1.aaaa.bbbb.cccc' WHERE team_id = ${teamId}`,
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            fioResponder = () => Effect.die(new Error('must not be called'));
          }),
        ),
        Effect.asVoid,
      ),
  },
];

describe('bank-sync API — POST /bank-sync/test — contract invariant ok === (status === ok) (T26)', () => {
  it.effect.each(T26_CASES)('$label', ({ seed }) =>
    Effect.gen(function* () {
      const { teamId, treasurerId } = yield* Effect.promise(() => setup(nextGuildId()));
      yield* seed(teamId, treasurerId);
      const { body } = yield* Effect.promise(() => postTest(teamId));
      const parsed = body as { ok: boolean; status: string };
      expect(parsed.ok).toBe(parsed.status === 'ok');
    }).pipe(Effect.provide(SeedLayer)),
  );
});
