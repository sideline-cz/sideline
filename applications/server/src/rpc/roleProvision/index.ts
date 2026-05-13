import { RoleProvisionRpcGroup } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { Array, Effect } from 'effect';
import { DiscordRoleProvisionEventsRepository } from '~/repositories/DiscordRoleProvisionEventsRepository.js';

export const RoleProvisionRpcLive = Effect.Do.pipe(
  Effect.bind('repo', () => DiscordRoleProvisionEventsRepository.asEffect()),
  Effect.let(
    'RoleProvision/GetUnprocessedEvents',
    ({ repo }) =>
      ({ limit }: { readonly limit: number }) =>
        repo.findUnprocessedAll(limit).pipe(
          Effect.map(
            Array.map(
              (row) =>
                new RoleProvisionRpcGroup.UnprocessedRoleProvisionEvent({
                  id: row.id,
                  team_id: row.team_id,
                  guild_id: row.guild_id,
                  kind: row.kind,
                  ref_id: row.ref_id,
                  desired_name: row.desired_name,
                }),
            ),
          ),
        ),
  ),
  Effect.let(
    'RoleProvision/MarkProcessed',
    ({ repo }) =>
      ({ id }: { readonly id: RoleProvisionRpcGroup.RoleProvisionEventId }) =>
        repo.markProcessed(id),
  ),
  Effect.let(
    'RoleProvision/MarkFailed',
    ({ repo }) =>
      ({
        id,
        error,
      }: {
        readonly id: RoleProvisionRpcGroup.RoleProvisionEventId;
        readonly error: string;
      }) =>
        repo.markFailed(id, error),
  ),
  Bind.remove('repo'),
  (handlers) => RoleProvisionRpcGroup.RoleProvisionRpcGroup.toLayer(handlers),
);
