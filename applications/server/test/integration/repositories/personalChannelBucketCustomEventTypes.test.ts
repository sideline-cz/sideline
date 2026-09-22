// Plan §7 B — the "Nastavitelná docházka" bucket regression for the new custom
// event types (Notion 3e393506-0818-80bd-b034-c5ff5ea668ea). `eventBucketSql`
// (and the shared fragments in `~/repositories/personalChannelBucket.ts`) route
// off the legacy `events.event_type` enum column, which the new
// `events_sync_event_type` trigger keeps in sync with whatever `event_types`
// row an event resolves to. A team renaming or naming a type must NEVER change
// which personal-channel bucket its events land in — only `kind` may.
//
// Modeled on `PersonalEventChannelsRepository.test.ts` (bucket-aware sections).

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { PersonalEventChannelsRepository } from '~/repositories/PersonalEventChannelsRepository.js';
import { deprovisionableBucketSql } from '~/repositories/personalChannelBucket.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createTeamMember, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventsRepository.Default,
  PersonalEventChannelsRepository.Default,
  TeamMembersRepository.Default,
  TeamSettingsRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const seedTeamWithMember = (suffix: string) =>
  Effect.Do.pipe(
    Effect.bind('owner', () => createUser(`custom-et-owner-${suffix}`)),
    Effect.bind('team', ({ owner }) => createTeam(nextDiscordId(), owner.id)),
    Effect.bind('memberUser', () => createUser(`custom-et-member-${suffix}`)),
    Effect.bind('member', ({ team, memberUser }) => createTeamMember(team.id, memberUser.id)),
    Effect.map(({ team, member }) => ({ team, member })),
  );

type EventTypeRow = { id: string };

/** Insert a CUSTOM (team-authored, non-seed) event type directly — there is no
 * repository for `event_types` yet (task 3). */
const insertCustomEventType = (params: {
  teamId: Team.TeamId;
  kind: string;
  name: string;
  color?: string;
}) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<EventTypeRow>`
        INSERT INTO event_types (team_id, name, kind, color, position)
        VALUES (${params.teamId}, ${params.name}, ${params.kind}, ${params.color ?? 'purple'}, 99)
        RETURNING id
      `,
    ),
  );

/** Insert an event that carries a specific (possibly custom) event_type_id.
 * Bypasses `EventsRepository.insertEvent` (which doesn't know about
 * `event_type_id` yet) — the `events_sync_event_type` trigger derives
 * `event_type` from the id regardless of what literal is passed here. */
const insertEventForType = (params: {
  teamId: Team.TeamId;
  createdBy: TeamMember.TeamMemberId;
  eventTypeId: string;
  placeholderKind?: string;
}) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{ id: string; event_type: string }>`
        INSERT INTO events (team_id, event_type, event_type_id, title, created_by, start_at)
        VALUES (
          ${params.teamId}, ${params.placeholderKind ?? 'other'}, ${params.eventTypeId},
          'Custom-type routing test', ${params.createdBy}, ${new Date('2099-06-15T18:00:00Z')}
        )
        RETURNING id, event_type
      `,
    ),
  );

const getEventBucket = (eventId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{ bucket: string }>`
        SELECT CASE e.event_type
          WHEN 'training' THEN 'training'
          WHEN 'match' THEN 'tournament'
          WHEN 'tournament' THEN 'tournament'
          ELSE 'other'
        END AS bucket
        FROM events e WHERE e.id = ${eventId}
      `,
    ),
    Effect.map((rows) => rows[0]?.bucket),
  );

describe('personal channel bucket routing is unaffected by custom event-type names', () => {
  it.effect(
    'a custom kind=\'match\' type named "Beach party" still routes to the "tournament" bucket',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember('match')),
        Effect.bind('customType', ({ seed }) =>
          insertCustomEventType({ teamId: seed.team.id, kind: 'match', name: 'Beach party' }),
        ),
        Effect.bind('event', ({ seed, customType }) =>
          insertEventForType({
            teamId: seed.team.id,
            createdBy: seed.member.id,
            eventTypeId: customType[0]?.id ?? '',
          }),
        ),
        Effect.bind('bucket', ({ event }) => getEventBucket(event[0]?.id ?? '')),
        Effect.tap(({ bucket, event }) =>
          Effect.sync(() => {
            expect(event[0]?.event_type).toBe('match');
            expect(bucket).toBe('tournament');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('a custom kind=\'training\' type routes to the "training" bucket', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember('training')),
      Effect.bind('customType', ({ seed }) =>
        insertCustomEventType({ teamId: seed.team.id, kind: 'training', name: 'Ranní tréninky' }),
      ),
      Effect.bind('event', ({ seed, customType }) =>
        insertEventForType({
          teamId: seed.team.id,
          createdBy: seed.member.id,
          eventTypeId: customType[0]?.id ?? '',
        }),
      ),
      Effect.bind('bucket', ({ event }) => getEventBucket(event[0]?.id ?? '')),
      Effect.tap(({ bucket }) =>
        Effect.sync(() => {
          expect(bucket).toBe('training');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  for (const kind of ['meeting', 'social', 'other'] as const) {
    it.effect(`a custom kind='${kind}' type routes to the "other" bucket`, () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember(`other-${kind}`)),
        Effect.bind('customType', ({ seed }) =>
          insertCustomEventType({ teamId: seed.team.id, kind, name: `Custom ${kind}` }),
        ),
        Effect.bind('event', ({ seed, customType }) =>
          insertEventForType({
            teamId: seed.team.id,
            createdBy: seed.member.id,
            eventTypeId: customType[0]?.id ?? '',
            placeholderKind: kind,
          }),
        ),
        Effect.bind('bucket', ({ event }) => getEventBucket(event[0]?.id ?? '')),
        Effect.tap(({ bucket }) =>
          Effect.sync(() => {
            expect(bucket).toBe('other');
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );
  }

  it.effect("renaming a custom event type changes no already-routed event's bucket", () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamWithMember('rename')),
      Effect.bind('customType', ({ seed }) =>
        insertCustomEventType({ teamId: seed.team.id, kind: 'match', name: 'Beach party' }),
      ),
      Effect.bind('event', ({ seed, customType }) =>
        insertEventForType({
          teamId: seed.team.id,
          createdBy: seed.member.id,
          eventTypeId: customType[0]?.id ?? '',
        }),
      ),
      Effect.bind('bucketBefore', ({ event }) => getEventBucket(event[0]?.id ?? '')),
      Effect.tap(({ customType }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen(
            (sql) =>
              sql`UPDATE event_types SET name = 'Summer beach cup' WHERE id = ${customType[0]?.id}`,
          ),
        ),
      ),
      Effect.bind('bucketAfter', ({ event }) => getEventBucket(event[0]?.id ?? '')),
      Effect.tap(({ bucketBefore, bucketAfter }) =>
        Effect.sync(() => {
          expect(bucketBefore).toBe('tournament');
          expect(bucketAfter).toBe('tournament');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// The tripwire: `_getObsoleteBuckets` and `_getGuildsNeedingProvisioning`
// branch (e) splice the SAME `deprovisionableBucketSql` fragment and must
// agree. If a future edit to `personalChannelBucket.ts` (or an inline rewrite
// at one of its two call sites) breaks that, this is where it shows up.
// ---------------------------------------------------------------------------

const setPersonalChannelsSplit = (memberId: TeamMember.TeamMemberId, value: boolean) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql`UPDATE team_members SET personal_channels_split = ${value} WHERE id = ${memberId}`.pipe(
        Effect.asVoid,
      ),
    ),
  );

const setTeamPersonalEventsCategory = (teamId: Team.TeamId, categoryId: Discord.Snowflake) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsert({
        teamId,
        eventHorizonDays: 30,
        minPlayersThreshold: 0,
        discordPersonalEventsCategoryId: Option.some(categoryId),
      }),
    ),
  );

describe('deprovisionableBucketSql agrees between _getObsoleteBuckets and _getGuildsNeedingProvisioning branch (e)', () => {
  it.effect(
    'one desired bucket left unprovisioned: _getObsoleteBuckets is empty, and the shared predicate independently says the old "all" channel is NOT deprovisionable',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamWithMember('tripwire')),
        Effect.tap(({ seed }) =>
          setTeamPersonalEventsCategory(seed.team.id, `900${nextDiscordId()}` as Discord.Snowflake),
        ),
        // Combined mode, with a provisioned "all" channel (about to become obsolete
        // once — and only once — every split bucket exists).
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo
                .reservePersonalChannel(seed.team.id, seed.member.id, 'all')
                .pipe(
                  Effect.andThen(() =>
                    repo.savePersonalChannelId(
                      seed.team.id,
                      seed.member.id,
                      `910${nextDiscordId()}` as Discord.Snowflake,
                      'events-{discord_id}',
                      'all',
                    ),
                  ),
                ),
            ),
          ),
        ),
        Effect.tap(({ seed }) => setPersonalChannelsSplit(seed.member.id, true)),
        // Only training + tournament are provisioned — "other" is deliberately left
        // unreserved, so the B3 gate must hold the old "all" channel open.
        Effect.tap(({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              Effect.forEach(
                ['training', 'tournament'] as const,
                (bucket) =>
                  repo
                    .reservePersonalChannel(seed.team.id, seed.member.id, bucket)
                    .pipe(
                      Effect.andThen(() =>
                        repo.savePersonalChannelId(
                          seed.team.id,
                          seed.member.id,
                          `${920 + (bucket === 'training' ? 1 : 2)}${nextDiscordId()}` as Discord.Snowflake,
                          'events-{discord_id}',
                          bucket,
                        ),
                      ),
                    ),
                { concurrency: 1 },
              ),
            ),
          ),
        ),
        Effect.bind('obsolete', ({ seed }) =>
          PersonalEventChannelsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.getObsoleteBucketsToDeprovision(seed.team.id, 100)),
          ),
        ),
        // The raw predicate, spliced directly against the "all" row, exactly as
        // `_getGuildsNeedingProvisioning` branch (e) does.
        Effect.bind('rawObsolete', ({ seed }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen(
              (sql) => sql<{ obsolete: boolean }>`
                SELECT (${sql.unsafe(deprovisionableBucketSql('tm', 'pec'))}) AS obsolete
                FROM personal_event_channels pec
                JOIN team_members tm ON tm.id = pec.team_member_id AND tm.team_id = pec.team_id
                WHERE pec.team_id = ${seed.team.id} AND pec.bucket = 'all'
              `,
            ),
          ),
        ),
        Effect.tap(({ obsolete, rawObsolete, seed }) =>
          Effect.sync(() => {
            const mine = (obsolete as ReadonlyArray<{ team_member_id: string }>).filter(
              (r) => r.team_member_id === seed.member.id,
            );
            expect(mine).toHaveLength(0);
            expect(rawObsolete[0]?.obsolete).toBe(false);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
