import { BankSyncApi } from '@sideline/domain';
import { fireEvent, render, screen } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { FioTestResultAlert } from '~/components/organisms/bank/FioTestResultAlert';

const ALL_STATUSES = BankSyncApi.BankSyncTestStatus.literals;

const buildResult = (
  status: BankSyncApi.BankSyncTestStatus,
  accountIban: Option.Option<string> = status === 'ok'
    ? Option.some('CZ6508000000192000145399')
    : Option.none(),
): BankSyncApi.BankSyncTestResult =>
  new BankSyncApi.BankSyncTestResult({
    ok: status === 'ok',
    status,
    message: Option.none(),
    accountIban,
  });

describe('FioTestResultAlert', () => {
  it('renders non-empty, translated copy for every status literal — no raw key on screen', () => {
    for (const status of ALL_STATUSES) {
      const { container, unmount } = render(<FioTestResultAlert result={buildResult(status)} />);
      const text = container.textContent ?? '';
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain('fio_test_');
      expect(text).not.toContain('fio_status_');
      unmount();
    }
  });

  it('carries the status literal on data-fio-test-status for an invalid result', () => {
    const { container } = render(<FioTestResultAlert result={buildResult('invalid')} />);
    expect(container.querySelector('[data-fio-test-status="invalid"]')).not.toBeNull();
  });

  // The whole `TEST_RESULT_META` `Record` is copy-pasted from ONE status to another in exactly
  // the shape a copy-paste error takes: every KEY present, every VALUE pointing at the wrong
  // entry. `text.length > 0` (above) and the `data-fio-test-status` check alone would still pass
  // if e.g. `rate_limited` silently rendered `history_locked`'s title — this is the assertion that
  // actually catches that class of bug.
  it('renders a pairwise-distinct title for each of the seven status literals', () => {
    const titles = ALL_STATUSES.map((status) => {
      const { container, unmount } = render(<FioTestResultAlert result={buildResult(status)} />);
      const title = container.querySelector('[data-slot="alert-title"]')?.textContent;
      unmount();
      return title;
    });

    expect(titles).toHaveLength(ALL_STATUSES.length);
    for (const title of titles) {
      expect(title).toBeTruthy();
    }
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('calls onReplaceToken when the invalid CTA is clicked', () => {
    const onReplaceToken = vi.fn();
    render(<FioTestResultAlert result={buildResult('invalid')} onReplaceToken={onReplaceToken} />);

    fireEvent.click(screen.getByRole('button', { name: 'Replace token' }));

    expect(onReplaceToken).toHaveBeenCalledOnce();
  });

  it('does not call onReplaceToken for a status other than invalid (no CTA rendered)', () => {
    const onReplaceToken = vi.fn();
    render(<FioTestResultAlert result={buildResult('ok')} onReplaceToken={onReplaceToken} />);

    expect(screen.queryByRole('button', { name: 'Replace token' })).toBeNull();
    expect(onReplaceToken).not.toHaveBeenCalled();
  });

  it('renders the IBAN line for ok with Some(iban)', () => {
    const iban = 'CZ6508000000192000145399';
    const { container } = render(
      <FioTestResultAlert result={buildResult('ok', Option.some(iban))} />,
    );
    expect(container.textContent).toContain(iban);
  });

  it('omits the IBAN line for ok with None (no account echoed back)', () => {
    const { container } = render(<FioTestResultAlert result={buildResult('ok', Option.none())} />);
    expect(container.textContent).not.toContain('CZ65');
  });

  it('omits the IBAN line for every non-ok status even when accountIban is (incorrectly) Some', () => {
    const iban = 'CZ6508000000192000145399';
    for (const status of ALL_STATUSES.filter((s) => s !== 'ok')) {
      const { container, unmount } = render(
        <FioTestResultAlert result={buildResult(status, Option.some(iban))} />,
      );
      expect(container.textContent).not.toContain(iban);
      unmount();
    }
  });
});
