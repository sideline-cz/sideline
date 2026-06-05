import type { ChannelApi, GroupApi } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { Option } from 'effect';
import { MoreHorizontal } from 'lucide-react';
import React from 'react';
import { ChannelTypeIcon } from '~/components/atoms/ChannelTypeIcon.js';
import { DiscordChannelLink } from '~/components/atoms/DiscordChannelLink.js';
import { AdoptChannelDialog } from '~/components/organisms/AdoptChannelDialog.js';
import { ArchiveChannelDialog } from '~/components/organisms/ArchiveChannelDialog.js';
import { BulkArchiveDialog } from '~/components/organisms/BulkArchiveDialog.js';
import { ChannelAccessSheet } from '~/components/organisms/ChannelAccessSheet.js';
import { CreateChannelDialog } from '~/components/organisms/CreateChannelDialog.js';
import { RenameChannelDialog } from '~/components/organisms/RenameChannelDialog.js';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Checkbox } from '~/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Skeleton } from '~/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '~/components/ui/tooltip';
import {
  DISCORD_CHANNEL_TYPE_CATEGORY,
  DISCORD_CHANNEL_TYPE_TEXT,
  DISCORD_CHANNEL_TYPE_VOICE,
} from '~/lib/discord.js';
import { tr } from '~/lib/translations.js';

interface ChannelManagementPageProps {
  teamId: string;
  guildId: Option.Option<string>;
  data: ChannelApi.ChannelListResponse | null;
  allGroups: ReadonlyArray<GroupApi.GroupInfo>;
}

type DialogState =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'rename'; channel: ChannelApi.ChannelInfo }
  | { kind: 'archive'; channel: ChannelApi.ChannelInfo }
  | { kind: 'access'; teamChannelId: string; channelName: string }
  | { kind: 'adopt'; channel: ChannelApi.ChannelInfo }
  | { kind: 'bulkArchive' };

function channelRowKey(channel: ChannelApi.ChannelInfo): string {
  if (Option.isSome(channel.discordChannelId)) {
    return `discord-${channel.discordChannelId.value}`;
  }
  if (Option.isSome(channel.teamChannelId)) {
    return `team-${channel.teamChannelId.value}`;
  }
  return `name-${channel.name}`;
}

function isSelectable(channel: ChannelApi.ChannelInfo, canManage: boolean): boolean {
  return (
    canManage &&
    !channel.archived &&
    (channel.type === DISCORD_CHANNEL_TYPE_TEXT || channel.type === DISCORD_CHANNEL_TYPE_VOICE)
  );
}

function ChannelRowSkeleton() {
  return (
    <div className='flex items-center gap-3 py-3 border-b'>
      <Skeleton className='h-4 w-4' />
      <Skeleton className='h-4 w-32' />
      <Skeleton className='h-5 w-16' />
      <Skeleton className='h-4 w-24' />
      <div className='ml-auto'>
        <Skeleton className='h-8 w-8' />
      </div>
    </div>
  );
}

function ChannelRow({
  channel,
  guildId,
  canManage,
  archiveCategoryId,
  onAction,
  selectionMode,
  selected,
  onToggleSelect,
}: {
  channel: ChannelApi.ChannelInfo;
  guildId: Option.Option<string>;
  canManage: boolean;
  archiveCategoryId: Option.Option<string>;
  onAction: (
    kind: 'rename' | 'archive' | 'access' | 'adopt',
    channel: ChannelApi.ChannelInfo,
  ) => void;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: (key: string) => void;
}) {
  const isSyncing = channel.managed && Option.isNone(channel.discordChannelId) && !channel.archived;
  const isManaged = channel.managed;
  const isText = channel.type === DISCORD_CHANNEL_TYPE_TEXT;
  const isVoice = channel.type === DISCORD_CHANNEL_TYPE_VOICE;
  const hasArchiveCategory = Option.isSome(archiveCategoryId);
  const selectable = isSelectable(channel, canManage);
  const rowKey = channelRowKey(channel);

  // Determine which actions are shown
  const showAccess = canManage && isText && !channel.archived;
  const showRename = canManage && isManaged && isText && !channel.archived;
  const showArchive = canManage && !channel.archived && (isText || isVoice);
  const hasAnyAction = showAccess || showRename || showArchive;

  return (
    <div className='flex items-center gap-3 py-3 border-b last:border-0'>
      {selectionMode && (
        <span className='shrink-0 flex items-center'>
          <Checkbox
            checked={selectable ? selected : false}
            disabled={!selectable}
            onCheckedChange={() => {
              if (selectable) onToggleSelect(rowKey);
            }}
            aria-label={tr('channels_selectRow', { name: channel.name })}
            className={!selectable ? 'opacity-30' : undefined}
          />
        </span>
      )}
      <span className='text-muted-foreground shrink-0 flex items-center'>
        <ChannelTypeIcon type={channel.type} className='size-4' />
      </span>
      <div className='flex-1 min-w-0 flex flex-wrap items-center gap-2'>
        <span className='font-medium truncate'>{channel.name}</span>
        {channel.archived && (
          <Badge variant='secondary' className='text-xs'>
            {tr('channels_archived_badge')}
          </Badge>
        )}
        {Option.isSome(channel.discordChannelId) && Option.isSome(guildId) && !channel.archived && (
          <DiscordChannelLink
            guildId={guildId.value}
            channelId={channel.discordChannelId.value}
            channelName={channel.name}
          />
        )}
      </div>
      <div className='flex items-center gap-2 shrink-0'>
        {isSyncing && (
          <Badge variant='outline' className='hidden sm:flex'>
            {tr('channels_status_syncing')}
          </Badge>
        )}
        {!isSyncing && !channel.archived && isManaged && (
          <span className='text-xs text-muted-foreground hidden md:block'>
            {tr('channels_groupAccessCount', { count: String(channel.accessCount) })}
          </span>
        )}
      </div>
      {!selectionMode && canManage && hasAnyAction && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant='ghost' size='icon' className='size-8 shrink-0'>
              <MoreHorizontal className='size-4' />
              <span className='sr-only'>Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            {showAccess && (
              <DropdownMenuItem onClick={() => onAction(isManaged ? 'access' : 'adopt', channel)}>
                {tr('channels_access_action')}
              </DropdownMenuItem>
            )}
            {showRename && (
              <DropdownMenuItem onClick={() => onAction('rename', channel)}>
                {tr('channels_rename')}
              </DropdownMenuItem>
            )}
            {showArchive &&
              (hasArchiveCategory ? (
                <DropdownMenuItem
                  className='text-destructive focus:text-destructive'
                  onClick={() => onAction('archive', channel)}
                >
                  {tr('channels_archive')}
                </DropdownMenuItem>
              ) : (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <DropdownMenuItem className='text-muted-foreground' disabled>
                          {tr('channels_archive')}
                        </DropdownMenuItem>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{tr('channels_archiveNoCategory_tooltip')}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function ChannelManagementPage({
  teamId,
  guildId,
  data,
  allGroups,
}: ChannelManagementPageProps) {
  const router = useRouter();
  const [dialog, setDialog] = React.useState<DialogState>({ kind: 'none' });

  // Selection state
  const [selectionMode, setSelectionMode] = React.useState(false);
  const [selectedKeys, setSelectedKeys] = React.useState<Set<string>>(new Set());

  const channels = data?.channels ?? [];
  const canManage = data?.canManage ?? false;
  const guildLinked = data?.guildLinked ?? false;
  const archiveCategoryId = data?.archiveCategoryId ?? Option.none();

  // Collect existing managed categories (for CreateChannelDialog)
  const existingCategories = React.useMemo(() => {
    const cats = new Set<string>();
    for (const ch of channels) {
      if (ch.managed && Option.isSome(ch.category)) cats.add(ch.category.value);
    }
    return [...cats].sort();
  }, [channels]);

  // Clear selection when data refreshes
  React.useEffect(() => {
    setSelectedKeys(new Set());
  }, []);

  // Poll for syncing channels (managed channels still provisioning)
  React.useEffect(() => {
    const syncing = channels.filter(
      (ch) => ch.managed && Option.isNone(ch.discordChannelId) && !ch.archived,
    );
    if (syncing.length === 0) return;
    const id = setInterval(() => {
      router.invalidate();
    }, 3000);
    return () => clearInterval(id);
  }, [channels, router]);

  // Separate archived and active channels; skip category-type channels as rows
  const activeChannels = React.useMemo(
    () => channels.filter((ch) => !ch.archived && ch.type !== DISCORD_CHANNEL_TYPE_CATEGORY),
    [channels],
  );

  const archivedChannels = React.useMemo(() => channels.filter((ch) => ch.archived), [channels]);

  // Group active channels by category name
  const activeGrouped = React.useMemo(() => {
    const UNCATEGORIZED = '\x00__uncategorized__';
    const byCategory = new Map<string, ChannelApi.ChannelInfo[]>();
    for (const ch of [...activeChannels].sort((a, b) => a.name.localeCompare(b.name))) {
      const key = Option.isSome(ch.category) ? ch.category.value : UNCATEGORIZED;
      const list = byCategory.get(key) ?? [];
      list.push(ch);
      byCategory.set(key, list);
    }
    const entries = [...byCategory.entries()].sort(([a], [b]) => {
      if (a === UNCATEGORIZED) return 1;
      if (b === UNCATEGORIZED) return -1;
      return a.localeCompare(b);
    });
    return entries.map(([key, chans]) => ({
      label: key === UNCATEGORIZED ? tr('channels_uncategorized') : key,
      channels: chans,
    }));
  }, [activeChannels]);

  const [archivedExpanded, setArchivedExpanded] = React.useState(false);

  const handleAction = (
    kind: 'rename' | 'archive' | 'access' | 'adopt',
    channel: ChannelApi.ChannelInfo,
  ) => {
    if (kind === 'access' && Option.isSome(channel.teamChannelId)) {
      setDialog({
        kind: 'access',
        teamChannelId: channel.teamChannelId.value,
        channelName: channel.name,
      });
    } else if (kind === 'adopt') {
      setDialog({ kind: 'adopt', channel });
    } else if (kind === 'rename') {
      setDialog({ kind: 'rename', channel });
    } else if (kind === 'archive') {
      setDialog({ kind: 'archive', channel });
    }
  };

  const handleCreated = (_channel: ChannelApi.ChannelDetail) => {
    // Channel enters syncing state - the polling effect will pick it up
  };

  const handleToggleSelect = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const getGroupSelectableKeys = (groupChannels: ReadonlyArray<ChannelApi.ChannelInfo>) =>
    groupChannels.filter((ch) => isSelectable(ch, canManage)).map(channelRowKey);

  const getGroupCheckedState = (
    groupChannels: ReadonlyArray<ChannelApi.ChannelInfo>,
  ): boolean | 'indeterminate' => {
    const keys = getGroupSelectableKeys(groupChannels);
    if (keys.length === 0) return false;
    const selectedCount = keys.filter((k) => selectedKeys.has(k)).length;
    if (selectedCount === 0) return false;
    if (selectedCount === keys.length) return true;
    return 'indeterminate';
  };

  const handleGroupToggle = (groupChannels: ReadonlyArray<ChannelApi.ChannelInfo>) => {
    const keys = getGroupSelectableKeys(groupChannels);
    const allSelected = keys.every((k) => selectedKeys.has(k));
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const k of keys) next.delete(k);
      } else {
        for (const k of keys) next.add(k);
      }
      return next;
    });
  };

  const selectedChannels = activeChannels.filter((ch) => selectedKeys.has(channelRowKey(ch)));
  const selectedCount = selectedChannels.length;

  const handleExitSelection = () => {
    setSelectionMode(false);
    setSelectedKeys(new Set());
  };

  return (
    <div className={selectionMode ? 'pb-20' : ''}>
      <header className='mb-8'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {tr('team_backToTeams')}
          </Link>
        </Button>
        <div className='flex items-center justify-between gap-4'>
          <h1 className='text-2xl font-bold'>{tr('channels_title')}</h1>
          <div className='flex items-center gap-2'>
            {canManage && (
              <Button
                size='sm'
                variant={selectionMode ? 'secondary' : 'outline'}
                onClick={() => {
                  if (selectionMode) {
                    handleExitSelection();
                  } else {
                    setSelectionMode(true);
                  }
                }}
              >
                {selectionMode ? tr('channels_selectDone') : tr('channels_select')}
              </Button>
            )}
            {canManage && !selectionMode && (
              <Button size='sm' onClick={() => setDialog({ kind: 'create' })}>
                {tr('channels_create')}
              </Button>
            )}
          </div>
        </div>
      </header>

      {!guildLinked && (
        <Alert className='mb-6'>
          <AlertDescription>
            {tr('channels_notConnected')}{' '}
            <Link
              to='/teams/$teamId/settings'
              params={{ teamId }}
              className='underline font-medium'
            >
              {tr('team_settings')}
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {!data ? (
        <div className='flex flex-col gap-1'>
          {[1, 2, 3, 4].map((i) => (
            <ChannelRowSkeleton key={i} />
          ))}
        </div>
      ) : channels.filter((ch) => ch.type !== DISCORD_CHANNEL_TYPE_CATEGORY).length === 0 ? (
        <div className='py-12 text-center'>
          <p className='text-lg font-medium'>{tr('channels_empty')}</p>
          <p className='text-muted-foreground mt-1'>{tr('channels_emptyBody')}</p>
          {canManage && (
            <Button className='mt-4' onClick={() => setDialog({ kind: 'create' })}>
              {tr('channels_create')}
            </Button>
          )}
        </div>
      ) : (
        <div className='flex flex-col gap-6'>
          {/* Active grouped channels */}
          {activeGrouped.map((group) => (
            <div key={group.label}>
              <div className='flex items-center gap-2 mb-2'>
                {selectionMode && (
                  <Checkbox
                    checked={getGroupCheckedState(group.channels)}
                    onCheckedChange={() => handleGroupToggle(group.channels)}
                    aria-label={tr('channels_selectAll', { group: group.label })}
                  />
                )}
                <h2 className='text-sm font-semibold text-muted-foreground uppercase tracking-wider'>
                  {group.label}
                </h2>
              </div>
              <div>
                {group.channels.map((channel) => (
                  <ChannelRow
                    key={channelRowKey(channel)}
                    channel={channel}
                    guildId={guildId}
                    canManage={canManage}
                    archiveCategoryId={archiveCategoryId}
                    onAction={handleAction}
                    selectionMode={selectionMode}
                    selected={selectedKeys.has(channelRowKey(channel))}
                    onToggleSelect={handleToggleSelect}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* Archived channels (collapsed by default) */}
          {archivedChannels.length > 0 && (
            <div>
              <button
                type='button'
                className='flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2 cursor-pointer hover:text-foreground transition-colors'
                onClick={() => setArchivedExpanded((v) => !v)}
                aria-expanded={archivedExpanded}
              >
                <span>{tr('channels_archived_group')}</span>
                <span className='text-xs normal-case opacity-60'>({archivedChannels.length})</span>
                <span className='text-xs'>{archivedExpanded ? '▲' : '▼'}</span>
              </button>
              {archivedExpanded && (
                <div className='opacity-60'>
                  {[...archivedChannels]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((channel) => (
                      <ChannelRow
                        key={channelRowKey(channel)}
                        channel={channel}
                        guildId={guildId}
                        canManage={canManage}
                        archiveCategoryId={archiveCategoryId}
                        onAction={handleAction}
                        selectionMode={selectionMode}
                        selected={false}
                        onToggleSelect={handleToggleSelect}
                      />
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Sticky bulk action bar */}
      {selectionMode && selectedCount > 0 && (
        <div className='fixed bottom-0 left-0 right-0 z-50 flex items-center justify-between gap-4 border-t bg-background px-4 py-3 shadow-lg'>
          <span aria-live='polite' className='text-sm font-medium'>
            {tr('channels_selectedCount', { count: String(selectedCount) })}
          </span>
          <div className='flex items-center gap-2'>
            <Button size='sm' variant='outline' onClick={() => setSelectedKeys(new Set())}>
              {tr('channels_clearSelection')}
            </Button>
            <Button
              size='sm'
              variant='destructive'
              onClick={() => setDialog({ kind: 'bulkArchive' })}
            >
              {tr('channels_bulkArchive_action')}
            </Button>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <CreateChannelDialog
        open={dialog.kind === 'create'}
        onOpenChange={(open) => {
          if (!open) setDialog({ kind: 'none' });
        }}
        teamId={teamId}
        existingCategories={existingCategories}
        onCreated={handleCreated}
      />

      {dialog.kind === 'rename' && Option.isSome(dialog.channel.teamChannelId) && (
        <RenameChannelDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: 'none' });
          }}
          teamId={teamId}
          teamChannelId={dialog.channel.teamChannelId.value}
          channelName={dialog.channel.name}
        />
      )}

      {dialog.kind === 'archive' && (
        <ArchiveChannelDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: 'none' });
          }}
          teamId={teamId}
          channelName={dialog.channel.name}
          teamChannelId={dialog.channel.teamChannelId}
          discordChannelId={dialog.channel.discordChannelId}
          managed={dialog.channel.managed}
          archiveCategoryId={archiveCategoryId}
        />
      )}

      {dialog.kind === 'access' && (
        <ChannelAccessSheet
          open
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: 'none' });
          }}
          teamId={teamId}
          teamChannelId={dialog.teamChannelId}
          channelName={dialog.channelName}
          allGroups={allGroups}
          canManage={canManage}
        />
      )}

      {dialog.kind === 'adopt' && (
        <AdoptChannelDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: 'none' });
          }}
          teamId={teamId}
          channel={dialog.channel}
          onAdopted={(detail) => {
            if (Option.isSome(detail.teamChannelId)) {
              setDialog({
                kind: 'access',
                teamChannelId: detail.teamChannelId.value,
                channelName: detail.name,
              });
            } else {
              setDialog({ kind: 'none' });
            }
          }}
        />
      )}

      {dialog.kind === 'bulkArchive' && (
        <BulkArchiveDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: 'none' });
          }}
          teamId={teamId}
          channels={selectedChannels}
          archiveCategoryId={archiveCategoryId}
          onArchived={() => {
            handleExitSelection();
          }}
        />
      )}
    </div>
  );
}
