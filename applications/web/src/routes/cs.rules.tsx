import { createFileRoute } from '@tanstack/react-router';
import { Option } from 'effect';
import { RulesTrainerPage } from '~/components/pages/RulesTrainerPage';
import { tr } from '~/lib/translations.js';

// See `en.rules.tsx` for why this is a flat route rather than `/$lang/rules`.
//
// `noindex` on purpose: the Czech content is AI-written and unreviewed beyond
// ~23 of 109 situations (see `packages/rules/authoring/czech-review-checklist.md`).
// An SSR-indexed, Sideline-branded page teaching a possibly-mistranslated
// ruling to Czech players is a higher bar than the standalone prototype this
// was ported from — see `docs/plans/rules-trainer.md`, "The Czech is
// AI-written and unreviewed".
export const Route = createFileRoute('/cs/rules')({
  ssr: false, // Effect `Option` in route context fails TanStack's serializability check.
  component: CsRulesRoute,
  head: () => ({
    meta: [
      { title: `${tr('rules_introTitle', undefined, { locale: 'cs' })} · Sideline` },
      { name: 'description', content: tr('rules_introLead', undefined, { locale: 'cs' }) },
      { name: 'robots', content: 'noindex' },
    ],
  }),
});

function CsRulesRoute() {
  // See `en.rules.tsx` for why `userOption` is read here rather than in `beforeLoad`.
  const { userOption } = Route.useRouteContext();
  return (
    <RulesTrainerPage
      locale='cs'
      showTranslationReviewNotice
      isSignedIn={Option.isSome(userOption)}
    />
  );
}
