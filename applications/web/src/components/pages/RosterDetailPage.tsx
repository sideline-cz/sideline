import type { EventRosterApi, GroupApi, Roster as RosterDomain } from '@sideline/domain';
import { Discord, RosterModel, Team, TeamMember } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { Loader2 } from 'lucide-react';
import React from 'react';

import { ColorPicker } from '~/components/atoms/ColorPicker.js';
import { DiscordChannelLink } from '~/components/atoms/DiscordChannelLink.js';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { RosterPendingRequestsSection } from '~/components/organisms/RosterPendingRequestsSection.js';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Separator } from '~/components/ui/separator';
import { DISCORD_CHANNEL_TYPE_TEXT } from '~/lib/discord';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface RosterDetailPageProps {
  teamId: string;
  rosterId: string;
  rosterDetail: RosterDomain.RosterDetail;
  allMembers: ReadonlyArray<RosterDomain.RosterPlayer>;
  canManage: boolean;
  userId: string;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
  guildId: Option.Option<string>;
  pendingRequests: ReadonlyArray<EventRosterApi.PendingRequestView>;
}

export function RosterDetailPage({
  teamId,
  rosterId,
  rosterDetail,
  allMembers,
  canManage,
  discordChannels,
  guildId,
  pendingRequests,
}: RosterDetailPageProps) {
  const run = useRun();
  const router = useRouter();
  const [selectedMemberId, setSelectedMemberId] = React.useState<string>('');
  const [selectedChannelId, setSelectedChannelId] = React.useState('');
  const [editName, setEditName] = React.useState(rosterDetail.name);
  const [editEmoji, setEditEmoji] = React.useState(Option.getOrElse(rosterDetail.emoji, () => ''));
  const [editColor, setEditColor] = React.useState<string | undefined>(
    Option.getOrUndefined(rosterDetail.color),
  );
  const [saving, setSaving] = React.useState(false);

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const rosterIdBranded = Schema.decodeSync(RosterModel.RosterId)(rosterId);

  React.useEffect(() => {
    if (!rosterDetail.discordChannelProvisioning) return;
    const id = setInterval(() => {
      router.invalidate();
    }, 5000);
    return () => clearInterval(id);
  }, [rosterDetail.discordChannelProvisioning, router]);

  const memberIdsInRoster = new Set(rosterDetail.members.map((m) => m.memberId));
  const availableMembers = allMembers.filter((m) => !memberIdsInRoster.has(m.memberId));

  const handleSaveNameEmojiColor = React.useCallback(async () => {
    setSaving(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.roster.updateRoster({
          params: { teamId: teamIdBranded, rosterId: rosterIdBranded },
          payload: {
            name: Option.some(editName),
            active: Option.none(),
            discordChannelId: Option.none(),
            emoji: editEmoji ? Option.some(editEmoji) : Option.none(),
            color: editColor ? Option.some(editColor) : Option.none(),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('roster_updateFailed'))),
      run({ success: tr('roster_rosterSaved') }),
    );
    setSaving(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [teamIdBranded, rosterIdBranded, editName, editEmoji, editColor, run, router]);

  const handleToggleActive = React.useCallback(async () => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.roster.updateRoster({
          params: { teamId: teamIdBranded, rosterId: rosterIdBranded },
          payload: {
            name: Option.none(),
            active: Option.some(!rosterDetail.active),
            discordChannelId: Option.none(),
            color: rosterDetail.color,
            emoji: rosterDetail.emoji,
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('roster_updateFailed'))),
      run({ success: tr('roster_rosterUpdated') }),
    );
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [
    teamIdBranded,
    rosterIdBranded,
    rosterDetail.active,
    rosterDetail.color,
    rosterDetail.emoji,
    run,
    router,
  ]);

  const handleLinkChannel = React.useCallback(async () => {
    if (!selectedChannelId) return;
    const snowflake = Schema.decodeSync(Discord.Snowflake)(selectedChannelId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.roster.updateRoster({
          params: { teamId: teamIdBranded, rosterId: rosterIdBranded },
          payload: {
            name: Option.none(),
            active: Option.none(),
            discordChannelId: Option.some(Option.some(snowflake)),
            color: rosterDetail.color,
            emoji: rosterDetail.emoji,
          },
        }),
      ),
      Effect.catchTag('ChannelAlreadyLinked', () =>
        Effect.fail(ClientError.make(tr('roster_channelAlreadyLinked'))),
      ),
      Effect.mapError(() => ClientError.make(tr('roster_updateFailed'))),
      run({ success: tr('roster_channelLinked') }),
    );
    if (Option.isSome(result)) {
      setSelectedChannelId('');
      router.invalidate();
    }
  }, [
    selectedChannelId,
    teamIdBranded,
    rosterIdBranded,
    rosterDetail.color,
    rosterDetail.emoji,
    run,
    router,
  ]);

  const handleUnlinkChannel = React.useCallback(async () => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.roster.updateRoster({
          params: { teamId: teamIdBranded, rosterId: rosterIdBranded },
          payload: {
            name: Option.none(),
            active: Option.none(),
            discordChannelId: Option.some(Option.none()),
            color: rosterDetail.color,
            emoji: rosterDetail.emoji,
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('roster_updateFailed'))),
      run({ success: tr('roster_channelUnlinked') }),
    );
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [teamIdBranded, rosterIdBranded, rosterDetail.color, rosterDetail.emoji, run, router]);

  const handleCreateChannel = React.useCallback(async () => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.roster.createChannel({
          params: { teamId: teamIdBranded, rosterId: rosterIdBranded },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('roster_channelCreateFailed'))),
      run({ success: tr('roster_channelCreateRequested') }),
    );
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [teamIdBranded, rosterIdBranded, run, router]);

  const handleAddMember = React.useCallback(async () => {
    if (!selectedMemberId) return;
    const memberId = Schema.decodeSync(TeamMember.TeamMemberId)(selectedMemberId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.roster.addRosterMember({
          params: { teamId: teamIdBranded, rosterId: rosterIdBranded },
          payload: { memberId },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('roster_updateFailed'))),
      run({ success: tr('roster_memberAdded') }),
    );
    if (Option.isSome(result)) {
      setSelectedMemberId('');
      router.invalidate();
    }
  }, [selectedMemberId, teamIdBranded, rosterIdBranded, run, router]);

  const handleRemoveMember = React.useCallback(
    async (memberIdRaw: string) => {
      const memberId = Schema.decodeSync(TeamMember.TeamMemberId)(memberIdRaw);
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.roster.removeRosterMember({
            params: { teamId: teamIdBranded, rosterId: rosterIdBranded, memberId },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('roster_updateFailed'))),
        run({ success: tr('roster_memberRemoved') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamIdBranded, rosterIdBranded, run, router],
  );

  const handleDelete = React.useCallback(async () => {
    if (!window.confirm(tr('roster_deleteRosterConfirm'))) return;
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.roster.deleteRoster({
          params: { teamId: teamIdBranded, rosterId: rosterIdBranded },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('roster_updateFailed'))),
      run({ success: tr('roster_rosterDeleted') }),
    );
    if (Option.isSome(result)) {
      router.navigate({ to: '/teams/$teamId/rosters', params: { teamId } });
    }
  }, [teamId, teamIdBranded, rosterIdBranded, run, router]);

  return (
    <div>
      <header className='mb-8'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId/rosters' params={{ teamId }}>
            ← {tr('roster_backToRosters')}
          </Link>
        </Button>
        <div className='flex flex-wrap items-center gap-3'>
          <h1 className='text-2xl font-bold'>{rosterDetail.name}</h1>
          <span
            className={
              rosterDetail.active
                ? 'text-green-700 font-medium'
                : 'text-muted-foreground font-medium'
            }
          >
            {rosterDetail.active ? tr('roster_active') : tr('roster_inactive')}
          </span>
          {canManage && (
            <>
              <Button variant='outline' size='sm' onClick={handleToggleActive}>
                {rosterDetail.active ? tr('roster_toggleInactive') : tr('roster_toggleActive')}
              </Button>
              <Button variant='destructive' size='sm' onClick={handleDelete}>
                {tr('roster_deleteRoster')}
              </Button>
            </>
          )}
        </div>
      </header>

      {canManage && (
        <Card className='mb-6 max-w-md'>
          <CardHeader>
            <CardTitle className='text-base'>{tr('roster_nameEmojiColor')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className='flex flex-col gap-2 sm:flex-row'>
              <div className='flex gap-2 flex-1'>
                <Input
                  id='roster-edit-emoji'
                  aria-label={tr('roster_emoji')}
                  value={editEmoji}
                  onChange={(e) => setEditEmoji(e.target.value)}
                  className='w-16 shrink-0'
                  placeholder='Emoji'
                />
                <ColorPicker id='roster-edit-color' value={editColor} onChange={setEditColor} />
                <Input
                  id='roster-edit-name'
                  aria-label={tr('roster_rosterName')}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className='flex-1'
                />
              </div>
              <Button onClick={handleSaveNameEmojiColor} disabled={saving}>
                {saving ? tr('roster_saving') : tr('roster_saveChanges')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card className='mb-6 max-w-md'>
          <CardHeader>
            <CardTitle className='text-base'>{tr('roster_discordChannel')}</CardTitle>
          </CardHeader>
          <CardContent>
            {rosterDetail.discordChannelProvisioning ? (
              <div className='flex flex-col items-center gap-2 py-4'>
                <Loader2 className='size-5 animate-spin text-muted-foreground' />
                <p className='text-sm font-medium'>{tr('discord_channelProvisioning')}</p>
                <p className='text-xs text-muted-foreground'>
                  {tr('discord_channelProvisioningHint')}
                </p>
              </div>
            ) : Option.isSome(rosterDetail.discordChannelId) ? (
              <div className='flex items-center justify-between'>
                {Option.isSome(guildId) ? (
                  <DiscordChannelLink
                    guildId={guildId.value}
                    channelId={Option.getOrElse(rosterDetail.discordChannelId, () => '')}
                    channelName={Option.getOrElse(rosterDetail.discordChannelName, () =>
                      Option.getOrElse(rosterDetail.discordChannelId, () => ''),
                    )}
                  />
                ) : (
                  <span className='text-sm font-medium'>
                    #{' '}
                    {Option.getOrElse(rosterDetail.discordChannelName, () =>
                      Option.getOrElse(rosterDetail.discordChannelId, () => ''),
                    )}
                  </span>
                )}
                <Button variant='outline' size='sm' onClick={handleUnlinkChannel}>
                  {tr('roster_unlinkChannel')}
                </Button>
              </div>
            ) : (
              <div className='flex flex-col gap-4'>
                <Button className='w-full' onClick={handleCreateChannel}>
                  {tr('roster_createChannel')}
                </Button>

                <div className='relative'>
                  <div className='absolute inset-0 flex items-center'>
                    <Separator className='w-full' />
                  </div>
                  <div className='relative flex justify-center text-xs uppercase'>
                    <span className='bg-card px-2 text-muted-foreground'>
                      {tr('roster_orLinkExisting')}
                    </span>
                  </div>
                </div>

                <div className='flex gap-2'>
                  <SearchableSelect
                    value={selectedChannelId}
                    onValueChange={setSelectedChannelId}
                    placeholder={tr('roster_selectChannel')}
                    options={discordChannels
                      .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
                      .map((ch) => ({ value: ch.id, label: `# ${ch.name}` }))}
                    className='flex-1'
                  />
                  <Button
                    variant='outline'
                    onClick={handleLinkChannel}
                    disabled={!selectedChannelId}
                  >
                    {tr('roster_linkChannel')}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {canManage && (
        <div className='flex gap-2 mb-6 max-w-md'>
          <SearchableSelect
            value={selectedMemberId}
            onValueChange={setSelectedMemberId}
            placeholder={tr('roster_addMember')}
            options={availableMembers.map((member) => ({
              value: member.memberId,
              label: member.displayName,
            }))}
            className='flex-1'
          />
          <Button onClick={handleAddMember} disabled={!selectedMemberId}>
            {tr('roster_addMember')}
          </Button>
        </div>
      )}

      {rosterDetail.members.length === 0 ? (
        <p className='text-muted-foreground'>{tr('members_noPlayers')}</p>
      ) : (
        <table className='w-full'>
          <tbody>
            {rosterDetail.members.map((player) => {
              const displayName = player.displayName;
              const jerseyNumber = player.jerseyNumber.pipe(
                Option.map((v) => `#${v}`),
                Option.getOrElse(() => '—'),
              );
              return (
                <tr key={player.memberId} className='border-b'>
                  <td className='py-2 px-4'>
                    <div className='flex items-center gap-2'>
                      <Avatar className='size-8'>
                        {Option.isSome(player.avatar) && (
                          <AvatarImage
                            src={`https://cdn.discordapp.com/avatars/${player.discordId}/${player.avatar.value}.png?size=32`}
                            alt={displayName}
                          />
                        )}
                        <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <span className='truncate'>{displayName}</span>
                    </div>
                  </td>
                  <td className='hidden sm:table-cell py-2 px-4'>{jerseyNumber}</td>
                  {canManage && (
                    <td className='py-2 px-4'>
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => handleRemoveMember(player.memberId)}
                      >
                        {tr('roster_removeMember')}
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {canManage && (
        <div className='mt-6'>
          <RosterPendingRequestsSection
            teamId={teamId}
            rosterId={rosterId}
            initialRequests={pendingRequests}
            onRefresh={() => router.invalidate()}
          />
        </div>
      )}
    </div>
  );
}
