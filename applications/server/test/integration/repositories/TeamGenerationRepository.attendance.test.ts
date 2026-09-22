// `findYesMembersForEvent` is the auto-balancer's player pool
// (docs/plans/rsvp-maybe-restore.md, "Why the attendance change matters" —
// `TeamGenerationRepository.ts:111` narrows to `IN ('yes', 'coming_later')`).
// A `maybe` ("Nevím") responder must not be offered up for team generation.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamGenerationRepository } from '~/repositories/TeamGenerationRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventRsvpsRepository.Default,
  EventsRepository.Default,
  TeamGenerationRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

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
        name: 'Team Generation Attendance Test Team',
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

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
    Effect.map((tm) => tm.id),
  );

const createEvent = (teamId: Team.TeamId, createdBy: TeamMember.TeamMemberId) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'training',
        title: 'Team Generation Pool Event',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy,
      }),
    ),
  );

describe('TeamGenerationRepository.findYesMembersForEvent — attendance narrowing', () => {
  it.effect('excludes a maybe responder, includes yes and coming_later responders', () =>
    Effect.Do.pipe(
      Effect.bind('ownerUserId', () => createUser('950100000000000001', 'tg-attend-owner')),
      Effect.bind('yesUserId', () => createUser('950100000000000002', 'tg-attend-yes')),
      Effect.bind('comingLaterUserId', () =>
        createUser('950100000000000003', 'tg-attend-coming-later'),
      ),
      Effect.bind('maybeUserId', () => createUser('950100000000000004', 'tg-attend-maybe')),
      Effect.bind('team', ({ ownerUserId }) =>
        createTeam('951010101010101010' as Discord.Snowflake, ownerUserId),
      ),
      Effect.bind('ownerMemberId', ({ team, ownerUserId }) => addTeamMember(team.id, ownerUserId)),
      Effect.bind('yesMemberId', ({ team, yesUserId }) => addTeamMember(team.id, yesUserId)),
      Effect.bind('comingLaterMemberId', ({ team, comingLaterUserId }) =>
        addTeamMember(team.id, comingLaterUserId),
      ),
      Effect.bind('maybeMemberId', ({ team, maybeUserId }) => addTeamMember(team.id, maybeUserId)),
      Effect.bind('event', ({ team, ownerMemberId }) => createEvent(team.id, ownerMemberId)),
      Effect.tap(({ event, yesMemberId }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.upsertRsvp(event.id, yesMemberId, 'yes', Option.none())),
        ),
      ),
      Effect.tap(({ event, comingLaterMemberId }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsertRsvp(
              event.id,
              comingLaterMemberId,
              'coming_later',
              Option.some('running late'),
            ),
          ),
        ),
      ),
      Effect.tap(({ event, maybeMemberId }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsertRsvp(event.id, maybeMemberId, 'maybe', Option.none()),
          ),
        ),
      ),
      Effect.bind('rows', ({ event }) =>
        TeamGenerationRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findYesMembersForEvent(event.id)),
        ),
      ),
      Effect.tap(({ rows, yesMemberId, comingLaterMemberId, maybeMemberId }) =>
        Effect.sync(() => {
          const ids = rows.map((r) => r.team_member_id);
          expect(ids).toContain(yesMemberId);
          expect(ids).toContain(comingLaterMemberId);
          expect(ids).not.toContain(maybeMemberId);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
