import { Users } from 'lucide-react';
import { LanguageSwitcher } from '~/components/organisms/LanguageSwitcher.js';
import { Button } from '~/components/ui/button';
import { Card, CardDescription, CardHeader } from '~/components/ui/card';
import { tr } from '~/lib/translations.js';

interface NoTeamPageProps {
  justRemoved?: boolean;
  onLogout?: () => void;
}

export function NoTeamPage({ justRemoved, onLogout }: NoTeamPageProps) {
  return (
    <div className='flex min-h-screen flex-col'>
      <header className='flex items-center justify-between px-6 py-4 border-b'>
        <span className='text-lg font-bold'>{tr('app_name')}</span>
        <div className='flex items-center gap-3'>
          <LanguageSwitcher isAuthenticated />
          <Button variant='ghost' size='sm' onClick={onLogout}>
            {tr('nav_logOut')}
          </Button>
        </div>
      </header>

      <main className='flex flex-1 flex-col items-center px-6 pt-16 pb-24'>
        <Card className='w-full max-w-md'>
          <CardHeader className='text-center'>
            <div className='flex justify-center mb-2'>
              <div className='flex size-12 items-center justify-center rounded-full bg-muted'>
                <Users className='size-6 text-muted-foreground' />
              </div>
            </div>
            {justRemoved === true && (
              <p className='text-sm text-muted-foreground mb-1'>{tr('noTeam_removedBanner')}</p>
            )}
            <h2 className='leading-none font-semibold'>{tr('noTeam_title')}</h2>
            <CardDescription>{tr('noTeam_description')}</CardDescription>
          </CardHeader>
        </Card>
      </main>
    </div>
  );
}
