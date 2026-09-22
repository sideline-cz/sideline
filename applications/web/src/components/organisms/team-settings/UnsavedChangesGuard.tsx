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
import { tr } from '~/lib/translations.js';

interface UnsavedChangesGuardProps {
  readonly open: boolean;
  readonly onStay: () => void;
  readonly onLeave: () => void;
}

/**
 * A dumb confirmation dialog for `useBlocker`'s `status === 'blocked'` state.
 * No router hooks here — the page owns `useBlocker` and hands down the three
 * primitives this needs (`applications/web/AGENTS.md` forbids router hooks
 * inside organisms).
 */
export function UnsavedChangesGuard({ open, onStay, onLeave }: UnsavedChangesGuardProps) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onStay()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tr('teamSettings_leaveGuard_title')}</AlertDialogTitle>
          <AlertDialogDescription>{tr('teamSettings_leaveGuard_body')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onStay}>
            {tr('teamSettings_leaveGuard_stay')}
          </AlertDialogCancel>
          <AlertDialogAction variant='destructive' onClick={onLeave}>
            {tr('teamSettings_leaveGuard_leave')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
