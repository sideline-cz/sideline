/**
 * Renders an assistant turn's `answer` prose plus its inline `[[ref:<token>]]` citations
 * (design §3.3 / §3.6). Prose is rendered as plain text nodes ONLY — no markdown, no HTML
 * interpretation, per the "model prose is never interpreted as markup" rule (there is no
 * markdown dependency in this app, and adding one to render model output would be a real XSS
 * surface). React itself guarantees this: `{segment.text}` is always a text node, never
 * `dangerouslySetInnerHTML`.
 *
 * The turn's `token -> position` map is derived once per render via `useMemo` over
 * `references` (rebuilt fresh every turn, exactly like the server's own map — design §3.2).
 */
import type { AiChatApi } from '@sideline/domain';
import React from 'react';
import { AssistantEntityLink } from '~/components/atoms/AssistantEntityLink.js';
import { parseAnswer } from '~/lib/assistant/parseAnswer.js';

interface AssistantAnswerProps {
  text: string;
  references: ReadonlyArray<AiChatApi.EntityRef>;
  teamId: string;
}

export function AssistantAnswer({ text, references, teamId }: AssistantAnswerProps) {
  const tokens = React.useMemo(
    () => new Map(references.map((reference, index) => [reference.ref, index] as const)),
    [references],
  );
  const { paragraphs } = React.useMemo(() => parseAnswer(text, tokens), [text, tokens]);

  if (paragraphs.length === 0) return null;

  return (
    <div className='flex flex-col gap-3 text-sm whitespace-pre-wrap break-words'>
      {paragraphs.map((segments, paragraphIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs never reorder within a turn
        <p key={paragraphIndex}>
          {segments.map((segment, segmentIndex) => {
            if (segment.kind === 'text') {
              // biome-ignore lint/suspicious/noArrayIndexKey: segments never reorder within a paragraph
              return <React.Fragment key={segmentIndex}>{segment.text}</React.Fragment>;
            }
            const position = tokens.get(segment.token);
            if (position === undefined) return null;
            const reference = references[position];
            if (reference === undefined) return null;
            return (
              <AssistantEntityLink
                // biome-ignore lint/suspicious/noArrayIndexKey: segments never reorder within a paragraph
                key={segmentIndex}
                reference={reference}
                teamId={teamId}
              />
            );
          })}
        </p>
      ))}
    </div>
  );
}
