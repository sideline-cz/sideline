// T10b — the missing producer for the Fio token-expiry warning (design §11). Everything
// downstream (RPCs, the bot's DM handler) already existed before this file; these tests pin the
// producer's behaviour: `BankSyncConfigRepository.findExpiringCandidates`'s day-boundary SQL and
// `BankTokenExpiryCron`'s emit/markSent/isolation wiring.

import { describe, expect, it } from '@effect/vitest';
import type { Team } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { BankSyncConfigRepository } from '~/repositories/BankSyncConfigRepository.js';
import { BankTokenExpiryEventsRepository } from '~/repositories/BankTokenExpiryEventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { bankTokenExpiryCronEffect } from '~/services/BankTokenExpiryCron.js';
import { createTeam, createUser, enableBankSync, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  BankSyncConfigRepository.Default,
  BankTokenExpiryEventsRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_LIFETIME_DAYS = 180;

/** `token_created_at` placing a token exactly `daysOut` calendar days from its own expiry. A
 * negative `daysOut` produces an already-expired token. */
const tokenCreatedForDaysOut = (daysOut: number): Date =>
  new Date(Date.now() - (TOKEN_LIFETIME_DAYS - daysOut) * DAY_MS);

const seedTeamWithToken = (daysOut: number, options: { readonly enabled?: boolean } = {}) =>
  Effect.Do.pipe(
    Effect.bind('user', () => createUser(`treasurer-${nextDiscordId()}`)),
    Effect.bind('team', ({ user }) => createTeam(nextDiscordId(), user.id)),
    Effect.tap(({ user, team }) =>
      enableBankSync(team.id, user.id, {
        enabled: options.enabled ?? true,
        fioTokenEncrypted: Option.some('v1.aaa.bbb.ccc'),
        fioTokenCreatedAt: tokenCreatedForDaysOut(daysOut),
      }),
    ),
  );

const unprocessedForTeam = (teamId: Team.TeamId) =>
  BankTokenExpiryEventsRepository.asEffect().pipe(
    Effect.flatMap((repo) => repo.findUnprocessed(1000)),
    Effect.map((rows) => rows.filter((row) => row.team_id === teamId)),
  );

interface SentRow {
  readonly threshold_days: number;
}

const sentRowsForTeam = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<SentRow>`
        SELECT threshold_days FROM bank_token_expiry_sent WHERE team_id = ${teamId}
      `,
    ),
  );

// ---------------------------------------------------------------------------
// Threshold boundaries
// ---------------------------------------------------------------------------

describe('BankTokenExpiryCron — threshold boundaries', () => {
  it.effect('emits a T-14 event for a token exactly 14 days from expiry', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithToken(14)),
      Effect.tap(() => bankTokenExpiryCronEffect),
      Effect.bind('events', ({ seed }) => unprocessedForTeam(seed.team.id)),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect(events.map((e) => e.threshold_days)).toEqual([14]);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('emits a T-7 event for a token exactly 7 days from expiry', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithToken(7)),
      Effect.tap(() => bankTokenExpiryCronEffect),
      Effect.bind('events', ({ seed }) => unprocessedForTeam(seed.team.id)),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect(events.map((e) => e.threshold_days)).toEqual([7]);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('emits a T-1 event for a token exactly 1 day from expiry', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithToken(1)),
      Effect.tap(() => bankTokenExpiryCronEffect),
      Effect.bind('events', ({ seed }) => unprocessedForTeam(seed.team.id)),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect(events.map((e) => e.threshold_days)).toEqual([1]);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('does NOT emit for a token 15 days from expiry (one day short of T-14)', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithToken(15)),
      Effect.tap(() => bankTokenExpiryCronEffect),
      Effect.bind('events', ({ seed }) => unprocessedForTeam(seed.team.id)),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect(events).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('does NOT emit for a token 13 days from expiry (one day past T-14)', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithToken(13)),
      Effect.tap(() => bankTokenExpiryCronEffect),
      Effect.bind('events', ({ seed }) => unprocessedForTeam(seed.team.id)),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect(events).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// Dedupe — each threshold fires exactly once
// ---------------------------------------------------------------------------

describe('BankTokenExpiryCron — dedupe', () => {
  it.effect('running the cron twice in a row does not double-emit the same threshold', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithToken(7)),
      Effect.tap(() => bankTokenExpiryCronEffect),
      Effect.tap(() => bankTokenExpiryCronEffect),
      Effect.bind('events', ({ seed }) => unprocessedForTeam(seed.team.id)),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect(events).toHaveLength(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'once the outbox row is processed, the threshold still never re-fires — bank_token_expiry_sent is the durable dedupe boundary',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithToken(1)),
        Effect.tap(() => bankTokenExpiryCronEffect),
        Effect.bind('repo', () => BankTokenExpiryEventsRepository.asEffect()),
        Effect.bind('firstEvents', ({ seed }) => unprocessedForTeam(seed.team.id)),
        Effect.tap(({ repo, firstEvents }) => {
          const [event] = firstEvents;
          return event === undefined ? Effect.void : repo.markProcessed(event.id);
        }),
        Effect.tap(() => bankTokenExpiryCronEffect),
        Effect.bind('eventsAfter', ({ seed }) => unprocessedForTeam(seed.team.id)),
        Effect.tap(({ firstEvents, eventsAfter }) =>
          Effect.sync(() => {
            expect(firstEvents).toHaveLength(1);
            expect(eventsAfter).toHaveLength(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('a successful emit writes a matching bank_token_expiry_sent row', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithToken(7)),
      Effect.tap(() => bankTokenExpiryCronEffect),
      Effect.bind('sentRows', ({ seed }) => sentRowsForTeam(seed.team.id)),
      Effect.tap(({ sentRows }) =>
        Effect.sync(() => {
          expect(sentRows.map((r) => r.threshold_days)).toEqual([7]);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// Replacing the token re-arms all three thresholds
// ---------------------------------------------------------------------------

describe('BankTokenExpiryCron — token replacement re-arms thresholds', () => {
  it.effect('a new token_created_at re-arms a threshold already marked sent for the old one', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithToken(1)),
      Effect.tap(() => bankTokenExpiryCronEffect),
      Effect.bind('firstEvents', ({ seed }) => unprocessedForTeam(seed.team.id)),
      Effect.bind('repo', () => BankTokenExpiryEventsRepository.asEffect()),
      Effect.tap(({ repo, firstEvents }) => {
        const [event] = firstEvents;
        return event === undefined ? Effect.void : repo.markProcessed(event.id);
      }),
      // Replace the token — a fresh token_created_at, again exactly 1 day from ITS OWN expiry.
      Effect.tap(({ seed }) =>
        enableBankSync(seed.team.id, seed.user.id, {
          fioTokenEncrypted: Option.some('v1.replacement.bbb.ccc'),
          fioTokenCreatedAt: tokenCreatedForDaysOut(1),
        }),
      ),
      Effect.tap(() => bankTokenExpiryCronEffect),
      Effect.bind('eventsAfter', ({ seed }) => unprocessedForTeam(seed.team.id)),
      Effect.tap(({ firstEvents, eventsAfter }) =>
        Effect.sync(() => {
          expect(firstEvents).toHaveLength(1);
          expect(eventsAfter).toHaveLength(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// A disabled config emits nothing
// ---------------------------------------------------------------------------

describe('BankTokenExpiryCron — disabled config', () => {
  it.effect('a disabled config at T-1 emits nothing', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithToken(1, { enabled: false })),
      Effect.tap(() => bankTokenExpiryCronEffect),
      Effect.bind('events', ({ seed }) => unprocessedForTeam(seed.team.id)),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect(events).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// An already-expired token stops firing (never re-arms itself)
// ---------------------------------------------------------------------------

describe('BankTokenExpiryCron — already-expired token', () => {
  it.effect(
    'a token that expired 20 days ago emits nothing — T-1 does not fire forever for a dead token',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithToken(-20)),
        Effect.tap(() => bankTokenExpiryCronEffect),
        Effect.bind('events', ({ seed }) => unprocessedForTeam(seed.team.id)),
        Effect.tap(({ events }) =>
          Effect.sync(() => {
            expect(events).toHaveLength(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// Per-team failure isolation
// ---------------------------------------------------------------------------

describe('BankTokenExpiryCron — per-team failure isolation', () => {
  it.effect(
    'one team failing to emit does not stop another team in the same cycle from being processed',
    () => {
      let failingTeamId: Team.TeamId | undefined;

      // Decorates the REAL repository (built against TestPgClient below) so every method except
      // `emit` behaves exactly as in production — only `emit` is intercepted, and only for the
      // one team this test designates as "broken".
      const IsolationBankTokenExpiryEventsRepository = Layer.effect(
        BankTokenExpiryEventsRepository,
        Effect.map(BankTokenExpiryEventsRepository.asEffect(), (real) => ({
          ...real,
          emit: (input: Parameters<typeof real.emit>[0]) =>
            failingTeamId !== undefined && input.teamId === failingTeamId
              ? LogicError.die(`simulated emit failure for team ${input.teamId}`)
              : real.emit(input),
        })),
      ).pipe(Layer.provide(BankTokenExpiryEventsRepository.Default));

      const IsolationTestLayer = Layer.mergeAll(
        BankSyncConfigRepository.Default,
        IsolationBankTokenExpiryEventsRepository,
        TeamsRepository.Default,
        UsersRepository.Default,
      ).pipe(Layer.provideMerge(TestPgClient));

      return Effect.Do.pipe(
        Effect.bind('badSeed', () => seedTeamWithToken(7)),
        Effect.bind('goodSeed', () => seedTeamWithToken(1)),
        Effect.tap(({ badSeed }) =>
          Effect.sync(() => {
            failingTeamId = badSeed.team.id;
          }),
        ),
        // Must complete WITHOUT dying — this is the isolation guarantee itself.
        Effect.tap(() => bankTokenExpiryCronEffect),
        Effect.bind('badEvents', ({ badSeed }) => unprocessedForTeam(badSeed.team.id)),
        Effect.bind('goodEvents', ({ goodSeed }) => unprocessedForTeam(goodSeed.team.id)),
        Effect.bind('badSentRows', ({ badSeed }) => sentRowsForTeam(badSeed.team.id)),
        Effect.tap(({ badEvents, goodEvents, badSentRows }) =>
          Effect.sync(() => {
            // The broken team never got its outbox row NOR its sent-dedupe row.
            expect(badEvents).toHaveLength(0);
            expect(badSentRows).toHaveLength(0);
            // The healthy team was unaffected by the other team's failure.
            expect(goodEvents.map((e) => e.threshold_days)).toEqual([1]);
          }),
        ),
        Effect.provide(IsolationTestLayer),
      );
    },
  );
});
