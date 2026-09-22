/**
 * The uncited references (design §3.5), rendered as `AssistantResultCard` rows. Five rows
 * visible; beyond that, a link-styled `Button` expands the rest in place — no request, no
 * navigation, since the wire carries no `total` to build a real "show all" destination from.
 */
import type { AiChatApi } from '@sideline/domain';
import React from 'react';
import { AssistantResultCard } from '~/components/molecules/assistant/AssistantResultCard.js';
import { Button } from '~/components/ui/button.js';
import { tr } from '~/lib/translations.js';

const VISIBLE_LIMIT = 5;

interface AssistantResultListProps {
  references: ReadonlyArray<AiChatApi.EntityRef>;
  teamId: string;
}

export function AssistantResultList({ references, teamId }: AssistantResultListProps) {
  const [expanded, setExpanded] = React.useState(false);
  const listRef = React.useRef<HTMLUListElement>(null);

  React.useEffect(() => {
    if (!expanded) return;
    // Move focus to the first newly-revealed row so keyboard users are not dropped back at the
    // top of the list (design §3.5 / §5).
    const links = listRef.current?.querySelectorAll('a');
    links?.[VISIBLE_LIMIT]?.focus();
  }, [expanded]);

  if (references.length === 0) return null;

  const visible = expanded ? references : references.slice(0, VISIBLE_LIMIT);
  const hiddenCount = references.length - visible.length;

  return (
    <div>
      <h2 className='sr-only'>{tr('assistant_results_label')}</h2>
      <ul ref={listRef} className='flex flex-col gap-1.5'>
        {visible.map((reference) => (
          <li key={reference.ref}>
            <AssistantResultCard reference={reference} teamId={teamId} />
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <Button
          type='button'
          variant='link'
          size='sm'
          className='mt-1 w-full sm:w-auto'
          onClick={() => setExpanded(true)}
        >
          {tr('assistant_results_showMore', { count: hiddenCount })}
        </Button>
      )}
    </div>
  );
}
