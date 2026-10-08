import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { tr } from '~/lib/translations.js';
import type { SettingsFormValues } from './settingsForm';
import type { CardForm } from './useCardForm';

interface FinanceAutomationCardProps {
  form: CardForm<SettingsFormValues>;
}

/**
 * The three money settings that `updateTeamSettings` owns, sitting on the Finance tab next to
 * `FioBankCard` rather than in General where they started. They are not general limits: one hands
 * out variable symbols, one spends members' credit, and one bills them their membership plan's
 * price once a season.
 *
 * It takes the SHARED `form` (not its own `useCardForm`) and so saves through the one save bar
 * with the rest of `updateTeamSettings` — unlike `FioBankCard`, which owns its form because it
 * writes `bank_sync_config` through a different endpoint. That shared form lives above the tabs,
 * so nothing here unmounts when the user switches tab and a pending edit survives the trip.
 */
export function FinanceAutomationCard({ form: { values, setField } }: FinanceAutomationCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>{tr('teamSettings_financeAutomation')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className='flex flex-col gap-4'>
          <div>
            <div className='flex items-center gap-2'>
              <input
                id='auto-assign-variable-symbols'
                type='checkbox'
                checked={values.autoAssignVariableSymbols}
                onChange={(e) => setField('autoAssignVariableSymbols', e.target.checked)}
                className='h-4 w-4'
              />
              <label htmlFor='auto-assign-variable-symbols' className='text-sm font-medium'>
                {tr('teamSettings_autoAssignVariableSymbols')}
              </label>
            </div>
            <p className='text-xs text-muted-foreground mt-1'>
              {tr('teamSettings_autoAssignVariableSymbols_help')}
            </p>
          </div>
          <div>
            <div className='flex items-center gap-2'>
              <input
                id='auto-apply-credit-enabled'
                type='checkbox'
                checked={values.autoApplyCreditEnabled}
                onChange={(e) => setField('autoApplyCreditEnabled', e.target.checked)}
                className='h-4 w-4'
              />
              <label htmlFor='auto-apply-credit-enabled' className='text-sm font-medium'>
                {tr('teamSettings_autoApplyCreditEnabled')}
              </label>
            </div>
            <p className='text-xs text-muted-foreground mt-1'>
              {tr('teamSettings_autoApplyCreditEnabled_help')}
            </p>
          </div>
          <div>
            <div className='flex items-center gap-2'>
              <input
                id='membership-billing-enabled'
                type='checkbox'
                checked={values.membershipBillingEnabled}
                onChange={(e) => setField('membershipBillingEnabled', e.target.checked)}
                className='h-4 w-4'
              />
              <label htmlFor='membership-billing-enabled' className='text-sm font-medium'>
                {tr('teamSettings_membershipBillingEnabled')}
              </label>
            </div>
            <p className='text-xs text-muted-foreground mt-1'>
              {tr('teamSettings_membershipBillingEnabled_help')}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
