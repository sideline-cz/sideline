import type { Lang } from '@sideline/rules';
import { TriangleAlert } from 'lucide-react';
import { RulesTrainer } from '~/components/organisms/RulesTrainer.js';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { tr } from '~/lib/translations.js';

interface RulesTrainerPageProps {
  readonly locale: Lang;
  /**
   * Renders a "translation under review" banner. **Currently no route passes
   * it** — the Czech gate was lifted by owner sign-off — so this is dormant
   * rather than dead, and deliberately so.
   *
   * Kept because the sign-off was a page-level judgement, not a read of all
   * 1182 options: the failure this gate guards against is a dropped or
   * inverted negation in a *wrong* option's `why`, which reads as fluent
   * Czech and is invisible to both a glance and `cz-audit.mjs`. If such a
   * ruling turns up, re-gating is passing this prop again from
   * `cs.rules.tsx` plus restoring its `noindex` meta — no UI to rebuild.
   * `packages/rules/authoring/czech-review-checklist.md` holds the
   * per-package breakdown for a deeper pass.
   */
  readonly showTranslationReviewNotice?: boolean;
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
export function RulesTrainerPage({
  locale,
  showTranslationReviewNotice = false,
  isSignedIn = false,
}: RulesTrainerPageProps) {
  return (
    <div className='mx-auto flex max-w-4xl flex-col gap-4 px-4 py-8'>
      {showTranslationReviewNotice && (
        <Alert variant='warning'>
          <TriangleAlert />
          {/* Hardcoded to `cs`, not the page locale: this notice only ever
              shows on /cs/rules, and it must be readable by the Czech speaker
              it is warning. Cleared per-package via
              packages/rules/authoring/czech-review-checklist.md. */}
          <AlertTitle>{tr('rules_csReviewNotice', undefined, { locale: 'cs' })}</AlertTitle>
          <AlertDescription>
            {tr('rules_csReviewNoticeBody', undefined, { locale: 'cs' })}
          </AlertDescription>
        </Alert>
      )}
      <RulesTrainer locale={locale} isSignedIn={isSignedIn} />
    </div>
  );
}
