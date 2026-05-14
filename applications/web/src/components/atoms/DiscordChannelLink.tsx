import { Hash } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '~/components/ui/tooltip';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

interface DiscordChannelLinkProps {
  guildId: string;
  channelId: string;
  channelName: string;
  className?: string;
}

export function DiscordChannelLink({
  guildId,
  channelId,
  channelName,
  className,
}: DiscordChannelLinkProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={`https://discord.com/channels/${guildId}/${channelId}`}
            target='_blank'
            rel='noopener noreferrer'
            aria-label={tr('discord_openChannel', { channelName })}
            className={cn(
              'inline-flex items-center gap-0.5 rounded bg-indigo-500/15 px-1.5 py-0.5 text-sm font-medium text-indigo-600 hover:bg-indigo-500/25 dark:text-indigo-400',
              'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              className,
            )}
          >
            <Hash className='size-3.5 shrink-0' aria-hidden />
            {channelName}
          </a>
        </TooltipTrigger>
        <TooltipContent>{channelId}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
