import type { EmailForwardingApi, GroupApi } from '@sideline/domain';
import { Team } from '@sideline/domain';
import { getLocale } from '@sideline/i18n/runtime';
import { DateTime, Effect, Option, Schema } from 'effect';
import { AlertTriangle, Copy, Mail, ShieldCheck } from 'lucide-react';
import React from 'react';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { Alert, AlertDescription } from '~/components/ui/alert';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Separator } from '~/components/ui/separator';
import { Switch } from '~/components/ui/switch';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { useServerUrl } from '~/lib/translation-overrides-context.js';
import { tr } from '~/lib/translations.js';
import {
  type EmailForwardingErrors,
  emailForwardingFormFrom,
  emailForwardingRequestFrom,
  hasEmailForwardingErrors,
  imapSecretPayload,
  validateEmailForwarding,
} from './emailForwardingForm';
import { textChannelOptions as buildTextChannelOptions, NONE_VALUE } from './shared';
import { useCardForm } from './useCardForm';

interface EmailForwardingCardProps {
  teamId: string;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
  initialConfig: EmailForwardingApi.EmailForwardingConfigView | null;
  onRefresh: () => void;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function EmailForwardingCard({
  teamId,
  discordChannels,
  initialConfig,
  onRefresh,
}: EmailForwardingCardProps) {
  const run = useRun();
  const serverUrl = useServerUrl();

  const [config, setConfig] = React.useState<EmailForwardingApi.EmailForwardingConfigView | null>(
    initialConfig,
  );
  // The inbound token is only revealed after regeneration
  const [lastToken, setLastToken] = React.useState<string | null>(null);

  // The nine primitive fields the Save button owns. `monitoredAddresses` and
  // `imapSecret` stay out of the form and are folded into `hasChanges` below —
  // see `emailForwardingForm.ts` for why neither survives a shallow compare.
  const form = useCardForm(emailForwardingFormFrom(config));
  const { setField } = form;
  const {
    enabled,
    coachChannelId,
    targetChannelId,
    imapEnabled,
    imapHost,
    imapPort,
    imapUseTls,
    imapUsername,
    imapFolder,
  } = form.values;

  const [monitoredAddresses, setMonitoredAddresses] = React.useState<string[]>(
    initialConfig ? [...initialConfig.monitoredAddresses] : [],
  );
  const [newSender, setNewSender] = React.useState('');
  const [newSenderError, setNewSenderError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [regenerating, setRegenerating] = React.useState(false);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = React.useState(false);
  const [copiedAddress, setCopiedAddress] = React.useState(false);

  // Write-only password — 3-state: unset, kept, or being replaced.
  const [imapSecret, setImapSecret] = React.useState('');
  const [replacingSecret, setReplacingSecret] = React.useState(false);

  // Per-field, so each error renders next to the input it belongs to.
  const [errors, setErrors] = React.useState<EmailForwardingErrors>({});

  const secretOptions = {
    imapSecretSet: config?.imapSecretSet ?? false,
    replacingSecret,
    imapSecret,
  };

  const initialAddresses = React.useMemo(() => [...(config?.monitoredAddresses ?? [])], [config]);
  const addressesChanged = JSON.stringify(monitoredAddresses) !== JSON.stringify(initialAddresses);
  // A typed secret only counts as a change when it would actually be sent.
  const secretChanged = Option.isSome(imapSecretPayload(secretOptions));

  const hasChanges = form.isDirty || addressesChanged || secretChanged;

  const hasInvalidSender = newSender.trim().length > 0 && !EMAIL_REGEX.test(newSender.trim());

  // Build the inbound webhook URL — only available after regeneration (token is secret)
  const inboundUrl = React.useMemo(() => {
    if (!lastToken) return null;
    const base = serverUrl.replace(/\/$/, '');
    return `${base}/email/inbound/${lastToken}`;
  }, [lastToken, serverUrl]);

  const handleAddSender = () => {
    const trimmed = newSender.trim();
    if (!trimmed) return;
    if (!EMAIL_REGEX.test(trimmed)) {
      setNewSenderError(tr('team_email_forwarding_allowed_senders_invalid'));
      return;
    }
    if (monitoredAddresses.includes(trimmed)) {
      setNewSenderError(tr('team_email_forwarding_allowed_senders_duplicate'));
      return;
    }
    setMonitoredAddresses((prev) => [...prev, trimmed]);
    setNewSender('');
    setNewSenderError(null);
  };

  const handleRemoveSender = (addr: string) => {
    setMonitoredAddresses((prev) => prev.filter((a) => a !== addr));
  };

  const handleCopyAddress = async () => {
    if (!inboundUrl) return;
    await navigator.clipboard.writeText(inboundUrl);
    setCopiedAddress(true);
    setTimeout(() => setCopiedAddress(false), 2000);
  };

  /** Computes errors, renders them, and says whether the save may proceed. */
  const runValidation = (): boolean => {
    const next = validateEmailForwarding(form.values, secretOptions);
    setErrors(next);
    return !hasEmailForwardingErrors(next);
  };

  const handleSave = async () => {
    if (!runValidation()) return;
    setSaving(true);

    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.emailForwarding.upsertEmailForwardingConfig({
          params: { teamId: Schema.decodeSync(Team.TeamId)(teamId) },
          payload: emailForwardingRequestFrom(form.values, {
            monitoredAddresses,
            imapSecret: imapSecretPayload(secretOptions),
          }),
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('team_email_forwarding_save_error'))),
      run({ success: tr('team_email_forwarding_save_success') }),
    );
    setSaving(false);

    if (Option.isSome(result)) {
      const cfg = result.value;
      // Adopt what the server stored, not what was typed: it normalises an
      // empty folder to INBOX, which would otherwise read as dirty for ever.
      setConfig(cfg);
      form.reset(emailForwardingFormFrom(cfg));
      setMonitoredAddresses([...cfg.monitoredAddresses]);
      setImapSecret('');
      setReplacingSecret(false);
      setErrors({});
      onRefresh();
    }
  };

  const handleRegenerate = React.useCallback(async () => {
    setRegenerating(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.emailForwarding.regenerateEmailForwardingToken({
          params: { teamId: Schema.decodeSync(Team.TeamId)(teamId) },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('team_email_forwarding_save_error'))),
      run({}),
    );
    setRegenerating(false);
    setShowRegenerateConfirm(false);
    if (Option.isSome(result)) {
      setLastToken(result.value.inbound_token);
      onRefresh();
    }
  }, [teamId, run, onRefresh]);

  const textChannelOptions = React.useMemo(
    () => buildTextChannelOptions(discordChannels, tr('teamSettings_channelNone')),
    [discordChannels],
  );

  const showChannelsWarning =
    enabled && (coachChannelId === NONE_VALUE || targetChannelId === NONE_VALUE);

  // Derived IMAP validation state for the Save button.
  const imapHasErrors = imapEnabled && hasEmailForwardingErrors(errors);

  // IMAP sync status
  const imapSyncStatus = React.useMemo(() => {
    const lastSynced = config?.imapLastSyncedAt ?? Option.none<DateTime.DateTime>();
    const lastUid = config?.imapLastSeenUid ?? Option.none<number>();
    if (Option.isNone(lastSynced)) {
      return tr('team_email_forwarding_imap_never_synced');
    }
    const syncedMs = DateTime.toEpochMillis(lastSynced.value);
    const diff = Date.now() - Number(syncedMs);
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    const rtf = new Intl.RelativeTimeFormat(getLocale() ?? 'en', { numeric: 'auto' });
    const relativeTime =
      diff < 60000
        ? rtf.format(-seconds, 'second')
        : minutes < 60
          ? rtf.format(-minutes, 'minute')
          : hours < 24
            ? rtf.format(-hours, 'hour')
            : rtf.format(-days, 'day');
    const uidSuffix = Option.isSome(lastUid)
      ? ` (${tr('team_email_forwarding_imap_last_uid', { uid: String(lastUid.value) })})`
      : '';
    return tr('team_email_forwarding_imap_last_synced', { time: relativeTime }) + uidSuffix;
  }, [config?.imapLastSyncedAt, config?.imapLastSeenUid]);

  return (
    <>
      <Card>
        <CardHeader>
          <div className='flex items-center gap-2'>
            <Mail className='size-4 text-muted-foreground' />
            <CardTitle className='text-base'>{tr('team_email_forwarding_title')}</CardTitle>
          </div>
          <CardDescription>{tr('team_email_forwarding_description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className='flex flex-col gap-5'>
            {/* Enable switch */}
            <div className='flex items-start justify-between gap-4'>
              <div>
                <label htmlFor='email-forwarding-enabled' className='text-sm font-medium block'>
                  {tr('team_email_forwarding_enabled_label')}
                </label>
                <p className='text-xs text-muted-foreground mt-1'>
                  {tr('team_email_forwarding_enabled_help')}
                </p>
              </div>
              <Switch
                id='email-forwarding-enabled'
                checked={enabled}
                onCheckedChange={(v) => setField('enabled', v)}
              />
            </div>

            <Separator />

            {/* Ingestion methods */}
            <div className='flex flex-col gap-5'>
              <h4 className='text-sm font-semibold'>
                {tr('team_email_forwarding_ingestion_methods')}
              </h4>

              {/* Webhook (push) */}
              <div className='flex flex-col gap-3'>
                <h4 className='text-sm font-semibold text-muted-foreground'>
                  {tr('team_email_forwarding_webhook_subtitle')}
                </h4>
                <div>
                  <span className='text-sm font-medium mb-1 block'>
                    {tr('team_email_forwarding_inbound_address_label')}
                  </span>
                  <p className='text-xs text-muted-foreground mb-2'>
                    {tr('team_email_forwarding_inbound_address_help')}
                  </p>
                  <div className='flex gap-2 flex-wrap sm:flex-nowrap'>
                    <Input
                      readOnly
                      value={inboundUrl ?? (config ? '(regenerate token to reveal URL)' : '—')}
                      className='font-mono text-xs'
                    />
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={handleCopyAddress}
                      disabled={!inboundUrl}
                    >
                      <Copy className='size-3 mr-1' />
                      {copiedAddress
                        ? tr('team_email_forwarding_copied')
                        : tr('team_email_forwarding_copy')}
                    </Button>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => setShowRegenerateConfirm(true)}
                      disabled={!config}
                    >
                      {tr('team_email_forwarding_regenerate')}
                    </Button>
                  </div>
                </div>
              </div>

              <Separator />

              {/* IMAP mailbox (poll) */}
              <div className='flex flex-col gap-3'>
                <h4 className='text-sm font-semibold text-muted-foreground'>
                  {tr('team_email_forwarding_imap_subtitle')}
                </h4>

                {/* IMAP enable switch */}
                <div className='flex items-start justify-between gap-4'>
                  <div>
                    <label htmlFor='imap-enabled' className='text-sm font-medium block'>
                      {tr('team_email_forwarding_imap_enabled_label')}
                    </label>
                    <p className='text-xs text-muted-foreground mt-1'>
                      {tr('team_email_forwarding_imap_enabled_help')}
                    </p>
                  </div>
                  <Switch
                    id='imap-enabled'
                    checked={imapEnabled}
                    onCheckedChange={(v) => setField('imapEnabled', v)}
                  />
                </div>

                {/* IMAP fieldset — disabled and greyed when IMAP not enabled */}
                <fieldset disabled={!imapEnabled} className={!imapEnabled ? 'opacity-60' : ''}>
                  <div className='flex flex-col gap-4'>
                    {/* Host + Port row */}
                    <div className='grid gap-3 sm:grid-cols-[1fr_auto]'>
                      {/* Host */}
                      <div>
                        <label htmlFor='imap-host' className='text-sm font-medium mb-1 block'>
                          {tr('team_email_forwarding_imap_host_label')}
                        </label>
                        <p className='text-xs text-muted-foreground mb-1'>
                          {tr('team_email_forwarding_imap_host_help')}
                        </p>
                        <Input
                          id='imap-host'
                          value={imapHost}
                          onChange={(e) => {
                            setField('imapHost', e.target.value);
                            setErrors((prev) => ({ ...prev, imapHost: undefined }));
                          }}
                          aria-invalid={errors.imapHost !== null}
                          aria-describedby={errors.imapHost ? 'imap-host-error' : undefined}
                        />
                        {errors.imapHost && (
                          <p id='imap-host-error' className='text-xs text-destructive mt-1'>
                            {errors.imapHost}
                          </p>
                        )}
                      </div>

                      {/* Port */}
                      <div className='max-w-32'>
                        <label htmlFor='imap-port' className='text-sm font-medium mb-1 block'>
                          {tr('team_email_forwarding_imap_port_label')}
                        </label>
                        <p className='text-xs text-muted-foreground mb-1'>&nbsp;</p>
                        <Input
                          id='imap-port'
                          type='number'
                          min={1}
                          max={65535}
                          value={imapPort}
                          onChange={(e) => {
                            setField('imapPort', e.target.value);
                            setErrors((prev) => ({ ...prev, imapPort: undefined }));
                          }}
                          className='max-w-32'
                          aria-invalid={errors.imapPort !== null}
                          aria-describedby={errors.imapPort ? 'imap-port-error' : undefined}
                        />
                        {errors.imapPort && (
                          <p id='imap-port-error' className='text-xs text-destructive mt-1'>
                            {errors.imapPort}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Use TLS switch */}
                    <div className='flex items-start justify-between gap-4'>
                      <div>
                        <label htmlFor='imap-use-tls' className='text-sm font-medium block'>
                          {tr('team_email_forwarding_imap_use_tls_label')}
                        </label>
                        <p className='text-xs text-muted-foreground mt-1'>
                          {tr('team_email_forwarding_imap_use_tls_help')}
                        </p>
                      </div>
                      <Switch
                        id='imap-use-tls'
                        checked={imapUseTls}
                        onCheckedChange={(v) => setField('imapUseTls', v)}
                      />
                    </div>

                    {/* Username */}
                    <div>
                      <label htmlFor='imap-username' className='text-sm font-medium mb-1 block'>
                        {tr('team_email_forwarding_imap_username_label')}
                      </label>
                      <p className='text-xs text-muted-foreground mb-1'>
                        {tr('team_email_forwarding_imap_username_help')}
                      </p>
                      <Input
                        id='imap-username'
                        value={imapUsername}
                        onChange={(e) => {
                          setField('imapUsername', e.target.value);
                          setErrors((prev) => ({ ...prev, imapUsername: undefined }));
                        }}
                        aria-invalid={errors.imapUsername !== null}
                        aria-describedby={errors.imapUsername ? 'imap-username-error' : undefined}
                      />
                      {errors.imapUsername && (
                        <p id='imap-username-error' className='text-xs text-destructive mt-1'>
                          {errors.imapUsername}
                        </p>
                      )}
                    </div>

                    {/* Password — 3 states */}
                    <div aria-live='polite'>
                      <Label htmlFor='imap-secret' className='text-sm font-medium mb-1 block'>
                        {tr('team_email_forwarding_imap_secret_label')}
                      </Label>
                      {/* State B: secret is set and not replacing */}
                      {config?.imapSecretSet && !replacingSecret ? (
                        <div className='flex items-center gap-3 mt-1'>
                          <ShieldCheck className='size-4 text-green-600' />
                          <span className='text-sm text-muted-foreground'>
                            {tr('team_email_forwarding_imap_secret_set')}
                          </span>
                          <Button
                            variant='outline'
                            size='sm'
                            type='button'
                            onClick={() => setReplacingSecret(true)}
                          >
                            {tr('team_email_forwarding_imap_secret_replace')}
                          </Button>
                        </div>
                      ) : (
                        <>
                          <p className='text-xs text-muted-foreground mb-1'>
                            {replacingSecret
                              ? tr('team_email_forwarding_imap_secret_replace_help')
                              : tr('team_email_forwarding_imap_secret_help')}
                          </p>
                          <div className='flex gap-2'>
                            <Input
                              id='imap-secret'
                              type='password'
                              autoComplete='new-password'
                              placeholder={tr('team_email_forwarding_imap_secret_placeholder')}
                              value={imapSecret}
                              onChange={(e) => {
                                setImapSecret(e.target.value);
                                setErrors((prev) => ({ ...prev, imapSecret: undefined }));
                              }}
                              aria-invalid={errors.imapSecret !== null}
                              aria-describedby={errors.imapSecret ? 'imap-secret-error' : undefined}
                            />
                            {/* State C: cancel button */}
                            {replacingSecret && (
                              <Button
                                variant='outline'
                                size='sm'
                                type='button'
                                onClick={() => {
                                  setImapSecret('');
                                  setErrors((prev) => ({ ...prev, imapSecret: undefined }));
                                  setReplacingSecret(false);
                                }}
                              >
                                {tr('team_email_forwarding_imap_secret_cancel')}
                              </Button>
                            )}
                          </div>
                          {errors.imapSecret && (
                            <p id='imap-secret-error' className='text-xs text-destructive mt-1'>
                              {errors.imapSecret}
                            </p>
                          )}
                        </>
                      )}
                    </div>

                    {/* Folder */}
                    <div>
                      <label htmlFor='imap-folder' className='text-sm font-medium mb-1 block'>
                        {tr('team_email_forwarding_imap_folder_label')}
                      </label>
                      <p className='text-xs text-muted-foreground mb-1'>
                        {tr('team_email_forwarding_imap_folder_help')}
                      </p>
                      <Input
                        id='imap-folder'
                        value={imapFolder}
                        placeholder='INBOX'
                        onChange={(e) => setField('imapFolder', e.target.value)}
                      />
                    </div>

                    {/* Sync status row — a polite live region (not role=status) so it
                        doesn't collide with the onboarding card's status output on this page */}
                    <div aria-live='polite' className='text-xs text-muted-foreground'>
                      {imapSyncStatus}
                    </div>
                  </div>
                </fieldset>
              </div>
            </div>

            <Separator />

            {/* Channels warning */}
            {showChannelsWarning && (
              <Alert variant='warning'>
                <AlertTriangle className='size-4' />
                <AlertDescription>{tr('team_email_forwarding_channels_warning')}</AlertDescription>
              </Alert>
            )}

            {/* Fields disabled when not enabled */}
            <fieldset disabled={!enabled} className={!enabled ? 'opacity-60' : ''}>
              <div className='flex flex-col gap-5'>
                {/* Allowed senders */}
                <div>
                  <span className='text-sm font-medium mb-1 block'>
                    {tr('team_email_forwarding_allowed_senders_label')}
                  </span>
                  <p className='text-xs text-muted-foreground mb-2'>
                    {tr('team_email_forwarding_allowed_senders_help')}
                  </p>
                  <div className='flex flex-col gap-2'>
                    {monitoredAddresses.map((addr) => (
                      <div key={addr} className='flex items-center gap-2'>
                        <Input readOnly value={addr} className='text-sm' />
                        <Button
                          variant='outline'
                          size='sm'
                          onClick={() => handleRemoveSender(addr)}
                          type='button'
                        >
                          {tr('team_email_forwarding_allowed_senders_remove')}
                        </Button>
                      </div>
                    ))}
                    <div className='flex items-start gap-2'>
                      <div className='flex-1'>
                        <Input
                          type='email'
                          placeholder='coach@example.com'
                          value={newSender}
                          onChange={(e) => {
                            setNewSender(e.target.value);
                            setNewSenderError(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleAddSender();
                            }
                          }}
                          aria-invalid={newSenderError !== null}
                        />
                        {newSenderError && (
                          <p className='text-xs text-destructive mt-1'>{newSenderError}</p>
                        )}
                      </div>
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={handleAddSender}
                        disabled={!newSender.trim() || hasInvalidSender}
                        type='button'
                      >
                        {tr('team_email_forwarding_allowed_senders_add')}
                      </Button>
                    </div>
                  </div>
                </div>

                <Separator />

                {/* Coach channel */}
                <div>
                  <label
                    htmlFor='email-forwarding-coach-channel'
                    className='text-sm font-medium mb-1 block'
                  >
                    {tr('team_email_forwarding_coach_channel_label')}
                  </label>
                  <p className='text-xs text-muted-foreground mb-2'>
                    {tr('team_email_forwarding_coach_channel_help')}
                  </p>
                  <SearchableSelect
                    id='email-forwarding-coach-channel'
                    value={coachChannelId}
                    onValueChange={(v) => setField('coachChannelId', v)}
                    placeholder={tr('teamSettings_channelNone')}
                    pinnedValues={[NONE_VALUE]}
                    options={textChannelOptions}
                  />
                </div>

                {/* Target channel */}
                <div>
                  <label
                    htmlFor='email-forwarding-target-channel'
                    className='text-sm font-medium mb-1 block'
                  >
                    {tr('team_email_forwarding_target_channel_label')}
                  </label>
                  <p className='text-xs text-muted-foreground mb-2'>
                    {tr('team_email_forwarding_target_channel_help')}
                  </p>
                  <SearchableSelect
                    id='email-forwarding-target-channel'
                    value={targetChannelId}
                    onValueChange={(v) => setField('targetChannelId', v)}
                    placeholder={tr('teamSettings_channelNone')}
                    pinnedValues={[NONE_VALUE]}
                    options={textChannelOptions}
                  />
                </div>
              </div>
            </fieldset>

            <div className='flex items-center gap-3'>
              <Button
                onClick={handleSave}
                disabled={saving || !hasChanges || hasInvalidSender || imapHasErrors}
              >
                {saving ? tr('profile_saving') : tr('profile_saveChanges')}
              </Button>
              {hasChanges && (
                <p className='text-sm text-muted-foreground'>{tr('teamSettings_unsavedChanges')}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Regenerate token confirm dialog */}
      <AlertDialog open={showRegenerateConfirm} onOpenChange={setShowRegenerateConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tr('team_email_forwarding_regenerate_confirm_title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tr('team_email_forwarding_regenerate_confirm_body')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {tr('team_email_forwarding_regenerate_confirm_cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleRegenerate} disabled={regenerating}>
              {tr('team_email_forwarding_regenerate_confirm_action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
