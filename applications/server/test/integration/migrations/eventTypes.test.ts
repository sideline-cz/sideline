// Plan §7 A — the migration half of "Make Event Types Custom" (Notion
// 3e393506-0818-80bd-b034-c5ff5ea668ea). Covers
// `1792400000_create_event_types.ts` end to end: per-team seeding, the
// bidirectional `events_sync_event_type` trigger, the uniqueness/colour
// CHECKs, and the three places the legal `kind`/`event_type` literal set is
// spelled out (this migration's `event_types.kind` CHECK, the pre-existing
// `events.event_type` CHECK, and `Event.EventType.literals` in
// `@sideline/domain`).
//
// Modeled on `personalEventChannelsBucket.test.ts`: these assert the SCHEMA
// and trigger behaviour the migration leaves behind, not repository code —
// there is no `EventTypesRepository` yet (task 3). Every insert/update that
// needs to set `event_type_id` explicitly goes through raw SQL for that
// reason; ordinary event creation goes through `EventsRepository.insertEvent`
// exactly as the app does today.

import { describe, expect, it } from '@effect/vitest';
import type { Team, TeamMember } from '@sideline/domain';
import { Event } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { eventBucketSql } from '~/repositories/personalChannelBucket.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createTeamMember, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
  EventsRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// A fixed future instant — every event in this file is a fixture, never asserted against
// the real clock, so an arbitrary far-future date is fine and never expires.
const FIXTURE_START = DateTime.fromDateUnsafe(new Date('2099-06-15T18:00:00Z'));

const seedTeamWithMember = Effect.Do.pipe(
  Effect.bind('owner', () => createUser('event-types-owner')),
  Effect.bind('team', ({ owner }) => createTeam(nextDiscordId(), owner.id)),
  Effect.bind('memberUser', () => createUser('event-types-member')),
  Effect.bind('member', ({ team, memberUser }) => createTeamMember(team.id, memberUser.id)),
  Effect.map(({ team, member }) => ({ team, member })),
);

type EventTypeRow = {
  id: string;
  name: string | null;
  kind: string;
  color: string;
  position: number;
  archived_at: Date | null;
  created_at: Date;
};

const getEventTypes = (teamId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<EventTypeRow>`
        SELECT id, name, kind, color, position, archived_at, created_at
        FROM event_types WHERE team_id = ${teamId} ORDER BY created_at, id
      `,
    ),
  );

const getEventTypeByKind = (teamId: string, kind: string) =>
  getEventTypes(teamId).pipe(
    Effect.map((rows) => rows.filter((r) => r.kind === kind && r.archived_at === null)),
    Effect.map((rows) => rows[0]),
  );

const insertEventType = (params: {
  teamId: string;
  kind: string;
  color?: string;
  name?: string | null;
  position?: number;
}) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<EventTypeRow>`
        INSERT INTO event_types (team_id, name, kind, color, position)
        VALUES (${params.teamId}, ${params.name ?? null}, ${params.kind}, ${params.color ?? 'blue'}, ${params.position ?? 99})
        RETURNING id, name, kind, color, position, archived_at, created_at
      `,
    ),
  );

const getEventRow = (eventId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{ id: string; event_type: string; event_type_id: string | null }>`
        SELECT id, event_type, event_type_id FROM events WHERE id = ${eventId}
      `,
    ),
    Effect.map((rows) => rows[0]),
  );

const insertEventRaw = (params: {
  teamId: string;
  createdBy: string;
  eventType: string;
  eventTypeId?: string | null;
  title?: string;
}) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{ id: string; event_type: string; event_type_id: string | null }>`
        INSERT INTO events (team_id, event_type, event_type_id, title, created_by, start_at)
        VALUES (
          ${params.teamId}, ${params.eventType}, ${params.eventTypeId ?? null},
          ${params.title ?? 'Raw test event'}, ${params.createdBy}, ${new Date('2099-06-15T18:00:00Z')}
        )
        RETURNING id, event_type, event_type_id
      `,
    ),
  );

const insertEventViaRepo = (
  teamId: Team.TeamId,
  memberId: TeamMember.TeamMemberId,
  eventType: Event.EventType,
) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType,
        title: `Repo event (${eventType})`,
        description: Option.none(),
        startAt: FIXTURE_START,
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy: memberId,
      }),
    ),
  );

// ---------------------------------------------------------------------------
// A1 — per-team seeding
// ---------------------------------------------------------------------------

describe('event_types — per-team seeding (Step 2/3)', () => {
  it.effect(
    'a newly created team is seeded with the six default types (Step 3 AFTER INSERT trigger)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember),
        Effect.bind('rows', ({ seed }) => getEventTypes(seed.team.id)),
        Effect.tap(({ rows }) =>
          Effect.sync(() => {
            expect(rows).toHaveLength(6);
            // Every seed row is unnamed — NULL renders the built-in translated label.
            expect(rows.every((r) => r.name === null)).toBe(true);
            expect(rows.every((r) => r.archived_at === null)).toBe(true);
            const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
            expect(byKind.training?.color).toBe('blue');
            expect(byKind.training?.position).toBe(0);
            expect(byKind.match?.color).toBe('red');
            expect(byKind.match?.position).toBe(1);
            expect(byKind.tournament?.color).toBe('orange');
            expect(byKind.tournament?.position).toBe(2);
            expect(byKind.meeting?.color).toBe('slate');
            expect(byKind.meeting?.position).toBe(3);
            expect(byKind.social?.color).toBe('pink');
            expect(byKind.social?.position).toBe(4);
            expect(byKind.other?.color).toBe('gray');
            expect(byKind.other?.position).toBe(5);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// id → kind (insert-time), legacy kind → id, and A8 foreign id discarded
// ---------------------------------------------------------------------------

describe('events_sync_event_type trigger — resolution on INSERT', () => {
  it.effect(
    "id wins at insert time: a conflicting event_type literal is overwritten from the id's kind",
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember),
        Effect.bind('matchType', ({ seed }) => getEventTypeByKind(seed.team.id, 'match')),
        // Deliberately pass a WRONG event_type ('other') alongside a 'match'-kind id.
        Effect.bind('inserted', ({ seed, matchType }) =>
          insertEventRaw({
            teamId: seed.team.id,
            createdBy: seed.member.id,
            eventType: 'other',
            eventTypeId: matchType?.id ?? null,
          }),
        ),
        Effect.tap(({ inserted, matchType }) =>
          Effect.sync(() => {
            expect(inserted[0]?.event_type).toBe('match');
            expect(inserted[0]?.event_type_id).toBe(matchType?.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    "legacy kind-only insert (no event_type_id) resolves to the team's matching-kind row",
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember),
        Effect.bind('trainingType', ({ seed }) => getEventTypeByKind(seed.team.id, 'training')),
        Effect.bind('event', ({ seed }) =>
          insertEventViaRepo(seed.team.id, seed.member.id, 'training'),
        ),
        Effect.bind('row', ({ event }) => getEventRow(event.id)),
        Effect.tap(({ row, trainingType }) =>
          Effect.sync(() => {
            expect(row?.event_type).toBe('training');
            expect(row?.event_type_id).toBe(trainingType?.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    "A8: a foreign team's event_type_id is discarded and the event resolves within its OWN team",
    () =>
      Effect.Do.pipe(
        Effect.bind('seedA', () => seedTeamWithMember),
        Effect.bind('ownerB', () => createUser('event-types-owner-b')),
        Effect.bind('teamB', ({ ownerB }) => createTeam(nextDiscordId(), ownerB.id)),
        Effect.bind('foreignMatchType', ({ teamB }) => getEventTypeByKind(teamB.id, 'match')),
        Effect.bind('ownMatchType', ({ seedA }) => getEventTypeByKind(seedA.team.id, 'match')),
        // Insert for team A but carry team B's id for the SAME kind.
        Effect.bind('inserted', ({ seedA, foreignMatchType }) =>
          insertEventRaw({
            teamId: seedA.team.id,
            createdBy: seedA.member.id,
            eventType: 'match',
            eventTypeId: foreignMatchType?.id ?? null,
          }),
        ),
        Effect.tap(({ inserted, ownMatchType, foreignMatchType }) =>
          Effect.sync(() => {
            // The team_id predicate in the trigger is the authorization boundary: the
            // foreign id must never survive, and event_type must stay correct.
            expect(inserted[0]?.event_type).toBe('match');
            expect(inserted[0]?.event_type_id).toBe(ownMatchType?.id);
            expect(inserted[0]?.event_type_id).not.toBe(foreignMatchType?.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// Resolution on UPDATE
// ---------------------------------------------------------------------------

describe('events_sync_event_type trigger — resolution on UPDATE', () => {
  it.effect('kind-only update (legacy path) re-resolves event_type_id from the new kind', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember),
      Effect.bind('socialType', ({ seed }) => getEventTypeByKind(seed.team.id, 'social')),
      Effect.bind('event', ({ seed }) =>
        insertEventViaRepo(seed.team.id, seed.member.id, 'training'),
      ),
      // The repository's updateEvent only ever writes `event_type`, never `event_type_id` —
      // exactly the "legacy web client" path this guard exists for.
      Effect.tap(({ event }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.updateEvent({
              id: event.id,
              title: event.title,
              eventType: 'social',
              trainingTypeId: Option.none(),
              description: Option.none(),
              startAt: FIXTURE_START,
              endAt: Option.none(),
              location: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('row', ({ event }) => getEventRow(event.id)),
      Effect.tap(({ row, socialType }) =>
        Effect.sync(() => {
          expect(row?.event_type).toBe('social');
          expect(row?.event_type_id).toBe(socialType?.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'id update drives kind: pointing event_type_id at a different-kind row flips event_type',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember),
        Effect.bind('meetingType', ({ seed }) => getEventTypeByKind(seed.team.id, 'meeting')),
        Effect.bind('event', ({ seed }) =>
          insertEventViaRepo(seed.team.id, seed.member.id, 'training'),
        ),
        Effect.tap(({ event, meetingType }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen(
              (sql) =>
                sql`UPDATE events SET event_type_id = ${meetingType?.id} WHERE id = ${event.id}`,
            ),
          ),
        ),
        Effect.bind('row', ({ event }) => getEventRow(event.id)),
        Effect.tap(({ row, meetingType }) =>
          Effect.sync(() => {
            expect(row?.event_type).toBe('meeting');
            expect(row?.event_type_id).toBe(meetingType?.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// A7 — rename does not move the bucket (through eventBucketSql, not event_type)
// ---------------------------------------------------------------------------

describe('event_types — rename is presentation-only (A7)', () => {
  it.effect(
    'renaming an event type changes nothing observed through eventBucketSql for its events',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember),
        Effect.bind('trainingType', ({ seed }) => getEventTypeByKind(seed.team.id, 'training')),
        Effect.bind('event', ({ seed }) =>
          insertEventViaRepo(seed.team.id, seed.member.id, 'training'),
        ),
        Effect.bind('bucketBefore', ({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen(
              (sql) =>
                sql<{
                  bucket: string;
                }>`SELECT ${sql.unsafe(eventBucketSql('e'))} AS bucket FROM events e WHERE e.id = ${event.id}`,
            ),
          ),
        ),
        // Rename the type — this NEVER touches the events table.
        Effect.tap(({ trainingType }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen(
              (sql) =>
                sql`UPDATE event_types SET name = 'Ranní tréninky' WHERE id = ${trainingType?.id}`,
            ),
          ),
        ),
        Effect.bind('bucketAfter', ({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen(
              (sql) =>
                sql<{
                  bucket: string;
                }>`SELECT ${sql.unsafe(eventBucketSql('e'))} AS bucket FROM events e WHERE e.id = ${event.id}`,
            ),
          ),
        ),
        Effect.tap(({ bucketBefore, bucketAfter }) =>
          Effect.sync(() => {
            expect(bucketBefore[0]?.bucket).toBe('training');
            expect(bucketAfter[0]?.bucket).toBe('training');
            expect(bucketAfter[0]?.bucket).toBe(bucketBefore[0]?.bucket);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// A7b — reorder does not re-target resolution (position never drives the query)
// ---------------------------------------------------------------------------

describe('event_types — reorder does not re-target kind resolution (A7b)', () => {
  it.effect(
    'moving a second training-kind type to position 0 does not steal future kind-only resolution from the older row',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember),
        Effect.bind('originalTraining', ({ seed }) => getEventTypeByKind(seed.team.id, 'training')),
        // A second, NEWER training-kind type for the same team.
        Effect.bind('newerTraining', ({ seed }) =>
          insertEventType({ teamId: seed.team.id, kind: 'training', name: 'Gym', position: 10 }),
        ),
        // Reorder: put the NEWER row at the front of the admin list.
        Effect.tap(({ newerTraining, originalTraining }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              Effect.all([
                sql`UPDATE event_types SET position = 0 WHERE id = ${newerTraining[0]?.id}`,
                sql`UPDATE event_types SET position = 1 WHERE id = ${originalTraining?.id}`,
              ]),
            ),
          ),
        ),
        Effect.bind('event', ({ seed }) =>
          insertEventViaRepo(seed.team.id, seed.member.id, 'training'),
        ),
        Effect.bind('row', ({ event }) => getEventRow(event.id)),
        Effect.tap(({ row, originalTraining, newerTraining }) =>
          Effect.sync(() => {
            // Resolution is (archived_at, created_at, id) — never position. The OLDEST
            // training row wins regardless of where the ▲ button just moved it.
            expect(row?.event_type_id).toBe(originalTraining?.id);
            expect(row?.event_type_id).not.toBe(newerTraining[0]?.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// Uniqueness, colour CHECK, archived-row behaviour
// ---------------------------------------------------------------------------

describe('event_types — uniqueness and CHECK constraints', () => {
  it.effect('name uniqueness is case-insensitive among active rows', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember),
      Effect.tap(({ seed }) =>
        insertEventType({ teamId: seed.team.id, kind: 'other', name: 'Beach party' }),
      ),
      Effect.bind('result', ({ seed }) =>
        insertEventType({ teamId: seed.team.id, kind: 'social', name: 'BEACH PARTY' }).pipe(
          Effect.result,
        ),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect("an archived type's name can be reused by a new active type", () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember),
      Effect.bind('original', ({ seed }) =>
        insertEventType({ teamId: seed.team.id, kind: 'other', name: 'Beach party' }),
      ),
      Effect.tap(({ original }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen(
            (sql) => sql`UPDATE event_types SET archived_at = now() WHERE id = ${original[0]?.id}`,
          ),
        ),
      ),
      Effect.bind('result', ({ seed }) =>
        insertEventType({ teamId: seed.team.id, kind: 'social', name: 'Beach party' }).pipe(
          Effect.result,
        ),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Success');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('the colour CHECK rejects a hue outside the fixed palette', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember),
      Effect.bind('result', ({ seed }) =>
        insertEventType({ teamId: seed.team.id, kind: 'other', color: 'violet' }).pipe(
          Effect.result,
        ),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('the kind CHECK rejects a value outside the fixed kind set', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember),
      Effect.bind('result', ({ seed }) =>
        insertEventType({ teamId: seed.team.id, kind: 'scrimmage' }).pipe(Effect.result),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('event_types — archived-row resolution', () => {
  it.effect(
    'an active type of a kind is preferred over an older archived type of the same kind',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember),
        Effect.bind('originalTraining', ({ seed }) => getEventTypeByKind(seed.team.id, 'training')),
        // Archive the original (oldest) training row.
        Effect.tap(({ originalTraining }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen(
              (sql) =>
                sql`UPDATE event_types SET archived_at = now() WHERE id = ${originalTraining?.id}`,
            ),
          ),
        ),
        // A brand-new, ACTIVE training-kind row, created strictly later.
        Effect.bind('newerActiveTraining', ({ seed }) =>
          insertEventType({ teamId: seed.team.id, kind: 'training', name: 'New training' }),
        ),
        Effect.bind('event', ({ seed }) =>
          insertEventViaRepo(seed.team.id, seed.member.id, 'training'),
        ),
        Effect.bind('row', ({ event }) => getEventRow(event.id)),
        Effect.tap(({ row, newerActiveTraining, originalTraining }) =>
          Effect.sync(() => {
            expect(row?.event_type_id).toBe(newerActiveTraining[0]?.id);
            expect(row?.event_type_id).not.toBe(originalTraining?.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('an archived type is still resolved to when it is the ONLY type of its kind', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember),
      Effect.bind('originalTraining', ({ seed }) => getEventTypeByKind(seed.team.id, 'training')),
      Effect.tap(({ originalTraining }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen(
            (sql) =>
              sql`UPDATE event_types SET archived_at = now() WHERE id = ${originalTraining?.id}`,
          ),
        ),
      ),
      Effect.bind('event', ({ seed }) =>
        insertEventViaRepo(seed.team.id, seed.member.id, 'training'),
      ),
      Effect.bind('row', ({ event }) => getEventRow(event.id)),
      Effect.tap(({ row, originalTraining }) =>
        Effect.sync(() => {
          // Falling back to an archived row (rather than leaving event_type_id NULL) is
          // the documented, legal outcome — an archived-but-referenced type still renders.
          expect(row?.event_type_id).toBe(originalTraining?.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// Step 4 — the one-time backfill statement
// ---------------------------------------------------------------------------

const disableSyncTrigger = SqlClient.SqlClient.asEffect().pipe(
  Effect.andThen((sql) => sql`ALTER TABLE events DISABLE TRIGGER events_sync_event_type_trg`),
);

const enableSyncTrigger = SqlClient.SqlClient.asEffect().pipe(
  Effect.andThen((sql) => sql`ALTER TABLE events ENABLE TRIGGER events_sync_event_type_trg`),
);

describe('event_types — the Step 4 backfill statement', () => {
  it.effect(
    'populates event_type_id for a pre-existing NULL row, matching by (team_id, kind)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember),
        Effect.bind('trainingType', ({ seed }) => getEventTypeByKind(seed.team.id, 'training')),
        // Simulate a row that predates the trigger: disable it, insert with event_type_id
        // left NULL (exactly the shape every pre-migration row has), then re-enable
        // immediately — the trigger's own behaviour is not what this test is about.
        Effect.tap(() => disableSyncTrigger),
        Effect.bind('inserted', ({ seed }) =>
          insertEventRaw({
            teamId: seed.team.id,
            createdBy: seed.member.id,
            eventType: 'training',
          }),
        ),
        Effect.tap(({ inserted }) =>
          Effect.sync(() => {
            expect(inserted[0]?.event_type_id).toBeNull();
          }),
        ),
        Effect.tap(() => enableSyncTrigger),
        // The literal Step 4 statement, scoped to this team so it cannot touch fixtures
        // from a concurrently-running case.
        Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
        Effect.tap(
          ({ sql, seed }) =>
            sql`
          UPDATE events e SET event_type_id = et.id FROM event_types et
          WHERE et.team_id = e.team_id AND et.kind = e.event_type AND e.event_type_id IS NULL
            AND e.team_id = ${seed.team.id}
        `,
        ),
        Effect.bind('after', ({ inserted }) => getEventRow(inserted[0]?.id ?? '')),
        Effect.tap(({ after, trainingType }) =>
          Effect.sync(() => {
            expect(after?.event_type_id).toBe(trainingType?.id);
          }),
        ),
        Effect.provide(TestLayer),
      ).pipe(Effect.ensuring(enableSyncTrigger.pipe(Effect.provide(TestPgClient), Effect.orDie))),
  );
});

// ---------------------------------------------------------------------------
// A14 — team delete does not storm (pg_trigger_depth() = 0 guard)
// ---------------------------------------------------------------------------

describe('event_types — team delete does not storm the trigger', () => {
  it.effect(
    'deleting a team with many events succeeds (ON DELETE CASCADE fan-out is guarded)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember),
        Effect.tap(({ seed }) =>
          Effect.forEach(
            Array.from({ length: 20 }, (_, i) => i),
            () => insertEventViaRepo(seed.team.id, seed.member.id, 'training'),
            { concurrency: 1 },
          ),
        ),
        Effect.bind('result', ({ seed }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) => sql`DELETE FROM teams WHERE id = ${seed.team.id}`),
            Effect.result,
          ),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Success');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// A15 — the three literal lists agree
// ---------------------------------------------------------------------------

const parseCheckLiterals = (def: string): string[] =>
  [...def.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');

const getConstraintLiterals = (table: string, likePattern: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{ def: string }>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = ${table}::regclass AND contype = 'c'
          AND conname LIKE ${likePattern}
      `,
    ),
    Effect.map((rows) => rows.flatMap((r) => parseCheckLiterals(r.def))),
  );

describe('event_types — A15: the three literal lists agree', () => {
  it.effect(
    'events.event_type CHECK, event_types.kind CHECK, and Event.EventType.literals are the same set',
    () =>
      Effect.Do.pipe(
        Effect.bind('eventsCheck', () => getConstraintLiterals('events', '%event_type%')),
        Effect.bind('eventTypesCheck', () => getConstraintLiterals('event_types', '%kind%')),
        Effect.tap(({ eventsCheck, eventTypesCheck }) =>
          Effect.sync(() => {
            const domainLiterals = new Set(Event.EventType.literals as ReadonlyArray<string>);
            expect(eventsCheck.length).toBeGreaterThan(0);
            expect(eventTypesCheck.length).toBeGreaterThan(0);
            expect(new Set(eventsCheck)).toEqual(domainLiterals);
            expect(new Set(eventTypesCheck)).toEqual(domainLiterals);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
