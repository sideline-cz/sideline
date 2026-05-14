import type { Auth } from '@sideline/domain';
import { useRouter } from '@tanstack/react-router';
import { Option } from 'effect';
import { ArrowLeft } from 'lucide-react';

import { LanguageSwitcher } from '~/components/organisms/LanguageSwitcher';
import { ProfileEditForm } from '~/components/organisms/ProfileEditForm';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { tr } from '~/lib/translations.js';

function discordAvatarUrl(discordId: string, avatar: string): string {
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png?size=128`;
}

interface MyProfilePageProps {
  user: Auth.CurrentUser;
  onUpdated: () => void;
}

export function MyProfilePage({ user, onUpdated }: MyProfilePageProps) {
  const router = useRouter();

  const initials = Option.getOrElse(user.name, () => user.username)
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className='flex min-h-screen flex-col'>
      <header className='sticky top-0 z-10 flex items-center justify-between border-b bg-background px-6 py-4'>
        <Button
          variant='ghost'
          size='icon'
          aria-label={tr('guild_back')}
          onClick={() => router.history.back()}
        >
          <ArrowLeft className='size-5' />
        </Button>
        <span className='text-lg font-bold'>{tr('app_name')}</span>
        <div className='flex items-center gap-3'>
          <LanguageSwitcher isAuthenticated />
        </div>
      </header>

      <main className='flex flex-1 flex-col items-center px-6 pt-16 pb-24'>
        <Card className='w-full max-w-md'>
          <CardHeader className='text-center'>
            <div className='flex justify-center mb-2'>
              <Avatar className='size-12'>
                {Option.isSome(user.avatar) && (
                  <AvatarImage
                    src={discordAvatarUrl(user.discordId, user.avatar.value)}
                    alt={tr('profile_discordAvatar')}
                  />
                )}
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
            </div>
            <CardTitle>{tr('profile_title')}</CardTitle>
            <CardDescription>@{user.username}</CardDescription>
          </CardHeader>
          <CardContent>
            <ProfileEditForm user={user} onSuccess={onUpdated} />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
