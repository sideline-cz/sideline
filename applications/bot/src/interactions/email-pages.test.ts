// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").

import { type EmailForwarding, EmailRpcModels, type Team } from '@sideline/domain';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction, MessageComponentData } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import {
  EmailDetailOpenButton,
  EmailDetailPageButton,
  EmailOriginalOpenButton,
  EmailOriginalPageButton,
} from '~/interactions/email-pages.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '600000000000000001' as DiscordTypes.Snowflake;
const CHANNEL_ID = '600000000000000010' as DiscordTypes.Snowflake;
const MESSAGE_ID = '600000000000000011' as DiscordTypes.Snowflake;
const USER_DISCORD_ID = '600000000000000030' as DiscordTypes.Snowflake;
const APP_ID = '600000000000000040' as DiscordTypes.Snowflake;
const INTERACTION_TOKEN = 'test-interaction-token';

const TEAM_ID = '00000000-0000-4000-8000-000000000010' as Team.TeamId;
const EMAIL_ID = '00000000-0000-4000-8000-000000000001' as EmailForwarding.EmailMessageId;

// ---------------------------------------------------------------------------
// Interaction fixture (same shape as email-approval.test.ts)
// ---------------------------------------------------------------------------

const makeComponentInteraction = (
  customId: string,
  userId: string = USER_DISCORD_ID,
): DiscordTypes.APIInteraction =>
  ({
    id: '1234567890' as DiscordTypes.Snowflake,
    application_id: APP_ID,
    token: INTERACTION_TOKEN,
    version: 1,
    type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    channel: {
      id: CHANNEL_ID,
      type: DiscordTypes.ChannelTypes.GUILD_TEXT,
    } as unknown as DiscordTypes.APIInteraction['channel'],
    member: {
      user: {
        id: userId as DiscordTypes.Snowflake,
        username: 'testuser',
        discriminator: '0001',
        global_name: null,
        avatar: null,
      },
      roles: [],
      joined_at: '2024-01-01T00:00:00Z',
      deaf: false,
      mute: false,
      permissions: '8',
    },
    locale: 'en-US',
    data: {
      component_type: 2,
      custom_id: customId,
    },
    message: {
      id: MESSAGE_ID,
      channel_id: CHANNEL_ID,
    },
  }) as unknown as DiscordTypes.APIInteraction;

// ---------------------------------------------------------------------------
// DiscordREST stub
// ---------------------------------------------------------------------------

interface RestStubOptions {
  updateOriginalWebhookMessage?: ReturnType<typeof vi.fn>;
  updateMessage?: ReturnType<typeof vi.fn>;
}

const makeRestStub = (options: RestStubOptions = {}) => {
  const updateOriginalWebhookMessage =
    options.updateOriginalWebhookMessage ?? vi.fn(() => Effect.succeed(undefined));
  const updateMessage = options.updateMessage ?? vi.fn(() => Effect.succeed(undefined));

  const rest = new Proxy({} as DiscordRestService, {
    get: (_target, prop: string) => {
      if (prop === 'updateOriginalWebhookMessage') return updateOriginalWebhookMessage;
      if (prop === 'updateMessage') return updateMessage;
      return () => Effect.succeed(undefined);
    },
  }) as unknown as DiscordRestService;

  const layer = Layer.succeed(DiscordREST, rest as unknown as InstanceType<typeof DiscordREST>);
  return { layer, updateOriginalWebhookMessage, updateMessage };
};

// ---------------------------------------------------------------------------
// SyncRpc stub (adds Email/GetEmailContent to the approval stubs)
// ---------------------------------------------------------------------------

interface SyncRpcOptions {
  'Email/GetEmailContent'?: ReturnType<typeof vi.fn>;
  'Email/RecordApproval'?: ReturnType<typeof vi.fn>;
  'Email/RecordReject'?: ReturnType<typeof vi.fn>;
  'Email/RecordSendOriginal'?: ReturnType<typeof vi.fn>;
}

const makeGetEmailContentResult = (
  summary: string | null = 'Detailed summary text for this email.',
  body: string = 'Original email body text. No code fences.',
): EmailRpcModels.EmailContentView =>
  new EmailRpcModels.EmailContentView({
    subject: 'Test Subject',
    from_address: 'sender@example.com',
    short_summary: Option.some('Short summary text.'),
    summary: summary !== null ? Option.some(summary) : Option.none(),
    body,
  });

const makeRpcStub = (options: SyncRpcOptions = {}) => {
  const defaults: Record<string, ReturnType<typeof vi.fn>> = {
    'Email/GetEmailContent': vi.fn(() => Effect.succeed(makeGetEmailContentResult())),
    'Email/RecordApproval': vi.fn(() => Effect.succeed({ outcome: 'approved' })),
    'Email/RecordReject': vi.fn(() => Effect.succeed({ outcome: 'dismissed' })),
    'Email/RecordSendOriginal': vi.fn(() => Effect.succeed({ outcome: 'sent_original' })),
  };

  const rpc = new Proxy({} as any, {
    get: (_target, prop: string) => {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
      return options[prop as keyof SyncRpcOptions] ?? defaults[prop];
    },
  });

  const layer = Layer.succeed(SyncRpc, rpc);
  return { layer, rpc, ...defaults, ...options };
};

// ---------------------------------------------------------------------------
// Run handler helper (mirrors email-approval.test.ts pattern)
// ---------------------------------------------------------------------------

const runHandler = async (
  component: { handle: Effect.Effect<unknown, unknown, unknown> },
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
  interaction: DiscordTypes.APIInteraction,
) => {
  const response = await Effect.runPromise(
    component.handle.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(
        Layer.succeed(
          MessageComponentData,
          (interaction as any).data as DiscordTypes.APIMessageComponentInteractionData,
        ),
      ),
      Effect.provide(restLayer),
      Effect.provide(rpcLayer),
    ) as Effect.Effect<unknown, never, never>,
  );
  // Flush microtask queue for forkDetach tasks
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
};

// ---------------------------------------------------------------------------
// Tests — EmailDetailOpenButton (email-detail: open handler)
// ---------------------------------------------------------------------------

describe('EmailDetailOpenButton — open handler', () => {
  it('returns DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE with Ephemeral flag', async () => {
    const rpcStub = makeRpcStub();
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-detail:${TEAM_ID}:${EMAIL_ID}`);

    const response = await runHandler(
      EmailDetailOpenButton,
      restStub.layer,
      rpcStub.layer,
      interaction,
    );

    expect((response as any).type).toBe(
      DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
    expect((response as any).data?.flags).toBe(DiscordTypes.MessageFlags.Ephemeral);
  });

  it('calls Email/GetEmailContent with correct team_id and email_id', async () => {
    const getContentFn = vi.fn(() => Effect.succeed(makeGetEmailContentResult()));
    const rpcStub = makeRpcStub({ 'Email/GetEmailContent': getContentFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-detail:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailDetailOpenButton, restStub.layer, rpcStub.layer, interaction);

    expect(getContentFn).toHaveBeenCalledWith(
      expect.objectContaining({
        team_id: TEAM_ID,
        email_id: EMAIL_ID,
      }),
    );
  });

  it('calls updateOriginalWebhookMessage for page 0 embed+components', async () => {
    const rpcStub = makeRpcStub();
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-detail:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailDetailOpenButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('kind=detailed — uses content.summary as text, falls back to content.body', async () => {
    const summary = 'Detailed summary text for the view.';
    const getContentFn = vi.fn(() =>
      Effect.succeed(makeGetEmailContentResult(summary, 'Original body')),
    );
    const rpcStub = makeRpcStub({ 'Email/GetEmailContent': getContentFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-detail:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailDetailOpenButton, restStub.layer, rpcStub.layer, interaction);

    // The updateOriginalWebhookMessage should have been called with content containing the summary
    const call = restStub.updateOriginalWebhookMessage.mock.calls[0];
    const payload = call?.[2] ?? call?.[1] ?? call?.[0];
    const payloadStr = JSON.stringify(payload);
    expect(payloadStr).toContain(summary);
  });

  it('kind=detailed with summary=None — falls back to content.body', async () => {
    const body = 'Fallback body content when summary is absent.';
    const getContentFn = vi.fn(() => Effect.succeed(makeGetEmailContentResult(null, body)));
    const rpcStub = makeRpcStub({ 'Email/GetEmailContent': getContentFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-detail:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailDetailOpenButton, restStub.layer, rpcStub.layer, interaction);

    const call = restStub.updateOriginalWebhookMessage.mock.calls[0];
    const payloadStr = JSON.stringify(call);
    expect(payloadStr).toContain(body);
  });

  it('custom_id parsing — extracts teamId and emailId from parts', async () => {
    const getContentFn = vi.fn(() => Effect.succeed(makeGetEmailContentResult()));
    const rpcStub = makeRpcStub({ 'Email/GetEmailContent': getContentFn });
    const restStub = makeRestStub();
    const customTeamId = '00000000-0000-4000-8000-000000000020' as Team.TeamId;
    const customEmailId = '00000000-0000-4000-8000-000000000002' as EmailForwarding.EmailMessageId;
    const interaction = makeComponentInteraction(`email-detail:${customTeamId}:${customEmailId}`);

    await runHandler(EmailDetailOpenButton, restStub.layer, rpcStub.layer, interaction);

    expect(getContentFn).toHaveBeenCalledWith(
      expect.objectContaining({
        team_id: customTeamId,
        email_id: customEmailId,
      }),
    );
  });

  it('GetEmailContent EmailRpcMessageNotFound — updates with error content, no throw', async () => {
    const getContentFn = vi.fn(() => Effect.fail(new EmailRpcModels.EmailRpcMessageNotFound()));
    const rpcStub = makeRpcStub({ 'Email/GetEmailContent': getContentFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-detail:${TEAM_ID}:${EMAIL_ID}`);

    // Should not throw
    await expect(
      runHandler(EmailDetailOpenButton, restStub.layer, rpcStub.layer, interaction),
    ).resolves.toBeDefined();

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('GetEmailContent RpcClientError — updates with error content, no throw', async () => {
    const getContentFn = vi.fn(() =>
      Effect.fail({
        _tag: 'RpcClientError',
        message: 'Connection refused',
      } as any),
    );
    const rpcStub = makeRpcStub({ 'Email/GetEmailContent': getContentFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-detail:${TEAM_ID}:${EMAIL_ID}`);

    await expect(
      runHandler(EmailDetailOpenButton, restStub.layer, rpcStub.layer, interaction),
    ).resolves.toBeDefined();

    // updateOriginalWebhookMessage should have been called with an error message
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('malformed custom_id (not enough parts) — updateOriginalWebhookMessage called with error content', async () => {
    const rpcStub = makeRpcStub();
    const restStub = makeRestStub();
    // Only one part after the prefix — teamId and emailId are both missing
    const interaction = makeComponentInteraction('email-detail:not-a-uuid');

    await expect(
      runHandler(EmailDetailOpenButton, restStub.layer, rpcStub.layer, interaction),
    ).resolves.toBeDefined();

    // The malformed-id branch forkDetaches an updateOriginalWebhookMessage call
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — EmailOriginalOpenButton (email-original: open handler)
// ---------------------------------------------------------------------------

describe('EmailOriginalOpenButton — open handler', () => {
  it('returns DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE with Ephemeral flag', async () => {
    const rpcStub = makeRpcStub();
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-original:${TEAM_ID}:${EMAIL_ID}`);

    const response = await runHandler(
      EmailOriginalOpenButton,
      restStub.layer,
      rpcStub.layer,
      interaction,
    );

    expect((response as any).type).toBe(
      DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
    expect((response as any).data?.flags).toBe(DiscordTypes.MessageFlags.Ephemeral);
  });

  it('kind=original — uses content.body (plain text, no code fences)', async () => {
    const body = 'Original plain text email body. No code fences here.';
    const getContentFn = vi.fn(() => Effect.succeed(makeGetEmailContentResult('summary', body)));
    const rpcStub = makeRpcStub({ 'Email/GetEmailContent': getContentFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-original:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailOriginalOpenButton, restStub.layer, rpcStub.layer, interaction);

    const call = restStub.updateOriginalWebhookMessage.mock.calls[0];
    const payloadStr = JSON.stringify(call);
    expect(payloadStr).toContain(body);
    // Should NOT contain code fence markers
    expect(payloadStr).not.toContain('```');
  });

  it('calls updateOriginalWebhookMessage for page 0', async () => {
    const rpcStub = makeRpcStub();
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-original:${TEAM_ID}:${EMAIL_ID}`);

    await runHandler(EmailOriginalOpenButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — EmailDetailPageButton (email-detail-page: page nav handler)
// ---------------------------------------------------------------------------

describe('EmailDetailPageButton — page navigation handler', () => {
  it('returns DEFERRED_UPDATE_MESSAGE', async () => {
    const rpcStub = makeRpcStub();
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-detail-page:${TEAM_ID}:${EMAIL_ID}:1`);

    const response = await runHandler(
      EmailDetailPageButton,
      restStub.layer,
      rpcStub.layer,
      interaction,
    );

    expect((response as any).type).toBe(
      DiscordTypes.InteractionCallbackTypes.DEFERRED_UPDATE_MESSAGE,
    );
  });

  it('page nav to page 1 — updateOriginalWebhookMessage called with page 1 content', async () => {
    // Create multi-page content by using a large summary
    const bigSummary = `📌 ${'A'.repeat(2000)}\n\n📌 ${'B'.repeat(2000)}\n\n📌 ${'C'.repeat(2000)}`;
    const getContentFn = vi.fn(() => Effect.succeed(makeGetEmailContentResult(bigSummary, 'body')));
    const rpcStub = makeRpcStub({ 'Email/GetEmailContent': getContentFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-detail-page:${TEAM_ID}:${EMAIL_ID}:1`);

    await runHandler(EmailDetailPageButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('page nav from page 1 to 0 — prev button triggers page 0', async () => {
    const rpcStub = makeRpcStub();
    const restStub = makeRestStub();
    // Simulates clicking the prev button on page 1 (target = page 0)
    const interaction = makeComponentInteraction(`email-detail-page:${TEAM_ID}:${EMAIL_ID}:0`);

    await runHandler(EmailDetailPageButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('stale out-of-range page index — clamped to [0, totalPages-1], no throw', async () => {
    // If content is single-page and we request page 99, it should clamp to 0
    const getContentFn = vi.fn(() =>
      Effect.succeed(makeGetEmailContentResult('Short content.', 'body')),
    );
    const rpcStub = makeRpcStub({ 'Email/GetEmailContent': getContentFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-detail-page:${TEAM_ID}:${EMAIL_ID}:99`);

    await expect(
      runHandler(EmailDetailPageButton, restStub.layer, rpcStub.layer, interaction),
    ).resolves.toBeDefined();

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('custom_id parsing — extracts kind=detailed, teamId, emailId, pageIndex', async () => {
    const getContentFn = vi.fn(() => Effect.succeed(makeGetEmailContentResult()));
    const rpcStub = makeRpcStub({ 'Email/GetEmailContent': getContentFn });
    const restStub = makeRestStub();
    const customTeamId = '00000000-0000-4000-8000-000000000020' as Team.TeamId;
    const customEmailId = '00000000-0000-4000-8000-000000000003' as EmailForwarding.EmailMessageId;
    const interaction = makeComponentInteraction(
      `email-detail-page:${customTeamId}:${customEmailId}:2`,
    );

    await runHandler(EmailDetailPageButton, restStub.layer, rpcStub.layer, interaction);

    expect(getContentFn).toHaveBeenCalledWith(
      expect.objectContaining({
        team_id: customTeamId,
        email_id: customEmailId,
      }),
    );
  });

  it('GetEmailContent EmailRpcMessageNotFound — error response, no throw', async () => {
    const getContentFn = vi.fn(() => Effect.fail(new EmailRpcModels.EmailRpcMessageNotFound()));
    const rpcStub = makeRpcStub({ 'Email/GetEmailContent': getContentFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-detail-page:${TEAM_ID}:${EMAIL_ID}:0`);

    await expect(
      runHandler(EmailDetailPageButton, restStub.layer, rpcStub.layer, interaction),
    ).resolves.toBeDefined();

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('GetEmailContent RpcClientError — error response, no throw', async () => {
    const getContentFn = vi.fn(() =>
      Effect.fail({ _tag: 'RpcClientError', message: 'Network error' } as any),
    );
    const rpcStub = makeRpcStub({ 'Email/GetEmailContent': getContentFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-detail-page:${TEAM_ID}:${EMAIL_ID}:0`);

    await expect(
      runHandler(EmailDetailPageButton, restStub.layer, rpcStub.layer, interaction),
    ).resolves.toBeDefined();

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — EmailOriginalPageButton (email-original-page: page nav handler)
// ---------------------------------------------------------------------------

describe('EmailOriginalPageButton — page navigation handler', () => {
  it('returns DEFERRED_UPDATE_MESSAGE', async () => {
    const rpcStub = makeRpcStub();
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-original-page:${TEAM_ID}:${EMAIL_ID}:0`);

    const response = await runHandler(
      EmailOriginalPageButton,
      restStub.layer,
      rpcStub.layer,
      interaction,
    );

    expect((response as any).type).toBe(
      DiscordTypes.InteractionCallbackTypes.DEFERRED_UPDATE_MESSAGE,
    );
  });

  it('kind=original — uses content.body (no code fences)', async () => {
    const body = 'Original body page content. Plain text only.';
    const getContentFn = vi.fn(() => Effect.succeed(makeGetEmailContentResult('summary', body)));
    const rpcStub = makeRpcStub({ 'Email/GetEmailContent': getContentFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-original-page:${TEAM_ID}:${EMAIL_ID}:0`);

    await runHandler(EmailOriginalPageButton, restStub.layer, rpcStub.layer, interaction);

    const call = restStub.updateOriginalWebhookMessage.mock.calls[0];
    const payloadStr = JSON.stringify(call);
    expect(payloadStr).toContain(body);
    expect(payloadStr).not.toContain('```');
  });

  it('GetEmailContent error — error response, no throw', async () => {
    const getContentFn = vi.fn(() => Effect.fail(new EmailRpcModels.EmailRpcMessageNotFound()));
    const rpcStub = makeRpcStub({ 'Email/GetEmailContent': getContentFn });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`email-original-page:${TEAM_ID}:${EMAIL_ID}:0`);

    await expect(
      runHandler(EmailOriginalPageButton, restStub.layer, rpcStub.layer, interaction),
    ).resolves.toBeDefined();

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });
});
