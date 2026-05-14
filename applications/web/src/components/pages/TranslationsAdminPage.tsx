import type { Translations } from '@sideline/domain';
import csRaw from '@sideline/i18n/raw/cs.json';
import enRaw from '@sideline/i18n/raw/en.json';
import { messageKeys } from '@sideline/i18n/registry';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Effect, Option } from 'effect';
import React from 'react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { useTranslationOverrides } from '~/lib/translation-overrides-context.js';

// ─── Types ───────────────────────────────────────────────────────────────────

type TranslationLocale = 'en' | 'cs';
type ImportRow = {
  readonly key: string;
  readonly locale: TranslationLocale;
  readonly value: string;
};

// JSON imports are typed as specific shapes by TypeScript/vite, we treat them as record lookups
const enDefaults: Readonly<Record<string, string | undefined>> = enRaw;
const csDefaults: Readonly<Record<string, string | undefined>> = csRaw;

const PAGE_SIZE = 50;

// ─── Import Dialog ────────────────────────────────────────────────────────────

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

function isTranslationLocale(s: string): s is TranslationLocale {
  return s === 'en' || s === 'cs';
}

function parseImportJson(text: string): ReadonlyArray<ImportRow> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) {
    const rows: Array<ImportRow> = [];
    for (const item of parsed as unknown[]) {
      if (
        typeof item === 'object' &&
        item !== null &&
        'key' in item &&
        'locale' in item &&
        'value' in item
      ) {
        const { key, locale, value } = item as Record<string, unknown>;
        if (
          typeof key === 'string' &&
          typeof locale === 'string' &&
          isTranslationLocale(locale) &&
          typeof value === 'string'
        ) {
          rows.push({ key, locale, value });
        }
      }
    }
    return rows.length > 0 ? rows : null;
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    const rows: Array<ImportRow> = [];
    for (const locale of ['en', 'cs'] satisfies TranslationLocale[]) {
      if (typeof obj[locale] === 'object' && obj[locale] !== null) {
        const localeObj = obj[locale] as Record<string, unknown>;
        for (const [key, value] of Object.entries(localeObj)) {
          if (typeof value === 'string') {
            rows.push({ key, locale, value });
          }
        }
      }
    }
    if (rows.length > 0) return rows;
  }

  return null;
}

function ImportDialog({ open, onClose, onImported }: ImportDialogProps) {
  const run = useRun();
  const queryClient = useQueryClient();
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<ReadonlyArray<ImportRow> | null>(null);
  const [unknownKeys, setUnknownKeys] = React.useState<ReadonlyArray<string> | null>(null);
  const [importing, setImporting] = React.useState(false);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFileError(null);
    setPending(null);
    setUnknownKeys(null);
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text !== 'string') {
        setFileError('Could not read file.');
        return;
      }
      const rows = parseImportJson(text);
      if (rows === null) {
        setFileError(
          'Invalid JSON format. Expected { en: {...}, cs: {...} } or array of { key, locale, value }.',
        );
        return;
      }
      setPending(rows);
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!pending) return;
    setImporting(true);
    setUnknownKeys(null);

    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.translations.import_({
          payload: { overrides: pending },
        }),
      ),
      Effect.catchTag('UnknownTranslationKeys', (err) => {
        setUnknownKeys(err.keys);
        return Effect.fail(ClientError.make(`Unknown keys: ${err.keys.join(', ')}`));
      }),
      Effect.mapError((e) => (e._tag === 'ClientError' ? e : ClientError.make('Import failed'))),
      run({ success: 'Translations imported.' }),
    );

    setImporting(false);

    if (Option.isSome(result)) {
      await queryClient.invalidateQueries({ queryKey: ['translations'] });
      onImported();
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-w-lg'>
        <DialogHeader>
          <DialogTitle>Import Translations</DialogTitle>
        </DialogHeader>

        <div className='flex flex-col gap-4'>
          <p className='text-sm text-muted-foreground'>
            Upload a JSON file in either of these formats:
          </p>
          <pre className='text-xs bg-muted rounded p-2 overflow-x-auto'>
            {`{ "en": { "key": "value" }, "cs": { "key": "value" } }`}
          </pre>
          <p className='text-sm text-muted-foreground'>or as a flat array:</p>
          <pre className='text-xs bg-muted rounded p-2 overflow-x-auto'>
            {`[{ "key": "...", "locale": "en", "value": "..." }]`}
          </pre>

          <Input type='file' accept='.json' onChange={handleFile} />

          {fileError && <p className='text-sm text-destructive'>{fileError}</p>}

          {pending && (
            <p className='text-sm text-muted-foreground'>
              Preview: {pending.length} override(s) to import.
            </p>
          )}

          {unknownKeys && (
            <div className='text-sm text-destructive'>
              <p className='font-medium'>Unknown translation keys:</p>
              <ul className='list-disc list-inside mt-1'>
                {unknownKeys.map((k) => (
                  <li key={k}>{k}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={importing}>
            Cancel
          </Button>
          <Button onClick={handleImport} disabled={!pending || importing}>
            {importing ? 'Importing…' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Override Cell ────────────────────────────────────────────────────────────

interface OverrideCellProps {
  translationKey: string;
  locale: TranslationLocale;
  currentValue: string | undefined;
  onSaved: () => void;
}

function OverrideCell({ translationKey, locale, currentValue, onSaved }: OverrideCellProps) {
  const run = useRun();
  const queryClient = useQueryClient();
  const [value, setValue] = React.useState(currentValue ?? '');
  const committedRef = React.useRef(currentValue ?? '');

  React.useEffect(() => {
    setValue(currentValue ?? '');
    committedRef.current = currentValue ?? '';
  }, [currentValue]);

  const save = React.useCallback(
    async (newValue: string) => {
      if (newValue === committedRef.current) return;

      const payload: Translations.UpsertTranslationPayload =
        locale === 'en'
          ? { en: Option.some(newValue), cs: Option.none() }
          : { en: Option.none(), cs: Option.some(newValue) };

      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.translations.upsert({
            params: { key: translationKey },
            payload,
          }),
        ),
        Effect.mapError(() => ClientError.make('Failed to save translation')),
        run({}),
      );

      if (Option.isSome(result)) {
        committedRef.current = newValue;
        await queryClient.invalidateQueries({ queryKey: ['translations'] });
        onSaved();
      } else {
        // Revert on failure
        setValue(committedRef.current);
      }
    },
    [translationKey, locale, run, queryClient, onSaved],
  );

  const handleBlur = () => {
    save(value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
    if (e.key === 'Escape') {
      setValue(committedRef.current);
    }
  };

  return (
    <Input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      placeholder='—'
      className='h-7 text-sm min-w-[120px]'
    />
  );
}

// ─── Delete Override Button ───────────────────────────────────────────────────

interface DeleteOverrideBtnProps {
  translationKey: string;
  locale: TranslationLocale;
  onDeleted: () => void;
}

function DeleteOverrideBtn({ translationKey, locale, onDeleted }: DeleteOverrideBtnProps) {
  const run = useRun();
  const queryClient = useQueryClient();

  const handleDelete = async () => {
    const payload: Translations.UpsertTranslationPayload =
      locale === 'en'
        ? { en: Option.some(null), cs: Option.none() }
        : { en: Option.none(), cs: Option.some(null) };

    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.translations.upsert({
          params: { key: translationKey },
          payload,
        }),
      ),
      Effect.mapError(() => ClientError.make('Failed to delete override')),
      run({ success: 'Override deleted.' }),
    );

    if (Option.isSome(result)) {
      await queryClient.invalidateQueries({ queryKey: ['translations'] });
      onDeleted();
    }
  };

  return (
    <Button
      variant='ghost'
      size='sm'
      className='h-6 text-xs px-2 text-destructive hover:text-destructive'
      onClick={handleDelete}
    >
      ×
    </Button>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

interface TranslationsAdminPageProps {
  initialData: Translations.TranslationsResponse;
}

export function TranslationsAdminPage(_props: TranslationsAdminPageProps) {
  const { overrides } = useTranslationOverrides();
  const queryClient = useQueryClient();

  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(0);
  const [importOpen, setImportOpen] = React.useState(false);

  const allKeys = messageKeys as ReadonlyArray<string>;

  const filteredKeys = React.useMemo(() => {
    if (!search.trim()) return allKeys;
    const q = search.toLowerCase();
    return allKeys.filter((k) => k.toLowerCase().includes(q));
  }, [search]);

  const totalPages = Math.ceil(filteredKeys.length / PAGE_SIZE);
  const pageKeys = filteredKeys.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Reset page when search changes
  React.useEffect(() => {
    setPage(0);
  }, []);

  const handleRefresh = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['translations'] });
  }, [queryClient]);

  const handleExport = () => {
    window.open('/api/translations/export.json', '_blank');
  };

  return (
    <div className='p-4 max-w-screen-xl mx-auto'>
      <header className='mb-6'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/'>← Back to dashboard</Link>
        </Button>
        <h1 className='text-2xl font-bold'>Translations</h1>
        <p className='text-muted-foreground mt-1'>
          Manage translation overrides. Overrides take precedence over built-in strings.
        </p>
      </header>

      {/* Toolbar */}
      <div className='flex flex-wrap gap-3 items-center mb-4'>
        <Input
          placeholder='Search by key…'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className='max-w-xs'
        />
        <div className='flex-1' />
        <Button variant='outline' onClick={handleExport}>
          Export JSON
        </Button>
        <Button variant='outline' onClick={() => setImportOpen(true)}>
          Import JSON
        </Button>
      </div>

      {/* Pagination */}
      <div className='flex items-center gap-2 mb-3 text-sm text-muted-foreground'>
        <span>
          {filteredKeys.length} key(s) — page {page + 1} of {Math.max(1, totalPages)}
        </span>
        <div className='flex gap-1 ml-auto'>
          <Button
            variant='outline'
            size='sm'
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            Previous
          </Button>
          <Button
            variant='outline'
            size='sm'
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
          >
            Next
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className='overflow-x-auto rounded-md border'>
        <table className='w-full text-sm'>
          <thead>
            <tr className='border-b bg-muted/50 text-left text-xs text-muted-foreground uppercase tracking-wide'>
              <th className='py-2 px-3 min-w-[200px]'>Key</th>
              <th className='py-2 px-3 min-w-[140px]'>EN Default</th>
              <th className='py-2 px-3 min-w-[160px]'>EN Override</th>
              <th className='py-2 px-3 min-w-[140px]'>CS Default</th>
              <th className='py-2 px-3 min-w-[160px]'>CS Override</th>
              <th className='py-2 px-3 w-16'>Del</th>
            </tr>
          </thead>
          <tbody>
            {pageKeys.map((key) => {
              const enOverride = overrides[key]?.en;
              const csOverride = overrides[key]?.cs;
              const isBot = key.startsWith('bot_');
              return (
                <tr key={key} className='border-b hover:bg-muted/20'>
                  <td className='py-2 px-3 font-mono text-xs align-middle'>
                    <div className='flex items-center gap-1.5 flex-wrap'>
                      <span className='break-all'>{key}</span>
                      {isBot && (
                        <Badge className='border border-amber-300 bg-amber-100 text-amber-800 text-[10px] px-1 py-0'>
                          Bot — requires redeploy
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className='py-2 px-3 text-muted-foreground align-middle'>
                    <span className='line-clamp-2 max-w-[140px]' title={enDefaults[key]}>
                      {enDefaults[key] ?? '—'}
                    </span>
                  </td>
                  <td className='py-2 px-3 align-middle'>
                    <OverrideCell
                      translationKey={key}
                      locale='en'
                      currentValue={enOverride}
                      onSaved={handleRefresh}
                    />
                  </td>
                  <td className='py-2 px-3 text-muted-foreground align-middle'>
                    <span className='line-clamp-2 max-w-[140px]' title={csDefaults[key]}>
                      {csDefaults[key] ?? '—'}
                    </span>
                  </td>
                  <td className='py-2 px-3 align-middle'>
                    <OverrideCell
                      translationKey={key}
                      locale='cs'
                      currentValue={csOverride}
                      onSaved={handleRefresh}
                    />
                  </td>
                  <td className='py-2 px-3 align-middle'>
                    <div className='flex gap-0.5'>
                      {enOverride !== undefined && (
                        <DeleteOverrideBtn
                          translationKey={key}
                          locale='en'
                          onDeleted={handleRefresh}
                        />
                      )}
                      {csOverride !== undefined && (
                        <DeleteOverrideBtn
                          translationKey={key}
                          locale='cs'
                          onDeleted={handleRefresh}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Bottom pagination */}
      <div className='flex gap-1 mt-3 justify-end'>
        <Button
          variant='outline'
          size='sm'
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0}
        >
          Previous
        </Button>
        <Button
          variant='outline'
          size='sm'
          onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          disabled={page >= totalPages - 1}
        >
          Next
        </Button>
      </div>

      {/* Import dialog */}
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={handleRefresh}
      />
    </div>
  );
}
