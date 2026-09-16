import type { BankTransaction } from '@sideline/domain';
import {
  ArrowDownRight,
  ArrowUpRight,
  Ban,
  CheckCheck,
  Coins,
  CopyCheck,
  HelpCircle,
  Layers,
  type LucideIcon,
  Users,
} from 'lucide-react';
import { tr } from '~/lib/translations.js';

type MatchReason = BankTransaction.BankTransactionMatchReason;

/**
 * The nine reasons a transaction failed to auto-match, keyed off the IMPORTED domain union
 * (`BankTransaction.BankTransactionMatchReason`) — never invented here. Per `AGENTS.md`'s
 * closed-union rule, every entry calls `tr()` with a literal string key inside an explicit
 * `Record<MatchReason, () => string>`: adding a reason to the engine fails the web build until
 * its Czech copy exists here, instead of shipping a raw key to the treasurer's screen.
 */
export const matchReasonLabels: Record<MatchReason, () => string> = {
  no_vs: () => tr('bank_reason_noVs'),
  no_member_for_vs: () => tr('bank_reason_noMemberForVs'),
  ambiguous_member: () => tr('bank_reason_ambiguousMember'),
  amount_mismatch_under: () => tr('bank_reason_amountMismatchUnder'),
  overpayment: () => tr('bank_reason_overpayment'),
  ambiguous_multiple_exact: () => tr('bank_reason_ambiguousMultipleExact'),
  ambiguous_multiple_open: () => tr('bank_reason_ambiguousMultipleOpen'),
  no_open_assignment: () => tr('bank_reason_noOpenAssignment'),
  currency_mismatch: () => tr('bank_reason_currencyMismatch'),
};

/** A distinct lucide glyph per reason — none shared (design §3.5 / §8.1). */
export const matchReasonIcons: Record<MatchReason, LucideIcon> = {
  no_vs: Ban,
  no_member_for_vs: HelpCircle,
  ambiguous_member: Users,
  amount_mismatch_under: ArrowDownRight,
  overpayment: ArrowUpRight,
  ambiguous_multiple_exact: CopyCheck,
  ambiguous_multiple_open: Layers,
  no_open_assignment: CheckCheck,
  currency_mismatch: Coins,
};

/**
 * Dashed border on the four "ambiguous, needs a judgement call" reasons, solid on the rest — a
 * shape channel that survives greyscale (design §3.5, the `RoleBadge.tsx` precedent).
 */
export const matchReasonDashed: Record<MatchReason, boolean> = {
  no_vs: false,
  no_member_for_vs: false,
  ambiguous_member: true,
  amount_mismatch_under: false,
  overpayment: false,
  ambiguous_multiple_exact: true,
  ambiguous_multiple_open: true,
  no_open_assignment: true,
  currency_mismatch: false,
};

/** Minimal shape the queue row / hint line needs — a subset of `BankSyncApi.BankTransactionView`
 * kept local so this stays a pure, framework-free helper (AGENTS.md "Pure Helpers"). */
export interface MatchReasonHintRow {
  readonly matchReason: MatchReason | null;
  readonly matchedMemberName: string | null;
  readonly variableSymbol: string | null;
  readonly duplicateOfTransactionId: string | null;
  readonly duplicateOfDate?: string | null;
}

/**
 * The one-line explanation under the badge (design §3.5) — best-effort from the LIST row's own
 * fields. The list DTO (`BankTransactionView`) does not carry candidate-assignment amounts, so
 * the exact "due X / paid Y / missing Z" figures for the amount-mismatch and ambiguity reasons
 * only become available from the per-row detail fetch (the "Zobrazit detail pohybu" sheet); this
 * function renders what the list already has (the resolved member's name, the VS, the duplicate
 * hint) and returns `undefined` when there is nothing more specific to say without that fetch.
 */
export function matchReasonHint(row: MatchReasonHintRow): string | undefined {
  if (row.matchReason === null) return undefined;

  switch (row.matchReason) {
    case 'no_vs':
      return row.matchedMemberName
        ? tr('bank_reason_noVsHintGuess', {
            member: row.matchedMemberName,
            vs: row.variableSymbol ?? '',
          })
        : tr('bank_reason_noVsHintNone');
    case 'no_member_for_vs':
      return tr('bank_reason_noMemberForVsHint', { vs: row.variableSymbol ?? '' });
    case 'no_open_assignment':
      return row.matchedMemberName
        ? tr('bank_reason_noOpenAssignmentHint', { member: row.matchedMemberName })
        : undefined;
    default:
      return row.matchedMemberName ? undefined : undefined;
  }
}

/** The duplicate hint (design §3.5 note 2) — a hint on `no_open_assignment`, never its own
 * `match_reason`. Rendered separately from `matchReasonHint` so the "[Zobrazit původní]" action
 * can sit right beside it. */
export function duplicateHint(row: MatchReasonHintRow): string | undefined {
  if (row.duplicateOfTransactionId === null) return undefined;
  return tr('bank_reason_duplicateHint', { date: row.duplicateOfDate ?? '' });
}
