import type { GroupApi, RoleApi, Roster as RosterDomain } from '@sideline/domain';
import { Discord, GroupModel, Role, Team, TeamMember } from '@sideline/domain';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { Loader2 } from 'lucide-react';
import React from 'react';
import { toast } from 'sonner';

import { ColorPicker } from '~/components/atoms/ColorPicker.js';
import { DiscordChannelLink } from '~/components/atoms/DiscordChannelLink.js';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Separator } from '~/components/ui/separator';
import { DISCORD_CHANNEL_TYPE_TEXT } from '~/lib/discord';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface GroupDetailPageProps {
  teamId: string;
  groupId: string;
  groupDetail: GroupApi.GroupDetail;
  allMembers: ReadonlyArray<RosterDomain.RosterPlayer>;
  allRoles: ReadonlyArray<RoleApi.RoleInfo>;
  channelMapping: Option.Option<GroupApi.ChannelMappingInfo>;
  allGroups: ReadonlyArray<GroupApi.GroupInfo>;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
  guildId: Option.Option<string>;
}

export function GroupDetailPage({
  teamId,
  groupId,
  groupDetail,
  allMembers,
  allRoles,
  channelMapping,
  allGroups,
  discordChannels,
  guildId,
}: GroupDetailPageProps) {
  const run = useRun();
  const router = useRouter();
  const navigate = useNavigate();

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const groupIdBranded = Schema.decodeSync(GroupModel.GroupId)(groupId);

  const [name, setName] = React.useState(groupDetail.name);
  const [emoji, setEmoji] = React.useState(Option.getOrElse(groupDetail.emoji, () => ''));
  const [color, setColor] = React.useState<string | undefined>(
    Option.getOrUndefined(groupDetail.color),
  );
  const [saving, setSaving] = React.useState(false);
  const [selectedMemberId, setSelectedMemberId] = React.useState<string>('');
  const [selectedRoleId, setSelectedRoleId] = React.useState<string>('');
  const [selectedChannelId, setSelectedChannelId] = React.useState('');
  const [parentGroupId, setParentGroupId] = React.useState<string>(
    Option.getOrElse(groupDetail.parentId, () => '__root__'),
  );
  const [syncingRoleMembers, setSyncingRoleMembers] = React.useState(false);

  React.useEffect(() => {
    if (!groupDetail.discordChannelProvisioning) return;
    const id = setInterval(() => {
      router.invalidate();
    }, 5000);
    return () => clearInterval(id);
  }, [groupDetail.discordChannelProvisioning, router]);

  const memberIdsInGroup = new Set(groupDetail.members.map((m) => m.memberId));
  const availableMembers = allMembers.filter((m) => !memberIdsInGroup.has(m.memberId));

  const roleIdsInGroup = new Set(groupDetail.roles.map((r) => r.roleId));
  const availableRoles = allRoles.filter((r) => !roleIdsInGroup.has(r.roleId));

  const handleSaveName = React.useCallback(async () => {
    setSaving(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.group.updateGroup({
          params: { teamId: teamIdBranded, groupId: groupIdBranded },
          payload: {
            name,
            emoji: emoji ? Option.some(emoji) : Option.none(),
            color: color ? Option.some(color) : Option.none(),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('group_updateFailed'))),
      run({ success: tr('group_groupSaved') }),
    );
    setSaving(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [teamIdBranded, groupIdBranded, name, emoji, color, run, router]);

  const handleAddMember = React.useCallback(async () => {
    if (!selectedMemberId) return;
    const memberId = Schema.decodeSync(TeamMember.TeamMemberId)(selectedMemberId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.group.addGroupMember({
          params: { teamId: teamIdBranded, groupId: groupIdBranded },
          payload: { memberId },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('group_updateFailed'))),
      run({ success: tr('group_memberAdded') }),
    );
    if (Option.isSome(result)) {
      setSelectedMemberId('');
      router.invalidate();
    }
  }, [selectedMemberId, teamIdBranded, groupIdBranded, run, router]);

  const handleRemoveMember = React.useCallback(
    async (memberIdRaw: string) => {
      const memberId = Schema.decodeSync(TeamMember.TeamMemberId)(memberIdRaw);
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.group.removeGroupMember({
            params: { teamId: teamIdBranded, groupId: groupIdBranded, memberId },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('group_updateFailed'))),
        run({ success: tr('group_memberRemoved') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamIdBranded, groupIdBranded, run, router],
  );

  const handleAssignRole = React.useCallback(async () => {
    if (!selectedRoleId) return;
    const roleId = Schema.decodeSync(Role.RoleId)(selectedRoleId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.group.assignGroupRole({
          params: { teamId: teamIdBranded, groupId: groupIdBranded },
          payload: { roleId },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('group_updateFailed'))),
      run({ success: tr('group_roleAssigned') }),
    );
    if (Option.isSome(result)) {
      setSelectedRoleId('');
      router.invalidate();
    }
  }, [selectedRoleId, teamIdBranded, groupIdBranded, run, router]);

  const handleUnassignRole = React.useCallback(
    async (roleIdRaw: string) => {
      const roleId = Schema.decodeSync(Role.RoleId)(roleIdRaw);
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.group.unassignGroupRole({
            params: { teamId: teamIdBranded, groupId: groupIdBranded, roleId },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('group_updateFailed'))),
        run({ success: tr('group_roleUnassigned') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamIdBranded, groupIdBranded, run, router],
  );

  const handleDelete = React.useCallback(async () => {
    if (!window.confirm(tr('group_deleteGroupConfirm'))) return;
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.group.deleteGroup({
          params: { teamId: teamIdBranded, groupId: groupIdBranded },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('group_deleteFailed'))),
      run({ success: tr('group_groupDeleted') }),
    );
    if (Option.isSome(result)) {
      navigate({ to: '/teams/$teamId/groups', params: { teamId } });
    }
  }, [teamId, teamIdBranded, groupIdBranded, run, navigate]);

  const handleLinkChannel = React.useCallback(async () => {
    if (!selectedChannelId) return;
    const discordChannelId = Schema.decodeSync(Discord.Snowflake)(selectedChannelId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.group.setChannelMapping({
          params: { teamId: teamIdBranded, groupId: groupIdBranded },
          payload: { discordChannelId },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('group_channelLinkFailed'))),
      run({ success: tr('group_channelLinked') }),
    );
    if (Option.isSome(result)) {
      setSelectedChannelId('');
      router.invalidate();
    }
  }, [selectedChannelId, teamIdBranded, groupIdBranded, run, router]);

  const handleUnlinkChannel = React.useCallback(async () => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.group.deleteChannelMapping({
          params: { teamId: teamIdBranded, groupId: groupIdBranded },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('group_channelLinkFailed'))),
      run({ success: tr('group_channelUnlinked') }),
    );
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [teamIdBranded, groupIdBranded, run, router]);

  const handleMoveGroup = React.useCallback(
    async (newParentId: string) => {
      const parentId =
        newParentId === '__root__'
          ? Option.none()
          : Option.some(Schema.decodeSync(GroupModel.GroupId)(newParentId));
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.group.moveGroup({
            params: { teamId: teamIdBranded, groupId: groupIdBranded },
            payload: { parentId },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('group_moveGroupFailed'))),
        run({ success: tr('group_parentChanged') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamIdBranded, groupIdBranded, run, router],
  );

  const handleCreateChannel = React.useCallback(async () => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.group.createChannel({
          params: { teamId: teamIdBranded, groupId: groupIdBranded },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('group_channelCreateFailed'))),
      run({ success: tr('group_channelCreateRequested') }),
    );
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [teamIdBranded, groupIdBranded, run, router]);

  const handleSyncRoleMembers = React.useCallback(async () => {
    setSyncingRoleMembers(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.group.syncRoleMembers({
          params: { teamId: teamIdBranded, groupId: groupIdBranded },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('group_syncRoleMembersFailed'))),
      run({}),
    );
    if (Option.isSome(result)) {
      toast.success(
        tr('group_syncRoleMembersQueued', {
          addedCount: result.value.addedCount,
          removedCount: result.value.removedCount,
          skippedCount: result.value.skippedCount,
        }),
      );
    }
    setSyncingRoleMembers(false);
  }, [teamIdBranded, groupIdBranded, run]);

  const linkedChannel = Option.flatMap(channelMapping, (mapping) =>
    Option.map(mapping.discordChannelId, (channelId) => ({
      channelId,
      channelName: mapping.discordChannelName,
    })),
  );

  return (
    <div>
      <header className='mb-8'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId/groups' params={{ teamId }}>
            ← {tr('group_backToGroups')}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{groupDetail.name}</h1>
      </header>

      <div className='flex flex-col gap-6'>
        {/* Rename / Emoji / Color */}
        <div>
          <label htmlFor='group-name' className='text-sm font-medium mb-1 block'>
            {tr('group_nameEmojiColor')}
          </label>
          <div className='flex flex-col gap-2 sm:flex-row'>
            <div className='flex gap-2 flex-1'>
              <Input
                id='group-emoji'
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                className='w-16 shrink-0'
                placeholder='Emoji'
              />
              <ColorPicker value={color} onChange={setColor} />
              <Input
                id='group-name'
                value={name}
                onChange={(e) => setName(e.target.value)}
                className='flex-1'
              />
            </div>
            <Button
              onClick={handleSaveName}
              disabled={
                saving &&
                name === groupDetail.name &&
                (emoji || null) === Option.getOrNull(groupDetail.emoji)
              }
            >
              {saving ? tr('group_saving') : tr('group_saveChanges')}
            </Button>
          </div>
        </div>

        {/* Parent Group */}
        <div>
          <label htmlFor='parent-group' className='text-sm font-medium mb-1 block'>
            {tr('group_parentGroup')}
          </label>
          <div className='flex gap-2'>
            <SearchableSelect
              className='flex-1'
              value={parentGroupId}
              onValueChange={(value) => {
                setParentGroupId(value);
                handleMoveGroup(value);
              }}
              pinnedValues={['__root__']}
              options={[
                { value: '__root__', label: tr('group_rootGroup') },
                ...allGroups
                  .filter((g) => g.groupId !== groupId)
                  .map((g) => ({
                    value: g.groupId,
                    label: g.emoji.pipe(
                      Option.map((v) => `${v} ${g.name}`),
                      Option.getOrElse(() => g.name),
                    ),
                  })),
              ]}
            />
          </div>
        </div>

        {/* Roles */}
        <div>
          <p className='text-sm font-medium mb-2'>{tr('group_roles')}</p>
          <div className='flex gap-2 mb-4'>
            <SearchableSelect
              className='flex-1'
              value={selectedRoleId}
              onValueChange={setSelectedRoleId}
              placeholder={tr('group_assignRole')}
              options={availableRoles.map((role) => ({ value: role.roleId, label: role.name }))}
            />
            <Button onClick={handleAssignRole} disabled={!selectedRoleId}>
              {tr('group_assignRole')}
            </Button>
          </div>

          {groupDetail.roles.length === 0 ? (
            <p className='text-muted-foreground'>{tr('roles_noRoles')}</p>
          ) : (
            <table className='w-full'>
              <tbody>
                {groupDetail.roles.map((role) => (
                  <tr key={role.roleId} className='border-b'>
                    <td className='py-2 px-4'>{role.roleName}</td>
                    <td className='py-2 px-4'>
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => handleUnassignRole(role.roleId)}
                      >
                        {tr('group_unassignRole')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Discord Channel */}
        <Card className='max-w-md'>
          <CardHeader>
            <CardTitle className='text-base'>{tr('group_discordChannel')}</CardTitle>
          </CardHeader>
          <CardContent>
            {groupDetail.discordChannelProvisioning ? (
              <div className='flex flex-col items-center gap-2 py-4'>
                <Loader2 className='size-5 animate-spin text-muted-foreground' />
                <p className='text-sm font-medium'>{tr('discord_channelProvisioning')}</p>
                <p className='text-xs text-muted-foreground'>
                  {tr('discord_channelProvisioningHint')}
                </p>
              </div>
            ) : Option.isSome(linkedChannel) ? (
              <div className='flex flex-col gap-3'>
                <div className='flex items-center justify-between'>
                  {Option.isSome(guildId) ? (
                    <DiscordChannelLink
                      guildId={guildId.value}
                      channelId={linkedChannel.value.channelId}
                      channelName={Option.getOrElse(
                        linkedChannel.value.channelName,
                        () => linkedChannel.value.channelId,
                      )}
                    />
                  ) : (
                    <span className='text-sm font-medium'>
                      #{' '}
                      {Option.getOrElse(
                        linkedChannel.value.channelName,
                        () => linkedChannel.value.channelId,
                      )}
                    </span>
                  )}
                  <Button variant='outline' size='sm' onClick={handleUnlinkChannel}>
                    {tr('group_unlinkChannel')}
                  </Button>
                </div>
                <p className='text-xs text-muted-foreground'>{tr('group_unlinkChannelHelp')}</p>
              </div>
            ) : (
              <div className='flex flex-col gap-4'>
                <Button className='w-full' onClick={handleCreateChannel}>
                  {tr('group_createChannel')}
                </Button>

                <div className='relative'>
                  <div className='absolute inset-0 flex items-center'>
                    <Separator className='w-full' />
                  </div>
                  <div className='relative flex justify-center text-xs uppercase'>
                    <span className='bg-card px-2 text-muted-foreground'>
                      {tr('group_orLinkExisting')}
                    </span>
                  </div>
                </div>

                <div className='flex gap-2'>
                  <SearchableSelect
                    className='flex-1'
                    value={selectedChannelId}
                    onValueChange={setSelectedChannelId}
                    placeholder={tr('group_selectChannel')}
                    options={discordChannels
                      .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
                      .map((ch) => ({ value: ch.id, label: `# ${ch.name}` }))}
                  />
                  <Button onClick={handleLinkChannel} disabled={!selectedChannelId}>
                    {tr('group_linkChannel')}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Discord Role */}
        <Card className='max-w-md'>
          <CardHeader>
            <CardTitle className='text-base'>{tr('group_syncRoleMembers')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className='text-xs text-muted-foreground mb-3'>{tr('group_syncRoleMembersHelp')}</p>
            <Button variant='outline' onClick={handleSyncRoleMembers} disabled={syncingRoleMembers}>
              {syncingRoleMembers ? (
                <>
                  <Loader2 className='mr-2 size-4 animate-spin' />
                  {tr('group_syncRoleMembers')}
                </>
              ) : (
                tr('group_syncRoleMembers')
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Members */}
        <div>
          <p className='text-sm font-medium mb-2'>{tr('group_members')}</p>
          <div className='flex gap-2 mb-4'>
            <SearchableSelect
              className='flex-1'
              value={selectedMemberId}
              onValueChange={setSelectedMemberId}
              placeholder={tr('group_addMember')}
              options={availableMembers.map((member) => ({
                value: member.memberId,
                label: Option.getOrElse(member.name, () => member.username),
              }))}
            />
            <Button onClick={handleAddMember} disabled={!selectedMemberId}>
              {tr('group_addMember')}
            </Button>
          </div>

          {groupDetail.members.length === 0 ? (
            <p className='text-muted-foreground'>{tr('members_noPlayers')}</p>
          ) : (
            <table className='w-full'>
              <tbody>
                {groupDetail.members.map((member) => (
                  <tr key={member.memberId} className='border-b'>
                    <td className='py-2 px-4'>
                      {Option.getOrElse(member.name, () => member.username)}
                    </td>
                    <td className='py-2 px-4'>
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => handleRemoveMember(member.memberId)}
                      >
                        {tr('group_removeMember')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Delete */}
        <div>
          <Button variant='destructive' onClick={handleDelete}>
            {tr('group_deleteGroup')}
          </Button>
        </div>
      </div>
    </div>
  );
}
