import type { ChannelApi } from '@sideline/domain';
import { Discord, Team } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import React from 'react';
import { toast } from 'sonner';
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
import { ApiClient, ClientError, SilentClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface BulkArchiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string;
  channels: ReadonlyArray<ChannelApi.ChannelInfo>;
  archiveCategoryId: Option.Option<string>;
  onArchived: () => void;
}

export function BulkArchiveDialog({
  open,
  onOpenChange,
  teamId,
  channels,
  archiveCategoryId,
  onArchived,
}: BulkArchiveDialogProps) {
  const run = useRun();
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState(false);
  const [noCategory, setNoCategory] = React.useState(false);

  // Reset no-category override when the dialog opens
  React.useEffect(() => {
    if (open) setNoCategory(false);
  }, [open]);

  const hasArchiveCategory = Option.isSome(archiveCategoryId) && !noCategory;
  const count = channels.length;

  const handleConfirm = async () => {
    const discordChannelIds = channels.flatMap((ch) =>
      Option.isSome(ch.discordChannelId) ? [ch.discordChannelId.value] : [],
    );

    if (discordChannelIds.length === 0) {
      onOpenChange(false);
      return;
    }

    const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
    const snowflakeIds = discordChannelIds.map((id) => Schema.decodeSync(Discord.Snowflake)(id));

    setSubmitting(true);

    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.channel.bulkArchiveDiscordChannels({
          params: { teamId: teamIdBranded },
          payload: { discordChannelIds: snowflakeIds },
        }),
      ),
      // Only ArchiveCategoryNotConfigured (409) switches to the no-category guidance screen.
      // Other errors (e.g. ChannelForbidden) surface as a toast via the normal error path.
      Effect.catchTag('ArchiveCategoryNotConfigured', () => {
        setNoCategory(true);
        setSubmitting(false);
        return Effect.fail(new SilentClientError({ message: '' }));
      }),
      Effect.mapError(() => ClientError.make(tr('channels_bulkArchive_result_allFailed'))),
      run({}),
    );

    setSubmitting(false);

    if (Option.isNone(result)) {
      return;
    }

    const { archived, skipped, failed } = result.value;
    const archivedCount = archived.length;
    const skippedCount = skipped.length + failed.length;

    if (archivedCount > 0 && skippedCount === 0) {
      toast.success(tr('channels_bulkArchive_result_allSuccess', { count: String(archivedCount) }));
    } else if (archivedCount > 0) {
      toast.success(
        tr('channels_bulkArchive_result_mixed', {
          archived: String(archivedCount),
          skipped: String(skippedCount),
        }),
      );
    } else {
      toast.error(tr('channels_bulkArchive_result_allFailed'));
    }

    onOpenChange(false);
    onArchived();
    router.invalidate();
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tr('channels_bulkArchive_title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {hasArchiveCategory
              ? tr('channels_bulkArchive_body', { count: String(count) })
              : tr('channels_archiveNoCategory')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {hasArchiveCategory ? (
            <>
              <AlertDialogCancel disabled={submitting}>{tr('channels_cancel')}</AlertDialogCancel>
              <AlertDialogAction
                variant='destructive'
                onClick={handleConfirm}
                disabled={submitting}
              >
                {submitting
                  ? tr('channels_bulkArchive_inProgress')
                  : tr('channels_bulkArchive_confirm')}
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
