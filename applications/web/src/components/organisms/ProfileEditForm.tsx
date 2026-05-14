import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { Auth } from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import { useForm } from 'react-hook-form';

import { Button } from '~/components/ui/button';
import { DatePicker } from '~/components/ui/date-picker';
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
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const currentYear = new Date().getFullYear();
const maxBirthYear = currentYear - Auth.MIN_AGE;
const defaultBirthMonth = new Date(currentYear - Auth.DEFAULT_BIRTH_YEAR_OFFSET, 0);

const NONE_VALUE = '__none__';

const ProfileEditSchema = Schema.Struct({
  name: Schema.String,
  birthDate: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((s: string) => {
        if (s === '') return true;
        const d = new Date(s);
        if (Number.isNaN(d.getTime())) return tr('validation_required');
        const minDate = new Date();
        minDate.setFullYear(minDate.getFullYear() - Auth.MIN_AGE);
        if (d > minDate) return tr('validation_minAge', { minAge: Auth.MIN_AGE });
        return true;
      }),
    ),
  ),
  gender: Schema.Union([
    Schema.Literals(['male', 'female', 'other']),
    Schema.Literal(NONE_VALUE),
  ]).annotate({ message: tr('validation_invalidOption') }),
});

type ProfileEditValues = Schema.Schema.Type<typeof ProfileEditSchema>;

const genderOptions = [
  { value: 'male', label: () => tr('profile_complete_genderMale') },
  { value: 'female', label: () => tr('profile_complete_genderFemale') },
  { value: 'other', label: () => tr('profile_complete_genderOther') },
] as const;

interface ProfileEditFormProps {
  user: Auth.CurrentUser;
  onSuccess: () => void;
}

export function ProfileEditForm({ user, onSuccess }: ProfileEditFormProps) {
  const run = useRun();

  const defaultValues: ProfileEditValues = {
    name: Option.getOrElse(user.name, () => ''),
    birthDate: Option.getOrElse(user.birthDate, () => ''),
    gender: Option.getOrElse(user.gender, () => NONE_VALUE),
  };

  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(ProfileEditSchema)),
    mode: 'onChange',
    defaultValues,
  });

  const onSubmit = async (values: ProfileEditValues) => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.auth.updateProfile({
          payload: {
            name: values.name ? Option.some(values.name) : Option.none(),
            birthDate: values.birthDate ? Option.some(values.birthDate) : Option.none(),
            gender: values.gender === NONE_VALUE ? Option.none() : Option.some(values.gender),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('profile_updateFailed'))),
      run({ success: tr('profile_saveSuccess') }),
    );
    if (Option.isSome(result)) {
      onSuccess();
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className='flex flex-col gap-4'>
        <FormField
          {...form.register('name')}
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tr('profile_complete_displayName')}</FormLabel>
              <FormControl>
                <Input placeholder={tr('profile_complete_displayNamePlaceholder')} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          {...form.register('birthDate')}
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tr('profile_complete_birthDate')}</FormLabel>
              <FormControl>
                <DatePicker
                  value={field.value}
                  onChange={field.onChange}
                  placeholder={tr('profile_complete_birthDatePlaceholder')}
                  fromYear={1900}
                  toYear={maxBirthYear}
                  defaultMonth={defaultBirthMonth}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          {...form.register('gender')}
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tr('profile_complete_gender')}</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger className='w-full'>
                    <SelectValue placeholder={tr('profile_complete_genderPlaceholder')} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={NONE_VALUE}>—</SelectItem>
                  {genderOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type='submit' disabled={form.formState.isSubmitting} className='mt-2'>
          {form.formState.isSubmitting ? tr('profile_saving') : tr('profile_saveChanges')}
        </Button>
      </form>
    </Form>
  );
}
