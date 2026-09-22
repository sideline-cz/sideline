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
 * The team, the caller's permissions, and the memoized group-visibility check — everything a
 * read tool needs that is NOT specific to the chat turn. Split out of `ToolContext` (below) so
 * the command-palette search endpoint (`.work-plans/command-palette-search.md` §A), which has no
 * chat turn and therefore no `teamTimezone`, can build one of these directly and call the same
 * executors the assistant does, with no per-keystroke `TeamSettingsRepository` lookup.
 */
export interface EntityReadContext {
  readonly teamId: Team.TeamId;
  readonly membership: MembershipWithRole;
  /** Memoized `checkGroupAccess` — see `makeCanSeeGroup` below. */
  readonly canSeeGroup: (groupId: Option.Option<GroupModel.GroupId>) => Effect.Effect<boolean>;
}

/**
 * No tool parameter may carry `teamId`. The team, the caller's permissions and
 * the team's timezone come from here, resolved BEFORE the model is ever
 * called — the model has no vocabulary in which to name another team.
 */
export interface ToolContext extends EntityReadContext {
  readonly teamTimezone: string;
}

/**
 * Every read executor's result. `E = never` — permission and not-found
 * outcomes are ENCODED as `result` (e.g. `{ error: 'forbidden', permission:
 * '<perm>' }` / `{ error: 'not_found' }`), never thrown. `hits` is the
 * typed view-model slice this call minted (plan §B: `AiChatApi.SearchHit`, not `EntityRef` —
 * no `ref` token, since an executor has no notion of a chat turn), for `ChatAgent` to mint
 * tokens for and accumulate, or for search to return directly.
 */
export interface ToolExecutionResult {
  readonly result: unknown;
  readonly hits: ReadonlyArray<AiChatApi.SearchHit>;
  /** Set only by `writeTools.ts`'s `proposeAction` — a pending action the client must confirm or
   *  reject. Optional so the six read executors and `buildListResult` are untouched. */
  readonly proposal?: AiChatApi.Proposal | undefined;
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
// buildListResult
//
// Previously this module minted its own per-row, per-executor-call random token (4 chars from a
// 32-character unambiguous alphabet), duplicating `refTokens.ts`'s alphabet/length/CSPRNG/
// collision-avoidance loop verbatim, then a fixed placeholder token after that (CONCERN 9). Both
// were needed only because `EntityRef` itself carried the per-turn `ref` field — now that
// `AiChatApi.SearchHit` (what an executor actually emits) has no `ref` at all
// (`.work-plans/command-palette-search.md` §B), there is no token to mint or placeholder here.
// `ChatAgent` (`remapCallReferences`, `ChatAgent.ts`) is the ONLY place that ever mints a token
// that ships — it now CONSTRUCTS `EntityRef` from a `SearchHit` (`{ ...hit, ref: token }`)
// instead of overwriting a placeholder field.
// ---------------------------------------------------------------------------

/**
 * Builds both the typed `SearchHit` (sent to the browser, or to `ChatAgent` for it to mint a
 * token onto) and the narrow model-facing row (sent to the LLM) for every row.
 *
 * Returns the executor's `ToolExecutionResult` directly: every list executor's tail was otherwise
 * the same two verbatim lines (unpack `{ hits, items }`, rewrap as `{ result: { items }, hits }`),
 * repeated once per tool.
 */
export const buildListResult = <Row>(
  rows: ReadonlyArray<Row>,
  toHit: (row: Row) => AiChatApi.SearchHit,
  toItem: (row: Row) => Record<string, unknown>,
): ToolExecutionResult => {
  const hits: Array<AiChatApi.SearchHit> = [];
  const items: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    hits.push(toHit(row));
    items.push(toItem(row));
  }
  return { result: { items }, hits };
};

// ---------------------------------------------------------------------------
// Shared result shapes
// ---------------------------------------------------------------------------

/** A foreign id, or an id in an invisible group, returns `not_found` — never
 * `forbidden`, which would confirm the row exists (plan §8 "Cross-team requests"). */
export const notFoundResult: ToolExecutionResult = {
  result: { error: 'not_found' },
  hits: [],
};

export const forbiddenResult = (permission: Role.Permission): ToolExecutionResult => ({
  result: { error: 'forbidden', permission },
  hits: [],
});
