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
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

export interface EditChallengeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTitle: string;
  initialDescription: string | null;
  onSaved: () => void;
  onSubmit?: (data: { title: string; description: string | null }) => Promise<void>;
}

export function EditChallengeDialog({
  open,
  onOpenChange,
  initialTitle,
  initialDescription,
  onSaved,
  onSubmit,
}: EditChallengeDialogProps) {
  const [title, setTitle] = React.useState(initialTitle);
  const [description, setDescription] = React.useState(initialDescription ?? '');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // Sync initial values when dialog opens
  React.useEffect(() => {
    if (open) {
      setTitle(initialTitle);
      setDescription(initialDescription ?? '');
      setIsSubmitting(false);
      setSubmitError(null);
    }
  }, [open, initialTitle, initialDescription]);

  const isTitleValid = title.length > 0 && title.length <= 120;
  const isTitleTooLong = title.length > 120;
  const isSubmitDisabled = !isTitleValid || isSubmitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitDisabled) return;

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      if (onSubmit) {
        await onSubmit({ title, description: description || null });
      }
      onSaved();
      onOpenChange(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setSubmitError(message || tr('challenges_error_notFound'));
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-md'>
        <DialogHeader>
          <DialogTitle>{tr('challenges_editDialog_title')}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className='flex flex-col gap-4'>
          {/* Title */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='edit-challenge-title'>{tr('challenges_newDialog_titleLabel')}</Label>
            <Input
              id='edit-challenge-title'
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={tr('challenges_newDialog_titlePlaceholder')}
              maxLength={121}
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
            <Label htmlFor='edit-challenge-desc'>{tr('challenges_newDialog_descLabel')}</Label>
            <Textarea
              id='edit-challenge-desc'
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

          {submitError && <p className='text-sm text-destructive'>{submitError}</p>}

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
              {tr('challenges_editDialog_submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
