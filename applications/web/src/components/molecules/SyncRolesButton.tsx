import { DateTime, Option } from 'effect';
import { Check, Loader2, RefreshCw } from 'lucide-react';
import React from 'react';
import { Button } from '~/components/ui/button';
import { useFormatDate } from '~/hooks/useFormatDate.js';
import { tr } from '~/lib/translations.js';

/** Local mirror of `RoleApi.SyncMemberRolesResult` — this molecule owns no API call (designer
 * §9 component inventory: "reusable in member, admin, and bulk contexts"), so it depends only on
 * the shape it needs, not the generated client type. */
export interface SyncRolesResult {
  readonly addedCount: number;
  readonly removedCount: number;
  readonly roleSyncState: 'queued' | 'ok' | 'failed' | 'never';
  /** The member's PREVIOUS completed sync attempt, as recorded server-side (see
   * `syncMemberDiscordRoles.ts`'s doc comment) — NOT this click's outcome. It can be populated
   * even when `roleSyncState` is `'queued'` (a fresh retry just enqueued), so a captain who just
   * fixed a Discord permission still sees when the last real attempt happened and why it failed,
   * rather than a stale "synced just now" from their own click. This is a different fact from the
   * component's local `syncedAt` state below and the two must never silently substitute for one
   * another — see where they are reconciled in the render body. */
  readonly lastRoleSyncAt: Option.Option<DateTime.Utc>;
  readonly lastRoleSyncError: Option.Option<
    'retryable' | 'captain_action' | 'user_action' | 'unknown'
  >;
}

/** designer §5.4 — after any completed run (success or failure) the button is disabled for 60s
 * so a frustrated user hammering it cannot generate a Discord rate-limit storm for the whole
 * guild. Mirrors the constant already shipped in `PlayerDetailPage.tsx`. */
const SYNC_COOLDOWN_MS = 60_000;

/** Exported so other surfaces rendering `lastRoleSyncError` (e.g. `PlayerDetailPage`, which owns
 * its own sync-button markup rather than this molecule) map the code to the same i18n key without
 * duplicating the mapping. */
export const errorCopyKey = (
  code: 'retryable' | 'captain_action' | 'user_action' | 'unknown',
): string =>
  `discord_syncError_${code === 'captain_action' ? 'captainAction' : code === 'user_action' ? 'userAction' : code}`;

type ButtonState = 'idle' | 'syncing' | 'cooldown';

interface SyncRolesButtonProps {
  readonly onSync: () => Promise<SyncRolesResult>;
  readonly disabled?: boolean;
}

/**
 * The designer §5.4 state machine: idle → syncing → (success | failure), then a 60s cooldown
 * regardless of outcome. Owns no API call — `onSync` is provided by the caller (member-facing
 * `DiscordConnectCard`, `MyProfilePage`, or a future admin/bulk context), so this component is
 * pure UI + local state.
 */
export function SyncRolesButton({ onSync, disabled = false }: SyncRolesButtonProps) {
  const [state, setState] = React.useState<ButtonState>('idle');
  const [result, setResult] = React.useState<SyncRolesResult | null>(null);
  const [syncedAt, setSyncedAt] = React.useState<Date | null>(null);
  const cooldownTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const { formatRelative } = useFormatDate();

  React.useEffect(
    () => () => {
      if (cooldownTimerRef.current !== null) clearTimeout(cooldownTimerRef.current);
    },
    [],
  );

  const handleClick = React.useCallback(async () => {
    if (state !== 'idle') return;
    setState('syncing');
    try {
      const outcome = await onSync();
      setResult(outcome);
      setSyncedAt(new Date());
    } finally {
      setState('cooldown');
      cooldownTimerRef.current = setTimeout(() => setState('idle'), SYNC_COOLDOWN_MS);
    }
  }, [state, onSync]);

  const errorCode = result === null ? Option.none() : result.lastRoleSyncError;
  const failed = Option.isSome(errorCode);

  // Prefer the server-recorded `lastRoleSyncAt` (the previous completed attempt) over the local
  // `syncedAt` click-stamp — they are different facts (see the field's doc comment above) and the
  // server's is the one worth showing. Fall back to the local stamp only when the server has no
  // prior record at all (e.g. `roleSyncState === 'never'`).
  const lastSyncedDate =
    result !== null && Option.isSome(result.lastRoleSyncAt)
      ? new Date(Number(DateTime.toEpochMillis(result.lastRoleSyncAt.value)))
      : syncedAt;

  return (
    <div className='flex flex-col gap-1'>
      <Button
        type='button'
        variant='outline'
        size='sm'
        onClick={handleClick}
        disabled={disabled || state !== 'idle'}
        className='min-w-36 justify-center'
      >
        {state === 'syncing' ? (
          <Loader2 className='size-4 animate-spin' aria-hidden='true' />
        ) : state === 'cooldown' && !failed ? (
          <Check className='size-4' aria-hidden='true' />
        ) : (
          <RefreshCw className='size-4' aria-hidden='true' />
        )}
        {state === 'syncing' ? tr('discord_syncing') : tr('discord_syncRolesFor')}
      </Button>
      <div role='status' aria-live='polite' className='sr-only'>
        {state === 'syncing' ? tr('discord_syncing') : null}
      </div>
      {result !== null && (
        <p className='text-xs text-muted-foreground'>
          {tr('discord_syncQueuedResult', {
            added: result.addedCount,
            removed: result.removedCount,
          })}
          {lastSyncedDate !== null &&
            ` · ${tr('discord_syncLastSyncedRelative', { relativeTime: formatRelative(lastSyncedDate) })}`}
        </p>
      )}
      {Option.match(errorCode, {
        onNone: () => null,
        onSome: (code) => (
          <div role='alert' className='text-xs text-destructive'>
            {tr(errorCopyKey(code))}
          </div>
        ),
      })}
    </div>
  );
}
