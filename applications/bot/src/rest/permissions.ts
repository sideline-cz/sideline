import type { TeamChannelAccess } from '@sideline/domain';
import { Discord } from 'dfx';

type AccessLevel = TeamChannelAccess.AccessLevel;

export interface Permission {
  allow?: bigint;
  deny?: bigint;
}

export const HIDDEN: Permission = {
  deny: Discord.Permissions.ViewChannel,
};

export const READ_ONLY: Permission = {
  allow: Discord.Permissions.ViewChannel,
  deny: Discord.Permissions.SendMessages,
};

export const READ_WRITE: Permission = {
  allow: Discord.Permissions.ViewChannel | Discord.Permissions.SendMessages,
};

export const MANAGE: Permission = {
  allow: Discord.Permissions.ViewChannel,
  deny: Discord.Permissions.SendMessages,
};

/**
 * Personal event channel: member can read but cannot write, react, or create threads.
 * Used for the per-member private event feed.
 */
export const PERSONAL_VIEW: Permission = {
  allow: Discord.Permissions.ViewChannel | Discord.Permissions.ReadMessageHistory,
  deny:
    Discord.Permissions.SendMessages |
    Discord.Permissions.AddReactions |
    Discord.Permissions.CreatePublicThreads |
    Discord.Permissions.CreatePrivateThreads,
};

// --- Managed channel access tiers ---

export const CHANNEL_ACCESS_VIEW: Permission = {
  allow: Discord.Permissions.ViewChannel | Discord.Permissions.ReadMessageHistory,
  deny:
    Discord.Permissions.SendMessages |
    Discord.Permissions.AddReactions |
    Discord.Permissions.SendMessagesInThreads |
    Discord.Permissions.CreatePublicThreads |
    Discord.Permissions.CreatePrivateThreads,
};

export const CHANNEL_ACCESS_EDIT: Permission = {
  allow:
    Discord.Permissions.ViewChannel |
    Discord.Permissions.ReadMessageHistory |
    Discord.Permissions.SendMessages |
    Discord.Permissions.AddReactions |
    Discord.Permissions.AttachFiles |
    Discord.Permissions.EmbedLinks |
    Discord.Permissions.SendMessagesInThreads |
    Discord.Permissions.CreatePublicThreads |
    Discord.Permissions.CreatePrivateThreads,
};

export const CHANNEL_ACCESS_ADMIN: Permission = {
  allow:
    Discord.Permissions.ViewChannel |
    Discord.Permissions.ReadMessageHistory |
    Discord.Permissions.SendMessages |
    Discord.Permissions.AddReactions |
    Discord.Permissions.AttachFiles |
    Discord.Permissions.EmbedLinks |
    Discord.Permissions.SendMessagesInThreads |
    Discord.Permissions.CreatePublicThreads |
    Discord.Permissions.CreatePrivateThreads |
    Discord.Permissions.ManageMessages |
    Discord.Permissions.ManageThreads |
    Discord.Permissions.PinMessages,
};

export const accessLevelPermission = (level: AccessLevel): Permission =>
  level === 'VIEW'
    ? CHANNEL_ACCESS_VIEW
    : level === 'EDIT'
      ? CHANNEL_ACCESS_EDIT
      : CHANNEL_ACCESS_ADMIN;
