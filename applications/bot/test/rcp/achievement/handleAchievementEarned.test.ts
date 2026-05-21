import type { AchievementRpcEvents, Discord, Team, TeamMember } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Logger, Option } from 'effect';
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
const ACHIEVEMENT_CHANNEL_ID = '333333333333333333' as Discord.Snowflake;
const DISCORD_ROLE_ID = '444444444444444444' as Discord.Snowflake;
const SOME_ROLE_ID = '555555555555555555' as Discord.Snowflake;

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
    achievement_channel_id: Option.some(ACHIEVEMENT_CHANNEL_ID),
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
// Fake 404 ErrorResponse
// ---------------------------------------------------------------------------

const make404ErrorResponse = () =>
  ({
    _tag: 'ErrorResponse',
    response: { status: 404 },
  }) as any;

// ---------------------------------------------------------------------------
// Log capture helper
// ---------------------------------------------------------------------------

const makeLogCapture = (): { messages: string[]; layer: Layer.Layer<never> } => {
  const messages: string[] = [];
  const layer = Logger.layer([
    Logger.make((options) => {
      messages.push(String(options.message));
    }),
  ]);
  return { messages, layer };
};

// ---------------------------------------------------------------------------
// Handler invocation helper
// ---------------------------------------------------------------------------

const runHandleAchievementEarned = (
  event: AchievementRpcEvents.AchievementEarnedEvent,
  restLayer: Layer.Layer<DiscordREST>,
  extraLayer?: Layer.Layer<never>,
) => {
  const base = handleAchievementEarned(event).pipe(Effect.provide(restLayer));
  return Effect.runPromise(extraLayer ? base.pipe(Effect.provide(extraLayer)) : base);
};

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

  it('posts embed to achievement_channel_id when Some — createMessage called on that channel', async () => {
    const { calls, layer } = makeRest();

    await runHandleAchievementEarned(
      makeEvent({ achievement_channel_id: Option.some(ACHIEVEMENT_CHANNEL_ID) }),
      layer,
    );

    expect(calls.createMessage).toHaveLength(1);
    const [channelArg] = calls.createMessage[0] as [string, unknown];
    expect(channelArg).toBe(ACHIEVEMENT_CHANNEL_ID);
  });

  it('skips embed when achievement_channel_id is None — createMessage NOT called (disabled state)', async () => {
    const { calls, layer } = makeRest();

    await runHandleAchievementEarned(makeEvent({ achievement_channel_id: Option.none() }), layer);

    expect(calls.createMessage).toHaveLength(0);
  });

  it('when achievement_channel_id is None and discord_role_id is Some, role is still granted (embed skipped)', async () => {
    const { calls, layer } = makeRest();

    await runHandleAchievementEarned(
      makeEvent({
        achievement_channel_id: Option.none(),
        discord_role_id: Option.some(SOME_ROLE_ID),
      }),
      layer,
    );

    expect(calls.addGuildMemberRole).toHaveLength(1);
    const args = calls.addGuildMemberRole[0] as any[];
    expect(args).toContain(SOME_ROLE_ID);
    expect(calls.createMessage).toHaveLength(0);
  });

  it('when addGuildMemberRole returns 404 and achievement_channel_id is None, "skipped embed" log is NOT emitted (roleGranted stays false)', async () => {
    const { messages, layer: logLayer } = makeLogCapture();
    const { layer: restLayer } = makeRest({
      addGuildMemberRole: (..._args: any[]) => Effect.fail(make404ErrorResponse()),
    });

    await runHandleAchievementEarned(
      makeEvent({
        achievement_channel_id: Option.none(),
        discord_role_id: Option.some(SOME_ROLE_ID),
      }),
      restLayer,
      logLayer,
    );

    const skippedEmbedLogs = messages.filter((m) =>
      m.includes('skipped embed (achievement channel not configured)'),
    );
    expect(skippedEmbedLogs).toHaveLength(0);
  }, 15_000);

  it('when addGuildMemberRole succeeds and achievement_channel_id is None, "skipped embed" log IS emitted', async () => {
    const { messages, layer: logLayer } = makeLogCapture();
    const { layer: restLayer } = makeRest();

    await runHandleAchievementEarned(
      makeEvent({
        achievement_channel_id: Option.none(),
        discord_role_id: Option.some(SOME_ROLE_ID),
      }),
      restLayer,
      logLayer,
    );

    const skippedEmbedLogs = messages.filter((m) =>
      m.includes('skipped embed (achievement channel not configured)'),
    );
    expect(skippedEmbedLogs).toHaveLength(1);
    expect(skippedEmbedLogs[0]).toContain(SOME_ROLE_ID);
  });

  it('does NOT call createMessage on system_log_channel_id, overview_channel_id, or welcome_channel_id (regression guard — those fields do not exist on AchievementEarnedEvent)', async () => {
    const { calls, layer } = makeRest();

    const event = makeEvent({
      achievement_channel_id: Option.none(),
      discord_role_id: Option.none(),
    });

    // Ensure the event does NOT have system_log_channel_id, overview_channel_id, or welcome_channel_id properties
    expect((event as any).system_log_channel_id).toBeUndefined();
    expect((event as any).overview_channel_id).toBeUndefined();
    expect((event as any).welcome_channel_id).toBeUndefined();

    await runHandleAchievementEarned(event, layer);

    // No channel available → no message posted at all
    expect(calls.createMessage).toHaveLength(0);
  });
});
