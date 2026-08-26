import { createFileRoute } from '@tanstack/react-router';
import { Option } from 'effect';
import { RulesTrainerPage } from '~/components/pages/RulesTrainerPage';
import { tr } from '~/lib/translations.js';

// See `en.rules.tsx` for why this is a flat route rather than `/$lang/rules`.
//
// The Czech review gate is CLOSED, not merely lifted (owner decision,
// 2026-08-26), so this route is fully symmetrical with `en.rules.tsx`.
//
// The banner, its two i18n keys and the per-package checklist have all been
// deleted rather than left dormant: a retained artifact reads as planned work,
// and this review is not planned. 86 of the 109 situations remain AI-written
// and unreviewed, which is accepted exposure — the same content has been live
// in Czech at rules.sideline.cz since before Sideline carried it. See the
// Risks section of `docs/plans/rules-trainer.md` for what that risk actually
// is. If a mistranslated ruling ever surfaces, fix that ruling.
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
