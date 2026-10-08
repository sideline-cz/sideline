// TDD — written BEFORE the three attachment endpoints exist (plan Task 7b). Until Task 3
// lands, this file fails at module resolution (`ExpenseAttachmentsRepository`,
// `expenseAttachmentLimits`); once the layer builds, the remaining red is 404/500 from the
// handlers. Both are the correct first red.
//
// Harness follows `bankSync.test.ts`: a "SmallApi" holding ONLY `ExpenseApi.ExpenseApiGroup`,
// served over REAL repositories against `TestPgClient`, with a hand-rolled `SessionsRepository`
// mock (token -> userId) standing in for cookie auth. Treasurer has `finance:manage_fees`;
// Captain is the `finance:view`-only reader.

import { describe, expect, it } from '@effect/vitest';
import type { Team, User } from '@sideline/domain';
import { ExpenseApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { ExpenseApiLive } from '~/api/expenses.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { BankTransactionsRepository } from '~/repositories/BankTransactionsRepository.js';
import { ExpenseAttachmentsRepository } from '~/repositories/ExpenseAttachmentsRepository.js';
import { ExpensesRepository } from '~/repositories/ExpensesRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { MAX_EXPENSE_ATTACHMENT_BYTES } from '~/services/expenseAttachmentLimits.js';
import { createTeam, createTeamMember, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const SmallApi = HttpApi.make('api').add(ExpenseApi.ExpenseApiGroup);

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

const RealRepos = Layer.mergeAll(
  UsersRepository.Default,
  TeamsRepository.Default,
  TeamMembersRepository.Default,
  RolesRepository.Default,
  ExpensesRepository.Default,
  ExpenseAttachmentsRepository.Default,
  BankTransactionsRepository.Default,
);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(ExpenseApiLive),
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const assignRole = (teamId: Team.TeamId, userId: User.UserId, roleName: string) =>
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
        Effect.andThen((repo) => repo.assignRole(tm.id, role.id)),
      ),
    ),
    Effect.map(({ tm }) => tm.id),
  );

/** One team with a treasurer, a captain and an unrelated outsider. Tokens are `<prefix>-*`. */
const setupTeam = (prefix: string) =>
  Effect.gen(function* () {
    const treasurer = yield* createUser(`${prefix}-treasurer`, nextDiscordId());
    const team = yield* createTeam(nextDiscordId(), treasurer.id, `${prefix} FC`);
    yield* assignRole(team.id, treasurer.id, 'Treasurer');
    sessionsStore.set(`${prefix}-treasurer-token`, treasurer.id);

    const captain = yield* createUser(`${prefix}-captain`, nextDiscordId());
    yield* assignRole(team.id, captain.id, 'Captain');
    sessionsStore.set(`${prefix}-captain-token`, captain.id);

    const outsider = yield* createUser(`${prefix}-outsider`, nextDiscordId());
    sessionsStore.set(`${prefix}-outsider-token`, outsider.id);

    return { teamId: team.id as string, treasurerId: treasurer.id, captainId: captain.id };
  }).pipe(Effect.provide(SeedLayer), Effect.runPromise);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const get = (path: string, token: string) =>
  handler(new Request(`${HOST}${path}`, { headers: { Authorization: `Bearer ${token}` } }));

const post = (path: string, token: string, body: unknown) =>
  handler(
    new Request(`${HOST}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const del = (path: string, token: string) =>
  handler(
    new Request(`${HOST}${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }),
  );

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

const pdfOfSize = (size: number): Uint8Array => {
  const out = new Uint8Array(size);
  out.set(PDF.subarray(0, Math.min(PDF.length, size)), 0);
  return out;
};

type AttachmentMetaBody = {
  attachmentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
};

const createExpense = async (teamId: string, token: string, description: string) => {
  const res = await post(`/teams/${teamId}/expenses`, token, {
    amountMinor: 25_000,
    currency: 'CZK',
    spentAt: '2025-05-01T12:00:00.000Z',
    category: 'fields',
    description,
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { expenseId: string };
  return body.expenseId;
};

const uploadPath = (teamId: string, expenseId: string) =>
  `/teams/${teamId}/expenses/${expenseId}/attachments`;

const attachmentPath = (teamId: string, expenseId: string, attachmentId: string) =>
  `${uploadPath(teamId, expenseId)}/${attachmentId}`;

const postAttachment = (
  teamId: string,
  expenseId: string,
  token: string,
  body: { filename: string; contentType: string; contentBase64: string },
) => post(uploadPath(teamId, expenseId), token, body);

const uploadPdf = async (
  teamId: string,
  expenseId: string,
  token: string,
  filename = 'invoice.pdf',
) => {
  const res = await postAttachment(teamId, expenseId, token, {
    filename,
    contentType: 'application/pdf',
    contentBase64: b64(PDF),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as AttachmentMetaBody;
};

const countAttachments = (expenseId?: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      expenseId === undefined
        ? sql`SELECT count(*)::int AS count FROM expense_attachments`
        : sql`SELECT count(*)::int AS count FROM expense_attachments WHERE expense_id = ${expenseId}`,
    ),
    Effect.map((rows) => (rows[0] as { count: number }).count),
    Effect.provide(TestPgClient),
    Effect.runPromise,
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('expense attachments — round trip', () => {
  it('should return the same bytes on download that were uploaded', async () => {
    const { teamId } = await setupTeam('a');
    const expenseId = await createExpense(teamId, 'a-treasurer-token', 'Pitch rent');

    const meta = await uploadPdf(teamId, expenseId, 'a-treasurer-token');
    expect(meta.filename).toBe('invoice.pdf');
    expect(meta.contentType).toBe('application/pdf');
    expect(meta.sizeBytes).toBe(PDF.length);
    expect(typeof meta.attachmentId).toBe('string');

    const res = await get(
      attachmentPath(teamId, expenseId, meta.attachmentId),
      'a-treasurer-token',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="invoice.pdf"; filename*=UTF-8\'\'invoice.pdf',
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
  });

  // A non-latin1 character in `content-disposition` makes Node's `writeHead` throw
  // `ERR_INVALID_CHAR`, so a Czech-named invoice used to upload fine and then 500 on every
  // download. This runs through the real HTTP stack, which is the only place that reproduces it.
  it('should download an attachment whose filename is not ASCII', async () => {
    const { teamId } = await setupTeam('a');
    const expenseId = await createExpense(teamId, 'a-treasurer-token', 'Pitch rent');
    const meta = await uploadPdf(teamId, expenseId, 'a-treasurer-token', 'Faktura_kv\u011bten.pdf');

    const res = await get(
      attachmentPath(teamId, expenseId, meta.attachmentId),
      'a-treasurer-token',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="Faktura_kv_ten.pdf"; filename*=UTF-8\'\'Faktura_kv%C4%9Bten.pdf',
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
  });

  it('should carry attachment metadata and never bytes on the expense views', async () => {
    const { teamId } = await setupTeam('a');
    const expenseId = await createExpense(teamId, 'a-treasurer-token', 'Pitch rent');
    const meta = await uploadPdf(teamId, expenseId, 'a-treasurer-token');

    const detail = await get(`/teams/${teamId}/expenses/${expenseId}`, 'a-treasurer-token');
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { attachments: ReadonlyArray<AttachmentMetaBody> };
    expect(detailBody.attachments).toHaveLength(1);
    expect(detailBody.attachments[0]).toEqual({
      attachmentId: meta.attachmentId,
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
    });
    expect(Object.keys(detailBody.attachments[0])).not.toContain('content');

    const list = await get(`/teams/${teamId}/expenses`, 'a-treasurer-token');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as ReadonlyArray<{
      expenseId: string;
      attachments: ReadonlyArray<AttachmentMetaBody>;
    }>;
    const row = listBody.find((e) => e.expenseId === expenseId);
    expect(row?.attachments).toHaveLength(1);
    expect(row?.attachments[0]?.attachmentId).toBe(meta.attachmentId);
  });

  it('should report an empty array, not [null], for an expense with no attachments', async () => {
    // The `jsonb_agg` COALESCE guard: a LEFT JOIN with no match aggregates to `[null]`.
    const { teamId } = await setupTeam('a');
    const bare = await createExpense(teamId, 'a-treasurer-token', 'No invoice yet');

    const detail = await get(`/teams/${teamId}/expenses/${bare}`, 'a-treasurer-token');
    expect(((await detail.json()) as { attachments: unknown[] }).attachments).toEqual([]);

    const list = await get(`/teams/${teamId}/expenses`, 'a-treasurer-token');
    const listBody = (await list.json()) as ReadonlyArray<{
      expenseId: string;
      attachments: unknown[];
    }>;
    expect(listBody.find((e) => e.expenseId === bare)?.attachments).toEqual([]);
  });
});

describe('expense attachments — authorization', () => {
  it('should forbid a finance:view member from uploading, downloading or deleting, while still listing metadata', async () => {
    // Deliberate asymmetry with getExpense/listExpenses next door: all three attachment
    // endpoints are `finance:manage_fees`. A captain sees the badge, never the bytes.
    const { teamId } = await setupTeam('a');
    const expenseId = await createExpense(teamId, 'a-treasurer-token', 'Pitch rent');
    const meta = await uploadPdf(teamId, expenseId, 'a-treasurer-token');

    const upload = await postAttachment(teamId, expenseId, 'a-captain-token', {
      filename: 'sneaky.pdf',
      contentType: 'application/pdf',
      contentBase64: b64(PDF),
    });
    expect(upload.status).toBe(403);

    const download = await get(
      attachmentPath(teamId, expenseId, meta.attachmentId),
      'a-captain-token',
    );
    expect(download.status).toBe(403);

    const remove = await del(
      attachmentPath(teamId, expenseId, meta.attachmentId),
      'a-captain-token',
    );
    expect(remove.status).toBe(403);

    // ...but the nudge's data path still works for them.
    const list = await get(`/teams/${teamId}/expenses`, 'a-captain-token');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as ReadonlyArray<{
      expenseId: string;
      attachments: ReadonlyArray<AttachmentMetaBody>;
    }>;
    expect(listBody.find((e) => e.expenseId === expenseId)?.attachments).toHaveLength(1);
  });

  it('should forbid a non-member from downloading', async () => {
    const { teamId } = await setupTeam('a');
    const expenseId = await createExpense(teamId, 'a-treasurer-token', 'Pitch rent');
    const meta = await uploadPdf(teamId, expenseId, 'a-treasurer-token');

    const res = await get(attachmentPath(teamId, expenseId, meta.attachmentId), 'a-outsider-token');
    expect(res.status).toBe(403);
  });

  it('should answer 404, never 403, for an expense id belonging to another team', async () => {
    // A 403 here confirms the id exists — that is the leak this test exists to prevent.
    const a = await setupTeam('a');
    const b = await setupTeam('b');
    const foreignExpenseId = await createExpense(b.teamId, 'b-treasurer-token', 'Their rent');
    const foreignMeta = await uploadPdf(b.teamId, foreignExpenseId, 'b-treasurer-token');

    const upload = await postAttachment(a.teamId, foreignExpenseId, 'a-treasurer-token', {
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      contentBase64: b64(PDF),
    });
    expect(upload.status).toBe(404);
    expect(upload.status).not.toBe(403);

    const download = await get(
      attachmentPath(a.teamId, foreignExpenseId, foreignMeta.attachmentId),
      'a-treasurer-token',
    );
    expect(download.status).toBe(404);
    expect(download.status).not.toBe(403);

    const remove = await del(
      attachmentPath(a.teamId, foreignExpenseId, foreignMeta.attachmentId),
      'a-treasurer-token',
    );
    expect(remove.status).toBe(404);
    expect(remove.status).not.toBe(403);
  });

  it('should answer 404 for an attachment id that belongs to a different expense', async () => {
    const { teamId } = await setupTeam('a');
    const first = await createExpense(teamId, 'a-treasurer-token', 'First');
    const second = await createExpense(teamId, 'a-treasurer-token', 'Second');
    const secondMeta = await uploadPdf(teamId, second, 'a-treasurer-token');

    const res = await get(
      attachmentPath(teamId, first, secondMeta.attachmentId),
      'a-treasurer-token',
    );
    expect(res.status).toBe(404);
  });
});

describe('expense attachments — limits', () => {
  it('should reject an oversize file with 413 and store nothing', async () => {
    const { teamId } = await setupTeam('a');
    const expenseId = await createExpense(teamId, 'a-treasurer-token', 'Pitch rent');

    const res = await postAttachment(teamId, expenseId, 'a-treasurer-token', {
      filename: 'huge.pdf',
      contentType: 'application/pdf',
      contentBase64: b64(pdfOfSize(MAX_EXPENSE_ATTACHMENT_BYTES + 1)),
    });
    expect(res.status).toBe(413);
    expect(await countAttachments()).toBe(0);
  });

  it('should reject a disallowed content type with 415', async () => {
    const { teamId } = await setupTeam('a');
    const expenseId = await createExpense(teamId, 'a-treasurer-token', 'Pitch rent');

    const res = await postAttachment(teamId, expenseId, 'a-treasurer-token', {
      filename: 'meme.gif',
      contentType: 'image/gif',
      contentBase64: b64(GIF),
    });
    expect(res.status).toBe(415);
    expect(await countAttachments()).toBe(0);
  });

  it('should reject PNG bytes declared as application/pdf with 415', async () => {
    const { teamId } = await setupTeam('a');
    const expenseId = await createExpense(teamId, 'a-treasurer-token', 'Pitch rent');

    const res = await postAttachment(teamId, expenseId, 'a-treasurer-token', {
      filename: 'not-really.pdf',
      contentType: 'application/pdf',
      contentBase64: b64(PNG),
    });
    expect(res.status).toBe(415);
    expect(await countAttachments()).toBe(0);
  });

  // Options are the SECOND argument since Vitest 4; the trailing-options signature was removed
  // and makes the whole file fail at collection.
  it('should accept a legitimate ~6.99 MB base64 body with 201', { timeout: 120_000 }, async () => {
    // Base64 of exactly MAX_EXPENSE_ATTACHMENT_BYTES is 6,990,508 chars — just under the
    // schema's 7,000,000 ceiling. This is why the cap is 7e6 and not 6e6.
    const { teamId } = await setupTeam('a');
    const expenseId = await createExpense(teamId, 'a-treasurer-token', 'Pitch rent');

    const encoded = b64(pdfOfSize(MAX_EXPENSE_ATTACHMENT_BYTES));
    expect(encoded.length).toBe(6_990_508);
    expect(encoded.length).toBeLessThan(7_000_000);

    const res = await postAttachment(teamId, expenseId, 'a-treasurer-token', {
      filename: 'big-but-legal.pdf',
      contentType: 'application/pdf',
      contentBase64: encoded,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as AttachmentMetaBody).sizeBytes).toBe(MAX_EXPENSE_ATTACHMENT_BYTES);
  });

  it('should reject an absurd body at the schema layer with 400, not 413', async () => {
    // 400 means the rejection happened before `Buffer.from(..., 'base64')` allocated a second
    // copy. A 413 here would mean the body reached `checkExpenseAttachment` — i.e. the schema
    // cap is missing and an authenticated member can POST 1 GB and OOM the process.
    const { teamId } = await setupTeam('a');
    const expenseId = await createExpense(teamId, 'a-treasurer-token', 'Pitch rent');

    const res = await postAttachment(teamId, expenseId, 'a-treasurer-token', {
      filename: 'absurd.pdf',
      contentType: 'application/pdf',
      contentBase64: 'A'.repeat(7_000_001),
    });
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(413);
    expect(await countAttachments()).toBe(0);
  });
});

describe('expense attachments — deletion', () => {
  it('should delete only the targeted attachment', async () => {
    const { teamId } = await setupTeam('a');
    const expenseId = await createExpense(teamId, 'a-treasurer-token', 'Pitch rent');
    const first = await uploadPdf(teamId, expenseId, 'a-treasurer-token', 'first.pdf');
    const second = await uploadPdf(teamId, expenseId, 'a-treasurer-token', 'second.pdf');

    const res = await del(
      attachmentPath(teamId, expenseId, first.attachmentId),
      'a-treasurer-token',
    );
    expect(res.status).toBe(204);

    const stillThere = await get(
      attachmentPath(teamId, expenseId, second.attachmentId),
      'a-treasurer-token',
    );
    expect(stillThere.status).toBe(200);
    expect(await countAttachments(expenseId)).toBe(1);

    const detail = await get(`/teams/${teamId}/expenses/${expenseId}`, 'a-treasurer-token');
    const detailBody = (await detail.json()) as { attachments: ReadonlyArray<AttachmentMetaBody> };
    expect(detailBody.attachments).toHaveLength(1);
    expect(detailBody.attachments[0]?.attachmentId).toBe(second.attachmentId);
  });

  it('should answer 404 the second time the same attachment is deleted', async () => {
    const { teamId } = await setupTeam('a');
    const expenseId = await createExpense(teamId, 'a-treasurer-token', 'Pitch rent');
    const meta = await uploadPdf(teamId, expenseId, 'a-treasurer-token');

    const first = await del(
      attachmentPath(teamId, expenseId, meta.attachmentId),
      'a-treasurer-token',
    );
    expect(first.status).toBe(204);

    const second = await del(
      attachmentPath(teamId, expenseId, meta.attachmentId),
      'a-treasurer-token',
    );
    expect(second.status).toBe(404);
  });

  it('should cascade the bytes away when the expense is deleted', async () => {
    // The only test that proves ON DELETE CASCADE landed on the migration.
    const { teamId } = await setupTeam('a');
    const expenseId = await createExpense(teamId, 'a-treasurer-token', 'Pitch rent');
    await uploadPdf(teamId, expenseId, 'a-treasurer-token');
    expect(await countAttachments(expenseId)).toBe(1);

    const res = await del(`/teams/${teamId}/expenses/${expenseId}`, 'a-treasurer-token');
    expect(res.status).toBe(204);
    expect(await countAttachments(expenseId)).toBe(0);
  });
});
