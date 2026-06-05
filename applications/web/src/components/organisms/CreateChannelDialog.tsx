import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { type ChannelApi, Team } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { useForm } from 'react-hook-form';
import { SearchableSelect } from '~/components/atoms/SearchableSelect.js';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '~/components/ui/form';
import { Input } from '~/components/ui/input';
import { withFieldErrors } from '~/lib/form';
import { formatChannelName } from '~/lib/formatChannelName.js';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const DEFAULT_CHANNEL_FORMAT = '{emoji}│{name}';

const CreateChannelSchema = Schema.Struct({
  name: Schema.NonEmptyString.annotate({ message: tr('validation_required') }),
  emoji: Schema.String,
  category: Schema.String,
});

type CreateChannelValues = Schema.Schema.Type<typeof CreateChannelSchema>;

interface CreateChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string;
  existingCategories: ReadonlyArray<string>;
  channelFormat?: string;
  onCreated: (channel: ChannelApi.ChannelDetail) => void;
}

export function CreateChannelDialog({
  open,
  onOpenChange,
  teamId,
  existingCategories,
  channelFormat,
  onCreated,
}: CreateChannelDialogProps) {
  const run = useRun();
  const router = useRouter();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);

  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(CreateChannelSchema)),
    mode: 'onChange',
    defaultValues: { name: '', emoji: '', category: '' },
  });

  const nameValue = form.watch('name');
  const emojiValue = form.watch('emoji');
  const format = channelFormat ?? DEFAULT_CHANNEL_FORMAT;
  const formattedPreview = nameValue ? formatChannelName(format, nameValue, emojiValue) : '';

  const categoryOptions = [
    { value: '', label: tr('channels_categoryNone') },
    ...existingCategories.map((c) => ({ value: c, label: c })),
  ];

  const onSubmit = async (values: CreateChannelValues) => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.channel.createChannel({
          params: { teamId: teamIdBranded },
          payload: {
            name: values.name,
            emoji: values.emoji
              ? Option.some(Schema.decodeSync(Schema.NonEmptyString)(values.emoji))
              : Option.none(),
            category: values.category
              ? Option.some(Schema.decodeSync(Schema.NonEmptyString)(values.category))
              : Option.none(),
          },
        }),
      ),
      withFieldErrors(form, [
        {
          tag: 'ChannelNameAlreadyTaken',
          field: 'name',
          message: tr('channels_createFailed'),
        },
      ]),
      Effect.mapError(() => ClientError.make(tr('channels_createFailed'))),
      run({ success: tr('channels_created') }),
    );
    if (Option.isSome(result)) {
      form.reset();
      onOpenChange(false);
      onCreated(result.value);
      router.invalidate();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr('channels_create')}</DialogTitle>
          <DialogDescription>{tr('channels_privateHint')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className='flex flex-col gap-4'>
            {/* Emoji + Name row */}
            <div className='flex gap-2 items-start'>
              <FormField
                {...form.register('emoji')}
                render={({ field }) => (
                  <FormItem className='shrink-0'>
                    <FormLabel>{tr('channels_emojiLabel')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        className='w-16'
                        placeholder='🏀'
                        aria-label={tr('channels_emojiLabel')}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                {...form.register('name')}
                render={({ field }) => (
                  <FormItem className='flex-1 min-w-0'>
                    <FormLabel>{tr('channels_nameLabel')}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder='e.g. general' />
                    </FormControl>
                    {formattedPreview && (
                      <FormDescription>
                        <span className='block'>
                          {tr('channels_namePreview')}:{' '}
                          <span className='font-mono'>{formattedPreview}</span>
                        </span>
                        <span className='block text-xs mt-1'>
                          {tr('channels_formatHint')}{' '}
                          <Link
                            to='/teams/$teamId/settings'
                            params={{ teamId }}
                            className='underline'
                          >
                            {tr('channels_formatHint_cta')}
                          </Link>
                        </span>
                      </FormDescription>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name='category'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tr('channels_categoryLabel')}</FormLabel>
                  <FormControl>
                    <SearchableSelect
                      options={categoryOptions}
                      value={field.value}
                      onValueChange={field.onChange}
                      placeholder={tr('channels_categoryNone')}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
                {tr('channels_cancel')}
              </Button>
              <Button type='submit' disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? tr('channels_creating') : tr('channels_create')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
