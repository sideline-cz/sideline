import { tr } from '~/lib/translations.js';
export function RoutePendingComponent() {
  return (
    <div className='flex min-h-[60vh] flex-col items-center justify-center gap-4'>
      <svg
        className='h-8 w-8 animate-spin text-muted-foreground'
        xmlns='http://www.w3.org/2000/svg'
        fill='none'
        viewBox='0 0 24 24'
        aria-label={tr('loading_text')}
        role='img'
      >
        <circle
          className='opacity-25'
          cx='12'
          cy='12'
          r='10'
          stroke='currentColor'
          strokeWidth='4'
        />
        <path
          className='opacity-75'
          fill='currentColor'
          d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z'
        />
      </svg>
      <p className='text-sm text-muted-foreground'>{tr('loading_text')}</p>
    </div>
  );
}
