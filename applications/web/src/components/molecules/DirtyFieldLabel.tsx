import { FormLabel } from '~/components/ui/form';
import { tr } from '~/lib/translations.js';

interface DirtyFieldLabelProps {
  readonly label: string;
  readonly dirty: boolean;
}

/**
 * Promoted out of `PlayerDetailPage.tsx` (per `AGENTS.md`): the variable-symbol field is its
 * third consumer, and copying the dot + `sr-only` pairing a third time is how the `sr-only` half
 * gets dropped. Marks a React-Hook-Form field's label with a small dirty dot — `aria-hidden`,
 * paired with an `sr-only` announcement so a screen-reader user gets the same signal.
 */
export function DirtyFieldLabel({ label, dirty }: DirtyFieldLabelProps) {
  return (
    <FormLabel className='flex items-center gap-1.5'>
      {label}
      {dirty ? (
        <>
          <span className='inline-block size-1.5 rounded-full bg-warning' aria-hidden='true' />
          <span className='sr-only'>{tr('form_fieldChanged')}</span>
        </>
      ) : null}
    </FormLabel>
  );
}
