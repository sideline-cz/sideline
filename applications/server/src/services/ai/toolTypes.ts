/**
 * Shared types and building blocks for the read-only AI tool executors — plan
 * `.work-plans/ai-app-interaction.md` §8.
 */
import type { AiChatApi, GroupModel, Role, Team, TeamMember } from '@sideline/domain';
import { Effect, Option, type ServiceMap } from 'effect';
import type { GroupsRepository } from '~/repositories/GroupsRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';

// ---------------------------------------------------------------------------
// ToolContext — built once per request, in the chat handler, from
// `requireMembership(members, teamId, currentUser.id, new AiChatApi.AiChatForbidden())`.
// ---------------------------------------------------------------------------

/**
 * No tool parameter may carry `teamId`. The team, the caller's permissions and
 * the team's timezone come from here, resolved BEFORE the model is ever
 * called — the model has no vocabulary in which to name another team.
 */
export interface ToolContext {
  readonly teamId: Team.TeamId;
  readonly membership: MembershipWithRole;
  readonly teamTimezone: string;
  /** Memoized `checkGroupAccess` — see `makeCanSeeGroup` below. */
  readonly canSeeGroup: (groupId: Option.Option<GroupModel.GroupId>) => Effect.Effect<boolean>;
}

/**
 * Every read executor's result. `E = never` — permission and not-found
 * outcomes are ENCODED as `result` (e.g. `{ error: 'forbidden', permission:
 * '<perm>' }` / `{ error: 'not_found' }`), never thrown. `references` is the
 * typed view-model slice this call minted, for `ChatAgent` to accumulate.
 */
export interface ToolExecutionResult {
  readonly result: unknown;
  readonly references: ReadonlyArray<AiChatApi.EntityRef>;
}

// ---------------------------------------------------------------------------
// makeCanSeeGroup — the memoized `checkGroupAccess`
// ---------------------------------------------------------------------------

/**
 * Per-request memoized `checkGroupAccess` (`src/api/scoping.ts`).
 * `checkGroupAccess` issues one `getDescendantMemberIds` call per invocation —
 * a pre-existing N+1 that `listEvents` already pays once per page, and that
 * the AI path would otherwise pay on EVERY turn at limit<=50. Backed by a
 * plain `Map<GroupId, ReadonlyArray<TeamMemberId>>` closure — there is no
 * `Effect.cachedFunction` in `effect@4.0.0-beta.40`.
 *
 * The plain `Map` needs no `Ref` ONLY because every call site passes
 * `{ concurrency: 1 }` explicitly (see `listEvents` in `readTools.ts`) —
 * never relying on `Effect.filter`'s default concurrency.
 */
export const makeCanSeeGroup = (
  groups: ServiceMap.Service.Shape<typeof GroupsRepository>,
  membershipId: TeamMember.TeamMemberId,
): ((groupId: Option.Option<GroupModel.GroupId>) => Effect.Effect<boolean>) => {
  const cache = new Map<GroupModel.GroupId, ReadonlyArray<TeamMember.TeamMemberId>>();
  return (groupId) =>
    Option.match(groupId, {
      onNone: () => Effect.succeed(true),
      onSome: (id) => {
        const cached = cache.get(id);
        if (cached !== undefined) {
          return Effect.succeed(cached.includes(membershipId));
        }
        return groups.getDescendantMemberIds(id).pipe(
          Effect.map((memberIds) => {
            cache.set(id, memberIds);
            return memberIds.includes(membershipId);
          }),
        );
      },
    });
};

// ---------------------------------------------------------------------------
// Reference-token PLACEHOLDER (plan §4).
//
// Previously this module minted its own per-row, per-executor-call random token (4 chars from a
// 32-character unambiguous alphabet), duplicating `refTokens.ts`'s alphabet/length/CSPRNG/
// collision-avoidance loop verbatim. That token was never actually usable: `ChatAgent`
// (`remapCallReferences`, `ChatAgent.ts`) re-dedupes and re-mints EVERY row into the turn's own
// token space via `refTokens.ts#mintToken` before anything reaches the model or the client, so
// every token minted here was unconditionally discarded — four wasted `crypto.getRandomValues`
// calls per row for nothing (CONCERN 9). `buildListResult` now emits a fixed placeholder instead:
// `remapCallReferences` correlates `items[i]` with `references[i]` by ARRAY POSITION, not by the
// placeholder's value, so the value itself is inert — it only needs to exist so `toRef`/`toItem`
// have something to put in the `ref` field before `ChatAgent` overwrites it. `ChatAgent` is the
// ONLY place that mints a token that ever ships.
// ---------------------------------------------------------------------------

/** Never reaches the model or the client — `ChatAgent` overwrites every row's `ref` before
 * either sees it. Kept 4 chars long purely so a bug that skips the remap step is obvious (a
 * clearly-fake token leaking through) rather than silently shipping `''`. */
const PENDING_REF = '----';

/**
 * Builds both the typed `EntityRef` (sent to the browser) and the narrow model-facing row (sent
 * to the LLM) for every row, from the same placeholder token — `ChatAgent` mints and substitutes
 * the token that actually ships (plan §4, part 1), keyed by array position.
 *
 * Returns the executor's `ToolExecutionResult` directly: every list executor's tail was otherwise
 * the same two verbatim lines (unpack `{ references, items }`, rewrap as
 * `{ result: { items }, references }`), repeated once per tool.
 */
export const buildListResult = <Row>(
  rows: ReadonlyArray<Row>,
  toRef: (row: Row, token: string) => AiChatApi.EntityRef,
  toItem: (row: Row, token: string) => Record<string, unknown>,
): ToolExecutionResult => {
  const references: Array<AiChatApi.EntityRef> = [];
  const items: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    references.push(toRef(row, PENDING_REF));
    items.push(toItem(row, PENDING_REF));
  }
  return { result: { items }, references };
};

// ---------------------------------------------------------------------------
// Shared result shapes
// ---------------------------------------------------------------------------

/** A foreign id, or an id in an invisible group, returns `not_found` — never
 * `forbidden`, which would confirm the row exists (plan §8 "Cross-team requests"). */
export const notFoundResult: ToolExecutionResult = {
  result: { error: 'not_found' },
  references: [],
};

export const forbiddenResult = (permission: Role.Permission): ToolExecutionResult => ({
  result: { error: 'forbidden', permission },
  references: [],
});
