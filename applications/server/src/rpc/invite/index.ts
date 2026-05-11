import { InviteRpcGroup, type Onboarding, type TeamInvite } from '@sideline/domain';
import { Effect } from 'effect';
import { TeamInvitesRepository } from '~/repositories/TeamInvitesRepository.js';

export const InvitesRpcLive = Effect.Do.pipe(
  Effect.bind('invites', () => TeamInvitesRepository.asEffect()),
  Effect.map(({ invites }) => ({
    'Invite/PendingDiscordCodes': ({ limit }: { readonly limit: number }) =>
      invites.findPendingDiscordCodes(limit),

    'Invite/SetDiscordCode': ({
      invite_id,
      discord_code,
    }: {
      readonly invite_id: TeamInvite.TeamInviteId;
      readonly discord_code: string;
    }) => invites.setDiscordCode({ inviteId: invite_id, discordCode: discord_code }),

    'Invite/MarkDiscordCodeFailed': ({
      invite_id,
      error_code,
      error_detail,
    }: {
      readonly invite_id: TeamInvite.TeamInviteId;
      readonly error_code: Onboarding.InviteGeneratorErrorCode;
      readonly error_detail: string;
    }) =>
      Effect.logWarning(`Invite ${invite_id} Discord code generation failed`, {
        error_code,
        error_detail,
      }),
  })),
  (handlers) => InviteRpcGroup.InviteRpcGroup.toLayer(handlers),
);
