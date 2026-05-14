import { EventApi } from '@sideline/domain';
import * as Option from 'effect/Option';
import { ExternalLink } from 'lucide-react';
import { tr } from '~/lib/translations.js';

interface EventLocationProps {
  text: string;
  url: Option.Option<string>;
  stopPropagation?: boolean;
}

export function EventLocation({ text, url, stopPropagation = false }: EventLocationProps) {
  if (Option.isSome(url) && EventApi.isPublicHttpsUrl(url.value)) {
    return (
      <a
        href={url.value}
        target='_blank'
        rel='noopener noreferrer'
        className='inline-flex items-center gap-1 underline underline-offset-2 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring rounded-sm'
        onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
      >
        {text}
        <ExternalLink className='size-3.5 shrink-0' aria-hidden />
        <span className='sr-only'>{tr('common_opensInNewTab')}</span>
      </a>
    );
  }

  return <>{text}</>;
}
