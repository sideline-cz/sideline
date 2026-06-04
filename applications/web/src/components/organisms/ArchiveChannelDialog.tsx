import { Discord, Team, TeamChannel } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
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
import { Button } from '~/components/ui/button';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface ArchiveChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string;
  channelName: string;
  teamChannelId: Option.Option<string>;
  discordChannelId: Option.Option<string>;
  managed: boolean;
  archiveCategoryId: Option.Option<string>;
}

export function ArchiveChannelDialog({
  open,
  onOpenChange,
  teamId,
  channelName,
  teamChannelId,
  discordChannelId,
  managed,
  archiveCategoryId,
}: ArchiveChannelDialogProps) {
  const run = useRun();
  const router = useRouter();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const [submitting, setSubmitting] = React.useState(false);

  const hasArchiveCategory = Option.isSome(archiveCategoryId);

  const handleConfirm = async () => {
    setSubmitting(true);

    if (managed && Option.isSome(teamChannelId)) {
      const channelIdBranded = Schema.decodeSync(TeamChannel.TeamChannelId)(teamChannelId.value);
      await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.channel.archiveChannel({
            params: { teamId: teamIdBranded, channelId: channelIdBranded },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('channels_archiveFailed'))),
        run({ success: tr('channels_archived') }),
      );
    } else if (Option.isSome(discordChannelId)) {
      const discordChIdBranded = Schema.decodeSync(Discord.Snowflake)(discordChannelId.value);
      await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.channel.archiveDiscordChannel({
            params: { teamId: teamIdBranded, discordChannelId: discordChIdBranded },
          }),
        ),
        Effect.catchTag('ArchiveCategoryNotConfigured', () =>
          Effect.fail(ClientError.make(tr('channels_archiveFailed'))),
        ),
        Effect.catchTag('ChannelNotArchivable', () =>
          Effect.fail(ClientError.make(tr('channels_archiveFailed'))),
        ),
        Effect.mapError(() => ClientError.make(tr('channels_archiveFailed'))),
        run({ success: tr('channels_archived') }),
      );
    }

    setSubmitting(false);
    onOpenChange(false);
    router.invalidate();
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tr('channels_archive_title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {hasArchiveCategory
              ? tr('channels_archive_body', { name: channelName })
              : tr('channels_archiveNoCategory')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {hasArchiveCategory ? (
            <>
              <AlertDialogCancel disabled={submitting}>{tr('channels_cancel')}</AlertDialogCancel>
              <AlertDialogAction
                className='bg-destructive text-white hover:bg-destructive/90'
                onClick={handleConfirm}
                disabled={submitting}
              >
                {tr('channels_archive_confirm')}
              </AlertDialogAction>
            </>
          ) : (
            <>
              <AlertDialogCancel>{tr('channels_cancel')}</AlertDialogCancel>
              <Button asChild>
                <Link to='/teams/$teamId/settings' params={{ teamId }}>
                  {tr('channels_archiveNoCategory_cta')}
                </Link>
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
