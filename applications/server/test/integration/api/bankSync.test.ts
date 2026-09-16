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
import { HttpRouter, HttpServer } from 'effect/unstable/http';
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

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(BankSyncApiLive),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provideMerge(RealRepos),
  Layer.provideMerge(TestPgClient),
);

const SeedLayer = RealRepos.pipe(Layer.provideMerge(TestPgClient));

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const app = HttpRouter.toWebHandler(TestLayer);
  handler = app.handler;
  dispose = app.dispose;
});

afterAll(async () => {
  await dispose();
});

beforeEach(async () => {
  await cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise);
  sessionsStore = new Map();
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
