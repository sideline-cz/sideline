import type { Invite } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { Effect, Option } from 'effect';
import { Users } from 'lucide-react';
import React from 'react';
import { LanguageSwitcher } from '~/components/organisms/LanguageSwitcher';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';

interface InvitePageProps {
  isAuthenticated: boolean;
  invite: Invite.InviteInfo;
  code: string;
  onJoined: (teamId: string, isProfileComplete: boolean) => void;
  onSignIn: () => void;
  onReauth: () => void;
}

export function InvitePage({
  isAuthenticated,
  invite,
  code,
  onJoined,
  onSignIn,
  onReauth,
}: InvitePageProps) {
  const run = useRun();
  const [joining, setJoining] = React.useState(false);
  const [requiresReauth, setRequiresReauth] = React.useState(false);
  const [joinResult, setJoinResult] = React.useState<Invite.JoinResult | null>(null);
  const [discordInviteUrl, setDiscordInviteUrl] = React.useState<Option.Option<string>>(
    Option.none(),
  );
  const [discordInviteFailed, setDiscordInviteFailed] = React.useState(false);

  const handleJoin = React.useCallback(async () => {
    setJoining(true);
    await ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.invite.joinViaInvite({ params: { code } })),
      Effect.tap((result) =>
        Effect.sync(() => {
          if (result.requiresReauth) {
            setRequiresReauth(true);
          } else {
            setJoinResult(result);
          }
        }),
      ),
      Effect.catchTag('AlreadyMember', () =>
        Effect.fail(ClientError.make(m.invite_errors_alreadyMember())),
      ),
      Effect.catchTag('InviteNotFound', () =>
        Effect.fail(ClientError.make(m.invite_errors_inviteNotValid())),
      ),
      Effect.mapError(() => ClientError.make(m.invite_errors_joinFailed())),
      run({ success: m.invite_teamJoined() }),
    );
    setJoining(false);
  }, [code, run]);

  const handleContinue = React.useCallback(() => {
    if (joinResult === null) return;
    onJoined(joinResult.teamId, joinResult.isProfileComplete);
  }, [joinResult, onJoined]);

  const acceptanceId = joinResult !== null ? joinResult.acceptanceId : Option.none();

  React.useEffect(() => {
    if (Option.isNone(acceptanceId)) return;
    if (Option.isSome(discordInviteUrl) || discordInviteFailed) return;

    let cancelled = false;
    const accId = acceptanceId.value;

    const poll = () =>
      ApiClient.asEffect().pipe(
        Effect.flatMap((api) => api.invite.getJoinStatus({ params: { acceptanceId: accId } })),
        Effect.tap((status) =>
          Effect.sync(() => {
            if (cancelled) return;
            if (Option.isSome(status.discordInviteUrl)) {
              setDiscordInviteUrl(status.discordInviteUrl);
            } else if (Option.isSome(status.errorCode)) {
              setDiscordInviteFailed(true);
            }
          }),
        ),
        Effect.mapError(() => ClientError.make('')),
        run(),
      );

    void poll();
    const interval = window.setInterval(poll, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [acceptanceId, discordInviteUrl, discordInviteFailed, run]);

  return (
    <div className='flex min-h-screen flex-col'>
      <header className='flex items-center justify-between px-6 py-4 border-b'>
        <span className='text-lg font-bold'>{m.app_name()}</span>
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
            {joinResult !== null ? (
              Option.isSome(discordInviteUrl) ? (
                <>
                  <CardTitle>{m.invite_joinDiscordTitle()}</CardTitle>
                  <CardDescription>
                    {m.invite_joinDiscordDescription({ teamName: invite.teamName })}
                  </CardDescription>
                </>
              ) : discordInviteFailed ? (
                <>
                  <CardTitle>{m.invite_discordInviteFailedTitle()}</CardTitle>
                  <CardDescription>{m.invite_discordInviteFailedDescription()}</CardDescription>
                </>
              ) : (
                <>
                  <CardTitle>{m.invite_preparingDiscordInviteTitle()}</CardTitle>
                  <CardDescription>{m.invite_preparingDiscordInviteDescription()}</CardDescription>
                </>
              )
            ) : requiresReauth ? (
              <>
                <CardTitle>{m.invite_reauthTitle()}</CardTitle>
                <CardDescription>{m.invite_reauthDescription()}</CardDescription>
              </>
            ) : (
              <>
                <CardTitle>{m.invite_joinTitle({ teamName: invite.teamName })}</CardTitle>
                <CardDescription>
                  {m.invite_joinDescription({ teamName: invite.teamName })}
                </CardDescription>
                {Option.match(invite.groupName, {
                  onNone: () => null,
                  onSome: (name) => (
                    <p className='text-sm text-muted-foreground'>
                      {m.invite_willJoinGroup()}: <strong>{name}</strong>
                    </p>
                  ),
                })}
                {Option.match(invite.inviterName, {
                  onNone: () => null,
                  onSome: (name) => (
                    <p className='text-sm text-muted-foreground'>
                      {m.invite_invitedBy()} <strong>{name}</strong>
                    </p>
                  ),
                })}
              </>
            )}
          </CardHeader>
          <CardContent className='flex flex-col gap-2'>
            {joinResult !== null ? (
              Option.isSome(discordInviteUrl) ? (
                <>
                  <a
                    href={discordInviteUrl.value}
                    target='_blank'
                    rel='noopener noreferrer'
                    className='w-full'
                  >
                    <Button className='w-full'>{m.invite_joinDiscordButton()}</Button>
                  </a>
                  <Button variant='ghost' onClick={handleContinue} className='w-full'>
                    {m.invite_joinButton()}
                  </Button>
                </>
              ) : (
                <Button onClick={handleContinue} className='w-full'>
                  {m.invite_joinButton()}
                </Button>
              )
            ) : requiresReauth ? (
              <Button onClick={onReauth} className='w-full'>
                {m.invite_reauthButton()}
              </Button>
            ) : isAuthenticated ? (
              <Button onClick={handleJoin} disabled={joining} className='w-full'>
                {joining ? m.invite_joining() : m.invite_joinButton()}
              </Button>
            ) : (
              <Button onClick={onSignIn} className='w-full'>
                {m.invite_signInToJoin()}
              </Button>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
