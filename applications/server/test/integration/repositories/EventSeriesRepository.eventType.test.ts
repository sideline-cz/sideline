// Series of any event type — repository SQL against a real DB (plan Task 3 test spec).
//
// Covers: the materializers (cron) passing the series' post-trigger type into every event,
// the archived-id mask in findActiveForGeneration / finalizeSeries, the COALESCE on the series
// update, the post-trigger training_type_id clamp (finalizeSeries), and retypeFollowingInSeries
// reaching individually edited occurrences while skipping cancelled / past / started ones.
//
// Every id is compared against what the EVENTS trigger picks for a kind-only insert in the same
// team, never a hand-picked id. Run after rebuilding the migrations dist.

import { describe, expect, it } from '@effect/vitest';
import type { EventSeries, Team, TeamMember } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventSeriesRepository } from '~/repositories/EventSeriesRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { eventHorizonCronEffect } from '~/services/EventHorizonCron.js';
import {
  computeHorizonEnd,
  generateOccurrenceDates,
  seriesRecurrence,
} from '~/services/RecurrenceService.js';
import { createTeam, createTeamMember, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
  EventSeriesRepository.Default,
  EventsRepository.Default,
  TeamSettingsRepository.Default,
  DiscordChannelMappingRepository.Default,
  EventSyncEventsRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Seeded = { teamId: Team.TeamId; memberId: TeamMember.TeamMemberId };

const seed = (label: string) =>
  Effect.gen(function* () {
    const user = yield* createUser(`es-repo-type-${label}`);
    const team = yield* createTeam(nextDiscordId(), user.id);
    const member = yield* createTeamMember(team.id, user.id);
    return { teamId: team.id, memberId: member.id } satisfies Seeded;
  });

const typeIdByKind = (teamId: string, kind: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ id: string }>`
        SELECT id FROM event_types
        WHERE team_id = ${teamId} AND kind = ${kind} AND archived_at IS NULL
        ORDER BY created_at, id LIMIT 1
      `,
    ),
    Effect.map((rows) => rows[0]?.id as string),
  );

const archiveType = (id: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) => sql`UPDATE event_types SET archived_at = now() WHERE id = ${id}`),
  );

const insertActiveType = (teamId: string, kind: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ id: string }>`
        INSERT INTO event_types (team_id, name, kind, color, position)
        VALUES (${teamId}, ${`Newer ${kind}`}, ${kind}, 'blue', 99)
        RETURNING id
      `,
    ),
    Effect.map((rows) => rows[0]?.id as string),
  );

const insertTrainingType = (teamId: string, name: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ id: string }>`
        INSERT INTO training_types (team_id, name) VALUES (${teamId}, ${name}) RETURNING id
      `,
    ),
    Effect.map((rows) => rows[0]?.id as string),
  );

// The id the events trigger resolves for a kind-only insert in this team. The reference event
// has no series_id, so it never shows up in a series' event list.
const eventsTriggerPick = (s: Seeded, kind: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ event_type_id: string | null }>`
        INSERT INTO events (team_id, event_type, title, created_by, start_at)
        VALUES (${s.teamId}, ${kind}, 'Reference', ${s.memberId}, ${new Date('2099-06-15T18:00:00Z')})
        RETURNING event_type_id
      `,
    ),
    Effect.map((rows) => rows[0]?.event_type_id ?? null),
  );

type SeriesDbRow = {
  event_type: string;
  event_type_id: string | null;
  training_type_id: string | null;
  title: string;
};

const getSeriesDb = (id: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<SeriesDbRow>`
        SELECT event_type, event_type_id, training_type_id, title FROM event_series WHERE id = ${id}
      `,
    ),
    Effect.map((rows) => rows[0] as SeriesDbRow),
  );

type EventDbRow = {
  id: string;
  event_type: string;
  event_type_id: string | null;
  training_type_id: string | null;
  title: string;
  series_modified: boolean;
  status: string;
};

const getSeriesEvents = (seriesId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<EventDbRow>`
        SELECT id, event_type, event_type_id, training_type_id, title, series_modified, status
        FROM events WHERE series_id = ${seriesId} ORDER BY start_at
      `,
    ),
  );

const getEvent = (id: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<EventDbRow>`
        SELECT id, event_type, event_type_id, training_type_id, title, series_modified, status
        FROM events WHERE id = ${id}
      `,
    ),
    Effect.map((rows) => rows[0] as EventDbRow),
  );

const todayUtc = () => DateTime.startOf(DateTime.nowUnsafe(), 'day');

// Cron fixtures start today: the cron only materializes up to now + horizon, so a far-future
// start_date would generate nothing. Non-cron fixtures use 2099 dates and never expire.
const baseSeries = (s: Seeded, startDate: DateTime.Utc = todayUtc()) => ({
  teamId: s.teamId,
  trainingTypeId: Option.none<string>(),
  title: 'Series',
  description: Option.none<string>(),
  startTime: '18:00',
  endTime: Option.none<string>(),
  location: Option.none<string>(),
  frequency: 'weekly',
  daysOfWeek: [1, 4],
  startDate,
  endDate: Option.none<DateTime.Utc>(),
  createdBy: s.memberId,
  timesAreTeamLocal: true,
});

const baseUpdate = (id: EventSeries.EventSeriesId) => ({
  id,
  title: 'Series',
  trainingTypeId: Option.none<string>(),
  description: Option.none<string>(),
  daysOfWeek: [1, 4],
  startTime: '18:00',
  endTime: Option.none<string>(),
  location: Option.none<string>(),
  endDate: Option.none<DateTime.Utc>(),
});

const insertOccurrence = (
  s: Seeded,
  seriesId: string,
  startAt: Date,
  opts: { trainingTypeId?: Option.Option<string>; eventType?: string } = {},
) =>
  EventsRepository.asEffect().pipe(
    Effect.flatMap((repo) =>
      repo.insertEvent({
        teamId: s.teamId,
        trainingTypeId: opts.trainingTypeId ?? Option.none(),
        eventType: opts.eventType ?? 'training',
        title: 'Series',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(startAt),
        endAt: Option.none(),
        location: Option.none(),
        createdBy: s.memberId,
        seriesId: Option.some(seriesId),
      }),
    ),
    Effect.map((e) => e.id as string),
  );

const runRaw = (statement: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>) =>
  SqlClient.SqlClient.asEffect().pipe(Effect.flatMap(statement));

// ---------------------------------------------------------------------------
// Cron materialization
// ---------------------------------------------------------------------------

describe('EventSeriesRepository — event type, cron materialization', () => {
  it.effect('generates match events for a match series (type + id, no training type)', () =>
    Effect.gen(function* () {
      const s = yield* seed('cron-match');
      const repo = yield* EventSeriesRepository;
      const matchId = yield* typeIdByKind(s.teamId, 'match');
      const series = yield* repo.insertEventSeries({
        ...baseSeries(s),
        eventType: 'match',
        eventTypeId: Option.some(matchId),
      });

      yield* eventHorizonCronEffect;

      const events = yield* getSeriesEvents(series.id);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.event_type).toBe('match');
        expect(e.event_type_id).toBe(matchId);
        expect(e.training_type_id).toBeNull();
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('regression: a series inserted without type args still generates training events', () =>
    Effect.gen(function* () {
      const s = yield* seed('cron-legacy');
      const repo = yield* EventSeriesRepository;
      const input = baseSeries(s);
      const series = yield* repo.insertEventSeries(input);

      yield* eventHorizonCronEffect;

      const events = yield* getSeriesEvents(series.id);
      const reference = yield* eventsTriggerPick(s, 'training');
      const recurrence = Option.getOrThrow(
        seriesRecurrence({
          frequency: input.frequency,
          days_of_week: input.daysOfWeek,
          day_of_month: Option.none(),
          week_of_month: Option.none(),
        }),
      );
      const expected = generateOccurrenceDates({
        ...recurrence,
        startDate: input.startDate,
        endDate: computeHorizonEnd({
          recurrence,
          seriesStartDate: input.startDate,
          seriesEndDate: null,
          horizonDays: 30,
        }),
      });

      expect(series.event_type).toBe('training');
      expect(events).toHaveLength(expected.length);
      for (const e of events) {
        expect(e.event_type).toBe('training');
        expect(e.event_type_id).toBe(reference);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('(hater a) a series stored on an archived type materializes with the active pick', () =>
    Effect.gen(function* () {
      const s = yield* seed('cron-archived');
      const repo = yield* EventSeriesRepository;
      const series = yield* repo.insertEventSeries(baseSeries(s));
      const typeA = Option.getOrThrow(series.event_type_id);

      yield* archiveType(typeA);
      const typeB = yield* insertActiveType(s.teamId, 'training');

      yield* eventHorizonCronEffect;

      const events = yield* getSeriesEvents(series.id);
      const reference = yield* eventsTriggerPick(s, 'training');
      expect(reference).toBe(typeB);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) expect(e.event_type_id).toBe(typeB);
      expect((yield* getSeriesDb(series.id)).event_type_id).toBe(typeA);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Retype ("all future" with a changed type)
// ---------------------------------------------------------------------------

describe('EventSeriesRepository / EventsRepository — retype following occurrences', () => {
  it.effect('retype reaches every following non-cancelled occurrence, edited ones included', () =>
    Effect.gen(function* () {
      const s = yield* seed('retype');
      const seriesRepo = yield* EventSeriesRepository;
      const eventsRepo = yield* EventsRepository;
      const tt = yield* insertTrainingType(s.teamId, 'Throwing');
      const series = yield* seriesRepo.insertEventSeries({
        ...baseSeries(s, DateTime.fromDateUnsafe(new Date('2099-01-01T00:00:00Z'))),
        trainingTypeId: Option.some(tt),
      });
      const ttOpt = { trainingTypeId: Option.some(tt) };

      const future1 = yield* insertOccurrence(
        s,
        series.id,
        new Date('2099-01-05T17:00:00Z'),
        ttOpt,
      );
      const future2 = yield* insertOccurrence(
        s,
        series.id,
        new Date('2099-01-08T17:00:00Z'),
        ttOpt,
      );
      const edited = yield* insertOccurrence(s, series.id, new Date('2099-01-12T17:00:00Z'), ttOpt);
      const cancelled = yield* insertOccurrence(
        s,
        series.id,
        new Date('2099-01-15T17:00:00Z'),
        ttOpt,
      );
      const past = yield* insertOccurrence(s, series.id, new Date('2000-01-03T17:00:00Z'), ttOpt);
      const started = yield* insertOccurrence(s, series.id, new Date(), ttOpt);

      yield* runRaw(
        (sql) =>
          sql`UPDATE events SET title = 'Edited title', series_modified = true WHERE id = ${edited}`,
      );
      yield* runRaw((sql) => sql`UPDATE events SET status = 'cancelled' WHERE id = ${cancelled}`);
      yield* runRaw((sql) => sql`UPDATE events SET status = 'started' WHERE id = ${started}`);

      const meetingId = yield* typeIdByKind(s.teamId, 'meeting');
      const trainingId = yield* typeIdByKind(s.teamId, 'training');

      const updated = yield* seriesRepo.updateEventSeries({
        ...baseUpdate(series.id),
        eventType: 'meeting',
        eventTypeId: Option.none(),
      });
      expect(updated.event_type).toBe('meeting');
      expect(updated.event_type_id).toEqual(Option.some(meetingId));

      yield* eventsRepo.retypeFollowingInSeries(series.id, new Date(), {
        eventType: updated.event_type,
        eventTypeId: updated.event_type_id,
      });

      for (const id of [future1, future2, edited]) {
        const e = yield* getEvent(id);
        expect(e.event_type).toBe('meeting');
        expect(e.event_type_id).toBe(meetingId);
        expect(e.training_type_id).toBeNull();
      }
      const editedRow = yield* getEvent(edited);
      expect(editedRow.title).toBe('Edited title');
      expect(editedRow.series_modified).toBe(true);

      for (const id of [cancelled, past, started]) {
        const e = yield* getEvent(id);
        expect(e.event_type).toBe('training');
        expect(e.event_type_id).toBe(trainingId);
        expect(e.training_type_id).toBe(tt);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('retype to training resolves the training id and keeps a NULL training type', () =>
    Effect.gen(function* () {
      const s = yield* seed('retype-to-training');
      const seriesRepo = yield* EventSeriesRepository;
      const eventsRepo = yield* EventsRepository;
      const matchId = yield* typeIdByKind(s.teamId, 'match');
      const series = yield* seriesRepo.insertEventSeries({
        ...baseSeries(s, DateTime.fromDateUnsafe(new Date('2099-01-01T00:00:00Z'))),
        eventType: 'match',
        eventTypeId: Option.some(matchId),
      });
      const edited = yield* insertOccurrence(s, series.id, new Date('2099-01-12T17:00:00Z'), {
        eventType: 'match',
      });
      yield* runRaw(
        (sql) =>
          sql`UPDATE events SET title = 'Edited', series_modified = true WHERE id = ${edited}`,
      );

      const updated = yield* seriesRepo.updateEventSeries({
        ...baseUpdate(series.id),
        eventType: 'training',
        eventTypeId: Option.none(),
      });
      yield* eventsRepo.retypeFollowingInSeries(series.id, new Date(), {
        eventType: updated.event_type,
        eventTypeId: updated.event_type_id,
      });

      const reference = yield* eventsTriggerPick(s, 'training');
      const e = yield* getEvent(edited);
      expect(e.event_type).toBe('training');
      expect(e.event_type_id).toBe(reference);
      expect(e.training_type_id).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('EventSeriesRepository — foreign event type id on update', () => {
  it.effect("a PATCH carrying another team's id stores and retypes to the own team's type", () =>
    Effect.gen(function* () {
      const s = yield* seed('foreign-a');
      const other = yield* seed('foreign-b');
      const seriesRepo = yield* EventSeriesRepository;
      const eventsRepo = yield* EventsRepository;
      const ownMatch = yield* typeIdByKind(s.teamId, 'match');
      const foreignMatch = yield* typeIdByKind(other.teamId, 'match');
      const series = yield* seriesRepo.insertEventSeries(
        baseSeries(s, DateTime.fromDateUnsafe(new Date('2099-01-01T00:00:00Z'))),
      );
      const occurrence = yield* insertOccurrence(s, series.id, new Date('2099-01-05T17:00:00Z'));

      const updated = yield* seriesRepo.updateEventSeries({
        ...baseUpdate(series.id),
        eventType: 'match',
        eventTypeId: Option.some(foreignMatch),
      });
      const db = yield* getSeriesDb(series.id);
      expect(db.event_type).toBe('match');
      expect(db.event_type_id).toBe(ownMatch);

      yield* eventsRepo.retypeFollowingInSeries(series.id, new Date(), {
        eventType: updated.event_type,
        eventTypeId: updated.event_type_id,
      });
      const e = yield* getEvent(occurrence);
      expect(e.event_type).toBe('match');
      expect(e.event_type_id).toBe(ownMatch);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Archived stored type: COALESCE + mask
// ---------------------------------------------------------------------------

describe('EventSeriesRepository — archived stored type', () => {
  it.effect('a no-type update keeps the archived stored id and masks it in the returned row', () =>
    Effect.gen(function* () {
      const s = yield* seed('archived-keep');
      const repo = yield* EventSeriesRepository;
      const series = yield* repo.insertEventSeries(
        baseSeries(s, DateTime.fromDateUnsafe(new Date('2099-01-01T00:00:00Z'))),
      );
      const typeA = Option.getOrThrow(series.event_type_id);
      yield* archiveType(typeA);
      yield* insertActiveType(s.teamId, 'training');

      const updated = yield* repo.updateEventSeries({
        ...baseUpdate(series.id),
        eventType: 'training',
        eventTypeId: Option.none(),
      });
      expect(updated.event_type).toBe('training');
      expect(Option.isNone(updated.event_type_id)).toBe(true);

      const found = Option.getOrThrow(yield* repo.findSeriesById(series.id));
      expect(found.event_type_id).toEqual(Option.some(typeA));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    '(hater b) a type-preserving edit leaves the events on the active type, only the title moves',
    () =>
      Effect.gen(function* () {
        const s = yield* seed('archived-edit');
        const seriesRepo = yield* EventSeriesRepository;
        const eventsRepo = yield* EventsRepository;
        const series = yield* seriesRepo.insertEventSeries(
          baseSeries(s, DateTime.fromDateUnsafe(new Date('2099-01-01T00:00:00Z'))),
        );
        const typeA = Option.getOrThrow(series.event_type_id);
        yield* archiveType(typeA);
        const typeB = yield* insertActiveType(s.teamId, 'training');

        yield* insertOccurrence(s, series.id, new Date('2099-01-05T17:00:00Z'));
        yield* insertOccurrence(s, series.id, new Date('2099-01-08T17:00:00Z'));
        const before = yield* getSeriesEvents(series.id);
        for (const e of before) expect(e.event_type_id).toBe(typeB);

        const updated = yield* seriesRepo.updateEventSeries({
          ...baseUpdate(series.id),
          title: 'Renamed',
          eventType: 'training',
          eventTypeId: Option.none(),
        });
        // The handler skips retypeFollowingInSeries here (the request carries no type).
        yield* eventsRepo.updateFutureUnmodifiedInSeries(series.id, new Date(), {
          title: updated.title,
          trainingTypeId: updated.training_type_id,
          description: updated.description,
          startTime: updated.start_time,
          endTime: updated.end_time,
          location: updated.location,
          locationUrl: updated.location_url,
          timezone: 'Europe/Prague',
        });

        const after = yield* getSeriesEvents(series.id);
        expect(after).toHaveLength(2);
        for (const e of after) {
          expect(e.event_type).toBe('training');
          expect(e.event_type_id).toBe(typeB);
          expect(e.title).toBe('Renamed');
        }
        expect((yield* getSeriesDb(series.id)).event_type_id).toBe(typeA);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Post-trigger training_type_id clamp (finalizeSeries)
// ---------------------------------------------------------------------------

describe('EventSeriesRepository — post-trigger training type clamp', () => {
  it.effect("insert: 'training' + a match id + a training type → match, no training type", () =>
    Effect.gen(function* () {
      const s = yield* seed('clamp-insert');
      const repo = yield* EventSeriesRepository;
      const tt = yield* insertTrainingType(s.teamId, 'Throwing');
      const matchId = yield* typeIdByKind(s.teamId, 'match');
      const series = yield* repo.insertEventSeries({
        ...baseSeries(s, DateTime.fromDateUnsafe(new Date('2099-01-01T00:00:00Z'))),
        trainingTypeId: Option.some(tt),
        eventType: 'training',
        eventTypeId: Option.some(matchId),
      });

      expect(series.event_type).toBe('match');
      expect(Option.isNone(series.training_type_id)).toBe(true);
      const db = yield* getSeriesDb(series.id);
      expect(db.event_type).toBe('match');
      expect(db.training_type_id).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("update: 'training' + a social id + a training type → social, no training type", () =>
    Effect.gen(function* () {
      const s = yield* seed('clamp-update');
      const repo = yield* EventSeriesRepository;
      const tt = yield* insertTrainingType(s.teamId, 'Throwing');
      const socialId = yield* typeIdByKind(s.teamId, 'social');
      const series = yield* repo.insertEventSeries({
        ...baseSeries(s, DateTime.fromDateUnsafe(new Date('2099-01-01T00:00:00Z'))),
        trainingTypeId: Option.some(tt),
      });
      expect(series.training_type_id).toEqual(Option.some(tt));

      const updated = yield* repo.updateEventSeries({
        ...baseUpdate(series.id),
        trainingTypeId: Option.some(tt),
        eventType: 'training',
        eventTypeId: Option.some(socialId),
      });

      expect(updated.event_type).toBe('social');
      expect(Option.isNone(updated.training_type_id)).toBe(true);
      const db = yield* getSeriesDb(series.id);
      expect(db.event_type).toBe('social');
      expect(db.event_type_id).toBe(socialId);
      expect(db.training_type_id).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );
});
