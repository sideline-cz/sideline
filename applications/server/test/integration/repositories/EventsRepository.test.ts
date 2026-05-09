// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They verify that EventsRepository correctly persists and round-trips
// the image_url column added in the event-image-attachment feature.
// They will FAIL until the developer runs the migration and updates the
// repository.
//
// location_url tests (added in TDD mode for the location-split feature) are
// at the bottom of this file in the "EventsRepository — location_url" describe
// block.  They will FAIL until the migration adds the column and the repository
// is updated.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId,
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
        name: 'Test Team',
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
      }),
    ),
  );

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({
        team_id: teamId,
        user_id: userId,
        active: true,
        joined_at: undefined,
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventsRepository — image_url', () => {
  it.effect('insertEvent with imageUrl Some stores and round-trips the URL', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('300000000000000001', 'events-img-owner-1')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('301010101010101010' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('inserted', ({ team, tm }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertEvent({
              teamId: team.id,
              eventType: 'training',
              title: 'Event With Image',
              description: Option.none(),
              imageUrl: Option.some('https://example.com/x.png'),
              startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
              endAt: Option.none(),
              location: Option.none(),
              ownerGroupId: Option.none(),
              memberGroupId: Option.none(),
              trainingTypeId: Option.none(),
              seriesId: Option.none(),
              discordTargetChannelId: Option.none(),
              createdBy: (tm as any).id as TeamMember.TeamMemberId,
            }),
          ),
        ),
      ),
      Effect.bind('found', ({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEventByIdWithDetails(inserted.id)),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          expect(Option.isSome(row.image_url)).toBe(true);
          expect(Option.getOrNull(row.image_url)).toBe('https://example.com/x.png');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('insertEvent with imageUrl None stores null and round-trips as None', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('300000000000000002', 'events-img-owner-2')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('302020202020202020' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('inserted', ({ team, tm }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertEvent({
              teamId: team.id,
              eventType: 'training',
              title: 'Event Without Image',
              description: Option.none(),
              imageUrl: Option.none(),
              startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
              endAt: Option.none(),
              location: Option.none(),
              ownerGroupId: Option.none(),
              memberGroupId: Option.none(),
              trainingTypeId: Option.none(),
              seriesId: Option.none(),
              discordTargetChannelId: Option.none(),
              createdBy: (tm as any).id as TeamMember.TeamMemberId,
            }),
          ),
        ),
      ),
      Effect.bind('found', ({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEventByIdWithDetails(inserted.id)),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          expect(Option.isNone(row.image_url)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('insertEvent without imageUrl field defaults to None', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('300000000000000003', 'events-img-owner-3')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('303030303030303030' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('inserted', ({ team, tm }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            // Intentionally omit imageUrl — it should default to Option.none()
            repo.insertEvent({
              teamId: team.id,
              eventType: 'training',
              title: 'Event Default Image',
              description: Option.none(),
              startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
              endAt: Option.none(),
              location: Option.none(),
              ownerGroupId: Option.none(),
              memberGroupId: Option.none(),
              trainingTypeId: Option.none(),
              seriesId: Option.none(),
              discordTargetChannelId: Option.none(),
              createdBy: (tm as any).id as TeamMember.TeamMemberId,
            } as any),
          ),
        ),
      ),
      Effect.bind('found', ({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEventByIdWithDetails(inserted.id)),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          expect(Option.isNone(row.image_url)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('updateEvent can set imageUrl on an event that had none', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('300000000000000004', 'events-img-owner-4')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('304040404040404040' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('inserted', ({ team, tm }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertEvent({
              teamId: team.id,
              eventType: 'training',
              title: 'Update Image Test',
              description: Option.none(),
              imageUrl: Option.none(),
              startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
              endAt: Option.none(),
              location: Option.none(),
              ownerGroupId: Option.none(),
              memberGroupId: Option.none(),
              trainingTypeId: Option.none(),
              seriesId: Option.none(),
              discordTargetChannelId: Option.none(),
              createdBy: (tm as any).id as TeamMember.TeamMemberId,
            }),
          ),
        ),
      ),
      Effect.tap(({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.updateEvent({
              id: inserted.id,
              title: 'Update Image Test',
              eventType: 'training',
              trainingTypeId: Option.none(),
              description: Option.none(),
              imageUrl: Option.some('https://example.com/updated.png'),
              startAt: inserted.start_at,
              endAt: Option.none(),
              location: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('found', ({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEventByIdWithDetails(inserted.id)),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          expect(Option.isSome(row.image_url)).toBe(true);
          expect(Option.getOrNull(row.image_url)).toBe('https://example.com/updated.png');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('updateEvent can clear imageUrl (set to None) on an event that had one', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('300000000000000005', 'events-img-owner-5')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('305050505050505050' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('inserted', ({ team, tm }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertEvent({
              teamId: team.id,
              eventType: 'training',
              title: 'Clear Image Test',
              description: Option.none(),
              imageUrl: Option.some('https://example.com/to-clear.png'),
              startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
              endAt: Option.none(),
              location: Option.none(),
              ownerGroupId: Option.none(),
              memberGroupId: Option.none(),
              trainingTypeId: Option.none(),
              seriesId: Option.none(),
              discordTargetChannelId: Option.none(),
              createdBy: (tm as any).id as TeamMember.TeamMemberId,
            }),
          ),
        ),
      ),
      Effect.tap(({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.updateEvent({
              id: inserted.id,
              title: 'Clear Image Test',
              eventType: 'training',
              trainingTypeId: Option.none(),
              description: Option.none(),
              imageUrl: Option.none(),
              startAt: inserted.start_at,
              endAt: Option.none(),
              location: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('found', ({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEventByIdWithDetails(inserted.id)),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          expect(Option.isNone(row.image_url)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findByIdWithDetails round-trips image_url', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('300000000000000006', 'events-img-owner-6')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('306060606060606060' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('inserted', ({ team, tm }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertEvent({
              teamId: team.id,
              eventType: 'match',
              title: 'Round Trip Image',
              description: Option.none(),
              imageUrl: Option.some('https://cdn.example.com/event-banner.jpg'),
              startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
              endAt: Option.none(),
              location: Option.none(),
              ownerGroupId: Option.none(),
              memberGroupId: Option.none(),
              trainingTypeId: Option.none(),
              seriesId: Option.none(),
              discordTargetChannelId: Option.none(),
              createdBy: (tm as any).id as TeamMember.TeamMemberId,
            }),
          ),
        ),
      ),
      Effect.bind('found', ({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEventByIdWithDetails(inserted.id)),
        ),
      ),
      Effect.tap(({ found, inserted }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          expect(row.id).toBe(inserted.id);
          expect(Option.getOrNull(row.image_url)).toBe('https://cdn.example.com/event-banner.jpg');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// location_url tests
// ---------------------------------------------------------------------------

describe('EventsRepository — location_url', () => {
  it.effect('insertEvent with locationUrl Some stores and round-trips the URL', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('400000000000000001', 'events-loc-url-owner-1')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('401010101010101010' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('inserted', ({ team, tm }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertEvent({
              teamId: team.id,
              eventType: 'training',
              title: 'Event With Location URL',
              description: Option.none(),
              imageUrl: Option.none(),
              startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
              endAt: Option.none(),
              location: Option.some('Main Field'),
              locationUrl: Option.some('https://maps.google.com/x'),
              ownerGroupId: Option.none(),
              memberGroupId: Option.none(),
              trainingTypeId: Option.none(),
              seriesId: Option.none(),
              discordTargetChannelId: Option.none(),
              createdBy: (tm as any).id as TeamMember.TeamMemberId,
            }),
          ),
        ),
      ),
      Effect.bind('found', ({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEventByIdWithDetails(inserted.id)),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          expect(Option.isSome(row.location_url)).toBe(true);
          expect(Option.getOrNull(row.location_url)).toBe('https://maps.google.com/x');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('insertEvent with locationUrl None stores null and round-trips as None', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('400000000000000002', 'events-loc-url-owner-2')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('402020202020202020' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('inserted', ({ team, tm }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertEvent({
              teamId: team.id,
              eventType: 'training',
              title: 'Event Without Location URL',
              description: Option.none(),
              imageUrl: Option.none(),
              startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
              endAt: Option.none(),
              location: Option.some('Main Field'),
              locationUrl: Option.none(),
              ownerGroupId: Option.none(),
              memberGroupId: Option.none(),
              trainingTypeId: Option.none(),
              seriesId: Option.none(),
              discordTargetChannelId: Option.none(),
              createdBy: (tm as any).id as TeamMember.TeamMemberId,
            }),
          ),
        ),
      ),
      Effect.bind('found', ({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEventByIdWithDetails(inserted.id)),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          expect(Option.isNone(row.location_url)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('updateEvent can set locationUrl on an event that had none', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('400000000000000003', 'events-loc-url-owner-3')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('403030303030303030' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('inserted', ({ team, tm }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertEvent({
              teamId: team.id,
              eventType: 'training',
              title: 'Set Location URL Test',
              description: Option.none(),
              imageUrl: Option.none(),
              startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
              endAt: Option.none(),
              location: Option.some('Main Field'),
              locationUrl: Option.none(),
              ownerGroupId: Option.none(),
              memberGroupId: Option.none(),
              trainingTypeId: Option.none(),
              seriesId: Option.none(),
              discordTargetChannelId: Option.none(),
              createdBy: (tm as any).id as TeamMember.TeamMemberId,
            }),
          ),
        ),
      ),
      Effect.tap(({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.updateEvent({
              id: inserted.id,
              title: 'Set Location URL Test',
              eventType: 'training',
              trainingTypeId: Option.none(),
              description: Option.none(),
              imageUrl: Option.none(),
              startAt: inserted.start_at,
              endAt: Option.none(),
              location: Option.some('Main Field'),
              locationUrl: Option.some('https://maps.google.com/updated'),
            }),
          ),
        ),
      ),
      Effect.bind('found', ({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEventByIdWithDetails(inserted.id)),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          expect(Option.isSome(row.location_url)).toBe(true);
          expect(Option.getOrNull(row.location_url)).toBe('https://maps.google.com/updated');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('updateEvent can clear locationUrl (set to None) on an event that had one', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('400000000000000004', 'events-loc-url-owner-4')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('404040404040404040' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('inserted', ({ team, tm }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertEvent({
              teamId: team.id,
              eventType: 'training',
              title: 'Clear Location URL Test',
              description: Option.none(),
              imageUrl: Option.none(),
              startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
              endAt: Option.none(),
              location: Option.some('Main Field'),
              locationUrl: Option.some('https://maps.google.com/to-clear'),
              ownerGroupId: Option.none(),
              memberGroupId: Option.none(),
              trainingTypeId: Option.none(),
              seriesId: Option.none(),
              discordTargetChannelId: Option.none(),
              createdBy: (tm as any).id as TeamMember.TeamMemberId,
            }),
          ),
        ),
      ),
      Effect.tap(({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.updateEvent({
              id: inserted.id,
              title: 'Clear Location URL Test',
              eventType: 'training',
              trainingTypeId: Option.none(),
              description: Option.none(),
              imageUrl: Option.none(),
              startAt: inserted.start_at,
              endAt: Option.none(),
              location: Option.some('Main Field'),
              locationUrl: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('found', ({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEventByIdWithDetails(inserted.id)),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          expect(Option.isNone(row.location_url)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findEventByIdWithDetails round-trips location_url', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('400000000000000005', 'events-loc-url-owner-5')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('405050505050505050' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('inserted', ({ team, tm }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insertEvent({
              teamId: team.id,
              eventType: 'match',
              title: 'Round Trip Location URL',
              description: Option.none(),
              imageUrl: Option.none(),
              startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
              endAt: Option.none(),
              location: Option.some('Stadium'),
              locationUrl: Option.some('https://maps.google.com/round-trip'),
              ownerGroupId: Option.none(),
              memberGroupId: Option.none(),
              trainingTypeId: Option.none(),
              seriesId: Option.none(),
              discordTargetChannelId: Option.none(),
              createdBy: (tm as any).id as TeamMember.TeamMemberId,
            }),
          ),
        ),
      ),
      Effect.bind('found', ({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEventByIdWithDetails(inserted.id)),
        ),
      ),
      Effect.tap(({ found, inserted }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          expect(row.id).toBe(inserted.id);
          expect(Option.getOrNull(row.location_url)).toBe('https://maps.google.com/round-trip');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
