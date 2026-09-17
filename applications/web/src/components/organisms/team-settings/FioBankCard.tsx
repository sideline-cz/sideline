import type { BankSyncApi } from '@sideline/domain';
import { CzIban, Team } from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import { AlertTriangle, ChevronRight, Landmark } from 'lucide-react';
import React from 'react';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { DatePicker } from '~/components/ui/date-picker';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Separator } from '~/components/ui/separator';
import { Switch } from '~/components/ui/switch';
import { dateOnlyToUtcNoon } from '~/lib/datetime.js';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';
import { BackfillDialog } from '../bank/BackfillDialog';
import { FioStatusBlock } from '../bank/FioStatusBlock';
import {
  FIO_BANK_CODE,
  fioBankFormFrom,
  fioBankRequestFrom,
  fioTokenPayload,
  hasFioBankErrors,
  validateFioBankForm,
} from './fioBankForm';
import { useCardForm } from './useCardForm';

interface FioBankCardProps {
  teamId: string;
  initialConfig: BankSyncApi.BankSyncConfigView | null;
  onRefresh: () => void;
}

function todayIsoDate(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const currentYear = new Date().getFullYear();

export function FioBankCard({ teamId, initialConfig, onRefresh }: FioBankCardProps) {
  const run = useRun();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);

  const [config, setConfig] = React.useState(initialConfig);
  const form = useCardForm(fioBankFormFrom(config));
  const { setField } = form;
  const {
    enabled,
    autoMatchEnabled,
    accountPrefix,
    accountNumber,
    recipientName,
    registeredId,
    registeredAddress,
  } = form.values;

  const [fioToken, setFioToken] = React.useState('');
  const [replacingToken, setReplacingToken] = React.useState(false);
  const [tokenCreatedAt, setTokenCreatedAt] = React.useState(todayIsoDate());
  const [errors, setErrors] = React.useState<ReturnType<typeof validateFioBankForm>>({});
  const [saving, setSaving] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(
    config === null || config.status === 'not_connected' || config.status === 'invalid',
  );
  const [docsOpen, setDocsOpen] = React.useState(false);
  const [backfillOpen, setBackfillOpen] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const tokenInputRef = React.useRef<HTMLInputElement>(null);

  const tokenOptions = { fioTokenSet: config?.fioTokenSet ?? false, replacingToken, fioToken };
  const tokenChanged = Option.isSome(fioTokenPayload(tokenOptions));
  const hasChanges = form.isDirty || tokenChanged;

  const runValidation = (): boolean => {
    const next = validateFioBankForm(form.values, tokenOptions);
    setErrors(next);
    return !hasFioBankErrors(next);
  };

  const refetchConfig = React.useCallback(async () => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.bankSync.getBankSyncConfig({ params: { teamId: teamIdBranded } }),
      ),
      Effect.mapError(() => ClientError.make(tr('fio_save_error'))),
      run({}),
    );
    if (Option.isSome(result)) {
      setConfig(result.value);
    }
    return result;
  }, [teamIdBranded, run]);

  const handleReplaceToken = () => {
    setReplacingToken(true);
    requestAnimationFrame(() => tokenInputRef.current?.focus());
  };

  const handleSave = async () => {
    if (!runValidation()) return;
    setSaving(true);

    const fioTokenOption = fioTokenPayload(tokenOptions);
    const request: BankSyncApi.UpsertBankSyncConfigRequest = {
      fio_token: Option.none(),
      ...fioBankRequestFrom(
        { ...form.values, bankCode: FIO_BANK_CODE },
        { fioToken: fioTokenOption },
      ),
      fio_token_created_at: Option.isSome(fioTokenOption)
        ? Option.some(dateOnlyToUtcNoon(tokenCreatedAt))
        : Option.none(),
    };

    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.bankSync.upsertBankSyncConfig({ params: { teamId: teamIdBranded }, payload: request }),
      ),
      Effect.mapError(() => ClientError.make(tr('fio_save_error'))),
      run({ success: tr('fio_save_success') }),
    );
    setSaving(false);

    if (Option.isSome(result)) {
      const cfg = result.value;
      setConfig(cfg);
      form.reset(fioBankFormFrom(cfg));
      setFioToken('');
      setReplacingToken(false);
      setTokenCreatedAt(todayIsoDate());
      setErrors({});
      onRefresh();
    }
  };

  const handleRetryNow = React.useCallback(async () => {
    setRetrying(true);
    await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.bankSync.testBankSyncConfig({ params: { teamId: teamIdBranded } }),
      ),
      Effect.mapError(() => ClientError.make(tr('fio_save_error'))),
      run({}),
    );
    await refetchConfig();
    setRetrying(false);
  }, [teamIdBranded, run, refetchConfig]);

  const handleStartBackfill = React.useCallback(
    async (from: string, to: string) => {
      setStarting(true);
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.bankSync.startBankSyncBackfill({
            params: { teamId: teamIdBranded },
            payload: { from, to },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('fio_save_error'))),
        run({}),
      );
      setStarting(false);
      if (Option.isSome(result)) {
        await refetchConfig();
      }
    },
    [teamIdBranded, run, refetchConfig],
  );

  // Poll while a backfill run is in flight, so "Načítám pohyby…" resolves on its own.
  const backfillStatus = config ? Option.getOrNull(config.backfillStatus) : null;
  React.useEffect(() => {
    if (backfillStatus !== 'running') return;
    const id = setInterval(() => {
      void refetchConfig();
    }, 5000);
    return () => clearInterval(id);
  }, [backfillStatus, refetchConfig]);

  const ibanPreview = CzIban.buildCzIban({
    prefix: accountPrefix,
    accountNumber,
    bankCode: FIO_BANK_CODE,
  });

  return (
    <>
      <Card>
        <CardHeader>
          <div className='flex items-center gap-2'>
            <Landmark className='size-4 text-muted-foreground' />
            <CardTitle className='text-base'>{tr('fio_card_title')}</CardTitle>
          </div>
          <CardDescription>{tr('fio_card_description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className='flex flex-col gap-5'>
            <FioStatusBlock
              config={config}
              onReplaceToken={handleReplaceToken}
              onRetryNow={handleRetryNow}
              retrying={retrying}
            />

            <div className='flex items-start justify-between gap-4'>
              <div>
                <label htmlFor='fio-enabled' className='text-sm font-medium block'>
                  {tr('fio_enabled_label')}
                </label>
                <p className='text-xs text-muted-foreground mt-1'>{tr('fio_enabled_help')}</p>
              </div>
              <Switch
                id='fio-enabled'
                checked={enabled}
                onCheckedChange={(v) => setField('enabled', v)}
              />
            </div>

            <div className='flex items-start justify-between gap-4'>
              <div>
                <label htmlFor='fio-auto-match' className='text-sm font-medium block'>
                  {tr('fio_autoMatch_label')}
                </label>
                <p className='text-xs text-muted-foreground mt-1'>{tr('fio_autoMatch_help')}</p>
              </div>
              <Switch
                id='fio-auto-match'
                checked={autoMatchEnabled}
                onCheckedChange={(v) => setField('autoMatchEnabled', v)}
                disabled={!enabled}
              />
            </div>

            <Separator />

            <fieldset disabled={!enabled} className={!enabled ? 'opacity-60' : ''}>
              <div className='flex flex-col gap-4'>
                <div>
                  <span className='text-sm font-medium mb-1 block'>{tr('fio_account_label')}</span>
                  <div className='grid grid-cols-[5rem_1fr_5rem] gap-2 items-end'>
                    <div>
                      <Label htmlFor='fio-prefix' className='text-xs text-muted-foreground'>
                        {tr('fio_account_prefix')}
                      </Label>
                      <Input
                        id='fio-prefix'
                        inputMode='numeric'
                        value={accountPrefix}
                        onChange={(e) => {
                          setField('accountPrefix', e.target.value);
                          setErrors((prev) => ({ ...prev, accountPrefix: undefined }));
                        }}
                        aria-invalid={errors.accountPrefix !== undefined}
                      />
                    </div>
                    <div>
                      <Label htmlFor='fio-account-number' className='text-xs text-muted-foreground'>
                        {tr('fio_account_number')}
                      </Label>
                      <Input
                        id='fio-account-number'
                        inputMode='numeric'
                        value={accountNumber}
                        onChange={(e) => {
                          setField('accountNumber', e.target.value);
                          setErrors((prev) => ({ ...prev, accountNumber: undefined }));
                        }}
                        aria-invalid={errors.accountNumber !== undefined}
                      />
                    </div>
                    <div>
                      <Label htmlFor='fio-bank-code' className='text-xs text-muted-foreground'>
                        {tr('fio_account_bankCode')}
                      </Label>
                      <Input id='fio-bank-code' readOnly value={FIO_BANK_CODE} />
                    </div>
                  </div>
                  <p className='text-xs text-muted-foreground mt-1'>
                    {tr('fio_account_bankCodeHelp')}
                  </p>
                  {errors.accountPrefix && (
                    <p className='text-xs text-destructive mt-1'>{tr(errors.accountPrefix)}</p>
                  )}
                  {errors.accountNumber && (
                    <p className='text-xs text-destructive mt-1'>{tr(errors.accountNumber)}</p>
                  )}
                  {/*
                    Fallback for any validation error whose field has no input of its own (the bank
                    code is static text, so `errors.bankCode` had nowhere to render). Without this, a
                    failing check aborts `handleSave` with no request and no message — the user sees
                    a Save button that simply does nothing. Never let a blocking error be invisible.
                  */}
                  {errors.bankCode && (
                    <p className='text-xs text-destructive mt-1'>{tr(errors.bankCode)}</p>
                  )}
                  {Option.isSome(ibanPreview) && (
                    <p className='text-xs text-muted-foreground mt-1 tabular-nums'>
                      {tr('fio_account_preview', {
                        account: `${accountPrefix ? `${accountPrefix}-` : ''}${accountNumber}/${FIO_BANK_CODE}`,
                        iban: ibanPreview.value,
                      })}
                    </p>
                  )}
                </div>

                <div aria-live='polite'>
                  <Label className='text-sm font-medium mb-1 block'>{tr('fio_token_label')}</Label>
                  {config?.fioTokenSet && !replacingToken ? (
                    <div className='flex items-center gap-3'>
                      <span className='text-sm text-muted-foreground'>{tr('fio_token_set')}</span>
                      <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        onClick={() => setReplacingToken(true)}
                      >
                        {tr('fio_token_replace')}
                      </Button>
                    </div>
                  ) : (
                    <>
                      <p className='text-xs text-muted-foreground mb-1'>
                        {replacingToken ? tr('fio_token_replaceHelp') : tr('fio_token_help')}
                      </p>
                      <div className='flex gap-2'>
                        <Input
                          ref={tokenInputRef}
                          type='password'
                          autoComplete='new-password'
                          placeholder={tr('fio_token_placeholder')}
                          value={fioToken}
                          onChange={(e) => setFioToken(e.target.value)}
                        />
                        {replacingToken && (
                          <Button
                            type='button'
                            variant='outline'
                            size='sm'
                            onClick={() => {
                              setFioToken('');
                              setReplacingToken(false);
                            }}
                          >
                            {tr('fio_token_cancel')}
                          </Button>
                        )}
                      </div>
                      {fioToken.trim().length > 0 && fioToken.trim().length !== 64 && (
                        <p className='text-xs text-muted-foreground mt-1'>
                          {tr('fio_token_errorShort')}
                        </p>
                      )}
                    </>
                  )}
                  <p className='text-xs text-muted-foreground mt-2'>{tr('fio_token_validity')}</p>
                </div>

                <div>
                  <Label htmlFor='fio-token-created-at' className='text-sm font-medium mb-1 block'>
                    {tr('fio_tokenCreatedAt_label')}
                  </Label>
                  <p className='text-xs text-muted-foreground mb-1'>
                    {tr('fio_tokenCreatedAt_help')}
                  </p>
                  <DatePicker
                    value={tokenCreatedAt}
                    onChange={setTokenCreatedAt}
                    fromYear={currentYear - 1}
                    toYear={currentYear}
                  />
                </div>

                <div>
                  <Button
                    type='button'
                    variant='link'
                    size='sm'
                    className='self-start px-0'
                    onClick={() => setHelpOpen((v) => !v)}
                    aria-expanded={helpOpen}
                  >
                    <ChevronRight
                      className={`size-3 transition-transform ${helpOpen ? 'rotate-90' : ''}`}
                      aria-hidden='true'
                    />
                    {tr('fio_help_toggle')}
                  </Button>
                  {helpOpen && (
                    <div className='flex flex-col gap-3 mt-2'>
                      <ol className='list-decimal pl-5 text-sm text-muted-foreground flex flex-col gap-1'>
                        <li>{tr('fio_help_step1')}</li>
                        <li>{tr('fio_help_step2')}</li>
                        <li>{tr('fio_help_step3')}</li>
                        <li>{tr('fio_help_step4')}</li>
                        <li>{tr('fio_help_step5')}</li>
                        <li>{tr('fio_help_step6')}</li>
                      </ol>
                      <Alert variant='warning'>
                        <AlertTriangle aria-hidden='true' />
                        <AlertTitle>{tr('fio_help_warningTitle')}</AlertTitle>
                        <AlertDescription>{tr('fio_help_warningBody')}</AlertDescription>
                      </Alert>
                    </div>
                  )}
                </div>

                <Separator />

                <div>
                  <Label htmlFor='fio-recipient-name' className='text-sm font-medium mb-1 block'>
                    {tr('fio_recipientName_label')}
                  </Label>
                  <p className='text-xs text-muted-foreground mb-1'>
                    {tr('fio_recipientName_help')}
                  </p>
                  <Input
                    id='fio-recipient-name'
                    value={recipientName}
                    onChange={(e) => setField('recipientName', e.target.value)}
                  />
                </div>

                <div>
                  <Button
                    type='button'
                    variant='link'
                    size='sm'
                    className='self-start px-0'
                    onClick={() => setDocsOpen((v) => !v)}
                    aria-expanded={docsOpen}
                  >
                    <ChevronRight
                      className={`size-3 transition-transform ${docsOpen ? 'rotate-90' : ''}`}
                      aria-hidden='true'
                    />
                    {tr('fio_documents_section')}
                  </Button>
                  {docsOpen && (
                    <div className='flex flex-col gap-3 mt-2'>
                      <p className='text-xs text-muted-foreground'>{tr('fio_documents_help')}</p>
                      <div>
                        <Label
                          htmlFor='fio-registered-id'
                          className='text-sm font-medium mb-1 block'
                        >
                          {tr('fio_registeredId_label')}
                        </Label>
                        <Input
                          id='fio-registered-id'
                          inputMode='numeric'
                          value={registeredId}
                          onChange={(e) => setField('registeredId', e.target.value)}
                        />
                      </div>
                      <div>
                        <Label
                          htmlFor='fio-registered-address'
                          className='text-sm font-medium mb-1 block'
                        >
                          {tr('fio_registeredAddress_label')}
                        </Label>
                        <Input
                          id='fio-registered-address'
                          value={registeredAddress}
                          onChange={(e) => setField('registeredAddress', e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <Separator />

                <div>
                  <span className='text-sm font-medium mb-1 block'>
                    {tr('fio_backfill_button')}
                  </span>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() => setBackfillOpen(true)}
                    disabled={config === null}
                  >
                    {tr('fio_backfill_button')}
                  </Button>
                </div>
              </div>
            </fieldset>

            <div className='flex items-center gap-3'>
              <Button onClick={handleSave} disabled={saving || !hasChanges}>
                {saving ? tr('profile_saving') : tr('profile_saveChanges')}
              </Button>
              {hasChanges && (
                <p className='text-sm text-muted-foreground'>{tr('teamSettings_unsavedChanges')}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <BackfillDialog
        open={backfillOpen}
        onOpenChange={setBackfillOpen}
        onStart={(from, to) => {
          void handleStartBackfill(from, to);
        }}
        starting={starting}
        backfillStatus={backfillStatus}
      />
    </>
  );
}
