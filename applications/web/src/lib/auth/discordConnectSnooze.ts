/**
 * PR-9 (Discord onboarding fix) — the "Skip for now" escape hatch's storage, per
 * `AGENTS.md` § "User-Scoped `localStorage` Keys" and the designer's §3.4 spec.
 *
 * User-scoped (never a bare, device-global key — a shared device with multiple Sideline
 * accounts must not leak one user's snooze onto another's session). Snooze suppresses the
 * `/teams/$teamId` → `/teams/$teamId/connect-discord` REDIRECT only; the persistent card and
 * the nav badge are never suppressed by this module or by anything that reads it.
 *
 * Both `getItem` and `setItem` are wrapped in try/catch, and — this is the important part — a
 * throw from `getItem` is treated as SNOOZED, not un-snoozed. Safari private mode (and any
 * storage-quota-exceeded scenario) throws synchronously on every `localStorage` call; if a read
 * failure meant "not snoozed", every page view in that session would re-evaluate the redirect
 * and the user would be trapped bouncing straight back to `/teams/$teamId/connect-discord`
 * forever. Failing open here is the only safe default.
 */

const discordSnoozeKey = (userId: string, teamId: string) =>
  `sideline:discord-connect-snoozed:${userId}:${teamId}`;

const discordSkipCountKey = (userId: string, teamId: string) =>
  `sideline:discord-connect-skip-count:${userId}:${teamId}`;

/** 24h for the first three skips, then 7 days (designer §3.4). */
const SHORT_SNOOZE_SKIP_LIMIT = 3;
const SHORT_SNOOZE_MS = 24 * 60 * 60 * 1000;
const LONG_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

const readSkipCount = (userId: string, teamId: string): number => {
  try {
    const raw = localStorage.getItem(discordSkipCountKey(userId, teamId));
    if (raw === null) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
};

/**
 * `true` when the redirect should be suppressed for this (user, team) pair — because an
 * unexpired snooze was recorded, OR because `localStorage` itself threw (fail open, see the
 * module doc comment above).
 */
export const isDiscordConnectSnoozed = (userId: string, teamId: string): boolean => {
  try {
    const raw = localStorage.getItem(discordSnoozeKey(userId, teamId));
    if (raw === null) return false;
    const until = Number(raw);
    if (!Number.isFinite(until)) return false;
    return Date.now() < until;
  } catch {
    return true;
  }
};

/**
 * Records a skip. Never throws — a failed write just means the next page load re-evaluates the
 * redirect (which itself fails open on a throw), never a crash of the "Skip for now" click.
 */
export const snoozeDiscordConnect = (userId: string, teamId: string): void => {
  const nextSkipCount = readSkipCount(userId, teamId) + 1;
  const durationMs = nextSkipCount <= SHORT_SNOOZE_SKIP_LIMIT ? SHORT_SNOOZE_MS : LONG_SNOOZE_MS;
  try {
    localStorage.setItem(discordSkipCountKey(userId, teamId), String(nextSkipCount));
    localStorage.setItem(discordSnoozeKey(userId, teamId), String(Date.now() + durationMs));
  } catch {
    // Best-effort — see module doc comment. `isDiscordConnectSnoozed` fails open regardless.
  }
};

/** How many times this (user, team) pair has clicked "Skip for now" — drives the §3.4 "you've
 * skipped this a few times" nudge on the third and later visits. `0` on any read failure. */
export const discordConnectSkipCount = (userId: string, teamId: string): number =>
  readSkipCount(userId, teamId);
