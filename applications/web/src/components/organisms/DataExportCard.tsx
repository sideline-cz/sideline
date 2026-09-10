import { Effect, Option } from 'effect';
import { Download } from 'lucide-react';
import React from 'react';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

/**
 * The self-service half of GDPR Art. 15, which §6 of the privacy policy said
 * for a long time was "handled by a person".
 *
 * The server decides what the file contains — see
 * `applications/server/src/gdpr/exportManifest.ts`. Nothing is filtered here
 * on the way out: a second opinion in the browser about what belongs in an
 * export is how the two drift apart, and the manifest is the one that is
 * pinned to the schema by a test.
 */
export function DataExportCard() {
  const run = useRun();
  const [downloading, setDownloading] = React.useState(false);

  const handleDownload = React.useCallback(async () => {
    setDownloading(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.auth.exportMyData()),
      Effect.mapError(() => ClientError.make(tr('privacy_exportFailed'))),
      Effect.flatMap((bundle) =>
        Effect.sync(() => {
          const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
          const objectUrl = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = objectUrl;
          anchor.download = `sideline-data-export-${new Date().toISOString().slice(0, 10)}.json`;
          document.body.appendChild(anchor);
          anchor.click();
          document.body.removeChild(anchor);
          URL.revokeObjectURL(objectUrl);
        }),
      ),
      run({}),
    );
    setDownloading(false);
    if (Option.isNone(result)) return;
  }, [run]);

  return (
    <Card className='w-full max-w-md mt-4'>
      <CardHeader>
        <div className='flex items-center gap-2'>
          <Download className='size-4 text-muted-foreground' />
          <CardTitle>{tr('privacy_exportTitle')}</CardTitle>
        </div>
        <CardDescription>{tr('privacy_exportDescription')}</CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-3'>
        <Button onClick={handleDownload} disabled={downloading} className='self-start'>
          {downloading ? tr('privacy_exportPreparing') : tr('privacy_exportButton')}
        </Button>
        <p className='text-xs text-muted-foreground'>{tr('privacy_exportHelp')}</p>
      </CardContent>
    </Card>
  );
}
