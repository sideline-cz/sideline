import type { Lang } from '@sideline/rules';
import { TriangleAlert } from 'lucide-react';
import { RulesTrainer } from '~/components/organisms/RulesTrainer.js';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { tr } from '~/lib/translations.js';

interface RulesTrainerPageProps {
  readonly locale: Lang;
  /** True only for `/cs/rules` — the Czech content is AI-written and
   * unreviewed beyond ~23 of 109 situations (see
   * `packages/rules/authoring/czech-review-checklist.md`). */
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
