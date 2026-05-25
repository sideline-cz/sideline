---
'@sideline/server': minor
'@sideline/web': minor
'@sideline/domain': minor
'@sideline/i18n': minor
---

Add user-facing surface for Weekly Challenges (Part 3/3 of Týdenní výzvy). Captains can create, edit, and delete one challenge per week per team; members tick "splněno" on their own row for the current ISO week. The new page at `/teams/{teamId}/challenges` shows a 12-week history grid (chronological-left, sticky member-name column on desktop, vertical card list with the active week pinned on top on mobile) with optimistic toggle updates, stale-response handling via monotonic in-flight request IDs, and post-midnight refresh on window focus. The new HTTP API at `applications/server/src/api/weekly-challenge.ts` adds six endpoints — `GET/POST/PATCH/DELETE /teams/:teamId/weekly-challenges[/:challengeId]` plus mark/unmark — reusing the existing `requireMembership` + `requirePermission` primitives; cross-team isolation is enforced on every mutation, and Discord sync events are enqueued only on Create. `MondayPicker` correctly identifies Mondays in the team's timezone (not the captain's browser) via `Intl.DateTimeFormat`, and the grid uses the server-computed `view.isActive` flag as the source of truth for current-week styling. Adds 47 new `challenges_*` i18n keys (cs primary, en fallback, gender-neutral). Closes the Sportovní aktivity bug.
