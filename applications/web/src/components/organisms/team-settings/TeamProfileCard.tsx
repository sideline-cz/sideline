import type { TeamApi } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { Users } from 'lucide-react';
import React from 'react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Textarea } from '~/components/ui/textarea';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';
import { SaveRow } from './SaveRow';
import { findInvalidProfileField, profileFormFrom, profileRequestFrom } from './teamInfoForm';
import { useCardForm } from './useCardForm';

interface TeamProfileCardProps {
  teamInfo: TeamApi.TeamInfo;
  onRefresh: () => void;
}

export function TeamProfileCard({ teamInfo, onRefresh }: TeamProfileCardProps) {
  const run = useRun();
  const form = useCardForm(profileFormFrom(teamInfo));
  const { values, setField } = form;
  const [saving, setSaving] = React.useState(false);

  const handleSave = React.useCallback(async () => {
    const invalidField = findInvalidProfileField(values);
    if (invalidField !== undefined) {
      toast.error(tr('teamSettings_fieldInvalid', { field: tr(invalidField) }));
      return;
    }

    setSaving(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.team.updateTeamInfo({
          params: { teamId: teamInfo.teamId },
          payload: profileRequestFrom(values),
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('teamSettings_profileSaveFailed'))),
      run({ success: tr('teamSettings_profileSaved') }),
    );
    setSaving(false);
    if (Option.isSome(result)) {
      onRefresh();
    }
  }, [teamInfo.teamId, values, run, onRefresh]);

  return (
    <Card>
      <CardHeader>
        <div className='flex items-center gap-2'>
          <Users className='size-4 text-muted-foreground' />
          <CardTitle className='text-base'>{tr('teamSettings_teamProfile')}</CardTitle>
        </div>
        <CardDescription>{tr('teamSettings_teamProfileDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className='flex flex-col gap-5'>
          {values.logoUrl.trim() && (
            <div className='flex justify-center'>
              <Avatar className='size-20'>
                <AvatarImage src={values.logoUrl.trim()} alt={values.teamName} />
                <AvatarFallback>{values.teamName.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
            </div>
          )}
          <div>
            <label htmlFor='team-name' className='text-sm font-medium mb-1 block'>
              {tr('teamSettings_teamName')}
            </label>
            <Input
              id='team-name'
              type='text'
              maxLength={100}
              value={values.teamName}
              onChange={(e) => setField('teamName', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor='team-description' className='text-sm font-medium mb-1 block'>
              {tr('teamSettings_description')}
            </label>
            <p className='text-xs text-muted-foreground mb-2'>
              {tr('teamSettings_descriptionHelp')}
            </p>
            <Textarea
              id='team-description'
              maxLength={500}
              rows={3}
              value={values.description}
              onChange={(e) => setField('description', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor='team-sport' className='text-sm font-medium mb-1 block'>
              {tr('teamSettings_sport')}
            </label>
            <p className='text-xs text-muted-foreground mb-2'>{tr('teamSettings_sportHelp')}</p>
            <Input
              id='team-sport'
              type='text'
              maxLength={50}
              value={values.sport}
              onChange={(e) => setField('sport', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor='team-logo-url' className='text-sm font-medium mb-1 block'>
              {tr('teamSettings_logoUrl')}
            </label>
            <p className='text-xs text-muted-foreground mb-2'>{tr('teamSettings_logoUrlHelp')}</p>
            <Input
              id='team-logo-url'
              type='url'
              maxLength={2048}
              value={values.logoUrl}
              onChange={(e) => setField('logoUrl', e.target.value)}
              placeholder='https://...'
            />
          </div>
          <SaveRow onSave={handleSave} saving={saving} dirty={form.isDirty} />
        </div>
      </CardContent>
    </Card>
  );
}
