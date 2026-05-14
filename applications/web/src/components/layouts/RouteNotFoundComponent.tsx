import { Button } from '~/components/ui/button';
import { tr } from '~/lib/translations.js';

export function RouteNotFoundComponent() {
  return (
    <div className='flex min-h-[60vh] flex-col items-center justify-center gap-6 p-8 text-center'>
      <div className='text-8xl font-black text-muted-foreground/20'>404</div>
      <div className='space-y-2'>
        <h1 className='text-2xl font-bold tracking-tight'>{tr('notFound_title')}</h1>
        <p className='max-w-md text-muted-foreground'>{tr('notFound_message')}</p>
      </div>
      <Button asChild variant='default'>
        <a href='/'>{tr('error_goHome')}</a>
      </Button>
    </div>
  );
}
