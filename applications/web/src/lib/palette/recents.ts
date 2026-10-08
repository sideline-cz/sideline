/**
 * The command palette's recent destinations — the last few things this browser opened from the
 * palette, per team, newest first. Shown on an empty query only: a recents list that re-orders
 * under each keystroke is noise, and search already covers the typing case.
 *
 * PRIVACY. An entry stores the whole `SearchHit`, so the row renders without a refetch — which
 * means member display names and avatar URLs sit in `localStorage`. Three things bound that:
 * the key is per team (switching teams can never surface another club's names), `clearRecents`
 * runs on logout, and nothing here is ever sent to the server. The residual exposure is real
 * but small: a member whose permission is revoked keeps seeing cached LABELS until they log
 * out. Opening one is still gated — the route re-checks server-side — so it is a stale name,
 * never an access grant. Do not widen this to anything the label itself must not reveal.
 *
 * Every read and write is wrapped: Safari private mode throws on `localStorage` access rather
 * than returning null, and a palette that cannot open is worse than one with no history.
 *
 * Entries are stored ENCODED, not as the decoded `SearchHit`. A hit carries `Option`s and
 * `DateTime.Utc`s, and `JSON.parse(JSON.stringify(hit))` hands back plain objects that every
 * `Option.isSome` in `AssistantResultCard` would then misread. Encoding through the schema is
 * the same round trip the wire already does, so a stored entry and a fresh search result decode
 * to exactly the same value.
 */
import { type AiChatApi, SearchApi } from '@sideline/domain';
import { Schema } from 'effect';

export const RECENTS_LIMIT = 5;

const KEY_PREFIX = 'sideline:palette-recents:';

const keyFor = (teamId: string) => `${KEY_PREFIX}${teamId}`;

/** A visited palette destination: either an entity hit or a static nav entry's route. */
export type RecentEntry =
  | { readonly type: 'hit'; readonly hit: AiChatApi.SearchHit }
  | { readonly type: 'nav'; readonly to: string };

const StoredEntry = Schema.Union([
  Schema.Struct({ type: Schema.Literal('hit'), hit: SearchApi.SearchHit }),
  Schema.Struct({ type: Schema.Literal('nav'), to: Schema.String }),
]);
const encodeEntries = Schema.encodeSync(Schema.Array(StoredEntry));
const decodeEntries = Schema.decodeUnknownSync(Schema.Array(StoredEntry));

/** Dedup identity. Hits reuse `searchHitId` rather than re-deriving `"<kind>:<id>"` here. */
export const recentEntryId = (entry: RecentEntry): string =>
  entry.type === 'hit' ? `hit:${SearchApi.searchHitId(entry.hit)}` : `nav:${entry.to}`;

export function readRecents(teamId: string): ReadonlyArray<RecentEntry> {
  try {
    const raw = window.localStorage.getItem(keyFor(teamId));
    if (raw === null) return [];
    // A decode failure is the expected path after a `SearchHit` variant changes shape, not an
    // exceptional one: the whole list is dropped and rebuilt from the user's next few visits.
    return decodeEntries(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Puts `entry` at the front, drops any earlier visit to the same destination, caps the list. */
export function pushRecent(teamId: string, entry: RecentEntry): ReadonlyArray<RecentEntry> {
  const id = recentEntryId(entry);
  const next = [entry, ...readRecents(teamId).filter((e) => recentEntryId(e) !== id)].slice(
    0,
    RECENTS_LIMIT,
  );
  try {
    window.localStorage.setItem(keyFor(teamId), JSON.stringify(encodeEntries(next)));
  } catch {
    // Quota or a blocked store — the list returned to the caller is still correct for this
    // session, it just will not survive a reload.
  }
  return next;
}

/** Called on logout. Clears EVERY team's list, not just the active one. */
export function clearRecents(): void {
  try {
    // Collect first, then remove: `localStorage` is live, so removing inside the index walk
    // shifts every later key down one and silently skips half of them.
    const doomed: Array<string> = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(KEY_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
  } catch {
    // Nothing to do — see the module comment.
  }
}
