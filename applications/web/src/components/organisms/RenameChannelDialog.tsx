import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { Team, TeamChannel } from '@sideline/domain';
import { useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { useForm } from 'react-hook-form';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
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
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const RenameChannelSchema = Schema.Struct({
  name: Schema.NonEmptyString.annotate({ message: tr('validation_required') }),
});

type RenameChannelValues = Schema.Schema.Type<typeof RenameChannelSchema>;

function normalizeChannelName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

interface RenameChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string;
  teamChannelId: string;
  channelName: string;
}

export function RenameChannelDialog({
  open,
  onOpenChange,
  teamId,
  teamChannelId,
  channelName,
}: RenameChannelDialogProps) {
  const run = useRun();
  const router = useRouter();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const channelIdBranded = Schema.decodeSync(TeamChannel.TeamChannelId)(teamChannelId);

  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(RenameChannelSchema)),
    mode: 'onChange',
    defaultValues: { name: channelName },
  });

  const nameValue = form.watch('name');
  const normalizedName = normalizeChannelName(nameValue);

  const onSubmit = async (values: RenameChannelValues) => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.channel.renameChannel({
          params: { teamId: teamIdBranded, channelId: channelIdBranded },
          payload: { name: values.name },
        }),
      ),
      withFieldErrors(form, [
        {
          tag: 'ChannelNameAlreadyTaken',
          field: 'name',
          message: tr('channels_renameFailed'),
        },
      ]),
      Effect.mapError(() => ClientError.make(tr('channels_renameFailed'))),
      run({ success: tr('channels_renamed') }),
    );
    if (Option.isSome(result)) {
      form.reset({ name: values.name });
      onOpenChange(false);
      router.invalidate();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr('channels_renameCta')}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className='flex flex-col gap-4'>
            <FormField
              {...form.register('name')}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tr('channels_nameLabel')}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={channelName} />
                  </FormControl>
                  {normalizedName && normalizedName !== normalizeChannelName(channelName) && (
                    <FormDescription>
                      {tr('channels_normalizedPreview', { name: normalizedName })}
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
                {tr('channels_cancel')}
              </Button>
              <Button type='submit' disabled={form.formState.isSubmitting}>
                {tr('channels_renameCta')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
