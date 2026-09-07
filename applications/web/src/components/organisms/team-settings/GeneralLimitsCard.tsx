import { Settings } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Separator } from '~/components/ui/separator';
import { tr } from '~/lib/translations.js';
import type { SettingsFormValues } from './settingsForm';
import type { CardForm } from './useCardForm';

interface GeneralLimitsCardProps {
  form: CardForm<SettingsFormValues>;
}

export function GeneralLimitsCard({ form: { values, setField } }: GeneralLimitsCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className='flex items-center gap-2'>
          <Settings className='size-4 text-muted-foreground' />
          <CardTitle className='text-base'>{tr('teamSettings_generalTitle')}</CardTitle>
        </div>
        <CardDescription>{tr('teamSettings_generalDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className='flex flex-col gap-5'>
          <div>
            <label htmlFor='horizon-days' className='text-sm font-medium mb-1 block'>
              {tr('teamSettings_horizonDays')}
            </label>
            <p className='text-xs text-muted-foreground mb-2'>
              {tr('teamSettings_horizonDaysHelp')}
            </p>
            <Input
              id='horizon-days'
              type='number'
              min={1}
              max={365}
              value={values.horizonDays}
              onChange={(e) => setField('horizonDays', e.target.value)}
              className='max-w-32'
            />
          </div>
          <Separator />
          <div>
            <label htmlFor='min-players' className='text-sm font-medium mb-1 block'>
              {tr('teamSettings_minPlayersThreshold')}
            </label>
            <p className='text-xs text-muted-foreground mb-2'>
              {tr('teamSettings_minPlayersThresholdHelp')}
            </p>
            <Input
              id='min-players'
              type='number'
              min={0}
              max={100}
              value={values.minPlayersThreshold}
              onChange={(e) => setField('minPlayersThreshold', e.target.value)}
              className='max-w-32'
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
