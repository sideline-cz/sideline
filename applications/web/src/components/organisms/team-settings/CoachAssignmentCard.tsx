import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { tr } from '~/lib/translations.js';
import type { SettingsFormValues } from './settingsForm';
import type { CardForm } from './useCardForm';

interface CoachAssignmentCardProps {
  form: CardForm<SettingsFormValues>;
}

export function CoachAssignmentCard({ form: { values, setField } }: CoachAssignmentCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>{tr('teamSettings_coachAssignment')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div>
          <label htmlFor='claim-request-days-before' className='text-sm font-medium mb-1 block'>
            {tr('teamSettings_claimRequestDaysBefore')}
          </label>
          <p className='text-xs text-muted-foreground mb-2'>
            {tr('teamSettings_claimRequestHelp')}
          </p>
          <Input
            id='claim-request-days-before'
            type='number'
            min={0}
            max={30}
            value={values.claimRequestDaysBefore}
            onChange={(e) => setField('claimRequestDaysBefore', e.target.value)}
            className='max-w-32'
          />
        </div>
      </CardContent>
    </Card>
  );
}
