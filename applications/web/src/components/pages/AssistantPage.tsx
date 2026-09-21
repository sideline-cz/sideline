/**
 * Props-only page shell (design §1/§2.1) — no `Route.use*()`. Renders the `h1` + subtitle and
 * then EITHER the disabled state OR `AssistantConversation`; the disabled state replaces the
 * log and composer entirely, never a disabled input box (that looks broken and invites a dead
 * click).
 *
 * The ~6-line disabled state is inlined here per design §2.1/§6 (no independent reuse, no
 * props beyond nothing).
 */
import { Sparkles } from 'lucide-react';
import { AssistantConversation } from '~/components/organisms/assistant/AssistantConversation.js';
import { tr } from '~/lib/translations.js';

interface AssistantPageProps {
  teamId: string;
  enabled: boolean;
}

export function AssistantPage({ teamId, enabled }: AssistantPageProps) {
  return (
    <div className='flex flex-1 min-h-0 flex-col gap-4'>
      <div className='shrink-0'>
        <h1 className='text-2xl font-bold'>{tr('assistant_navTitle')}</h1>
        <p className='hidden text-sm text-muted-foreground sm:block'>
          {tr('assistant_pageSubtitle')}
        </p>
      </div>

      {enabled ? (
        <AssistantConversation teamId={teamId} />
      ) : (
        <div className='flex flex-1 flex-col items-center justify-center gap-3 text-center'>
          <Sparkles className='size-8 text-muted-foreground' aria-hidden='true' />
          <h2 className='text-lg font-semibold'>{tr('assistant_disabled_title')}</h2>
          <p className='max-w-md text-sm text-muted-foreground'>{tr('assistant_disabled_body')}</p>
        </div>
      )}
    </div>
  );
}
