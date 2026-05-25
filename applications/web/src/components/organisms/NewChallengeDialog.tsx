import type { TeamChallenge } from '@sideline/domain';
import React from 'react';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Textarea } from '~/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

type TeamChallengeKind = TeamChallenge.TeamChallengeKind;

export interface NewChallengeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string;
  teamTimezone: string;
  existingStartDates: string[];
  onCreated: () => void;
  onSubmit?: (data: {
    startDate: Date;
    endDate: Date;
    kind: TeamChallengeKind;
    title: string;
    description: string | null;
  }) => Promise<{ _tag?: string } | undefined>;
}

/**
 * Returns today's date as a YYYY-MM-DD string in the given IANA timezone.
 */
function todayInTz(teamTz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: teamTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Adds days to a YYYY-MM-DD date string.
 */
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Parses a YYYY-MM-DD string as a UTC-midnight Date.
 */
function parseDateStr(str: string): Date {
  const [y, m, d] = str.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

export function NewChallengeDialog({
  open,
  onOpenChange,
  teamId: _teamId,
  teamTimezone,
  existingStartDates: _existingStartDates,
  onCreated,
  onSubmit,
}: NewChallengeDialogProps) {
  const today = React.useMemo(() => todayInTz(teamTimezone), [teamTimezone]);
  const defaultStart = today;
  const defaultEnd = addDays(today, 6);

  const [kind, setKind] = React.useState<TeamChallengeKind>('throwing');
  const [startDateStr, setStartDateStr] = React.useState<string>(defaultStart);
  const [endDateStr, setEndDateStr] = React.useState<string>(defaultEnd);
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [inlineError, setInlineError] = React.useState<string | null>(null);

  // Reset state when dialog opens
  React.useEffect(() => {
    if (open) {
      const t = todayInTz(teamTimezone);
      setKind('throwing');
      setStartDateStr(t);
      setEndDateStr(addDays(t, 6));
      setTitle('');
      setDescription('');
      setIsSubmitting(false);
      setInlineError(null);
    }
  }, [open, teamTimezone]);

  // When startDate changes, keep endDate >= startDate
  const handleStartDateChange = (value: string) => {
    setStartDateStr(value);
    if (endDateStr < value) {
      setEndDateStr(value);
    }
  };

  const isTitleValid = title.length > 0 && title.length <= 120;
  const isTitleTooLong = title.length > 120;
  const isDateRangeValid = startDateStr <= endDateStr;
  const isSubmitDisabled = !isTitleValid || !isDateRangeValid || isSubmitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitDisabled) return;

    setIsSubmitting(true);
    setInlineError(null);

    try {
      if (onSubmit) {
        const result = await onSubmit({
          startDate: parseDateStr(startDateStr),
          endDate: parseDateStr(endDateStr),
          kind,
          title,
          description: description || null,
        });
        if (result && typeof result === 'object' && '_tag' in result) {
          const tag = result._tag;
          if (tag === 'TeamChallengeAlreadyExistsForWeek') {
            setInlineError(tr('challenges_error_alreadyExists'));
            setIsSubmitting(false);
            return;
          }
          if (tag === 'TeamChallengeStartDateOutOfRange') {
            setInlineError(tr('challenges_error_outOfRange'));
            setIsSubmitting(false);
            return;
          }
          // Unrecognized error tag — show generic error and keep dialog open
          setInlineError(tr('challenges_error_generic'));
          setIsSubmitting(false);
          return;
        }
      }
      onCreated();
      onOpenChange(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('TeamChallengeAlreadyExistsForWeek')) {
        setInlineError(tr('challenges_error_alreadyExists'));
      } else if (message.includes('TeamChallengeStartDateOutOfRange')) {
        setInlineError(tr('challenges_error_outOfRange'));
      } else {
        setInlineError(tr('challenges_error_forbidden'));
      }
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-md overflow-y-auto max-h-[90vh]'>
        <DialogHeader>
          <DialogTitle>{tr('challenges_newDialog_title')}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className='flex flex-col gap-4'>
          {/* Kind */}
          <div className='flex flex-col gap-1.5'>
            <Label>{tr('challenges_newDialog_kindLabel')}</Label>
            <ToggleGroup
              type='single'
              value={kind}
              onValueChange={(v) => {
                if (v === 'throwing' || v === 'sport') setKind(v);
              }}
              variant='outline'
            >
              <ToggleGroupItem value='throwing'>
                🥏 {tr('challenges_kind_throwing')}
              </ToggleGroupItem>
              <ToggleGroupItem value='sport'>🏃 {tr('challenges_kind_sport')}</ToggleGroupItem>
            </ToggleGroup>
          </div>

          {/* Start date */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='challenge-start-date'>
              {tr('challenges_newDialog_startDateLabel')}
            </Label>
            <p className='text-xs text-muted-foreground'>
              {tr('challenges_newDialog_startDateHelp')}
            </p>
            <Input
              id='challenge-start-date'
              type='date'
              value={startDateStr}
              onChange={(e) => handleStartDateChange(e.target.value)}
            />
          </div>

          {/* End date */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='challenge-end-date'>{tr('challenges_newDialog_endDateLabel')}</Label>
            <p className='text-xs text-muted-foreground'>
              {tr('challenges_newDialog_endDateHelp')}
            </p>
            <Input
              id='challenge-end-date'
              type='date'
              value={endDateStr}
              min={startDateStr}
              onChange={(e) => setEndDateStr(e.target.value)}
            />
            {inlineError && <p className='text-sm text-destructive'>{inlineError}</p>}
          </div>

          {/* Title */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='challenge-title'>{tr('challenges_newDialog_titleLabel')}</Label>
            <Input
              id='challenge-title'
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={tr('challenges_newDialog_titlePlaceholder')}
              maxLength={121} // allow typing past 120 to show counter error
            />
            <p
              className={cn(
                'text-xs text-right',
                isTitleTooLong ? 'text-destructive font-medium' : 'text-muted-foreground',
              )}
            >
              {tr('challenges_newDialog_titleCounter', { n: title.length })}
            </p>
          </div>

          {/* Description */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='challenge-desc'>{tr('challenges_newDialog_descLabel')}</Label>
            <Textarea
              id='challenge-desc'
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={tr('challenges_newDialog_descPlaceholder')}
              rows={3}
              maxLength={2000}
            />
            <p className='text-xs text-right text-muted-foreground'>
              {tr('challenges_newDialog_descCounter', { n: description.length })}
            </p>
          </div>

          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              {tr('challenges_newDialog_cancel')}
            </Button>
            <Button type='submit' disabled={isSubmitDisabled}>
              {tr('challenges_newDialog_submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
