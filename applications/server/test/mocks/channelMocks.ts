import { LogicError } from '@sideline/effect-lib';
import { Effect, Layer, Option } from 'effect';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { TeamChannelAccessRepository } from '~/repositories/TeamChannelAccessRepository.js';
import { TeamChannelsRepository } from '~/repositories/TeamChannelsRepository.js';

/**
 * Noop mock for TeamChannelsRepository used in tests that don't exercise
 * the channel management endpoints.
 *
 * READ methods return empty/None. WRITE methods fail-fast with a descriptive
 * defect so tests that don't stub a write can't silently pass.
 */
export const MockTeamChannelsRepositoryLayer = Layer.succeed(TeamChannelsRepository, {
  _tag: 'api/TeamChannelsRepository' as const,
  findById: () => Effect.succeed(Option.none()),
  findAllByTeam: () => Effect.succeed([]),
  insert: () => LogicError.die('MockTeamChannelsRepository.insert called without a stub'),
  rename: () => LogicError.die('MockTeamChannelsRepository.rename called without a stub'),
  updateOrganization: () =>
    LogicError.die('MockTeamChannelsRepository.updateOrganization called without a stub'),
  setArchived: () => LogicError.die('MockTeamChannelsRepository.setArchived called without a stub'),
  delete: () => LogicError.die('MockTeamChannelsRepository.delete called without a stub'),
  upsertDiscordChannelId: () =>
    LogicError.die('MockTeamChannelsRepository.upsertDiscordChannelId called without a stub'),
  clearDiscordChannelId: () =>
    LogicError.die('MockTeamChannelsRepository.clearDiscordChannelId called without a stub'),
} as never);

/**
 * Noop mock for TeamChannelAccessRepository used in tests that don't exercise
 * the channel management endpoints.
 *
 * READ methods return empty. WRITE methods fail-fast.
 */
export const MockTeamChannelAccessRepositoryLayer = Layer.succeed(TeamChannelAccessRepository, {
  _tag: 'api/TeamChannelAccessRepository' as const,
  findByChannel: () => Effect.succeed([]),
  findByChannelForUpdate: () => Effect.succeed([]),
  upsertGrant: () =>
    LogicError.die('MockTeamChannelAccessRepository.upsertGrant called without a stub'),
  deleteGrant: () =>
    LogicError.die('MockTeamChannelAccessRepository.deleteGrant called without a stub'),
  countByChannel: () => Effect.succeed(0),
  findGroupRoleIds: () => Effect.succeed([]),
} as never);

/**
 * Noop mock for DiscordChannelsRepository used in tests that don't exercise
 * discord channel management endpoints.
 *
 * READ methods return empty/None. WRITE methods fail-fast.
 */
export const MockDiscordChannelsRepositoryLayer = Layer.succeed(DiscordChannelsRepository, {
  _tag: 'api/DiscordChannelsRepository' as const,
  findByGuildId: () => Effect.succeed([]),
  findManagedListByTeam: () => Effect.succeed([]),
  findByChannelId: () => Effect.succeed(Option.none()),
  syncChannels: () =>
    LogicError.die('MockDiscordChannelsRepository.syncChannels called without a stub'),
  updateChannelName: () =>
    LogicError.die('MockDiscordChannelsRepository.updateChannelName called without a stub'),
  deleteChannel: () =>
    LogicError.die('MockDiscordChannelsRepository.deleteChannel called without a stub'),
  upsertChannel: () =>
    LogicError.die('MockDiscordChannelsRepository.upsertChannel called without a stub'),
} as never);

export const MockChannelManagementLayers = Layer.mergeAll(
  MockTeamChannelsRepositoryLayer,
  MockTeamChannelAccessRepositoryLayer,
  MockDiscordChannelsRepositoryLayer,
);
