import { type InviteAcceptance, InviteRpcGroup, type Onboarding } from '@sideline/domain';
import { Effect } from 'effect';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';

export const InvitesRpcLive = Effect.Do.pipe(
  Effect.bind('acceptances', () => InviteAcceptancesRepository.asEffect()),
  Effect.map(({ acceptances }) => ({
    'Invite/PendingAcceptances': ({ limit }: { readonly limit: number }) =>
      acceptances.findPending(limit),

    'Invite/SetAcceptanceDiscordCode': ({
      acceptance_id,
      discord_code,
    }: {
      readonly acceptance_id: InviteAcceptance.InviteAcceptanceId;
      readonly discord_code: string;
    }) => acceptances.setDiscordCode({ acceptanceId: acceptance_id, discordCode: discord_code }),

    'Invite/MarkAcceptanceFailed': ({
      acceptance_id,
      error_code,
      error_detail,
    }: {
      readonly acceptance_id: InviteAcceptance.InviteAcceptanceId;
      readonly error_code: Onboarding.InviteGeneratorErrorCode;
      readonly error_detail: string;
    }) =>
      acceptances
        .markFailed({
          acceptanceId: acceptance_id,
          errorCode: error_code,
          errorDetail: error_detail,
        })
        .pipe(
          Effect.tap(() =>
            Effect.logWarning(`Invite acceptance ${acceptance_id} Discord code generation failed`, {
              error_code,
              error_detail,
            }),
          ),
        ),
  })),
  (handlers) => InviteRpcGroup.InviteRpcGroup.toLayer(handlers),
);
