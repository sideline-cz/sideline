import {
  ChannelApi,
  type GroupApi,
  GroupModel,
  Team,
  TeamChannel,
  type TeamChannelAccess,
} from '@sideline/domain';
import { useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { Trash2 } from 'lucide-react';
import React from 'react';
import { SearchableSelect } from '~/components/atoms/SearchableSelect.js';
import { AccessLevelSelect } from '~/components/molecules/AccessLevelSelect.js';
import { Alert, AlertDescription } from '~/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '~/components/ui/alert-dialog';
import { Button } from '~/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet';
import { Skeleton } from '~/components/ui/skeleton';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface ChannelAccessSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string;
  channelName: string;
  teamChannelId: string;
  allGroups: ReadonlyArray<GroupApi.GroupInfo>;
  canManage: boolean;
}

export function ChannelAccessSheet({
  open,
  onOpenChange,
  teamId,
  channelName,
  teamChannelId,
  allGroups,
  canManage,
}: ChannelAccessSheetProps) {
  const run = useRun();
  const router = useRouter();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const channelIdBranded = Schema.decodeSync(TeamChannel.TeamChannelId)(teamChannelId);

  const [detail, setDetail] = React.useState<ChannelApi.ChannelDetail | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState(false);
  const [selectedGroupId, setSelectedGroupId] = React.useState('');
  const [selectedLevel, setSelectedLevel] = React.useState<TeamChannelAccess.AccessLevel>('VIEW');
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setLoading(true);
    setLoadError(false);
    setDetail(null);

    // Capture the channel id at fetch start to guard against stale results
    const fetchedForChannelId = teamChannelId;

    const effect = ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.channel.getChannel({ params: { teamId: teamIdBranded, channelId: channelIdBranded } }),
      ),
      Effect.mapError(() => ClientError.make(tr('channels_access_loadFailed'))),
      run({}),
    );

    effect.then((result) => {
      // Ignore the result if the active channel has changed since fetch started
      if (fetchedForChannelId !== teamChannelId) return;
      if (Option.isSome(result)) {
        setDetail(result.value);
      } else {
        setLoadError(true);
      }
      setLoading(false);
    });
  }, [open, teamIdBranded, channelIdBranded, run, teamChannelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const grantedGroupIds = new Set(detail?.grants.map((g) => g.groupId) ?? []);
  const availableGroups = allGroups.filter((g) => !grantedGroupIds.has(g.groupId));

  const getGroupName = (groupId: string) =>
    allGroups.find((g) => g.groupId === groupId)?.name ?? groupId;

  const handleGrantAccess = async () => {
    if (!selectedGroupId || !detail) return;
    const newGrant = new ChannelApi.ChannelAccessGrant({
      groupId: Schema.decodeSync(GroupModel.GroupId)(selectedGroupId),
      accessLevel: selectedLevel,
    });
    const newGrants = [...detail.grants, newGrant];
    const groupName = getGroupName(selectedGroupId);
    setSubmitting(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.channel.setAccess({
          params: { teamId: teamIdBranded, channelId: channelIdBranded },
          payload: { grants: newGrants },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('channels_access_updateFailed'))),
      run({ success: tr('channels_access_granted', { group: groupName }) }),
    );
    setSubmitting(false);
    if (Option.isSome(result)) {
      setDetail(result.value);
      setSelectedGroupId('');
      setSelectedLevel('VIEW');
      router.invalidate();
    }
  };

  const handleChangeLevel = async (groupId: string, newLevel: TeamChannelAccess.AccessLevel) => {
    if (!detail) return;
    const newGrants = detail.grants.map((g) =>
      g.groupId === groupId
        ? new ChannelApi.ChannelAccessGrant({ groupId: g.groupId, accessLevel: newLevel })
        : g,
    );
    setSubmitting(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.channel.setAccess({
          params: { teamId: teamIdBranded, channelId: channelIdBranded },
          payload: { grants: newGrants },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('channels_access_updateFailed'))),
      run({ success: tr('channels_access_updated') }),
    );
    setSubmitting(false);
    if (Option.isSome(result)) {
      setDetail(result.value);
      router.invalidate();
    }
  };

  const handleRemoveAccess = async (groupId: string) => {
    if (!detail) return;
    const newGrants = detail.grants.filter((g) => g.groupId !== groupId);
    setSubmitting(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.channel.setAccess({
          params: { teamId: teamIdBranded, channelId: channelIdBranded },
          payload: { grants: newGrants },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('channels_access_removeFailed'))),
      run({ success: tr('channels_access_removed') }),
    );
    setSubmitting(false);
    if (Option.isSome(result)) {
      setDetail(result.value);
      router.invalidate();
    }
  };

  const hasNoAccess = (detail?.grants.length ?? 0) === 0;

  const accessLevelLabel = (level: TeamChannelAccess.AccessLevel) => {
    const map: Record<TeamChannelAccess.AccessLevel, string> = {
      VIEW: tr('channels_accessLevel_view'),
      EDIT: tr('channels_accessLevel_edit'),
      ADMIN: tr('channels_accessLevel_admin'),
    };
    return map[level];
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side='right' className='w-full sm:max-w-md flex flex-col gap-0 overflow-y-auto'>
        <SheetHeader className='p-4 pb-2'>
          <SheetTitle>{tr('channels_access_title')}</SheetTitle>
          <SheetDescription>
            # {channelName} — {tr('channels_access_description')}
          </SheetDescription>
        </SheetHeader>

        <div className='flex flex-col gap-4 p-4'>
          {/* Visibility note */}
          {!loading && !loadError && hasNoAccess && (
            <Alert>
              <AlertDescription>{tr('channels_visibilityNote_hidden')}</AlertDescription>
            </Alert>
          )}

          {/* Add access */}
          {canManage && (
            <div className='flex flex-col gap-2'>
              <p className='text-sm font-medium'>{tr('channels_access_add')}</p>
              <div className='flex gap-2 flex-wrap'>
                <div className='flex-1 min-w-36'>
                  <SearchableSelect
                    options={availableGroups.map((g) => ({
                      value: g.groupId,
                      label: Option.isSome(g.emoji) ? `${g.emoji.value} ${g.name}` : g.name,
                    }))}
                    value={selectedGroupId}
                    onValueChange={setSelectedGroupId}
                    placeholder={
                      availableGroups.length === 0
                        ? tr('channels_access_addGroupEmpty')
                        : tr('channels_access_addGroupPlaceholder')
                    }
                    disabled={availableGroups.length === 0 || submitting}
                  />
                </div>
                <AccessLevelSelect
                  value={selectedLevel}
                  onValueChange={setSelectedLevel}
                  disabled={!selectedGroupId || submitting}
                  className='w-36'
                />
                <Button
                  size='sm'
                  onClick={handleGrantAccess}
                  disabled={!selectedGroupId || submitting}
                >
                  {tr('channels_access_add')}
                </Button>
              </div>
            </div>
          )}

          {/* Current grants */}
          <div className='flex flex-col gap-1'>
            {loading ? (
              <>
                <Skeleton className='h-10 w-full' />
                <Skeleton className='h-10 w-full' />
              </>
            ) : loadError ? (
              <p className='text-sm text-destructive'>{tr('channels_access_loadFailed')}</p>
            ) : detail && detail.grants.length === 0 ? (
              <p className='text-sm text-muted-foreground'>{tr('channels_access_empty')}</p>
            ) : (
              detail?.grants.map((grant) => {
                const groupName = getGroupName(grant.groupId);
                return (
                  <div
                    key={grant.groupId}
                    className='flex items-center gap-2 py-1.5 border-b last:border-0'
                  >
                    <span className='flex-1 text-sm font-medium truncate'>{groupName}</span>
                    {canManage ? (
                      <AccessLevelSelect
                        value={grant.accessLevel}
                        onValueChange={(newLevel) => handleChangeLevel(grant.groupId, newLevel)}
                        disabled={submitting}
                        className='w-32 shrink-0'
                      />
                    ) : (
                      <span className='text-sm text-muted-foreground shrink-0'>
                        {accessLevelLabel(grant.accessLevel)}
                      </span>
                    )}
                    {canManage && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant='ghost'
                            size='icon'
                            className='size-8 shrink-0 text-destructive'
                            disabled={submitting}
                            aria-label={tr('channels_access_remove')}
                          >
                            <Trash2 className='size-4' />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              {tr('channels_access_removeConfirm_title')}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              {tr('channels_access_removeConfirm_description', {
                                group: groupName,
                              })}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{tr('channels_cancel')}</AlertDialogCancel>
                            <AlertDialogAction
                              className='bg-destructive text-white hover:bg-destructive/90'
                              onClick={() => handleRemoveAccess(grant.groupId)}
                            >
                              {tr('channels_access_remove')}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
