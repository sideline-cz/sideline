import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { Discord, type OnboardingApi, type TeamOnboardingToken } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { DateTime, Effect, Option, Schema } from 'effect';
import { ArrowLeft, Copy, Link2 } from 'lucide-react';
import React from 'react';
import { useForm } from 'react-hook-form';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
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
import { Label } from '~/components/ui/label';
import { useFormatDate } from '~/hooks/useFormatDate';
import { copyToClipboard } from '~/lib/clipboard';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

// ─── Form schema ─────────────────────────────────────────────────────────────

const CreateTokenFormSchema = Schema.Struct({
  proposedName: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(100)),
  ),
  boundDiscordId: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>(
        (v) => /^\d{17,20}$/.test(v) || tr('admin_onboarding_validation_discordIdInvalid'),
      ),
    ),
  ),
  ttl: Schema.Literals(['24h', '72h', '7d']),
});
type CreateTokenFormValues = Schema.Schema.Type<typeof CreateTokenFormSchema>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusVariant(
  status: OnboardingApi.OnboardingTokenStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'active':
      return 'default';
    case 'consumed':
      return 'secondary';
    case 'expired':
      return 'outline';
    case 'revoked':
      return 'destructive';
  }
}

function statusLabel(status: OnboardingApi.OnboardingTokenStatus): string {
  switch (status) {
    case 'active':
      return tr('admin_onboarding_status_active');
    case 'consumed':
      return tr('admin_onboarding_status_consumed');
    case 'expired':
      return tr('admin_onboarding_status_expired');
    case 'revoked':
      return tr('admin_onboarding_status_revoked');
  }
}

// ─── Minted link dialog ───────────────────────────────────────────────────────

interface MintedLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
  proposedName: string;
  discordId: string;
}

export function MintedLinkDialog({
  open,
  onOpenChange,
  url,
  proposedName,
  discordId,
}: MintedLinkDialogProps) {
  const [copied, setCopied] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyRequestIdRef = React.useRef(0);

  const handleCopy = React.useCallback(() => {
    const requestId = ++copyRequestIdRef.current;
    copyToClipboard(url).then((ok) => {
      if (!ok || requestId !== copyRequestIdRef.current) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [url]);

  React.useEffect(() => {
    if (!open) {
      copyRequestIdRef.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
      setCopied(false);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {tr('admin_onboarding_mintSuccessTitle', { teamName: proposedName })}
          </DialogTitle>
          <p className='text-sm text-muted-foreground'>
            {tr('admin_onboarding_mintSuccessDescription', { discordId })}
          </p>
        </DialogHeader>
        <div className='space-y-3'>
          <p className='text-sm font-medium text-amber-600 dark:text-amber-400'>
            {tr('admin_onboarding_oneTimeWarning')}
          </p>
          <div className='flex items-center gap-2'>
            <Input value={url} readOnly className='flex-1 font-mono text-xs' />
            <Button
              type='button'
              variant='outline'
              size='icon'
              onClick={handleCopy}
              title={tr('admin_onboarding_copyLink')}
            >
              <Copy className='size-4' />
              <span className='sr-only'>{tr('admin_onboarding_copyLink')}</span>
            </Button>
          </div>
          {copied && (
            <p className='text-xs text-green-600 dark:text-green-400'>
              {tr('admin_onboarding_copied')}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            {tr('admin_onboarding_done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

interface AdminOnboardingTokensPageProps {
  tokens: ReadonlyArray<OnboardingApi.OnboardingTokenListItem>;
}

export function AdminOnboardingTokensPage({ tokens }: AdminOnboardingTokensPageProps) {
  const run = useRun();
  const router = useRouter();
  const { formatDateTime } = useFormatDate();

  const [mintedUrl, setMintedUrl] = React.useState<string | null>(null);
  const [mintedProposedName, setMintedProposedName] = React.useState('');
  const [mintedDiscordId, setMintedDiscordId] = React.useState('');
  const [mintDialogOpen, setMintDialogOpen] = React.useState(false);

  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(CreateTokenFormSchema)),
    mode: 'onChange',
    defaultValues: {
      proposedName: '',
      boundDiscordId: '',
      ttl: '7d' as const,
    },
  });

  const onSubmit = React.useCallback(
    async (values: CreateTokenFormValues) => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.onboarding.mintOnboardingToken({
            payload: {
              proposedName: values.proposedName,
              boundDiscordId: Schema.decodeSync(Discord.Snowflake)(values.boundDiscordId),
              ttl: values.ttl,
            },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('admin_onboarding_mintFailed'))),
        run(),
      );
      if (Option.isSome(result)) {
        setMintedUrl(result.value.onboardingUrl);
        setMintedProposedName(values.proposedName);
        setMintedDiscordId(values.boundDiscordId);
        setMintDialogOpen(true);
        form.reset({ proposedName: '', boundDiscordId: '', ttl: '7d' });
        await router.invalidate();
      }
    },
    [run, router, form],
  );

  const handleRevoke = React.useCallback(
    async (tokenId: TeamOnboardingToken.TeamOnboardingTokenId) => {
      if (!window.confirm(tr('admin_onboarding_revokeConfirm'))) return;
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) => api.onboarding.revokeOnboardingToken({ params: { tokenId } })),
        Effect.mapError(() => ClientError.make(tr('admin_onboarding_revokeFailed'))),
        run({ success: tr('admin_onboarding_revoked') }),
      );
      if (Option.isSome(result)) {
        await router.invalidate();
      }
    },
    [run, router],
  );

  const handleMintDialogClose = React.useCallback((open: boolean) => {
    setMintDialogOpen(open);
    if (!open) {
      setMintedUrl(null);
      setMintedProposedName('');
      setMintedDiscordId('');
    }
  }, []);

  return (
    <div className='container mx-auto py-8 max-w-3xl space-y-8'>
      <div className='space-y-3'>
        <Link
          to='/'
          className='inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors'
        >
          <ArrowLeft className='size-4' />
          {tr('common_backToDashboard')}
        </Link>
        <div>
          <h1 className='text-2xl font-bold'>{tr('admin_onboarding_pageTitle')}</h1>
          <p className='text-muted-foreground'>{tr('admin_onboarding_pageDescription')}</p>
        </div>
      </div>

      {/* Create form */}
      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2'>
            <Link2 className='size-5' />
            {tr('admin_onboarding_createTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className='space-y-4'>
              <FormField
                {...form.register('proposedName')}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tr('admin_onboarding_proposedNameLabel')}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder='FC Sidewinders' />
                    </FormControl>
                    <FormDescription>{tr('admin_onboarding_proposedNameHelp')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                {...form.register('boundDiscordId')}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tr('admin_onboarding_boundDiscordIdLabel')}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder='123456789012345678' />
                    </FormControl>
                    <FormDescription>{tr('admin_onboarding_boundDiscordIdHelp')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                {...form.register('ttl')}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tr('admin_onboarding_ttlLabel')}</FormLabel>
                    <FormControl>
                      <div className='flex gap-4'>
                        {(['24h', '72h', '7d'] as const).map((val) => (
                          <Label key={val} className='flex items-center gap-2 cursor-pointer'>
                            <input
                              type='radio'
                              value={val}
                              checked={field.value === val}
                              onChange={() => field.onChange(val)}
                            />
                            {val === '24h'
                              ? tr('admin_onboarding_ttl_24h')
                              : val === '72h'
                                ? tr('admin_onboarding_ttl_72h')
                                : tr('admin_onboarding_ttl_7d')}
                          </Label>
                        ))}
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button type='submit' disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting
                  ? tr('admin_onboarding_minting')
                  : tr('admin_onboarding_submit')}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      {/* Token list */}
      <Card>
        <CardHeader>
          <CardTitle>{tr('admin_onboarding_listTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {tokens.length === 0 ? (
            <p className='text-sm text-muted-foreground'>{tr('admin_onboarding_listEmpty')}</p>
          ) : (
            <div className='space-y-3'>
              {tokens.map((token) => (
                <div
                  key={token.id}
                  className='flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border p-3'
                >
                  <div className='space-y-1 min-w-0'>
                    <div className='font-medium truncate'>{token.proposedName}</div>
                    <div className='text-xs text-muted-foreground'>
                      {tr('admin_onboarding_boundDiscordIdShort')}: {token.boundDiscordId}
                    </div>
                    <div className='text-xs text-muted-foreground'>
                      {tr('admin_onboarding_col_created')}:{' '}
                      {formatDateTime(DateTime.toDate(token.createdAt))}
                    </div>
                    <div className='text-xs text-muted-foreground'>
                      {tr('admin_onboarding_expiresAt')}:{' '}
                      {formatDateTime(DateTime.toDate(token.expiresAt))}
                    </div>
                    {token.status === 'consumed' && Option.isSome(token.resultingTeamId) && (
                      <div className='text-xs'>
                        <a
                          href={`/teams/${token.resultingTeamId.value}`}
                          className='text-primary underline'
                        >
                          {tr('admin_onboarding_viewTeam')}
                        </a>
                      </div>
                    )}
                  </div>
                  <div className='flex items-center gap-2'>
                    <Badge variant={statusVariant(token.status)}>{statusLabel(token.status)}</Badge>
                    {token.status === 'active' && (
                      <Button
                        variant='destructive'
                        size='sm'
                        onClick={() => handleRevoke(token.id)}
                      >
                        {tr('admin_onboarding_revoke')}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <MintedLinkDialog
        open={mintDialogOpen}
        onOpenChange={handleMintDialogClose}
        url={mintedUrl ?? ''}
        proposedName={mintedProposedName}
        discordId={mintedDiscordId}
      />
    </div>
  );
}
