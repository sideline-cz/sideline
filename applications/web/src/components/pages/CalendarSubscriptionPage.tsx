import type { ICalApi } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { Effect } from 'effect';
import React from 'react';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Separator } from '~/components/ui/separator';
import { copyToClipboard } from '~/lib/clipboard';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface CalendarSubscriptionPageProps {
  teamId: string;
  icalToken: ICalApi.ICalTokenResponse;
}

export function CalendarSubscriptionPage({ teamId, icalToken }: CalendarSubscriptionPageProps) {
  const run = useRun();
  const router = useRouter();
  const [url, setUrl] = React.useState(icalToken.url);
  const [copied, setCopied] = React.useState(false);
  const [regenerating, setRegenerating] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = () => {
    if (!url) return;
    copyToClipboard(url).then((ok) => {
      if (!ok) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    });
  };

  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleRegenerate = async () => {
    if (!window.confirm(tr('ical_regenerateConfirm'))) return;
    setRegenerating(true);
    const result = await run({ success: tr('ical_regenerated') })(
      ApiClient.asEffect().pipe(
        Effect.flatMap((api) => api.ical.regenerateICalToken()),
        Effect.mapError(() => ClientError.make(tr('ical_regenerateFailed'))),
      ),
    );
    setRegenerating(false);
    if (result._tag === 'Some') {
      setUrl(result.value.url);
      router.invalidate();
    }
  };

  return (
    <div className='max-w-2xl space-y-6'>
      <header>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {tr('team_backToTeams')}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{tr('ical_title')}</h1>
        <p className='text-muted-foreground mt-1'>{tr('ical_description')}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>{tr('ical_subscribeUrl')}</CardTitle>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='flex flex-col gap-2 sm:flex-row'>
            <Input value={url} readOnly className='font-mono text-sm flex-1' />
            <Button variant='outline' onClick={handleCopy} className='shrink-0'>
              {copied ? tr('ical_copied') : tr('ical_copyUrl')}
            </Button>
          </div>
          <div>
            <Button variant='destructive' onClick={handleRegenerate} disabled={regenerating}>
              {tr('ical_regenerate')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className='pt-6 space-y-4'>
          <div>
            <h2 className='text-base font-semibold mb-1'>Google Calendar</h2>
            <p className='text-muted-foreground text-sm'>{tr('ical_instructions_google')}</p>
          </div>
          <Separator />
          <div>
            <h2 className='text-base font-semibold mb-1'>Apple Calendar</h2>
            <p className='text-muted-foreground text-sm'>{tr('ical_instructions_apple')}</p>
          </div>
          <Separator />
          <div>
            <h2 className='text-base font-semibold mb-1'>Outlook</h2>
            <p className='text-muted-foreground text-sm'>{tr('ical_instructions_outlook')}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
