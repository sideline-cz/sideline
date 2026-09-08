import type { TeamGenerationApi } from '@sideline/domain';
import { Team, TeamGenerationConfig } from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import React from 'react';
import { WeightSliderField } from '~/components/molecules/WeightSliderField.js';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Separator } from '~/components/ui/separator';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';
import {
  generationWeightsFormFrom,
  generationWeightsRequestFrom,
  hasGenerationWeightsErrors,
  validateGenerationWeights,
} from './generationWeightsForm';
import { useCardForm } from './useCardForm';

// Defaults imported from domain so "Reset to defaults" always matches server defaults
const DEFAULT_WEIGHT_ELO = TeamGenerationConfig.DEFAULT_WEIGHT_ELO;
const DEFAULT_WEIGHT_SIZE = TeamGenerationConfig.DEFAULT_WEIGHT_SIZE;
const DEFAULT_WEIGHT_GENDER = TeamGenerationConfig.DEFAULT_WEIGHT_GENDER;
const DEFAULT_TEAM_COUNT = TeamGenerationConfig.DEFAULT_TEAM_COUNT;
const DEFAULT_MAX_ITERATIONS = TeamGenerationConfig.DEFAULT_MAX_ITERATIONS;

interface GenerationWeightsCardProps {
  teamId: string;
  initialConfig: TeamGenerationApi.GenerationConfigResponse;
  onRefresh: () => void;
}

export function GenerationWeightsCard({
  teamId,
  initialConfig,
  onRefresh,
}: GenerationWeightsCardProps) {
  const run = useRun();

  const form = useCardForm(generationWeightsFormFrom(initialConfig));
  const { setField } = form;
  const { weightElo, weightSize, weightGender, defaultTeamCount, maxIterations } = form.values;
  const [saving, setSaving] = React.useState(false);

  const totalWeight = weightElo + weightSize + weightGender;
  const eloPercent = totalWeight > 0 ? Math.round((weightElo / totalWeight) * 100) : 0;
  const sizePercent = totalWeight > 0 ? Math.round((weightSize / totalWeight) * 100) : 0;
  const genderPercent = totalWeight > 0 ? 100 - eloPercent - sizePercent : 0;

  const errors = validateGenerationWeights(form.values);
  const isValid = !hasGenerationWeightsErrors(errors);

  const handleSave = async () => {
    // Unreachable from the UI — Save is disabled while invalid — but the
    // payload builder assumes the numbers parse, so keep the guard.
    if (!isValid) return;
    setSaving(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.teamGeneration.updateGenerationConfig({
          params: { teamId: Schema.decodeSync(Team.TeamId)(teamId) },
          payload: generationWeightsRequestFrom(form.values),
        }),
      ),
      Effect.catchTag('TeamGenerationForbidden', () =>
        Effect.fail(ClientError.make(tr('teamGenSettings_saveFailed'))),
      ),
      Effect.mapError(() => ClientError.make(tr('teamGenSettings_saveFailed'))),
      run({ success: tr('teamGenSettings_saved') }),
    );
    setSaving(false);
    if (Option.isSome(result)) {
      onRefresh();
    }
  };

  const handleResetToDefaults = React.useCallback(() => {
    setField('weightElo', DEFAULT_WEIGHT_ELO);
    setField('weightSize', DEFAULT_WEIGHT_SIZE);
    setField('weightGender', DEFAULT_WEIGHT_GENDER);
    setField('defaultTeamCount', String(DEFAULT_TEAM_COUNT));
    setField('maxIterations', String(DEFAULT_MAX_ITERATIONS));
  }, [setField]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>{tr('teamGenSettings_title')}</CardTitle>
        <p className='text-sm text-muted-foreground'>{tr('teamGenSettings_description')}</p>
      </CardHeader>
      <CardContent>
        <div className='flex flex-col gap-5'>
          <WeightSliderField
            id='weight-elo'
            label={tr('teamGenSettings_weightElo')}
            description={tr('teamGenSettings_weightEloDescription')}
            value={weightElo}
            onChange={(v) => setField('weightElo', v)}
            disabled={saving}
          />
          <WeightSliderField
            id='weight-size'
            label={tr('teamGenSettings_weightSize')}
            description={tr('teamGenSettings_weightSizeDescription')}
            value={weightSize}
            onChange={(v) => setField('weightSize', v)}
            disabled={saving}
          />
          <WeightSliderField
            id='weight-gender'
            label={tr('teamGenSettings_weightGender')}
            description={tr('teamGenSettings_weightGenderDescription')}
            value={weightGender}
            onChange={(v) => setField('weightGender', v)}
            disabled={saving}
          />

          <p
            aria-live='polite'
            className='text-xs text-muted-foreground rounded-md border bg-muted/40 px-3 py-2'
          >
            {tr('teamGenSettings_normalizedReadout', {
              eloPercent,
              sizePercent,
              genderPercent,
            })}
          </p>

          <Separator />

          <div>
            <label htmlFor='default-team-count' className='text-sm font-medium mb-1 block'>
              {tr('teamGenSettings_defaultTeamCount')}
            </label>
            <p className='text-xs text-muted-foreground mb-2'>
              {tr('teamGenSettings_defaultTeamCountDescription')}
            </p>
            <Input
              id='default-team-count'
              type='number'
              min={2}
              max={20}
              value={defaultTeamCount}
              onChange={(e) => setField('defaultTeamCount', e.target.value)}
              disabled={saving}
              className='max-w-32'
              aria-invalid={errors.defaultTeamCount !== undefined}
              aria-describedby={errors.defaultTeamCount ? 'default-team-count-error' : undefined}
            />
            {errors.defaultTeamCount && (
              <p id='default-team-count-error' className='text-xs text-destructive mt-1'>
                {tr(errors.defaultTeamCount)}
              </p>
            )}
          </div>

          <div>
            <label htmlFor='max-iterations' className='text-sm font-medium mb-1 block'>
              {tr('teamGenSettings_maxIterations')}
            </label>
            <p className='text-xs text-muted-foreground mb-2'>
              {tr('teamGenSettings_maxIterationsDescription')}
            </p>
            <Input
              id='max-iterations'
              type='number'
              min={0}
              max={10000}
              value={maxIterations}
              onChange={(e) => setField('maxIterations', e.target.value)}
              disabled={saving}
              className='max-w-32'
              aria-invalid={errors.maxIterations !== undefined}
              aria-describedby={errors.maxIterations ? 'max-iterations-error' : undefined}
            />
            {errors.maxIterations && (
              <p id='max-iterations-error' className='text-xs text-destructive mt-1'>
                {tr(errors.maxIterations)}
              </p>
            )}
          </div>

          <div className='flex items-center gap-3'>
            <Button onClick={handleSave} disabled={saving || !form.isDirty || !isValid}>
              {saving ? tr('teamGenSettings_saving') : tr('teamGenSettings_save')}
            </Button>
            <Button variant='ghost' size='sm' onClick={handleResetToDefaults} disabled={saving}>
              {tr('teamGenSettings_resetToDefaults')}
            </Button>
            {form.isDirty && (
              <p className='text-sm text-muted-foreground'>{tr('teamSettings_unsavedChanges')}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
