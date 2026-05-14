import type { GroupApi, Invite, Team } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { Effect, Option } from 'effect';
import { Copy, PlusCircle } from 'lucide-react';
import React from 'react';
import { CreateInviteDialog } from '~/components/organisms/CreateInviteDialog';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { useFormatDate } from '~/hooks/useFormatDate';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface TeamInvitesPageProps {
  teamId: Team.TeamId;
  teamIdRaw: string;
  invites: ReadonlyArray<Invite.InviteListItem>;
  groups: ReadonlyArray<GroupApi.GroupInfo>;
  onRefresh: () => void;
}

export function TeamInvitesPage({
  teamId,
  teamIdRaw,
  invites,
  groups,
  onRefresh,
}: TeamInvitesPageProps) {
  const run = useRun();
  const { formatDate, formatDateTime } = useFormatDate();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [copied, setCopied] = React.useState<string | null>(null);

  const handleCopy = React.useCallback((code: string) => {
    const link = `${window.location.origin}/invite/${code}`;
    navigator.clipboard.writeText(link).then(() => {
      setCopied(code);
      setTimeout(() => setCopied(null), 2000);
    });
  }, []);

  const handleDisable = React.useCallback(
    async (inviteId: Invite.InviteListItem['id']) => {
      if (!window.confirm(tr('invites_disableConfirm'))) return;
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) => api.invite.deactivateInvite({ params: { teamId, inviteId } })),
        Effect.mapError(() => ClientError.make(tr('invites_disableFailed'))),
        run({ success: tr('invites_disabled_success') }),
      );
      if (Option.isSome(result)) {
        onRefresh();
      }
    },
    [teamId, run, onRefresh],
  );

  const handleDialogClose = React.useCallback(
    (open: boolean) => {
      setDialogOpen(open);
      if (!open) {
        onRefresh();
      }
    },
    [onRefresh],
  );

  return (
    <div>
      <header className='mb-6'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId: teamIdRaw }}>
            ← {tr('team_backToTeams')}
          </Link>
        </Button>
        <div className='flex items-center justify-between'>
          <h1 className='text-2xl font-bold'>{tr('invites_title')}</h1>
          <Button onClick={() => setDialogOpen(true)} size='sm'>
            <PlusCircle className='size-4 mr-2' />
            {tr('invites_newInvite')}
          </Button>
        </div>
      </header>

      {invites.length === 0 ? (
        <p className='text-muted-foreground'>{tr('invites_noInvites')}</p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full text-sm'>
            <thead>
              <tr className='border-b'>
                <th className='py-2 px-3 text-left font-medium text-muted-foreground'>
                  {tr('invites_code')}
                </th>
                <th className='hidden sm:table-cell py-2 px-3 text-left font-medium text-muted-foreground'>
                  {tr('invites_group')}
                </th>
                <th className='hidden md:table-cell py-2 px-3 text-left font-medium text-muted-foreground'>
                  {tr('invites_createdBy')}
                </th>
                <th className='hidden lg:table-cell py-2 px-3 text-left font-medium text-muted-foreground'>
                  {tr('invites_createdAt')}
                </th>
                <th className='hidden md:table-cell py-2 px-3 text-left font-medium text-muted-foreground'>
                  {tr('invites_expiresAt')}
                </th>
                <th className='py-2 px-3 text-left font-medium text-muted-foreground'>
                  {/* status */}
                </th>
                <th className='py-2 px-3' />
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => (
                <tr key={invite.id} className='border-b hover:bg-muted/30'>
                  <td className='py-2 px-3 font-mono'>{invite.code}</td>
                  <td className='hidden sm:table-cell py-2 px-3'>
                    {Option.isSome(invite.groupName) ? (
                      <Badge variant='secondary'>{invite.groupName.value}</Badge>
                    ) : (
                      <span className='text-muted-foreground text-xs'>
                        {tr('invites_allMembers')}
                      </span>
                    )}
                  </td>
                  <td className='hidden md:table-cell py-2 px-3 text-muted-foreground'>
                    {Option.isSome(invite.inviterName) ? invite.inviterName.value : '—'}
                  </td>
                  <td className='hidden lg:table-cell py-2 px-3 text-muted-foreground'>
                    {formatDate(invite.createdAt)}
                  </td>
                  <td className='hidden md:table-cell py-2 px-3 text-muted-foreground'>
                    {Option.isSome(invite.expiresAt)
                      ? formatDateTime(invite.expiresAt.value)
                      : tr('invites_never')}
                  </td>
                  <td className='py-2 px-3'>
                    <Badge variant={invite.active ? 'default' : 'outline'}>
                      {invite.active ? tr('invites_active') : tr('invites_disabled')}
                    </Badge>
                  </td>
                  <td className='py-2 px-3'>
                    <div className='flex gap-1 items-center justify-end'>
                      <Button
                        variant='ghost'
                        size='icon'
                        onClick={() => handleCopy(invite.code)}
                        title={tr('invites_copyLink')}
                      >
                        <Copy className='size-4' />
                        <span className='sr-only'>{tr('invites_copyLink')}</span>
                      </Button>
                      {copied === invite.code && (
                        <span className='text-xs text-muted-foreground'>
                          {tr('invites_linkCopied')}
                        </span>
                      )}
                      {invite.active && (
                        <Button variant='ghost' size='sm' onClick={() => handleDisable(invite.id)}>
                          {tr('invites_disable')}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateInviteDialog
        open={dialogOpen}
        onOpenChange={handleDialogClose}
        teamId={teamId}
        groups={groups}
      />
    </div>
  );
}
