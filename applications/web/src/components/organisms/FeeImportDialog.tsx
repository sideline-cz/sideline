import type { FinanceApi } from '@sideline/domain';
import React from 'react';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  type FeeImportErrorCode,
  type ParsedFeeImportRow,
  parseFeeImportCsv,
} from '~/lib/finance/parseFeeImportCsv.js';
import { tr } from '~/lib/translations.js';

const errorLabels: Record<FeeImportErrorCode, () => string> = {
  invalid_header: () => tr('fee_import_error_invalidHeader'),
  no_rows: () => tr('fee_import_error_noRows'),
  too_many_rows: () => tr('fee_import_error_tooManyRows'),
  invalid_encoding: () => tr('fee_import_error_invalidEncoding'),
  malformed_row: () => tr('fee_import_error_malformedRow'),
  invalid_amount: () => tr('fee_import_error_invalidAmount'),
  invalid_currency: () => tr('fee_import_error_invalidCurrency'),
  invalid_due_at: () => tr('fee_import_error_invalidDueAt'),
  member_not_found: () => tr('fee_import_error_memberNotFound'),
  member_ambiguous: () => tr('fee_import_error_memberAmbiguous'),
  duplicate_member: () => tr('fee_import_error_duplicateMember'),
  fee_exists: () => tr('fee_import_error_feeExists'),
};

const EXAMPLE = 'member;fee;amount;currency;dueAt\nalice;Season 2026;1500;CZK;30.9.2026';

type ImportError = { line: number; code: FeeImportErrorCode };

interface FeeImportDialogProps {
  open: boolean;
  onSubmit: (rows: ParsedFeeImportRow[]) => Promise<ReadonlyArray<FinanceApi.FeeImportRowError>>;
  onCancel: () => void;
}

export function FeeImportDialog({ open, onSubmit, onCancel }: FeeImportDialogProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<ParsedFeeImportRow[]>([]);
  const [errors, setErrors] = React.useState<ReadonlyArray<ImportError>>([]);
  const [submitting, setSubmitting] = React.useState(false);
  // Bumped per file pick and on close; a decode that finishes after a newer bump is dropped.
  const fileVersion = React.useRef(0);

  React.useEffect(() => {
    if (!open) {
      fileVersion.current++;
      setFileName(null);
      setRows([]);
      setErrors([]);
      setSubmitting(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }, [open]);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear now: Chromium fires no `change` when the same file is picked again after a fix.
    e.target.value = '';
    if (!file) return;
    const version = ++fileVersion.current;
    setFileName(file.name);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      if (version !== fileVersion.current) return;
      setRows([]);
      setErrors([{ line: 1, code: 'invalid_encoding' }]);
      return;
    }
    if (version !== fileVersion.current) return;
    const result = parseFeeImportCsv(text);
    setRows(result.rows);
    setErrors(result.errors);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const serverErrors = await onSubmit(rows);
      if (serverErrors.length > 0) {
        setRows([]);
        setErrors(serverErrors);
        inputRef.current?.focus();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const fees = new Set(rows.map((r) => `${r.feeName}\u0000${r.currency}\u0000${r.dueDate ?? ''}`))
    .size;
  const canImport = rows.length > 0 && errors.length === 0 && !submitting;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !submitting) onCancel();
      }}
    >
      <DialogContent showCloseButton={!submitting} aria-describedby='fee-import-description'>
        <DialogHeader>
          <DialogTitle>{tr('fee_import_title')}</DialogTitle>
          <DialogDescription id='fee-import-description'>
            {tr('fee_import_description')}
          </DialogDescription>
        </DialogHeader>

        <div className='flex min-w-0 flex-col gap-3'>
          <pre className='text-xs bg-muted rounded p-2 overflow-x-auto'>{EXAMPLE}</pre>
          <Label htmlFor='fee-import-file'>{tr('fee_import_fileLabel')}</Label>
          <Input
            id='fee-import-file'
            ref={inputRef}
            type='file'
            accept='.csv,text/csv'
            aria-describedby='fee-import-description'
            onChange={handleFile}
          />
          {fileName !== null && (
            <p className='text-sm text-muted-foreground break-all'>{fileName}</p>
          )}

          {/* Only the title or the summary is announced; the list (up to 1000 rows) is not. */}
          <div aria-live='polite' aria-atomic='true'>
            {errors.length > 0 ? (
              <p className='text-sm font-medium text-destructive'>{tr('fee_import_errorsTitle')}</p>
            ) : rows.length > 0 ? (
              <p className='text-sm'>{tr('fee_import_summary', { rows: rows.length, fees })}</p>
            ) : null}
          </div>
          {errors.length > 0 && (
            <ol className='max-h-60 overflow-y-auto text-sm text-destructive'>
              {errors.map(({ line, code }) => (
                <li key={`${line}-${code}`}>
                  {tr('fee_import_errorLine', { line, reason: errorLabels[code]() })}
                </li>
              ))}
            </ol>
          )}
        </div>

        <DialogFooter>
          <Button type='button' variant='outline' disabled={submitting} onClick={onCancel}>
            {tr('common_cancel')}
          </Button>
          <Button type='button' disabled={!canImport} aria-busy={submitting} onClick={handleSubmit}>
            {submitting ? tr('fee_import_submitting') : tr('fee_import_submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
