// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They require:
//   - EventsRepository.saveClaimThread(eventId, threadId) method
//   - New DB column: events.claim_thread_id (Discord.Snowflake nullable)
//   - EventClaimInfo.claim_thread_id field (already in domain as of this branch)
//
// The tests verify that:
//   1. After saving a thread id via saveClaimThread, findClaimInfo returns claim_thread_id.
//   2. claim_discord_channel_id and claim_discord_message_id are NOT overwritten
//      when saveClaimThread is called (regression guard).
//
// ASSUMPTION: saveClaimThread(eventId, threadId) is a new method on EventsRepository
//   that does: UPDATE events SET claim_thread_id = $threadId WHERE id = $eventId.
// ASSUMPTION: findClaimInfo already includes claim_thread_id in its result
//   (as EventClaimInfo already has that field in domain).

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
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
        name: 'Thread Test Team',
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
        overview_channel_id: Option.none(),
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

const seedTeamWithMember = (discordId: string, username: string, guildId: Discord.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(discordId, username)),
    Effect.bind('team', ({ userId }) => createTeam(guildId, userId)),
    Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
    Effect.map(({ team, member }) => ({ team, memberId: member.id })),
  );

const createTrainingEvent = (teamId: Team.TeamId, createdBy: string) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'training',
        title: 'Thread Test Training',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        discordTargetChannelId: Option.none(),
        createdBy: createdBy as any,
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventsRepository — saveClaimThread / findClaimInfo round-trip', () => {
  it.effect('after saveClaimThread, findClaimInfo returns claim_thread_id correctly', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '700000000000000001',
          'thread-owner-1',
          '701010101010101010' as Discord.Snowflake,
        ),
      ),
      Effect.bind('event', ({ seed }) => createTrainingEvent(seed.team.id, seed.memberId)),
      // Save a claim message first (claim_discord_channel_id + message_id)
      Effect.tap(({ event }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.saveClaimDiscordMessage(event.id, '700100000000000001', '700200000000000001'),
          ),
        ),
      ),
      // Now save the thread id
      Effect.tap(({ event }) =>
        EventsRepository.asEffect().pipe(
          // The new method is saveClaimThread(eventId, threadId)
          Effect.andThen((repo) =>
            repo.saveClaimThread(event.id, '700300000000000001' as Discord.Snowflake),
          ),
        ),
      ),
      Effect.bind('claimInfo', ({ event }) =>
        EventsRepository.asEffect().pipe(Effect.andThen((repo) => repo.findClaimInfo(event.id))),
      ),
      Effect.tap(({ claimInfo }) =>
        Effect.sync(() => {
          expect(Option.isSome(claimInfo)).toBe(true);
          const info = Option.getOrThrow(claimInfo);
          // claim_thread_id must be present
          expect(Option.isSome(info.claim_thread_id)).toBe(true);
          expect(Option.getOrNull(info.claim_thread_id)).toBe('700300000000000001');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'saveClaimThread does NOT overwrite claim_discord_channel_id or claim_discord_message_id (regression guard)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '700000000000000002',
            'thread-owner-2',
            '702020202020202020' as Discord.Snowflake,
          ),
        ),
        Effect.bind('event', ({ seed }) => createTrainingEvent(seed.team.id, seed.memberId)),
        // Set known claim discord channel + message
        Effect.tap(({ event }) =>
          EventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.saveClaimDiscordMessage(
                event.id,
                '700100000000000002', // claim_discord_channel_id
                '700200000000000002', // claim_discord_message_id
              ),
            ),
          ),
        ),
        // Save thread id
        Effect.tap(({ event }) =>
          EventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.saveClaimThread(event.id, '700300000000000002' as Discord.Snowflake),
            ),
          ),
        ),
        Effect.bind('claimInfo', ({ event }) =>
          EventsRepository.asEffect().pipe(Effect.andThen((repo) => repo.findClaimInfo(event.id))),
        ),
        Effect.tap(({ claimInfo }) =>
          Effect.sync(() => {
            expect(Option.isSome(claimInfo)).toBe(true);
            const info = Option.getOrThrow(claimInfo);
            // Original claim message fields must be unchanged
            expect(Option.isSome(info.claim_discord_channel_id)).toBe(true);
            expect(Option.getOrNull(info.claim_discord_channel_id)).toBe('700100000000000002');
            expect(Option.isSome(info.claim_discord_message_id)).toBe(true);
            expect(Option.getOrNull(info.claim_discord_message_id)).toBe('700200000000000002');
            // Thread id is the new addition
            expect(Option.isSome(info.claim_thread_id)).toBe(true);
            expect(Option.getOrNull(info.claim_thread_id)).toBe('700300000000000002');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'findClaimInfo returns claim_thread_id as None when saveClaimThread has not been called',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '700000000000000003',
            'thread-owner-3',
            '703030303030303030' as Discord.Snowflake,
          ),
        ),
        Effect.bind('event', ({ seed }) => createTrainingEvent(seed.team.id, seed.memberId)),
        Effect.bind('claimInfo', ({ event }) =>
          EventsRepository.asEffect().pipe(Effect.andThen((repo) => repo.findClaimInfo(event.id))),
        ),
        Effect.tap(({ claimInfo }) =>
          Effect.sync(() => {
            expect(Option.isSome(claimInfo)).toBe(true);
            const info = Option.getOrThrow(claimInfo);
            // claim_thread_id must be None before saveClaimThread is called
            expect(Option.isNone(info.claim_thread_id)).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
