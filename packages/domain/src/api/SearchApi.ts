/**
 * The command-palette search endpoint (`.work-plans/command-palette-search.md` §A). Calls the
 * same five AI read-tool executors the in-app assistant uses (`applications/server/src/services/
 * ai/readTools.ts`), so the permission gates are the same function calls, not a second copy.
 * `SearchHit` is defined in `AiChatApi.ts` and re-exported here, per the shared-schema
 * convention (`packages/domain/AGENTS.md` → "Shared Schemas Across API Contracts").
 */
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { SearchHit } from '~/api/AiChatApi.js';
import { AuthMiddleware } from '~/api/Auth.js';
import { TeamId } from '~/models/Team.js';

export { SearchHit } from '~/api/AiChatApi.js';

/**
 * The one label per hit — used by the server for prefix ranking and by the palette where a
 * plain string is needed (cmdk `value` fallback, the live-region text), so the two can never
 * disagree about what "matches" means. Pure, no i18n.
 */
export const searchHitLabel = (hit: SearchHit): string => {
  switch (hit.kind) {
    case 'event':
      return hit.event.title;
    case 'member':
      return hit.displayName;
    case 'group':
      return hit.group.name;
    case 'roster':
      return hit.roster.name;
    case 'trainingType':
      return hit.trainingType.name;
  }
};

/**
 * Stable identity for a hit: `"<kind>:<id>"`. The palette's React key and cmdk item `value`.
 * `SearchHit` has no `ref`; this is the only identity there is.
 */
export const searchHitId = (hit: SearchHit): string => {
  switch (hit.kind) {
    case 'event':
      return `event:${hit.event.eventId}`;
    case 'member':
      return `member:${hit.memberId}`;
    case 'group':
      return `group:${hit.group.groupId}`;
    case 'roster':
      return `roster:${hit.roster.rosterId}`;
    case 'trainingType':
      return `trainingType:${hit.trainingType.trainingTypeId}`;
  }
};

export class SearchForbidden extends Schema.TaggedErrorClass<SearchForbidden>()(
  'SearchForbidden',
  {},
) {}

export class SearchApiGroup extends HttpApiGroup.make('search').add(
  HttpApiEndpoint.get('search', '/teams/:teamId/search', {
    success: Schema.Array(SearchHit),
    error: SearchForbidden.pipe(HttpApiSchema.status(403)),
    params: { teamId: TeamId },
    query: {
      q: Schema.String.pipe(
        Schema.check(Schema.isMinLength(1)),
        Schema.check(Schema.isMaxLength(100)),
      ),
    },
  }).middleware(AuthMiddleware),
) {}
