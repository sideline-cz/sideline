import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type { GroupApi, TrainingTypeApi } from '@sideline/domain';
import { GroupModel, Team } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import React from 'react';
import { useForm } from 'react-hook-form';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
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
import { toGroupOptions } from '~/lib/group-options';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const CreateTrainingTypeSchema = Schema.Struct({
  name: Schema.NonEmptyString.annotate({ message: tr('validation_required') }),
});

type CreateTrainingTypeValues = Schema.Schema.Type<typeof CreateTrainingTypeSchema>;

const NONE_VALUE = '__none__';

interface TrainingTypesListPageProps {
  teamId: string;
  trainingTypes: ReadonlyArray<TrainingTypeApi.TrainingTypeInfo>;
  canAdmin: boolean;
  groups: ReadonlyArray<GroupApi.GroupInfo>;
}

export function TrainingTypesListPage({
  teamId,
  trainingTypes,
  canAdmin,
  groups,
}: TrainingTypesListPageProps) {
  const run = useRun();
  const router = useRouter();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);

  const [ownerGroupId, setOwnerGroupId] = React.useState(NONE_VALUE);
  const [memberGroupId, setMemberGroupId] = React.useState(NONE_VALUE);

  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(CreateTrainingTypeSchema)),
    mode: 'onChange',
    defaultValues: { name: '' },
  });

  const onSubmit = async (values: CreateTrainingTypeValues) => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.trainingType.createTrainingType({
          params: { teamId: teamIdBranded },
          payload: {
            name: values.name,
            ownerGroupId:
              ownerGroupId !== NONE_VALUE
                ? Option.some(Schema.decodeSync(GroupModel.GroupId)(ownerGroupId))
                : Option.none(),
            memberGroupId:
              memberGroupId !== NONE_VALUE
                ? Option.some(Schema.decodeSync(GroupModel.GroupId)(memberGroupId))
                : Option.none(),
            discordChannelId: Option.none(),
          },
        }),
      ),
      withFieldErrors(form, [
        {
          tag: 'TrainingTypeNameAlreadyTaken',
          field: 'name',
          message: tr('trainingType_nameAlreadyTaken'),
        },
      ]),
      Effect.mapError(() => ClientError.make(tr('trainingType_createFailed'))),
      run({ success: tr('trainingType_created') }),
    );
    if (Option.isSome(result)) {
      form.reset();
      setOwnerGroupId(NONE_VALUE);
      setMemberGroupId(NONE_VALUE);
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
        <h1 className='text-2xl font-bold'>{tr('trainingType_trainingTypes')}</h1>
      </header>

      {canAdmin && (
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className='flex flex-col gap-4 mb-6 max-w-xl'
          >
            <FormField
              {...form.register('name')}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tr('trainingType_name')}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={tr('trainingType_namePlaceholder')} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {groups.length > 0 && (
              <div className='flex flex-col gap-4 sm:flex-row'>
                <div className='flex-1'>
                  <label htmlFor='owner-group-select' className='text-sm font-medium mb-1 block'>
                    {tr('event_ownerGroup')}
                  </label>
                  <p className='text-xs text-muted-foreground mb-2'>{tr('event_ownerGroupHelp')}</p>
                  <SearchableSelect
                    id='owner-group-select'
                    value={ownerGroupId}
                    onValueChange={setOwnerGroupId}
                    placeholder={tr('event_useDefault')}
                    options={[
                      { value: NONE_VALUE, label: tr('event_useDefault') },
                      ...toGroupOptions(groups),
                    ]}
                    pinnedValues={[NONE_VALUE]}
                    className='w-full sm:max-w-xs'
                  />
                </div>
                <div className='flex-1'>
                  <label htmlFor='member-group-select' className='text-sm font-medium mb-1 block'>
                    {tr('event_memberGroup')}
                  </label>
                  <p className='text-xs text-muted-foreground mb-2'>
                    {tr('event_memberGroupHelp')}
                  </p>
                  <SearchableSelect
                    id='member-group-select'
                    value={memberGroupId}
                    onValueChange={setMemberGroupId}
                    placeholder={tr('event_useDefault')}
                    options={[
                      { value: NONE_VALUE, label: tr('event_useDefault') },
                      ...toGroupOptions(groups),
                    ]}
                    pinnedValues={[NONE_VALUE]}
                    className='w-full sm:max-w-xs'
                  />
                </div>
              </div>
            )}
            <div>
              <Button type='submit' disabled={form.formState.isSubmitting}>
                {tr('trainingType_createTrainingType')}
              </Button>
            </div>
          </form>
        </Form>
      )}

      {trainingTypes.length === 0 ? (
        <p className='text-muted-foreground'>{tr('trainingType_noTrainingTypes')}</p>
      ) : (
        <table className='w-full'>
          <thead>
            <tr className='border-b'>
              <th className='py-2 px-4 text-left text-sm font-medium'>{tr('trainingType_name')}</th>
              <th className='hidden sm:table-cell py-2 px-4 text-left text-sm font-medium text-muted-foreground'>
                {tr('event_ownerGroup')}
              </th>
              <th className='hidden sm:table-cell py-2 px-4 text-left text-sm font-medium text-muted-foreground'>
                {tr('event_memberGroup')}
              </th>
              <th className='py-2 px-4' />
            </tr>
          </thead>
          <tbody>
            {trainingTypes.map((tt) => (
              <tr key={tt.trainingTypeId} className='border-b'>
                <td className='py-2 px-4'>
                  <Link
                    to='/teams/$teamId/training-types/$trainingTypeId'
                    params={{ teamId, trainingTypeId: tt.trainingTypeId }}
                    className='font-medium hover:underline'
                  >
                    {tt.name}
                  </Link>
                  {(Option.isSome(tt.ownerGroupName) || Option.isSome(tt.memberGroupName)) && (
                    <p className='text-xs text-muted-foreground sm:hidden'>
                      {Option.getOrElse(tt.ownerGroupName, () => tr('trainingType_noGroup'))}
                      {' / '}
                      {Option.getOrElse(tt.memberGroupName, () => tr('trainingType_noGroup'))}
                    </p>
                  )}
                </td>
                <td className='hidden sm:table-cell py-2 px-4 text-muted-foreground'>
                  {Option.getOrElse(tt.ownerGroupName, () => tr('trainingType_noGroup'))}
                </td>
                <td className='hidden sm:table-cell py-2 px-4 text-muted-foreground'>
                  {Option.getOrElse(tt.memberGroupName, () => tr('trainingType_noGroup'))}
                </td>
                <td className='py-2 px-4'>
                  <Button asChild variant='outline' size='sm'>
                    <Link
                      to='/teams/$teamId/training-types/$trainingTypeId'
                      params={{ teamId, trainingTypeId: tt.trainingTypeId }}
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
