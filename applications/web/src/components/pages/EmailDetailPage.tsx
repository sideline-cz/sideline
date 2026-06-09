import type { EmailForwardingApi } from '@sideline/domain';
import { Team } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { DateTime, Effect, Option, Schema } from 'effect';
import { Download } from 'lucide-react';
import React from 'react';
import { toast } from 'sonner';
import { EmailStatusBadge } from '~/components/molecules/EmailStatusBadge.js';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
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
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Textarea } from '~/components/ui/textarea';
import { useFormatDate } from '~/hooks/useFormatDate.js';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { getToken } from '~/lib/token';
import { useServerUrl } from '~/lib/translation-overrides-context.js';
import { tr } from '~/lib/translations.js';

interface EmailDetailPageProps {
  email: EmailForwardingApi.EmailDetailView;
  teamId: string;
  hasCoachAuthority: boolean;
}

export function EmailDetailPage({
  email: initialEmail,
  teamId,
  hasCoachAuthority,
}: EmailDetailPageProps) {
  const run = useRun();
  const router = useRouter();
  const { formatDateTime } = useFormatDate();
  const serverUrl = useServerUrl();

  const [email, setEmail] = React.useState(initialEmail);
  const [shortSummaryText, setShortSummaryText] = React.useState(
    Option.getOrElse(email.shortSummary, () => ''),
  );
  const [detailedSummaryText, setDetailedSummaryText] = React.useState(
    Option.getOrElse(email.summary, () => ''),
  );
  const [savingSummary, setSavingSummary] = React.useState(false);
  const [approving, setApproving] = React.useState(false);
  const [sendingOriginal, setSendingOriginal] = React.useState(false);
  const [rejecting, setRejecting] = React.useState(false);
  const [showRejectConfirm, setShowRejectConfirm] = React.useState(false);

  const isPending = email.status === 'pending_approval';
  const canAct = isPending && hasCoachAuthority;

  const initialShortSummary = Option.getOrElse(email.shortSummary, () => '');
  const initialDetailedSummary = Option.getOrElse(email.summary, () => '');
  const shortChanged = shortSummaryText !== initialShortSummary;
  const detailedChanged = detailedSummaryText !== initialDetailedSummary;
  const summaryChanged = shortChanged || detailedChanged;

  const shortSummaryEmpty = !shortSummaryText.trim();

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const emailIdBranded = email.emailId;

  // Build authenticated attachment download URL (relative to server base)
  const buildAttachmentUrl = React.useCallback(
    (attachmentId: string) => {
      const base = serverUrl.replace(/\/$/, '');
      return `${base}/teams/${teamId}/emails/${email.emailId}/attachments/${attachmentId}`;
    },
    [serverUrl, teamId, email.emailId],
  );

  const handleSaveSummary = React.useCallback(async () => {
    setSavingSummary(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.emailForwarding.updateEmailSummary({
          params: { teamId: teamIdBranded, emailId: emailIdBranded },
          payload: { summary: detailedSummaryText, short_summary: shortSummaryText },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('email_detail_save_summary_error'))),
      run({ success: tr('email_detail_save_summary_success') }),
    );
    setSavingSummary(false);
    if (Option.isSome(result)) {
      setEmail(result.value);
    }
  }, [teamIdBranded, emailIdBranded, detailedSummaryText, shortSummaryText, run]);

  const handleApprove = React.useCallback(async () => {
    setApproving(true);

    // Flush pending summary changes first
    if (summaryChanged && !shortSummaryEmpty) {
      const saveResult = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.emailForwarding.updateEmailSummary({
            params: { teamId: teamIdBranded, emailId: emailIdBranded },
            payload: { summary: detailedSummaryText, short_summary: shortSummaryText },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('email_detail_save_summary_error'))),
        run({}),
      );
      if (Option.isNone(saveResult)) {
        setApproving(false);
        return;
      }
    }

    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.emailForwarding.approveEmail({
          params: { teamId: teamIdBranded, emailId: emailIdBranded },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('email_detail_approve_error'))),
      run({ success: tr('email_detail_approve_success') }),
    );
    setApproving(false);
    if (Option.isSome(result)) {
      if (result.value.outcome === 'already_handled') {
        // Reload to show current state
        router.invalidate();
      } else {
        router.invalidate();
      }
    }
  }, [
    teamIdBranded,
    emailIdBranded,
    detailedSummaryText,
    shortSummaryText,
    summaryChanged,
    shortSummaryEmpty,
    run,
    router,
  ]);

  const handleSendOriginal = React.useCallback(async () => {
    setSendingOriginal(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.emailForwarding.sendOriginalEmail({
          params: { teamId: teamIdBranded, emailId: emailIdBranded },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('email_detail_send_original_error'))),
      run({ success: tr('email_detail_send_original_success') }),
    );
    setSendingOriginal(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [teamIdBranded, emailIdBranded, run, router]);

  const handleReject = React.useCallback(async () => {
    setRejecting(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.emailForwarding.rejectEmail({
          params: { teamId: teamIdBranded, emailId: emailIdBranded },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('email_detail_reject_error'))),
      run({ success: tr('email_detail_reject_success') }),
    );
    setRejecting(false);
    setShowRejectConfirm(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [teamIdBranded, emailIdBranded, run, router]);

  const handleDownloadAttachment = React.useCallback(
    async (attachmentId: string, filename: string) => {
      const url = buildAttachmentUrl(attachmentId);
      const result = await getToken.pipe(
        Effect.flatMap((tokenOpt) => {
          const headers: Record<string, string> = {};
          if (Option.isSome(tokenOpt)) {
            headers.Authorization = `Bearer ${tokenOpt.value}`;
          }
          return Effect.tryPromise({
            try: () => fetch(url, { headers }),
            catch: () => ClientError.make(tr('email_detail_attachment_download_error')),
          });
        }),
        Effect.flatMap((response) => {
          if (!response.ok) {
            return Effect.fail(ClientError.make(tr('email_detail_attachment_download_error')));
          }
          return Effect.tryPromise({
            try: () => response.blob(),
            catch: () => ClientError.make(tr('email_detail_attachment_download_error')),
          });
        }),
        Effect.flatMap((blob) =>
          Effect.sync(() => {
            const objectUrl = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = filename;
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            URL.revokeObjectURL(objectUrl);
          }),
        ),
        run({}),
      );
      if (Option.isNone(result)) {
        toast.error(tr('email_detail_attachment_download_error'));
      }
    },
    [buildAttachmentUrl, run],
  );

  const receivedDate = new Date(Number(DateTime.toEpochMillis(email.receivedAt)));

  const terminalResultBanner = (() => {
    if (email.status === 'approved') {
      return (
        <Alert variant='default' className='border-blue-500 text-blue-700 bg-blue-50'>
          <AlertDescription>{tr('email_detail_result_approved')}</AlertDescription>
        </Alert>
      );
    }
    if (email.status === 'send_original') {
      return (
        <Alert variant='default' className='border-blue-500 text-blue-700 bg-blue-50'>
          <AlertDescription>{tr('email_detail_result_send_original')}</AlertDescription>
        </Alert>
      );
    }
    if (email.status === 'rejected') {
      return (
        <Alert variant='default'>
          <AlertDescription>{tr('email_detail_result_rejected')}</AlertDescription>
        </Alert>
      );
    }
    if (email.status === 'posted_summary') {
      return (
        <Alert variant='default' className='border-success text-success-foreground bg-success/10'>
          <AlertDescription>{tr('email_detail_result_posted_summary')}</AlertDescription>
        </Alert>
      );
    }
    if (email.status === 'posted_original') {
      return (
        <Alert variant='default' className='border-success text-success-foreground bg-success/10'>
          <AlertDescription>{tr('email_detail_result_posted_original')}</AlertDescription>
        </Alert>
      );
    }
    if (email.status === 'failed') {
      return (
        <Alert variant='destructive'>
          <AlertDescription>{tr('email_detail_result_failed')}</AlertDescription>
        </Alert>
      );
    }
    return null;
  })();

  return (
    <div className='max-w-3xl mx-auto px-4 py-6 flex flex-col gap-6'>
      {/* Header card */}
      <Card>
        <CardHeader>
          <div className='flex items-start justify-between gap-3 flex-wrap'>
            <CardTitle className='text-xl break-words'>{email.subject}</CardTitle>
            <EmailStatusBadge status={email.status} />
          </div>
          <div className='flex flex-col gap-1 text-sm text-muted-foreground mt-2'>
            <div>
              <span className='font-medium text-foreground'>{tr('email_detail_from_label')}: </span>
              {email.fromAddress}
            </div>
            <div>
              <span className='font-medium text-foreground'>
                {tr('email_detail_received_label')}:{' '}
              </span>
              {formatDateTime(receivedDate)}
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Terminal result banner */}
      {terminalResultBanner}

      {/* Original email body */}
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>{tr('email_detail_original_heading')}</CardTitle>
          <p className='text-xs text-muted-foreground'>{tr('email_detail_original_hint')}</p>
        </CardHeader>
        <CardContent>
          <pre className='whitespace-pre-wrap break-words text-sm font-sans'>{email.body}</pre>
        </CardContent>
      </Card>

      {/* Attachments */}
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>{tr('email_detail_attachments_heading')}</CardTitle>
        </CardHeader>
        <CardContent>
          {email.attachments.length === 0 ? (
            <p className='text-sm text-muted-foreground'>{tr('email_detail_attachments_empty')}</p>
          ) : (
            <div className='flex flex-col gap-2'>
              {email.attachments.map((att) => (
                <div
                  key={att.attachmentId}
                  className='flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2'
                >
                  <div className='flex flex-col min-w-0'>
                    <span className='text-sm font-medium truncate'>{att.filename}</span>
                    <span className='text-xs text-muted-foreground'>
                      {att.contentType} &middot; {formatBytes(att.sizeBytes)}
                    </span>
                  </div>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={() => handleDownloadAttachment(att.attachmentId, att.filename)}
                  >
                    <Download className='size-3 mr-1' />
                    {tr('email_detail_attachments_download')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* SHORT Summary card */}
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>{tr('email_detail_short_heading')}</CardTitle>
          <p className='text-xs text-muted-foreground'>{tr('email_detail_short_hint')}</p>
        </CardHeader>
        <CardContent>
          {canAct ? (
            <div className='flex flex-col gap-2'>
              <Textarea
                rows={6}
                value={shortSummaryText}
                onChange={(e) => setShortSummaryText(e.target.value)}
                placeholder={tr('email_detail_short_placeholder')}
                maxLength={2000}
              />
              <div className='flex items-center justify-between'>
                {shortSummaryEmpty ? (
                  <p className='text-xs text-destructive'>{tr('email_detail_short_required')}</p>
                ) : (
                  <span />
                )}
                <p className='text-xs text-muted-foreground text-right'>
                  {shortSummaryText.length}/2000
                </p>
              </div>
            </div>
          ) : (
            <p className='text-sm whitespace-pre-wrap break-words'>
              {Option.getOrElse(email.shortSummary, () => '—')}
            </p>
          )}
        </CardContent>
      </Card>

      {/* DETAILED Summary card */}
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>{tr('email_detail_detailed_heading')}</CardTitle>
          <p className='text-xs text-muted-foreground'>{tr('email_detail_detailed_hint')}</p>
        </CardHeader>
        <CardContent>
          {canAct ? (
            <div className='flex flex-col gap-2'>
              <Textarea
                rows={12}
                value={detailedSummaryText}
                onChange={(e) => setDetailedSummaryText(e.target.value)}
                placeholder={tr('email_detail_detailed_placeholder')}
                maxLength={8000}
              />
              <p className='text-xs text-muted-foreground text-right'>
                {detailedSummaryText.length}/8000
              </p>
            </div>
          ) : (
            <p className='text-sm whitespace-pre-wrap break-words'>
              {Option.getOrElse(email.summary, () => '—')}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Actions (coach + pending only) */}
      {canAct && (
        <div className='flex flex-wrap gap-3'>
          <Button
            variant='outline'
            onClick={handleSaveSummary}
            disabled={savingSummary || !summaryChanged}
          >
            {savingSummary ? tr('profile_saving') : tr('email_detail_save_summary')}
          </Button>
          <Button
            onClick={handleApprove}
            disabled={approving || sendingOriginal || rejecting || shortSummaryEmpty}
          >
            {approving ? tr('profile_saving') : tr('email_detail_approve')}
          </Button>
          <Button
            variant='outline'
            onClick={handleSendOriginal}
            disabled={approving || sendingOriginal || rejecting}
          >
            {sendingOriginal ? tr('profile_saving') : tr('email_detail_send_original')}
          </Button>
          <Button
            variant='destructive'
            onClick={() => setShowRejectConfirm(true)}
            disabled={approving || sendingOriginal || rejecting}
          >
            {tr('email_detail_reject')}
          </Button>
        </div>
      )}

      {/* Reject confirm dialog */}
      <AlertDialog open={showRejectConfirm} onOpenChange={setShowRejectConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr('email_detail_reject_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tr('email_detail_reject_confirm_body')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('email_detail_reject_confirm_cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleReject} disabled={rejecting}>
              {tr('email_detail_reject_confirm_action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface EmailDetailNotFoundProps {
  teamId: string;
}

export function EmailDetailNotFound({ teamId }: EmailDetailNotFoundProps) {
  return (
    <div className='max-w-3xl mx-auto px-4 py-6'>
      <Alert variant='destructive'>
        <AlertTitle>{tr('email_detail_not_found_title')}</AlertTitle>
        <AlertDescription>{tr('email_detail_not_found_body')}</AlertDescription>
      </Alert>
      <div className='mt-4'>
        <Button asChild variant='outline'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            {tr('email_detail_not_found_back')}
          </Link>
        </Button>
      </div>
    </div>
  );
}
