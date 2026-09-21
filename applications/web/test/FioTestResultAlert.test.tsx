import { BankSyncApi } from '@sideline/domain';
import { fireEvent, render, screen } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { FioTestResultAlert } from '~/components/organisms/bank/FioTestResultAlert';

const ALL_STATUSES = BankSyncApi.BankSyncTestStatus.literals;

// `configuredIban` is a required prop (plan §7) — the server cannot emit `account_mismatch`
// without a configured account, and the Test button is disabled when there is none. Every render
// below passes this default so existing coverage keeps compiling once the prop lands.
const DEFAULT_CONFIGURED_IBAN = 'CZ7120100000002703474850';

const buildResult = (
  status: BankSyncApi.BankSyncTestStatus,
  accountIban: Option.Option<string> = status === 'ok' || status === 'account_mismatch'
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
      const { container, unmount } = render(
        <FioTestResultAlert
          result={buildResult(status)}
          configuredIban={DEFAULT_CONFIGURED_IBAN}
        />,
      );
      const text = container.textContent ?? '';
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain('fio_test_');
      expect(text).not.toContain('fio_status_');
      unmount();
    }
  });

  it('carries the status literal on data-fio-test-status for an invalid result', () => {
    const { container } = render(
      <FioTestResultAlert
        result={buildResult('invalid')}
        configuredIban={DEFAULT_CONFIGURED_IBAN}
      />,
    );
    expect(container.querySelector('[data-fio-test-status="invalid"]')).not.toBeNull();
  });

  // The whole `TEST_RESULT_META` `Record` is copy-pasted from ONE status to another in exactly
  // the shape a copy-paste error takes: every KEY present, every VALUE pointing at the wrong
  // entry. `text.length > 0` (above) and the `data-fio-test-status` check alone would still pass
  // if e.g. `rate_limited` silently rendered `history_locked`'s title — this is the assertion that
  // actually catches that class of bug.
  it('renders a pairwise-distinct title for each of the eight status literals', () => {
    const titles = ALL_STATUSES.map((status) => {
      const { container, unmount } = render(
        <FioTestResultAlert
          result={buildResult(status)}
          configuredIban={DEFAULT_CONFIGURED_IBAN}
        />,
      );
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
    render(
      <FioTestResultAlert
        result={buildResult('invalid')}
        configuredIban={DEFAULT_CONFIGURED_IBAN}
        onReplaceToken={onReplaceToken}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Replace token' }));

    expect(onReplaceToken).toHaveBeenCalledOnce();
  });

  // Renamed from "does not call onReplaceToken for a status other than invalid (no CTA
  // rendered)": that claim is now false in general — `account_mismatch` also renders the CTA
  // (see the dedicated test below). This test only pins down the 'ok' case.
  it('does not call onReplaceToken for ok (no CTA rendered)', () => {
    const onReplaceToken = vi.fn();
    render(
      <FioTestResultAlert
        result={buildResult('ok')}
        configuredIban={DEFAULT_CONFIGURED_IBAN}
        onReplaceToken={onReplaceToken}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Replace token' })).toBeNull();
    expect(onReplaceToken).not.toHaveBeenCalled();
  });

  it('renders the IBAN line for ok with Some(iban)', () => {
    const iban = 'CZ6508000000192000145399';
    const { container } = render(
      <FioTestResultAlert
        result={buildResult('ok', Option.some(iban))}
        configuredIban={DEFAULT_CONFIGURED_IBAN}
      />,
    );
    expect(container.textContent).toContain(iban);
  });

  it('omits the IBAN line for ok with None (no account echoed back)', () => {
    const { container } = render(
      <FioTestResultAlert
        result={buildResult('ok', Option.none())}
        configuredIban={DEFAULT_CONFIGURED_IBAN}
      />,
    );
    expect(container.textContent).not.toContain('CZ65');
  });

  it('omits the IBAN line for every non-ok, non-account_mismatch status even when accountIban is (incorrectly) Some', () => {
    const iban = 'CZ6508000000192000145399';
    // `account_mismatch` deliberately DOES render an IBAN line (both IBANs, dedicated tests
    // below) — excluded here so that behaviour isn't asserted away by this loop.
    for (const status of ALL_STATUSES.filter((s) => s !== 'ok' && s !== 'account_mismatch')) {
      const { container, unmount } = render(
        <FioTestResultAlert
          result={buildResult(status, Option.some(iban))}
          configuredIban={DEFAULT_CONFIGURED_IBAN}
        />,
      );
      expect(container.textContent).not.toContain(iban);
      unmount();
    }
  });

  // Coverage the filter above deliberately excludes: `account_mismatch` with a genuinely absent
  // Fio IBAN must still omit the dual-account line (it is gated on `Option.isSome`).
  it('omits the dual-account line for account_mismatch when accountIban is None', () => {
    const { container } = render(
      <FioTestResultAlert
        result={buildResult('account_mismatch', Option.none())}
        configuredIban={DEFAULT_CONFIGURED_IBAN}
      />,
    );
    expect(container.textContent).not.toContain('CZ65');
  });

  it('renders both IBANs on account_mismatch', () => {
    const fioIban = 'CZ6508000000192000145399';
    const configuredIban = 'CZ7120100000002703474850';
    const { container } = render(
      <FioTestResultAlert
        result={buildResult('account_mismatch', Option.some(fioIban))}
        configuredIban={configuredIban}
      />,
    );
    expect(container.textContent).toContain(fioIban);
    expect(container.textContent).toContain(configuredIban);
  });

  it('renders the Replace token CTA on account_mismatch, but not the ib.fio.cz link', () => {
    const onReplaceToken = vi.fn();
    render(
      <FioTestResultAlert
        result={buildResult('account_mismatch')}
        configuredIban={DEFAULT_CONFIGURED_IBAN}
        onReplaceToken={onReplaceToken}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Replace token' }));
    expect(onReplaceToken).toHaveBeenCalledOnce();

    expect(
      screen.queryByRole('link', { name: /ib\.fio\.cz|fio_status_createNewToken/i }),
    ).toBeNull();
    const linkToFio = Array.from(document.querySelectorAll('a')).find((a) =>
      a.getAttribute('href')?.includes('ib.fio.cz'),
    );
    expect(linkToFio).toBeUndefined();
  });
});
