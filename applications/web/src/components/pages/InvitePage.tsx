import type { Invite } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { Users } from 'lucide-react';
import React from 'react';
import { LanguageSwitcher } from '~/components/organisms/LanguageSwitcher';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface InvitePageProps {
  isAuthenticated: boolean;
  invite: Invite.InviteInfo;
  code: string;
  // BLOCKER 4 (review of PR-4): a single callback, called exactly once per join, rather than the
  // previous `onJoinPersisted` / `onJoinComplete` pair. Both had the identical signature
  // `(result: Invite.JoinResult) => void`, so swapping them at the call site compiled cleanly and
  // silently reintroduced the bug this PR fixes (persistence being skipped for the
  // `requiresReauth` cohort). With one prop there is nothing left to swap.
  //
  // `meta.navigated` is `true` iff `requiresReauth` is `false` — it tells the caller whether it
  // should ALSO navigate away, on top of always persisting the result.
  onJoinResult: (result: Invite.JoinResult, meta: { readonly navigated: boolean }) => void;
  onSignIn: () => void;
  onReauth: () => void;
}

export function InvitePage({
  isAuthenticated,
  invite,
  code,
  onJoinResult,
  onSignIn,
  onReauth,
}: InvitePageProps) {
  const run = useRun();
  const [joining, setJoining] = React.useState(false);
  const [requiresReauth, setRequiresReauth] = React.useState(false);

  const handleJoin = React.useCallback(async () => {
    setJoining(true);
    await ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.invite.joinViaInvite({ params: { code } })),
      Effect.tap((result) =>
        Effect.sync(() => {
          onJoinResult(result, { navigated: !result.requiresReauth });
          if (result.requiresReauth) {
            setRequiresReauth(true);
          }
        }),
      ),
      Effect.catchTag('AlreadyMember', () =>
        Effect.fail(ClientError.make(tr('invite_errors_alreadyMember'))),
      ),
      Effect.catchTag('InviteNotFound', () =>
        Effect.fail(ClientError.make(tr('invite_errors_inviteNotValid'))),
      ),
      Effect.mapError(() => ClientError.make(tr('invite_errors_joinFailed'))),
      run({ success: tr('invite_teamJoined') }),
    );
    setJoining(false);
  }, [code, run, onJoinResult]);

  return (
    <div className='flex min-h-screen flex-col'>
      <header className='flex items-center justify-between px-6 py-4 border-b'>
        <span className='text-lg font-bold'>{tr('app_name')}</span>
        <div className='flex items-center gap-3'>
          <LanguageSwitcher isAuthenticated={false} />
        </div>
      </header>

      <main className='flex flex-1 flex-col items-center justify-center px-6 py-12'>
        <Card className='w-full max-w-sm'>
          <CardHeader className='text-center'>
            <div className='flex justify-center mb-2'>
              <div className='flex size-12 items-center justify-center rounded-full bg-muted'>
                <Users className='size-6 text-muted-foreground' />
              </div>
            </div>
            {requiresReauth ? (
              <>
                <CardTitle>{tr('invite_reauthTitle')}</CardTitle>
                <CardDescription>{tr('invite_reauthDescription')}</CardDescription>
              </>
            ) : (
              <>
                <CardTitle>{tr('invite_joinTitle', { teamName: invite.teamName })}</CardTitle>
                <CardDescription>
                  {tr('invite_joinDescription', { teamName: invite.teamName })}
                </CardDescription>
                {Option.match(invite.groupName, {
                  onNone: () => null,
                  onSome: (name) => (
                    <p className='text-sm text-muted-foreground'>
                      {tr('invite_willJoinGroup')}: <strong>{name}</strong>
                    </p>
                  ),
                })}
                {Option.match(invite.inviterName, {
                  onNone: () => null,
                  onSome: (name) => (
                    <p className='text-sm text-muted-foreground'>
                      {tr('invite_invitedBy')} <strong>{name}</strong>
                    </p>
                  ),
                })}
              </>
            )}
          </CardHeader>
          <CardContent className='flex flex-col gap-2'>
            {requiresReauth ? (
              <Button onClick={onReauth} className='w-full'>
                {tr('invite_reauthButton')}
              </Button>
            ) : isAuthenticated ? (
              <Button onClick={handleJoin} disabled={joining} className='w-full'>
                {joining ? tr('invite_joining') : tr('invite_joinButton')}
              </Button>
            ) : (
              <Button onClick={onSignIn} className='w-full'>
                {tr('invite_signInToJoin')}
              </Button>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
