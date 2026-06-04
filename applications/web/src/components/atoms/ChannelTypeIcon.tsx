import { Folder, Hash, Volume2 } from 'lucide-react';
import {
  DISCORD_CHANNEL_TYPE_CATEGORY,
  DISCORD_CHANNEL_TYPE_TEXT,
  DISCORD_CHANNEL_TYPE_VOICE,
} from '~/lib/discord.js';
import { tr } from '~/lib/translations.js';

interface ChannelTypeIconProps {
  type: number;
  className?: string;
}

export function ChannelTypeIcon({ type, className }: ChannelTypeIconProps) {
  if (type === DISCORD_CHANNEL_TYPE_TEXT) {
    return (
      <>
        <Hash className={className} aria-hidden />
        <span className='sr-only'>{tr('channels_type_text')}</span>
      </>
    );
  }
  if (type === DISCORD_CHANNEL_TYPE_VOICE) {
    return (
      <>
        <Volume2 className={className} aria-hidden />
        <span className='sr-only'>{tr('channels_type_voice')}</span>
      </>
    );
  }
  if (type === DISCORD_CHANNEL_TYPE_CATEGORY) {
    return (
      <>
        <Folder className={className} aria-hidden />
        <span className='sr-only'>{tr('channels_type_category')}</span>
      </>
    );
  }
  return null;
}
