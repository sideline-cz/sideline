/**
 * Shown when the conversation has no turns yet (design §2.3). All four suggested prompts are
 * read-only and genuinely answerable by the six shipped tools (`current_datetime`,
 * `list_events`, `list_training_types`, `list_groups`, `list_members`, `list_rosters`) without
 * any elevated permission — a plain member (the default `Player` role) can run every one of
 * them, so there is no permission-dependent swap. `list_groups` is deliberately never used here:
 * it requires `group:manage`, which a plain player lacks. Clicking a suggestion fills the
 * composer and focuses it; it does not send.
 */
import { Sparkles } from 'lucide-react';
import { Button } from '~/components/ui/button.js';
import { useIsMobile } from '~/hooks/use-mobile.js';
import { tr } from '~/lib/translations.js';

interface AssistantEmptyStateProps {
  onPickPrompt: (prompt: string) => void;
}

export function AssistantEmptyState({ onPickPrompt }: AssistantEmptyStateProps) {
  const isMobile = useIsMobile();

  // On mobile, drop the aggregate example so the empty state + composer fit an average phone
  // viewport without scrolling (design §8).
  const suggestions = [
    tr('assistant_suggestion_rsvp'),
    tr('assistant_suggestion_filter'),
    tr('assistant_suggestion_attendance'),
    ...(isMobile ? [] : [tr('assistant_suggestion_aggregate')]),
  ];

  return (
    <div className='flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center'>
      <Sparkles className='size-8 text-muted-foreground' aria-hidden='true' />
      <h2 className='text-lg font-semibold'>{tr('assistant_empty_title')}</h2>
      <p className='max-w-md text-center text-sm text-muted-foreground'>
        {tr('assistant_empty_body')}
      </p>
      <p className='text-xs font-medium text-muted-foreground'>
        {tr('assistant_empty_suggestionsLabel')}
      </p>
      <div className='grid w-full max-w-xl gap-2 sm:grid-cols-2'>
        {suggestions.map((suggestion) => (
          <Button
            key={suggestion}
            type='button'
            variant='outline'
            className='h-auto justify-start whitespace-normal py-3 text-left text-sm'
            onClick={() => onPickPrompt(suggestion)}
          >
            {suggestion}
          </Button>
        ))}
      </div>
    </div>
  );
}
