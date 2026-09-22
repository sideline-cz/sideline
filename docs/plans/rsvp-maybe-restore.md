# Restore `maybe` as a first-class "Nevím" RSVP

Story: Notion `3d793506-0818-8008-9ff6-dee4b4bf4ec1` — *uprav možnost přijdu později na přijdu později / nevím*
Branch: `feat/adjust-later-option`

## Semantic model after this change

| response | label (cs / en) | attending? | comment | submit |
|---|---|---|---|---|
| `yes` | Ano / Yes | yes | optional | instant |
| `coming_later` | Přijdu později / Coming later | yes | **mandatory** | modal |
| `maybe` | **Nevím / Not sure** | **no** | optional | instant |
| `no` | Ne / No | no | optional | instant |

Canonical order everywhere — buttons, embed fields, summary slots, list sorts, SQL rank — is the gradient `yes → coming_later → maybe → no`.

Today `maybe` is a legacy DB-only value; every server read surface projects `coming_later → maybe`, so clients cannot tell them apart. That projection is removed.

## Decisions taken

1. **"Nevím" does not count as attending.** The attendance predicate is narrowed so `maybe` no longer counts.

   **No data migration** — and the plan originally specified one, on a premise that turned out to be false. `1790300016` deferred converting historical `maybe` rows to a "Release B follow-up", but before #549 (`5ec1fcba`) the button was literally labelled `❓ Maybe` / `❓ Možná`, so those rows already mean "Nevím" and are correct as stored. Converting them would have rewritten real answers to the opposite meaning, irreversibly, and minted `coming_later` rows with `message IS NULL` against the mandatory-note invariant. Historical rows do stop counting as attending, which is right — they were uncertain answers all along — and the blast radius is small: the only automatic consumer, `TrainingAutoLogCron`, has a 7-day event window.
2. **The "✅ Jdou" list excludes `maybe`.**
3. **Label is "Nevím" / "Not sure"** — not "Možná". A first-person verb discriminates on the first token; Discord truncates from the right.
4. **`my_response_actual` is kept** for one more release (rolling-deploy safety).
5. **The CHECK constraint is NOT tightened.** `maybe` is now actively written; the old note suggesting a future drop is obsolete and is contradicted in the new migration's header.

## Why the attendance change matters

`maybe` currently returns `true` from `isAttendingRsvpResponse`, which feeds **write** paths:

- `TrainingAutoLogCron.ts:33` — inserts an `activity_logs` row with `source: 'auto'` every cron cycle
- `EventRosterProvisioningService.ts:231` — `upsertApproved` + `addMemberToRoster` (a real Discord role grant), or an owner approval request
- `TeamGenerationRepository.ts:111` — the auto-balancer's player pool
- `player-rating.ts:303` — the `notRsvpYes` game-result guard
- `rpc/event/index.ts:1550` and `api/event-roster.ts:196` — the auto-approve backfill twins

Without the narrowing, answering "I don't know" auto-logs training attendance and claims a roster slot.

**Consequence to note in the release:** `coming_later → maybe` now satisfies `isWithdraw`, so one tap on "Nevím" removes the roster entry and the Discord role; tapping "Přijdu později" again re-enters as `pending` behind the queue when `auto_approve` is off. This makes "Nevím" the most destructive button in the row — which is why it sits in slot 3, not slot 2.

---

## packages/migrations

**No migration.** One was written (`1792200000_convert_rsvp_maybe_to_coming_later.ts`, `UPDATE event_rsvps SET response = 'coming_later' WHERE response = 'maybe'`) and then deleted — see the decision above. Historical `maybe` rows already mean "Nevím" and are correct as stored.

The CHECK constraint is **not** tightened either: `1790300016` already permits all four literals, and `maybe` is now actively written, so dropping it would reject every new "Nevím". The note in `1790300016` suggesting a future drop is obsolete; `applications/server/AGENTS.md` records why.

## applications/server — attendance narrowing

| file:line | change |
|---|---|
| `utils/rsvpAttendance.ts:7` | drop the `'maybe'` arm; rewrite the doc comment |
| `repositories/EventRsvpsRepository.ts:241` | `findYesRsvpMemberIds` → `IN ('yes','coming_later')` |
| `repositories/EventRsvpsRepository.ts:215` | `findYesAttendeesWithLimit` → `IN ('yes','coming_later')` |
| `repositories/TeamGenerationRepository.ts:111` | → `IN ('yes','coming_later')` |
| `api/player-rating.ts:303` | narrow `notRsvpYes`; the L300 comment already described the intended set |
| `repositories/EventRsvpsRepository.ts:187` | rank `yes 1 / coming_later 2 / maybe 3 / no 4` — without this the two buckets interleave across attendee pages |

`EventsRepository.ts:840` (iCal feed filter) deliberately keeps all three — that is "events I have any interest in for my calendar", not an attendance roster.

## applications/server — projection removal

Delete `utils/rsvpWireProjection.ts`. Call sites:

- `rpc/event/index.ts` — L46 import; L573 `isLateRsvpChange` becomes `r !== response` (maybe ↔ coming_later is now a genuine change and should announce); L708/L1128 pass through; L930–960 SQL splits `maybe_count` from a new `coming_later_count` and drops the `CASE WHEN … THEN 'maybe'` cast
- `rpc/guild/index.ts` — L1579–1581, L1604–1608, L1665–1667: identical edits (the two queries differ only by this one's absent `LIMIT`/`OFFSET`)
- `api/dashboard.ts` — L12 import out, L121 passes through
- `api/event-rsvp.ts` — L23 import out; L105–108 splits into two `Array.findFirst` pipes matching `yesCount`

`api/ical.ts` — **no change.** There is no `PARTSTAT` line; L145–148 already distinguishes `[Maybe] ` from `[Later] `. Locked with a test instead.

### Note-retention fix

`coming_later` mandates a note, and the upsert does `message = COALESCE(…)`, so switching to "Nevím" today keeps *"dorazím v 19:00"* attached and renders `Nevím\n💬 dorazím v 19:00`. Fixed at the single chokepoint all three clients route through, reusing the already-bound `priorRsvp`:

```ts
Effect.let('effectiveClear', ({ priorRsvp }) =>
  clearMessage ||
  (Option.isNone(message) &&
   response !== 'coming_later' &&
   Option.exists(priorRsvp, (r) => r.response === 'coming_later'))),
```

This covers the bot. The web panel re-sends `savedMessage`, which is never empty on exactly this transition, so it needs the matching one-liner at `EventRsvpPanel.tsx:79`: send `''` (the existing clear signal) when leaving `coming_later`.

## packages/domain

- `EventRpcModels.ts` — L145 `RsvpAttendeeEntry.response` → `RsvpResponse`; L203 `my_response` → `OptionFromNullOr(RsvpResponse)`; **keep** `my_response_actual` (L204–216) with a rewritten rationale; add `coming_later_count` with `withDecodingDefaultKey(() => 0)`
- `EventRsvpApi.ts` — delete `LegacyRsvpResponse`; widen `RsvpEntry.response` and `EventRsvpDetail.myResponse`; add `comingLaterCount`
- Retarget three stale comments that cite the deleted file: `domain/src/index.ts:96`, `domain/src/api/Invite.ts:18`, `server/src/utils/inviteErrorWireProjection.ts:16`

Aggregates left lumped after a re-confirmed dead-field audit: `RsvpCountsResult`, `SubmitRsvpResult`, `RsvpReminderSummary.maybeCount`, `GuildEventListEntry.maybe_count` — none are rendered.

## applications/bot

`rest/events/buildUpcomingEventEmbed.ts` — row 1 becomes four buttons in gradient order. `myActualResponse` now drives row 1's style highlight as well as row 2's ids (never worse against a new server, strictly better against an old one, and it deletes a special case).

| row | response | custom_id | len |
|---|---|---|---|
| 1 | yes | `upcoming-rsvp:{event}:{team}:yes` | 91 |
| 1 | coming_later | `u-add-msg:{team}:{event}:coming_later:v` | **98** |
| 1 | maybe | `upcoming-rsvp:{event}:{team}:maybe` | 93 |
| 1 | no | `upcoming-rsvp:{event}:{team}:no` | 90 |
| 2 | always | `attendees:{team}:{event}:0` | 85 |
| 2 | resp=yes | `u-add-msg:…:yes` / `u-clear-msg:…:yes` | 87 / 89 |
| 2 | resp=no | `u-add-msg:…:no` / `u-clear-msg:…:no` | 86 / 88 |
| 2 | resp=maybe | `u-add-msg:…:maybe` / `u-clear-msg:…:maybe` | 89 / 91 |
| 2 | resp=coming_later | `u-add-msg:…:coming_later` (no clear button) | 96 |

**No collision:** four prefixes are in play. Only `u-add-msg:` appears in both rows, yielding two ids per message — row 1's `…:coming_later:v` (98) and row 2's `…:{my_response}` (≤96) — which collide only without the `:v` marker, i.e. the exact 50035 bug it exists to prevent. `maybe` reuses `upcoming-rsvp:`, which row 2 never mints, so it adds zero new collision surface. **No overflow:** max 98 ≤ 100, 2 characters of headroom.

Other bot changes: `buildAttendeesEmbed.ts` grows to four buckets in gradient order; `interactions/rsvp.ts` `localizeRsvpResponse` stops folding `coming_later` into `rsvp_maybe`. `interactions/upcoming-rsvp.ts` and the legacy `rsvp:` card need no change.

## applications/web

`EventRsvpPanel.tsx` — delete the `isLate` helper; four buttons in gradient order; `maybe` instant-submits and does not steal focus; `messageRequired` is `coming_later` only (L88 too); below-min-players becomes `yesCount + comingLaterCount` (the string says "Pouze {count} potvrzeno" and "Nevím" is not confirmed).

Layout: `flex gap-2` has no wrap and the buttons are `whitespace-nowrap` — four of them with icons is ~389px against ~328px usable at a 360px viewport. Becomes `grid grid-cols-2 gap-2 sm:flex sm:flex-wrap` with `w-full sm:w-auto`.

Accessibility: lucide `Check`/`Clock`/`CircleHelp`/`X` as the non-colour discriminator; `{messageRequired && ' *'}` becomes an `aria-hidden` span (today a screen reader announces "asterisk"); helper text rendered permanently and wired via `aria-describedby`, both ids on error; `aria-pressed` true on exactly one button.

Also: `TeamDetailPage.tsx` `RsvpBadge` gains a fourth key (amber for `maybe`); `events.$eventId.tsx` narrows its filter to `yes || coming_later`; `HomePage.tsx` keeps its demo datum but moves the `maybe` style blue → amber; `e2e/fixtures/mock-data.ts:201` gains `comingLaterCount`.

## packages/i18n

Strategy: retarget the misnamed `*maybe*` keys (which today render "Přijdu později"), add new `*coming_later*` keys. Renaming would orphan admin translation-override rows.

**Retarget:** `rsvp_maybe` → `Nevím`/`Not sure`; `bot_btn_maybe` → `❓ Nevím`; `bot_attendees_maybe` → `❓ Nevím ({count})`; `bot_your_rsvp_maybe` → `❓ Nevím`; `dashboard_rsvpMaybe` → `Nevím`; `rsvp_undecided` → `{count} neví`.

**Add:** `rsvp_comingLater`, `rsvp_comingLaterCount`, `rsvp_messageHelpRequired`, `rsvp_messageHelpOptional`, `dashboard_rsvpComingLater`, `bot_btn_coming_later`, `bot_attendees_coming_later`, `bot_your_rsvp_coming_later`.

(`rsvp_comingLater` serves both the web `tr()` call and the bot's `localizeRsvpResponse`, exactly as `rsvp_maybe`/`rsvp_yes` already do — no separate snake_case twin.)

**Modify:** `bot_embed_rsvp_summary` → `✅ {yes}  ·  🕒 {coming_later}  ·  ❓ {maybe}  ·  ❌ {no}` (today it is yes/no/later, so there is no status quo to preserve).

---

## Tests

**Migration** — converts every historical row; idempotent; the CHECK constraint still accepts a fresh `maybe` write (this is the guard against anyone later "tidying up" the constraint).

**Attendance (highest value)** — `maybe` does not provision a roster seat; `coming_later → maybe` runs the withdrawal branch; `maybe → coming_later` provisions; `findYesRsvpMemberIds` and `findYesAttendeesForEmbed` exclude `maybe`; `findAttendeesPage` orders `yes < coming_later < maybe < no` and pages without interleaving; the four-literal truth table for `isAttendingRsvpResponse`; a `maybe` responder is not auto-logged; a game result naming a `maybe` responder fails `notRsvpYes`.

**Server** — `prior maybe → coming_later` announces as a late change; submitting `maybe` with no message succeeds; the note-clearing guard (and its negative: `coming_later → coming_later` preserves the note); iCal renders `[Maybe] ` and `[Later] ` distinctly; the count split.

**Bot** — four buttons in gradient order; `maybe` instant-submits; `coming_later` keeps `:v`; **the uniqueness table extended to all four responses × message present/absent (8 cases) with real 36-char UUIDs**, asserting set-uniqueness and `length <= 100`; exactly one button highlighted; four distinct "your RSVP" labels; four counts in the summary.

**Web** — fix the local `tr` stub *first*: it maps `rsvp_maybe: 'Coming later'` with a `map[key] ?? key` fallback, so after the retarget six `getByRole('button', { name: 'Coming later' })` queries silently resolve to the **maybe** button. Then invert the two tests that assert the conflation, and rewrite the two below-min-players tests (they keep passing with `comingLaterCount` defaulting to 0 while covering nothing).

**Domain** — decode `coming_later` on both widened DTOs; `coming_later_count` absent ⇒ 0; `my_response_actual` absent ⇒ `none`.

## Risks

1. **Rolling deploy — the ordering is NOT symmetric between bot and web.**

   - **Bot before or with the server.** An old bot decoding `coming_later` against the legacy 3-literal union fails the *whole* RPC result, not one row — reconcile passes and the Attendees button break for any team with a `coming_later` RSVP. The reverse (new bot, old server) is safe: `my_response_actual` already ships on the currently-deployed server, so the bot reads the true value.
   - **Web with or AFTER the server — never before.** `EventRsvpDetail` has no `my_response_actual` equivalent, and adding one now would not help (the currently-deployed server does not emit it). Against an old server that still projects, the panel sees `myResponse: 'maybe'` for a member who actually stored `coming_later`, so `messageRequired` is false, the mandatory note becomes editable, and a Save writes `response: 'maybe'` — silently downgrading the RSVP and discarding the note. That is a *write*-side corruption, strictly worse than the old-bundle failure mode it would be trading against (an old web bundle against a new server merely 404s the event route until reload: transient, read-only, self-healing).

   **Order: bot → server → web** (server and web together is fine).
2. **`my_response_actual` must not be deleted** until the projection is gone from every deployed instance — follow-up ticket.
3. **Behaviour change on write paths** — roster grants, auto activity logs, team generation and game-result eligibility stop counting "Nevím". No-op for existing data thanks to the migration; needs a release note.
4. **Discord 50035** remains the highest-consequence code risk (it kills the whole card). Mitigated by the 8-case uniqueness table. 2 characters of headroom.
5. **One-time personal-card re-PATCH storm** — the card hash covers components, so every member's card re-PATCHes once at concurrency 1 after deploy. Expected, not a regression.
6. **Metric series break** on `rsvpSubmissionsTotal{response="maybe"}` — re-baseline dashboards at the deploy timestamp.
7. **Translation overrides** on `rsvp_maybe`, `rsvp_undecided`, `dashboard_rsvpMaybe` will render stale text — ops check `/admin/translations` after deploy.

## Build order

`pnpm build:packages && pnpm codegen && pnpm check && pnpm test`

Domain and migrations changes need a build before type-checking (apps resolve `dist/`, not `src/`); i18n changes need `pnpm codegen`. Stale `.tsbuildinfo` will blame untouched files — delete and rebuild. Run only the RSVP + migration integration slice locally.
