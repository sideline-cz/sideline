import type { AchievementRpcEvents, Discord, Team, TeamMember } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { handleAchievementEarned } from '~/rcp/achievement/handleAchievementEarned.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '111111111111111111' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEAM_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const EVENT_ID = '00000000-0000-0000-0000-000000000001' as any;
const DISCORD_USER_ID = '222222222222222222' as Discord.Snowflake;
const WELCOME_CHANNEL_ID = '333333333333333333' as Discord.Snowflake;
const DISCORD_ROLE_ID = '444444444444444444' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// Event factory
// ---------------------------------------------------------------------------

const makeEvent = (
  overrides: Partial<AchievementRpcEvents.AchievementEarnedEvent> = {},
): AchievementRpcEvents.AchievementEarnedEvent =>
  new (require('@sideline/domain').AchievementRpcEvents.AchievementEarnedEvent)({
    id: EVENT_ID,
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    team_member_id: TEAM_MEMBER_ID,
    achievement_slug: 'first_activity',
    discord_user_id: DISCORD_USER_ID,
    welcome_channel_id: Option.some(WELCOME_CHANNEL_ID),
    discord_role_id: Option.none(),
    ...overrides,
  });

// ---------------------------------------------------------------------------
// DiscordREST mock helpers
// ---------------------------------------------------------------------------

type RestCallRecord = {
  addGuildMemberRole: unknown[][];
  createMessage: unknown[][];
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCallRecord; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCallRecord = {
    addGuildMemberRole: [],
    createMessage: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    addGuildMemberRole: (...args: any[]) => {
      calls.addGuildMemberRole.push(args);
      return Effect.void;
    },
    createMessage: (...args: any[]) => {
      calls.createMessage.push(args);
      return Effect.succeed({ id: 'msg-123' });
    },
  };

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (!fn) return () => Effect.void;
        return fn;
      },
    }),
  );

  return { calls, layer };
};

// ---------------------------------------------------------------------------
// Handler invocation helper
// ---------------------------------------------------------------------------

const runHandleAchievementEarned = (
  event: AchievementRpcEvents.AchievementEarnedEvent,
  restLayer: Layer.Layer<DiscordREST>,
) => Effect.runPromise(handleAchievementEarned(event).pipe(Effect.provide(restLayer)));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleAchievementEarned', () => {
  it('grants role when discord_role_id is Some — addGuildMemberRole called with that role id', async () => {
    const { calls, layer } = makeRest();

    await runHandleAchievementEarned(
      makeEvent({ discord_role_id: Option.some(DISCORD_ROLE_ID) }),
      layer,
    );

    expect(calls.addGuildMemberRole).toHaveLength(1);
    const args = calls.addGuildMemberRole[0] as any[];
    // addGuildMemberRole(guildId, userId, roleId) — roleId must match DISCORD_ROLE_ID
    expect(args).toContain(DISCORD_ROLE_ID);
  });

  it('skips role grant when discord_role_id is None — addGuildMemberRole NOT called', async () => {
    const { calls, layer } = makeRest();

    await runHandleAchievementEarned(makeEvent({ discord_role_id: Option.none() }), layer);

    expect(calls.addGuildMemberRole).toHaveLength(0);
  });

  it('posts embed to welcome_channel_id when Some — createMessage called on that channel', async () => {
    const { calls, layer } = makeRest();

    await runHandleAchievementEarned(
      makeEvent({ welcome_channel_id: Option.some(WELCOME_CHANNEL_ID) }),
      layer,
    );

    expect(calls.createMessage).toHaveLength(1);
    const [channelArg] = calls.createMessage[0] as [string, unknown];
    expect(channelArg).toBe(WELCOME_CHANNEL_ID);
  });

  it('skips embed when welcome_channel_id is None — createMessage NOT called', async () => {
    const { calls, layer } = makeRest();

    await runHandleAchievementEarned(makeEvent({ welcome_channel_id: Option.none() }), layer);

    expect(calls.createMessage).toHaveLength(0);
  });

  it('does NOT call createMessage on system_log_channel_id or overview_channel_id (regression guard — those fields do not exist on AchievementEarnedEvent)', async () => {
    const { calls, layer } = makeRest();

    const event = makeEvent({
      welcome_channel_id: Option.none(),
      discord_role_id: Option.none(),
    });

    // Ensure the event does NOT have system_log_channel_id or overview_channel_id properties
    expect((event as any).system_log_channel_id).toBeUndefined();
    expect((event as any).overview_channel_id).toBeUndefined();

    await runHandleAchievementEarned(event, layer);

    // No channel available → no message posted at all
    expect(calls.createMessage).toHaveLength(0);
  });
});
