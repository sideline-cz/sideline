import { Effect, Layer, Option } from 'effect';
import { EmailAttachmentsRepository } from '~/repositories/EmailAttachmentsRepository.js';
import { EmailForwardingConfigRepository } from '~/repositories/EmailForwardingConfigRepository.js';
import { EmailMessagesRepository } from '~/repositories/EmailMessagesRepository.js';
import { EmailApprovalService } from '~/services/EmailApprovalService.js';
import { EmailSecretCrypto } from '~/services/EmailSecretCrypto.js';

const die = (msg: string) => () => Effect.die(new Error(msg));

export const MockEmailForwardingConfigRepositoryLayer = Layer.succeed(
  EmailForwardingConfigRepository,
  {
    _tag: 'api/EmailForwardingConfigRepository' as const,
    findByTeam: () => Effect.succeed(Option.none()),
    upsert: die('MockEmailForwardingConfigRepository.upsert not implemented'),
    findByInboundToken: () => Effect.succeed(Option.none()),
    regenerateToken: die('MockEmailForwardingConfigRepository.regenerateToken not implemented'),
    findImapEnabled: () => Effect.succeed([]),
    updateImapSync: () => Effect.void,
  } as never,
);

export const MockEmailMessagesRepositoryLayer = Layer.succeed(EmailMessagesRepository, {
  _tag: 'api/EmailMessagesRepository' as const,
  insertReceived: die('MockEmailMessagesRepository.insertReceived not implemented'),
  insertReceivedDedup: die('MockEmailMessagesRepository.insertReceivedDedup not implemented'),
  findById: () => Effect.succeed(Option.none()),
  findReceivedBatch: () => Effect.succeed([]),
  claimForSummarizing: () => Effect.succeed(Option.none()),
  setSummaryPendingApproval: die(
    'MockEmailMessagesRepository.setSummaryPendingApproval not implemented',
  ),
  updateSummary: () => Effect.succeed(Option.none()),
  incrementAttemptsAndMaybeFail: die(
    'MockEmailMessagesRepository.incrementAttemptsAndMaybeFail not implemented',
  ),
  approve: () => Effect.succeed(Option.none()),
  sendOriginal: () => Effect.succeed(Option.none()),
  dismiss: () => Effect.succeed(Option.none()),
  setPosted: die('MockEmailMessagesRepository.setPosted not implemented'),
} as never);

export const MockEmailAttachmentsRepositoryLayer = Layer.succeed(EmailAttachmentsRepository, {
  _tag: 'api/EmailAttachmentsRepository' as const,
  insertMany: () => Effect.void,
  listMetaByEmail: () => Effect.succeed([]),
  findByIdWithBytes: () => Effect.succeed(Option.none()),
} as never);

export const MockEmailApprovalServiceLayer = Layer.succeed(EmailApprovalService, {
  _tag: 'api/EmailApprovalService' as const,
  approve: die('MockEmailApprovalService.approve not implemented'),
  sendOriginal: die('MockEmailApprovalService.sendOriginal not implemented'),
  dismiss: die('MockEmailApprovalService.dismiss not implemented'),
} as never);

export const MockEmailLayers = Layer.mergeAll(
  MockEmailForwardingConfigRepositoryLayer,
  MockEmailMessagesRepositoryLayer,
  MockEmailAttachmentsRepositoryLayer,
  MockEmailApprovalServiceLayer,
  EmailSecretCrypto.Default,
);
