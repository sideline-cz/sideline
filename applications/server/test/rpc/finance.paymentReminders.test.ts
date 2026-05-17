// TDD mode — tests written BEFORE the four new Finance RPC handlers exist.
// These tests WILL FAIL until the developer implements:
//   - Finance/MarkReminderSent handler writing to payment_reminders_sent
//   - Finance/MarkPaymentReminderProcessed handler updating processed_at
//   - Finance/MarkPaymentReminderFailed handler updating processed_at + error
//   - Finance/GetUnprocessedPaymentReminders handler querying payment_reminder_sync_events

import { it as itEffect } from '@effect/vitest';
import type { Discord, FeeAssignment } from '@sideline/domain';
import { FinanceRpcGroup, type PaymentReminder } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { FinanceOverviewRepository } from '~/repositories/FinanceOverviewRepository.js';
import { PaymentReminderSyncEventsRepository } from '~/repositories/PaymentReminderSyncEventsRepository.js';
import { PaymentRemindersSentRepository } from '~/repositories/PaymentRemindersSentRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { FinanceRpcLive } from '~/rpc/finance/index.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const GUILD_ID = '111111111111111111' as Discord.Snowflake;
const ASSIGNMENT_ID = '00000000-0000-0000-0000-000000000040' as FeeAssignment.FeeAssignmentId;
const SYNC_EVENT_ID = '00000000-0000-0000-0000-000000000050';
const DISCORD_USER_ID = '222222222222222222' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

type SyncEventRecord = {
  id: string;
  assignment_id: FeeAssignment.FeeAssignmentId;
  guild_id: Discord.Snowflake;
  kind: PaymentReminder.PaymentReminderKind;
  fee_name: string;
  currency: string;
  amount_minor: number;
  paid_minor: number;
  effective_due_at: Date;
  user_discord_id: Discord.Snowflake;
  created_at: Date;
  processed_at: Date | null;
  error: string | null;
  _tag: 'payment_reminder_ready';
};

let syncEventsStore: Map<string, SyncEventRecord>;
let sentStore: Set<string>; // `${assignment_id}:${kind}`

const resetStores = () => {
  syncEventsStore = new Map([
    [
      SYNC_EVENT_ID,
      {
        id: SYNC_EVENT_ID,
        assignment_id: ASSIGNMENT_ID,
        guild_id: GUILD_ID,
        kind: 'due_today' as PaymentReminder.PaymentReminderKind,
        fee_name: 'Test Fee',
        currency: 'CZK',
        amount_minor: 5000,
        paid_minor: 0,
        effective_due_at: new Date(),
        user_discord_id: DISCORD_USER_ID,
        created_at: new Date(),
        processed_at: null,
        error: null,
        _tag: 'payment_reminder_ready' as const,
      },
    ],
  ]);
  sentStore = new Set();
};

// ---------------------------------------------------------------------------
// Mock repositories
// ---------------------------------------------------------------------------

const MockPaymentReminderSyncEventsRepositoryLayer = Layer.succeed(
  PaymentReminderSyncEventsRepository,
  {
    emit: () => Effect.void,
    findUnprocessed: (limit: number) => {
      const rows = Array.from(syncEventsStore.values())
        .filter((r) => r.processed_at === null)
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        .slice(0, limit);
      return Effect.succeed(rows);
    },
    markProcessed: (id: string) => {
      const row = syncEventsStore.get(id);
      if (row) {
        syncEventsStore.set(id, { ...row, processed_at: new Date() });
      }
      return Effect.void;
    },
    markFailed: (id: string, error: string) => {
      const row = syncEventsStore.get(id);
      if (row) {
        syncEventsStore.set(id, { ...row, processed_at: new Date(), error });
      }
      return Effect.void;
    },
  } as any,
);

const MockPaymentRemindersSentRepositoryLayer = Layer.succeed(PaymentRemindersSentRepository, {
  markSent: (
    assignmentId: FeeAssignment.FeeAssignmentId,
    kind: PaymentReminder.PaymentReminderKind,
  ) => {
    sentStore.add(`${assignmentId}:${kind}`);
    return Effect.void;
  },
  existsForAssignmentKind: (
    assignmentId: FeeAssignment.FeeAssignmentId,
    kind: PaymentReminder.PaymentReminderKind,
  ) => Effect.succeed(sentStore.has(`${assignmentId}:${kind}`)),
} as any);

// Minimal stubs for existing repos that FinanceRpcLive depends on
const MockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  findByGuildId: () => Effect.succeed(Option.none()),
  findById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
} as any);

const MockUsersRepositoryLayer = Layer.succeed(UsersRepository, {
  findById: () => Effect.succeed(Option.none()),
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.die(new Error('Not implemented')),
  completeProfile: () => Effect.die(new Error('Not implemented')),
  updateLocale: () => Effect.die(new Error('Not implemented')),
  updateAdminProfile: () => Effect.die(new Error('Not implemented')),
} as any);

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  findMembershipByIds: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  addMember: () => Effect.die(new Error('Not implemented')),
} as any);

const MockFinanceOverviewRepositoryLayer = Layer.succeed(FinanceOverviewRepository, {
  overviewByTeam: () => Effect.succeed([]),
  myStatus: () => Effect.succeed([]),
} as any);

const TestLayer = FinanceRpcLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      MockTeamsRepositoryLayer,
      MockUsersRepositoryLayer,
      MockTeamMembersRepositoryLayer,
      MockFinanceOverviewRepositoryLayer,
      MockPaymentReminderSyncEventsRepositoryLayer,
      MockPaymentRemindersSentRepositoryLayer,
    ),
  ),
);

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Finance RPC — MarkReminderSent', () => {
  itEffect('writes a row into payment_reminders_sent', () =>
    Effect.Do.pipe(
      Effect.bind('client', () => RpcTest.makeClient(FinanceRpcGroup.FinanceRpcGroup)),
      Effect.tap(({ client }) =>
        client['Finance/MarkReminderSent']({
          assignment_id: ASSIGNMENT_ID,
          kind: 'due_today',
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(sentStore.has(`${ASSIGNMENT_ID}:due_today`)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  itEffect('calling MarkReminderSent twice for the same key is idempotent', () =>
    Effect.Do.pipe(
      Effect.bind('client', () => RpcTest.makeClient(FinanceRpcGroup.FinanceRpcGroup)),
      Effect.tap(({ client }) =>
        client['Finance/MarkReminderSent']({
          assignment_id: ASSIGNMENT_ID,
          kind: 'overdue_3d',
        }),
      ),
      Effect.tap(({ client }) =>
        client['Finance/MarkReminderSent']({
          assignment_id: ASSIGNMENT_ID,
          kind: 'overdue_3d',
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          // Still only one entry
          expect(sentStore.has(`${ASSIGNMENT_ID}:overdue_3d`)).toBe(true);
          expect(sentStore.size).toBe(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('Finance RPC — MarkPaymentReminderProcessed', () => {
  itEffect('updates the sync row processed_at', () =>
    Effect.Do.pipe(
      Effect.bind('client', () => RpcTest.makeClient(FinanceRpcGroup.FinanceRpcGroup)),
      Effect.tap(({ client }) =>
        client['Finance/MarkPaymentReminderProcessed']({ id: SYNC_EVENT_ID }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          const row = syncEventsStore.get(SYNC_EVENT_ID);
          expect(row?.processed_at).not.toBeNull();
          expect(row?.error).toBeNull();
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('Finance RPC — MarkPaymentReminderFailed', () => {
  itEffect('updates processed_at and stores the error message', () =>
    Effect.Do.pipe(
      Effect.bind('client', () => RpcTest.makeClient(FinanceRpcGroup.FinanceRpcGroup)),
      Effect.tap(({ client }) =>
        client['Finance/MarkPaymentReminderFailed']({
          id: SYNC_EVENT_ID,
          error: 'Discord HTTP 500',
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          const row = syncEventsStore.get(SYNC_EVENT_ID);
          expect(row?.processed_at).not.toBeNull();
          expect(row?.error).toBe('Discord HTTP 500');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('Finance RPC — GetUnprocessedPaymentReminders', () => {
  itEffect('returns unprocessed rows ordered by created_at ASC, capped at limit', () =>
    Effect.Do.pipe(
      Effect.bind('client', () => RpcTest.makeClient(FinanceRpcGroup.FinanceRpcGroup)),
      Effect.tap(() => {
        // Add a second unprocessed event created slightly later
        const SYNC_EVENT_ID_2 = '00000000-0000-0000-0000-000000000051';
        syncEventsStore.set(SYNC_EVENT_ID_2, {
          id: SYNC_EVENT_ID_2,
          assignment_id: ASSIGNMENT_ID,
          guild_id: GUILD_ID,
          kind: 'overdue_3d',
          fee_name: 'Test Fee 2',
          currency: 'EUR',
          amount_minor: 2000,
          paid_minor: 0,
          effective_due_at: new Date(),
          user_discord_id: DISCORD_USER_ID,
          created_at: new Date(Date.now() + 1000),
          processed_at: null,
          error: null,
          _tag: 'payment_reminder_ready' as const,
        });
        return Effect.void;
      }),
      Effect.bind('results', ({ client }) =>
        client['Finance/GetUnprocessedPaymentReminders']({ limit: 10 }),
      ),
      Effect.tap(({ results }) =>
        Effect.sync(() => {
          expect(results).toHaveLength(2);
          // First should be the earlier created one
          expect(results[0]?.id).toBe(SYNC_EVENT_ID);
          expect(results[0]?._tag).toBe('payment_reminder_ready');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  itEffect('respects the limit parameter', () =>
    Effect.Do.pipe(
      Effect.bind('client', () => RpcTest.makeClient(FinanceRpcGroup.FinanceRpcGroup)),
      Effect.bind('results', ({ client }) =>
        client['Finance/GetUnprocessedPaymentReminders']({ limit: 1 }),
      ),
      Effect.tap(({ results }) =>
        Effect.sync(() => {
          expect(results).toHaveLength(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  itEffect('excludes rows with processed_at IS NOT NULL', () =>
    Effect.Do.pipe(
      Effect.bind('client', () => RpcTest.makeClient(FinanceRpcGroup.FinanceRpcGroup)),
      // Mark the existing event as processed
      Effect.tap(({ client }) =>
        client['Finance/MarkPaymentReminderProcessed']({ id: SYNC_EVENT_ID }),
      ),
      Effect.bind('results', ({ client }) =>
        client['Finance/GetUnprocessedPaymentReminders']({ limit: 10 }),
      ),
      Effect.tap(({ results }) =>
        Effect.sync(() => {
          expect(results).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
