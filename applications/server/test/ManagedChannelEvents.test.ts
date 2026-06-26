/**
 * Tests for the `constructEvent` matcher in `applications/server/src/rpc/channel/events.ts`.
 *
 * Focuses on managed entity_type branches and regression checks for group/roster rows.
 */

import type {
  ChannelSyncEvent,
  Discord,
  GroupModel,
  RosterModel,
  Team,
  TeamChannel,
  TeamMember,
} from '@sideline/domain';
import { Effect, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { EventRow } from '~/repositories/ChannelSyncEventsRepository.js';
import { constructEvent, EventPropertyMissing } from '~/rpc/channel/events.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const EVENT_ID = 'evt-00000000-0000-0000-0000-000000000001' as ChannelSyncEvent.ChannelSyncEventId;
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const TEAM_CHANNEL_ID = '00000000-0000-0000-0000-000000000020' as TeamChannel.TeamChannelId;
const DISCORD_CHANNEL_ID = '111111111111111111' as Discord.Snowflake;
const DISCORD_ROLE_ID = '222222222222222222' as Discord.Snowflake;
const ARCHIVE_CATEGORY_ID = '333333333333333333' as Discord.Snowflake;
const GROUP_ID = '00000000-0000-0000-0000-000000000030' as GroupModel.GroupId;
const ROSTER_ID = '00000000-0000-0000-0000-000000000040' as RosterModel.RosterId;
const MEMBER_ID = '00000000-0000-0000-0000-000000000050' as TeamMember.TeamMemberId;
const DISCORD_USER_ID = '444444444444444444' as Discord.Snowflake;

const baseRow = (
  event_type: ChannelSyncEvent.ChannelSyncEventType,
  entity_type: ChannelSyncEvent.ChannelSyncEntityType,
  overrides: Partial<EventRow> = {},
): EventRow =>
  new EventRow({
    id: EVENT_ID,
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    event_type,
    entity_type,
    group_id: Option.none(),
    group_name: Option.none(),
    team_member_id: Option.none(),
    discord_user_id: Option.none(),
    roster_id: Option.none(),
    roster_name: Option.none(),
    existing_channel_id: Option.none(),
    discord_role_id: Option.none(),
    archive_category_id: Option.none(),
    target_category_id: Option.none(),
    discord_channel_name: Option.none(),
    discord_role_name: Option.none(),
    discord_role_color: Option.none(),
    team_channel_id: Option.none(),
    access_level: Option.none(),
    ...overrides,
  });

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, never>);
const runFail = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flip(effect as Effect.Effect<A, E>));

// ---------------------------------------------------------------------------
// channel_created + managed
// ---------------------------------------------------------------------------

describe('constructEvent — managed channel_created', () => {
  it('produces ManagedChannelCreatedEvent with team_channel_id and discord_channel_name', async () => {
    const row = baseRow('channel_created', 'managed', {
      team_channel_id: Option.some(TEAM_CHANNEL_ID),
      discord_channel_name: Option.some('general'),
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('managed_channel_created');
    if (event._tag !== 'managed_channel_created') return;
    expect(event.team_channel_id).toBe(TEAM_CHANNEL_ID);
    expect(event.discord_channel_name).toBe('general');
    expect(event.guild_id).toBe(GUILD_ID);
  });

  it('fails with EventPropertyMissing when team_channel_id is absent', async () => {
    const row = baseRow('channel_created', 'managed', {
      discord_channel_name: Option.some('general'),
      // team_channel_id is Option.none()
    });

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toBe('team_channel_id');
  });

  it('fails with EventPropertyMissing when discord_channel_name is absent', async () => {
    const row = baseRow('channel_created', 'managed', {
      team_channel_id: Option.some(TEAM_CHANNEL_ID),
      // discord_channel_name is Option.none()
    });

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toBe('discord_channel_name');
  });
});

// ---------------------------------------------------------------------------
// channel_archived + managed
// ---------------------------------------------------------------------------

describe('constructEvent — managed channel_archived', () => {
  it('produces ManagedChannelArchivedEvent with archive_category_id and optional discord_channel_id', async () => {
    const row = baseRow('channel_archived', 'managed', {
      team_channel_id: Option.some(TEAM_CHANNEL_ID),
      existing_channel_id: Option.some(DISCORD_CHANNEL_ID),
      archive_category_id: Option.some(ARCHIVE_CATEGORY_ID),
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('managed_channel_archived');
    if (event._tag !== 'managed_channel_archived') return;
    expect(event.team_channel_id).toBe(TEAM_CHANNEL_ID);
    expect(event.archive_category_id).toBe(ARCHIVE_CATEGORY_ID);
    expect(Option.isSome(event.discord_channel_id)).toBe(true);
    if (Option.isSome(event.discord_channel_id)) {
      expect(event.discord_channel_id.value).toBe(DISCORD_CHANNEL_ID);
    }
  });

  it('produces ManagedChannelArchivedEvent with none discord_channel_id when absent', async () => {
    const row = baseRow('channel_archived', 'managed', {
      team_channel_id: Option.some(TEAM_CHANNEL_ID),
      archive_category_id: Option.some(ARCHIVE_CATEGORY_ID),
      // existing_channel_id is Option.none()
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('managed_channel_archived');
    if (event._tag !== 'managed_channel_archived') return;
    expect(Option.isNone(event.discord_channel_id)).toBe(true);
  });

  it('fails with EventPropertyMissing when archive_category_id is absent', async () => {
    const row = baseRow('channel_archived', 'managed', {
      team_channel_id: Option.some(TEAM_CHANNEL_ID),
      // archive_category_id is Option.none()
    });

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toBe('archive_category_id');
  });
});

// ---------------------------------------------------------------------------
// channel_deleted + managed
// ---------------------------------------------------------------------------

describe('constructEvent — managed channel_deleted', () => {
  it('produces ManagedChannelDeletedEvent', async () => {
    const row = baseRow('channel_deleted', 'managed', {
      team_channel_id: Option.some(TEAM_CHANNEL_ID),
      existing_channel_id: Option.some(DISCORD_CHANNEL_ID),
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('managed_channel_deleted');
    if (event._tag !== 'managed_channel_deleted') return;
    expect(event.team_channel_id).toBe(TEAM_CHANNEL_ID);
    if (Option.isSome(event.discord_channel_id)) {
      expect(event.discord_channel_id.value).toBe(DISCORD_CHANNEL_ID);
    }
  });

  it('produces ManagedChannelDeletedEvent with none discord_channel_id', async () => {
    const row = baseRow('channel_deleted', 'managed', {
      team_channel_id: Option.some(TEAM_CHANNEL_ID),
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('managed_channel_deleted');
    if (event._tag !== 'managed_channel_deleted') return;
    expect(Option.isNone(event.discord_channel_id)).toBe(true);
  });

  it('fails with EventPropertyMissing when team_channel_id is absent', async () => {
    const row = baseRow('channel_deleted', 'managed');

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
  });
});

// ---------------------------------------------------------------------------
// member_added + managed → ManagedChannelAccessGrantedEvent
// ---------------------------------------------------------------------------

describe('constructEvent — managed member_added (access granted)', () => {
  it('produces ManagedChannelAccessGrantedEvent with all required fields', async () => {
    const row = baseRow('member_added', 'managed', {
      team_channel_id: Option.some(TEAM_CHANNEL_ID),
      existing_channel_id: Option.some(DISCORD_CHANNEL_ID),
      discord_role_id: Option.some(DISCORD_ROLE_ID),
      access_level: Option.some('EDIT' as const),
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('managed_access_granted');
    if (event._tag !== 'managed_access_granted') return;
    expect(event.team_channel_id).toBe(TEAM_CHANNEL_ID);
    expect(event.discord_channel_id).toBe(DISCORD_CHANNEL_ID);
    expect(event.discord_role_id).toBe(DISCORD_ROLE_ID);
    expect(event.access_level).toBe('EDIT');
  });

  it('fails with EventPropertyMissing when access_level is absent', async () => {
    const row = baseRow('member_added', 'managed', {
      team_channel_id: Option.some(TEAM_CHANNEL_ID),
      existing_channel_id: Option.some(DISCORD_CHANNEL_ID),
      discord_role_id: Option.some(DISCORD_ROLE_ID),
      // access_level is Option.none()
    });

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toBe('access_level');
  });

  it('fails with EventPropertyMissing when existing_channel_id is absent', async () => {
    const row = baseRow('member_added', 'managed', {
      team_channel_id: Option.some(TEAM_CHANNEL_ID),
      discord_role_id: Option.some(DISCORD_ROLE_ID),
      access_level: Option.some('VIEW' as const),
    });

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toBe('existing_channel_id');
  });
});

// ---------------------------------------------------------------------------
// member_removed + managed → ManagedChannelAccessRevokedEvent
// ---------------------------------------------------------------------------

describe('constructEvent — managed member_removed (access revoked)', () => {
  it('produces ManagedChannelAccessRevokedEvent', async () => {
    const row = baseRow('member_removed', 'managed', {
      existing_channel_id: Option.some(DISCORD_CHANNEL_ID),
      discord_role_id: Option.some(DISCORD_ROLE_ID),
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('managed_access_revoked');
    if (event._tag !== 'managed_access_revoked') return;
    expect(event.discord_channel_id).toBe(DISCORD_CHANNEL_ID);
    expect(event.discord_role_id).toBe(DISCORD_ROLE_ID);
  });

  it('fails with EventPropertyMissing when discord_channel_id is absent', async () => {
    const row = baseRow('member_removed', 'managed', {
      discord_role_id: Option.some(DISCORD_ROLE_ID),
    });

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toBe('existing_channel_id');
  });
});

// ---------------------------------------------------------------------------
// channel_archived + entity_type='discord' → DiscordChannelArchivedEvent
// ---------------------------------------------------------------------------

describe('constructEvent — discord channel_archived', () => {
  it('produces DiscordChannelArchivedEvent with discord_channel_id Some + archive_category_id', async () => {
    const row = baseRow('channel_archived', 'discord', {
      existing_channel_id: Option.some(DISCORD_CHANNEL_ID),
      archive_category_id: Option.some(ARCHIVE_CATEGORY_ID),
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('discord_channel_archived');
    if (event._tag !== 'discord_channel_archived') return;
    expect(Option.isSome(event.discord_channel_id)).toBe(true);
    if (Option.isSome(event.discord_channel_id)) {
      expect(event.discord_channel_id.value).toBe(DISCORD_CHANNEL_ID);
    }
    expect(event.archive_category_id).toBe(ARCHIVE_CATEGORY_ID);
    expect(event.guild_id).toBe(GUILD_ID);
  });

  it('produces DiscordChannelArchivedEvent with discord_channel_id None when existing_channel_id absent', async () => {
    const row = baseRow('channel_archived', 'discord', {
      archive_category_id: Option.some(ARCHIVE_CATEGORY_ID),
      // existing_channel_id stays Option.none()
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('discord_channel_archived');
    if (event._tag !== 'discord_channel_archived') return;
    expect(Option.isNone(event.discord_channel_id)).toBe(true);
    expect(event.archive_category_id).toBe(ARCHIVE_CATEGORY_ID);
  });

  it('fails with EventPropertyMissing when archive_category_id is absent', async () => {
    const row = baseRow('channel_archived', 'discord', {
      existing_channel_id: Option.some(DISCORD_CHANNEL_ID),
      // archive_category_id stays Option.none()
    });

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toBe('archive_category_id');
  });
});

// ---------------------------------------------------------------------------
// Impossible-state guards: discord entity_type for non-channel_archived event_types
// ---------------------------------------------------------------------------

describe('constructEvent — impossible-state guards for discord entity_type', () => {
  it('channel_created + discord → fails with EventPropertyMissing (impossible state)', async () => {
    const row = baseRow('channel_created', 'discord');

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toContain('discord');
  });

  it('channel_updated + discord → fails with EventPropertyMissing (impossible state)', async () => {
    const row = baseRow('channel_updated', 'discord');

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toContain('discord');
  });

  it('channel_deleted + discord → fails with EventPropertyMissing (impossible state)', async () => {
    const row = baseRow('channel_deleted', 'discord');

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toContain('discord');
  });

  it('member_added + discord → fails with EventPropertyMissing (impossible state)', async () => {
    const row = baseRow('member_added', 'discord');

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toContain('discord');
  });

  it('member_removed + discord → fails with EventPropertyMissing (impossible state)', async () => {
    const row = baseRow('member_removed', 'discord');

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toContain('discord');
  });

  it('channel_detached + discord → fails with EventPropertyMissing (impossible state)', async () => {
    const row = baseRow('channel_detached', 'discord');

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toContain('discord');
  });
});

// ---------------------------------------------------------------------------
// channel_updated + managed → ManagedChannelAdoptedEvent (adopted channel)
// ---------------------------------------------------------------------------

describe('constructEvent — managed channel_updated (adopted)', () => {
  it('produces ManagedChannelAdoptedEvent with team_channel_id and discord_channel_id', async () => {
    const row = baseRow('channel_updated', 'managed', {
      team_channel_id: Option.some(TEAM_CHANNEL_ID),
      existing_channel_id: Option.some(DISCORD_CHANNEL_ID),
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('managed_channel_adopted');
    if (event._tag !== 'managed_channel_adopted') return;
    expect(event.team_channel_id).toBe(TEAM_CHANNEL_ID);
    expect(event.discord_channel_id).toBe(DISCORD_CHANNEL_ID);
    expect(event.guild_id).toBe(GUILD_ID);
  });

  it('fails with EventPropertyMissing when team_channel_id is absent', async () => {
    const row = baseRow('channel_updated', 'managed', {
      existing_channel_id: Option.some(DISCORD_CHANNEL_ID),
      // team_channel_id is Option.none()
    });

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toBe('team_channel_id');
  });

  it('fails with EventPropertyMissing when existing_channel_id (discord_channel_id) is absent', async () => {
    const row = baseRow('channel_updated', 'managed', {
      team_channel_id: Option.some(TEAM_CHANNEL_ID),
      // existing_channel_id is Option.none()
    });

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toBe('existing_channel_id');
  });
});

// ---------------------------------------------------------------------------
// Impossible-state guards: channel_detached + managed
// ---------------------------------------------------------------------------

describe('constructEvent — impossible-state guards for managed entity_type', () => {
  it('channel_detached + managed → fails with EventPropertyMissing (impossible state)', async () => {
    const row = baseRow('channel_detached', 'managed');

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toContain('managed');
  });
});

// ---------------------------------------------------------------------------
// channel_restored + managed → ManagedChannelRestoredEvent
// ---------------------------------------------------------------------------

describe('constructEvent — managed channel_restored', () => {
  it('produces ManagedChannelRestoredEvent with team_channel_id and existing_channel_id', async () => {
    const row = baseRow('channel_restored', 'managed', {
      team_channel_id: Option.some(TEAM_CHANNEL_ID),
      existing_channel_id: Option.some(DISCORD_CHANNEL_ID),
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('managed_channel_restored');
    if (event._tag !== 'managed_channel_restored') return;
    expect(event.team_channel_id).toBe(TEAM_CHANNEL_ID);
    expect(Option.isSome(event.discord_channel_id)).toBe(true);
    if (Option.isSome(event.discord_channel_id)) {
      expect(event.discord_channel_id.value).toBe(DISCORD_CHANNEL_ID);
    }
    expect(event.guild_id).toBe(GUILD_ID);
  });

  it('fails with EventPropertyMissing when team_channel_id is absent', async () => {
    const row = baseRow('channel_restored', 'managed', {
      existing_channel_id: Option.some(DISCORD_CHANNEL_ID),
      // team_channel_id is Option.none()
    });

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toBe('team_channel_id');
  });
});

// ---------------------------------------------------------------------------
// channel_restored + discord → DiscordChannelRestoredEvent
// ---------------------------------------------------------------------------

describe('constructEvent — discord channel_restored', () => {
  it('produces DiscordChannelRestoredEvent with existing_channel_id', async () => {
    const row = baseRow('channel_restored', 'discord', {
      existing_channel_id: Option.some(DISCORD_CHANNEL_ID),
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('discord_channel_restored');
    if (event._tag !== 'discord_channel_restored') return;
    expect(Option.isSome(event.discord_channel_id)).toBe(true);
    if (Option.isSome(event.discord_channel_id)) {
      expect(event.discord_channel_id.value).toBe(DISCORD_CHANNEL_ID);
    }
    expect(event.guild_id).toBe(GUILD_ID);
  });

  it('produces DiscordChannelRestoredEvent with discord_channel_id None when existing_channel_id absent', async () => {
    const row = baseRow('channel_restored', 'discord');
    // existing_channel_id is Option.none() → discord_channel_id is None

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('discord_channel_restored');
    if (event._tag !== 'discord_channel_restored') return;
    expect(Option.isNone(event.discord_channel_id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// channel_restored + group / roster → EventPropertyMissing (impossible guard)
// ---------------------------------------------------------------------------

describe('constructEvent — channel_restored impossible-state guards', () => {
  it('channel_restored + group → fails with EventPropertyMissing', async () => {
    const row = baseRow('channel_restored', 'group');

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toContain('group');
  });

  it('channel_restored + roster → fails with EventPropertyMissing', async () => {
    const row = baseRow('channel_restored', 'roster');

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toContain('roster');
  });
});

// ---------------------------------------------------------------------------
// Regression: channel_updated + discord still hits the impossible-state guard
// ---------------------------------------------------------------------------

describe('constructEvent — channel_updated + discord still fails (impossible state)', () => {
  it('channel_updated + discord → fails with EventPropertyMissing (impossible state)', async () => {
    const row = baseRow('channel_updated', 'discord');

    const error = await runFail(constructEvent(row));

    expect(error).toBeInstanceOf(EventPropertyMissing);
    expect((error as EventPropertyMissing).property).toContain('discord');
  });
});

// ---------------------------------------------------------------------------
// Regression: group/roster rows still construct correctly
// ---------------------------------------------------------------------------

describe('constructEvent — regression: group and roster rows still work', () => {
  it('channel_created + group → GroupChannelCreatedEvent', async () => {
    const row = baseRow('channel_created', 'group', {
      group_id: Option.some(GROUP_ID),
      group_name: Option.some('Goalkeepers'),
      discord_channel_name: Option.some('goalkeepers'),
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('group_channel_created');
  });

  it('channel_created + roster → RosterChannelCreatedEvent', async () => {
    const row = baseRow('channel_created', 'roster', {
      roster_id: Option.some(ROSTER_ID),
      roster_name: Option.some('Roster A'),
      discord_channel_name: Option.some('roster-a'),
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('roster_channel_created');
  });

  it('member_added + group → GroupMemberAddedEvent', async () => {
    const row = baseRow('member_added', 'group', {
      group_id: Option.some(GROUP_ID),
      group_name: Option.some('Goalkeepers'),
      team_member_id: Option.some(MEMBER_ID),
      discord_user_id: Option.some(DISCORD_USER_ID),
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('group_member_added');
  });

  it('member_removed + group → GroupMemberRemovedEvent', async () => {
    const row = baseRow('member_removed', 'group', {
      group_id: Option.some(GROUP_ID),
      team_member_id: Option.some(MEMBER_ID),
      discord_user_id: Option.some(DISCORD_USER_ID),
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('group_member_removed');
  });

  it('channel_archived + group → GroupChannelArchivedEvent', async () => {
    const row = baseRow('channel_archived', 'group', {
      group_id: Option.some(GROUP_ID),
      archive_category_id: Option.some(ARCHIVE_CATEGORY_ID),
    });

    const event = await run(constructEvent(row));

    expect(event._tag).toBe('group_channel_archived');
  });
});
