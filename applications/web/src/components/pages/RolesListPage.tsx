import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type { RoleApi } from '@sideline/domain';
import { Role, Team } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { OctagonX, TriangleAlert, UserPlus } from 'lucide-react';
import React from 'react';
import { useForm } from 'react-hook-form';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { NONE_VALUE } from '~/components/organisms/team-settings/shared.js';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '~/components/ui/form';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { withFieldErrors } from '~/lib/form';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const CreateRoleSchema = Schema.Struct({
  name: Schema.NonEmptyString.annotate({ message: tr('validation_required') }),
});

type CreateRoleValues = Schema.Schema.Type<typeof CreateRoleSchema>;

interface RolesListPageProps {
  teamId: string;
  roles: ReadonlyArray<RoleApi.RoleInfo>;
  canManage: boolean;
  // RESOLVED server-side (`TeamMembersRepository.getDefaultRoleId`), fallback included — see
  // `RoleApi.RoleListResponse`. Never re-derive this in the browser.
  defaultRoleId: Option.Option<Role.RoleId>;
  defaultRoleGrantsManage: boolean;
}

export function RolesListPage({
  teamId,
  roles,
  canManage,
  defaultRoleId,
  defaultRoleGrantsManage,
}: RolesListPageProps) {
  const run = useRun();
  const router = useRouter();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const [savingDefault, setSavingDefault] = React.useState(false);
  // Optimistic echo of the in-flight selection — `SearchableSelect` is fully controlled and
  // renders straight off `value`, so without this it keeps showing the OLD role for the entire
  // round trip (API call + un-awaited `router.invalidate()` refetch). Cleared once the loader
  // refetch behind a successful `invalidate()` lands (so `defaultRoleId` already matches by the
  // time we drop it — no flicker back to old-then-snap-to-new), or immediately on failure, which
  // snaps the control back to the still-correct server value.
  const [pending, setPending] = React.useState<string | null>(null);

  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(CreateRoleSchema)),
    mode: 'onChange',
    defaultValues: { name: '' },
  });

  const onSubmit = async (values: CreateRoleValues) => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.role.createRole({
          params: { teamId: teamIdBranded },
          payload: { name: values.name, permissions: [] },
        }),
      ),
      withFieldErrors(form, [
        { tag: 'RoleNameAlreadyTaken', field: 'name', message: tr('role_nameAlreadyTaken') },
      ]),
      Effect.mapError(() => ClientError.make(tr('role_createFailed'))),
      run({ success: tr('role_roleCreated') }),
    );
    if (Option.isSome(result)) {
      form.reset();
      router.invalidate();
    }
  };

  const onChangeDefault = async (value: string) => {
    const roleId = Schema.decodeSync(Role.RoleId)(value);
    const roleName = roles.find((r) => r.roleId === roleId)?.name ?? value;
    setPending(value);
    setSavingDefault(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.role.setDefaultRole({
          params: { teamId: teamIdBranded },
          payload: { roleId },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('role_defaultUpdateFailed'))),
      run({ success: tr('role_defaultUpdated', { role: roleName }) }),
    );
    setSavingDefault(false);
    if (Option.isSome(result)) {
      await router.invalidate();
    }
    setPending(null);
  };

  const defaultSelectValue = Option.getOrElse(defaultRoleId, () => NONE_VALUE);
  const defaultSelectOptions = roles.map((r) => ({ value: r.roleId, label: r.name }));

  return (
    <div>
      <header className='mb-8'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {tr('team_backToTeams')}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{tr('role_roles')}</h1>
      </header>

      {canManage && (
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className='flex gap-2 mb-6 max-w-md'>
            <FormField
              {...form.register('name')}
              render={({ field }) => (
                <FormItem className='flex-1'>
                  <FormLabel>{tr('role_roleName')}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={tr('role_roleNamePlaceholder')} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type='submit' disabled={form.formState.isSubmitting} className='self-end'>
              {tr('role_createRole')}
            </Button>
          </form>
        </Form>
      )}

      <div className='mb-6 max-w-md'>
        <Label htmlFor='default-role' className='text-sm font-medium mb-1 block'>
          {tr('role_defaultForNewMembers')}
        </Label>
        <SearchableSelect
          id='default-role'
          aria-describedby='default-role-help'
          value={pending ?? defaultSelectValue}
          onValueChange={onChangeDefault}
          options={defaultSelectOptions}
          placeholder={tr('role_defaultNone')}
          disabled={!canManage || savingDefault}
        />
        <p id='default-role-help' className='text-sm text-muted-foreground'>
          {tr('role_defaultHint')}
        </p>
        {Option.isNone(defaultRoleId) && (
          <Alert variant='destructive' className='mt-2'>
            <OctagonX className='size-4' aria-hidden='true' />
            <AlertDescription>{tr('role_defaultBrokenWarning')}</AlertDescription>
          </Alert>
        )}
        {Option.isSome(defaultRoleId) && defaultRoleGrantsManage && (
          <Alert variant='warning' className='mt-2'>
            <TriangleAlert className='size-4' aria-hidden='true' />
            <AlertDescription>{tr('role_defaultEscalationWarning')}</AlertDescription>
          </Alert>
        )}
      </div>

      {roles.length === 0 ? (
        <p className='text-muted-foreground'>{tr('role_noRoles')}</p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full'>
            <tbody>
              {roles.map((role) => (
                <tr key={role.roleId} className='border-b'>
                  <td className='py-2 px-4'>
                    <Link
                      to='/teams/$teamId/roles/$roleId'
                      params={{ teamId, roleId: role.roleId }}
                      className='font-medium hover:underline'
                    >
                      {role.name}
                    </Link>
                    {Option.contains(defaultRoleId, role.roleId) && (
                      <Badge
                        variant='secondary'
                        className='ml-2 align-middle'
                        aria-label={tr('role_defaultForNewMembers')}
                      >
                        <UserPlus className='size-3' aria-hidden='true' />
                        {tr('role_default')}
                      </Badge>
                    )}
                    {/* Show permission count inline on mobile */}
                    <p className='text-xs text-muted-foreground sm:hidden'>
                      {tr('role_permissionCount', { count: String(role.permissionCount) })}
                    </p>
                  </td>
                  <td className='hidden sm:table-cell py-2 px-4'>
                    <span
                      className={
                        role.isBuiltIn
                          ? 'text-blue-700 font-medium'
                          : 'text-muted-foreground font-medium'
                      }
                    >
                      {role.isBuiltIn ? tr('role_builtIn') : tr('role_custom')}
                    </span>
                  </td>
                  <td className='hidden sm:table-cell py-2 px-4 text-muted-foreground'>
                    {tr('role_permissionCount', { count: String(role.permissionCount) })}
                  </td>
                  <td className='py-2 px-4'>
                    <Button asChild variant='outline' size='sm'>
                      <Link
                        to='/teams/$teamId/roles/$roleId'
                        params={{ teamId, roleId: role.roleId }}
                      >
                        View
                      </Link>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
