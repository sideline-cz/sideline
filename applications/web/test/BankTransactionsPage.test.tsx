// Regression test for the review BLOCKER: `BankTransactionsPage` gated its halted-import banner
// on a hand-written `status === 'invalid' || status === 'sync_failing'` disjunction, so the new
// `account_mismatch` ladder rank rendered nothing on the page treasurers actually open — a silent
// halt one route over from the one the rank exists to prevent.

import { BankSyncApi } from '@sideline/domain';
import { render, screen } from '@testing-library/react';
import { Schema } from 'effect';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BankTransactionsPage } from '~/components/pages/BankTransactionsPage';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}));

const baseConfig = {
  teamId: 'team-1',
  provider: 'fio' as const,
  enabled: true,
  autoMatchEnabled: true,
  accountPrefix: null,
  accountNumber: '2703474850',
  bankCode: '2010',
  computedIban: null,
  currency: 'CZK' as const,
  recipientName: null,
  registeredId: null,
  registeredAddress: null,
  bankName: null,
  fioTokenSet: true,
  tokenCreatedAt: null,
  tokenExpiresAt: null,
  expiringSoon: false,
  backfillStatus: null,
  backfillCursor: null,
  backfillRunId: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastAttemptFailed: false,
  coverageWarning: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function configWithStatus(status: BankSyncApi.BankSyncConfigView['status']) {
  return Schema.decodeUnknownSync(BankSyncApi.BankSyncConfigView)({ ...baseConfig, status });
}

describe('BankTransactionsPage', () => {
  it('shows its own banner for account_mismatch instead of the "token stopped working" copy', () => {
    render(
      <BankTransactionsPage
        teamId='team-1'
        config={configWithStatus('account_mismatch')}
        summary={null}
        transactions={[]}
        onRefresh={() => {}}
        onStartBackfill={async () => {}}
      />,
    );

    expect(
      screen.queryByText('Importing is stopped — the token reads a different account.'),
    ).not.toBeNull();
    expect(screen.queryByText('The token stopped working.')).toBeNull();
  });

  it('still shows the invalid-token banner for the invalid status', () => {
    render(
      <BankTransactionsPage
        teamId='team-1'
        config={configWithStatus('invalid')}
        summary={null}
        transactions={[]}
        onRefresh={() => {}}
        onStartBackfill={async () => {}}
      />,
    );

    expect(screen.queryByText('The token stopped working.')).not.toBeNull();
  });
});
