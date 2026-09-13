# Fix training notifications — implementation plan

**Bug:** Uprav notifikace na tréninky · Discord Bot · production · `fix/training-notifications`

Maxič's report, as three acceptance criteria:

1. The late-arrival channel gets a notice **only when someone changes an answer they already gave** — not on every RSVP submission.
2. The summary posted when reminders go out is not needed — remove it.
3. The summary posted when an event starts is not needed — remove it.

Two product decisions were confirmed before planning:

- **AC3 removes the whole post**, not just its embed. The coach `@mention` and the "nobody claimed this training" warning go with it.
- **AC1 is changes-only.** A member who ignores the reminder and then answers for the first time 30 minutes before training produces *no* late-channel notice. Only a subsequent change does.

---

## Task 1 — Late channel fires only on a real answer change

**File:** `applications/server/src/rpc/event/index.ts:555-566`

Today one boolean does two jobs:

```ts
Effect.let('isLateRsvp', ({ event, upsertResult }) =>
  Option.isSome(event.reminder_sent_at) &&
    (Option.isNone(upsertResult.priorResponse) ||
      Option.exists(upsertResult.priorResponse, (r) => r !== response))),
Effect.bind('lateRsvpChannelId', ({ isLateRsvp }) =>
  isLateRsvp ? svc.teamSettings.findLateRsvpChannelId(team_id) : Effect.succeed(Option.none())),
```

It drives both the channel post *and* the ephemeral `bot_rsvp_late_hint` shown to the submitting
member. Those two now want different answers, so they get two booleans:

- `isLateRsvp` — **unchanged.** Reminder sent, and this is either a first answer or a change.
  Keeps the ephemeral hint working for the first-answer-after-reminder case it was written for.
- `isLateRsvpChange` — **new.** Reminder sent **and** a prior response existed **and** it differs.
  Gates the `findLateRsvpChannelId` lookup, so `lateRsvpChannelId` is `Some` only when the post
  should actually happen.

Compare through `projectRsvpResponseToLegacy` (`applications/server/src/utils/rsvpWireProjection.ts`)
rather than raw stored values, so a legacy `maybe` row hit with the "Coming later" button is not
announced as a change — both render as *Možná* and the post would read as a no-op change.

**Why gate the lookup instead of adding a wire field.** An explicit `isLateRsvpChange` on
`SubmitRsvpResult` would need `Schema.withDecodingDefaultKey` for rolling-deploy skew, and old bot
pods would keep posting on first answers for the whole rollout window. Gating the channel id fixes
the bug the moment the *server* deploys, regardless of bot version. The trade-off is that
`lateRsvpChannelId: None` now means either "no channel configured" or "not a change" — a comment on
the `Effect.bind` records that.

**Bot side:** `applications/bot/src/interactions/rsvp.ts` needs **no logic change**. Its guard at
`:144` is `if (!counts.isLateRsvp || Option.isNone(counts.lateRsvpChannelId))` — a changed answer
still sets `isLateRsvp: true`, so the post fires; a first answer arrives with `lateRsvpChannelId:
None` and is dropped. The `!counts.isLateRsvp` half stays as defence-in-depth. Doc comment at
`:125-130` gets rewritten to state where the decision actually lives.

**Copy fix.** `bot_late_rsvp_notification` currently reads *"{user} responded **{response}** to
{event} after the reminder was sent."* That now misdescribes every message it sends. Reword to a
changed-answer phrasing in both `packages/i18n/messages/en.json` and `cs.json` (key name stays —
it is referenced from `docs/api.md`).

## Task 2 — Remove the reminder-dispatch summary post

**File:** `applications/bot/src/rcp/event/handleRsvpReminder.ts`

Delete `nameFieldChunks` (`:47-48`), `yesAttendeeNames` / `nonResponderNames` (`:50-51`), the
`fields` array (`:78-98`) and `postChannel` (`:100-117`). The final line (`:169`) becomes
`return sendDms;`.

**The per-non-responder DMs (`:131-167`) stay** — that is the actual reminder; only the channel
summary goes.

Because `channelId` now only feeds the DM deep-link, the `if (!channelId) return
Effect.logWarning(...)` early return (`:37-44`) is no longer justified — it would abort the DMs over
a missing system channel. Delete it and give `linkFor` (`:123-129`) a three-step fallback: personal
channel → `channelId` → `https://discord.com/channels/${event.guild_id}`.

Drop the now-unused `formatNameWithMention, splitIntoFieldChunks` import (`:8`). Leave the
`Event/GetRsvpReminderSummary` RPC alone — `nonResponders` is still needed, and narrowing an RPC
result is a two-release dance for no gain. A comment at the `Effect.bind('summary', …)` notes that
only `nonResponders` is consumed now.

## Task 3 — Remove the event-start summary post

**File:** `applications/bot/src/rcp/event/handleStarted.ts`

Delete `newPost` (`:28-179`), `safeNewPost` (`:181-188`), `STARTED_POST_COLOR` (`:14`) and
`parseGuild` (`:16-20`). Line `:226` becomes `return safeDeleteClaim.pipe(Effect.asVoid);`, keeping
the `Effect.exit` + `logWarning` wrapper so a Discord failure still doesn't fail the sync event.

`deleteClaim` (`:190-216`) **stays** — it deletes the owners-thread claim message.

Biome treats unused imports as errors, so all thirteen orphans must go: `EventRpcModels`, `m`,
`Array`, `DateTime`, `pipe`, `Schema`, `Locale`, `guildLocale`, `YES_EMBED_LIMIT`,
`formatEventWhenLong`, `locationDisplay`, `formatNameWithMention`, `splitIntoFieldChunks`,
`DfxGuild`. Only `DiscordREST`, `Effect`, `Option`, `SyncRpc` and the `EventRpcEvents` type survive.

**Do not touch `EventStartCron`.** The all-day `event_started` emit is what triggers claim-message
deletion; removing it would regress unrelated behaviour. Its only remaining effect becomes deleting
the claim message at 08:00 local instead of midnight — invisible, since `all_day_post_time` is not
exposed anywhere.

## Task 4 — Dead code

Delete, with the tests that cover them:

| Item | Where | Why it's safe |
|---|---|---|
| `formatEventWhenLong` | `applications/bot/src/rest/events/eventWhen.ts:57` | Only production caller was `handleStarted.ts:81` |
| `splitIntoFieldChunks` | `applications/bot/src/rest/utils.ts:76` | Only callers were `handleStarted.ts:72` and `handleRsvpReminder.ts:48` — both deleted here |
| `bot_event_started_post_title` | `packages/i18n/messages/{cs,en}.json` | Only `handleStarted.ts:161` |
| `bot_event_started_post_title_all_day` | same | Only `handleStarted.ts:160` |
| `bot_event_started_post_attendees` | same | Only `handleStarted.ts:112` |
| `bot_event_started_no_coach_warning` | same | Only `handleStarted.ts:133,137` |

Both locale files must change together — `packages/i18n/test/keyParity.test.ts` fails on asymmetry.

**Keeps its callers, do not delete:** `formatNameWithMention`, `locationDisplay`, `formatEventWhen`,
`YES_EMBED_LIMIT`, `rsvp_nonRespondersTitle` (web), `bot_embed_*`, the reminder-DM keys,
`REMINDER_COLOR`, `bot_rsvp_late_hint`, `SubmitRsvpResult.isLateRsvp`.

## Task 5 — Docs

| File | Change |
|---|---|
| `docs/discord-bot.md:710,756,824` | `postRsvpDiscordUpdates` fires on a *changed* answer, not on "the RSVP was late" |
| `docs/discord-bot.md:1742` | Delete the "Starting now" post paragraph (coach/role mention, `GetYesAttendeesForEmbed`) |
| `docs/discord-bot.md:1743` | Reminder is DM-only now; no yellow channel embed |
| `applications/docs/.../guides/notifications.mdx:21,23-26,30` | Reminders channel only resolves the DM deep-link fallback; reminders are DM-only; fix the stale "voting message" link wording |
| `applications/docs/.../guides/notifications.mdx:34-40` | Delete the "Event-start announcements" section |
| `applications/docs/.../guides/discord-integration.mdx:26-27` | Drop "and event-start announcements"; late channel posts only on a changed answer |
| `applications/docs/.../changelog.md` | Prepend a plain-language entry |
| `applications/server/AGENTS.md:866-889` | The snippet quotes `isLateRsvp` verbatim — update to both booleans, and fix the already-stale `Effect.bind('priorRsvp', …)` shape to the CTE shape production actually uses |
| `applications/bot/AGENTS.md:45,519,967` | `handleStarted` posts nothing; drop the `handleRsvpReminder` bullet from the `formatNameWithMention` consumer list |

## Task 6 — Tests

Written before implementation; every changed case must fail first.

**Server — `applications/server/test/EventRsvp.test.ts`** (harness at `:1692-2045` already has
`rpcLateRsvpChannelId` / `makeSubmitRsvp`; no new mocks):

- **The core regression:** first answer after the reminder, channel configured → `isLateRsvp: true`
  **and** `lateRsvpChannelId: None`.
- Prior `yes` → `no` after reminder → channel `Some`.
- Prior `yes` → `yes` after reminder → `isLateRsvp: false`, channel `None`.
- Prior `yes` → `no` with **no** `reminder_sent_at` → channel `None`.
- `clearMessage: true` re-submitting the same response after the reminder → channel `None`.
- Prior `no` → `coming_later` after reminder → channel `Some`.
- Prior legacy `maybe` → `coming_later` after reminder → channel `None` (projection).
- **Rewrite `:2158`** — it seeds a first-time RSVP and asserts channel `Some`; reseed with a prior
  response. **Rewrite `:2187`** too, which would otherwise pass vacuously.

**Bot — `handleRsvpReminder.test.ts`:** `:131`, `:146`, `:161` assert `createMessageCalls.length >= 1`
against a default empty `nonResponders` and break — retarget them at the DM payload with one
non-responder seeded. Delete the channel-embed field assertions at `:273`, `:346`, `:384` (the DM
siblings at `:293`/`:361` keep the `formatEventWhen` coverage); keep only the DM half of `:318`.
New: posts nothing to the reminder channel; no non-responders → zero Discord calls; still DMs when
no channel resolves, with the guild-level link; DM count matches non-responders having a `discord_id`.

**Bot — `handleStarted.test.ts`:** delete the 16 tests asserting the "Starting now" payload (`:167`,
`:182`, `:199`, `:216`, `:256`, `:284`, `:313`, `:345`, `:476`, `:497`, `:525`, `:549`, `:587`,
`:600`, `:613`, `:622`). Keep the four `T12.B.*` claim tests and `:637` (all-day claim deletion).
New: zero `createMessage` for timed and all-day events; never fetches the guild; never calls
`Event/GetYesAttendeesForEmbed`.

**Bot — `rsvp.test.ts`:** add the contract test — `isLateRsvp: true` with `lateRsvpChannelId: None`
(server withheld it) → zero REST calls.

**`eventWhen.test.ts`:** delete `describe('formatEventWhenLong')` (`:182-225`). Delete the
`splitIntoFieldChunks` tests in the `rest/utils` suite.

---

## Risks, and what is deliberately out of scope

- **The loudest late signal disappears.** Someone who never responded and drops a `no` 20 minutes
  before training now produces nothing. This is what AC1 asks for and was confirmed, but it is the
  biggest behavioural surprise in the PR and belongs in the description.
- **DMs become the only reminder.** A member with DMs closed previously still saw the channel post;
  now they get nothing, and the DM failure is swallowed into a `logWarning`
  (`handleRsvpReminder.ts:158-162`). Worth a follow-up — a failed-DM counter and a
  `Sent N/M reminder DMs` log line — but out of scope here.
- **`rest.getGuild` (`handleRsvpReminder.ts:23`) becomes a single point of failure** for the whole
  reminder now that nothing else depends on it. Catching it into a default locale would keep DMs
  flowing, but it silently degrades a Czech team to English — a real decision, not a cleanup, so
  it's flagged rather than folded in.
- **The ephemeral hint is mildly wrong for mind-changers** ("next time respond before the reminder
  goes out" shown to someone who *did* answer in time). Pre-existing, unchanged here.
- **The web RSVP surface never posted to the late channel** (`applications/server/src/api/event-rsvp.ts:213`).
  `applications/server/AGENTS.md:891` says per-response side effects belong on both write surfaces,
  so the PR should say this is a pre-existing gap being deliberately left alone.

## Build notes

No `packages/domain` change, so no wire-compat concern. `packages/i18n` needs a rebuild before
typecheck: `pnpm --filter @sideline/i18n build && pnpm check && pnpm lint && pnpm test:unit`.
No migration. The server integration suite is serial — no overlapping vitest runs.
