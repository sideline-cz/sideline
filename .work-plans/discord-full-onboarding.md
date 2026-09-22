# Full onboarding using Discord

Notion `3ba93506-0818-80d2-8181-e80e210c56da`. Branch `feat/full-onboarding-using-discord`.
Companion UX spec: `.work-plans/discord-full-onboarding-design.md` (copy, choreography, failure
states — that doc owns the i18n wording; this one owns the data and code).

> /invite/ alternativa web appky. uzivatel dostane discord link. na discordu dokonci overeni
> sveho uctu pomoci /complete. nez ma uzivatel dokonceny profil tak nemůže vyplnovat docházku
> a jinak interagovat.
> idealne mit readonly channel s infem ktery vidi jenom neovereny clovek. je tam tlacitko na
> overeni ktere projde s uzivatelem flow.

## What already works (confirmed, not re-planned)

| Fact | Evidence |
|---|---|
| Joining the guild through **any** plain Discord invite already creates the `users` row + `team_members` row, roles, group binding and welcome message. No OAuth token needed. | `rpc/guild/index.ts:500-580` → `UsersRepository.upsertFromDiscord` (`:54-71`), tokens live in `oauth_connections` since migration `1742200000`. |
| `/complete` (cs `/dokoncit`) collects gender → modal `profile-complete:{gender}` → `Guild/CompleteMemberProfile` → `users.completeProfile` (`is_profile_complete = true`) + jersey, one transaction. | `commands/complete/{index,handler}.ts`, `interactions/profile-complete.ts`, `rpc/guild/index.ts:1238-1330`. |
| `is_profile_complete` is enforced **nowhere** server-side — only three web `beforeLoad` redirects. | `web/src/routes/(authenticated)/teams/$teamId/index.tsx:16`, `(no-team)/create-team.tsx:13`, `(no-team)/profile/index.tsx:11`. |
| RSVP has exactly two server writers. | `api/event-rsvp.ts:223` `submitRsvp`; `rpc/event/index.ts:494` `Event/SubmitRsvp`. Both call `EventRsvpsRepository.upsertRsvp`. |
| `users.completeProfile` has exactly **two** writers, not one. | `api/auth.ts:463` (web `completeProfile` handler) and `rpc/guild/index.ts:1301` (bot modal). Any side effect hung off "profile became complete" must account for both — see Deliverable D. |
| `teams.onboarding_locale` is already an `'en'`/`'cs'` literal on every team. | `packages/domain/src/models/Onboarding.ts:3`, `repositories/TeamsRepository.ts:18`. |

So this story is **one guard, one modal change, one button, and one channel**. Nothing about
"create a user from Discord" needs building.

### One finding that shapes the join-time surface

`buildWelcomeMeta` (`rpc/guild/index.ts:330-392`) returns `welcome: Option.none()` whenever
`inviteContext` is `None`, and `resolveInviteContext` only resolves from a **Sideline-minted
per-acceptance Discord code** or an `invite_acceptances` row inside a 15-minute window. A member
joining through a plain, captain-made Discord invite — i.e. exactly the cohort this story is
about — has neither, so **no welcome message is sent to them at all today**.

Hanging the Verify button *only* off the welcome embed therefore reaches the wrong cohort. Two
consequences, both planned below:

1. `RegisterMember`'s response gains **top-level** verification fields (outside the nested
   `welcome`), so the bot can act on a join with no welcome embed.
2. Deliverable D (the unverified role + read-only channel) is the catch-all for that cohort, which
   is why it is **in scope**, not deferred.

---

## Deliverable A — the server-side gate

### Scope of the gate: three write paths, four handlers

The story says "nemůže vyplnovat účast a jinak interagovat". "Jinak interagovat" is open-ended;
the gate covers the actions with a **roster-integrity consequence** — an action whose record other
people read and plan around:

| Surface | Handler | Error |
|---|---|---|
| Discord button / slash | `Event/SubmitRsvp` (`rpc/event/index.ts:397`) | `EventRpcModels.RsvpProfileIncomplete` |
| Web HTTP | `submitRsvp` (`api/event-rsvp.ts:163`) | `EventRsvpApi.RsvpProfileIncomplete` |
| Discord button | `Event/ClaimTraining` (`rpc/event/index.ts:1175`) | `EventRpcModels.ClaimProfileIncomplete` |
| Discord button | `Carpool/ReserveSeat` + `Carpool/AddCar` (`rpc/carpool/index.ts:163`, `:127`) | `CarpoolRpcModels.CarpoolProfileIncomplete` |

`Carpool/AddCar` is gated because adding a car *is* taking a seat — capacity is
"včetně řidiče" (`bot_carpool_capacity_label`) and `CarpoolOwnerCannotReserve` exists precisely
because the owner already occupies one.

### Where the guard lives: a shared helper, parameterised by the transport's error

Three candidates were considered.

**Rejected — inside `EventRsvpsRepository.upsertRsvp`.** This is the only *structurally*
unskippable spot (a new error in the repository's `E` channel forces every caller to map it or
fail `pnpm check`), and repo-level business errors do have precedent
(`WeeklyChallengeAlreadyExistsForWeek`, root AGENTS.md rule 2). It still loses, on cost:
the repository would need the env kill switch, which means either importing `~/env.js` into a
repository (a layering smell — no repository does) or adding a service to
`EventRsvpsRepository.Default`'s `RIn`, which breaks the layer construction in **60 test files**
that reference that repository. It also only covers RSVP — the claim and carpool paths write
through three other repositories. Not worth it.

**Rejected — duplicated inline at every call site with its own predicate.** This is the thing
`applications/server/AGENTS.md` → "RSVP Has Two Write Surfaces" already exists to warn about, and
the gate now has four surfaces, not two.

**Chosen — a shared helper in `applications/server/src/utils/requireCompleteProfile.ts`,**
following the exact shape of `requireMembership(members, teamId, userId, forbidden)`
(`api/permissions.ts:8-26`): the caller passes its own error value, so one predicate serves four
wire contracts.

```ts
// applications/server/src/utils/requireCompleteProfile.ts
import { Effect } from 'effect';
import { profileGateEnabled } from '~/env.js';

// The profile gate for actions with a roster-integrity consequence (RSVP, training claim,
// carpool seat). `requiredByTeam` is the per-team opt-in (`team_settings.require_complete_profile`,
// DEFAULT false); `PROFILE_GATE_ENABLED` is the global incident lever and short-circuits it.
// Every call site already holds both booleans off a SELECT it was doing anyway, so this helper
// does no I/O and is a pure predicate over three booleans.
export const requireCompleteProfile = <E>(input: {
  readonly requiredByTeam: boolean;
  readonly isProfileComplete: boolean;
  readonly incomplete: E;
}): Effect.Effect<void, E> =>
  !profileGateEnabled || !input.requiredByTeam || input.isProfileComplete
    ? Effect.void
    : Effect.fail(input.incomplete).pipe(
        Effect.tapError(() => Effect.logInfo('Action blocked: profile incomplete')),
      );
```

### Feeding the helper: fold the flag into the lookup, do not add a query

**The "zero extra queries" claim in the previous revision of this plan was false**, and the cost it
hid is the exact cost used to reject the repository-level guard. `submitRsvp` binds no
`teamSettings`, and `svc.teamSettings.findByTeamId` is a real SELECT — as originally written the
gate added a query to the hottest write path in the product. Fixed by folding both booleans into
the member/membership SELECT each handler already runs:

| Handler | Lookup it already does | Change |
|---|---|---|
| `Event/SubmitRsvp`, `Event/ClaimTraining` | `TeamMemberLookup` (`rpc/event/index.ts:55`) | add `u.is_profile_complete` and `LEFT JOIN team_settings ts ON ts.team_id = tm.team_id` → `ts.require_complete_profile`, decoded as `Schema.Boolean` / `Schema.OptionFromNullOr(Schema.Boolean)` with `None` ⇒ `false` |
| HTTP `submitRsvp` | `requireMembership` → `findMembershipByIds` → `MembershipWithRole` (`TeamMembersRepository.ts:65`) | same `LEFT JOIN team_settings`; `is_profile_complete` is already free on `Auth.CurrentUserContext` (`utils/toCurrentUser.ts:18`) |
| `Carpool/ReserveSeat`, `Carpool/AddCar` | `resolveMember` → `findMembershipByDiscordAndTeam` → the **same** `MembershipWithRole` class | the same two columns cover both carpool handlers at once; this path has no `CurrentUser`, so it needs `u.is_profile_complete` too (the query already `JOIN users u`) |

Two schema classes change, five SQL statements. `TeamMemberLookup` is the `Result` of five queries
in `rpc/event/index.ts` (`:444`, `:1191`, `:1343`, `:1626`, `:1704`) — widening the class forces the
same two columns onto all five SELECTs. Three of those (`UnclaimTraining`,
`Approve/DeclineRosterRequest`) are not gated and simply carry unread columns; that is the price of
one shared lookup class and it is cheaper than a second class.

`MembershipWithRole` is referenced 181 times across the server test tree; the overwhelming majority
are `as unknown as MembershipWithRole` casts or `Map<string, MembershipWithRole>` type positions,
which a widened class does not break. Expect a handful of strict object literals to need two extra
fields. `findMembershipQuery` (`:187`) does not `JOIN users` today and gains one.

**Placement in each handler:** immediately after the member/membership bind and before every other
precondition, so an incomplete profile reports as itself rather than as `RsvpDeadlinePassed` /
`ClaimNotOwnerGroupMember` / `CarpoolFull`. For `Event/SubmitRsvp` that requires reordering the
handler — see the next section.

**Residual risk accepted:** a hypothetical fifth writer can forget the guard. Mitigation is a real
test, not a grep — see Task 3's `gatedWriters.test.ts`. The type-enforced upgrade (a branded
`ProfileGateOk` token that only the helper mints, required as an argument to the four writes) is
named here as the escalation and deliberately not built.

### The errors: one per transport, each following its own file's prefix convention

`EventRsvpApi.RsvpDeadlinePassed` (`api/EventRsvpApi.ts:56-58`) and
`EventRpcModels.RsvpDeadlinePassed` (`rpc/event/EventRpcModels.ts:75-77`) carry an **identical**
tag — they are a collision that happens to be harmless because the two schemas never meet on one
wire, **not** a precedent for differing tags. Do not cite them as one.

The real convention in each file is its own **prefix**: `EventRsvpApi` uses `EventRsvp*`
(`EventRsvpEventNotFound:50`, `EventRsvpForbidden:54`, `EventRsvpMessageRequired:62`);
`EventRpcModels` uses bare `Rsvp*` / `Claim*`; `CarpoolRpcModels` uses `Carpool*`.

| Transport | File | Class | Tag | Status |
|---|---|---|---|---|
| HTTP | `packages/domain/src/api/EventRsvpApi.ts` | `RsvpProfileIncomplete` | `'EventRsvpProfileIncomplete'` | `HttpApiSchema.status(403)` on `submitRsvp` |
| RPC | `packages/domain/src/rpc/event/EventRpcModels.ts` | `RsvpProfileIncomplete` | `'RsvpProfileIncomplete'` | in `SubmitRsvp`'s `error:` union |
| RPC | `packages/domain/src/rpc/event/EventRpcModels.ts` | `ClaimProfileIncomplete` | `'ClaimProfileIncomplete'` | in `ClaimTraining`'s `error:` union |
| RPC | `packages/domain/src/rpc/carpool/CarpoolRpcModels.ts` | `CarpoolProfileIncomplete` | `'CarpoolProfileIncomplete'` | in `AddCar`'s and `ReserveSeat`'s `error:` unions |

403, not 400: the request is well-formed; the *actor* is not yet permitted. Matches the
`Forbidden` family in AGENTS.md → "HTTP API Error Tags".

**The UX requirement this satisfies** (design spec §3.3): `*ProfileIncomplete` must be
distinguishable from `RsvpMemberNotFound` / `CarpoolNotMember`. One is "do this 20-second thing",
the other is "you are in the wrong server". Collapsing them is the single worst outcome available.

### Guard ordering in `Event/SubmitRsvp` — a required reorder

Today the handler binds `event` (`:433`), taps the deadline check (`:435`), *then* binds `member`
(`:440`). The gate reads off the `member` bind, so with the current order a profile-incomplete
member on a closed event gets `RsvpDeadlinePassed` and never sees the Verify button.

**Hoist the `member` bind above the `event` bind and the deadline tap.** `Event/ClaimTraining` in
the same file already binds `member` first (`:1185`), so this is the file's other convention, not a
new one.

**Behaviour change, stated explicitly:** a **non-member** submitting an RSVP now gets
`RsvpMemberNotFound` where they previously got `RsvpEventNotFound` (deleted event) or
`RsvpDeadlinePassed` (closed event). That is strictly more accurate — the reply moves from
"termín vypršel" to "nejsi členem tohoto týmu" — and it is pinned by a test (Task 2).

The HTTP `submitRsvp` needs no reorder: `requireMembership` is already its first bind (`:176`).

---

## Rollout: two levers

**Blast radius, stated plainly.** Every member whose row was created by `Guild/RegisterMember`
and who never ran `/complete` or finished the web profile has `is_profile_complete = false`. The
web onboarding forces completion, so the false cohort is essentially "everyone who joined via
Discord and never used the web app" — realistically **the majority of a Discord-native club's
roster**, unbounded. Measure before flipping anything:

```sql
SELECT t.id, t.name,
       count(*) FILTER (WHERE NOT u.is_profile_complete) AS incomplete,
       count(*) AS total
FROM team_members tm
JOIN users u ON u.id = tm.user_id
JOIN teams t ON t.id = tm.team_id
WHERE tm.active
GROUP BY t.id, t.name
ORDER BY incomplete DESC;
```

**Lever 1 — `team_settings.require_complete_profile BOOLEAN NOT NULL DEFAULT false`.** The
captain's opt-in and the real off switch. Gates the block, the join-time prompt, and the unverified
role/channel. Default `false` means **nothing changes for any existing team on deploy** — this is
the anti-lockout guarantee, and it is a DB default, not a code path.

**Lever 2 — `PROFILE_GATE_ENABLED` env var, server only, default `true`.** The global incident
lever: one variable turns the gate off for every team at once.

Why this one defaults **on** while `DISCORD_JOIN_ENFORCEMENT_ENABLED` defaults off: that flag had
to be the *only* safety, so it defaulted off and needed a service wrapper
(`DiscordJoinEnforcementConfig`) purely so tests could override a module-load-time env read. Here
lever 1 already provides "off for everybody by default", so the env flag can default on, keep the
codebase's `_ENABLED` convention (`DISCORD_JOIN_ENFORCEMENT_ENABLED` at `env.ts:85`, `AI_CHAT_ENABLED`
at `:95`), and still need no service wrapper: tests flip the team column, which is ordinary DB
state. No `AppLive` change, no test-layer churn. Put that sentence in the field's doc comment —
it is the one thing a future reader will ask.

Shape follows `parseDiscordJoinEnforcementEnabled` (`env.ts:113-127`) exactly: raw `Schema.String`
(never `Schema.Literals` — a flag that exists to be flipped during an incident must never fail
boot), permissive case-insensitive parse, unrecognised value → `console.warn` + the safe direction.
**The safe direction here is `true`.** One deviation from the copied source is mandatory: the field
must be `Schemas.Optional(() => 'true')`, and `''` must leave the FALSY set, or an unset variable
would parse as disabled and silently invert the default.

**Staged rollout.** (1) Deploy server, then bot, then web — flags untouched, zero behaviour change.
(2) Run the query above; pick one small pilot team. (3) Captain flips `require_complete_profile` →
joiners get the prompt and the read-only channel, incomplete members get a blocked reply *with the
Verify button*. (4) Watch. (5) Widen. Rollback at any point: unflip the team, or set
`PROFILE_GATE_ENABLED=false` for everyone at once.

### Backward compatibility with an un-upgraded bot

Deploy **server before bot** (AGENTS.md rule).

| Change | Old bot against new server |
|---|---|
| `RegisterMember` success gains `profile_complete`, `profile_gate_enabled`, `verify_locale` | Effect `Schema.Struct` drops unknown keys on decode. No effect. Safe. |
| `SubmitRsvp` / `ClaimTraining` / `AddCar` / `ReserveSeat` error unions gain a tag | Old bot's client schema cannot decode the tag → the interaction falls through to its terminal `withBackstop` / `Effect.catchCause` arm and shows the generic error copy. Degraded, not broken — and unreachable in practice because no team's `require_complete_profile` is flipped until after the bot ships. |

New bot against old server (rollback window): `profile_complete` is declared
`Schema.Boolean.pipe(Schema.withDecodingDefaultKey(() => true))` — an absent key means "complete",
i.e. never nag. `profile_gate_enabled` defaults to `false` and `verify_locale` to `'en'`, so an
absent key means "do nothing".

---

## Deliverable D — the unverified role + read-only channel: IN SCOPE

Rejected alternatives first, because the recommendation only makes sense against them.

### D2 (invert the existing entry role) — reject

1. `teams.onboarding_rules_role_id` is a **captain-typed, opaque role id** from the team-settings
   form (`web/.../teamInfoForm.ts:102`, `TeamApi.UpdateTeam.onboardingRulesRoleId`). Sideline never
   creates it and has no idea which channels — if any — it gates. `provisionNewTeam.ts:103` sets it
   to `Option.none()`, so for every team that never filled the field there is nothing to invert.
2. Its only writer is `events/guildMemberUpdate.ts`, gated on `member.pending === false` — Discord
   **membership screening**, a per-guild setting Sideline does not control. On a guild with
   screening off the handler never fires, so the grant point being "moved" doesn't exist.
3. Where it *is* configured and load-bearing, withholding it until `/complete` locks an unverified
   member out of the entire server, and the retroactive half (stripping it from today's incomplete
   cohort) is the mass-lockout incident the constraints forbid. There is no safe flag position.
4. It is not revertible by us: re-granting a role to N members needs N REST calls through a
   pipeline that has no "grant to everyone" path.

This also answers design-spec ask #7: the two gates are **never stacked**, because the rules role is
left entirely alone. A member on a screening-enabled guild meets Discord's own wall, then ours —
but ours is an ephemeral with a button, not a locked server.

### D1's muting half — reject

**Discord guild-level role permissions are purely additive — a role cannot subtract a
permission.** "Denying SEND_MESSAGES elsewhere" therefore is not expressible as a role; it requires
a `deny: SendMessages` **channel overwrite on every channel in the guild**, plus on every channel
anyone creates afterwards. That is an unbounded reconciliation surface over channels Sideline does
not own (`discord_channels` is a mirror, not an authority), against Discord's per-channel overwrite
ceiling, with no backout. **Not building it.** This matches design-spec ask #9: Discord-level
restriction is for the one info channel's visibility, nothing else.

### D3 — D1's lifecycle, exactly one channel, no guild-wide muting: build this

* **One bot-owned Discord role** (`Sideline Unverified`), resolved by name with `ensureSudoRole`'s
  exact pattern (`rest/roles/ensureSudoRole.ts`: list → find by name → create, deterministic
  oldest-id tiebreak, no DB row).
* **No `discord_role_mappings` row and no Sideline `roles` row.** This is what makes it inert with
  respect to `reconcileMemberDiscordRoles`: both of that diff's candidate lists are filtered from
  `managed` (the team's `discord_role_mappings`), so "a Discord role with no `discord_role_mappings`
  row is never considered, added, or removed" — the CC-8 anti-stripping guard, stated in that
  file's own doc comment. Verified; zero interaction, by construction, with no new code.
* **One channel**, created with the `createDiscordChannelAndRole` shape
  (`rest/channels/createChannelWithRole.ts:33`), using two constants that already exist
  (`rest/permissions.ts:11-13`, `:44-51`):
  * `@everyone` → `deny(HIDDEN)` — `ViewChannel` denied.
  * unverified role → `allow/deny(CHANNEL_ACCESS_VIEW)` — view + read history, deny send, react,
    threads.

  **This topology needs no roster backfill**, which is the whole reason it is safe to ship: the
  channel is invisible to everyone by default and becomes visible only to members who are *given*
  the role. Nobody loses access to anything. Contrast the design spec's §4.3 inversion
  (`@everyone` ALLOW view, `Ověřeno` role DENY view), which would make the channel visible to the
  entire existing roster on creation and require granting a role to every already-complete member
  before it settled. Same member-visible outcome, no backfill.
* Channel name, topic, pinned embed and the "never delete the message, never garbage-collect the
  channel" rule are the design spec's (§4.1, §4.2, §4.3). Do not make the embed per-team
  configurable.

### Grant / revoke, and the two-writer drift

`users.completeProfile` has **two** writers (`api/auth.ts:463`, `rpc/guild/index.ts:1301`).
Revoking the role only in the bot's modal-submit path strands every member who finishes their
profile on the web: the channel stays in their sidebar forever.

Make both directions **idempotent and evaluated on every `guildMemberAdd`**, not just on completion:

* `profile_complete === false` and `profile_gate_enabled` → `ensureUnverifiedRole` (create if
  absent) + `addGuildMemberRole`. Adding a role the member already holds is a Discord no-op.
* `profile_complete === true` and `profile_gate_enabled` → `findUnverifiedRole` (**resolve only,
  never create** — creating a role in order to revoke it is absurd) + `deleteGuildMemberRole`.
  Removing an absent role is a Discord no-op, the same argument `rcp/role/handleUnassigned.ts:31-32`
  already makes for its own unconditional delete.
* `profile_gate_enabled === false` → do nothing in either direction. Otherwise every complete
  member's join costs a REST call on every team in the product.
* Plus the existing revoke on modal-submit success, which is the fast path.

`ponytail:` two named ceilings, both cosmetic-only, both upgradeable to a nightly sweep *if they
are ever observed*:
1. A member who completes on the web and never rejoins keeps a visible read-only channel until
   their next join or their next `/dokoncit`.
2. A team that turns `require_complete_profile` back **off** leaves already-granted roles in place;
   the channel is then visible to whoever still holds the role. The captain can delete the role.

`Guild/ReconcileMembers` is **not** a self-heal point: it discards the `RegisterMember` DTO
entirely (see `rpc/guild/index.ts:780-820`), so wiring the role to it would mean giving the
reconcile pass a second purpose. Not doing that.

---

## Locale at join time — why the DTO carries `verify_locale`

`guildLocale` (`bot/src/locale.ts:7-8`) reads `interaction.guild_locale`. **`GuildMemberAdd` is a
gateway dispatch with no interaction and no such field**, so the previous revision's "use
`guildLocale` in task 8" was not implementable. `guildLocaleFromRaw` exists but needs an uncached
`getGuild` REST call per join.

Resolution: `RegisterMember`'s response carries `verify_locale: Onboarding.OnboardingLocale`, read
straight off `teams.onboarding_locale` — a column every team already has, on a row the handler has
already loaded. Zero extra queries, zero REST calls, and it is the team's own configured language
rather than Discord's guess.

**Deviation from ruling R8, flagged deliberately.** R8 asked the server to *render the prompt
string* into the DTO. That resolves the locale problem for one string; Deliverable D needs eleven
(channel name, topic, seven embed strings, the welcome-embed field pair, the button label), all of
which are Discord components the bot constructs itself and cannot receive pre-rendered. Shipping
eleven rendered strings on every join DTO is worse than shipping one locale. The binding half of
R8 — *task 8 must not call `guildLocale` and must not add a `getGuild` call* — is met in full.
The server *can* render (`@sideline/i18n` is already a server dependency and
`api/translations.ts:4` already pulls `messagesByKey`, which is the messages module), so this is a
reversible choice, not a capability limit. **Confirm or overrule before Task 4 is written.**

Bot AGENTS.md → "Rules When Modifying the Welcome Flow" is unaffected: rule 1 forbids rendering the
captain's `welcome_message_template` in the bot (still server-rendered), and rule 3 forbids the bot
*looking up* denormalised metadata (channel ids, group colour, inviter id — all still from the DTO).
The bot rendering its own i18n is what it does for every button label in the product.

---

## Task list — one commit each

### Task 0 — manual spike, no commit. **Nothing else is built until this passes.**

Open the profile modal once against a real guild with a **mixed** payload: three `type: 1` action
rows (the existing text inputs) plus one `type: 18` `LabelComponentForModalRequest` wrapping a
`StringSelectComponentForModalRequest`. Confirm Discord accepts it and that the submit payload
arrives with a `ModalSubmitLabelComponent` carrying `component.values: [gender]`.

Typing is confirmed on both sides:
`ModalInteractionCallbackRequestData.components` accepts
`ActionRowComponentForModalRequest | LabelComponentForModalRequest | TextDisplayComponentForModalRequest`
(`applications/bot/node_modules/dfx/dist/DiscordREST/Generated.d.ts:4622-4638`), and
`ModalSubmitLabelComponent` / `APIModalSubmitStringSelectComponent` exist on the submit side
(`applications/bot/node_modules/discord-api-types/payloads/v10/_interactions/modalSubmit.d.ts:9-11,41-45`).
Typing is not acceptance — Discord's API is the authority here.

**If the mixed payload 400s:** retry once in the same session with *all four* fields as `type: 18`
label components (no action rows at all). **If label components in a modal are rejected outright:**
fall back to the design spec's §2.2 three-button design — an ephemeral `profile-verify` entry
button responding with three SECONDARY gender buttons (`profile-verify:male|female|other`), each
responding `MODAL` with `custom_id: profile-complete:{gender}`, and
`decodeGenderFromCustomId` + the current `modalValueOption` both stay exactly as they are. That
fallback adds one file (`interactions/profile-verify.ts` grows a second handler), one i18n key
(`bot_verify_gender_prompt`) and one extra tap for the member; it changes nothing else in this plan.

---

### Task 1 — `feat(domain,migrations): profile-gate wire contract`

Domain + migration only, so the server/bot/web tasks all compile against one rebuilt `dist`.

**Files**

* `packages/migrations/src/before/1792110000_add_team_settings_require_complete_profile.ts` — **new**.
  `ALTER TABLE team_settings ADD COLUMN IF NOT EXISTS require_complete_profile BOOLEAN NOT NULL DEFAULT false;`
  **Implemented as `1792110000`, not the `1792060000` this plan originally named.** By the time the
  task was built, `1792100000_series_time_is_team_local.ts` had *landed* on `origin/main` — this plan
  and `.work-plans/series-time-conversion.md:41` both still described that id as merely "reserved".
  `scripts/check-migration-ids.mjs` requires every new id to be strictly greater than every id on
  `origin/main`, so `1792060000` would now fail that check. Verified with `pnpm lint:migration-ids`.
  **Re-take the next free id again at merge time** if main moves on.
* `packages/domain/src/models/TeamSettings.ts` — `require_complete_profile: Schema.Boolean`.
* `packages/domain/src/api/TeamSettingsApi.ts` — `requireCompleteProfile: Schema.Boolean` on
  `TeamSettingsInfo`; `requireCompleteProfile: Schema.OptionFromOptional(Schema.Boolean)` on
  `UpdateTeamSettingsRequest`. Copy the `rsvpRemindersEnabled` lines (`:40`, `:91`).
* `packages/domain/src/api/EventRsvpApi.ts` — `RsvpProfileIncomplete` tagged
  `'EventRsvpProfileIncomplete'`; add `RsvpProfileIncomplete.pipe(HttpApiSchema.status(403))` to
  `submitRsvp`'s `error` array only.
* `packages/domain/src/rpc/event/EventRpcModels.ts` — `RsvpProfileIncomplete`
  (`'RsvpProfileIncomplete'`) and `ClaimProfileIncomplete` (`'ClaimProfileIncomplete'`).
* `packages/domain/src/rpc/carpool/CarpoolRpcModels.ts` — `CarpoolProfileIncomplete`
  (`'CarpoolProfileIncomplete'`).
* `packages/domain/src/rpc/event/EventRpcGroup.ts` — add the two tags to `SubmitRsvp`'s (`:94`) and
  `ClaimTraining`'s (`:192`) error unions.
* `packages/domain/src/rpc/carpool/CarpoolRpcGroup.ts` — add the tag to `AddCar`'s (`:62`) and
  `ReserveSeat`'s (`:79`) error unions.
* `packages/domain/src/rpc/guild/GuildRpcGroup.ts` — three new **top-level** fields on
  `RegisterMember`'s `success` struct (`:124-140`), outside the nested `welcome`:

  ```ts
  // Absent key = an old server. Safe direction is "never nag", so default true.
  profile_complete: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(() => true)),
  // team_settings.require_complete_profile. Absent = off = the bot does nothing.
  profile_gate_enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(() => false)),
  // teams.onboarding_locale. GuildMemberAdd has no guild_locale to read, so the locale for
  // every string the bot posts at join time rides on the DTO. See "Locale at join time".
  verify_locale: Onboarding.OnboardingLocale.pipe(Schema.withDecodingDefaultKey(() => 'en')),
  ```

  Use `//` line comments, not JSDoc — the barrel codegen hoists a file's first doc block onto its
  `export * as` line.

**Pattern:** `rsvp_reminders_enabled` end-to-end (server AGENTS.md → "Adding a Team Setting
End-to-End"), places 1–3 of 6.

**Edge cases:** `Schema.optionalWith` does not exist in `effect@4.0.0-beta.40` — use
`Schema.OptionFromNullOr` / `Schema.withDecodingDefaultKey`. Write the migration idempotently
(`IF NOT EXISTS`) so a renumber stays safe.

---

### Task 2 — `refactor(server): bind the RSVP member before the event and deadline checks`

Behaviour-affecting reorder, isolated into its own commit so the diff and its one behaviour change
are reviewable without the gate on top of them.

**Files**

* `applications/server/src/rpc/event/index.ts` — in `Event/SubmitRsvp`, move the
  `Effect.bind('member', ...)` block (`:440-461`) above the `Effect.bind('event', ...)` bind
  (`:433`) and above the `eventAcceptsRsvp` deadline tap (`:435`). Nothing else moves; the group
  check, `priorRsvp`, message-required check and upsert already depend on `member` and stay put.
  Add a comment naming the reason (the profile gate reads off `member` and must report before the
  deadline) and the precedent (`Event/ClaimTraining` at `:1185` already binds `member` first).

**Behaviour change:** a non-member submitting an RSVP now fails `RsvpMemberNotFound` where they
previously failed `RsvpEventNotFound` (event deleted) or `RsvpDeadlinePassed` (event closed). The
bot renders `bot_rsvp_not_member` instead of `bot_rsvp_deadline_passed` for that member — strictly
more accurate.

---

### Task 3 — `feat(server): require a complete profile to RSVP, claim or take a seat`

**Files**

* `applications/server/src/env.ts` —
  `PROFILE_GATE_ENABLED: Schema.String.pipe(Schemas.Optional(() => 'true'), Schema.toStandardSchemaV1)`,
  plus `parseProfileGateEnabled` and the exported `profileGateEnabled` constant. Copy
  `parseDiscordJoinEnforcementEnabled` (`:113-127`) in structure. TRUTHY
  `['true','1','yes','on']`, FALSY `['false','0','no','off']` — **`''` must not be in the FALSY
  set** or an unset variable inverts the default. Unrecognised → `console.warn` + `true`. One
  sentence in the doc comment saying why this flag defaults on (lever 1 is the real off switch).
* `applications/server/src/utils/requireCompleteProfile.ts` — **new**, body above.
* `applications/server/src/repositories/TeamMembersRepository.ts` — add
  `is_profile_complete: Schema.Boolean` and
  `require_complete_profile: Schema.OptionFromNullOr(Schema.Boolean)` to `MembershipWithRole`
  (`:65`); `findMembershipQuery` (`:187`) gains `JOIN users u ON u.id = tm.user_id` and both
  columns; `findMembershipByDiscordQuery` (`:200`) already joins users, gains the `LEFT JOIN
  team_settings ts ON ts.team_id = tm.team_id` and both columns.
* `applications/server/src/rpc/event/index.ts` — add the same two columns to `TeamMemberLookup`
  (`:55`) and to all **five** of its SELECTs (`:444`, `:1191`, `:1343`, `:1626`, `:1704`). Then in
  `Event/SubmitRsvp` and `Event/ClaimTraining`, one `requireCompleteProfile` tap immediately after
  the (now first) `member` bind.
* `applications/server/src/rpc/carpool/index.ts` — `resolveMember` is the chokepoint for all six
  carpool handlers, so do **not** put the guard inside it (that would gate `LeaveCarpool` and
  `RemoveCar`, which are un-blocking actions and must always work). One tap after the `membership`
  bind in `Carpool/AddCar` (`:145`) and `Carpool/ReserveSeat` (`:180`) only.
* `applications/server/src/api/event-rsvp.ts` — in `submitRsvp`, one tap immediately after the
  `membership` bind (`:176`), reading `currentUser.isProfileComplete` and
  `membership.require_complete_profile`. Declare
  `const profileIncomplete = new EventRsvpApi.RsvpProfileIncomplete()` next to the other
  module-level singletons (`:25-28`).
* `applications/server/src/repositories/TeamSettingsRepository.ts` — place 4 of the recipe:
  `require_complete_profile: Schema.Boolean` on `TeamSettingsRow` (`:17` region) and on the upsert
  input row (`:74` region); the SELECT / INSERT / `ON CONFLICT DO UPDATE` / `RETURNING` column
  lists (`:158`, `:217`, `:240`, `:264`, `:291`); the `upsert` named param
  `requireCompleteProfile = false` with its type (`:427`, `:457`, `:486`).
* `applications/server/src/api/team-settings.ts` — place 5: the `onNone` default-object branch
  (`:40`), the `onSome` branch (`:69`), both upsert branches (`:131`, `:210`), and the response
  mapper (`:396`). Default `false` in all of them.
* `applications/server/AGENTS.md` — retitle "RSVP Has Two Write Surfaces — Apply Side Effects to
  Both" to cover four gated writers, name `requireCompleteProfile` and the two levers, and
  **replace the "grep `upsertRsvp` before shipping" instruction (`:1079`) with a pointer to
  `test/gatedWriters.test.ts`** — an invariant that only a human's grep enforces is not enforced.

**Order:** env → helper → repositories → the four handlers → team-settings plumbing → AGENTS.md.

**Edge cases**

* A team with **no** `team_settings` row must read as `false` (never block). The `LEFT JOIN`'s
  `NULL` → `Option.none()` → `false` branch is load-bearing; test it.
* Do not touch `getRsvps`, `GetCarpoolView`, or any read path. Reading the roster stays allowed;
  only writing is gated.
* `Carpool/LeaveCarpool`, `Carpool/RemoveCar`, `Event/UnclaimTraining` are **not** gated — a member
  who is already in a car or holding a training must always be able to get out, gate or no gate.

---

### Task 4 — `feat(server): carry verification state in RegisterMember's response`

**Files**

* `applications/server/src/rpc/guild/index.ts`
  * extend the local `WelcomeMeta` type (`:95-99`) with `profile_complete: boolean`,
    `profile_gate_enabled: boolean` and `verify_locale: Onboarding.OnboardingLocale` —
    **top level**, next to `system_log_channel_id`, not inside `WelcomeDetail`. That is the whole
    point: the cohort this story targets gets `welcome: None`.
  * `buildWelcomeMeta` (`:330`) takes two more inputs: the `user` already bound by
    `registerMemberWithReconcile` (`upsertFromDiscord` returns `User.User`, which carries
    `is_profile_complete` — zero extra queries) and `team.onboarding_locale` (already on the loaded
    row — zero extra queries).
  * `profile_gate_enabled` is the only field that costs a query
    (`deps.teamSettings.findByTeamId(team.id)`). **Skip that lookup entirely when
    `payload.source` is `Some('reconcile')`** and emit `false`: `Guild/ReconcileMembers` calls
    `registerMemberWithReconcile` for every member at `concurrency: 5` (`:795-815`) and **discards
    the `welcomeMeta` result**, so the query would be pure waste on the largest fan-out in the
    server. `profile_complete` and `verify_locale` are free and stay populated on that path.
  * Both the `noWelcome` object and the `onSome` branch must set all three fields.
  * `registerMemberWithReconcile`'s `Effect.bind('welcomeMeta', ...)` (`:562`) now also destructures
    `user`.

**Do not** add a repository to `GuildsRpcLive`'s top-level `Effect.Do.pipe` — it is at 19 of a
maximum 20 arguments (server AGENTS.md, `RegisterMember` rule 5). `teamSettings` is already bound.

**Edge cases**

* `profile_gate_enabled === false` → the bot does nothing at join time: no button on the welcome
  embed, no role, no channel. Deliberate; the team has not opted in.
* `Guild/ReconcileMembers` must **not** start posting prompts or granting roles on every bot
  reconnect. Two independent guarantees: the bot only acts on the DTO in its `GuildMemberAdd`
  handler, and the reconcile path now reports `profile_gate_enabled: false` by construction.

---

### Task 5 — `feat(web): profile-gate setting + blocked-RSVP copy`

**Files**

* `applications/web/src/components/organisms/team-settings/settingsForm.ts` — `requireCompleteProfile: boolean` on the values type (`:20` region), seed from `settings.requireCompleteProfile` (`:49`), `Option.some(values.requireCompleteProfile)` in the save payload (`:141`).
* `applications/web/src/components/organisms/team-settings/GeneralLimitsCard.tsx` — a checkbox,
  copying `RemindersCard.tsx:103-108`'s `rsvpRemindersEnabled` shape.
* `applications/web/src/components/pages/EventDetailPage.tsx` — in `handleRsvpSubmit` (`:437`), an
  `Effect.catchTag('EventRsvpProfileIncomplete', () => Effect.fail(ClientError.make(tr('rsvp_profileIncomplete'))))`
  **above** the existing `Effect.mapError` catch-all.
* `packages/i18n/messages/{en,cs}.json` — the three `*_profileIncomplete` / `teamSettings_*` keys
  from the table below. Web strings are **vykání** (`profile_complete_title: "Dokončete svůj profil"`).

**Note:** this path is near-unreachable today — `teams/$teamId/index.tsx:16` already redirects a
user with an incomplete profile away from the team. Add it anyway; it is the cheap half of the
type-level mapping and the redirect is a client-side guard, not a server one.

---

### Task 6 — `feat(bot): ask for gender inside the profile modal`

The spike (task 0) has passed. One tap, one form, no intermediate step.

**Files**

* `applications/bot/src/commands/complete/modal.ts` — **new**.
  `export const buildProfileCompleteModal = (locale: 'en' | 'cs') => ({ custom_id: 'profile-complete', title, components: [...] })`,
  returning just the `data` object. Three action rows of text inputs as today, plus one
  `type: 18` label wrapping a `StringSelectComponentForModalRequest`:
  `custom_id: 'profile_gender'`, `required: true`, `min_values: 1`, `max_values: 1`, options
  `gender_male` / `gender_female` / `gender_other` (existing keys, already used by `genderLabel`),
  `placeholder: bot_complete_gender_placeholder`, label `bot_complete_gender_label`, description
  `bot_complete_gender_description`.
* `applications/bot/src/commands/complete/handler.ts` — call it. **Drop the `gender` option
  parsing**; the handler becomes a guild check plus one call.
* `applications/bot/src/commands/complete/index.ts` — **remove the `gender` command option**
  (`:13-41`). It is now redundant: the modal asks. Removing a required option is a compatible
  command-definition update.
* `applications/bot/src/interactions/profile-complete.ts` — the contract changes here, once:
  * `Ix.idStartsWith('profile-complete:')` → `Ix.id('profile-complete')` (`:102`). Exact match, so
    it cannot swallow anything else.
  * **Delete `decodeGenderFromCustomId` (`:62-67`)** and the `profile-complete:{gender}` scheme with
    it. Gender now arrives in the modal payload: `decodeGender(modalValueOption(data, 'profile_gender'))`.
  * `modalValueOption` (`:73-88`) must walk **both** shapes. Today it is
    `if (row.type !== 1) continue;`; it gains a `row.type === 18` branch reading `row.component`,
    and per-component it reads `values[0]` for a select and `value` for a text input. The
    action-row branch stays — the three text inputs still ride in action rows.
  * Failure copy: split the current single `bot_complete_not_member` arm into
    `bot_verify_not_member` (`CompleteProfileNotMember`) and `bot_verify_guild_not_registered`
    (`CompleteProfileGuildNotFound`); map `RpcClientError` to `bot_verify_unavailable`.
  * `parseBirthDate` (`:24-32`): normalise Czech input (`24. 8. 2005`, `24.8.2005`, `24/8/2005`) to
    ISO before `Auth.BirthDateString`, and return a tagged `'invalid' | 'too_young'` so an under-6
    date reads `bot_verify_too_young` instead of "neplatné datum" (design asks #3 and #4, ~10 lines
    total). Keep `Auth.BirthDateString` as the authority; the normaliser only reshapes the string.
* `packages/i18n/messages/{en,cs}.json` — the modal and failure keys from the table below.

**`/dokoncit` still flows through the same submit handler**, and now through the *same modal*: one
builder, one `custom_id`, one `ProfileCompleteModal`. That is the whole point of collapsing the
gender argument into the form.

**Modal limits:** every label and the title must be ≤45 characters in both locales (bot AGENTS.md
rule 5 — Discord rejects the whole modal otherwise). Task 6's test asserts it.

---

### Task 7 — `feat(bot): a Verify button that opens the profile modal`

**Files**

* `applications/bot/src/interactions/profile-verify.ts` — **new**, one handler.
  `ProfileVerifyButton = Ix.messageComponent(Ix.id('profile-verify'), ...)` — **exact** match,
  responding `InteractionCallbackTypes.MODAL` with `buildProfileCompleteModal(locale)`.
  **No RPC call, no defer** — a `MODAL` response cannot be deferred (bot AGENTS.md).
  Export `buildVerifyButton(locale)` returning the single `UI.button({ style: 1, ... })` used by
  tasks 8, 9 and 10, so the entry `custom_id` is minted in exactly one place.
* `applications/bot/src/interactions/index.ts` — import + `.add(ProfileVerifyButton)`.

**`custom_id`:** `profile-verify`, 14 chars, carries **no state**. The design spec writes it as
`vrf`; the id is not member-visible, so either spelling works — `profile-verify` matches the
codebase's existing kebab prefixes (`profile-complete`, `upcoming-rsvp`). Discord rejects a whole
message with `50035` on a duplicate id or an id over 100 chars; a stateless 14-char id, one per
message, cannot hit either.

**Guild-less interaction:** a button clicked in a DM has no `guild_id`. Reply
`bot_complete_no_guild` ephemerally, same as `handler.ts:18-26`. We post no DMs, so this is only
reachable if someone drags a message into one.

**Public-message safety:** the button sits on public messages (tasks 9, 10), so anyone can click
it, including already-complete members. That is harmless and idempotent — the modal writes only to
the clicker's own profile, `Guild/CompleteMemberProfile` already rejects a non-member with
`CompleteProfileNotMember`, and re-running the flow is exactly what `/dokoncit` is for. No
"already verified" pre-check: it would cost an RPC round-trip on a response that cannot be
deferred.

---

### Task 8 — `feat(bot): offer the Verify button when an action is blocked`

This is the surface that reaches the **existing** incomplete cohort with no backfill, and it fires
at the exact moment the member cares.

**Files**

* `applications/bot/src/interactions/rsvp.ts` — three sites (`:272`, `:487`, `:613` regions). Add
  `Effect.catchTag('RsvpProfileIncomplete', ...)` returning the existing
  `{ _tag: 'error', hasMessage: false, content }` shape plus a new optional `components` field, and
  widen the error branch's payload from `{ content: result.content }` to also spread `components`
  when present.
* `applications/bot/src/interactions/upcoming-rsvp.ts` — three sites (`:178`, `:347`, `:511`
  regions). These call `updateOriginalWebhookMessage` directly per arm, so each is a two-line
  addition.
* `applications/bot/src/interactions/claim.ts` — one site (`:97` region), `ClaimProfileIncomplete`
  → `bot_verify_blocked_claim` + the button.
* `applications/bot/src/interactions/carpool.ts` — two sites (`:465` region for AddCar, `:611`
  region for ReserveSeat), `CarpoolProfileIncomplete` → `bot_verify_blocked_carpool` + the button.

Nine near-identical edits, deliberately **not** refactored into a shared handler — nine two-line
diffs beat restructuring nine working interaction handlers.

**No RSVP resume.** The blocked copy must **not** promise "we'll save your Ano afterwards". The
member re-taps the RSVP button after verifying: one extra tap, zero new state, and the entire
`custom_id`-budget problem (the design spec's §3.2 table, 90 of 100 characters with no slack)
disappears along with the pending-intent store, the `pvr:` prefix and the resume failure mode
("profile saved, RSVP not saved" after a modal timeout). `bot_verify_blocked_rsvp` therefore takes
no `{response}` placeholder.

**Edge case:** every one of these replies is the deferred ephemeral follow-up, so the button is only
visible to the clicker. Good — the prompt is private by construction.

---

### Task 9 — `feat(bot): verify field + button on the welcome embed`

**Files**

* `applications/bot/src/events/index.ts` — `handleWelcomeMeta` (`:216`) gains `profile_complete`,
  `profile_gate_enabled` and `verify_locale` on its parameter type, and one branch:
  * `profile_gate_enabled === false` **or** `profile_complete === true` → unchanged behaviour.
  * otherwise, **and a welcome embed is being sent** → add one non-inline field
    (`bot_verify_welcome_field_name` / `_value`) to that embed and
    `components: [UI.row([buildVerifyButton(verify_locale)])]` to the **same** `createMessage` call.
    One message, one ping — never a second bot message chasing someone who just walked in.
  * otherwise, **and no welcome embed** (the Discord-native cohort) → **post nothing**. Task 10's
    pinned channel is their surface, and task 8 is the universal safety net. A per-member message
    into the verify channel would turn one clean pinned card into a scroll of identical bot spam
    (design spec §1.3).
* `applications/bot/src/services/welcomeRenderer.ts` (or wherever `buildWelcomeEmbed` lives) — the
  existing `Skupina` / `Group` field name is **hardcoded English**; key it as
  `bot_welcome_group_field` while the file is open.

**Locale:** `verify_locale` from the DTO. **Do not call `guildLocale`** — `GuildMemberAdd` has no
`guild_locale` field (`bot/src/locale.ts:7-8`) — and do not call `getGuild`.

**Do not** render the captain's welcome template in the bot and **do not** look any channel id up
in the bot (welcome-flow rules 1 and 3). Both still come from the DTO.

---

### Task 10 — `feat(bot): unverified role + read-only verification channel`

Bot-only; touches no server code, no migration, no RPC. Ships last because it is the largest task,
not because it is optional.

**Files**

* `applications/bot/src/rest/roles/ensureUnverifiedRole.ts` — **new**. The shape of
  `ensureSudoRole.ts` with `UNVERIFIED_ROLE_NAME = 'Sideline Unverified'` and `permissions: 0`
  (never `Administrator`). Export **two** functions: `findUnverifiedRole` (list → find by name →
  `Option`, never creates) for the revoke path, and `ensureUnverifiedRole` (find-or-create) for the
  grant path. No `Role/UpsertMapping`, no `discord_role_mappings`, no Sideline `roles` row — state
  in the file's doc comment that this absence is what keeps `reconcileMemberDiscordRoles` inert
  (CC-8 anti-stripping guard).
* `applications/bot/src/rest/channels/ensureVerificationChannel.ts` — **new**. `listGuildChannels` →
  find by name (`bot_verify_channel_name`) → else `createGuildChannel` with
  `topic: bot_verify_channel_topic` and
  `permission_overwrites: [{ id: guildId, type: ROLE, deny: deny(HIDDEN) }, { id: unverifiedRoleId, type: ROLE, allow: allow(CHANNEL_ACCESS_VIEW), deny: deny(CHANNEL_ACCESS_VIEW) }]`
  (`allow`/`deny` from `rest/utils.ts`, constants from `rest/permissions.ts:11-13,44-51` — add
  neither). On create only, post **one** embed (`bot_verify_intro_*`, colour `0x5865f2` to match
  `DEFAULT_WELCOME_COLOR`) carrying `buildVerifyButton(locale)`, and pin it. Follow
  `createChannelWithRole.ts`'s `Effect.suspend` + `retryPolicy` + `catchIf(isPermanentError)`
  discipline. **Never delete the message, never garbage-collect the channel.**
* `applications/bot/src/services/VerificationChannelCache.ts` — **new**, a copy of
  `OnboardingRoleCache.ts` keyed by guild id, holding `{ roleId, channelId }`. 60s TTL. Without it
  every join pays a `listGuildChannels` + `listGuildRoles`.
* `applications/bot/src/events/index.ts` — in the branch added by task 9, when
  `profile_gate_enabled === true`:
  * `profile_complete === false` → `ensureUnverifiedRole` + `ensureVerificationChannel` +
    `addGuildMemberRole`.
  * `profile_complete === true` → `findUnverifiedRole` + `deleteGuildMemberRole`. This is the
    self-heal for the **web** `completeProfile` writer (`api/auth.ts:463`), which the bot never
    observes.
  * Both idempotent: adding a held role and removing an absent one are Discord no-ops
    (`rcp/role/handleUnassigned.ts:31-32` makes the same argument).
* `applications/bot/src/interactions/profile-complete.ts` — one `Effect.tap` on the RPC success path
  calling `findUnverifiedRole` + `rest.deleteGuildMemberRole(guildId, userId, roleId)`, wrapped in
  `Effect.catchCause(logWarning)` so a failed revoke never fails the reply. `ponytail:` comment
  naming the ceiling (no reconciler; a stuck role is cosmetic).
* `applications/bot/src/Bot.ts` / wherever layers are assembled — provide
  `VerificationChannelCache.Default`.
* `packages/i18n/messages/{en,cs}.json` — the `bot_verify_channel_*` and `bot_verify_intro_*` keys.

**Edge cases**

* Guild missing `MANAGE_ROLES` / `MANAGE_CHANNELS` → every call fails permanently. Log a warning
  once and continue; **never fail the join**. The channel simply does not exist and tasks 8–9 carry
  the flow, exactly as they do for a team with the gate off.
* Two concurrent joins racing the create → `ensureSudoRole`'s deterministic oldest-id tiebreak
  handles the role; for the channel, accept the duplicate and log (Discord has no unique name
  constraint). `ponytail:` upgrade path is a per-guild semaphore if it ever bites.
* Members who joined before this shipped never get the role until their next join. Deliberate — no
  backfill, and that absence *is* the anti-lockout property. They are reached by task 8.

---

## Test specification

Write these **before** the implementation; they should all fail first.

### Task 1

**Test file:** `applications/server/test/integration/migrations/addTeamSettingsRequireCompleteProfile.test.ts`
(pattern: `test/integration/migrations/addSeriesTimesTeamLocalFlag.test.ts`; helpers `TestPgClient`,
`cleanDatabase` from `../helpers.js`).

1. `column exists and defaults to false` — insert a `team_settings` row without the column;
   expected `require_complete_profile === false`.
2. `column is NOT NULL` — expected: an explicit `NULL` insert raises a `SqlError`.

### Task 2

**Test file:** extend `applications/server/test/EventRsvp.test.ts` (the reorder belongs with the
existing RSVP vocabulary tests, not in a new file).

1. `non-member on a closed event → RsvpMemberNotFound` — pins the new order. Fails before the
   reorder with `RsvpDeadlinePassed`.
2. `non-member on a deleted event → RsvpMemberNotFound` — was `RsvpEventNotFound`.
3. `member on a closed event → RsvpDeadlinePassed` — unchanged; proves the reorder did not swallow
   the deadline check.

### Task 3

**Test file:** `applications/server/test/ProfileGate.test.ts` — a new focused file, not an
extension of the 2 904-line `EventRsvp.test.ts`. Copy that file's mock-layer cascade
(server AGENTS.md → "Testing" → "HttpApi Mock-Layer Cascade"): `ApiLive` + `AuthMiddlewareLive` +
the repository mock layers + `RpcTest` for the RPC half. Do **not** add a `ProfileGateConfig`-style
layer — there is no service.

HTTP `submitRsvp`:

1. `setting off, profile incomplete → 204` — the RSVP is written.
2. `setting on, profile incomplete → 403 EventRsvpProfileIncomplete` — expected `upsertRsvp` is
   **never called** (assert on the mock).
3. `setting on, profile complete → 204`.
4. `setting on, no team_settings row at all → 204` — the `LEFT JOIN` NULL branch must not block.
5. `setting on, profile incomplete, deadline also passed → 403 EventRsvpProfileIncomplete`, not
   `RsvpDeadlinePassed` — pins guard ordering.
6. `getRsvps is never gated` — setting on, profile incomplete; expected 200.

RPC, the same six cases through `RpcTest`, per gated handler:

7. `Event/SubmitRsvp` → `RsvpProfileIncomplete`.
8. `Event/ClaimTraining` → `ClaimProfileIncomplete`; plus `claimTraining` never called.
9. `Carpool/ReserveSeat` → `CarpoolProfileIncomplete`; plus `reserveSeat` never called.
10. `Carpool/AddCar` → `CarpoolProfileIncomplete`; plus `addCar` never called.
11. `Carpool/LeaveCarpool` and `Event/UnclaimTraining` are **not** gated — setting on, profile
    incomplete; expected success. Pins that the guard did not land in `resolveMember`.

**Test file:** `applications/server/test/env.profileGate.test.ts` — pure unit test of
`parseProfileGateEnabled`: `'true'|'1'|'yes'|'on'` (any case) → `true`; `'false'|'0'|'no'|'off'`
→ `false`; `'banana'` → `true` **and** `console.warn` called (spy); **`''` → `true`** (the
default-inversion regression). Pattern: whatever guards `parseDiscordJoinEnforcementEnabled` today.

**Test file:** `applications/server/test/gatedWriters.test.ts` — **R10, the grep turned into a
test.** Walk `applications/server/src` (`fs.readdir` recursive, `.ts` only, skip `repositories/`),
and for a table of gated writers assert (a) the exact expected number of call sites and (b) that
every file containing one also contains `requireCompleteProfile`:

| call expression | expected sites | files today |
|---|---|---|
| `upsertRsvp(` | 2 | `api/event-rsvp.ts`, `rpc/event/index.ts` |
| `claimTraining(` | 1 | `rpc/event/index.ts` |
| `reserveSeat(` | 1 | `rpc/carpool/index.ts` |
| `addCar(` | 1 | `rpc/carpool/index.ts` |

It must fail the moment someone adds a writer — a hard-coded count is the point, not a smell.
Assert the file list too, so a *moved* call site is also caught. This replaces
`applications/server/AGENTS.md:1079`'s "grep `upsertRsvp` before shipping".

**Integration:** `applications/server/test/integration/api/profileGate.test.ts` — one end-to-end
case per gated handler against real SQL, because the `TeamMemberLookup` / `MembershipWithRole`
changes are SQL changes and a mock cannot catch a wrong `LEFT JOIN`: seed a team with
`require_complete_profile = true`, a user with `is_profile_complete = false`, a membership, an
event and a carpool; expected the tagged error **and** zero rows written. Plus one case with no
`team_settings` row at all, expected success (the NULL branch, against a real NULL).

### Task 4

**Test file:** `applications/server/test/integration/rpc/registerMemberProfileComplete.test.ts`
(pattern: the two existing `registerMember*.test.ts` files right next to it).

1. `incomplete profile, setting on` — expected `profile_complete === false`,
   `profile_gate_enabled === true`, `verify_locale === team.onboarding_locale`.
2. `incomplete profile, setting OFF` — expected `profile_gate_enabled === false`.
3. `complete profile, setting on` — expected `profile_complete === true`.
4. `no invite context (plain Discord invite)` — expected `welcome === None` **and**
   `profile_complete === false`, `profile_gate_enabled === true`. **This is the regression guard
   for the whole story** — the target cohort gets no welcome embed but must still get the fields.
5. `existing active member re-observed` — expected the fields still populate (the "already active"
   branch of `registerMemberWithReconcile`).
6. `source: 'reconcile'` — expected `profile_gate_enabled === false` **and** the `teamSettings`
   mock's `findByTeamId` was **never called** (assert on the mock). Pins R9's fan-out saving.
7. `cs team` — expected `verify_locale === 'cs'`.

### Task 5

**Test file:** `applications/web/src/components/organisms/team-settings/settingsForm.test.ts`
(extend the existing file).

1. `requireCompleteProfile round-trips` — seed `false`, toggle, expected `Option.some(true)` in the payload.
2. `dirty check` — matching how the file asserts `rsvpRemindersEnabled`.

### Task 6

**Test file:** `applications/bot/test/commands/complete/modal.test.ts` — **new**, plain `vitest`,
static imports only (bot AGENTS.md → "Test File Imports — Static Only").

1. `payload shape` — `buildProfileCompleteModal('cs')`: `custom_id === 'profile-complete'`, four
   components in order — three `type: 1` rows with `profile_name` / `profile_birth_date` /
   `profile_jersey_number` (`required` `true/true/false`) and one `type: 18` label wrapping a
   `type: 3` select with `custom_id: 'profile_gender'`, `required: true`, three options.
2. `every label and the title are ≤45 characters in both locales` — loop `['en','cs']` (bot
   AGENTS.md rule 5 — Discord rejects the whole modal otherwise).

**Test file:** extend `applications/bot/src/interactions/profile-complete.test.ts`.

3. `modalValueOption reads a text input out of an action row` — the existing behaviour, unbroken.
4. `modalValueOption reads a select out of a label component` — a `type: 18` row whose
   `component.values === ['female']` yields `Some('female')`.
5. `gender comes from the payload, not the custom_id` — a submission with
   `custom_id: 'profile-complete'` and `profile_gender: ['male']` completes; a submission with no
   gender component fails `bot_verify_gender_missing`.
6. `Czech dates normalise` — `'24. 8. 2005'`, `'24.8.2005'`, `'24/8/2005'` and `'2005-08-24'` all
   parse to `'2005-08-24'`; `'32. 1. 2005'` fails `'invalid'`.
7. `under MIN_AGE is 'too_young', not 'invalid'` — a well-formed date six months ago.
8. `CompleteProfileNotMember and CompleteProfileGuildNotFound get different copy`.

### Task 7

**Test file:** `applications/bot/src/interactions/profile-verify.test.ts`
(pattern: `applications/bot/src/interactions/upcoming-rsvp.test.ts` — its `makeComponentInteraction`
helper is reusable verbatim; no RPC stub is needed).

1. `button → MODAL` — input `custom_id: 'profile-verify'`; expected
   `type === InteractionCallbackTypes.MODAL` and `data.custom_id === 'profile-complete'`.
2. `the modal response is not deferred` — expected the handler returns the MODAL synchronously with
   no `forkDetach` and no `DEFERRED_*` type.
3. `no guild_id` — expected the ephemeral `bot_complete_no_guild` copy, no modal.
4. `buildVerifyButton mints one id, ≤100 chars, style 1` — the `50035` guard, and the
   single-source-of-truth assertion tasks 8–10 depend on.

### Task 8

**Test file:** `applications/bot/src/interactions/blockedProfileIncomplete.test.ts` — **new**, one
file covering all four interaction files. Stub `SyncRpc` so each RPC fails with its
`*ProfileIncomplete` error; stub `DiscordREST` to capture `updateOriginalWebhookMessage`.

1. `rsvp: button → blocked reply carries the verify button` — captured payload has
   `content === m.bot_verify_blocked_rsvp(..., 'en')` and one row with `custom_id: 'profile-verify'`.
2. `upcoming-rsvp: same` — one case per file is enough; the other sites share the arm shape.
3. `claim: bot_verify_blocked_claim + the button`.
4. `carpool reserve: bot_verify_blocked_carpool + the button`.
5. `cs locale` — expected the Czech string.
6. `no write happens and no re-render is triggered` — the RPC stub was called exactly once and no
   follow-up `Guild/GetAllUpcomingEventsForUser` re-render happened.
7. `the blocked copy contains no {response} placeholder and promises no resume` — a literal assert
   on the message string. Pins R2 against a future re-add.

### Task 9

**Test file:** `applications/bot/test/events/guildMemberAddVerifyPrompt.test.ts` — **new**. Stub
`SyncRpc`'s `Guild/RegisterMember` to return each DTO shape; capture `rest.createMessage`.

1. `profile_complete true` — exactly the messages sent today, **no** button.
2. `profile_gate_enabled false` — exactly the messages sent today, **no** button, even with
   `profile_complete: false`.
3. `incomplete + gate on + welcome embed present` — **one** `createMessage` to the welcome channel
   carrying the embed, the new field and the button (not two messages, not two pings), with
   `allowed_mentions: { parse: [], users: [...] }` preserved.
4. `incomplete + gate on + welcome None` — **no** extra `createMessage`.
5. `verify_locale drives the strings` — `'cs'` on the DTO yields the Czech field and label with no
   `getGuild` call (assert `rest.getGuild` was never called).
6. `an old server's response (no new keys)` — a DTO literally missing all three keys; expected
   `profile_complete` decodes `true`, `profile_gate_enabled` decodes `false`, nothing is posted.

### Task 10

**Test file:** `applications/bot/test/rest/roles/ensureUnverifiedRole.test.ts` — role present →
returns its id, no create; absent → `ensureUnverifiedRole` creates with `permissions: 0` and
`findUnverifiedRole` returns `None` **without creating**; two roles with the same name → the lowest
id plus a warning.

**Test file:** `applications/bot/test/rest/channels/ensureVerificationChannel.test.ts` — channel
present → returns id, no create and **no** second pinned post; absent → creates with exactly two
overwrites (`@everyone` deny `ViewChannel`; role `CHANNEL_ACCESS_VIEW`), posts one message with the
button and pins it; permanent Discord error → logs and returns `None`, never throws.

**Test file:** extend `applications/bot/test/events/guildMemberAddVerifyPrompt.test.ts` —
`incomplete + gate on → role granted`; `complete + gate on → deleteGuildMemberRole called and
createGuildRole NOT called` (the web-writer self-heal, and the reason `findUnverifiedRole` exists);
`gate off → neither called`; `MANAGE_ROLES missing → warning logged, join still succeeds`.

**Test file:** extend `applications/bot/src/interactions/profile-complete.test.ts` —
`successful completion revokes the unverified role`; `a failed deleteGuildMemberRole still returns
the success reply`.

---

## New i18n keys (`packages/i18n/messages/{en,cs}.json`)

Key names are the design spec's. Bot member-facing copy is **tykání** (matching `bot_complete_*`,
`bot_claim_*`, `bot_carpool_*`); web copy is **vykání** (matching
`profile_complete_title: "Dokončete svůj profil"`). The shipped Czech word for RSVP is **účast**
(`bot_rsvp_modal_title: "Účast — {response}"`) — never "docházka", including in the story's own
wording. Person stays consistent within a message.

**Source of truth, so the two documents cannot drift.** This table is authoritative for *which
keys exist*. `.work-plans/discord-full-onboarding-design.md` §6 is authoritative for *the wording
of each one*. Where they differ today, these three rulings settle it — apply them when writing
the JSON, and do not re-open them:

1. **`bot_verify_blocked_rsvp` / `_claim` / `_carpool` — take the design spec's wording**, which
   ends with the "come back and tap it again" beat (`Potom se sem vrať a klepni na **{response}**
   znovu.`). The rows below omit that sentence and are stale. Because we deliberately build no
   RSVP resume (R2), telling the member what to do next is the whole point of the message — it is
   the difference between a dead end and a two-tap recovery.
2. **`bot_verify_welcome_prompt` — do not create it.** The design spec's table still lists it from
   its earlier draft, where the join-time prompt was a standalone bot message. Task 9 supersedes
   that: for the cohort with no welcome embed we post nothing at join, and Task 10's pinned card
   is their surface (design spec §1.3 agrees). A key with no call site is dead weight.
3. **`bot_welcome_group_field` — do create it**, contrary to design spec §8. That section rules it
   out of scope because `buildWelcomeEmbed` takes no locale; Task 9 already threads `verify_locale`
   into exactly that call, so keying the hardcoded English `Group` costs one argument that is
   being added anyway.

| Key | en | cs |
|---|---|---|
| `bot_verify_button` | `Finish my profile` | `Dokončit profil` |
| `bot_welcome_group_field` | `Group` | `Skupina` |
| `bot_verify_welcome_field_name` | `One more thing 👋` | `Ještě jedna věc 👋` |
| `bot_verify_welcome_field_value` | `Before you can sign up for anything, tell us who you are. Three fields, less than a minute.` | `Než začneš zapisovat účast, řekni nám, kdo jsi. Tři údaje, ani ne minuta.` |
| `bot_verify_blocked_rsvp` | `**We don't know you yet** 👀\n\nBefore you can sign up, finish your profile — name, date of birth and gender. It takes a moment and you only do it once.` | `**Ještě tě neznáme** 👀\n\nNež zapíšeš účast, dokonči si profil — jméno, datum narození a pohlaví. Zabere to chvilku a je to jednou provždy.` |
| `bot_verify_blocked_claim` | `**We don't know you yet** 👀\n\nBefore you can take a training, finish your profile — name, date of birth and gender. It takes a moment and you only do it once.` | `**Ještě tě neznáme** 👀\n\nNež si vezmeš trénink, dokonči si profil — jméno, datum narození a pohlaví. Zabere to chvilku a je to jednou provždy.` |
| `bot_verify_blocked_carpool` | `**We don't know you yet** 👀\n\nBefore you can take a seat, finish your profile — name, date of birth and gender. It takes a moment and you only do it once.` | `**Ještě tě neznáme** 👀\n\nNež se zapíšeš do auta, dokonči si profil — jméno, datum narození a pohlaví. Zabere to chvilku a je to jednou provždy.` |
| `bot_verify_channel_name` | `start-here` | `nez-zacnes` |
| `bot_verify_channel_topic` | `Finish your profile and everything else opens up. Once you do, this channel disappears — that's normal.` | `Dokonči si profil a máš přístup ke všemu ostatnímu. Až to uděláš, kanál ti zmizí — to je v pořádku.` |
| `bot_verify_intro_title` | `Welcome! We don't know you yet 👋` | `Vítej! Ještě tě neznáme 👋` |
| `bot_verify_intro_description` | `Sideline keeps your team's trainings, attendance and rosters in one place. Before you jump in we need three things. Nothing more, and they go nowhere else.` | `Sideline tvému týmu hlídá tréninky, účast a soupisky. Než se do toho pustíš, potřebujeme tři údaje. Nic víc, nikam je neposíláme.` |
| `bot_verify_intro_unlocks_name` | `What this opens up` | `Co se ti tím otevře` |
| `bot_verify_intro_unlocks_value` | `• Signing up for trainings and matches\n• Taking a training as coach\n• Carpool seats` | `• Zapisování účasti na tréninky a zápasy\n• Braní tréninků jako trenér\n• Místa ve spolujízdě` |
| `bot_verify_intro_why_name` | `Why we ask` | `Proč to po tobě chceme` |
| `bot_verify_intro_why_value` | `Your name for the roster, your date of birth for age categories, your gender for mixed line-ups. Only your team sees it.` | `Jméno kvůli soupisce, datum narození kvůli věkovým kategoriím, pohlaví kvůli mixed rozdělení. Vidí to jen tvůj tým.` |
| `bot_verify_intro_footer` | `Takes a moment · after that this channel disappears` | `Zabere to chvilku · potom ti tenhle kanál zmizí` |
| `bot_verify_invalid_date` | `That date doesn't look right. Write it like 24. 8. 2005 or 2005-08-24.` | `Tohle datum nesedí. Napiš ho jako 24. 8. 2005 nebo 2005-08-24.` |
| `bot_verify_too_young` | `Sideline is for ages 6 and up — check the date of birth.` | `Sideline je od 6 let — zkontroluj si datum narození.` |
| `bot_verify_gender_missing` | `Pick one of the three options, then submit again.` | `Vyber jednu ze tří možností a odešli to znovu.` |
| `bot_verify_not_member` | `You're not on this team's roster yet. Try rejoining with the invite link, or give your captain a nudge.` | `Zatím nejsi na soupisce tohoto týmu. Zkus se připojit znovu přes pozvánku, nebo se ozvi kapitánovi.` |
| `bot_verify_guild_not_registered` | `This server isn't connected to Sideline yet. Give your captain a nudge.` | `Tenhle server ještě není propojený se Sideline. Dej vědět kapitánovi.` |
| `bot_verify_unavailable` | `Sideline isn't answering right now. Try again in a minute — nothing was lost.` | `Sideline teď neodpovídá. Zkus to za chvíli znovu — nic se neztratilo.` |
| `bot_complete_gender_label` | `Gender` | `Pohlaví` |
| `bot_complete_gender_description` | `Used for rosters and mixed line-ups.` | `Kvůli soupiskám a rozdělení na tréninku.` |
| `bot_complete_gender_placeholder` | `Pick one…` | `Vyber…` |
| `bot_complete_jersey_description` | `Optional — you can add it later.` | `Nepovinné, můžeš doplnit potom.` |
| `teamSettings_requireCompleteProfile` *(web, vykání)* | `Require a complete profile` | `Vyžadovat dokončený profil` |
| `teamSettings_requireCompleteProfile_help` *(web, vykání)* | `Members without a name, date of birth and gender cannot RSVP, take a training or reserve a carpool seat. They get a button in Discord that walks them through it.` | `Členové bez jména, data narození a pohlaví nemohou zapisovat účast, brát si tréninky ani se zapisovat do aut. V Discordu dostanou tlačítko, které je provede vyplněním.` |
| `rsvp_profileIncomplete` *(web, vykání)* | `Finish your profile before you sign up.` | `Než zapíšete účast, dokončete si profil.` |

### Existing keys whose copy changes (task 6, the modal)

| key | today (cs) | new (cs) | new (en) | why |
|---|---|---|---|---|
| `bot_complete_name_label` | `Jméno` | `Jméno a příjmení` | `Full name` | a roster needs the surname |
| `bot_complete_birth_date_label` | `Datum narození (RRRR-MM-DD)` | `Datum narození` | `Date of birth` | format belongs in the placeholder |
| `bot_complete_birth_date_placeholder` | `2005-08-24` | `24. 8. 2005` | `2005-08-24` | Czech members type Czech dates; pairs with the normaliser |
| `bot_complete_jersey_label` | `Číslo dresu (nepovinné)` | `Číslo dresu` | `Jersey number` | "(nepovinné)" moves into the label `description` |

### Existing keys reused unchanged

`gender_male` / `gender_female` / `gender_other` (the select options and the success summary),
`bot_complete_modal_title`, `bot_complete_name_placeholder`, `bot_complete_jersey_placeholder`,
`bot_complete_invalid_name`, `bot_complete_invalid_jersey`, `bot_complete_no_guild`,
`bot_complete_error`, `bot_complete_success` / `bot_complete_success_with_jersey`,
`bot_rsvp_*` (untouched — see below).

### Delta against the design spec's §6 table, with reasons

These are the only differences; reconcile them in the design spec so the two tables match.

| design-spec key | status here | reason |
|---|---|---|
| `bot_verify_dm_title`, `bot_verify_dm_description` | **dropped** | no DM fallback is built — the read-only channel plus the blocked-action ephemeral cover the cohort |
| `bot_verify_success`, `bot_verify_success_rsvp`, `bot_verify_success_rsvp_failed` | **dropped** | `bot_complete_success` / `bot_complete_success_with_jersey` already ship this, including the `{jersey}` split the design spec asks about; and there is no RSVP resume (R2) |
| `bot_verify_blocked_other` | **replaced** by `bot_verify_blocked_claim` + `bot_verify_blocked_carpool` | the gated set is known and small; a specific first clause beats a generic one |
| `bot_verify_stale` | **dropped** | `profile-verify` carries no state, so no button can go stale |
| `bot_verify_already_done` | **dropped** | the button always opens the modal (a `MODAL` response cannot be deferred, so there is no pre-check); an already-complete member just re-saves, which is what `/dokoncit` does today |
| `bot_verify_gender_prompt` | **deferred** | fallback-only (task 0's three-button path). Add it with the fallback, not before |
| `bot_rsvp_profile_incomplete` | **dropped** | a tykání string does not belong in the vykání `bot_rsvp_*` family; `bot_verify_blocked_rsvp` is the key |
| `bot_verify_intro_unlocks_value`: `• The rest of the server` | **changed** | there is no guild-wide muting, so nothing about "the rest of the server" is gated. The line would be false |
| design spec §5.1's proposed `bot_rsvp_*` flip to tykání | **out of scope** | a separate, tiny diff. This story does not restyle a shipped copy family |

---

## Migrations

| Id | File | Statement |
|---|---|---|
| `1792060000` | `packages/migrations/src/before/1792060000_add_team_settings_require_complete_profile.ts` | `ALTER TABLE team_settings ADD COLUMN IF NOT EXISTS require_complete_profile BOOLEAN NOT NULL DEFAULT false` |

Re-checked against `origin/main` at the time of writing: highest merged id `1792050000`, so
`1792060000` is free. **`1792100000` is reserved** by `.work-plans/series-time-conversion.md:41`.
**Re-take the next free id at merge time** — ids collide silently across branches and the failure
surfaces as `No test files found, exiting with code 1` in the integration suite's `globalSetup`.
`pnpm lint` runs `scripts/check-migration-ids.mjs`, which names both the collision and the next
free id.

No migration for anything else. The unverified role and channel are deliberately persistence-free —
no `teams.verify_channel_id` column (design-spec ask #8 declined): the bot resolves both by name,
which is one less column, one less API field and one less thing to keep in sync with a captain who
deletes the channel.

---

## Risks

| Risk | Mitigation |
|---|---|
| **Mass lockout of the existing `is_profile_complete = false` cohort** — plausibly the majority of every Discord-native roster. | The gate is off by a `DEFAULT false` **DB column**, not a code path, so deploy changes nothing for anyone. Per-team opt-in, one pilot team first, measured with the query above. `PROFILE_GATE_ENABLED=false` is the one-line global revert. |
| `PROFILE_GATE_ENABLED` defaults **on**, so a parser bug enables the gate rather than disabling it. | The per-team column is still `false` for every team, so an enabled global flag blocks nobody. The env unit test pins `''` → `true` and `'banana'` → `true` explicitly. |
| Four new error tags break an un-upgraded bot's decode. | Server-before-bot deploy; flags stay off until both are out. Worst case is the generic `withBackstop` copy, unreachable while every team's setting is `false`. |
| **Discord rejects a mixed action-row + label modal payload.** | Task 0 is a manual spike against a real guild and **nothing is built until it passes**. Two documented fallbacks (all-label modal, then the three-button design), both local to tasks 6–7. |
| Widening `MembershipWithRole` breaks server tests. | 181 references, overwhelmingly `as unknown as` casts and type positions. Expect a handful of strict literals; `pnpm check` names every one. |
| Widening `TeamMemberLookup` forces three ungated SELECTs to carry unread columns. | Accepted: one shared lookup class beats a second near-identical one. |
| Stale `packages/domain/dist` after task 1 → type errors in apps that were never touched. | `pnpm build:packages && pnpm codegen && pnpm check`, in that order. `rm` the `tsbuildinfo` and `tsc -b --force` if it still lies. |
| `GuildsRpcLive`'s top-level `Effect.Do.pipe` is at 19 of 20 arguments. | Task 4 adds **no** repository — `teamSettings` is already bound. Resolve anything new inline instead. |
| Guard ordering regression: a blocked member is told "deadline passed". | Task 2 reorders and pins it; Task 3 case 5 pins it again through the gate. |
| The unverified role is mistaken for a Sideline role and gets mapped. | No `discord_role_mappings` row, ever. That absence is what keeps `reconcileMemberDiscordRoles` inert (CC-8 anti-stripping guard, verified). State it in the file's doc comment. |
| A member completes their profile on the **web** and keeps the unverified channel. | `guildMemberAdd` evaluates both directions idempotently, and modal-submit revokes. Residual: someone who never rejoins and never re-runs `/dokoncit` keeps a cosmetic read-only channel. Named `ponytail:` ceiling; upgrade is a nightly sweep *if observed*. |

## Build notes

* Task 1 touches `packages/domain/` and `packages/migrations/` → `pnpm build` before anything in
  tasks 2–10 will type-check.
* Task 5 and every i18n change → `pnpm codegen` (route tree, i18n registry, index barrels).
* Before pushing: `pnpm build:packages && pnpm codegen && pnpm check && pnpm lint`.
* Integration tests need Docker and a prior `pnpm build` (the migrations package must be compiled,
  or a deleted/renamed migration keeps running out of a stale `dist/`).
* Run your own slice locally; the full integration suite is too large for one machine and dies on
  the container, not on your diff.

---

## Deliberately NOT building

1. **Guild-wide muting of unverified members.** Not expressible as a Discord role — guild-level role
   permissions are additive only — so it means a deny overwrite on every channel that exists or will
   ever exist. Unbounded surface over channels Sideline does not own, no backout. The enforcement
   the story asks for lives in Deliverable A.
2. **Inverting `teams.onboarding_rules_role_id`** (D2). Captain-typed opaque id, unset for most
   teams, granted only when Discord membership screening is on, and un-revertible. Full reasoning
   above; it is also the answer to design-spec ask #7 — the two gates are never stacked.
3. **Gating poll voting.** A poll vote has no roster-integrity consequence — nobody plans a training
   around it — and a poll is the cheapest possible first interaction for someone who just arrived.
4. **Gating `/rules` quiz attempts.** Same reason, more so: the quiz is a zero-stakes way for a
   newcomer to poke at the bot. Blocking it is pure hostility with no upside.
5. **Gating any read path** — `getRsvps`, `GetCarpoolView`, every embed, every `/` command that only
   displays. Reading the roster is how a newcomer works out whether they are in the right place.
6. **Gating `Carpool/LeaveCarpool`, `Carpool/RemoveCar`, `Event/UnclaimTraining`.** Un-blocking
   actions must always work; gating them would trap an incomplete member in a car or a training.
7. **Resuming the blocked RSVP after verification.** The member re-taps the button: one tap, no
   pending-intent store, no `pvr:` prefix, no 90-of-100-character `custom_id`, and no "profile
   saved, RSVP not saved" failure mode when the modal outlives its interaction token. The blocked
   copy must not promise a resume.
8. **A backfill or sweep over existing incomplete members.** No role grants, no DM campaign, no
   `is_profile_complete` recompute. The absence of a backfill *is* the anti-lockout property.
9. **A DM fallback at join time** (design spec §1.3 step 3). `50007` handling, best-effort delivery
   and a guild id in the `custom_id`, to reach a strictly smaller cohort than the read-only channel
   already reaches. Add it if the pilot shows the channel is not enough.
10. **A new Discord invite-minting path.** "uzivatel dostane discord link" already works — a captain
    pastes any plain guild invite and `Guild/RegisterMember` does the rest. The per-acceptance
    one-use invite machinery stays exactly as it is, for the web `/invite/` flow only.
11. **A `teams.verify_channel_id` column** (design-spec ask #8). The bot resolves the channel by
    name; a column would add an API field, a settings form control and a sync problem.
12. **A per-team template for the info-channel embed.** The captain's voice already has `#welcome`.
    Add it when a captain asks.
13. **A `ProfileGateConfig` service.** `DiscordJoinEnforcementConfig` exists only because
    `auth.myTeams` needed a test override for a module-load-time env read; here the per-team column
    is the testable lever, so a module-level constant is enough and 60 test files stay untouched.
14. **A branded `ProfileGateOk` capability token** forcing the four writers through the guard at the
    type level. `gatedWriters.test.ts` catches the fifth writer at a fraction of the cost. Named as
    the escalation if that test ever starts failing for real reasons.
15. **Flipping the `bot_rsvp_*` family from vykání to tykání** (design spec §5.1). A real
    inconsistency, a separate tiny diff, and scope creep here.
16. **Re-planning the web→Discord direction.** `.work-plans/discord-onboarding-fix-plan.md` and
    `discord-connect-enforcement-design.md` are already fully implemented (PR-1..PR-9,
    `ConnectDiscordPage`, `DiscordConnectCard`, snooze, manual role sync). Untouched.
