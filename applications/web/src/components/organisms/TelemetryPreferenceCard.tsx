import { Activity } from 'lucide-react';
import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Label } from '~/components/ui/label';
import { Switch } from '~/components/ui/switch';
import {
  browserSignalsOptOut,
  isTelemetryAllowed,
  setTelemetryOptOut,
} from '~/lib/telemetryOptOut.js';
import { tr } from '~/lib/translations.js';

/**
 * The objection mechanism GDPR Art. 21 requires and §6 of the privacy policy
 * promises. Telemetry runs on legitimate interest (§3), so this is an opt-*out*
 * — it is on unless the person turns it off, and there is no consent banner.
 *
 * Reads the initial value in an effect rather than during render: the answer
 * depends on `localStorage` and `navigator`, so rendering it directly would
 * disagree with the server-rendered markup and hydrate mismatched.
 */
export function TelemetryPreferenceCard() {
  const [allowed, setAllowed] = React.useState(true);
  const [forcedOff, setForcedOff] = React.useState(false);

  React.useEffect(() => {
    setForcedOff(browserSignalsOptOut());
    setAllowed(isTelemetryAllowed());
  }, []);

  const onChange = (next: boolean) => {
    setTelemetryOptOut(!next);
    // `telemetry.ts` re-reads the objection on every send, so this takes
    // effect immediately — no reload, nothing already-registered keeps going.
    setAllowed(isTelemetryAllowed());
  };

  return (
    <Card className='w-full max-w-md mt-4'>
      <CardHeader>
        <div className='flex items-center gap-2'>
          <Activity className='size-4 text-muted-foreground' />
          <CardTitle>{tr('privacy_telemetryTitle')}</CardTitle>
        </div>
        <CardDescription>{tr('privacy_telemetryDescription')}</CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-3'>
        <div className='flex items-start justify-between gap-4'>
          <Label htmlFor='telemetry-allowed' className='font-medium'>
            {tr('privacy_telemetryToggle')}
          </Label>
          <Switch
            id='telemetry-allowed'
            checked={allowed}
            disabled={forcedOff}
            onCheckedChange={onChange}
            aria-describedby='telemetry-help'
          />
        </div>
        <p id='telemetry-help' className='text-xs text-muted-foreground'>
          {forcedOff ? tr('privacy_telemetryBrowserSignal') : tr('privacy_telemetryHelp')}
        </p>
      </CardContent>
    </Card>
  );
}
