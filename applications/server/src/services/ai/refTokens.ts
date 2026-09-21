/**
 * Per-turn reference-token minting for `ChatAgent` — plan
 * `.work-plans/ai-app-interaction.md` §4.
 *
 * This is the ONLY place a reference token that ever ships (to the model or the client) is
 * minted. `toolTypes.ts#buildListResult` — the per-executor-call row builder — emits
 * `AiChatApi.SearchHit` rows, which carry no `ref` field at all
 * (`.work-plans/command-palette-search.md` §B); `ChatAgent` (`remapCallReferences`,
 * `ChatAgent.ts`) mints this module's tokens and CONSTRUCTS `EntityRef` from each hit
 * (`{ ...hit, ref: token }`) before anything leaves `ChatAgent`. It re-dedupes and re-mints
 * ACROSS THE WHOLE TURN (every tool call in every round) into a fresh `used` set per turn — a
 * token is only ever valid for the turn that minted it.
 */
import type { AiChatApi } from '@sideline/domain';

const REF_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const REF_TOKEN_LENGTH = 4;

const randomRefChar = (): string => {
  const index = crypto.getRandomValues(new Uint32Array(1))[0] % REF_ALPHABET.length;
  return REF_ALPHABET.charAt(index);
};

const randomToken = (): string => {
  let token = '';
  for (let i = 0; i < REF_TOKEN_LENGTH; i += 1) {
    token += randomRefChar();
  }
  return token;
};

/**
 * Mints a token distinct from every token already in `used`, regenerating on
 * collision, records it into `used`, and returns it.
 */
export const mintToken = (used: Set<string>): string => {
  let token = randomToken();
  while (used.has(token)) {
    token = randomToken();
  }
  used.add(token);
  return token;
};

/**
 * The stable dedup identity of a hit — "kind:id" — used to decide whether an
 * entity seen again later in the same turn (a different tool call, or the
 * same call) should reuse the token minted on first sight rather than mint a
 * new one. Takes `AiChatApi.SearchHit` (what an executor actually emits, no
 * `ref` field) — an `EntityRef` is always a valid argument too, since it is
 * a `SearchHit` plus `ref`. NOT derived from `ref` itself (the token is
 * per-turn and regenerated every turn, so it can never be the dedup key).
 * Same string as `SearchApi.searchHitId` — see that function's doc comment.
 */
export const entityKeyOf = (hit: AiChatApi.SearchHit): string => {
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

/**
 * Rebuilds the `token -> position in references` map from scratch — the
 * ONLY way `ChatAgent`'s per-turn token map is ever produced (plan §4: "a
 * `Map<token, position>` rebuilt from scratch every turn"). Cheap at the
 * turn's scale (`references.length <= MAX_REFERENCES`).
 */
export const buildTokenMap = (
  references: ReadonlyArray<AiChatApi.EntityRef>,
): ReadonlyMap<string, number> => new Map(references.map((ref, index) => [ref.ref, index]));
