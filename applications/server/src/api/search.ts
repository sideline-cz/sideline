/**
 * The command-palette search endpoint (`.work-plans/command-palette-search.md` §A). Calls the
 * same AI read-tool executors the in-app assistant uses
 * (`applications/server/src/services/ai/readTools.ts`) — the permission gates are therefore the
 * same function calls, not a second copy that could drift. `search` never passes
 * `includeAllGroups` to `listAllEvents`, so a `team:manage` caller is group-filtered exactly like
 * everyone else (mirrors `GET /events` without `?all=1`) — do not "fix" that later, see the plan.
 *
 * A missing per-kind gate (`group:manage`, `member:view`, `roster:view`, `role:view`,
 * `finance:view`) is never a 403 for the
 * whole query: `forbiddenResult` already returns empty `hits`, so the kind is simply absent from
 * the response. The only 403 is `requireMembership` failing for a non-member.
 */
import { type AiChatApi, Auth, SearchApi } from '@sideline/domain';
import { DateTime, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership } from '~/api/permissions.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import {
  listAllEvents,
  listExpenses,
  listGroups,
  listMembers,
  listRoles,
  listRosters,
  listTrainingTypes,
} from '~/services/ai/readTools.js';
import { type EntityReadContext, makeCanSeeGroup } from '~/services/ai/toolTypes.js';

// Exported for `test/unit/searchRanking.test.ts`. Both values are unchanged from when there were
// five kinds, but the reasoning that justified them is NOT: at five kinds per-kind capping alone
// bounded any input to `PER_KIND_LIMIT * 5 = 25`, so `TOTAL_LIMIT` was never reachable and its
// value was unobservable. With seven kinds it IS reachable — and reaching it by truncating a
// kind-ordered list would make the last kinds unreachable whenever the first ones saturate
// (7 kinds x 5 = 35 > 25, so `expense` could never appear alongside five full earlier kinds).
// `rankAndCap` therefore fills interleaved rather than sequentially; see below.
export const PER_KIND_LIMIT = 5;
export const TOTAL_LIMIT = 25;

const KIND_ORDER: ReadonlyArray<AiChatApi.SearchHit['kind']> = [
  'event',
  'member',
  'group',
  'roster',
  'trainingType',
  'role',
  'expense',
];

const addDaysIso = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const eventStartDateOf = (hit: AiChatApi.SearchHit & { readonly kind: 'event' }): string =>
  Option.getOrElse(hit.event.startDate, () => DateTime.formatIsoDateUtc(hit.event.startAt));

/**
 * Ranks and caps the aggregate hit list. Exported for `test/unit/searchRanking.test.ts`.
 *
 * 1. Grouped by kind, in `KIND_ORDER` — the UI groups by kind in encounter order.
 * 2. Within `event`: upcoming/today first (ascending), then past (descending). `todayIso` is
 *    UTC while `startDate` is team-local wall clock, so a one-day grace band (`upcomingFrom`)
 *    keeps a UTC-yesterday `todayIso` from sinking today's team-local event into the past bucket.
 *    // ponytail: `start_date` is team-local, `todayIso` is UTC, so a one-day grace band replaces
 *    // a per-keystroke TeamSettingsRepository lookup. Upgrade: pass the team timezone if ordering
 *    // around midnight ever matters more than a query does.
 * 3. Within every other kind: prefix matches on `searchHitLabel` first, then everything else,
 *    stable within each bucket.
 * 4. Capped at `PER_KIND_LIMIT` per kind (applied after ranking), then filled INTERLEAVED up to
 *    `TOTAL_LIMIT`: pass 1 takes each kind's top row in `KIND_ORDER`, pass 2 each kind's second,
 *    and so on until the budget runs out. A plain `slice(0, TOTAL_LIMIT)` over the kind-ordered
 *    list would spend the whole budget on the earliest kinds and make the last ones unreachable
 *    (see `TOTAL_LIMIT` above). The survivors are then re-grouped into `KIND_ORDER` so the wire
 *    order is still grouped-by-kind, which is what the palette renders from.
 */
export const rankAndCap = (
  hits: ReadonlyArray<AiChatApi.SearchHit>,
  query: string,
  todayIso: string,
): ReadonlyArray<AiChatApi.SearchHit> => {
  const lowerQuery = query.toLowerCase();
  const upcomingFrom = addDaysIso(todayIso, -1);
  const isUpcoming = (d: string) => d >= upcomingFrom;

  const rankOf = (hit: AiChatApi.SearchHit): number =>
    SearchApi.searchHitLabel(hit).toLowerCase().startsWith(lowerQuery) ? 0 : 1;

  const sortWithin = (
    kindHits: ReadonlyArray<AiChatApi.SearchHit>,
  ): ReadonlyArray<AiChatApi.SearchHit> => {
    if (kindHits.length === 0) return kindHits;
    if (kindHits[0]?.kind === 'event') {
      const eventHits = kindHits as ReadonlyArray<AiChatApi.SearchHit & { readonly kind: 'event' }>;
      const upcoming = eventHits
        .filter((h) => isUpcoming(eventStartDateOf(h)))
        .sort((a, b) => (eventStartDateOf(a) < eventStartDateOf(b) ? -1 : 1));
      const past = eventHits
        .filter((h) => !isUpcoming(eventStartDateOf(h)))
        .sort((a, b) => (eventStartDateOf(a) > eventStartDateOf(b) ? -1 : 1));
      return [...upcoming, ...past];
    }
    return kindHits
      .map((hit, index) => ({ hit, index, rank: rankOf(hit) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(({ hit }) => hit);
  };

  const byKind = KIND_ORDER.map((kind) =>
    sortWithin(hits.filter((h) => h.kind === kind)).slice(0, PER_KIND_LIMIT),
  );

  const kept = new Set<AiChatApi.SearchHit>();
  for (let rank = 0; rank < PER_KIND_LIMIT && kept.size < TOTAL_LIMIT; rank += 1) {
    for (const kindHits of byKind) {
      if (kept.size >= TOTAL_LIMIT) break;
      const hit = kindHits[rank];
      if (hit !== undefined) kept.add(hit);
    }
  }

  return byKind.flat().filter((hit) => kept.has(hit));
};

const forbidden = new SearchApi.SearchForbidden();

export const SearchApiLive = HttpApiBuilder.group(Api, 'search', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.map(({ members, groups }) =>
      handlers.handle('search', ({ params: { teamId }, query: { q } }) =>
        // ponytail: seven unbounded team-wide SELECTs + in-memory substring match per keystroke,
        // reusing the AI read tools so the permission gates cannot drift. Move to per-kind SQL
        // `ILIKE … LIMIT` (or a pg_trgm index) if p95 search latency or DB load becomes visible.
        // Abuse vector, not just latency: unlike `/teams/:teamId/ai-chat` (guarded by
        // `ChatRateLimiter`), this endpoint has no rate limit, so any team member can loop
        // `?q=a` to force seven unbounded team-wide `SELECT`s plus a recursive CTE per distinct
        // event group on every request. Deferred for parity with `/events` (also unrate-limited)
        // — add a limiter here (or in front of both) if that gets exploited.
        Effect.Do.pipe(
          Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
          Effect.bind('membership', ({ currentUser }) =>
            requireMembership(members, teamId, currentUser.id, forbidden),
          ),
          Effect.let(
            'ctx',
            ({ membership }): EntityReadContext => ({
              teamId,
              membership,
              canSeeGroup: makeCanSeeGroup(groups, membership.id),
            }),
          ),
          // The executors run concurrently: `listAllEvents` is the only one that touches the
          // memoized `canSeeGroup` `Map` (`makeCanSeeGroup` in `toolTypes.ts`), and its own
          // internal `Effect.filter` already forces `{ concurrency: 1 }` around every read of
          // that `Map` (`readTools.ts`), so running it alongside the others — which never touch
          // `canSeeGroup` at all — cannot race on shared mutable state. That is a constraint on
          // what may be ADDED here, not just a note: `listEventRsvps`/`listEventAttendance` both
          // reach `canSeeGroup` through `resolveVisibleEvent`, so neither may join this set
          // without first giving that `Map` a `Ref` (they are not text-searchable anyway — both
          // take an `eventId`, not a query).
          Effect.bind('results', ({ ctx }) =>
            Effect.all(
              {
                eventResult: listAllEvents({ query: q }, ctx),
                memberResult: listMembers({ query: q }, ctx),
                groupResult: listGroups({ query: q }, ctx),
                rosterResult: listRosters({ query: q }, ctx),
                trainingTypeResult: listTrainingTypes({ query: q }, ctx),
                roleResult: listRoles({ query: q }, ctx),
                expenseResult: listExpenses({ query: q }, ctx),
              },
              { concurrency: 'unbounded' },
            ),
          ),
          Effect.map(
            ({
              results: {
                eventResult,
                memberResult,
                groupResult,
                rosterResult,
                trainingTypeResult,
                roleResult,
                expenseResult,
              },
            }) =>
              rankAndCap(
                [
                  ...eventResult.hits,
                  ...memberResult.hits,
                  ...groupResult.hits,
                  ...rosterResult.hits,
                  ...trainingTypeResult.hits,
                  ...roleResult.hits,
                  ...expenseResult.hits,
                ],
                q,
                DateTime.formatIsoDateUtc(DateTime.nowUnsafe()),
              ),
          ),
        ),
      ),
    ),
  ),
);
