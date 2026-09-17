import type { BankSyncApi } from '@sideline/domain';
import {
  AlertTriangle,
  CheckCircle,
  Hourglass,
  Landmark,
  Lock,
  type LucideIcon,
  RefreshCw,
  ServerCrash,
} from 'lucide-react';
import { tr } from '~/lib/translations.js';

type TestStatus = BankSyncApi.BankSyncTestStatus;

/**
 * The seven outcomes of ONE `/bank-sync/test` probe, keyed off the IMPORTED domain union
 * (`BankSyncApi.BankSyncTestStatus`) — never invented here. Per `applications/web/AGENTS.md`'s
 * "Closed-Union Copy Comes From An Explicit `Record`" rule, every entry calls `tr()` with a
 * literal string key: adding a status to the server union then fails the web build until its
 * copy exists here, instead of shipping a raw key to the treasurer's screen. Never
 * `` tr(`fio_test_${status}`) `` — `tr()` does not throw on an unknown key, and the wire literals
 * are snake_case while the i18n keys are camelCase, so a template would miss every branch.
 *
 * `misconfigured` and `no_token` reuse the existing `fio_status_*` copy (i18n rule 6 — do not
 * re-mint a translation that already says the same thing).
 */
export const TEST_RESULT_META: Record<
  TestStatus,
  {
    readonly Icon: LucideIcon;
    readonly variant: 'default' | 'warning' | 'destructive';
    readonly title: () => string;
    readonly body: () => string;
  }
> = {
  ok: {
    Icon: CheckCircle,
    variant: 'default',
    title: () => tr('fio_test_okTitle'),
    body: () => tr('fio_test_okBody'),
  },
  invalid: {
    Icon: AlertTriangle,
    variant: 'destructive',
    title: () => tr('fio_test_invalidTitle'),
    body: () => tr('fio_test_invalidBody'),
  },
  rate_limited: {
    Icon: Hourglass,
    variant: 'warning',
    title: () => tr('fio_test_rateLimitedTitle'),
    body: () => tr('fio_test_rateLimitedBody'),
  },
  history_locked: {
    Icon: Lock,
    variant: 'warning',
    title: () => tr('fio_test_historyLockedTitle'),
    body: () => tr('fio_test_historyLockedBody'),
  },
  unreachable: {
    Icon: RefreshCw,
    variant: 'warning',
    title: () => tr('fio_test_unreachableTitle'),
    body: () => tr('fio_test_unreachableBody'),
  },
  misconfigured: {
    Icon: ServerCrash,
    variant: 'destructive',
    title: () => tr('fio_status_misconfiguredTitle'),
    body: () => tr('fio_status_misconfiguredBody'),
  },
  no_token: {
    Icon: Landmark,
    variant: 'default',
    title: () => tr('fio_status_notConnectedTitle'),
    body: () => tr('fio_status_notConnectedBody'),
  },
};
