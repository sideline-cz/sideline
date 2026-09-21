# Design: AI assistant — PR B, create-event with confirmation

UI/UX specification for the assistant's **first write path**. The assistant may now *propose*
`create_event`; the user must verify the proposal field by field and explicitly confirm before
anything is created.

**Scope: `create_event` only.** No updates, no deletes — therefore no before→after diffs, no
destructive-action dialog, and no "stale entity" handling anywhere in this document.

This spec sits on top of what PR A actually shipped (`cb833d73`), not on top of the PR A design
doc. Where the two differ, the **code** is authoritative; §0.2 lists the differences that matter.

**This revision conforms to the reconciled wire contract** (§1). Where an earlier revision of this
document and `.work-plans/ai-assistant-write.md` disagreed, the contract in §1 is now the single
source of truth for both, and this document derives from it rather than restating a competing
version of it.

Companion documents:
- `.work-plans/ai-app-interaction-design.md` — PR A's UI spec. Its §9 is the note this document
  turns into a real spec; its §3.1 (P1/P2), §5 (a11y) and §7 (no computed keys) are **inherited
  rules, not restated arguments**.
- `.work-plans/ai-assistant-write.md` — the implementation plan for the same PR (server + domain +
  web). It owns the `Schema` definitions, the tool contract and the server-side error mapping.
- `.work-plans/ai-app-interaction.md` §16 — the protocol, TTL and the original blocker list.

---

## 0. Starting position

### 0.1 The four constraints that decide almost everything below

1. **The card is the contract.** The card renders server-held typed data only. An injected event
   description must not be able to make the card say something the payload does not — not by
   faking a field label, not by faking a second value, not by rendering as markup.
2. **No markdown.** The repo has no markdown renderer and PR A deliberately kept model output as
   plain text. Every string in this design is a React text node.
3. **Confirm sends only the proposal id.** Nothing about the action is client-held, so there is
   nothing on the client to tamper with and nothing to re-send if the page is reloaded.
4. **The card shows the team's wall clock, not the viewer's.** The user said "Thursday at 6pm";
   the tool takes that as a team-local wall clock; the card must therefore say 18:00 to *every*
   viewer, in every timezone. This is new in this revision and it is the reason the proposal
   carries `teamTimezone` — see §1.4, which is the single most consequential correction in this
   document.

### 0.2 What PR A actually shipped (deltas from its own design doc)

Verified by reading the files, not the spec:

| Design doc said | Code does |
|---|---|
| `EntityRef` carries `token` | field is **`ref`** (`AiChatApi.RefToken`, 4 chars) |
| flat per-kind fields | four of five variants **nest** the existing projection: `reference.event`, `.group`, `.roster`, `.trainingType`; only `member` is flat |
| `AssistantResultList` derives its colour map | it takes **`colorMap` as a prop**; `AssistantTurnView` builds it |
| `AssistantResultRow` takes `to`/`params` | it takes a **`renderLink(children, className)` render prop** — per-kind `<Link>`s are built in `AssistantResultCard`, cast-free |
| `AssistantTurnError` props `{reason, retryAfterSeconds, onRetry}` | also has **`disabled`** (another turn in flight) and exports `turnErrorMessages` |
| suggestion copy | the four `assistant_suggestion_*` values shipped with different (simpler) copy than the doc's table |
| `AssistantConversation` renders only below the h1 | it also owns the **New chat** trigger row and the `AlertDialog` |
| — | `AssistantEmptyState` **drops the 4th suggestion on mobile** (`useIsMobile()`), so it shows 3 prompts below 768px and 4 above. §6.4's swap has to respect that; an earlier revision of this doc did not. |

Everything else is as designed: Pattern A (`ApiClient.asEffect()` + `useRun()` inside the
organism), `SilentClientError` for inline-only failure reporting, one `role='log'` live region,
44 `assistant_*` keys, 10 components, no router hooks in organisms.

### 0.3 What this PR adds to the surface

One new element in the transcript — the **proposal card** — plus two new requests it can make
(confirm, reject), a countdown, and one new suggested prompt for users who may create events.

Nothing else about the page changes: same route, same composer, same log, same history budget,
same degraded/turn-error handling.

---

## 1. The wire the UI sits on — the reconciled contract

This is the fixed contract. The UI derives from it; it does not negotiate with it.

```
POST /teams/:teamId/ai/chat
  -> { answer, generated, degradedReason, references,
       proposal: Option<ActionProposal> }                    // NEW

ActionProposal = {
  id:            AiProposalId                 // branded, UUID-pattern-checked; the ONLY thing
                                              // confirm/reject send
  action:        AiActionName                 // closed union; PR B: 'create_event' and nothing else
  fields:        ReadonlyArray<ProposalField> // the typed summary — NOT prose, NOT `summary`
  expiresAt:     DateTime.Utc                 // absolute, server-minted, TTL 15 min
  teamTimezone:  string                       // IANA id from `team_settings.timezone` (§1.4)
}

ProposalField = { key: ProposalFieldKey, value: ProposalValue }

ProposalFieldKey =                            // 8 literals, fixed ORDER emitted server-side
  | 'title' | 'eventType' | 'trainingType' | 'when'
  | 'location' | 'description' | 'ownerGroup' | 'memberGroup'

ProposalValue — discriminated on `kind`, five variants:
  | { kind: 'text';      text: string }
  | { kind: 'dateRange'; startAt, endAt: Option<…>, allDay: boolean,
                         startDate: Option<string>, endDate: Option<string> }
  | { kind: 'eventType'; eventType: Event.EventType }
  | { kind: 'entity';    entity: EntityRef }          // the WHOLE EntityRef, reused verbatim
  | { kind: 'empty' }

POST /teams/:teamId/ai/proposals/:id/confirm      // NO payload
  -> { created: EntityRef }                         // kind 'event' for create_event
  errors: AiProposalNotFound 404 | AiProposalActionForbidden 403
        | AiProposalAlreadyUsed 409 | AiProposalExpired 410
        | AiProposalActionUnavailable                        // NEW — §4.5

POST /teams/:teamId/ai/proposals/:id/reject
  -> 204
  errors: 403 | 404 | 409 only — no 410, no ActionUnavailable   (§3.2)

GET /teams/:teamId/ai/capabilities
  -> { enabled, canCreateEvent }                    // canCreateEvent NEW, see §6.4
```

**`canCreateEvent`, not `canWrite`.** A single-permission boolean must not be named as though it
were a capability class. `canWrite` would be a lie the moment a second action ships behind a
different permission (`event:update` is a different grant from `event:create`, and the first
non-event action will not be an event permission at all), and correcting it then is a breaking
rename of a shipped field. The name states exactly what it is: whether this caller may create an
event. A second action brings a second boolean.

**`kind` discriminates `ProposalValue`, `key` names the field.** `key`/`value` is the pair
vocabulary; `kind` matches `EntityRef.kind`, which is the discriminant the assistant's client code
already switches on in three places (`AssistantEntityLink`, `AssistantResultCard`,
`entityRoutes.ts`). One discriminant name across the whole assistant surface.

### 1.1 `fields` is a typed field list, never prose

`packages/domain` depends only on `effect` and `@sideline/effect-lib` and cannot import the
message catalogue (PR A's P2). So the server emits typed keys and values, and the client owns
every human-readable character.

Why these five value kinds and no more:

- **`dateRange` carries the whole range in one value**, so the card composes one string from one
  value rather than reconciling separate `start`/`end`/`allDay` fields that could contradict each
  other. It also carries the server-derived team-local `startDate`/`endDate`, which is the only
  correct source for an all-day date (§1.4).
- **`eventType` is its own variant** rather than a generic `enum` — it resolves through the
  existing `eventTypeLabels` map with no runtime enum-name dispatch and no computed `tr()` key.
- **`entity` carries a whole `EntityRef`.** Reuse it verbatim (mint a throwaway `ref` token — the
  card never resolves markers, so the token is simply unused) rather than minting a parallel
  slimmer struct that would drift from the five result-card branches. This also keeps §2.5's
  decision reversible at zero contract cost.
- **`empty` is explicit, not an omission.** "The assistant did *not* set a location" is a fact the
  user is verifying. A field list that silently omits unset optional fields cannot express it. The
  server emits every field of the action, always, in a fixed order.
- No `boolean` variant: `allDay` lives inside `dateRange` and renders as the existing
  `event_allDayLabel` chip. No `instant` variant: a bare instant has no correct rendering without
  a zone, and every instant in this payload is part of a range.

**Both unions are closed, and that is the fallback strategy.** A client that meets an unknown
`key` or `value.kind` fails the response decode, which lands in the existing generic turn error
(`assistant_turnFailedGeneric`) with no card and nothing created. A partially-understood contract
is never rendered — omitting one line from a verification card is worse than showing no card. This
only matters during a rolling deploy; in the same deploy `Record<ProposalFieldKey, …>` makes a
missing label a compile error.

### 1.2 Fields deliberately absent from `create_event`

**`locationUrl` and `imageUrl` are not accepted by `propose_create_event` and therefore never
appear in `fields`.** No `locationUrl` field key exists; no branch renders one; nothing in this
document references one.

The argument is not "the guard is missing" — it is that the guard does not address this threat.
`EventApi.EventLocationUrl` blocks SSRF shapes (private hosts, non-http schemes); it does not and
cannot block `https://attacker.example/`. On a write path whose payload originates in untrusted
tool output, the live threat is **exfiltration by click**: the URL lands permanently on the team's
event, renders as a link on the event page, and is pushed to Discord where every member sees it.
A model-chosen URL is the least valuable field in the payload and the only one with a standing
attacker benefit. It is not accepted, so there is nothing to guard.

Recurrence/series is likewise out (different endpoint, different semantics).

**Architect note — cap the strings in the tool's `payloadSchema`:** `title` ≤ 200,
`location` ≤ 200, `description` ≤ 2000 characters. The card renders text values in full, with no
clamp and no "show more" (§2.3); the bound that keeps a card from becoming ten screens tall is a
server-side one, where it is also a bound on what can actually be created.

### 1.3 Invariants the UI relies on

1. **At most one proposal per response** (`Option`, not an array). A second proposal is a second
   turn.
2. **A degraded turn carries no proposal.** `generated === false` means the model did not produce
   the turn; it must not have produced a write either. (If both ever arrive, the client renders
   both — the server is authoritative on the proposal's existence — in the order of §2.4.)
3. **`fields` order is emitted by `renderSummary`, i.e. by code**, not by the model. The model
   cannot reorder, duplicate or inject a field.
4. **The proposal never enters the model history.** `toMessageTurns` already serializes only
   `role` + `content`; it must keep doing so. Neither the proposal nor its outcome is described
   back to the model in prose — the model learns that the event exists the same way it learns
   anything, by calling `list_events`.

### 1.4 Times render in the TEAM's timezone — the correction that `teamTimezone` exists for

**The defect this fixes.** Every date helper the assistant currently uses is browser-local by
construction: `formatEventDateRange` says so in its own doc comment
(`applications/web/src/lib/datetime.ts:62`) and is built from `formatLocalDate`/`formatLocalTime`;
`useFormatDate` sets no `timeZone` at all. A card rendered with either of them would show a
Prague team's 18:00 training as 12:00 to a coach watching from Boston. The card's entire premise
— *this is what will be created; check it* — dies there: the user would verify a clock time the
event will never have, and would "correct" a time that was already right.

**Why this is new.** The rest of the app is self-consistently browser-local: the event form writes
the instant the browser picked and the event list reads it back the same way. The proposal card is
the first surface where a **wall clock travels through the server as a wall clock** —
`propose_create_event` now takes `startDate`/`startTime` as team-local wall-clock strings rather
than an instant, precisely so the wall clock the user asked for is the wall clock that gets
stored. The card must therefore echo that same wall clock, which means projecting into
`proposal.teamTimezone`, not into the browser's zone.

**How it renders.**

| Case | Rule |
|---|---|
| timed (`allDay: false`) | date = `formatDateInZone(startAt, teamTimezone)`, time = `formatTimeInZone(startAt, teamTimezone)` (`datetime.ts:161`); same for `endAt`. `sameDay` is compared on the **team-local** dates, so an event that crosses midnight in the viewer's zone but not the team's is correctly one day. |
| all-day (`allDay: true`) | use `startDate`/`endDate` **verbatim**. Never project the instant. The wire value is noon-UTC anchored, and at UTC+13 (`Pacific/Auckland`) noon UTC is the *next* calendar day — projecting it would put the card a day off for exactly the teams that most need it right. |

Two small additions, no modification of a shipped helper:

- **`lib/datetime.ts` gains `formatDateInZone(dt, tz): string`** — `YYYY-MM-DD` in the given IANA
  zone, via `DateTime.setZoneNamed` → `DateTime.toParts` → `{year, month, day}`, falling back to
  `Europe/Prague` when the zone is unrecognised. It is a four-line sibling of `formatTimeInZone`
  with the same fallback discipline, for the same reason: `team_settings.timezone` has no CHECK
  constraint, and `Intl.DateTimeFormat` *throws* on a bad zone while `setZoneNamed` returns
  `None`. The `{year, month, day}` destructure is the established pattern
  (`applications/server/src/api/event.ts:99`).
- **`formatProposalRange(value, tz)` in `lib/assistant/proposal.ts`** — the pure composer that
  applies the table above and returns `{ start, end: Option<string>, allDay }`. It mirrors
  `formatEventDateRange`'s output shape so the card's composition logic looks like the result
  row's, but it is a separate function, not a new parameter on the shipped one: adding a `tz`
  argument to `formatEventDateRange` would silently change the meaning of every existing call
  site.

**The team-time chip.** When the proposal is timed **and**
`Intl.DateTimeFormat().resolvedOptions().timeZone !== proposal.teamTimezone`, the `when` value is
followed by a `Badge variant='outline'` reading `assistant_proposal_teamTimeZone` — "Team time
(Europe/Prague)". Not shown when the zones match (noise for ~95% of users, and a needless hint
that the time might not mean what it says); not shown for all-day (there is no clock time to
misread, and the date is team-local by construction). If `resolvedOptions()` yields nothing, the
chip shows — more information is the safe default.

**Accepted consequence, named rather than hidden.** After confirmation the card shows the created
event through the shipped `AssistantResultCard`, which renders browser-local like the rest of the
app. For a cross-zone viewer the card says 18:00 and the success row says 12:00 — the same instant
described twice, once as the team's wall clock and once as the viewer's. This is not a bug in
either: the card answers *"what did I ask for?"* and the row answers *"when is it for me?"*, and
the chip has already taught the difference by the time the row appears. Re-rendering the whole
app's event times in team-local is a much larger change with its own migration and is explicitly
out of scope for PR B; this card is the strongest argument for eventually doing it.

---

## 2. The proposal card

### 2.1 Anatomy

```
┌─ Card (border-primary/40, bg-card, gap-3 py-4)  ────────────────────────────────┐
│  CardHeader                                                                      │
│    [CalendarPlus icon]  <h3> Create this event?        [Badge: Expires in 14 min]│
│    <p> Check the details — nothing is created until you confirm.                 │
│                                                                                  │
│  CardContent — <dl> the typed field list (§2.3)                                  │
│    Title          Tuesday Training                                               │
│    Event Type     Training                                                       │
│    Training Type  Strength                                                       │
│    Date           2026-05-12 18:00 – 19:30   [Team time (Europe/Prague)]         │
│    Location       Main Field                                                     │
│    Description    Bring indoor shoes.                                            │
│    Owner Group    Coaches                                                        │
│    Member Group   Not set                                                        │
│                                                                                  │
│  CardFooter (md:flex-row md:justify-end, below md: flex-col-reverse, full width) │
│                                            [ Discard ]  [ Create event ]         │
│                                             ↑ DOM order: Discard, then Confirm   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- Heading is an `<h3>` (`text-base font-semibold`) — the log already contains an `sr-only` `<h2>`
  ("Results") per turn, so `h3` keeps the outline sane.
- Icon `CalendarPlus` (lucide), `aria-hidden`. It is the create-glyph, not `Sparkles` — the card
  is not "the assistant speaking", it is "a thing about to happen to your team's data".
- `border-primary/40` is the only chrome that marks it as needing a decision. No coloured
  background fill: a tinted card in a transcript reads as a status message, and this is a form.
- The expiry badge is `Badge variant='outline'` with a `Clock` icon (§4.4).
- The team-time chip appears only under the conditions in §1.4.
- **The card contains exactly two interactive elements: Discard and Confirm** (§2.5).

### 2.2 What the card must never do

- Never render a value outside its labelled `<dd>`. Labels are client-minted `<dt>`s; no server
  or model string can ever land in label position.
- Never render markdown, HTML, or a link built from a value's text.
- Never re-derive the payload. The card is a *view* of `fields`; Confirm posts the id.
- Never show a field the server did not send, and never hide one it did.
- Never render a time without an explicit `timeZone` (§1.4). `formatEventDateRange`,
  `formatLocalTime`, `formatLocalDate` and `useFormatDate` are **banned inside this card**.

### 2.3 Field rendering, value kind by value kind

The `<dl>` is a grid: `grid gap-x-4 gap-y-2 md:grid-cols-[10rem_minmax(0,1fr)]`. Labels are
`text-xs text-muted-foreground md:text-sm` (`<dt>`), values `text-sm break-words` (`<dd>`).
Below 768px it collapses to one column (§7).

| `ProposalFieldKey` | Label key (all **existing**) | en label |
|---|---|---|
| `title` | `event_title` | Title |
| `eventType` | `event_eventType` | Event Type |
| `trainingType` | `event_trainingType` | Training Type |
| `when` | `event_eventDate` | Date |
| `location` | `event_location` | Location |
| `description` | `event_description` | Description |
| `ownerGroup` | `event_ownerGroup` | Owner Group |
| `memberGroup` | `event_memberGroup` | Member Group |

Resolved through `proposalFieldLabels: Record<ProposalFieldKey, () => string>` in
`lib/assistant/proposal.ts` — the `event-labels.ts:13` idiom, never a computed key (PR A §7).
`when` keeps the existing `event_eventDate` ("Date") label rather than minting a new one: it is
the same field of the same form the user already fills in by hand, and the range itself makes the
time visible.

| `value.kind` | Rendering |
|---|---|
| `text` | `<dd className='whitespace-pre-wrap break-words text-sm'>{text}</dd>` — a React text node, so injection-proof. **No clamp, no "show more".** The user is verifying what will be created; hiding half of a description behind a toggle is the one thing a contract card may not do. The length bound is server-side (§1.2). |
| `dateRange` | `formatProposalRange(value, proposal.teamTimezone)` (§1.4), composed into `start – end` via `Option.match(end, …)`. When `allDay`, an `event_allDayLabel` `Badge variant='outline'` follows the range and no time is ever shown. When timed and the viewer's zone differs, the team-time chip follows. |
| `eventType` | `eventTypeLabels[eventType]()` as plain text. Not a badge — in a field list a badge on one value and not the others reads as a status, which it is not. |
| `entity` | `entityDisplayName(entity)` as plain text, same typography as `text` (§2.5). |
| `empty` | `<span className='text-muted-foreground'>{tr('assistant_proposal_notSet')}</span>`. Not `members_fieldEmpty` ("—"): that key exists to hold table-column alignment, and an em-dash in a verification card is ambiguous between "not set" and "we don't know". |

`Option`-typed values do not exist at this layer — the server has already collapsed "absent" into
`{ kind: 'empty' }`, so the client has one branch per kind and no `Option` handling in the
renderer.

### 2.4 Where the card sits

Inside the assistant turn's `<li>`, **last**, after everything else:

```
<li className='flex flex-col gap-3'>          ← AssistantTurnView, unchanged
  TurnSpeakerRow
  degraded <Alert>          (if any)
  <AssistantAnswer>         (if answer non-empty)
  <AssistantResultList>     (if uncited references)
  <AssistantProposal>       ← NEW, when turn.proposal is Some
</li>
```

Last, for three reasons that agree:

1. **Reading order matches decision order** — the prose explains, the results give context, the
   card asks. A card above the prose asks before it has explained.
2. **Confirm ends up last in the turn's tab order**, which is the same rule as "Confirm is the
   last focusable control in the card" (§5.1) applied one level up.
3. **It is closest to the composer**, which is where the user's hands are.

The card is full-width within the log's `max-w-3xl` column — no bubble, no indent. It is not
speech.

### 2.5 DECISION: entity values render as plain text, not links — the in-card link is cut

An earlier revision made `trainingType`, `ownerGroup` and `memberGroup` render as
`AssistantEntityLink` badges opening in a new tab, which required an `openInNewTab` prop on that
shipped component. **That is cut.** The names render as plain text.

The cut is taken, not conceded:

1. **The card's job is one decision, and its interactive surface should be exactly that
   decision.** With the links, a typical card has two or three tab stops *before* the two buttons,
   all of which lead away from the card. Without them the card has exactly two: Discard and
   Confirm. "Confirm is the last focusable control" (§5.1) stops being a rule that needs enforcing
   and becomes a structural fact. For a confirmation surface whose dominant failure mode is
   habituated clicking, fewer things to click is the design.
2. **The link was mitigating a defect, not adding a capability.** The transcript is client state
   that PR A deliberately does not persist, so in-app navigation from the card would destroy the
   proposal being verified. The fix was `target='_blank'` — which makes a badge that looks
   *identical* to the ones in prose and result rows behave differently, invisibly. Two behaviours
   for one affordance is worse than one behaviour and no link.
3. **The name is already the verification.** These entities are resolved and validated
   server-side at propose time; the card shows the same string the event page would. The link only
   helps when the *name itself* is ambiguous between two similarly-named entities, which is rare
   in a team's small, human-curated set of training types and groups.
4. **What is genuinely lost, stated honestly:** you cannot check *who is in* "Coaches" before
   creating an event that will notify them. That is a real gap. It is small enough to accept
   because the event remains fully editable and deletable afterwards through the UI the user
   already knows, and because the recovery ("ask again with the right group") costs one sentence.
5. **The decision is reversible at zero contract cost.** The wire still carries the whole
   `EntityRef` (§1.1), so restoring links later is a pure client change: add `openInNewTab` to
   `AssistantEntityLink` and swap one branch of §2.3.

What this drops: the `AssistantEntityLink` edit, the `ENTITY_ROUTE`/`entityKindLabels` wiring in
the card, the `common_opensInNewTab` reuse, the tab-order clause in §5.1, and 2–3 tests.

What it adds: `entityDisplayName(ref: EntityRef): string` in `lib/assistant/proposal.ts` — an
exhaustive five-way switch returning `title` / `displayName` / `name`, pure, ~10 lines, unit
tested. That is a smaller and better-tested surface than a behavioural fork on a shipped
component.

**If the architect overrides this** (e.g. because group membership verification is judged
essential): the only change needed is an additive optional `openInNewTab?: boolean` prop on
`applications/web/src/components/atoms/AssistantEntityLink.tsx`, defaulting to `false`, which adds
`target='_blank' rel='noopener noreferrer'` and appends the existing `common_opensInNewTab` as
sr-only text; TanStack's `<Link>` passes both attributes through to the `<a>`. Nothing else in
this spec moves except §5.1's tab order and the key count (+1 reused key, no new keys).

---

## 3. The state machine

### 3.1 Six states

`AssistantProposal` (the organism) holds exactly one of:

| State | Meaning | Card shows |
|---|---|---|
| `pending` | awaiting the user | field list + expiry badge + Discard/Confirm |
| `submitting({ intent })` | confirm or reject in flight | field list, both buttons `aria-disabled`, spinner on the pressed one |
| `confirmed({ created })` | 200 from confirm | success block + the created event's `AssistantResultCard` row |
| `rejected` | 204 from reject (or 404 on the reject path) | one muted line |
| `expired` | countdown reached 0, or 410 from confirm | muted line + **Ask again** |
| `failed({ reason })` | `notFound` / `forbidden` / `alreadyUsed` / `unavailable` / `generic` | destructive alert + copy + at most one recovery control |

`failed` carries a five-way reason rather than five states, matching PR A's shipped
`AssistantTurnError` (one component, `reason` union, conditional recovery button). The five differ
only in copy and in which recovery is honest.

`submitting({ intent })` rather than `confirming` is deliberate: **reject is also a fallible
network call**, and it needs the same in-flight rendering, the same double-submit protection and
the same frozen countdown. One state with an intent covers both without a seventh state.

### 3.2 Transitions

Branches are selected by **error `_tag`**, not by HTTP status; statuses are shown for orientation
only and the architect owns the exact status for `AiProposalActionUnavailable`.

```
  mount ──▶ pending ──Confirm──▶ submitting('confirm') ──200──▶ confirmed  (terminal)
     │         │                        ├──AiProposalExpired            (410)──▶ expired
     │         │                        ├──AiProposalNotFound           (404)──▶ failed(notFound)
     │         │                        ├──AiProposalAlreadyUsed        (409)──▶ failed(alreadyUsed)
     │         │                        ├──AiProposalActionForbidden    (403)──▶ failed(forbidden)
     │         │                        ├──AiProposalActionUnavailable       ──▶ failed(unavailable)
     │         │                        └──other / transport / decode      ──▶ failed(generic)
     │         │                                   └─Retry──▶ submitting('confirm')
     │         │
     │         └─Discard──▶ submitting('reject') ──204──▶ rejected  (terminal)
     │                             ├──AiProposalNotFound  (404)──▶ rejected
     │                             ├──AiProposalAlreadyUsed (409)──▶ failed(alreadyUsed)
     │                             └──other──▶ pending + inline error   (nothing was lost)
     │
     └─ mount with expiresAt already past ──▶ expired   (no request is ever sent)

  pending ── countdown reaches 0 ──▶ expired            (only while pending)
```

**The reject path has three outcomes and no more.** Its declared error set is 403/404/409:

- **No 410 branch.** Reject does not return `AiProposalExpired` — an expired row either still
  exists (and is deleted normally → 204) or is already gone (404 → `rejected`). Either way the
  user's intent, "make this go away", is satisfied. A branch for it would be dead code.
- **No dedicated 403 branch.** Rejecting a proposal requires no action permission, so a 403 here
  can only be the ambient team-access failure the whole page already handles — unreachable for a
  user who is looking at the card. It folds into `other` (→ back to `pending` with an inline
  error), which is the correct treatment anyway: nothing was consumed.
- **No `AiProposalActionUnavailable`.** Reject never executes the action.

Rules that fall out of it:

- **Terminal states stop the timer.** Once the state is not `pending`, `useExpiryCountdown` is
  disabled; an expiry cannot overwrite a `confirmed`.
- **The timer never preempts an in-flight request.** If the countdown reaches 0 while
  `submitting`, the card stays in `submitting` and the server's response decides (§4.4).
- **A failed *reject* returns to `pending`, not to an error state.** Nothing was consumed, the
  proposal is still live, and the recovery is "press Discard again" — which the `pending` footer
  already offers. A terminal error state here would strand a usable proposal.
- **Retry exists on `failed('generic')` only.** Retrying 403/404/409/unavailable cannot succeed;
  a retry button there is a dead click (PR A's rule for `AiChatForbidden`). `unavailable` gets
  **Ask again** instead, which can (§4.5).

### 3.3 Which of §9's eight states were dropped, and why

§9 proposed `pending → confirming → applied / failed / stale / expired / discarded / superseded`
for a surface that included updates and deletes.

| Original | Fate | Why |
|---|---|---|
| `pending` | kept | — |
| `confirming` | **generalized** to `submitting({intent})` | §3.1. |
| `applied` | renamed `confirmed` | matches the endpoint verb the user pressed; "applied" is diff language. |
| `discarded` | renamed `rejected` | same reason — the endpoint is `/reject`. |
| `failed` | kept, + 5-way reason | one per server error tag that is not expiry. |
| `expired` | kept | the only lifecycle end the user does not cause. |
| `stale` | **dropped** | `stale` meant "the entity changed under the proposal, so the before→after diff no longer holds". A create has no prior entity and no diff. The nearest real case — a *referenced* entity disappearing — is now `AiProposalActionUnavailable`, which is a confirm-time server answer, not a client-tracked state. |
| `superseded` | **dropped** | `superseded` meant "a newer proposal targets the same entity". Two `create_event` proposals target no shared entity — they are two different events. The client cannot know that "actually, make it Friday" was a *replacement* rather than a second event, and guessing wrong either creates an unwanted event or silently disables a write the user wanted. Both cards therefore stay independently live; the transcript order makes the sequence obvious, and an unwanted one expires in 15 minutes having created nothing. |

**Also dropped from §9:** the second `AlertDialog` confirmation for destructive actions. With no
deletes and no updates there is nothing destructive; and the card *is* the confirmation step —
a dialog on top of a confirmation card is a double prompt that trains people to click through.

---

## 4. Affordances, outcomes and failures

### 4.1 Confirm and Discard

```tsx
<CardFooter className='flex flex-col-reverse gap-2 md:flex-row md:justify-end' aria-busy={busy}>
  <Button type='button' variant='outline' className='h-10 w-full md:h-9 md:w-auto'
          aria-disabled={busy} onClick={onReject}>
    {busyIntent === 'reject' && <Loader2 className='size-4 animate-spin' aria-hidden='true' />}
    {tr('assistant_proposal_reject')}
  </Button>
  <Button type='button' className='h-10 w-full md:h-9 md:w-auto'
          aria-disabled={busy} aria-describedby={titleId} onClick={onConfirm}>
    {busyIntent === 'confirm' && <Loader2 className='size-4 animate-spin' aria-hidden='true' />}
    {tr('assistant_proposal_confirm')}
  </Button>
</CardFooter>
```

- **DOM order is Discard → Confirm, always.** Confirm is the last focusable control in the card
  (§5.1). Below 768px `flex-col-reverse` puts Confirm visually on top (mobile primary-action
  convention) while leaving it last in the DOM.
- **The primary button names the outcome** — "Create event", not "Confirm". A button that says
  what it does is the cheapest defence against an accidental write.
- **Discard is `variant='outline'`, not `destructive`.** Discarding creates nothing and destroys
  nothing; red here would train people to fear the safe button.
- **Both buttons use `aria-disabled` while `busy`, not `disabled`.** `disabled` on the button that
  currently has focus blurs it to `<body>` — a focus orphan for the 1–3 s of the request, right
  after a deliberate keyboard action. Handlers no-op while `busy`; the footer carries
  `aria-busy='true'`. This is a deliberate, local deviation from `AssistantTurnError`'s `disabled`
  (which is never focused at the moment it flips).
- **No keyboard shortcut reaches Confirm.** The card contains no `<form>` and both buttons are
  `type='button'`, so the composer's Enter-to-send can never submit a write, and a stray Enter in
  the transcript has nothing to activate unless the user tabbed onto the button deliberately.

### 4.2 Confirmed

```
[CheckCircle2, text-success]  Event created            ← event_eventCreated (existing key)
<AssistantResultCard reference={created} teamId colorMap />   ← the created event, as a link
```

- The success state **is** the link to the created event: the same 48px result row the rest of the
  assistant uses, with the same colour bar, composed date range and status badge. It doubles as
  field-level proof of what now exists, and one click opens it. Zero new rendering, zero new keys.
  (Its times are browser-local — see the accepted consequence in §1.4.)
- `colorMap` comes from `buildTrainingTypeColorMap` over the created event's `trainingTypeName`,
  exactly as `AssistantTurnView` does per turn — so the row's colour matches the events page.
- `onRefresh()` fires **once**, on the 200 (§6.4 — the router call lives in the route, not here).
  The page's own loader (`{ enabled, canCreateEvent }`) does not change, but every other route's
  loader (events list, dashboard, calendar) is now stale, and the user's next move is usually to
  go look at the thing they just made.
- The field list is replaced, not kept above the success block: the proposal has become an event,
  and the event row is the better rendering of the same facts.
- **No toast.** PR A's rule: the transcript is the single place a turn's outcome is reported, and
  the card is on screen.

### 4.3 Rejected

One muted line in place of the card body: `tr('assistant_proposal_rejected')` — "Discarded.
Nothing was created." No undo. (Undo would need the server to keep the row, which contradicts
`reject → row deleted`; and re-asking is one keystroke.)

### 4.4 Expiry — the server is authoritative, and clock skew must never fake a failure

Four mechanisms, each doing one job:

1. **The countdown is a duration, not a clock comparison.** `useExpiryCountdown` captures
   `remainingMs = Date.parse(expiresAt) − Date.now()` **once**, at the moment the response is
   committed to a turn, and from then on counts that duration down with local ticks. A constant
   offset between the browser clock and the server clock cancels out of the subtraction, because
   the response arrived at "now" on both clocks. Only clock *drift* (rate error) survives, which
   is immaterial over 15 minutes. A client whose clock is an hour off shows a correct countdown.
2. **Expiry never says "it failed".** The `expired` copy is
   "This suggestion expired after 15 minutes. Nothing was created." — which is true whether or not
   the server would still have accepted it, because a client-side expiry never sends a request.
   `expired` is styled as a muted lifecycle end (not `Alert variant='destructive'`), with an
   **Ask again** button.
3. **The server always wins on the paths that matter.** A 200 from confirm renders `confirmed`
   even if the local countdown hit 0 mid-flight (the timer is frozen during `submitting`). A 410
   renders `expired` even if the local countdown says 4 minutes remain. The client's belief is
   never allowed to turn a server success into a failure, nor a server 410 into a success.
4. **Expiry never steals focus and never announces** (§5.2). It happens to the user, not because
   of them.

**One tick, once a second.** `useExpiryCountdown` runs a single `setInterval(…, 1000)` while
enabled. An earlier revision switched cadence (30 s above the minute mark, 1 s below); that is
cut. The saving was ~870 re-renders of one `<span>` over 15 minutes — beneath measurement in
React — and the cost was a second interval plus a cadence-switch boundary that has to be proven
not to skip the 60 s tick. One interval, one state value (whole seconds remaining), one test.

**Badge display.** `Badge variant='outline'` with a `Clock` icon:
`assistant_proposal_expiresInMinutes` ("Expires in {count} min") above 60 s, rounded **down** so
it never over-promises; `assistant_proposal_expiresInSeconds` ("Expires in {count} s") below.
Two keys instead of one interpolated duration string, because abbreviated units sidestep Czech
plural forms entirely (this catalogue has no plural machinery — `group_memberCount` is a bare
`{count} members`). Under the last 60 s the badge also gets `text-destructive` — paired with the
changing number and the changing unit, never colour alone.

**Ask again** re-prefills the composer with the *user message that produced this proposal* and
focuses it — reusing PR A's existing `presetValue` mechanism (`AssistantConversation` already
holds it, and `handleRetry` already knows how to find a turn's preceding user turn). It does not
auto-send: the user usually wants to adjust the day or the time that made the first attempt
stale.

### 4.5 Failure states, one per server tag

| Tag | HTTP | State | Copy key | Recovery |
|---|---|---|---|---|
| `AiProposalNotFound` | 404 | `failed('notFound')` (confirm) / `rejected` (reject) | `assistant_proposal_failedNotFound` | none |
| `AiProposalActionForbidden` | 403 | `failed('forbidden')` | `assistant_proposal_failedForbidden` | none |
| `AiProposalAlreadyUsed` | 409 | `failed('alreadyUsed')` | `assistant_proposal_failedAlreadyUsed` | link to Events (`event_events`) |
| `AiProposalActionUnavailable` | 4xx (architect's call; 422 suggested) | `failed('unavailable')` | `assistant_proposal_failedUnavailable` | **Ask again** |
| `AiProposalExpired` | 410 | `expired` | `assistant_proposal_expired` | Ask again |
| transport / 5xx / decode | — | `failed('generic')` | `assistant_proposal_failedGeneric` | Retry (`common_retry`) |

`classifyProposalFailure` sniffs `_tag`, so the client is correct whatever status the architect
assigns to `AiProposalActionUnavailable`; an unrecognised tag falls to `generic`.

All non-expired failures render as `Alert variant='destructive'` with `OctagonX`, titled
`assistant_proposal_failedTitle` — the same shape as PR A's `AssistantTurnError`, so a failure in
this card looks like every other failure on the page.

Copy honesty, field by field:

- **404 on confirm means the proposal never executed.** A successful confirm marks `consumed_at`
  and keeps the row (→ 409); only a *reject* deletes it. So "Nothing was created." is literally
  true here.
- **404 on the reject path is success, not failure.** The user asked for the row to be gone; it is
  gone. Reporting an error would be a false alarm.
- **409 is the only "maybe it happened" case, and the copy says so**: "This suggestion was already
  used, so the event most likely already exists." plus a `Button variant='link'` `<Link>` to
  `/teams/$teamId/events` labelled with the existing `event_events` key. Never "nothing was
  created".
- **`unavailable` is the new tag, and it exists because `generic` was lying.** When a training
  type or a group referenced by the proposal is deleted between propose and confirm, the create
  cannot succeed — not now, not on retry. Folding it into `generic` produced copy that says "Try
  again — it can't be created twice" above a Retry button that **can never succeed**, which is the
  worst kind of recovery affordance: it invites the user to hammer a dead path and then blames
  itself for an unknown outcome that is in fact perfectly known. Its copy names the cause and the
  only real recovery: "Something this suggestion refers to no longer exists — a training type or
  group may have been deleted. Nothing was created." with **Ask again**, which re-prefills the
  original request so the model re-resolves against the current set of entities. No Retry.
- **`generic` covers the genuinely unknown case** — a connection dropped after the server may have
  committed. Its copy refuses to guess and names the guarantee that makes retrying safe:
  "Something went wrong, so we can't tell whether the event was created. Try again — it can't be
  created twice." That guarantee is real: the single-statement claim means a retry after an unseen
  success returns 409, whose copy then points at Events. There is no path to a duplicate event.

### 4.6 Interaction with the rest of the page

- **New chat** clears `turns`, which unmounts pending cards. It sends **no** reject calls: firing
  requests from a "clear my screen" gesture is surprising, and an abandoned proposal creates
  nothing and evaporates in 15 minutes. The shipped `assistant_newChatConfirmDescription` ("This
  clears the conversation on this page… it can't be brought back") already covers it.
- **Turn retry** (PR A's `handleRetry`) replaces a failed turn in place; a proposal belonging to a
  replaced turn disappears with it. Unchanged, and safe — nothing was confirmed.
- **History budgeting** is untouched: `toMessageTurns` still serializes only `role`/`content`.
- A pending card in an **older** turn stays live and confirmable while the conversation continues.
  That is intentional: the proposal's lifetime is the server's TTL, not the scroll position.

---

## 5. Accessibility

### 5.1 Focus

- **Nothing is focused when a proposal arrives.** The card appears while the user is very likely
  still in the composer. Moving focus to a card — and especially to a Confirm button — is the
  accidental-write hazard this design exists to prevent: an auto-focused Confirm turns the next
  stray `Enter` into a created event. PR A's rule ("focus is never moved when an answer arrives")
  holds unchanged, and the proposal is part of an answer.
- **Confirm is the last focusable control in the card.** With §2.5's cut this is structural, not
  merely arranged: the card's only focusable elements are Discard then Confirm.
- **Focus IS moved on an outcome, because the user caused it.** When `submitting` resolves, the
  Confirm/Discard buttons unmount and their focus would be orphaned to `<body>`. The outcome
  container therefore carries `tabIndex={-1}` and is focused in the same effect that commits the
  outcome. This is user-initiated focus movement (the correct kind), it prevents focus loss, and
  it makes the screen reader read the outcome without any live region.
- **Expiry moves nothing.** It is not user-initiated. If the user happens to be focused on Confirm
  when the countdown fires, the buttons unmount and focus falls back — accepted, because the
  alternative (yanking focus to a card the user did not touch) is worse and the countdown is
  visible for 15 minutes beforehand.
- Tab order within the card: Discard → Confirm. In terminal states: the created-event row / Events
  link / Retry / Ask again — one control at most.

### 5.2 Announcements — no nested live region

The card renders inside the log, which is already
`role='log' aria-live='polite' aria-relevant='additions text'`. PR A had to fix a nested live
region once; it must not come back.

- **The card carries no `aria-live`, no `role='status'`, no `role='alert'` — at any depth.**
- Arrival is announced by the log's `additions`.
- Outcomes are announced twice over, redundantly and correctly: the log's `aria-relevant` includes
  `text`, and focus moves into the outcome container (§5.1), which reads it on every AT/browser
  pair regardless of `aria-relevant` support.
- **Expiry is deliberately not announced.** It is a silent visual change; announcing it would
  interrupt whatever the user is reading or typing to tell them nothing happened. This is the same
  call PR A made for the history-trimmed divider (`role='note'`).
- The spinner during `submitting` is not a live region either; `aria-busy` on the footer is the
  signal.

### 5.3 Naming and semantics

- `<dl>`/`<dt>`/`<dd>` is the correct structure for a field list and gives screen readers the
  label→value pairing for free. Grid layout on the `<dl>` with `<dt>`/`<dd>` as direct children
  keeps the semantics intact (no wrapper `<div>` per row, which would break the list in some AT).
- Confirm is `aria-describedby={titleId}` so its accessible description is "Create this event?" —
  a bare "Create event" in a button list is ambiguous once there are several turns.
- Every icon `aria-hidden='true'`; the expiry badge's text is the label, the `Clock` is decoration.
  The team-time chip's text is the label likewise.
- No state is carried by colour alone: expiry has a number, the last minute adds `text-destructive`
  *and* switches to seconds; failures carry an icon, a title and body copy; success carries
  "Event created" text next to the green check.
- Contrast: theme tokens only (`text-muted-foreground`, `border-primary/40`, `text-success`,
  `Alert variant='destructive'`, `Badge variant='outline'`). The single non-token colour is the
  event colour bar inside the reused result row, which PR A already sanctions.

---

## 6. Component inventory

**3 new components** (page total 10 → **13**), 1 new hook, 1 new pure lib module, **5 edited
files** + i18n.

PR A ended at 10 components because four candidates were inlined. The same discipline applies
here, and four more are inlined rather than created.

### 6.1 New

| Layer | Component | Props | Owns | Reuses |
|---|---|---|---|---|
| `organisms/assistant/` | **`AssistantProposal.tsx`** | `{ teamId, proposal, onRefresh, onAskAgain }` | the six-state machine (§3), both API calls via `ApiClient.asEffect()` + `useRun()` + `SilentClientError`, the expiry timer's enable/disable, the outcome focus move, the `colorMap` for the created row | `useRun`, `useExpiryCountdown`, `AssistantProposalCard`, `AssistantResultCard`, `buildTrainingTypeColorMap`, `lib/assistant/proposal` |
| `molecules/assistant/` | **`AssistantProposalCard.tsx`** | `{ state, proposal, teamId, titleId, onConfirm, onReject, onRetry, onAskAgain, createdSlot }` | **all** rendering for all six states: header + expiry badge, field list, footer, and the five terminal bodies | `Card*`, `Button`, `Badge`, `Alert*`, `Link`, `AssistantProposalFields`, `tr` |
| `molecules/assistant/` | **`AssistantProposalFields.tsx`** | `{ fields, teamTimezone }` | the `<dl>` and the five-way `value.kind` dispatch, the team-time chip | `proposalFieldLabels`, `eventTypeLabels`, `formatProposalRange`, `entityDisplayName`, `Badge`, `tr` |

The organism/molecule split is the PR A split: **behaviour in the organism, rendering in the
molecule.** `AssistantProposalCard` fetches nothing and holds no state, so it is testable by
rendering each of the six states directly. `AssistantProposalFields` takes `teamTimezone` rather
than the whole proposal so its zone behaviour is testable with a one-line prop change and no
`teamId` (it renders no links — §2.5).

### 6.2 Inlined, not created (matching PR A's four cuts)

| Candidate | Why not |
|---|---|
| `ExpiryCountdownBadge` | a `Badge` + one formatted string over one prop; the min/sec branch lives in `formatRemaining` (pure, tested). ~8 lines inside the card header. |
| `AssistantProposalOutcome` | each terminal body is 4–8 lines of static JSX; five of them in one `switch` inside `AssistantProposalCard` is shorter and easier to read than a component with a six-way discriminated prop. |
| `AssistantProposalActions` (footer) | 12 lines of JSX over three handlers, one call site. |
| `AssistantProposalSuccess` | it is a heading line plus the *existing* `AssistantResultCard`; extracting it would create a file whose entire body is another component. |

### 6.3 New non-component modules

| Module | Export |
|---|---|
| `hooks/useExpiryCountdown.ts` (+ `.test.ts`) | `(expiresAt: DateTime.Utc \| string, enabled: boolean) => { remainingMs: number; expired: boolean }` — captures the duration once at mount (§4.4.1), **one 1 s interval**, clears on unmount, freezes when `enabled` is false. Sibling of the shipped `useRetryCooldown`. |
| `lib/assistant/proposal.ts` (+ `.test.ts`) | `proposalFieldLabels: Record<ProposalFieldKey, () => string>`; `proposalActionTitles: Record<AiActionName, () => string>` (one entry today — a new action literal becomes a compile error); `proposalFailureMessages: Record<ProposalFailureReason, () => string>`; `classifyProposalFailure(squashed: unknown): ProposalFailureReason` (tag-sniffing, same shape as the shipped `classifyTurnFailure`); `formatProposalRange(value, tz)` (§1.4); `entityDisplayName(ref)` (§2.5); `formatRemaining(ms): { unit: 'min' \| 's'; count: number }`. No React, no `ApiClient`, `tr()` called lazily inside thunks. |

### 6.4 Edited

| File | Change |
|---|---|
| `components/organisms/assistant/AssistantConversation.tsx` | `AssistantTurnData` gains `proposal: Option<ActionProposal>`; `AssistantTurnView` renders `<AssistantProposal>` last and passes `onAskAgain` (prefill via the existing `setPresetValue`, resolved from the turn's preceding user turn exactly as `handleRetry` does); component gains an `onRefresh: () => void` **prop**. |
| `components/pages/AssistantPage.tsx` | threads `onRefresh` and `canCreateEvent` through; stays props-only. |
| `routes/(authenticated)/teams/$teamId/assistant.tsx` | loader returns `{ enabled, canCreateEvent }` (and the `Effect.catch` fallback becomes `{ enabled: false, canCreateEvent: false }`); **the route component owns the router call**: `const router = useRouter()` and `onRefresh={() => { router.invalidate(); }}`. |
| `components/molecules/assistant/AssistantEmptyState.tsx` | permission-aware suggestion set (below). |
| `lib/datetime.ts` | add `formatDateInZone(dt, tz)` (§1.4) + tests. Additive; no existing export changes. |
| `packages/i18n/messages/{en,cs}.json` | §8. |

**`AssistantEntityLink.tsx` is NOT edited** — §2.5. If that decision is overridden, it gains one
additive optional `openInNewTab?: boolean` prop and nothing else.

**`onRefresh` routing is a hard rule, not a preference.** `AssistantConversation` must not call
`router.invalidate()` itself: its own file header states that it "takes no router hooks"
(`applications/web/src/components/organisms/assistant/AssistantConversation.tsx:5`), which is the
shipped expression of the AGENTS.md rule that routing lives in routes. The invalidation therefore
travels down as a plain callback prop from the route component, through `AssistantPage`, through
`AssistantConversation`, to `AssistantProposal`, which calls it once on a 200 (§4.2). PR A's "no
`onRefresh` yet" note said explicitly that it returns with the write path — this is that return,
in the place PR A reserved for it.

**The suggestion swap, respecting the shipped mobile cut.** `AssistantEmptyState` already shows 4
prompts above 768px and 3 below (it drops `assistant_suggestion_aggregate` on mobile so the empty
state plus composer fit a phone viewport). A swap written as "replace `aggregate` when
`canCreateEvent`" would therefore be a no-op on mobile and writers on phones would never see the
gesture. The rule is instead **"the create prompt displaces the last read example at whichever
breakpoint we are at"**:

```ts
const readSuggestions = isMobile
  ? [rsvp, filter, attendance]
  : [rsvp, filter, attendance, aggregate];
const suggestions = canCreateEvent
  ? [...readSuggestions.slice(0, -1), tr('assistant_suggestion_createEvent')]
  : readSuggestions;
```

Count is preserved at both breakpoints, every `tr()` call stays a literal, and the create prompt
is always last — closest to the composer. Non-writers are never taught a gesture they cannot use;
writers are always shown it.

**§9's read-only `Alert` is cut.** With the suggestion set already permission-aware, a banner
telling members what they cannot do is chrome nobody asked for, on a page whose empty state is
already three paragraphs of chrome. (The implementation plan's `AssistantEmptyState` row still
mentions adding it; this spec supersedes that.) If the architect declines `canCreateEvent`
entirely, drop the swap and `assistant_suggestion_createEvent` with it (17 keys instead of 18);
nothing else in this spec depends on it.

### 6.5 Reused unchanged

`ui/`: `card`, `button`, `badge`, `alert`, `separator`.
`molecules/`: `AssistantResultCard` (the created-event row), `AssistantResultList` (untouched).
`atoms/`: `AssistantEntityLink` — **untouched** (§2.5).
`lib/`: `datetime` (`formatTimeInZone`; `formatEventDateRange` is used only by the reused result
row, never by the card), `event-labels` (`eventTypeLabels`), `event-colors`
(`buildTrainingTypeColorMap`), `runtime` (`ApiClient`, `useRun`, `SilentClientError`),
`translations`.
`hooks/`: `use-mobile`.

**Not used, deliberately:** `AlertDialog` (no destructive action — §3.3); `sonner` (the
transcript reports outcomes — §4.2); `useFormatDate` and every browser-local date helper inside
the card (§1.4/§2.2); any markdown renderer (none exists, none is added).

---

## 7. Mobile — the 768px breakpoint

768px is `useIsMobile()`'s boundary **and** Tailwind's default `md` (this repo adds no custom
breakpoints), so the card's layout switch coincides exactly with the sidebar's. The card uses
`md:` utilities throughout — deliberately not `sm:` (640px), which is what PR A's result rows use,
because those were tuned to a different thing (badge-vs-title width competition) and this card's
switch should land on the nav boundary.

| Below 768px | At/above 768px |
|---|---|
| `<dl>` is one column: `<dt>` (`text-xs text-muted-foreground`) above `<dd>` (`text-sm`), `gap-y-2` between pairs | two columns, `md:grid-cols-[10rem_minmax(0,1fr)]`, labels aligned to the value gutter |
| header stacks: title on one line, expiry badge on the next (`flex-col items-start`) — "Create this event?" + "Expires in 14 min" side by side at 360px squeezes both | `md:flex-row md:items-center md:justify-between`; the badge sits at the header's right edge |
| the team-time chip wraps onto its own line under the range (`flex flex-wrap items-center gap-2` on the `<dd>`) | sits inline after the range |
| footer `flex-col-reverse gap-2`, both buttons `w-full h-10` — Confirm visually on top, still last in the DOM | `md:flex-row md:justify-end`, `md:w-auto md:h-9`, Discard left of Confirm |
| `Card` padding tightened to `px-4` (`CardHeader`/`CardContent`/`CardFooter` default to `px-6`) | default `px-6` |
| long `text` values wrap with `break-words whitespace-pre-wrap` | same |
| the created-event row is the shipped `AssistantResultCard`, which already has its own <768px rules (status badge moves onto the secondary line) — inherited, not re-specified | — |
| Retry / Ask again / Events buttons `w-full`, matching `AssistantTurnError`'s shipped `w-full sm:w-auto` | auto width |

The card sits in the log's `overflow-y-auto` column, so a long description scrolls the log, never
the page, and the composer stays pinned (PR A §8). Nothing here introduces a horizontal scrollbar:
the field grid's value column is `minmax(0,1fr)`, which is what lets `break-words` actually break.

---

## 8. Translation keys

**18 new keys**, counted key by key below: **8** card chrome + **9** outcome/failure + **1**
suggestion. (Two earlier revisions miscounted; this count is enumerated, not asserted. The
differences from the last revision are `assistant_proposal_teamTimeZone` (§1.4) and
`assistant_proposal_failedUnavailable` (§4.5); no key was dropped by §2.5's cut, which only
removed a *reused* key.)

Every one is a literal `tr('key')` call; the two runtime unions (field key, failure reason)
resolve through explicit `Record` lookups in `lib/assistant/proposal.ts`, never a template literal
— PR A's `assistant_degraded_*` near-miss is the standing precedent.

### 8.1 Card chrome (8)

| # | Key | en | cs |
|---|---|---|---|
| 1 | `assistant_proposal_createEventTitle` | Create this event? | Vytvořit tuto událost? |
| 2 | `assistant_proposal_intro` | Check the details — nothing is created until you confirm. | Zkontrolujte údaje — dokud nepotvrdíte, nic se nevytvoří. |
| 3 | `assistant_proposal_confirm` | Create event | Vytvořit událost |
| 4 | `assistant_proposal_reject` | Discard | Zahodit |
| 5 | `assistant_proposal_notSet` | Not set | Nenastaveno |
| 6 | `assistant_proposal_expiresInMinutes` | Expires in {count} min | Vyprší za {count} min |
| 7 | `assistant_proposal_expiresInSeconds` | Expires in {count} s | Vyprší za {count} s |
| 8 | `assistant_proposal_teamTimeZone` | Team time ({zone}) | Týmový čas ({zone}) |

### 8.2 Outcomes and failures (9)

| # | Key | en | cs |
|---|---|---|---|
| 9 | `assistant_proposal_rejected` | Discarded. Nothing was created. | Zahozeno. Nic se nevytvořilo. |
| 10 | `assistant_proposal_expired` | This suggestion expired after 15 minutes. Nothing was created. | Tento návrh po 15 minutách vypršel. Nic se nevytvořilo. |
| 11 | `assistant_proposal_askAgain` | Ask again | Zeptat se znovu |
| 12 | `assistant_proposal_failedTitle` | That didn't go through | Nepodařilo se to dokončit |
| 13 | `assistant_proposal_failedNotFound` | This suggestion is no longer available. Nothing was created. | Tento návrh už není k dispozici. Nic se nevytvořilo. |
| 14 | `assistant_proposal_failedAlreadyUsed` | This suggestion was already used, so the event most likely already exists. | Tento návrh už byl použit, událost tedy nejspíš už existuje. |
| 15 | `assistant_proposal_failedForbidden` | You don't have permission to create events for this team. Nothing was created. | Nemáte oprávnění vytvářet události v tomto týmu. Nic se nevytvořilo. |
| 16 | `assistant_proposal_failedUnavailable` | Something this suggestion refers to no longer exists — a training type or group may have been deleted. Nothing was created. | Něco, na co tento návrh odkazuje, už neexistuje — typ tréninku nebo skupina mohly být smazány. Nic se nevytvořilo. |
| 17 | `assistant_proposal_failedGeneric` | Something went wrong, so we can't tell whether the event was created. Try again — it can't be created twice. | Něco se pokazilo, takže nevíme, jestli se událost vytvořila. Zkuste to znovu — podruhé se vytvořit nemůže. |

### 8.3 Suggested prompt (1)

| # | Key | en | cs |
|---|---|---|---|
| 18 | `assistant_suggestion_createEvent` | Create a training this Thursday at 6pm | Vytvoř trénink ve čtvrtek v 18:00 |

Shown only when `canCreateEvent` (§6.4), displacing the last read example. Informal imperative,
matching PR A's rule that suggestions are the user addressing the assistant while everything else
addresses the user with *vykání*.

### 8.4 Existing keys reused — 13, no duplicates minted

Verified present in both `en.json` and `cs.json`.

| Key | en / cs | Used for |
|---|---|---|
| `event_title` | Title / Název | `<dt>` for `title` |
| `event_eventType` | Event Type / Typ události | `<dt>` for `eventType` |
| `event_trainingType` | Training Type / Typ tréninku | `<dt>` for `trainingType` |
| `event_eventDate` | Date / Datum | `<dt>` for `when` |
| `event_location` | Location / Místo | `<dt>` for `location` |
| `event_description` | Description / Popis | `<dt>` for `description` |
| `event_ownerGroup` | Owner Group / Skupina vlastníků | `<dt>` for `ownerGroup` |
| `event_memberGroup` | Member Group / Skupina členů | `<dt>` for `memberGroup` |
| `event_allDayLabel` | All day / Celý den | all-day chip on the `dateRange` value |
| `event_type_*` | — | the `eventType` value, via `eventTypeLabels` |
| `event_eventCreated` | Event created / Událost vytvořena | success heading |
| `event_events` | Events / Události | link label on the 409 state |
| `common_retry` | Retry / Zkusit znovu | `failed('generic')` |

(`common_opensInNewTab` was in this list in the previous revision; §2.5's cut removes its only
use here.)

Eight of the thirteen are the field labels, which is the strongest argument for this field set:
the proposal card is labelled with the *same words as the event form the user already knows*. Of
PR A's 44 `assistant_*` keys, none is reusable here (they cover chrome, degraded reasons, turn
errors and result-kind labels — no confirmation vocabulary), which is why all 18 are new.

After merging: `assistant_*` goes from 44 to **62 keys**. Run `pnpm codegen && pnpm build` so
`messagesByKey` picks them up; `lib/staticTrKeys.test.ts` covers the literal-key rule.

---

## 9. Explicit non-goals for PR B

- **Updates and deletes**, and with them before→after diffs, `stale`, `superseded`, the
  `AlertDialog` second confirmation, and the `assistant_*_update` / `_delete` / `destructive*` key
  families sketched in §9 of the PR A design.
- **`locationUrl` and `imageUrl` on the write path** — §1.2, permanently for this action.
- **Team-local rendering of event times outside this card.** The card is team-local because the
  wall clock is the thing being verified (§1.4); the events list, dashboard and calendar stay
  browser-local, and changing that is its own PR.
- **In-card navigation to the referenced training type / groups** — §2.5. The wire keeps the full
  `EntityRef`, so this is a pure client change whenever it is wanted.
- **Conversation persistence.** Still client state. A pending proposal survives navigation only in
  the sense that the server still holds it for 15 minutes — the *card* does not come back.
- **A proposal inbox** ("you have 2 pending suggestions") anywhere outside the transcript.
- **Editing a proposal before confirming.** The user changes it by asking again; letting the
  client mutate the payload would break "confirm sends only the id", which is the property the
  whole design rests on.
- **Undo after confirm.** The created event is deleted through the normal event UI, which already
  exists and is the surface the user knows.
- **Streaming, optimistic rendering, or any client-held copy of the payload.**
