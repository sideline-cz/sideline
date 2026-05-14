import type { RoleApi } from '@sideline/domain';
import { Role, Team } from '@sideline/domain';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import React from 'react';

import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const permissionLabels: Record<Role.Permission, () => string> = {
  'team:manage': () => tr('role_perm_teamManage'),
  'team:invite': () => tr('role_perm_teamInvite'),
  'roster:view': () => tr('role_perm_rosterView'),
  'roster:manage': () => tr('role_perm_rosterManage'),
  'member:view': () => tr('role_perm_memberView'),
  'member:edit': () => tr('role_perm_memberEdit'),
  'member:remove': () => tr('role_perm_memberRemove'),
  'role:view': () => tr('role_perm_roleView'),
  'role:manage': () => tr('role_perm_roleManage'),
  'activity-type:create': () => tr('role_perm_activityTypeCreate'),
  'activity-type:delete': () => tr('role_perm_activityTypeDelete'),
  'training-type:create': () => tr('role_perm_trainingTypeCreate'),
  'training-type:delete': () => tr('role_perm_trainingTypeDelete'),
  'event:create': () => tr('role_perm_eventCreate'),
  'event:edit': () => tr('role_perm_eventEdit'),
  'event:cancel': () => tr('role_perm_eventCancel'),
  'group:manage': () => tr('role_perm_groupManage'),
};

interface RoleDetailPageProps {
  teamId: string;
  role: RoleApi.RoleDetail;
  canManage: boolean;
}

export function RoleDetailPage({ teamId, role, canManage }: RoleDetailPageProps) {
  const run = useRun();
  const router = useRouter();
  const navigate = useNavigate();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const roleIdBranded = Schema.decodeSync(Role.RoleId)(role.roleId);

  const [name, setName] = React.useState(role.name);
  const [permissions, setPermissions] = React.useState<ReadonlyArray<Role.Permission>>(
    role.permissions,
  );
  const [saving, setSaving] = React.useState(false);

  const togglePermission = React.useCallback((perm: Role.Permission) => {
    setPermissions((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm],
    );
  }, []);

  const handleSave = React.useCallback(async () => {
    setSaving(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.role.updateRole({
          params: { teamId: teamIdBranded, roleId: roleIdBranded },
          payload: {
            name: role.isBuiltIn ? Option.none() : Option.some(name),
            permissions: Option.some([...permissions]),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('role_updateFailed'))),
      run({ success: tr('role_roleSaved') }),
    );
    setSaving(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [teamIdBranded, roleIdBranded, name, permissions, run, router, role.isBuiltIn]);

  const handleDelete = React.useCallback(async () => {
    if (!window.confirm(tr('role_deleteRoleConfirm'))) return;
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.role.deleteRole({ params: { teamId: teamIdBranded, roleId: roleIdBranded } }),
      ),
      Effect.mapError(() => ClientError.make(tr('role_deleteFailed'))),
      run({ success: tr('role_roleDeleted') }),
    );
    if (Option.isSome(result)) {
      navigate({ to: '/teams/$teamId/roles', params: { teamId } });
    }
  }, [teamIdBranded, roleIdBranded, teamId, navigate, run]);

  return (
    <div>
      <header className='mb-8'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId/roles' params={{ teamId }}>
            ← {tr('role_backToRoles')}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{role.name}</h1>
        <span className={role.isBuiltIn ? 'text-blue-700 font-medium' : 'text-muted-foreground'}>
          {role.isBuiltIn ? tr('role_builtIn') : tr('role_custom')}
        </span>
      </header>

      <div className='flex flex-col gap-4'>
        <div>
          <label htmlFor='role-name' className='text-sm font-medium mb-1 block'>
            {tr('role_roleName')}
          </label>
          <Input
            id='role-name'
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={role.isBuiltIn || !canManage}
            className={role.isBuiltIn || !canManage ? 'text-muted-foreground' : undefined}
          />
        </div>

        <div>
          <p className='text-sm font-medium mb-2'>{tr('role_permissions')}</p>
          <div className='flex flex-col gap-2'>
            {Role.allPermissions.map((perm) => (
              <label key={perm} className='flex items-center gap-2 cursor-pointer'>
                <input
                  type='checkbox'
                  checked={permissions.includes(perm)}
                  onChange={() => togglePermission(perm)}
                  disabled={!canManage}
                  className='rounded'
                />
                <span className='text-sm'>{permissionLabels[perm]()}</span>
              </label>
            ))}
          </div>
        </div>

        {canManage && (
          <div className='flex gap-2'>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? tr('role_saving') : tr('role_saveChanges')}
            </Button>
            {!role.isBuiltIn ? (
              <Button variant='destructive' onClick={handleDelete}>
                {tr('role_deleteRole')}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
