import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type { AgeThresholdApi, GroupApi } from '@sideline/domain';
import { AgeThresholdRule, GroupModel, Team, User } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema, SchemaGetter } from 'effect';
import { Info } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '~/components/ui/tooltip';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const OptionalNumber = Schema.String.pipe(
  Schema.decodeTo(Schema.Option(Schema.Number), {
    decode: SchemaGetter.transform((s: string) =>
      s === '' ? Option.none() : Option.some(Number(s)),
    ),
    encode: SchemaGetter.transform(
      Option.match<string, number>({ onNone: () => '', onSome: (n) => String(n) }),
    ),
  }),
);

type GenderFormValue = 'any' | User.Gender;

const OptionalGender = Schema.Literals(['any', 'male', 'female', 'other']).pipe(
  Schema.decodeTo(Schema.Option(User.Gender), {
    decode: SchemaGetter.transform((s: GenderFormValue) =>
      s === 'any' ? Option.none<User.Gender>() : Option.some(s),
    ),
    encode: SchemaGetter.transform(
      Option.match<GenderFormValue, User.Gender>({
        onNone: () => 'any' as const,
        onSome: (g) => g,
      }),
    ),
  }),
);

type RequiredGroupIdFormValue = '' | GroupModel.GroupId;

// Decode: string (form value) → Option<string> (encoded form of Option<GroupId>)
// Encode: Option<string> → string (form value)
// Then Schema.Option(GroupModel.GroupId) decodes Option<string> → Option<GroupId>
const OptionalGroupId = Schema.String.pipe(
  Schema.decodeTo(Schema.Option(GroupModel.GroupId), {
    decode: SchemaGetter.transform(
      (s: string): Option.Option<string> => (s === '' ? Option.none() : Option.some(s)),
    ),
    encode: SchemaGetter.transform(
      Option.match<string, string>({ onNone: () => '', onSome: (g) => g }),
    ),
  }),
);

const CreateThresholdSchema = Schema.Struct({
  groupId: GroupModel.GroupId,
  requiredGroupId: OptionalGroupId,
  gender: OptionalGender,
  minAge: OptionalNumber,
  maxAge: OptionalNumber,
});

type CreateThresholdValues = Schema.Schema.Type<typeof CreateThresholdSchema>;

interface AgeThresholdsPageProps {
  teamId: string;
  rules: ReadonlyArray<AgeThresholdApi.AgeThresholdInfo>;
  groups: ReadonlyArray<GroupApi.GroupInfo>;
}

export function AgeThresholdsPage({ teamId, rules, groups }: AgeThresholdsPageProps) {
  const run = useRun();
  const router = useRouter();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const [evaluationResults, setEvaluationResults] = React.useState<
    ReadonlyArray<AgeThresholdApi.AgeGroupChange>
  >([]);
  const [evaluating, setEvaluating] = React.useState(false);

  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(CreateThresholdSchema)),
    mode: 'onChange',
    defaultValues: {
      groupId: '',
      requiredGroupId: '' as RequiredGroupIdFormValue,
      gender: 'any' as GenderFormValue,
      minAge: '',
      maxAge: '',
    },
  });

  const watchedGroupId = form.watch('groupId');
  const watchedRequiredGroupId = form.watch('requiredGroupId');
  const watchedGender = form.watch('gender');
  const watchedMinAge = form.watch('minAge');
  const watchedMaxAge = form.watch('maxAge');
  const isAllBlank =
    watchedGender === 'any' &&
    watchedMinAge === '' &&
    watchedMaxAge === '' &&
    watchedRequiredGroupId === '';

  const isSelfReference =
    watchedGroupId !== '' &&
    watchedRequiredGroupId !== '' &&
    watchedGroupId === watchedRequiredGroupId;

  React.useEffect(() => {
    if (isSelfReference) {
      form.setError('requiredGroupId', {
        type: 'selfReference',
        message: tr('ageThreshold_selfReferenceError'),
      });
    } else if (form.formState.errors.requiredGroupId?.type === 'selfReference') {
      form.clearErrors('requiredGroupId');
    }
  }, [isSelfReference, form]);

  const onSubmit = async (values: CreateThresholdValues) => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.ageThreshold.createAgeThreshold({
          params: { teamId: teamIdBranded },
          payload: values,
        }),
      ),
      Effect.catchTags({
        AgeThresholdEmptyCriteria: () =>
          Effect.fail(ClientError.make(tr('ageThreshold_emptyCriteria'))),
        AgeThresholdAlreadyExists: () =>
          Effect.fail(ClientError.make(tr('ageThreshold_alreadyExists'))),
        AgeThresholdSelfRequired: () =>
          Effect.fail(ClientError.make(tr('ageThreshold_selfReferenceError'))),
      }),
      // Only map *unhandled* errors to the generic toast — leave ClientErrors thrown
      // by the catchTags above intact so users see the specific message.
      Effect.catchIf(
        (e): e is Exclude<typeof e, ClientError> => (e as { _tag?: string })._tag !== 'ClientError',
        () => Effect.fail(ClientError.make(tr('ageThreshold_createFailed'))),
      ),
      run({ success: tr('ageThreshold_created') }),
    );
    if (Option.isSome(result)) {
      form.reset();
      router.invalidate();
    }
  };

  const handleDelete = React.useCallback(
    async (ruleIdRaw: string) => {
      if (!window.confirm(tr('ageThreshold_deleteConfirm'))) return;
      const ruleId = Schema.decodeSync(AgeThresholdRule.AgeThresholdRuleId)(ruleIdRaw);
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.ageThreshold.deleteAgeThreshold({
            params: { teamId: teamIdBranded, ruleId },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('ageThreshold_deleteFailed'))),
        run({ success: tr('ageThreshold_deleted') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamIdBranded, run, router],
  );

  const handleEvaluate = React.useCallback(async () => {
    setEvaluating(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.ageThreshold.evaluateAgeThresholds({
          params: { teamId: teamIdBranded },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('ageThreshold_evaluateFailed'))),
      run({ success: tr('ageThreshold_evaluated') }),
    );
    setEvaluating(false);
    if (Option.isSome(result)) {
      setEvaluationResults(result.value);
      router.invalidate();
    }
  }, [teamIdBranded, run, router]);

  const formatAgeRange = (minAge: Option.Option<number>, maxAge: Option.Option<number>) => {
    if (Option.isSome(minAge) && Option.isSome(maxAge)) {
      return `${minAge.value}–${maxAge.value}`;
    }
    if (Option.isSome(minAge)) {
      return `${minAge.value}+`;
    }
    if (Option.isSome(maxAge)) {
      return `≤${maxAge.value}`;
    }
    return tr('ageThreshold_anyAge');
  };

  const formatGender = (gender: Option.Option<User.Gender>) =>
    Option.match(gender, {
      onNone: () => '—',
      onSome: (g) => {
        if (g === 'male') return tr('ageThreshold_genderMale');
        if (g === 'female') return tr('ageThreshold_genderFemale');
        return tr('ageThreshold_genderOther');
      },
    });

  return (
    <div>
      <header className='mb-8'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {tr('team_backToTeams')}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{tr('ageThreshold_title')}</h1>
        <p className='text-muted-foreground mt-1'>{tr('ageThreshold_subtitle')}</p>
      </header>

      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className='flex flex-col gap-4 mb-6 sm:flex-row sm:flex-wrap sm:items-end sm:max-w-3xl'
        >
          <FormField
            {...form.register('groupId')}
            render={({ field }) => (
              <FormItem className='flex-1 min-w-[12rem]'>
                <FormLabel>{tr('group_groupName')}</FormLabel>
                <FormControl>
                  <SearchableSelect
                    value={field.value}
                    onValueChange={field.onChange}
                    placeholder={tr('ageThreshold_selectGroup')}
                    options={groups.map((group) => ({
                      value: group.groupId,
                      label: group.name,
                    }))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            {...form.register('requiredGroupId')}
            render={({ field }) => (
              <FormItem className='flex-1 min-w-[12rem]'>
                <FormLabel>{tr('ageThreshold_requiredGroup')}</FormLabel>
                <FormControl>
                  <SearchableSelect
                    value={field.value}
                    onValueChange={field.onChange}
                    placeholder={tr('ageThreshold_requiredGroupAny')}
                    options={[
                      { value: '', label: tr('ageThreshold_requiredGroupAny') },
                      ...groups.map((g) => ({ value: g.groupId, label: g.name })),
                    ]}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            {...form.register('gender')}
            render={({ field }) => (
              <FormItem className='w-32'>
                <FormLabel>{tr('ageThreshold_gender')}</FormLabel>
                <FormControl>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className='w-32'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='any'>{tr('ageThreshold_genderAny')}</SelectItem>
                      <SelectItem value='male'>{tr('ageThreshold_genderMale')}</SelectItem>
                      <SelectItem value='female'>{tr('ageThreshold_genderFemale')}</SelectItem>
                      <SelectItem value='other'>{tr('ageThreshold_genderOther')}</SelectItem>
                    </SelectContent>
                  </Select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className='flex gap-2'>
            <FormField
              {...form.register('minAge')}
              render={({ field }) => (
                <FormItem className='w-24'>
                  <FormLabel>{tr('ageThreshold_minAge')}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type='number'
                      placeholder={tr('ageThreshold_minAgePlaceholder')}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              {...form.register('maxAge')}
              render={({ field }) => (
                <FormItem className='w-24'>
                  <FormLabel>{tr('ageThreshold_maxAge')}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type='number'
                      placeholder={tr('ageThreshold_maxAgePlaceholder')}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <Button
            type='submit'
            disabled={form.formState.isSubmitting || isAllBlank || isSelfReference}
          >
            {tr('ageThreshold_create')}
          </Button>
        </form>
        <p className='text-sm text-muted-foreground'>{tr('ageThreshold_andSemantics')}</p>
      </Form>

      {rules.length === 0 ? (
        <p className='text-muted-foreground'>{tr('ageThreshold_noRules')}</p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full mb-6'>
            <thead>
              <tr className='border-b'>
                <th className='py-2 px-4 text-left'>{tr('group_groupName')}</th>
                <th className='py-2 px-4 text-left'>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type='button' className='flex items-center gap-1 cursor-default'>
                          {tr('ageThreshold_requiredGroup')}
                          <Info className='h-3 w-3' />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {tr('ageThreshold_requiredGroupHeaderTooltip')}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </th>
                <th className='py-2 px-4 text-left'>{tr('ageThreshold_gender')}</th>
                <th className='py-2 px-4 text-left'>{tr('ageThreshold_ageRange')}</th>
                <th className='py-2 px-4' />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => {
                const requiredGroupIdValue = Option.getOrNull(rule.requiredGroupId);
                const requiredGroupName = requiredGroupIdValue
                  ? (groups.find((g) => g.groupId === requiredGroupIdValue)?.name ?? '—')
                  : '—';
                return (
                  <tr key={rule.ruleId} className='border-b'>
                    <td className='py-2 px-4 font-medium'>{rule.groupName}</td>
                    <td className='py-2 px-4'>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button type='button' className='cursor-default'>
                              {requiredGroupIdValue ? requiredGroupName : '—'}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {Option.isSome(rule.requiredGroupId)
                              ? tr('ageThreshold_requiredGroupTooltipSpecific', {
                                  group: requiredGroupName,
                                })
                              : tr('ageThreshold_requiredGroupTooltipAny')}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </td>
                    <td className='py-2 px-4'>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button type='button' className='cursor-default'>
                              {formatGender(rule.gender)}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {Option.isSome(rule.gender)
                              ? tr('ageThreshold_genderTooltipSpecific', {
                                  gender: formatGender(rule.gender),
                                })
                              : tr('ageThreshold_genderTooltipAny')}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </td>
                    <td className='py-2 px-4'>{formatAgeRange(rule.minAge, rule.maxAge)}</td>
                    <td className='py-2 px-4'>
                      <Button variant='outline' size='sm' onClick={() => handleDelete(rule.ruleId)}>
                        {tr('ageThreshold_delete')}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className='flex flex-col gap-4'>
        <Button onClick={handleEvaluate} disabled={evaluating} variant='secondary'>
          {evaluating ? tr('ageThreshold_evaluating') : tr('ageThreshold_evaluateNow')}
        </Button>

        {evaluationResults.length > 0 && (
          <div>
            <h2 className='text-lg font-semibold mb-2'>{tr('ageThreshold_results')}</h2>
            <table className='w-full'>
              <tbody>
                {evaluationResults.map((change, i) => (
                  <tr
                    key={`${change.memberId}-${change.groupId}-${String(i)}`}
                    className='border-b'
                  >
                    <td className='py-2 px-4'>{change.memberName}</td>
                    <td className='py-2 px-4'>{change.groupName}</td>
                    <td className='py-2 px-4'>
                      <span
                        className={
                          change.action === 'added'
                            ? 'text-green-700 font-medium'
                            : 'text-red-700 font-medium'
                        }
                      >
                        {change.action === 'added'
                          ? tr('ageThreshold_added')
                          : tr('ageThreshold_removed')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
