import { createFileRoute } from '@tanstack/react-router';
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
  return <RulesTrainerPage locale='en' />;
}
