// Tests for FeeImportDialog.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, string | number>) => {
    const map: Record<string, string> = {
      fee_import_title: 'Import fees from CSV',
      fee_import_description: 'One row is one member charge.',
      fee_import_fileLabel: 'CSV file',
      fee_import_submit: 'Import',
      fee_import_submitting: 'Importing…',
      fee_import_errorsTitle: 'Nothing was imported.',
      fee_import_errorLine: 'Line {line}: {reason}',
      fee_import_summary: 'Rows: {rows} · Fees: {fees}',
      fee_import_error_invalidEncoding: 'Save the file as CSV UTF-8.',
      fee_import_error_memberNotFound: 'No active team member has this Discord username.',
      common_cancel: 'Cancel',
    };
    const text = map[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));
  },
  setTranslationOverrides: vi.fn(),
}));

const { FeeImportDialog } = await import('~/components/organisms/FeeImportDialog.js');

const VALID_CSV =
  'member;fee;amount;currency;dueAt\nalice;Season;1500;CZK;\nbob;Season;1500;CZK;\n';

// A file stand-in whose bytes arrive when the test says so.
function fakeFile(name: string, bytes: Uint8Array) {
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    file: { name, arrayBuffer: () => ready.then(() => bytes.buffer) },
    release,
  };
}

function utf8(text: string) {
  return new TextEncoder().encode(text);
}

function renderDialog(onSubmit = vi.fn(), open = true) {
  const onCancel = vi.fn();
  const view = render(<FeeImportDialog open={open} onSubmit={onSubmit} onCancel={onCancel} />);
  return { ...view, onSubmit, onCancel };
}

function pick(file: { name: string }) {
  fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [file] } });
}

async function pickNow(name: string, bytes: Uint8Array) {
  const f = fakeFile(name, bytes);
  f.release();
  pick(f.file);
  await waitFor(() => expect(screen.queryByText(name)).not.toBeNull());
}

const importButton = () => screen.getByRole('button', { name: 'Import' });

describe('FeeImportDialog', () => {
  it('shows a Line 1 encoding error for bytes that are not UTF-8', async () => {
    renderDialog();
    await pickNow('fees.csv', new Uint8Array([0xff, 0xfe, 0x41]));

    expect(await screen.findByText('Line 1: Save the file as CSV UTF-8.')).not.toBeNull();
    expect(importButton()).toHaveProperty('disabled', true);
  });

  it('shows the summary and enables Import for a valid file', async () => {
    renderDialog();
    await pickNow('fees.csv', utf8(VALID_CSV));

    expect(await screen.findByText('Rows: 2 · Fees: 1')).not.toBeNull();
    expect(importButton()).toHaveProperty('disabled', false);
  });

  it('lists server errors, disables Import and focuses the file input', async () => {
    const onSubmit = vi.fn().mockResolvedValue([{ line: 3, code: 'member_not_found' }]);
    renderDialog(onSubmit);
    await pickNow('fees.csv', utf8(VALID_CSV));
    await screen.findByText('Rows: 2 · Fees: 1');

    fireEvent.click(importButton());

    expect(
      await screen.findByText('Line 3: No active team member has this Discord username.'),
    ).not.toBeNull();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(importButton()).toHaveProperty('disabled', true);
    expect(document.activeElement).toBe(screen.getByLabelText('CSV file'));
  });

  it('keeps the long error list out of the live region', async () => {
    const onSubmit = vi.fn().mockResolvedValue([{ line: 3, code: 'member_not_found' }]);
    renderDialog(onSubmit);
    await pickNow('fees.csv', utf8(VALID_CSV));
    await screen.findByText('Rows: 2 · Fees: 1');
    fireEvent.click(importButton());

    const item = await screen.findByText(/^Line 3:/);
    expect(item.closest('[aria-live]')).toBeNull();
    expect(screen.getByText('Nothing was imported.').closest('[aria-live]')).not.toBeNull();
  });

  it('disables Cancel and Import while onSubmit is pending', async () => {
    let resolve: (v: never[]) => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<never[]>((r) => {
          resolve = r;
        }),
    );
    renderDialog(onSubmit);
    await pickNow('fees.csv', utf8(VALID_CSV));
    await screen.findByText('Rows: 2 · Fees: 1');

    fireEvent.click(importButton());

    const pending = await screen.findByRole('button', { name: 'Importing…' });
    expect(pending).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);

    await act(async () => resolve([]));
    expect(importButton()).toHaveProperty('disabled', false);
  });

  it('drops the result of an older pick when a newer file is picked', async () => {
    renderDialog();
    const a = fakeFile('a.csv', utf8(VALID_CSV));
    const b = fakeFile('b.csv', utf8('member;fee;amount;currency;dueAt\ncarol;Trip;500;EUR;\n'));

    pick(a.file);
    pick(b.file);
    await act(async () => b.release());
    await screen.findByText('Rows: 1 · Fees: 1');
    await act(async () => a.release());

    expect(screen.getByText('b.csv')).not.toBeNull();
    expect(screen.getByText('Rows: 1 · Fees: 1')).not.toBeNull();
    expect(screen.queryByText('Rows: 2 · Fees: 1')).toBeNull();
  });

  it('drops a decode that finishes after the dialog closed', async () => {
    const { rerender, onSubmit, onCancel } = renderDialog();
    const a = fakeFile('a.csv', utf8(VALID_CSV));

    pick(a.file);
    rerender(<FeeImportDialog open={false} onSubmit={onSubmit} onCancel={onCancel} />);
    rerender(<FeeImportDialog open={true} onSubmit={onSubmit} onCancel={onCancel} />);
    await act(async () => a.release());

    expect(screen.queryByText('Rows: 2 · Fees: 1')).toBeNull();
    expect(importButton()).toHaveProperty('disabled', true);
  });
});
