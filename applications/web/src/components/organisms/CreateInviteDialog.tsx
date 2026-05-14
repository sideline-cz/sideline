import type { GroupApi, Team } from '@sideline/domain';
import { GroupModel } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { Copy, ExternalLink } from 'lucide-react';
import React from 'react';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

type ExpiryPreset = 'never' | '7days' | '30days';

interface CreateInviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: Team.TeamId;
  groups: ReadonlyArray<GroupApi.GroupInfo>;
}

export function CreateInviteDialog({
  open,
  onOpenChange,
  teamId,
  groups,
}: CreateInviteDialogProps) {
  const run = useRun();
  const [groupMode, setGroupMode] = React.useState<'any' | 'specific'>('any');
  const [selectedGroupId, setSelectedGroupId] = React.useState<string>('');
  const [expiry, setExpiry] = React.useState<ExpiryPreset>('never');
  const [creating, setCreating] = React.useState(false);
  const [createdCode, setCreatedCode] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const inviteLink = createdCode ? `${window.location.origin}/invite/${createdCode}` : null;

  const handleCreate = React.useCallback(async () => {
    const groupId: Option.Option<GroupModel.GroupId> =
      groupMode === 'specific' && selectedGroupId
        ? Option.some(Schema.decodeSync(GroupModel.GroupId)(selectedGroupId))
        : Option.none();

    const addDays = (days: number): Date => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      return d;
    };
    const expiresAt: Option.Option<Date> =
      expiry === '7days'
        ? Option.some(addDays(7))
        : expiry === '30days'
          ? Option.some(addDays(30))
          : Option.none();

    setCreating(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.invite.createInvite({
          params: { teamId },
          payload: { groupId, expiresAt },
        }),
      ),
      Effect.tapError((error) => Effect.logError('createInvite failed', error)),
      Effect.mapError(() => ClientError.make(tr('invites_createFailed'))),
      run({ success: tr('invites_createSuccess') }),
    );
    setCreating(false);
    if (Option.isSome(result)) {
      setCreatedCode(result.value.code);
    }
  }, [teamId, groupMode, selectedGroupId, expiry, run]);

  const handleCopy = React.useCallback(() => {
    if (!inviteLink) return;
    navigator.clipboard.writeText(inviteLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [inviteLink]);

  const handleClose = React.useCallback(() => {
    setCreatedCode(null);
    setCopied(false);
    setGroupMode('any');
    setSelectedGroupId('');
    setExpiry('never');
    onOpenChange(false);
  }, [onOpenChange]);

  const hasGroups = groups.length > 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>{tr('invites_dialogTitle')}</DialogTitle>
          <DialogDescription>{tr('invites_dialogDescription')}</DialogDescription>
        </DialogHeader>

        {createdCode !== null ? (
          <div className='flex flex-col gap-4'>
            <p className='text-sm font-medium'>{tr('invites_createdLinkTitle')}</p>
            <p className='text-xs text-muted-foreground'>{tr('invites_createdLinkDescription')}</p>
            <div className='flex gap-2'>
              <Input readOnly value={inviteLink ?? ''} className='font-mono text-xs' />
              <Button type='button' variant='outline' size='icon' onClick={handleCopy}>
                <Copy className='size-4' />
                <span className='sr-only'>{tr('invites_copyLink')}</span>
              </Button>
            </div>
            {copied && <p className='text-xs text-muted-foreground'>{tr('invites_linkCopied')}</p>}
            <DialogFooter>
              <Button onClick={handleClose}>{tr('invites_done')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className='flex flex-col gap-5'>
            {/* Group selection */}
            <div className='flex flex-col gap-2'>
              <Label>{tr('invites_groupLabel')}</Label>
              {!hasGroups ? (
                <div className='text-sm text-muted-foreground'>
                  <p>{tr('invites_noGroupsCta')}</p>
                  <Link
                    to='/teams/$teamId/groups'
                    params={{ teamId }}
                    className='text-primary underline hover:no-underline inline-flex items-center gap-1 mt-1'
                  >
                    {tr('invites_noGroupsLink')}
                    <ExternalLink className='size-3' />
                  </Link>
                </div>
              ) : (
                <div className='flex flex-col gap-2'>
                  <div className='flex flex-col gap-1'>
                    <label className='flex items-center gap-2 text-sm cursor-pointer'>
                      <input
                        type='radio'
                        name='group-mode'
                        value='any'
                        checked={groupMode === 'any'}
                        onChange={() => setGroupMode('any')}
                        className='accent-primary'
                      />
                      {tr('invites_groupAny')}
                    </label>
                    <label className='flex items-center gap-2 text-sm cursor-pointer'>
                      <input
                        type='radio'
                        name='group-mode'
                        value='specific'
                        checked={groupMode === 'specific'}
                        onChange={() => setGroupMode('specific')}
                        className='accent-primary'
                      />
                      {tr('invites_groupSpecific')}
                    </label>
                  </div>
                  {groupMode === 'specific' && (
                    <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
                      <SelectTrigger>
                        <SelectValue placeholder={tr('invites_groupSelect')} />
                      </SelectTrigger>
                      <SelectContent>
                        {groups.map((g) => (
                          <SelectItem key={g.groupId} value={g.groupId}>
                            {Option.isSome(g.emoji) ? `${g.emoji.value} ${g.name}` : g.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}
            </div>

            {/* Expiry */}
            <div className='flex flex-col gap-2'>
              <Label htmlFor='invite-expiry'>{tr('invites_expiryLabel')}</Label>
              <Select value={expiry} onValueChange={(v) => setExpiry(v as ExpiryPreset)}>
                <SelectTrigger id='invite-expiry'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='never'>{tr('invites_expiryNever')}</SelectItem>
                  <SelectItem value='7days'>{tr('invites_expiry7days')}</SelectItem>
                  <SelectItem value='30days'>{tr('invites_expiry30days')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <DialogFooter>
              <Button
                onClick={handleCreate}
                disabled={creating || (groupMode === 'specific' && hasGroups && !selectedGroupId)}
              >
                {creating ? tr('invites_creating') : tr('invites_create')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
