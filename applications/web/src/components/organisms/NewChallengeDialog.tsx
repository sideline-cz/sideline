import type { WeeklyChallenge } from '@sideline/domain';
import React from 'react';
import { MondayPicker } from '~/components/molecules/MondayPicker.js';
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

type WeeklyChallengeKind = WeeklyChallenge.WeeklyChallengeKind;

export interface NewChallengeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string;
  teamTimezone: string;
  existingWeekStarts: string[];
  onCreated: () => void;
  onSubmit?: (data: {
    weekStart: Date;
    kind: WeeklyChallengeKind;
    title: string;
    description: string | null;
  }) => Promise<{ _tag?: string } | undefined>;
}

/**
 * Returns the next available Monday (i.e. not in existingWeekStarts) starting
 * from the current Monday in the team timezone.
 *
 * Per plan §9 risk 5: construct as UTC-midnight of the local Monday.
 */
function getNextAvailableMonday(teamTz: string, existingWeekStarts: string[]): Date {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: teamTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const now = new Date();
  const parts = formatter.formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')?.value ?? 0);
  const month = Number(parts.find((p) => p.type === 'month')?.value ?? 1) - 1;
  const day = Number(parts.find((p) => p.type === 'day')?.value ?? 1);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dow = weekdayMap[weekday] ?? 1;
  const offset = dow === 0 ? 6 : dow - 1;
  const mondayDay = day - offset;
  const currentMonday = new Date(Date.UTC(year, month, mondayDay));

  // Find the next Monday not in existingWeekStarts (within 8 weeks)
  for (let w = 0; w <= 8; w++) {
    const candidate = new Date(currentMonday);
    candidate.setUTCDate(candidate.getUTCDate() + w * 7);
    const dateStr = `${candidate.getUTCFullYear()}-${String(candidate.getUTCMonth() + 1).padStart(2, '0')}-${String(candidate.getUTCDate()).padStart(2, '0')}`;
    if (!existingWeekStarts.includes(dateStr)) {
      return candidate;
    }
  }
  // Fallback: current monday
  return currentMonday;
}

export function NewChallengeDialog({
  open,
  onOpenChange,
  teamId: _teamId,
  teamTimezone,
  existingWeekStarts,
  onCreated,
  onSubmit,
}: NewChallengeDialogProps) {
  const defaultMonday = React.useMemo(
    () => getNextAvailableMonday(teamTimezone, existingWeekStarts),
    [teamTimezone, existingWeekStarts],
  );

  const [kind, setKind] = React.useState<WeeklyChallengeKind>('throwing');
  const [weekStart, setWeekStart] = React.useState<Date | undefined>(defaultMonday);
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [inlineError, setInlineError] = React.useState<string | null>(null);

  // Reset state when dialog opens
  React.useEffect(() => {
    if (open) {
      setKind('throwing');
      setWeekStart(getNextAvailableMonday(teamTimezone, existingWeekStarts));
      setTitle('');
      setDescription('');
      setIsSubmitting(false);
      setInlineError(null);
    }
  }, [open, teamTimezone, existingWeekStarts]);

  const isTitleValid = title.length > 0 && title.length <= 120;
  const isTitleTooLong = title.length > 120;
  const isSubmitDisabled = !isTitleValid || !weekStart || isSubmitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitDisabled || !weekStart) return;

    setIsSubmitting(true);
    setInlineError(null);

    try {
      if (onSubmit) {
        const result = await onSubmit({
          weekStart,
          kind,
          title,
          description: description || null,
        });
        if (result && typeof result === 'object' && '_tag' in result) {
          const tag = result._tag;
          if (tag === 'WeeklyChallengeAlreadyExistsForWeek') {
            setInlineError(tr('challenges_error_alreadyExists'));
            setIsSubmitting(false);
            return;
          }
          if (tag === 'WeeklyChallengeWeekOutOfRange') {
            setInlineError(tr('challenges_error_outOfRange'));
            setIsSubmitting(false);
            return;
          }
        }
      }
      onCreated();
      onOpenChange(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('WeeklyChallengeAlreadyExistsForWeek')) {
        setInlineError(tr('challenges_error_alreadyExists'));
      } else if (message.includes('WeeklyChallengeWeekOutOfRange')) {
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

          {/* Week picker */}
          <div className='flex flex-col gap-1.5'>
            <Label>{tr('challenges_newDialog_weekLabel')}</Label>
            <p className='text-xs text-muted-foreground'>{tr('challenges_newDialog_weekHelp')}</p>
            <div className='border rounded-md overflow-hidden'>
              <MondayPicker
                teamTz={teamTimezone}
                existingWeekStarts={existingWeekStarts}
                value={weekStart}
                onChange={setWeekStart}
              />
            </div>
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
