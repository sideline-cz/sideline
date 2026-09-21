import type { BankSyncApi, Roster } from '@sideline/domain';
import { Team } from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface AssignVariableSymbolsDialogProps {
  readonly open: boolean;
  readonly teamId: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAssigned: (updated: ReadonlyArray<Roster.RosterPlayer>) => void;
}

/**
 * Preview-then-apply bulk auto-assign (design §5.3) — never a blind bulk write. Fetches the
 * proposed `{year}{seq3}` pairs on open, shows them, and only calls the assign endpoint on
 * explicit confirmation.
 */
export function AssignVariableSymbolsDialog({
  open,
  teamId,
  onOpenChange,
  onAssigned,
}: AssignVariableSymbolsDialogProps) {
  const run = useRun();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const [suggestions, setSuggestions] = React.useState<
    ReadonlyArray<BankSyncApi.VariableSymbolSuggestion>
  >([]);
  const [loading, setLoading] = React.useState(false);
  const [assigning, setAssigning] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.bankSync.suggestVariableSymbols({ params: { teamId: teamIdBranded } }),
        ),
        Effect.mapError(() => ClientError.make(tr('members_saveFailed'))),
        run({}),
      );
      if (cancelled) return;
      setSuggestions(Option.getOrElse(result, () => []));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, teamIdBranded, run]);

  const handleConfirm = async () => {
    if (suggestions.length === 0) return;
    setAssigning(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.bankSync.assignVariableSymbols({
          params: { teamId: teamIdBranded },
          payload: {
            assignments: suggestions.map((s) => ({
              memberId: s.memberId,
              variableSymbol: s.suggestedVariableSymbol,
            })),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('members_saveFailed'))),
      run({ success: tr('members_vs_assignSuccess') }),
    );
    setAssigning(false);
    if (Option.isSome(result)) {
      onOpenChange(false);
      onAssigned(result.value);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tr('members_vs_assignTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {tr('members_vs_assignBody', { count: suggestions.length })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {loading ? (
          <p className='text-sm text-muted-foreground'>{tr('loading_text')}</p>
        ) : (
          <ul className='flex flex-col gap-1 text-sm max-h-64 overflow-y-auto'>
            {suggestions.map((s) => (
              <li key={s.memberId} className='flex items-center justify-between gap-4'>
                <span>{Option.getOrElse(s.memberName, () => tr('members_fieldEmpty'))}</span>
                <span className='tabular-nums font-mono'>{s.suggestedVariableSymbol}</span>
              </li>
            ))}
          </ul>
        )}

        <p className='text-xs text-muted-foreground'>{tr('members_vs_assignNote')}</p>

        <AlertDialogFooter>
          <AlertDialogCancel>{tr('common_cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={assigning || loading || suggestions.length === 0}
          >
            {tr('members_vs_assignConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
