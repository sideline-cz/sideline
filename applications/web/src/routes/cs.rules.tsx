import { createFileRoute } from '@tanstack/react-router';
import { Option } from 'effect';
import { RulesTrainerPage } from '~/components/pages/RulesTrainerPage';
import { tr } from '~/lib/translations.js';

// See `en.rules.tsx` for why this is a flat route rather than `/$lang/rules`.
//
// The Czech review gate is lifted (owner sign-off), so this route is now
// symmetrical with `en.rules.tsx`: no `noindex`, no in-page review notice.
//
// If a later read of the content turns up a mistranslated ruling, re-gating is
// two lines — add `{ name: 'robots', content: 'noindex' }` back to `meta` and
// pass `showTranslationReviewNotice` to the page. The
// `rules_csReviewNotice` / `rules_csReviewNoticeBody` keys are kept in the
// catalogue for exactly that reason, and
// `packages/rules/authoring/czech-review-checklist.md` still holds the
// per-package breakdown for anyone doing the deeper pass.
export const Route = createFileRoute('/cs/rules')({
  ssr: false, // Effect `Option` in route context fails TanStack's serializability check.
  component: CsRulesRoute,
  head: () => ({
    meta: [
      { title: `${tr('rules_introTitle', undefined, { locale: 'cs' })} · Sideline` },
      { name: 'description', content: tr('rules_introLead', undefined, { locale: 'cs' }) },
    ],
  }),
});

function CsRulesRoute() {
  // See `en.rules.tsx` for why `userOption` is read here rather than in `beforeLoad`.
  const { userOption } = Route.useRouteContext();
  return <RulesTrainerPage locale='cs' isSignedIn={Option.isSome(userOption)} />;
}
