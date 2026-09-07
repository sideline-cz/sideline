import type { GroupApi, TeamSettingsApi } from '@sideline/domain';
import { Effect, Option } from 'effect';
import React from 'react';
import { toast } from 'sonner';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';
import { CoachAssignmentCard } from './CoachAssignmentCard';
import { DiscordDefaultsCard } from './DiscordDefaultsCard';
import { GeneralLimitsCard } from './GeneralLimitsCard';
import { RemindersCard } from './RemindersCard';
import { SaveRow } from './SaveRow';
import { findInvalidSettingsField, settingsFormFrom, settingsRequestFrom } from './settingsForm';
import { useCardForm } from './useCardForm';

interface TeamSettingsSectionProps {
  settings: TeamSettingsApi.TeamSettingsInfo;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
  groups: ReadonlyArray<GroupApi.GroupInfo>;
  onRefresh: () => void;
}

/**
 * The four cards saved by `updateTeamSettings`, and the one Save button that
 * saves them. The cards are presentational — they read and write `form` and
 * own no dirty flag or handler of their own, so a field cannot end up wired to
 * a button that does not send it.
 */
export function TeamSettingsSection({
  settings,
  discordChannels,
  groups,
  onRefresh,
}: TeamSettingsSectionProps) {
  const run = useRun();
  const form = useCardForm(settingsFormFrom(settings));
  const [saving, setSaving] = React.useState(false);

  const handleSave = React.useCallback(async () => {
    const invalidField = findInvalidSettingsField(form.values);
    if (invalidField !== undefined) {
      toast.error(tr('teamSettings_fieldInvalid', { field: tr(invalidField) }));
      return;
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
    }
  }, [settings.teamId, form.values, run, onRefresh]);

  return (
    <>
      <GeneralLimitsCard form={form} />
      <RemindersCard form={form} discordChannels={discordChannels} />
      <CoachAssignmentCard form={form} />
      <DiscordDefaultsCard form={form} discordChannels={discordChannels} groups={groups} />
      <SaveRow onSave={handleSave} saving={saving} dirty={form.isDirty} />
    </>
  );
}
