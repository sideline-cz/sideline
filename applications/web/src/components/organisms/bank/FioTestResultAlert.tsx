import type { BankSyncApi } from '@sideline/domain';
import { Option } from 'effect';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { TEST_RESULT_META } from '~/lib/finance/bankTestStatus.js';
import { tr } from '~/lib/translations.js';

interface FioTestResultAlertProps {
  readonly result: BankSyncApi.BankSyncTestResult;
  /** `BankSyncConfigView.computedIban` — the IBAN the club has saved, never a second wire field.
   * Required: the server cannot emit `account_mismatch` without a configured account, and the
   * Test button is disabled when `config === null` (`FioBankCard.tsx`). */
  readonly configuredIban: string;
  readonly onReplaceToken?: () => void;
}

/**
 * Renders the verdict of ONE `/bank-sync/test` probe. Pure presentational — the IBAN comparison
 * is the server's (`account_mismatch` IS that comparison); this component only renders both
 * IBANs so the treasurer can see which is which.
 */
export function FioTestResultAlert({
  result,
  configuredIban,
  onReplaceToken,
}: FioTestResultAlertProps) {
  const meta = TEST_RESULT_META[result.status];

  return (
    // The live region lives in the parent (`FioBankCard`) and stays mounted whether or not there
    // is a result — most screen readers only announce mutations *inside* an already-present live
    // region, so this content must be rendered into that region rather than carrying its own role
    // here. That parent region is a bare `aria-live='polite' aria-atomic='true'` div, NOT
    // `role='status'` — the settings page already has one `status` role
    // (`molecules/SyncRolesButton.tsx`), and a second made `page.getByRole('status')` ambiguous,
    // breaking two E2E specs in `e2e/tests/onboarding-settings.spec.ts` (`FioBankCard.tsx:253-260`).
    //
    // `role='presentation'` is load-bearing, not decoration: `ui/alert.tsx` hardcodes
    // `role='alert'` and spreads `{...props}` AFTER it, so overriding the prop is the only way to
    // drop it. Left as `alert`, this div would nest an implicitly `aria-live='assertive'` region
    // inside the parent's polite one — double-announcing, and interrupting the user for a result
    // they asked for. It strips semantics from this wrapper div only; the title, body and buttons
    // inside keep theirs. Do NOT "simplify" this to `role={undefined}` — biome's formatter
    // deletes that prop outright, silently restoring `role='alert'`.
    <Alert variant={meta.variant} role='presentation' data-fio-test-status={result.status}>
      <span className='sr-only'>{tr('fio_test_resultLabel')}</span>
      <meta.Icon aria-hidden='true' />
      <AlertTitle>{meta.title()}</AlertTitle>
      <AlertDescription className='flex flex-col gap-2'>
        <p>{meta.body()}</p>
        {result.status === 'ok' && Option.isSome(result.accountIban) && (
          <p className='text-muted-foreground tabular-nums'>
            {tr('fio_test_okAccount', { iban: result.accountIban.value })}
          </p>
        )}
        {result.status === 'account_mismatch' && Option.isSome(result.accountIban) && (
          <p className='tabular-nums'>
            {tr('fio_test_accountMismatchAccounts', {
              fioIban: result.accountIban.value,
              configuredIban,
            })}
          </p>
        )}
        {(result.status === 'invalid' || result.status === 'account_mismatch') && (
          <div className='flex flex-wrap gap-2'>
            <Button type='button' variant='outline' size='sm' onClick={onReplaceToken}>
              {tr('fio_token_replace')}
            </Button>
            {result.status === 'invalid' && (
              <Button asChild type='button' variant='outline' size='sm'>
                <a href='https://ib.fio.cz' target='_blank' rel='noopener noreferrer'>
                  {tr('fio_status_createNewToken')}
                </a>
              </Button>
            )}
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}
