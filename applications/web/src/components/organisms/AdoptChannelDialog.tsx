import type { ChannelApi } from '@sideline/domain';
import { Discord, Team } from '@sideline/domain';
import { useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { AlertTriangle } from 'lucide-react';
import React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface AdoptChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string;
  channel: ChannelApi.ChannelInfo;
  onAdopted: (detail: ChannelApi.ChannelDetail) => void;
}

export function AdoptChannelDialog({
  open,
  onOpenChange,
  teamId,
  channel,
  onAdopted,
}: AdoptChannelDialogProps) {
  const run = useRun();
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState(false);

  const handleConfirm = async () => {
    if (Option.isNone(channel.discordChannelId)) return;

    const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
    const discordChIdBranded = Schema.decodeSync(Discord.Snowflake)(channel.discordChannelId.value);

    setSubmitting(true);

    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.channel.adoptDiscordChannel({
          params: { teamId: teamIdBranded, discordChannelId: discordChIdBranded },
        }),
      ),
      Effect.catchTag('ChannelAdoptionNameConflict', () =>
        Effect.fail(ClientError.make(tr('channels_adopt_nameConflict'))),
      ),
      Effect.catchTag('ChannelNotAdoptable', () =>
        Effect.fail(ClientError.make(tr('channels_adopt_failed'))),
      ),
      Effect.mapError(() => ClientError.make(tr('channels_adopt_failed'))),
      run({}),
    );

    setSubmitting(false);

    if (Option.isSome(result)) {
      const detail = result.value;
      onOpenChange(false);
      router.invalidate();
      onAdopted(detail);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tr('channels_adopt_title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {tr('channels_adopt_body', { name: channel.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className='flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm dark:border-yellow-800 dark:bg-yellow-950'>
          <AlertTriangle
            aria-hidden='true'
            className='mt-0.5 size-4 shrink-0 text-yellow-600 dark:text-yellow-400'
          />
          <span>{tr('channels_adopt_warning')}</span>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel autoFocus disabled={submitting}>
            {tr('channels_cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            className='bg-destructive text-white hover:bg-destructive/90'
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting ? tr('channels_adopt_inProgress') : tr('channels_adopt_confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
