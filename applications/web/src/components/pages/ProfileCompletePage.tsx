import { UserCircle } from 'lucide-react';
import { LanguageSwitcher } from '~/components/organisms/LanguageSwitcher';
import { ProfileCompleteForm } from '~/components/organisms/ProfileCompleteForm';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { tr } from '~/lib/translations.js';

interface ProfileCompletePageProps {
  user: { username: string };
  onSuccess: () => void;
}

export function ProfileCompletePage({ user, onSuccess }: ProfileCompletePageProps) {
  return (
    <div className='flex min-h-screen flex-col'>
      <header className='flex items-center justify-between px-6 py-4 border-b'>
        <span className='text-lg font-bold'>{tr('app_name')}</span>
        <div className='flex items-center gap-3'>
          <LanguageSwitcher isAuthenticated />
        </div>
      </header>

      <main className='flex flex-1 flex-col items-center px-6 pt-16 pb-24'>
        <Card className='w-full max-w-md'>
          <CardHeader className='text-center'>
            <div className='flex justify-center mb-2'>
              <div className='flex size-12 items-center justify-center rounded-full bg-muted'>
                <UserCircle className='size-6 text-muted-foreground' />
              </div>
            </div>
            <CardTitle>{tr('profile_complete_title')}</CardTitle>
            <CardDescription>{tr('profile_complete_subtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ProfileCompleteForm initialName={user.username} onSuccess={onSuccess} />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
