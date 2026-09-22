import type { TeamSettingsApi } from '@sideline/domain';
import { Effect, Option } from 'effect';
import React from 'react';
import { toast } from 'sonner';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';
import { findInvalidSettingsField, settingsFormFrom, settingsRequestFrom } from './settingsForm';
import type { CardForm } from './useCardForm';
import { useCardForm } from './useCardForm';

/**
 * The one payload, one Save button shared by `GeneralLimitsCard`,
 * `RemindersCard`, `CoachAssignmentCard` and `DiscordDefaultsCard`. Lives
 * above the tabs — not inside a `TeamSettingsSection` organism — precisely so
 * a tab switch (general/discord) can never unmount it: the four cards render
 * across two different `TabsContent` panels, and unmounting either would
 * throw away the other's edits.
 */
export function useTeamSettingsForm(
  settings: TeamSettingsApi.TeamSettingsInfo,
  onRefresh: () => void,
): {
  form: CardForm<ReturnType<typeof settingsFormFrom>>;
  saving: boolean;
  handleSave: () => Promise<boolean>;
  handleDiscard: () => void;
} {
  const run = useRun();
  const form = useCardForm(settingsFormFrom(settings));
  const [saving, setSaving] = React.useState(false);

  const handleSave = React.useCallback(async () => {
    const invalidField = findInvalidSettingsField(form.values);
    if (invalidField !== undefined) {
      toast.error(tr('teamSettings_fieldInvalid', { field: tr(invalidField) }));
      return false;
    }

    setSaving(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.teamSettings.updateTeamSettings({
          params: { teamId: settings.teamId },
          payload: settingsRequestFrom(form.values),
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('teamSettings_saveFailed'))),
      run({ success: tr('teamSettings_saved') }),
    );
    setSaving(false);
    if (Option.isSome(result)) {
      onRefresh();
      return true;
    }
    return false;
  }, [settings.teamId, form.values, run, onRefresh]);

  const handleDiscard = React.useCallback(() => {
    form.reset(settingsFormFrom(settings));
  }, [form, settings]);

  return { form, saving, handleSave, handleDiscard };
}
