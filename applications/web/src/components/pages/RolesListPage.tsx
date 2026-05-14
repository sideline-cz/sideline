import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type { RoleApi } from '@sideline/domain';
import { Team } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { useForm } from 'react-hook-form';
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
}

export function RolesListPage({ teamId, roles, canManage }: RolesListPageProps) {
  const run = useRun();
  const router = useRouter();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);

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

      {roles.length === 0 ? (
        <p className='text-muted-foreground'>{tr('role_noRoles')}</p>
      ) : (
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
      )}
    </div>
  );
}
