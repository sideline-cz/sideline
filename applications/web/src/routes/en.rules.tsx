import { createFileRoute } from '@tanstack/react-router';
import { Option } from 'effect';
import { RulesTrainerPage } from '~/components/pages/RulesTrainerPage';
import { tr } from '~/lib/translations.js';

// A flat, explicit route rather than a `/$lang/rules` dynamic segment: a
// top-level dynamic segment would greedily compete with `/invite/$code`,
// `/onboarding/$token` and the `(authenticated)` routes. See
// `applications/web/AGENTS.md` routing conventions.
export const Route = createFileRoute('/en/rules')({
  ssr: false, // Effect `Option` in route context fails TanStack's serializability check.
  component: EnRulesRoute,
  head: () => ({
    meta: [
      { title: `${tr('rules_introTitle', undefined, { locale: 'en' })} · Sideline` },
      { name: 'description', content: tr('rules_introLead', undefined, { locale: 'en' }) },
    ],
  }),
});

function EnRulesRoute() {
  // `userOption` comes from the root route's `beforeLoad` (see
  // `__root.tsx`); reading it here — rather than in `beforeLoad` — mirrors
  // `invite.$code.tsx`, since this route needs nothing else from the
  // context. Only a plain boolean crosses into the (router-hook-free) page
  // component — see `RulesTrainerPage`'s "no TanStack Router imports" rule.
  const { userOption } = Route.useRouteContext();
  return <RulesTrainerPage locale='en' isSignedIn={Option.isSome(userOption)} />;
}
