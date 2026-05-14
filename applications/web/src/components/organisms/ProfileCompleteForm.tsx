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

const ProfileFormSchema = Schema.Struct({
  name: Schema.NonEmptyString.annotate({ message: tr('validation_required') }),
  birthDate: Schema.NonEmptyString.annotate({ message: tr('validation_required') }).pipe(
    Schema.check(
      Schema.makeFilter((s: string) => {
        const d = new Date(s);
        if (Number.isNaN(d.getTime())) return tr('validation_required');
        const minDate = new Date();
        minDate.setFullYear(minDate.getFullYear() - Auth.MIN_AGE);
        if (d > minDate) return tr('validation_minAge', { minAge: Auth.MIN_AGE });
        return true;
      }),
    ),
  ),
  gender: Schema.Literals(['male', 'female', 'other']).annotate({
    message: tr('validation_invalidOption'),
  }),
});

type ProfileFormValues = Schema.Schema.Type<typeof ProfileFormSchema>;

const genderOptions = [
  { value: 'male', label: () => tr('profile_complete_genderMale') },
  { value: 'female', label: () => tr('profile_complete_genderFemale') },
  { value: 'other', label: () => tr('profile_complete_genderOther') },
] as const;

interface ProfileCompleteFormProps {
  initialName: string;
  onSuccess: () => void;
}

export function ProfileCompleteForm({ initialName, onSuccess }: ProfileCompleteFormProps) {
  const run = useRun();

  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(ProfileFormSchema)),
    mode: 'onChange',
    defaultValues: {
      name: initialName,
      birthDate: '',
    },
  });

  const onSubmit = async (values: ProfileFormValues) => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.auth.completeProfile({
          payload: values,
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('profile_complete_saveFailed'))),
      run({ success: tr('profile_profileCompleted') }),
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
          {form.formState.isSubmitting
            ? tr('profile_complete_saving')
            : tr('profile_complete_submit')}
        </Button>
      </form>
    </Form>
  );
}
