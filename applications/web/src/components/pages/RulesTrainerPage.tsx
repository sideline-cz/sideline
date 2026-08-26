import type { Lang } from '@sideline/rules';
import { RulesTrainer } from '~/components/organisms/RulesTrainer.js';

interface RulesTrainerPageProps {
  readonly locale: Lang;
  /**
   * Whether the visitor is signed in — a plain boolean derived from the
   * route's `userOption` (see `en.rules.tsx`/`cs.rules.tsx`), never the
   * `User` object itself: nothing below this page needs anything else about
   * the caller, and passing the boolean keeps this props-only page (and the
   * organisms it renders) free of any dependency on `@sideline/domain`'s
   * `Auth.User` shape.
   */
  readonly isSignedIn?: boolean;
}

// No TanStack Router imports here on purpose (Atomic Design boundary) — the
// route file supplies `locale` as a prop; this component and everything it
// renders is driven purely by props.
export function RulesTrainerPage({ locale, isSignedIn = false }: RulesTrainerPageProps) {
  return (
    <div className='mx-auto flex max-w-4xl flex-col gap-4 px-4 py-8'>
      <RulesTrainer locale={locale} isSignedIn={isSignedIn} />
    </div>
  );
}
