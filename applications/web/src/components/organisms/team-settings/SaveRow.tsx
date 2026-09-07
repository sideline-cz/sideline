import { Button } from '~/components/ui/button';
import { tr } from '~/lib/translations.js';

interface SaveRowProps {
  onSave: () => void;
  saving: boolean;
  /** The dirty flag of the very form this button submits. */
  dirty: boolean;
  /** Extra reason the card cannot be saved at all (e.g. a disabled feature). */
  disabled?: boolean;
}

/**
 * A Save button plus its unsaved-changes hint. Taking both from one `CardForm`
 * at the call site is what keeps "the button is lit" and "the payload carries
 * the edit" the same question.
 */
export function SaveRow({ onSave, saving, dirty, disabled = false }: SaveRowProps) {
  return (
    <div className='flex items-center gap-3'>
      <Button onClick={onSave} disabled={saving || !dirty || disabled}>
        {saving ? tr('profile_saving') : tr('profile_saveChanges')}
      </Button>
      {dirty && (
        <p className='text-sm text-muted-foreground'>{tr('teamSettings_unsavedChanges')}</p>
      )}
    </div>
  );
}
