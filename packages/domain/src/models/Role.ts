import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { TeamId } from '~/models/Team.js';

export const RoleId = Schema.String.pipe(Schema.brand('RoleId'));
export type RoleId = typeof RoleId.Type;

export const Permission = Schema.Literals([
  'team:manage',
  'team:invite',
  'roster:view',
  'roster:manage',
  'member:view',
  'member:edit',
  'member:remove',
  'role:view',
  'role:manage',
  'activity-type:create',
  'activity-type:delete',
  'training-type:create',
  'training-type:delete',
  'event:create',
  'event:edit',
  'event:cancel',
  'group:manage',
  'finance:view',
  'finance:manage_fees',
  'finance:record_payments',
  'challenge:manage',
]);
export type Permission = typeof Permission.Type;

export const allPermissions: ReadonlyArray<Permission> =
  Permission.literals as ReadonlyArray<Permission>;

export const defaultPermissions: Record<string, ReadonlyArray<Permission>> = {
  Admin: [
    'team:manage',
    'team:invite',
    'roster:view',
    'roster:manage',
    'member:view',
    'member:edit',
    'member:remove',
    'role:view',
    'role:manage',
    'activity-type:create',
    'activity-type:delete',
    'training-type:create',
    'training-type:delete',
    'event:create',
    'event:edit',
    'event:cancel',
    'group:manage',
    'finance:view',
    'finance:manage_fees',
    'finance:record_payments',
    'challenge:manage',
  ],
  Captain: [
    'roster:view',
    'roster:manage',
    'member:view',
    'member:edit',
    'role:view',
    'activity-type:create',
    'activity-type:delete',
    'training-type:create',
    'event:create',
    'event:edit',
    'event:cancel',
    'group:manage',
    'finance:view',
    'challenge:manage',
  ],
  Player: ['roster:view', 'member:view'],
  Treasurer: ['finance:view', 'finance:manage_fees', 'finance:record_payments'],
};

export const builtInRoleNames = ['Admin', 'Captain', 'Player', 'Treasurer'] as const;

export class Role extends Model.Class<Role>('Role')({
  id: Model.Generated(RoleId),
  team_id: TeamId,
  name: Schema.String,
  is_built_in: Schema.Boolean,
  created_at: Model.DateTimeInsertFromDate,
}) {}

export class RolePermission extends Schema.Class<RolePermission>('RolePermission')({
  role_id: RoleId,
  permission: Permission,
}) {}
