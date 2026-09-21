import type { BankSyncApi } from '@sideline/domain';
import { Effect, Option } from 'effect';
import React from 'react';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { DatePicker } from '~/components/ui/date-picker';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { getToken } from '~/lib/token.js';
import { useServerUrl } from '~/lib/translation-overrides-context.js';
import { tr } from '~/lib/translations.js';

type ExportFormat = 'csv' | 'pdf';
type PeriodPreset = 'thisYear' | 'lastYear' | 'allTime' | 'custom';

interface BankExportPanelProps {
  readonly teamId: string;
  readonly summary: BankSyncApi.BankSyncSummaryView | null;
  readonly onOpenBackfill: (from: string, to: string) => void;
}

const currentYear = new Date().getFullYear();

function presetRange(preset: PeriodPreset): { from: string; to: string } {
  if (preset === 'thisYear') return { from: `${currentYear}-01-01`, to: `${currentYear}-12-31` };
  if (preset === 'lastYear') {
    return { from: `${currentYear - 1}-01-01`, to: `${currentYear - 1}-12-31` };
  }
  if (preset === 'allTime') return { from: '2000-01-01', to: `${currentYear}-12-31` };
  return { from: '', to: '' };
}

async function downloadFile(url: string, filename: string): Promise<boolean> {
  const tokenOpt = await Effect.runPromise(getToken);
  const headers: Record<string, string> = {};
  if (Option.isSome(tokenOpt)) {
    headers.Authorization = `Bearer ${tokenOpt.value}`;
  }
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return false;
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(objectUrl);
    return true;
  } catch {
    return false;
  }
}

/** Export tab (design §7) — coverage is a `coverageGaps` list, not a single earliest-date
 * scalar, so an interior poller outage inside the range never renders as "fully covered". */
export function BankExportPanel({ teamId, summary, onOpenBackfill }: BankExportPanelProps) {
  const serverUrl = useServerUrl();
  const [preset, setPreset] = React.useState<PeriodPreset>('thisYear');
  const [from, setFrom] = React.useState(presetRange('thisYear').from);
  const [to, setTo] = React.useState(presetRange('thisYear').to);
  const [format, setFormat] = React.useState<ExportFormat>('pdf');
  const [docLabel, setDocLabel] = React.useState('');
  const [acknowledgeGaps, setAcknowledgeGaps] = React.useState(false);
  const [preparing, setPreparing] = React.useState(false);
  const [downloadedFilename, setDownloadedFilename] = React.useState<string | null>(null);
  const [downloadError, setDownloadError] = React.useState(false);

  const handlePreset = (value: PeriodPreset) => {
    setPreset(value);
    setAcknowledgeGaps(false);
    setDownloadedFilename(null);
    if (value !== 'custom') {
      const range = presetRange(value);
      setFrom(range.from);
      setTo(range.to);
    }
  };

  if (!summary) {
    return (
      <div className='flex flex-col items-center gap-2 py-12 text-center'>
        <p className='text-muted-foreground'>{tr('bank_export_nothingIngested')}</p>
      </div>
    );
  }

  const gaps = summary.coverageGaps;
  const hasLeadingGap = gaps.length > 0 && from !== '' && gaps.some((g) => g.from <= from);
  const narrowFrom =
    gaps.length > 0 ? [...gaps].sort((a, b) => (a.to < b.to ? -1 : 1))[gaps.length - 1].to : from;

  const handleDownload = async () => {
    if (from === '' || to === '') return;
    setPreparing(true);
    setDownloadError(false);
    setDownloadedFilename(null);
    const base = serverUrl.replace(/\/$/, '');
    const filename = `vypis-${teamId}-${from}_${to}.${format}`;
    const params = new URLSearchParams({ from, to });
    if (format === 'csv' && acknowledgeGaps) params.set('acknowledgeGaps', 'true');
    if (format === 'pdf' && docLabel.trim()) params.set('docLabel', docLabel.trim());
    const url = `${base}/teams/${teamId}/bank-transactions/export.${format}?${params.toString()}`;
    const ok = await downloadFile(url, filename);
    setPreparing(false);
    if (ok) setDownloadedFilename(filename);
    else setDownloadError(true);
  };

  return (
    <div className='flex flex-col gap-5 max-w-xl'>
      <p className='text-sm text-muted-foreground'>{tr('bank_export_description')}</p>

      <div>
        <span className='text-sm font-medium mb-1 block'>{tr('bank_export_period')}</span>
        <div className='flex flex-wrap gap-2 mb-2'>
          <Button
            type='button'
            variant={preset === 'thisYear' ? 'default' : 'outline'}
            size='sm'
            onClick={() => handlePreset('thisYear')}
          >
            {tr('finance_period_thisYear')}
          </Button>
          <Button
            type='button'
            variant={preset === 'lastYear' ? 'default' : 'outline'}
            size='sm'
            onClick={() => handlePreset('lastYear')}
          >
            {tr('bank_export_periodLastYear')}
          </Button>
          <Button
            type='button'
            variant={preset === 'allTime' ? 'default' : 'outline'}
            size='sm'
            onClick={() => handlePreset('allTime')}
          >
            {tr('finance_period_allTime')}
          </Button>
          <Button
            type='button'
            variant={preset === 'custom' ? 'default' : 'outline'}
            size='sm'
            onClick={() => handlePreset('custom')}
          >
            {tr('finance_period_custom')}
          </Button>
        </div>
        <div className='grid grid-cols-2 gap-3'>
          <div>
            <Label className='text-xs text-muted-foreground'>{tr('bank_export_from')}</Label>
            <DatePicker
              value={from}
              onChange={(v) => {
                setFrom(v);
                setPreset('custom');
              }}
              fromYear={currentYear - 10}
              toYear={currentYear}
            />
          </div>
          <div>
            <Label className='text-xs text-muted-foreground'>{tr('bank_export_to')}</Label>
            <DatePicker
              value={to}
              onChange={(v) => {
                setTo(v);
                setPreset('custom');
              }}
              fromYear={currentYear - 10}
              toYear={currentYear}
            />
          </div>
        </div>
      </div>

      <div>
        <span className='text-sm font-medium mb-1 block'>{tr('bank_export_format')}</span>
        <ToggleGroup
          type='single'
          value={format}
          onValueChange={(v) => {
            if (v === 'csv' || v === 'pdf') setFormat(v);
          }}
          variant='outline'
        >
          <ToggleGroupItem value='csv'>{tr('bank_export_formatCsv')}</ToggleGroupItem>
          <ToggleGroupItem value='pdf'>{tr('bank_export_formatPdf')}</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {format === 'pdf' && (
        <div>
          <Label htmlFor='export-doc-label'>{tr('bank_export_docLabel')}</Label>
          <Input
            id='export-doc-label'
            value={docLabel}
            placeholder={tr('bank_export_docLabelPlaceholder')}
            onChange={(e) => setDocLabel(e.target.value)}
          />
          <p className='text-xs text-muted-foreground mt-1'>{tr('bank_export_docLabelHelp')}</p>
        </div>
      )}

      {gaps.length === 0 ? (
        <Alert variant='default'>
          <AlertDescription>{tr('bank_export_covered')}</AlertDescription>
        </Alert>
      ) : (
        <Alert variant='warning'>
          <AlertTitle>{tr('bank_export_gapTitle')}</AlertTitle>
          <AlertDescription className='flex flex-col gap-2'>
            <p>{tr('bank_export_gapBody')}</p>
            <ul className='list-disc pl-4'>
              {gaps.slice(0, 5).map((g) => (
                <li key={`${g.from}-${g.to}`}>
                  {tr('bank_export_gapItem', { from: g.from, to: g.to })}
                </li>
              ))}
            </ul>
            {gaps.length > 5 && <p>{tr('bank_export_gapMore', { n: gaps.length - 5 })}</p>}
            <p>{tr('bank_export_gapMissingNote')}</p>
            <div className='flex flex-wrap gap-2'>
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={() => onOpenBackfill(gaps[0].from, gaps[gaps.length - 1].to)}
              >
                {tr('bank_export_gapBackfill')}
              </Button>
              {hasLeadingGap && (
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() => {
                    setFrom(narrowFrom);
                    setPreset('custom');
                  }}
                >
                  {tr('bank_export_gapNarrow', { date: narrowFrom })}
                </Button>
              )}
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={() => setAcknowledgeGaps(true)}
              >
                {tr('bank_export_gapAnyway')}
              </Button>
            </div>
            {format === 'csv' && <p>{tr('bank_export_gapCsvNote')}</p>}
          </AlertDescription>
        </Alert>
      )}

      <div>
        <p className='text-sm'>{tr('bank_export_summary', { count: summary.importedCount })}</p>
        <p className='text-sm text-muted-foreground'>
          {tr('bank_export_summaryTotals', {
            opening: '—',
            income: formatMoney(summary.periodIncomeMinor, 'CZK', 'en'),
            expenses: formatMoney(summary.periodExpensesMinor, 'CZK', 'en'),
            closing: '—',
          })}
        </p>
      </div>

      {format === 'csv' && (
        <div className='text-xs text-muted-foreground flex flex-col gap-1'>
          <p>{tr('bank_export_csvHelp')}</p>
          <p>{tr('bank_export_csvLeadingZeros')}</p>
        </div>
      )}

      <div>
        <Button
          type='button'
          onClick={handleDownload}
          disabled={preparing || from === '' || to === ''}
          aria-busy={preparing}
        >
          {preparing
            ? tr('bank_export_preparing')
            : format === 'pdf'
              ? tr('bank_export_downloadPdf')
              : tr('bank_export_downloadCsv')}
        </Button>
        {downloadedFilename && (
          <p className='text-sm text-muted-foreground mt-2'>
            {tr('bank_export_downloaded', { filename: downloadedFilename })}
          </p>
        )}
        {downloadError && (
          <Alert variant='destructive' className='mt-2'>
            <AlertDescription>{tr('bank_export_error')}</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
