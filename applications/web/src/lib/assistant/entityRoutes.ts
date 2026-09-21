/**
 * Route table and label lookup for `EntityRef` (plan `.work-plans/ai-app-interaction.md`
 * §13.8, design §3.7). `ENTITY_ROUTE` is `as const satisfies Record<EntityRef['kind'],
 * string>` so the literal route strings survive for TanStack Router's typed `<Link to>` —
 * a widened `{ to: string }` return would force an `as never` cast at every call site,
 * which is exactly the drift this module exists to prevent.
 *
 * `entityKindLabels` is the `event-labels.ts:13` idiom: an explicit
 * `Record<EntityRef['kind'], () => string>`, never a computed
 * `` tr(`assistant_result_${kind}`) `` template — that form is invisible to
 * `lib/staticTrKeys.test.ts` and prints the raw key to the user on a miss. The
 * `assistant_result_*` keys ship in `packages/i18n/messages/*.json`.
 */
import type { AiChatApi } from '@sideline/domain';
import { tr } from '~/lib/translations.js';

type EntityKind = AiChatApi.EntityRef['kind'];
type DegradedReason = AiChatApi.DegradedReason;

export const ENTITY_ROUTE = {
  event: '/teams/$teamId/events/$eventId',
  member: '/teams/$teamId/members/$memberId',
  group: '/teams/$teamId/groups/$groupId',
  roster: '/teams/$teamId/rosters/$rosterId',
  trainingType: '/teams/$teamId/training-types/$trainingTypeId',
} as const satisfies Record<EntityKind, string>;

export const entityKindLabels: Record<EntityKind, () => string> = {
  event: () => tr('assistant_result_event'),
  member: () => tr('assistant_result_member'),
  group: () => tr('assistant_result_group'),
  roster: () => tr('assistant_result_roster'),
  trainingType: () => tr('assistant_result_trainingType'),
};

/**
 * Resolves the wire's `DegradedReason` (closed union, `snake_case` literals) to copy through
 * an explicit lookup — never `` tr(`assistant_degraded_${reason}`) ``. The key names are NOT
 * `snake_case` (`notConfigured`, not `not_configured`), so a template literal would miss every
 * single branch and print the raw, wrong key to the user (design §7).
 */
export const degradedReasonLabels: Record<DegradedReason, () => string> = {
  not_configured: () => tr('assistant_degraded_notConfigured'),
  disabled: () => tr('assistant_degraded_disabled'),
  provider_error: () => tr('assistant_degraded_providerError'),
  too_many_steps: () => tr('assistant_degraded_tooManySteps'),
  empty_answer: () => tr('assistant_degraded_emptyAnswer'),
};
