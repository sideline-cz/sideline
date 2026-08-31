import type { Auth } from '@sideline/domain';
import { AlertTriangle, CheckCircle } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { tr } from '~/lib/translations.js';

interface DiscordConnectionBadgeProps {
  readonly state: Auth.UserTeamDiscordJoined;
}

/**
 * Pure `state → Badge` mapping (designer §3.6 / §8): `'connected'` is a `Badge variant='success'`
 * with `CheckCircle`, `'not_connected'` is an amber badge with `AlertTriangle`, and — the one
 * rule that matters most in this whole PR — `'unknown'` renders NOTHING. Never colour-only: every
 * state pairs an icon with the word, never the dot alone.
 */
export function DiscordConnectionBadge({ state }: DiscordConnectionBadgeProps) {
  if (state === 'unknown') return null;

  if (state === 'connected') {
    return (
      <Badge variant='success' className='gap-1'>
        <CheckCircle className='size-3' aria-hidden='true' />
        {tr('discord_connected')}
      </Badge>
    );
  }

  return (
    <Badge className='gap-1 border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-800 dark:bg-amber-900/50 dark:text-amber-300'>
      <AlertTriangle className='size-3' aria-hidden='true' />
      {tr('discord_notConnected')}
    </Badge>
  );
}
