# Discord onboarding fix — revised implementation plan (architect, rev 3)

Bug: "Nefunguje discord onboarding pres webapp" (Notion 3ba93506-0818-800b-9245-c490b422dec3)
Companion design: `.work-plans/discord-connect-enforcement-design.md` (UX spec)

**Rev 3 changelog.** Rev 2 was reviewed and returned BLOCK on PR-3, PR-5, PR-6, PR-7, PR-8. The scope
is still complete — nothing is dropped. What changed:

- A new **CC-0** names the class of bug that produced three of the five blockers: *a first failure is
  terminal, with no retry*. Every instance is fixed, and no PR is allowed to add a fourth.
- **PR-3 shrinks.** Transient Discord failures (429 / network / 5xx) no longer write a terminal error
  code; the row stays open and the next poll retries. `welcome_channel_missing` becomes re-openable
  once a captain sets the welcome channel.
- The **backlog sweep moves to an explicit pre-deploy step** (blocker 3): un-filtering and sweeping in
  the same release races the 20-invites-per-second `fastPollLoop`. The cron stays as a backstop only.
- **The regenerate endpoint now exists** (blocker 1, designer open question 3 — answered in CC-14).
  It is the same code path as PR-4's idempotent re-join, and it lands in PR-5, not "PR-5/PR-9".
- **Expiry moves from `errorCode` to `state`** (blocker 4), so PR-5's copy is true the day it ships
  and CC-3 collapses from four releases to three.
- **PR-6 stops being blind.** Candidate roles are read from `DiscordREST` in the bot (permissions +
  the bot's own top position are both visible there), adoption requires `permissions === '0'`, and
  collisions take the **lowest** position, not the highest.
- **PR-7 actually fixes root cause D** — `role.ts` gains the four missing `emit*` calls. Without them
  all nine PRs still leave a captain's role assignment un-propagated. `removedCount` becomes a real
  number, computed against `discord_role_mappings`.
- **PR-8 becomes level-based** (blocker 8). A periodic diff of desired-vs-actual Discord roles
  replaces the one-shot transition gate, which makes the pipeline self-healing, subsumes removal, and
  subsumes the bulk backfill action that no PR was shipping.
- Rollback SQL that was permanently destructive (PR-4) or permanently jamming (PR-8) is corrected.

Read `## Cross-cutting decisions` before starting any PR. **PR-1 is approved and being implemented;
its steps are byte-for-byte unchanged from rev 2** — the only addition is one measurement note in its
rollout section, required by blocker 3.

---

## Part 0 — Flow disambiguation (unchanged)

`OnboardingPage.tsx` is **NOT** the flow in this bug. It is captain/team provisioning:
`applications/web/src/routes/onboarding.$token.tsx` loads a one-time team onboarding token
(`previewOnboardingToken`); its two steps are "name the team" + "pick your guild and invite the bot"
(`OnboardingPage.tsx:77` builds `.../oauth2/authorize?...scope=bot%20applications.commands`).
It ends by calling `completeOnboarding`, which creates a team. A normal member never sees this page.

**The member-facing flow is the invite flow:**

1. `applications/web/src/routes/invite.$code.tsx` → `InvitePage` → `joinViaInvite`
2. On success, `invite.$code.tsx:31` writes `pending-discord-join` to **localStorage**
3. `applications/web/src/components/organisms/PendingDiscordJoinBanner.tsx` reads that key and polls
   `invite.getJoinStatus` every 2s for `discordInviteUrl`
4. The banner is rendered exactly once, at `applications/web/src/components/layouts/AuthenticatedLayout.tsx:128`,
   and `AuthenticatedLayout` is mounted from exactly one route:
   `applications/web/src/routes/(authenticated)/teams/$teamId/route.tsx:61`

That ephemeral banner is the **only** place in the entire webapp where a member can ever see a Discord link.
Commit `40b33ef2` removed the captain-facing "Copy Discord link" affordance too.

---

## Part 1 — Verified root cause (unchanged, still the basis of PR-1..PR-5)

### Root cause A (primary): the invite-generator query silently excludes most teams

`applications/server/src/repositories/InviteAcceptancesRepository.ts:73-92`:

```sql
FROM invite_acceptances ia
JOIN team_invites ti ON ti.id = ia.team_invite_id
JOIN teams t         ON t.id = ti.team_id
JOIN bot_guilds b    ON b.guild_id = t.guild_id
WHERE ia.discord_code IS NULL
  AND ia.discord_code_error_code IS NULL
  AND t.welcome_channel_id IS NOT NULL     -- line 87
  AND b.is_community_enabled = true        -- line 88
```

This is the only producer of `invite_acceptances.discord_code`, consumed by the bot at
`applications/bot/src/rcp/inviteGenerator/ProcessorService.ts` (which calls `createChannelInvite`).

Two rows-disappear-forever conditions:

1. **`b.is_community_enabled = true`** — set from `guild.features.includes('COMMUNITY')`
   (`applications/bot/src/events/guildCreate.ts:22`, `applications/bot/src/events/ready.ts:58`).
   Most club Discord servers are NOT Community servers; the column defaults to `false`
   (`packages/migrations/src/before/1747000000_add_onboarding_columns.ts:19`). Community is a hard
   precondition for `PUT /guilds/{id}/onboarding`; it is **not** a precondition for
   `POST /channels/{id}/invites`. This predicate was copy-pasted from the native-onboarding feature.
2. **`t.welcome_channel_id IS NOT NULL`** — the onboarding wizard makes the welcome channel optional
   (`OnboardingPage.tsx:66` declares `welcomeChannelId: Schema.String` with no min-length check;
   `OnboardingPage.tsx:337` defaults it to `''`). The deprecated `auth.createTeam` path hard-codes
   `welcomeChannelId: Option.none()`.

Because these are **filters, not failure paths**, the acceptance row never gets a `discord_code`
**and never gets a `discord_code_error_code`**. `getJoinStatus`
(`applications/server/src/api/invite.ts:128-146`) therefore returns
`discordInviteUrl: None, errorCode: None` forever, and the banner sits on its
"Preparing your Discord invite..." branch indefinitely — no error, no timeout, no link.
That is verbatim "uzivatelum se link neukaze".

Corroborating evidence this is a mistake, not intent: `packages/domain/src/models/Onboarding.ts:23-32`
defines error code `'welcome_channel_missing'` that **no code path can produce**, precisely because the
SQL filters those rows out instead of failing them. Design intended select-then-fail; implementation
does filter-and-vanish.

### Root cause B (compounding): the automatic guild-join pipeline is dead code

`pending_guild_joins` is a complete, wired pipeline — repository, RPCs
(`Guild/PendingGuildJoins` / `MarkGuildJoinDone` / `MarkGuildJoinFailed` at
`applications/server/src/rpc/guild/index.ts:518-529`), and a bot processor calling `addGuildMember`
with the user's OAuth token (`applications/bot/src/rcp/guildJoin/ProcessorService.ts`).
It adds the user to the guild with **no link at all**.

**Nothing calls `enqueue`.** `enqueue` is defined at `PendingGuildJoinsRepository.ts:76` and called
from zero production sites. `requeueFailedForUser` is called from `auth.ts:172`, requeuing rows that
can never exist.

Git history pins the regression:
- `9af6d3c9` had `Effect.tap(({ user, invite }) => pendingGuildJoins.enqueue(user.id, invite.team_id))` in `joinViaInvite`
- `74223840` guarded it behind `requiresReauth`
- **`bdc0b0ed`** ("feat: discord native onboarding") deleted it
- `40b33ef2` replaced the approach with the per-acceptance link + banner — the one Root Cause A breaks

We regressed from "user is auto-joined to the guild" to "user is shown a link", then broke the link.

### Root cause C (secondary, narrower): the re-auth dead end

`InvitePage.tsx:38` — when `result.requiresReauth` is true, `onJoined` is never called, so
`setPendingDiscordJoin` never runs and the banner never appears. But `joinViaInvite` already created
the membership before computing `requiresReauth` (`invite.ts`, `Effect.bind('membership', ...)`
precedes `Effect.let('requiresReauth', ...)` at line 99). The "Re-authorize" button calls
`handleSignIn` → `getLogin()` → `doLogin`, whose `redirectUrl` is hard-coded to `env.FRONTEND_URL`;
the user returns through `/` → pending-invite redirect → `/invite/:code` → clicks Join →
**`AlreadyMember` 409**. Permanent dead end.

Narrower because `doLogin` requests `guilds.join` up front and `handleDiscordLogin` does a one-shot
scope retry (`buildScopeRetryRedirect`), so most users have the scope. Users who declined once, or
whose stored connection predates the scope, land here.

### Root cause D (part 3 of the report): the server has never emitted a single role sync event

`applications/bot/src/rcp/role/handleAssigned.ts` → `ensureMapping` → `addGuildMemberRole` is complete
and correct. `emitRoleAssigned` / `emitRoleUnassigned`
(`applications/server/src/repositories/RoleSyncEventsRepository.ts:116,132`) have **zero production
callers** — verified: `applications/server/src/api/role.ts` `assignRole` (line 197) writes
`member_roles` and a notification, and never touches `role_sync_events`. The bot's role loop has been
polling an empty table since it shipped. This is why `discord_role_mappings` is also empty
(its only writer is `Role/UpsertMapping`, reached only from `createGuildRole`, reached only from
`ensureMapping`, reached only from a role event) — see B3 / PR-6.

### Confidence

**High confidence on A** (pure code read: predicates are unconditional, the "preparing" state is
terminal, and the unreachable `welcome_channel_missing` code proves intent diverged from
implementation). **Certain on B and D** (no caller exists; the git hunk is explicit).

Discriminating production queries — **run these before PR-3** to size the backfill cohort:

```sql
-- A: acceptances stuck with neither code nor error
SELECT count(*) FROM invite_acceptances
WHERE discord_code IS NULL AND discord_code_error_code IS NULL;

-- A, split by which predicate killed it, and by age bucket (drives the PR-3 cohort decision)
SELECT (t.welcome_channel_id IS NULL) AS no_welcome,
       COALESCE(b.is_community_enabled, false) AS community,
       (b.guild_id IS NULL) AS bot_absent,
       width_bucket(extract(epoch from now() - ia.created_at) / 86400, 0, 90, 6) AS age_bucket,
       count(*)
FROM invite_acceptances ia
JOIN team_invites ti ON ti.id = ia.team_invite_id
JOIN teams t ON t.id = ti.team_id
LEFT JOIN bot_guilds b ON b.guild_id = t.guild_id
WHERE ia.discord_code IS NULL AND ia.discord_code_error_code IS NULL
GROUP BY 1, 2, 3, 4 ORDER BY 4;

-- C: how many members lack guilds.join
SELECT count(*) FROM oauth_connections
WHERE provider = 'discord' AND granted_scopes NOT LIKE '%guilds.join%';

-- D: proof the role pipeline has never run
SELECT count(*) FROM role_sync_events;          -- expect 0
SELECT count(*) FROM discord_role_mappings;     -- expect 0
```

Also grep bot logs for `invite_generator_total{status=...}` — near-zero while acceptances accumulate
confirms A outright.

**Not confirmed:** that users simply never reach `/teams/$teamId` while the banner is alive. Noted as
a real design fragility (link lives only in localStorage, is dismissible, expires in 24h, absent from
`/profile/complete` — the exact page a newly invited user lands on) but not claimed as the production cause.

---

## Cross-cutting decisions

These settle every contradiction between rev 1, rev 2 and the UX spec. Do not re-decide them per PR.

### CC-0 — No first failure is terminal. This is the class of bug, not three instances of it.

Rev 2 shipped three independent places where one transient error permanently strands a user. They
are the same bug and they get the same rule.

| Where | How it goes terminal | Fixed in |
|---|---|---|
| `invite_acceptances.discord_code_error_code` | `findPending` (`InviteAcceptancesRepository.ts:82`) excludes **any** row with an error code, and `errorClassifier.ts:29-43` writes `rate_limited` / `network_error` into that column. `ClassifiedError.retry_after` is computed at line 31 and thrown away. | PR-3 |
| `role_sync_events` | `Role/MarkEventFailed` sets `processed_at = now()` (`RoleSyncEventsRepository.ts:79`) while `findUnprocessed` selects `WHERE processed_at IS NULL` (line 63). One 429 and the event is gone forever. | PR-8 |
| `team_members.discord_joined_at` | Rev 2's one-shot `NULL → set` transition gate: the timestamp is consumed once; if emission is suppressed on that tick, nothing ever re-fires. | PR-8 |

**The rule, binding on every PR in this plan:**

1. **A failure is either transient or terminal, and the classifier must say which.** Transient
   failures (`rate_limited`, `network_error`, Discord 5xx, `RpcClientError`) must never be written to
   a column that a "find work to do" query excludes on.
2. **A terminal code must be re-openable when its cause is fixable by a human.**
   `welcome_channel_missing` is fixable — the welcome channel is settable in the web UI
   (`TeamSettingsPage.tsx:479` → `updateTeamInfo` `welcomeChannelId`). So the row must re-open when
   `teams.welcome_channel_id` becomes non-null. `bot_not_in_guild` is likewise fixable (re-invite the
   bot) but is left terminal-with-a-regenerate-button because re-opening it needs a join across
   `bot_guilds` that changes rarely; the regenerate primitive (CC-14) covers it.
3. **Prefer a level-based trigger to an edge-based one.** Where the desired state is computable
   (member's effective Sideline roles vs. their actual Discord roles), a periodic diff is
   self-healing by construction and needs no retry counter. Where it is not, use a bounded retry with
   backoff — never a single shot.
4. **Every "leave it open and retry" path needs a bounded backstop** so a permanently broken row
   cannot be polled forever at 1 Hz. The backstop is an age sweep that writes a *terminal* code
   (CC-4), never a filter.

### CC-1 — The bot is the decoder. Deploy order is expand → contract, never "server first".

`Invite/PendingAcceptances` (`packages/domain/src/rpc/invite/InviteRpcGroup.ts:10-17`) declares
`welcome_channel_id: Discord.Snowflake` — **non-nullable**. The server encodes, the **bot decodes**.
`SqlSchema.findAll` returns a `Schema.Array`, so one row with `welcome_channel_id: null` fails the
decode of the **whole batch** and invite generation stops for **every team** until the bot is
upgraded. "Ship server before bot" is therefore backwards and is deleted from this plan.

The rule for every wire change in this plan:

1. **Release A (expand)** — widen the schema in `packages/domain` and ship it to *all* consumers.
   The producer keeps emitting only legacy-compatible values.
2. **Release B (contract)** — the producer starts emitting the new values.

`docs/deployment.md` §6.3: all apps are normally tagged at one shared version and released as a
matrix, but the containers do **not** start atomically, and deployed **web bundles in users'
browsers** are arbitrarily old. Every schema a browser decodes needs the projection treatment
(CC-3), not just a shared release.

**Verifying "the bot is on version X" — use `/api/version` on the server, not `/info` on the bot.**
The bot re-reports its version to the server every 5 minutes via `BotInfo/ReportBotInfo`
(`applications/bot/src/Bot.ts:110-134` — the comment there explains exactly why: a single boot-time
report decays to `"bot":"unknown"` the next time the server restarts, and that has already produced a
false-green deploy in this repo). `GET /api/version` is the surface a deploy is verified against; it
is the one PR-3's gate names.

### CC-2 — `is_community_enabled` comes out first, on its own, with zero wire change.

Dropping `AND b.is_community_enabled = true` requires no schema change at all (the inner
`JOIN bot_guilds` and `welcome_channel_id IS NOT NULL` both stay, so nothing new reaches the wire).
It is the P0 and it is PR-1. Everything else queues behind it.

### CC-3 — `InviteGeneratorErrorCode` is a stored enum read by browsers. Expiry is a **state**, not an error code.

`invite_acceptances.discord_code_error_code` is plain `TEXT`
(`packages/migrations/src/before/1747300000_invite_acceptances.ts:11`) and is surfaced to the web as
`Invite.JoinStatus.errorCode`. Adding a literal and writing it before every browser bundles the
widened set fails the decode of `getJoinStatus`. `packages/domain/AGENTS.md:73` documents the
required pattern; precedent is `EventRsvpApi.ts:15` `LegacyRsvpResponse` +
`applications/server/src/utils/rsvpWireProjection.ts`.

**Rev 2 got the schedule wrong** and the review caught it: the projection is applied at the
`getJoinStatus` **read boundary**, so un-pinning the *client* schema in PR-5 changes nothing — the
server still emits `'unknown'` until PR-9 deletes the projection. PR-5's error-specific copy, PR-5
test 14 and CC-5's "renders as §4.2(a)" would all have been false between PR-5 and PR-9, and the
component tests would have passed anyway because they mock props. Corrected:

**Expiry is carried by `JoinStatus.state`, and `'expired'` never appears on `JoinStatus.errorCode` —
not in PR-5, not in PR-9, not ever.**

- The **stored** enum `Onboarding.InviteGeneratorErrorCode` gains `'bot_not_in_guild'` and
  `'expired'` in PR-2. It must, because the DB column holds those strings and
  `InviteAcceptance.InviteAcceptance` (a `SELECT *` decode) and `Invite/MarkAcceptanceFailed` both
  read it. This union is decoded only by the server and the bot.
- The **client-facing** union is a separate, narrower literal set on `Invite.JoinStatus.errorCode`.
- `projectInviteErrorToWire` returns an **`Option`**: `'expired' → Option.none()` (permanently — the
  state says it), `'bot_not_in_guild' → Option.some('unknown')` until PR-9, identity otherwise.
- `JoinStatus.state` gains `'expired'` in PR-5:
  `Schema.Literals(['preparing','ready','failed','expired','joined'])`. A browser on an older bundle
  has no `state` key in its schema at all and `Schema.Struct` ignores excess properties, so shipping
  `state: 'expired'` to it is inert — it keeps reading `discordInviteUrl` + `errorCode` exactly as
  today.

Three releases instead of four:

| Release | Domain | Server | Effect |
|---|---|---|---|
| PR-2 (A) | `InviteGeneratorErrorCode` gains both literals. New `JoinStatusErrorCode` pins `JoinStatus.errorCode` to the original 8. | new `applications/server/src/utils/inviteErrorWireProjection.ts`, applied at the `getJoinStatus` read boundary. | Server & bot bundle the widened stored enum; browsers see only the 8. |
| PR-3 (B) | — | bot begins writing `bot_not_in_guild`; the pre-deploy sweep + cron write `expired`. | Projection absorbs both. |
| PR-5 (C) | `JoinStatus.state` gains `'expired'`. `errorCode` stays pinned. | populate `state`. | New browsers get the §4.2(a) copy **immediately**, from `state`. |
| PR-9 (D) | `JoinStatusErrorCode` gains `'bot_not_in_guild'` only. | projection keeps the `'expired' → None` collapse; drops the `bot_not_in_guild` mapping. | Full fidelity, and `errorCode` never carries a non-error. |

`Invite/MarkAcceptanceFailed.error_code` travels **bot → server**; the server must bundle the widened
stored enum before the bot sends a new value. PR-2 ships it to both; PR-3 turns on emission.

**Rev 2's "PR-5 un-pins `errorCode`" step is deleted.** It was a no-op that read like a behaviour
change (over-engineering cut, review §"Over-engineering to cut").

### CC-4 — There is no age *filter*. Aged rows get a terminal error code. One window constant, shared.

An `AND ia.created_at > now() - interval '7 days'` predicate is the same filter-not-failure-path bug
we are fixing: on day 8 the row silently stops being selected, never gets an error code, and the UI
hangs forever. Instead:

- **Server-side sweep (authoritative, PR-3):** an idempotent `UPDATE` that sets
  `discord_code_error_code = 'expired'`, `discord_code_error_detail = 'aged out before generation'`,
  `generated_at = now()` on rows where `discord_code IS NULL AND discord_code_error_code IS NULL AND
  created_at < now() - interval '<N> days'`. **Never touches `created_at`.**
- **Derived guard (defensive, PR-5):** `getJoinStatus` also derives `state: 'expired'` when the row is
  older than the window and still has neither code nor error, so the UI can never hang even if the
  sweep is not running.

**The two must not disagree visibly.** The sweep is a daily cron; the derived guard runs on every
2-second poll. If they use the same window, a row crosses the derived boundary up to 24 hours before
the sweep writes it, and a user who reloads sees `'expired'`, then `'preparing'` again if any code
path re-reads a stale value. Binding rule:

```ts
// applications/server/src/utils/inviteExpiry.ts  (new, PR-3)
export const INVITE_ACCEPTANCE_SWEEP_DAYS = 3;
export const INVITE_ACCEPTANCE_DERIVED_EXPIRY_DAYS = INVITE_ACCEPTANCE_SWEEP_DAYS + 1;
```

Both the sweep (PR-3) and the derived guard (PR-5) import from this one module. The derived window is
**strictly larger**, so the sweep always wins the race and the UI never flips backwards. A unit test
asserts `DERIVED > SWEEP`.

### CC-5 — The backfill is non-destructive and *closes* rows; it does not resurrect them.

`UPDATE invite_acceptances SET created_at = now() WHERE ...` (rev 1) is rejected: it rewrites audit
timestamps and would mint a `max_age: 86400, max_uses: 1` invite in **every** guild for **every** user
who ever accepted — most of whom joined months ago. The sweep instead closes the entire stuck backlog
to `'expired'` (CC-4), which PR-5 renders from `state: 'expired'` as the designer's §4.2(a)
"We need a fresh invite" + **"Get a new invite"** — a button that now has a real endpoint behind it
(CC-14). Only genuinely recent rows (`INVITE_ACCEPTANCE_SWEEP_DAYS`, default 3) are left open to be
picked up naturally by the now-unblocked `findPending`.

**The sweep runs as a pre-deploy step, not as a startup cron (blocker 3).** See PR-3 step 0 — this is
the single most important sequencing change in rev 3.

### CC-6 — The link is the designed fallback for auto-join, not a redundancy to be dropped.

Two mechanisms get a user into the guild and **both stay**:

- `pending_guild_joins` → `PUT /guilds/{id}/members/{user}` with the user's OAuth token (silent, best UX)
- the one-time `discord.gg` link from `invite_acceptances.discord_code` (works without `guilds.join`)

**S2 — OAuth access tokens are never refreshed.** `oauth_connections.access_token` is written only at
login (`applications/server/src/api/auth.ts:150-160`); there is no refresh flow anywhere in the repo.
Discord access tokens expire in ~7 days; sessions last 30 (`auth.ts` `DateTime.add(now, { days: 30 })`).
So auto-join **will** 401 for any session older than a week. Consequences, binding on PR-4/PR-5:

- The link must render whenever it exists, **including** when the guild-join row is `failed`. A
  failed `pending_guild_joins` row is **not** an error state in the UI — it silently degrades to the
  link. Never gate part 2 (part 3 of the report) on auto-join succeeding.
- A token-refresh flow is out of scope for these nine PRs. File it separately — **and record these
  two facts in the ticket so nobody re-derives them:** (a) the refresh token is *already stored*.
  `auth.ts:158` writes `Option.fromNullishOr(oauth.refreshToken())` into
  `oauth_connections.refresh_token`; the column has existed since
  `packages/migrations/src/before/1742200000_extract_oauth_connections.ts:13`; the model exposes it as
  `Model.Sensitive(Schema.OptionFromNullOr(Schema.String))`
  (`packages/domain/src/models/OAuthConnection.ts:20`). (b) It has **never been read** — grep for
  `refresh_token` across `applications/server/src` returns only the four write sites in
  `OAuthConnectionsRepository.ts`. A refresh flow is therefore one repository read plus one
  `POST /oauth2/token` call, not a new subsystem.

**S3 — both mechanisms share one permission.** `PUT /guilds/{id}/members/{user}` requires the bot to
hold `CREATE_INSTANT_INVITE` in the guild — the *same* permission whose absence
`classifyInviteGeneratorError` maps to `bot_missing_perms` for `POST /channels/{id}/invites`. A guild
that has stripped it loses **both** paths at once. Surface it once, in the `bot_missing_perms` copy
(designer §5.4 `discord_connect_error_botPerms`), and do not model it as two independent failures.

**S4 — `enqueue` fires only from an explicit Join click, or an explicit regenerate click.** Never from
a background job, never from `Guild/ReconcileMembers`. A user who deliberately left a guild must not
be silently re-added.

**S5 — `requeueFailedForUser` never fires for the dominant failure mode.** `auth.ts:165-172` gates the
requeue on a *scope transition* (`hasScopeNow && !hadScopeBefore`). But the dominant auto-join
failure is a **401 on an expired access token**, and that user already had `guilds.join` — so the
transition is false and the requeue never runs, on the exact login that just minted a fresh token.
Fix in PR-4: requeue when the scope is newly granted **or** whenever a fresh access token is written
and the user has at least one `failed` row. Cheapest correct form: drop the transition condition and
call `requeueFailedForUser` on every successful callback where `hasScopeNow` is true — the query is
`WHERE user_id = ... AND status = 'failed'`, it is a no-op when there is nothing to requeue, and it
respects S4 because only the user's own Join click could have created those rows.

### CC-7 — Waking the role queue must not create duplicate Discord roles, and must not grant admin.

`applications/bot/src/rest/roles/ensureMapping.ts:21` falls back to `createGuildRole` on a mapping
miss, and `applications/bot/src/rest/roles/createGuildRole.ts:16` calls
`rest.createGuildRole(guildId, { name: roleName, permissions: 0 })` **unconditionally, with no lookup
of existing guild roles by name**. `discord_role_mappings` is empty in production (root cause D). So
the first emission would give every team brand-new zero-permission roles named "Captain"/"Player"
beside their real ones, and assign members to the empty duplicates.

Rev 2's fix — name-match against `discord_guild_roles` via `Guild/ListGuildRoles` — was **blocked**,
for two reasons that both come from the same omission:

- **Privilege escalation.** `discord_guild_roles` has no `permissions` column
  (`packages/migrations/src/before/1747000000_add_onboarding_columns.ts:21-32`) and neither
  `Guild/SyncGuildRoles` nor `Guild/ListGuildRoles` carries one
  (`packages/domain/src/rpc/guild/GuildRpcGroup.ts:184-195` is `{id, name, color, position, managed}`).
  A guild whose existing `Captain` role carries `ADMINISTRATOR` would get that role adopted, and
  `handleAssigned.ts` → `addGuildMemberRole` would then hand guild admin to every `role:manage`
  holder. `createGuildRole.ts:16` deliberately creates with `permissions: 0`; adoption must not throw
  that guarantee away.
- **Hierarchy.** "Take the highest `position`" maximises the chance of picking a role **above the
  bot's own top role**, which Discord rejects with `50013` on assignment — and (CC-0) that failure was
  terminal.

**Decision: PR-6 stays bot-only, and reads candidates from `DiscordREST`, not from the RPC.**
`rest.listGuildRoles(guildId)` returns `GuildRoleResponse` including `permissions: string` and
`position: number`, and `rest.getMyGuildMember(guildId)` returns the bot's own `roles` — from which
the bot's top position is one `max`. Neither needs a migration, an RPC change, or a wire change, so
"bot-only" survives. Adoption requires **all** of:

1. `name` matches exactly (case-sensitive, no trim),
2. `managed === false`,
3. `permissions === '0'` — a strict string compare against the zero bitfield, not a mask test,
4. `position < botTopPosition`,

and among survivors takes the **lowest** `position` (furthest below the bot), logging a warning when
more than one matched. Anything else falls through to `createGuildRole`, which is safe by
construction.

PR-6 merges **before** anything can emit (PR-7, PR-8), and ships a report-only pass first.

### CC-8 — Part 3's result contract: ship it once, in PR-7.

Rev 1's `{rolesQueued, groupsQueued, skippedNoDiscordLink}` and the designer's §5.4
`"{added} added, {removed} removed"` + polled `roleSyncState` + `lastRoleSyncAt` + a 9-code
`DiscordSyncErrorCode` are two different contracts. Rev 2 resolved this by shipping
`SyncRoleMembersResult` in PR-7 and replacing DTO + copy + i18n in PR-9. **That is a wire migration
for zero existing clients** — `role_sync_events` and `discord_role_mappings` are both empty, and no
user has ever seen a role-sync result. Settled instead:

- **PR-7 ships the final shape once.** `RoleApi.SyncMemberRolesResult` with the fields PR-9 needs:
  `addedCount`, `removedCount`, `skippedCount`, plus
  `lastRoleSyncAt: Schema.OptionFromNullOr(Schema.DateTimeUtc)` and
  `roleSyncState: Schema.Literals(['queued','ok','failed','never'])`. Fidelity fields the classifier
  has not landed yet are `Option.none()` / `'queued'` in PR-7; PR-9 fills them in **without touching
  the DTO, the copy, or the i18n keys**.
- **`removedCount` is a real number from PR-7 on** (blocker 6). It is not "0 until later" — a
  structurally-always-zero field with "{removed} removed" copy is a lie the UI would tell forever.
  It is computed server-side without any Discord call: the member's mapped-but-not-effective roles
  (`discord_role_mappings` for the team minus the member's effective Sideline roles), each of which
  gets a `role_unassigned` event.
- **Counts are queue semantics and the copy must say so.** This matches the established meaning in
  `group.ts:1040-1047`. One key, `discord_syncQueuedResult` — "Queued {added} additions and {removed}
  removals." — from PR-7 onward. PR-9 does **not** replace it.
- **`DiscordSyncErrorCode` ships as four buckets, not nine** (over-engineering cut). With retries in
  place (CC-0) `rate_limited` and `discord_unavailable` are no longer user-visible at all, and the
  remaining nine codes collapse to three actionable ones plus a fallback:
  `retryable` (we will retry; nothing for you to do) / `captain_action` (bot missing permission, role
  hierarchy, guild not configured) / `user_action` (not in the guild / left the guild) / `unknown`.
  Expand the union only when there is a distinct remedy behind each new code.

### CC-9 — Notification enum widening is a rolling-deploy break, not a cheap add.

`packages/domain/src/models/Notification.ts:9-14` is a `Schema.Literals` decoded by the deployed web
bundle; `notifications.type` is plain `TEXT`
(`packages/migrations/src/before/1740960000_create_notifications.ts:12`). Writing
`'discord_connect_pending'` before every client bundles the widened set fails the decode of the whole
notification **list**, not just the new row. Same pattern as CC-3. Decision: **defer to PR-9** and
implement it there as a two-release expand/contract with wire-value projection. If PR-9 is
time-boxed, **drop it** — the designer marks it optional for v1.

### CC-10 — Role sync is **level-based**. There is no one-shot gate, and `source` distinguishes "absent" from "reconcile".

Rev 2 built two edge gates (a `NULL → set` transition on `discord_joined_at`, and a `source !==
'reconcile'` check) to stop `Guild/ReconcileMembers` flooding the queue on every gateway connect.
Both are removed. They created blocker 7 (a rollout window where a real join is misread as a
reconcile, consumes the timestamp, suppresses the emission, and strands the member **permanently**)
and blocker 8 (no self-healing after any transient failure).

**The replacement is a diff.** Both `Guild/ReconcileMembers` and `Guild/RegisterMember` already carry
the member's **actual Discord role ids** — `roles: Schema.Array(Schema.String)` at
`packages/domain/src/rpc/guild/GuildRpcGroup.ts:88` and `:101`. The server therefore has ground truth
and can emit **only the difference** between:

- **desired** = the member's effective Sideline roles (`member_roles` ∪ group-inherited) mapped
  through `discord_role_mappings`, and
- **actual** = the `roles` array on the payload, restricted to ids present in
  `discord_role_mappings` for that team (never touch roles Sideline does not manage).

Properties this buys, for free:

- **No flood.** In steady state the diff is empty, so a gateway reconnect emits **zero** events —
  a stronger guarantee than the transition gate, and it holds on *every* reconnect, not just the
  first one after the migration.
- **Self-healing (blocker 8).** A `role_sync_events` row lost to `MarkEventFailed` is simply
  re-derived on the next pass. No `attempts` column, no backoff schedule, no dead-letter queue.
- **Removal is free** (CC-8 / blocker 6) — it is the other half of the same diff.
- **The bulk backfill action is free** (designer `design.md:610`) — the first pass over a guild *is*
  the backfill, and no PR has to ship a separate bulk endpoint.
- **Pre-existing members are covered.** Rev 2 backfilled `discord_joined_at` silently and left every
  pre-existing member outside both triggers. A diff has no concept of "pre-existing".

`team_members.discord_joined_at` is still added in PR-8, but its **only** job is PR-9's tri-state
("have we ever observed this user in this guild"). It no longer gates emission, so writing it is
idempotent and consuming it is impossible.

**`source` becomes a tri-state, and absence is not `'reconcile'` (blocker 7).**

```ts
source: Schema.OptionFromOptionalNullOr(Schema.Literals(['member_add', 'reconcile', 'interaction'])),
```

`Option.none()` means *unknown* — an un-upgraded bot. On `None`: do **not** set `discord_joined_at`
and do **not** run the diff; log at debug and return. `Guild/ReconcileMembers` supplies
`'reconcile'` explicitly server-side, so `None` can only come from a bot older than PR-8, and the
member is picked up on the next reconcile from an upgraded bot. Rev 2's
`withDecodingDefaultKey(() => 'reconcile')` is deleted: it made absence indistinguishable from a real
reconcile, which is precisely what stranded the member.

**S6 — the reconcile backfill still cannot detect truncation.** `guildCreate.ts:70` calls
`rest.listGuildMembers(guild.id, { limit: 1000 })` — one page, no `after` cursor. A guild over 1000
members backfills partially; the unseen members are then indistinguishable from "confirmed absent"
(a false `not_connected` — the designer's §3.6 self-inflicted outage). Fix in PR-8: paginate with
`after` until a page returns `< 1000` (cap at 10 pages), and carry `complete: boolean` on
`Guild/ReconcileMembers`. `complete` gates only `discord_joined_at` and
`bot_guilds.members_backfilled_at` — **not** the diff, which is per-member and safe on a partial page.

### CC-11 — The banner's fate, settled.

- **PR-5 keeps and repairs it** (server-sourced, silent polling, terminal states, non-toast errors).
  It is the only member-facing link surface that exists today and the bugfix must land behind it.
- **PR-9 retires it**, replaced by `DiscordConnectCard` + the `/connect-discord` interstitial +
  the sidebar badge. `AuthenticatedLayout.tsx:128` loses the `<PendingDiscordJoinBanner />` mount and
  the component is deleted.
- **`MyProfilePage.tsx` is in PR-9's file list.** PR-5 adds a "Join the team Discord" row there; PR-9
  must migrate or delete it, or the retirement leaves a third surface reading a fourth state. Rev 2
  omitted it, which violated this very decision.

### CC-12 — The enforcement interstitial does not "mirror `/profile/complete`".

`routes/(authenticated)/teams/$teamId/connect-discord.tsx` nests under
`routes/(authenticated)/teams/$teamId/route.tsx`, which renders `AuthenticatedLayout` — so the page
appears **inside the sidebar shell** (`AuthenticatedLayout.tsx:161` `<Outlet />`), not in the
standalone `flex min-h-screen flex-col` shell of `ProfileCompletePage`. Pick one in PR-9:

- **(a) Recommended** — keep the nested route and **drop the "mirrors /profile/complete" framing**.
  Design the card for the sidebar shell. Cheapest, no route-tree surgery.
- **(b)** — move it to a sibling under `(authenticated)/` taking `teamId` as a **search param** with
  `validateSearch`, and render the standalone shell. Only if the standalone shell is judged
  load-bearing for the enforcement framing.

### CC-13 — `enqueue` idempotency: do not resurrect `done` rows.

`PendingGuildJoinsRepository.ts:18-26` upserts
`ON CONFLICT (user_id, team_id) DO UPDATE SET status = 'pending', attempts = 0, last_error = NULL,
created_at = now(), processed_at = NULL` — with no status predicate. That resets a **`done`** row back
to `pending` and re-adds a user who has since deliberately left the guild. Add a WHERE clause to the
`DO UPDATE` so `done` is terminal:

```sql
ON CONFLICT (user_id, team_id) DO UPDATE SET
  status = 'pending', attempts = 0, last_error = NULL, created_at = now(), processed_at = NULL
WHERE pending_guild_joins.status <> 'done'
```

No migration needed — a query change in PR-4, asserted by an explicit test.

**Consequence for rollback, and rev 2 got this wrong.** Once `'done'` is terminal, `enqueue` refuses
those rows forever and `requeueFailedForUser` only touches `'failed'`. So rev 2's rollback SQL —
`UPDATE pending_guild_joins SET status = 'done' WHERE status = 'pending'` — is **permanently
destructive**: it cancels the queue in a way that can never be undone by any code path. The correct
cancel is to a *recoverable* terminal state:

```sql
UPDATE pending_guild_joins
SET status = 'failed', last_error = 'cancelled by PR-4 rollback', processed_at = now()
WHERE status = 'pending';
```

`'failed'` is exactly what `requeueFailedForUser` revives, so a re-deploy plus one login puts the user
back in the queue.

### CC-14 — The regenerate primitive. (This answers designer open question 3, `discord-connect-enforcement-design.md:836`.)

The designer asks: *"`invite_acceptances.discord_code` exists but is single-use and tied to one
acceptance. The §4.2a regenerate affordance needs a supported way to mint a replacement for an
already-joined team member."* Rev 2 left this unanswered while CC-5 closed the whole backlog to
`'expired'` and PR-9 test 11 asserted a CTA with nothing behind it. Answered now.

**Constraints that shape the answer** (verified, so no PR re-derives them):

- `InviteAcceptancesRepository` exposes only `findById`, `findByDiscordCodeWithContext`,
  `findRecentByUserAndGuildWithContext` — nothing finds a user's acceptance for a given invite.
- `invite_acceptances` has **no unique key on `(team_invite_id, user_id)`**
  (`1747300000_invite_acceptances.ts` — the only unique index is on `discord_code`). Nothing in the
  schema stops a retry loop minting a second one-time Discord invite per click.
- `team_invites` has only `active` and `expires_at`
  (`packages/migrations/src/before/1739716800_create_teams.ts:24-32`) — **no use counter**, so there
  is no seat accounting to corrupt by re-running a join.
- `members.assignRole` is `ON CONFLICT DO NOTHING`
  (`applications/server/src/repositories/TeamMembersRepository.ts:90`), so re-running the role
  assignment is safe.
- `setDiscordCode` (`InviteAcceptancesRepository.ts:94`) writes `discord_code` and `generated_at`
  only — it does **not** clear `discord_code_error_code`. That matters as soon as a row can be
  re-opened (CC-0 rule 2); PR-3 fixes it.

**The answer: a new acceptance row is correct in exactly one case — the newest acceptance for this
(user, invite) is terminally failed, or there is none at all.** That single rule is simultaneously the
idempotent-re-join path and the regenerate primitive, so there is one code path, not two:

```
resolveOrCreateAcceptance(userId, invite):
  open := findOpenByUserAndInvite(userId, invite.id)      -- newest with no error code
  if Some(open)          -> reuse it, create nothing      (CC-14's original hard rule, intact)
  if None:
      if regenerations in the last hour >= 3              -> reuse the newest row as-is (see below)
      else                                                -> acceptances.create(invite.id, userId)
```

- **Rate limit: ≤3 per hour per user** (designer §"Regenerate invite endpoint … rate-limited
  server-side (≤3/hour/user)"). Enforced with a `COUNT(*) FROM invite_acceptances WHERE user_id = $1
  AND created_at > now() - interval '1 hour'` — no new table, no new counter.
- **Exceeding the limit does not error.** It returns the newest existing (failed/expired) acceptance
  unchanged, so the UI keeps showing the §4.2(a) copy and the button just does not produce a new
  link. This deliberately avoids adding a new tagged error to `joinViaInvite`'s error union, which an
  old web bundle could not decode. (If a distinct 429 is later judged necessary, it is an additive
  wire change and belongs in its own release.)
- **`Invite.AlreadyMember` stops being emitted** by `joinViaInvite`. It stays declared in the domain
  for wire compatibility with deployed bundles. Rev 2's "still returns 409 for an active member with
  no open acceptance" is exactly the dead end this rule removes; its test is inverted in PR-4.
- **This also un-does the 409 dead end for the cohort PR-3 just swept.** Their newest acceptance is
  `'expired'`, so `findOpenByUserAndInvite` returns `None` — under rev 2 that meant 409 forever.
- **`findOpenByUserAndInvite` and regenerate are one function.** PR-5's endpoint
  `POST /teams/:teamId/me/discord-join` is a thin wrapper: resolve the team's active invite, call
  `resolveOrCreateAcceptance`, return the same `JoinStatus` shape as
  `GET /teams/:teamId/me/discord-join`. **PR-9 needs nothing new** for its "Get a new invite" CTA.
- **The new row is `enqueue`-safe.** Creating an acceptance also taps `pendingGuildJoins.enqueue`
  (PR-4 step 5) — which is an explicit user click, so S4 holds.

### CC-15 — One source of truth for "is this user in the guild".

Rev 2 had three, and they disagree:

| Surface | Source | Behaviour |
|---|---|---|
| PR-5 `JoinStatus.state = 'joined'` | `pending_guild_joins.status = 'done'` | permanently terminal (CC-13) → sticky forever, even after the user leaves |
| PR-9 `UserTeam.discordJoined` | `team_members.discord_joined_at` | cleared on `Guild/RemoveMember` → correct |
| PR-5 `MyProfilePage` row | its own read | a third answer |

Decision: **`team_members.discord_joined_at` is the only source**, because it is the only one that is
*cleared* when the user leaves the guild.

- PR-5 ships **before** that column exists (it is added in PR-8). So PR-5's `state` union does **not**
  include `'joined'`: the states are `preparing | ready | expired | failed`, and "already in the
  guild" is expressed by `getMyPendingDiscordJoin` returning `Option.none()` (nothing pending). "No
  state" is strictly better than a wrong state.
- PR-8 adds the column. PR-9 adds `'joined'` to `state` (a purely additive literal on a field that
  already has a decoding default) and derives it from `discord_joined_at`, at the same time as
  `UserTeam.discordJoined`. The banner is gone by then, so there is exactly one consumer.
- `pending_guild_joins.status` is **never** read by a UI surface. It is queue state.

### CC-16 — Non-goals for all nine PRs

- **Roster roles** (`roster_members` → `reconcileRosterRoleExtras`) and **achievement roles**
  (`achievement_role_mappings` → `discord_role_provision_events`) have their own pipelines and are
  **out of scope**. PR-7/PR-8 sync *Sideline permission roles* (`member_roles`) and *group-derived
  roles* (`role_groups` + recursive ancestry) only. File the other two separately.
- **OAuth token refresh** (CC-6/S2) is out of scope. File separately, with the two facts recorded in
  CC-6 so the ticket starts from "read the column that is already there".
- **Do not opportunistically rewrite `Effect.gen`.** `PendingGuildJoinsRepository.ts:13`,
  `RoleSyncEventsRepository.ts:39` and `DiscordRolesRepository.ts:23` are
  `const make = Effect.gen(function* () {` repository constructor bodies, which `AGENTS.md:176-177`
  **explicitly exempts**.
- **The three `.work-plans/discord-native-onboarding*.md` documents are stale** — they describe work
  that shipped in `bdc0b0ed`, and `discord-native-onboarding.md:3` still says "Status: Backlog".
  Their stale Community-gating language is plausibly what produced the bad `findPending` predicate.
  Mark them Done as a chore alongside PR-1.

---

## PR sequence

| # | PR | Touches | Wire change | Must be live first |
|---|---|---|---|---|
| 1 | hotfix — un-filter community guilds | server | none | — |
| 2 | wire expand | domain, server, bot | **expand only** | PR-1 |
| 3 | contract — un-filter the welcome channel, fail *terminally* only, retry the rest | migrations, server, bot | contract | PR-2 **fully rolled out** (bot included, verified on `/api/version`) |
| 4 | automatic guild join + re-auth dead end + the regenerate primitive | server, web | none | PR-3 |
| 5 | durable link surface + regenerate endpoint | domain, server, web, i18n | additive | PR-4 |
| 6 | role mapping adoption | bot (+ test) | none | **nothing** — see the note below |
| 7 | role emission + manual role sync | domain, server, web, i18n | additive | PR-6 **live in production** |
| 8 | level-based role reconciliation on guild join | migrations, domain, server, bot | additive | PR-6, PR-7 |
| 9 | enforcement, sync fidelity, banner retirement | migrations, domain, server, web, i18n | expand/contract | PR-8 |

**PR-6 has no dependency on PR-2 and can be worked in parallel from day one.** Rev 2's gate said
"PR-2 (RPC already exists)", which is self-contradictory — `Guild/ListGuildRoles` exists in
production today, and after CC-7 PR-6 does not use it at all (it reads `DiscordREST` directly). PR-6
is the long pole for PR-7 **and** PR-8, so starting it beside PR-2 is the single biggest schedule
win available. Its only constraint is that it must be **live in production** before PR-7 merges.

---

## PR-1 — hotfix: stop excluding non-Community guilds

**Goal.** Restore invite generation for the majority of teams with a single-predicate change that
cannot break any decoder. This is the P0; ship it alone and observe before starting PR-2.

**Files**
- `applications/server/src/repositories/InviteAcceptancesRepository.ts` — delete one line from `findPending`
- `applications/server/test/integration/repositories/InviteAcceptancesRepository.test.ts` — **create**

**Steps**
1. In `findPending` (line 73), delete **only** `AND b.is_community_enabled = true` (line 88).
2. Leave everything else byte-for-byte identical: `JOIN bot_guilds b` stays an **inner** join,
   `AND t.welcome_channel_id IS NOT NULL` (line 87) stays, `PendingAcceptanceRow` (line 15) is
   untouched, `packages/domain/src/rpc/invite/InviteRpcGroup.ts` is untouched.
3. Add a code comment above the remaining `welcome_channel_id IS NOT NULL` predicate noting it is a
   temporary wire guard removed in PR-3, so nobody deletes it early.

**Why this is wire-safe.** The inner join guarantees `bot_present` is implicitly true, and the
`IS NOT NULL` predicate guarantees `welcome_channel_id` is a real snowflake. The encoded row shape is
byte-identical to what the currently deployed bot already decodes.

**Tests** — `applications/server/test/integration/repositories/InviteAcceptancesRepository.test.ts` (new).
Pattern: `applications/server/test/integration/repositories/TeamInvitesRepository.test.ts` (its
`createTeam` helper enumerates every `teams` column needed); harness `TestPgClient` / `cleanDatabase`
from `applications/server/test/integration/helpers.ts`.

1. `findPending returns an acceptance for a team with a welcome channel and a community guild` — baseline, 1 row
2. **`findPending returns an acceptance when the guild is NOT community-enabled`** — `is_community_enabled = false`; expect 1 row. *Regression test; fails before this PR.*
3. `findPending still excludes a team with no welcome_channel_id` — 0 rows. *Guards the PR-3 boundary; this test is **inverted** in PR-3.*
4. `findPending still excludes an acceptance whose team's guild has no bot_guilds row` — 0 rows. *Also inverted in PR-3.*
5. `findPending excludes acceptances that already have a discord_code` — 0
6. `findPending excludes acceptances already marked failed` — 0
7. `findPending orders by created_at ASC and honours the limit`

**Deploy / rollout.** Server-only. No domain rebuild. No bot coordination. Deployable to production
the moment it merges. **Observe for at least one full bot poll cycle before merging PR-2:**
`invite_generator_total{status="success"}` should go from ~0 to non-zero, and the stuck-acceptance
count query above should start falling.

**Measure the drain cohort before this reaches production (blocker 3, rev 3 addition — no code
change).** PR-1 un-hides every acceptance whose team has a welcome channel and a bot, in a
*non-Community* guild. The bot drains that backlog through `fastPollLoop`
(`applications/bot/src/Bot.ts:203` — `Schedule.spaced('1 seconds')`, `limit: 20`), i.e. up to
**20 Discord invite creations per second**, minting a `max_age: 86400, max_uses: 1` invite for every
historical row. Run the age-bucket query from Part 1 and record the count of rows with
`no_welcome = false AND bot_absent = false AND community = false` in the PR description. If that
count is large (rule of thumb: **> 2000**, ≈ 100 s of saturated invite creation), run PR-3's
pre-deploy sweep (PR-3 step 0) against the aged slice of *this* cohort **before** PR-1 ships, not
after. The sweep only touches rows the currently-deployed `findPending` already ignores, so it is
safe to run against the pre-PR-1 server.

**Rollback.** Re-add the one line. No data written by this PR is unusual (`discord_code` values are
the normal product of the feature), so there is nothing to unwind.

---

## PR-2 — wire expand (no behaviour change)

**Goal.** Ship every widened schema to every consumer *before* any producer emits a widened value.
This PR is intentionally behaviour-neutral in production.

**Rev 3 delta:** step 3/4/5 change shape — the projection now returns an `Option` and `'expired'`
collapses to `None` permanently (CC-3). Everything else is as reviewed and approved.

**Files**
- `packages/domain/src/rpc/invite/InviteRpcGroup.ts` — widen the `Invite/PendingAcceptances` success schema
- `packages/domain/src/models/Onboarding.ts` — widen the stored `InviteGeneratorErrorCode`
- `packages/domain/src/api/Invite.ts` — add `JoinStatusErrorCode`, pin `JoinStatus.errorCode` to it
- `applications/server/src/utils/inviteErrorWireProjection.ts` — **create**
- `applications/server/src/api/invite.ts` — apply the projection in `getJoinStatus`
- `applications/server/src/repositories/InviteAcceptancesRepository.ts` — select the two new columns; predicates unchanged
- `applications/bot/src/rcp/inviteGenerator/ProcessorService.ts` — accept the widened shape; add the `welcome_channel_missing` short-circuit
- `packages/domain/test/InviteRpcWireCompat.test.ts` — **create**

**Steps**

1. **Domain — `InviteRpcGroup.ts:10-17`.** Replace the `success` struct fields:
   ```ts
   welcome_channel_id: Schema.OptionFromOptionalNullOr(Discord.Snowflake, { onNoneEncoding: null }),
   bot_present: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(() => true)),
   ```
   `OptionFromOptionalNullOr` tolerates the key being **absent** (old server → new bot) *and* `null`
   (new server → new bot). `withDecodingDefaultKey(() => true)` makes a missing `bot_present` decode
   as "bot is present", the behaviour-preserving default. Precedents:
   `packages/domain/src/api/TeamSettingsApi.ts:59,79`, `packages/domain/src/rpc/event/EventRpcEvents.ts:30`.
2. **Domain — `Onboarding.ts:23-32`.** Add `'bot_not_in_guild'` and `'expired'` to the **stored**
   `InviteGeneratorErrorCode`. Both are additive; the union is consumed by `InviteAcceptance`
   (a `SELECT *` decode — this is why `'expired'` must be here even though it never reaches a
   browser) and by `Invite/MarkAcceptanceFailed`.
3. **Domain — `Invite.ts`.** Add, next to the imports:
   ```ts
   /** The client-facing subset. `'expired'` is never here — `JoinStatus.state` carries it (CC-3). */
   export const JoinStatusErrorCode = Schema.Literals([
     'welcome_channel_missing', 'welcome_channel_deleted', 'bot_missing_perms',
     'community_not_enabled', 'rate_limited', 'discord_error', 'network_error', 'unknown',
   ]);
   ```
   and change `JoinStatus.errorCode` to `Schema.OptionFromNullOr(JoinStatusErrorCode)`.
   Model on `packages/domain/src/api/EventRsvpApi.ts:15,21,28`.
   Name it `JoinStatusErrorCode`, **not** `LegacyInviteGeneratorErrorCode` — it is not a legacy
   artefact awaiting deletion, it is the permanent client contract (only `'bot_not_in_guild'` joins it
   later, in PR-9).
4. **Server — `inviteErrorWireProjection.ts`.** A pure function, no Effect, no I/O:
   ```ts
   export const projectInviteErrorToWire = (
     code: Onboarding.InviteGeneratorErrorCode,
   ): Option.Option<Invite.JoinStatusErrorCode> =>
     code === 'expired' ? Option.none()          // permanent: `state` says it (CC-3)
     : code === 'bot_not_in_guild' ? Option.some('unknown')  // removed in PR-9
     : Option.some(code);
   ```
   Model on `applications/server/src/utils/rsvpWireProjection.ts`.
5. **Server — `invite.ts` `getJoinStatus` (line 128).**
   `errorCode: Option.flatMap(acc.discord_code_error_code, projectInviteErrorToWire)`.
   Note the `flatMap` — the projection now returns an `Option`, so an `'expired'` row yields
   `errorCode: None`, which is exactly what an old browser should see (it has no `state` field and
   will keep showing "Preparing…" — no worse than today, and PR-5 fixes it for every current bundle).
6. **Server — `InviteAcceptancesRepository.ts`.** In `findPending`, add `TRUE AS bot_present` to the
   select list (the inner join makes it a constant this release) and keep
   `t.welcome_channel_id AS welcome_channel_id`. Widen `PendingAcceptanceRow` (line 15) to
   `welcome_channel_id: Schema.OptionFromNullOr(Discord.Snowflake)` and `bot_present: Schema.Boolean`.
   **Do not touch the WHERE clause.** The server therefore still cannot put a `null` on the wire.
7. **Bot — `ProcessorService.ts`.** Widen the `PendingAcceptance` interface (line 13) to
   `readonly welcome_channel_id: Option.Option<string>` and `readonly bot_present: boolean`. At the
   top of `makeProcessAcceptance`:
   - `Option.isNone(acceptance.welcome_channel_id)` → `Invite/MarkAcceptanceFailed` with
     `'welcome_channel_missing'` (finally makes that literal reachable). Unreachable in production
     this release because of step 6; the code ships now so PR-3 is a one-line SQL change.
   - **Do NOT yet emit `'bot_not_in_guild'`.** Leave the branch out entirely. PR-3 adds it.
   - Move the `createChannelInvite` call inside the `Option.match` `onSome` branch so
     `welcome_channel_id` is a plain string where Discord needs it. Keep `Effect.catch` →
     `classifyInviteGeneratorError` untouched **this release** (PR-3 splits it).

**Tests**

- `packages/domain/test/InviteRpcWireCompat.test.ts` (**new**):
  1. `new PendingAcceptances schema decodes a legacy payload` — no `bot_present` key; expect `welcome_channel_id: Option.some(...)`, `bot_present: true`
  2. `new PendingAcceptances schema decodes welcome_channel_id: null` — expect `Option.none()`
  3. `new PendingAcceptances schema decodes bot_present: false` — expect `false`
  4. **`the PR-2 server encoding still decodes under the legacy schema`** — construct the exact struct the PR-2 server emits and decode it with a locally-declared copy of the *old* `Schema.Struct({acceptance_id, guild_id, welcome_channel_id: Discord.Snowflake})`; expect success. This proves an un-upgraded bot survives PR-2.
- `applications/server/test/unit/inviteErrorWireProjection.test.ts` (**new**):
  5. `projects 'expired' to None` — table-driven over all 10 stored literals; `'bot_not_in_guild' → Some('unknown')`, identity elsewhere
- `applications/bot/test/rcp/inviteGenerator/ProcessorService.test.ts` (**new**). Pattern:
  `applications/bot/test/rcp/roleProvision/handleProvisionRole.test.ts` (`Layer.succeed` recorders for
  `DiscordREST` + `SyncRpc`).
  6. `marks the acceptance failed with welcome_channel_missing when welcome_channel_id is None` — `createChannelInvite` NOT called
  7. `sets the discord code on success`
  8. `classifies a 50013 ErrorResponse as bot_missing_perms`
  9. `classifies a Discord "community" error as community_not_enabled` — proves the gate belongs at the Discord boundary, not in SQL
- Existing `applications/server/test/Invite.test.ts`:
  10. `getJoinStatus projects bot_not_in_guild to 'unknown'`
  11. `getJoinStatus returns errorCode None for an expired row`

**Deploy / rollout.** `pnpm build` in `packages/domain` **before** typechecking server/web/bot.
Release all apps at one version. Because the server still emits only legacy-compatible values and the
bot still writes only legacy-compatible codes, **the deploy order within this release does not
matter** — which is the entire point of the PR. Verify: `invite_generator_total` unchanged, no decode
errors in bot logs.

**Rollback.** Revert the whole PR. Nothing new was written to the database. If only the bot needs
rolling back, an old bot still decodes the new server's payload (test 4).

---

## PR-3 — contract: un-filter the welcome channel, fail *terminally* only, retry the rest

**Goal.** Turn the two remaining silent filters into explicit failure paths — and, per CC-0, make
sure the failure paths that open up are only the ones a human can act on. Rev 2 would have converted
every 429 burst and network blip into a permanent dead end for the affected user.

**Rev 3 delta (blockers 2 and 3):** this PR is now **smaller** in behaviour and **larger** in
sequencing discipline.
- Transient classifier codes no longer call `MarkAcceptanceFailed` at all.
- `welcome_channel_missing` becomes re-openable.
- The backlog sweep runs as an explicit **pre-deploy step**, before this code ships; the cron is a
  backstop only.

**Hard precondition: PR-2 must be fully rolled out — bot included.** Verify with
`curl https://<host>/api/version` and confirm the reported **bot** version is the PR-2 release
(CC-1 — `/api/version` on the server, *not* `/info` on the bot). This is the one ordering constraint
in the plan that, if violated, breaks invite generation for every team.

**Files**
- `packages/migrations/src/before/<ts>_invite_acceptances_retry_indexes.ts` — **create**
- `applications/server/src/utils/inviteExpiry.ts` — **create** (the shared CC-4 window constants)
- `applications/server/src/repositories/InviteAcceptancesRepository.ts` — SQL contract, `sweepExpired`, `setDiscordCode` clears the error
- `applications/server/src/services/InviteAcceptanceSweepCron.ts` — **create**
- `applications/server/src/run.ts` — add the cron to the concurrent startup list
- `applications/bot/src/rcp/inviteGenerator/errorClassifier.ts` — mark codes transient vs terminal
- `applications/bot/src/rcp/inviteGenerator/ProcessorService.ts` — enable `bot_not_in_guild`; do not fail on transient errors
- `applications/server/test/integration/repositories/InviteAcceptancesRepository.test.ts` — extend + invert two tests

**Steps**

0. **PRE-DEPLOY — run the sweep by hand, before this code ships. This is a gate, not a suggestion.**

   Rev 2 scheduled the sweep as a startup cron in the same release that un-filters `findPending`.
   Those two race. `AgeCheckCron.ts:35` shows the house pattern (`Effect.repeat(Schedule.cron(...))`)
   does run its body **once immediately at startup** — but it is one of ~12 entries in a concurrent
   `Effect.all` at `run.ts:252-263` with `concurrency: 'unbounded'`, and **nothing sequences it
   against the HTTP server accepting the bot's `Invite/PendingAcceptances` poll**. The bot polls at
   1 Hz with `limit: 20`, so the un-filtered backlog starts draining at up to 20 Discord invite
   creations per second while the sweep is still deciding what to close. That is precisely the
   "mint an invite in every guild for every historical user" outcome CC-5 rejects, reached by a
   different route.

   Instead, against the **currently deployed** (pre-PR-3) server:

   ```sql
   -- 1. Size it. Record this number in the PR description; it is the acceptance gate.
   SELECT count(*) AS to_close
   FROM invite_acceptances
   WHERE discord_code IS NULL
     AND discord_code_error_code IS NULL
     AND created_at < now() - interval '3 days';

   -- 2. Close it.
   UPDATE invite_acceptances
   SET discord_code_error_code = 'expired',
       discord_code_error_detail = 'aged out before generation',
       generated_at = now()
   WHERE discord_code IS NULL
     AND discord_code_error_code IS NULL
     AND created_at < now() - interval '3 days';

   -- 3. Confirm. Must return 0.
   SELECT count(*) FROM invite_acceptances
   WHERE discord_code IS NULL AND discord_code_error_code IS NULL
     AND created_at < now() - interval '3 days';
   ```

   **Why this is safe against the old server:** every row it touches already has
   `discord_code_error_code IS NULL`, and the currently deployed `findPending` additionally requires
   `t.welcome_channel_id IS NOT NULL AND b.is_community_enabled = true` (or, post-PR-1, just the
   welcome channel). Writing an error code onto rows the deployed query *already* ignores cannot
   change deployed behaviour. The old server can read `'expired'` back only through `getJoinStatus`,
   and PR-2 already taught it the widened stored enum — this is exactly why PR-2 ships first.

   **Acceptance gate:** step 1's `to_close` must be recorded, and step 3 must return 0, before the
   PR-3 image is promoted. The remaining open backlog (rows newer than 3 days) is what the bot will
   drain at 20/s; it must be small enough to be uninteresting — if it is not, raise
   `INVITE_ACCEPTANCE_SWEEP_DAYS` for the pre-deploy run only and note the value used.

1. **`findPending` SQL.** Delete `AND t.welcome_channel_id IS NOT NULL` and the PR-1 comment. Change
   `JOIN bot_guilds b ON b.guild_id = t.guild_id` to `LEFT JOIN`. Replace `TRUE AS bot_present` with
   `(b.guild_id IS NOT NULL) AS bot_present`. **Add no age predicate** (CC-4). Pattern for the
   nullable select + `Schema.OptionFromNullOr`: the `LEFT JOIN groups g` shape already in
   `findByDiscordCodeWithContext` at line 110 of the same file.

   And **re-open `welcome_channel_missing` rows whose cause has been fixed** (CC-0 rule 2). Replace
   `AND ia.discord_code_error_code IS NULL` with:
   ```sql
   AND (ia.discord_code_error_code IS NULL
        OR (ia.discord_code_error_code = 'welcome_channel_missing'
            AND t.welcome_channel_id IS NOT NULL))
   ```
   The welcome channel is settable by a captain in Team Settings
   (`applications/web/src/components/pages/TeamSettingsPage.tsx:479` sends
   `welcomeChannelId: Option.some(...)` through `updateTeamInfo`). Without this clause, a captain who
   fixes the exact thing the error message told them to fix gets nothing.

2. **Migration — one partial index.**
   ```sql
   -- The OR in step 1 makes the existing idx_invite_acceptances_pending insufficient on its own;
   -- with both partial indexes present Postgres can BitmapOr the two branches.
   CREATE INDEX idx_invite_acceptances_welcome_retry
     ON invite_acceptances(created_at)
     WHERE discord_code IS NULL AND discord_code_error_code = 'welcome_channel_missing';
   ```
   **Do not add `idx_invite_acceptances_user_id` here.** Should-fix 3 (third review of PR-4): it
   shipped a release early, in
   `packages/migrations/src/before/1790600000_invite_acceptances_user_id_index.ts` (PR-4), because
   PR-4's `countRecentByUserAndInvite` rate-limit COUNT needed it immediately and couldn't wait for
   a PR-3 that at review time was sequenced *after* PR-4. Re-adding the same index name here —
   without `IF NOT EXISTS`, and with a different shape (`(user_id)` vs. the shape actually
   shipped) — would 500 the whole migration batch: `Migrator.js` runs a release's pending
   migrations inside one transaction, so a `relation already exists` rolls back everything in it
   and the server does not boot. The shipped shape is `(user_id, team_invite_id, created_at DESC)`
   (round-4 review of PR-4: the 2-column shape did not match the predicate). All three hot-path
   reads — `findOpenByUserAndInvite`, `findNewestByUserAndInvite` and `countRecentByUserAndInvite`
   — filter on `user_id AND team_invite_id` together, so the 3-column shape satisfies every
   predicate plus the sort in one index scan. It remains a strict superset of anything PR-3/PR-5
   need — nothing left to add here.
   **Do not add an index for `sweepExpired`.** It is already perfectly served by
   `idx_invite_acceptances_pending` (`packages/migrations/src/before/1747300000_invite_acceptances.ts:23-25`
   — `ON invite_acceptances(created_at) WHERE discord_code IS NULL AND discord_code_error_code IS NULL`),
   whose predicate is byte-for-byte the sweep's `WHERE`. Stated here so nobody adds a redundant one.

3. **Bot — split the classifier into transient and terminal (blocker 2). This is the core of the PR.**

   `applications/bot/src/rcp/inviteGenerator/errorClassifier.ts` currently returns
   `rate_limited` (line 29-36) and `network_error` (line 38-43) as ordinary codes, and computes
   `retry_after` (line 31) only to throw it away. Add to `ClassifiedError`:
   ```ts
   export interface ClassifiedError {
     readonly code: Onboarding.InviteGeneratorErrorCode;
     readonly detail: string;
     readonly retry_after?: number;
     /** false → do not write a terminal error code; leave the row open and let the next tick retry. */
     readonly terminal: boolean;
   }
   ```
   - `terminal: false` for `rate_limited`, `network_error`, and `discord_error` when the upstream HTTP
     status is 5xx (Discord's own outage — `isTagged(error, 'ErrorResponse')` with a 5xx status, or
     any `HttpClientError` that is not a 4xx).
   - `terminal: true` for `welcome_channel_missing`, `welcome_channel_deleted`, `bot_missing_perms`,
     `community_not_enabled`, `bot_not_in_guild`, 4xx `discord_error`, and `unknown`.

   In `ProcessorService.ts`'s `Effect.catch` handler (line 44), branch on `classified.terminal`:
   - **terminal** → `Invite/MarkAcceptanceFailed` exactly as today, metric
     `invite_generator_total{status="failed"}`.
   - **transient** → do **not** call `MarkAcceptanceFailed`. `Effect.logWarning` with the code and
     `retry_after`, bump `invite_generator_total{status="transient"}` (a **new** label value — add it
     to any dashboard/alert that enumerates statuses), and return `Effect.void`. The row keeps
     `discord_code IS NULL AND discord_code_error_code IS NULL`, so the next `fastPollLoop` tick
     (1 s later) picks it up again, and the CC-4 sweep is the bounded backstop if it never succeeds.
   - When `retry_after` is present, `Effect.sleep(Duration.seconds(Math.min(retry_after, 30)))`
     before returning, so a 429 burst does not immediately re-hammer Discord at 1 Hz. Cap it: the
     tick must not hold the loop for longer than the sweep window.

   **This is strictly smaller than what rev 2 specified** — it deletes a write, it does not add one.

4. **Bot — enable `bot_not_in_guild`.** Add the short-circuit **above** the `welcome_channel_id`
   check: `acceptance.bot_present === false` → `Invite/MarkAcceptanceFailed` with
   `'bot_not_in_guild'` and a detail naming the guild. Terminal (a human must re-invite the bot); the
   regenerate primitive (CC-14) is the recovery path.

5. **Server — `setDiscordCode` must clear the error (CC-14).** `InviteAcceptancesRepository.ts:94`
   writes `discord_code` and `generated_at` only. Once step 1 lets a `welcome_channel_missing` row be
   retried, success would leave a row with **both** a code and an error code. Add
   `discord_code_error_code = NULL, discord_code_error_detail = NULL` to the `SET`. (`getJoinStatus`'s
   precedence already prefers `discord_code`, so this is belt-and-braces — but the stored row should
   not lie.)

6. **Server — `applications/server/src/utils/inviteExpiry.ts` (new).** The two CC-4 constants and
   nothing else. Both PR-3's sweep and PR-5's derived guard import from here.

7. **Server — `sweepExpired(olderThanDays: number)`** on the repository. `SqlSchema.void`, idempotent,
   the same `UPDATE` as step 0. **`created_at` is never written.** Export it from the repository record.

8. **Server — `applications/server/src/services/InviteAcceptanceSweepCron.ts` (new).** Follow the
   house pattern exactly — `AgeCheckCron.ts` is the reference:
   ```ts
   const cronEffect = Effect.Do.pipe(
     Effect.bind('acceptances', () => InviteAcceptancesRepository.asEffect()),
     Effect.tap(({ acceptances }) => acceptances.sweepExpired(INVITE_ACCEPTANCE_SWEEP_DAYS)),
     Effect.asVoid,
     withCronMetrics('invite-acceptance-sweep'),
   );
   export const InviteAcceptanceSweepCron = cronEffect.pipe(
     Effect.repeat(Schedule.cron('0 3 * * *')),
     Effect.asVoid,
   );
   ```
   Add it to the `Effect.all` list in `run.ts:252-263`. **Note explicitly in the PR description that
   `Effect.repeat` runs the body once immediately at startup, unsequenced against the HTTP server** —
   that is exactly why step 0 exists and why this cron is a *backstop*, not the backfill.

**Tests** — extend `applications/server/test/integration/repositories/InviteAcceptancesRepository.test.ts`:

1. **`findPending returns an acceptance when the team has no welcome_channel_id`** — 1 row, `welcome_channel_id: Option.none()`. *Inverts PR-1 test 3.*
2. **`findPending returns bot_present: false when no bot_guilds row exists`** — 1 row, `bot_present === false`. *Inverts PR-1 test 4.*
3. `findPending does not filter by age` — a 90-day-old open acceptance is **returned**
4. **`findPending re-opens a welcome_channel_missing row once the team gets a welcome channel`** — insert the row with the error, set `teams.welcome_channel_id`, expect 1 row. *Pins CC-0 rule 2.*
5. `findPending still excludes a welcome_channel_missing row while welcome_channel_id is NULL` — 0 rows
6. `findPending still excludes rows with any other error code` — `bot_missing_perms` → 0 rows
7. `setDiscordCode clears discord_code_error_code and _detail`
8. `sweepExpired closes rows older than the window`
9. **`sweepExpired does not modify created_at`** — capture before/after; assert equal. *Guards CC-5.*
10. `sweepExpired leaves rows inside the window untouched`
11. `sweepExpired is idempotent` — run twice; the second affects 0 rows and does not change `generated_at`
12. `sweepExpired does not touch rows that already have a discord_code or an error code`

`applications/server/test/unit/inviteExpiry.test.ts` (**new**):
13. **`the derived expiry window is strictly larger than the sweep window`** — pins CC-4's anti-flapping rule

Extend `applications/bot/test/rcp/inviteGenerator/ProcessorService.test.ts`:
14. `marks the acceptance failed with bot_not_in_guild when bot_present is false` — `createChannelInvite` NOT called
15. `prefers bot_not_in_guild over welcome_channel_missing when both are true` — pins the precedence
16. **`does NOT call MarkAcceptanceFailed for a RatelimitedResponse`** — assert the `Invite/MarkAcceptanceFailed` recorder is empty and `invite_generator_total{status="transient"}` was bumped. *This is blocker 2's regression test.*
17. **`does NOT call MarkAcceptanceFailed for a RequestError (network)`**
18. **`does NOT call MarkAcceptanceFailed for a 5xx ErrorResponse`**
19. `DOES call MarkAcceptanceFailed for a 50013 ErrorResponse` — the terminal side of the same branch
20. `sleeps for retry_after (capped) before returning on a 429`

`applications/bot/test/rcp/inviteGenerator/errorClassifier.test.ts` (**new or extended**):
21. `every code is classified terminal or transient` — table-driven over the full union; a new literal added without a `terminal` value fails this test

**Deploy / rollout.** Pre-deploy step 0 first (gated). Then server + bot at one version; migration runs
at server startup. Because PR-2 already taught the bot both the nullable field and the widened enum,
either container may start first. After rollout watch:
- `invite_generator_total{status="failed"}` — a spike is **expected and correct** (previously
  invisible failures becoming visible), dominated by `welcome_channel_missing` / `bot_not_in_guild`.
- `invite_generator_total{status="transient"}` — should be near zero in steady state. A sustained
  non-zero rate means rows are being retried at 1 Hz forever; check that the sweep is closing them.
- The open-backlog count (`discord_code IS NULL AND discord_code_error_code IS NULL`) — must not grow.

**Rollback.** Revert the SQL contract (restore `AND t.welcome_channel_id IS NOT NULL` + inner join +
the simple `IS NULL` error predicate) and disable the sweep schedule. Rows already marked `'expired'`
/ `'bot_not_in_guild'` **stay** — they decode fine on the reverted server (PR-2 widened the stored
enum) and are absorbed by the CC-3 projection for browsers. The migration's indexes are additive;
leave them. Reverting past PR-2 is **not** safe with those rows present; if you must,
`UPDATE invite_acceptances SET discord_code_error_code = 'unknown' WHERE discord_code_error_code IN ('expired','bot_not_in_guild')` first.

---

## PR-4 — automatic guild join, the re-auth dead end, and the regenerate primitive

**Goal.** Restore the silent `addGuildMember` path deleted in `bdc0b0ed`, make the re-auth branch
reachable instead of a permanent 409 loop, and land the one code path that both the idempotent
re-join and PR-5's regenerate button sit on (CC-14).

**Rev 3 delta:** step 4 becomes `resolveOrCreateAcceptance` (CC-14) instead of "reuse or 409";
steps 4 and 5 are explicitly composed (rev 2's short-circuit skipped the enqueue tap); `auth.ts`'s
requeue condition is widened (CC-6/S5); the rollback SQL is corrected (CC-13). Everything else is as
reviewed and approved.

**Files**
- `applications/server/src/repositories/InviteAcceptancesRepository.ts` — `findOpenByUserAndInvite`, `countRecentByUser`
- `applications/server/src/repositories/PendingGuildJoinsRepository.ts` — CC-13 conflict predicate
- `applications/server/src/utils/resolveOrCreateAcceptance.ts` — **create** (CC-14, shared with PR-5)
- `applications/server/src/api/invite.ts` — enqueue, idempotent re-join, ownership check
- `applications/server/src/api/auth.ts` — widen the requeue condition (S5)
- `applications/web/src/components/pages/InvitePage.tsx` — split the join callback
- `applications/web/src/routes/invite.$code.tsx` — implement the two callbacks
- `applications/server/test/Invite.test.ts` — extend

**Steps**

1. **Repository — `findOpenByUserAndInvite(userId, teamInviteId)`.** `SqlSchema.findOneOption`,
   `Result: InviteAcceptance.InviteAcceptance`:
   ```sql
   SELECT * FROM invite_acceptances
   WHERE user_id = ${userId} AND team_invite_id = ${teamInviteId}
     AND discord_code_error_code IS NULL
   ORDER BY created_at DESC
   LIMIT 1
   ```
   "Open" = not terminally failed and, if a code was already minted, not expired (BLOCKER 2, third
   review of PR-4 — see the amendment below). Uses `idx_invite_acceptances_user_id`, which now ships
   in PR-4 itself (`packages/migrations/src/before/1790600000_invite_acceptances_user_id_index.ts`),
   not PR-3 — see should-fix 3's amendment above.
   Also add `countRecentByUserAndInvite(userId, teamInviteId)` — `SELECT count(*) ... WHERE user_id
   = $1 AND team_invite_id = $2 AND created_at > now() - interval '1 hour'` — for CC-14's rate
   limit. BLOCKER 1 (third review of PR-4): scoped to the (user, invite) pair, not just the user —
   see the amendment below; the original pseudocode below (`countRecentByUser(userId, ...)`) was
   the bug.
2. **Repository — `_enqueue` (line 18-26).** Append `WHERE pending_guild_joins.status <> 'done'` to
   the `DO UPDATE` (CC-13).
3. **`applications/server/src/utils/resolveOrCreateAcceptance.ts` (new).** `Effect.Do.pipe`, per
   `AGENTS.md` (helpers are not repositories — no `Effect.gen`). Signature
   `(userId, invite: TeamInvite) => Effect<InviteAcceptance, ...>` implementing CC-14's pseudocode,
   AMENDED by BLOCKER 1 (third review of PR-4) to scope the count to this invite, not just the
   user:
   - `findOpenByUserAndInvite` → `Some` → return it, create nothing.
   - `None` → `countRecentByUserAndInvite(userId, invite.id, '1 hour')`; `>= 3` → return the newest
     row for this (user, invite) unchanged (`findNewestByUserAndInvite`, add it alongside), logging
     at info; `< 3` → `acceptances.create({ team_invite_id, user_id })`.
   - Because the count and the newest-row lookup are scoped to the same (user, invite) pair,
     hitting the cap PROVES a newest row exists — `findNewestByUserAndInvite` returning `None` here
     is an invariant violation, not a legitimate state, and is a defect (`LogicError.die`), not a
     silently-absent acceptance.
   - Return a discriminated result `{ acceptance: InviteAcceptance, created: boolean, rateLimited:
     boolean }` (no longer `Option<InviteAcceptance>` — see the amendment above) so callers can
     decide whether to enqueue and what to log.
   PR-5 imports this module unchanged. **This is the only place in the codebase allowed to call
   `acceptances.create` after PR-4.**
4. **`invite.ts` prelude.** Add `Effect.bind('pendingGuildJoins', () => PendingGuildJoinsRepository.asEffect())`
   to the `InviteApiLive` prelude (line 24-30) and destructure at line 30.
5. **`joinViaInvite` — one path for new and returning members, and it composes with step 6.**

   Rev 2 replaced the `AlreadyMember` failure (line 67) with a *short-circuit* that returned early —
   which skipped the enqueue tap added further down the pipeline, so the retry click never
   re-enqueued the guild join. **Do not short-circuit.** Restructure so both cases run the same tail:
   ```
   Effect.bind('existing', ...)                       // unchanged membership lookup
   Effect.bind('membership', ({ existing }) =>
     Option.isSome(existing) && existing.value.active
       ? Effect.succeed(existing.value)               // returning member: no insert
       : createOrReactivateMembership(...))           // today's path
   Effect.tap(({ membership, playerRole }) => members.assignRole(...))   // ON CONFLICT DO NOTHING
   Effect.bind('resolved', ({ user, invite }) => resolveOrCreateAcceptance(user.id, invite))
   Effect.let('requiresReauth', ...)                  // unchanged, line 99
   Effect.tap(({ user, invite, requiresReauth }) => ...enqueue...)       // step 6, always reached
   Effect.map(({ resolved, requiresReauth, ... }) => new Invite.JoinResult({
     acceptanceId: resolved.acceptance.id, requiresReauth, ... }))
   ```
   `Invite.AlreadyMember` is **no longer raised** (CC-14). Leave the error declared in the domain for
   wire compatibility.
6. **`joinViaInvite` — enqueue (S4).** After `members.assignRole` and **after**
   `Effect.let('requiresReauth', ...)` (line 99) — the ordering is a hard constraint:
   ```ts
   Effect.tap(({ user, invite, requiresReauth }) =>
     requiresReauth
       ? Effect.logInfo('[invite/join] skipping pending_guild_joins enqueue — missing guilds.join')
       : pendingGuildJoins.enqueue(user.id, invite.team_id),
   ),
   ```
   This is the **only** production call site of `enqueue`. It fires from an explicit Join click — and,
   because of step 5, it now also fires on the idempotent re-join, which is the point: a returning
   member whose auto-join previously failed gets re-queued by clicking Join again.
7. **`getJoinStatus` — ownership check.** Today (`invite.ts:128`) it looks the acceptance up by id and
   returns it to **any** authenticated caller — so anyone holding an `acceptanceId` gets a working
   one-time Discord invite to a server they were never invited to. Add
   `Effect.bind('user', () => Auth.CurrentUserContext.asEffect())` and fail `InviteNotFound` (404,
   not 403 — do not confirm existence) when `acc.user_id !== user.id`.
8. **`auth.ts` — widen the requeue condition (CC-6/S5).** `auth.ts:165-172` gates
   `requeueFailedForUser` on `hasScopeNow && !hadScopeBefore`. The dominant auto-join failure is a
   401 on an expired access token, and that user *already had* the scope — so the requeue never fires
   on the one login that just wrote a fresh token. Change the condition to `hasScopeNow` alone. Keep
   the `previousScopes` bind and keep the existing log line for the newly-granted case; add a second,
   quieter log for the token-refresh case. The underlying query is
   `WHERE user_id = $1 AND status = 'failed'`, so it is a no-op when there is nothing to requeue, and
   S4 still holds because only the user's own Join click could have created those rows.
9. **Web — split the callback.** `handleJoined` in `routes/invite.$code.tsx:26-44` **navigates away**
   (line 39 or 41), so "call `onJoined` even when `requiresReauth`" is unimplementable. Change the
   `InvitePageProps` contract:
   ```ts
   onJoinPersisted: (result: Invite.JoinResult) => void;  // setLastTeamId + setPendingDiscordJoin
   onJoinComplete:  (result: Invite.JoinResult) => void;  // navigate
   ```
   In `InvitePage.tsx:35-43`, call `onJoinPersisted(result)` **unconditionally**, then branch:
   `result.requiresReauth ? setRequiresReauth(true) : onJoinComplete(result)`. In
   `invite.$code.tsx`, `handleJoinPersisted` does the `setLastTeamId` + `setPendingDiscordJoin` half
   of today's `handleJoined` (lines 27-36) and `handleJoinComplete` does the navigate half
   (lines 37-42).
10. **Do NOT touch `routes/index.tsx`.** Rev 1's "drop `clearPendingInvite`" would create a permanent
    redirect loop: `redirectIfPendingInvite` (`routes/index.tsx:29-36`) does
    `Effect.tap(() => clearPendingInvite)` *then* redirects. It is also unnecessary — `handleSignIn`
    re-sets the pending invite at `invite.$code.tsx:48` on every re-auth click.

**Tests** — `applications/server/test/Invite.test.ts` (extend; the mock-repository harness already
includes `PendingGuildJoinsRepository` at lines 699 and 1251 — add an `enqueue` recorder, a `create`
recorder, and `findOpenByUserAndInvite` / `countRecentByUser` stubs to both).

1. `joinViaInvite enqueues a pending guild join when the user has guilds.join` — *fails before this PR*
2. `joinViaInvite does NOT enqueue when the user lacks guilds.join` — `requiresReauth: true`, recorder empty
3. `joinViaInvite is idempotent for an active member with an open acceptance` — 200 with the **existing** `acceptanceId`, not 409
4. **`the idempotent path with an open acceptance does not create a second acceptance`** — `create` recorder empty (CC-14)
5. **`the idempotent path DOES enqueue`** — pins the step-5/step-6 composition the review flagged; the `enqueue` recorder must have one entry for a returning member
6. **`an active member whose newest acceptance is terminally failed gets a NEW acceptance`** — `create` called once; returns the new id. *This is the regenerate primitive; it inverts rev 2's "still returns 409" test.*
7. **`an active member with no acceptance at all gets a new acceptance`** — the pre-feature cohort
8. **`the 4th regeneration within an hour reuses the newest row instead of creating`** — `countRecentByUser` stub returns 3; `create` recorder empty; no error raised
9. `joinViaInvite reuses an acceptance that already has a discord_code` — the link is still usable
10. `getJoinStatus returns 404 for another user's acceptance`
11. `getJoinStatus returns the acceptance for its owner`

`applications/server/test/integration/repositories/` (new or extended):

12. `findOpenByUserAndInvite returns the newest open row`
13. `findOpenByUserAndInvite skips rows with a discord_code_error_code`
14. **`enqueue does not reset a done row to pending`** (CC-13) — insert a `done` row, call `enqueue`, assert `status` is still `'done'`
15. `enqueue does requeue a failed row`
16. `countRecentByUser counts only rows inside the window`

`applications/server/test/Auth.test.ts` (extend):

17. **`a login with an unchanged guilds.join scope still requeues failed guild joins`** — pins S5; *fails before this PR*

Web — `applications/web/src/components/pages/InvitePage.test.tsx` (new or extended):

18. `calls onJoinPersisted and not onJoinComplete when requiresReauth is true`
19. `calls both when requiresReauth is false`
20. `renders the reauth card after a requiresReauth join`

**Deploy / rollout.** Server + web at one version; no bot change; no schema change (PR-3 already
shipped the `user_id` index). The `JoinResult` / `JoinStatus` wire shapes are unchanged, so an old web
bundle keeps working.

**Rollback.** Revert. `pending_guild_joins` rows created before the revert are drained harmlessly by
the already-deployed bot processor. If you want them stopped, cancel them to a **recoverable**
terminal state (CC-13 — rev 2's `SET status = 'done'` was permanently destructive, because `'done'`
is refused by `enqueue` forever and ignored by `requeueFailedForUser`):
```sql
UPDATE pending_guild_joins
SET status = 'failed', last_error = 'cancelled by PR-4 rollback', processed_at = now()
WHERE status = 'pending';
```
A later re-deploy plus one login revives exactly those rows via `requeueFailedForUser`.

**Watch after deploy (CC-6/S2).** `syncEventsProcessedTotal{sync_type="guild_join"}` versus
`pending_guild_joins` rows landing in `failed`. A high failure rate is **expected** for users whose
Discord access token has expired (>7 days since login) and is **not** a reason to revert — those
users fall through to the `discord.gg` link, which PR-5 makes durable. Also watch
`invite_acceptances` row growth: CC-14 permits creation, so a runaway would show here. The 3/hour cap
bounds it at 3 × active users; anything above that is a bug.

---

## PR-5 — durable link surface + the regenerate endpoint

**Goal.** Make the link survive a device change, a dismissal, and a week of not opening the app; stop
the banner from spamming empty error toasts; give every terminal state honest copy — **and give the
"Get a new invite" button something to call**.

**Rev 3 delta (blockers 1 and 4):** the regenerate endpoint moves *into* this PR (it was in "PR-5 or
PR-9", i.e. nowhere); `'expired'` is a `state`, not an `errorCode`, so the error copy is true the day
this ships; the redundant `errorCode` un-pin step is deleted; `'joined'` is dropped from the state
union until PR-8 provides a source that can be un-set (CC-15).

**Files**
- `packages/domain/src/api/Invite.ts` — `JoinStatus.state`, `getMyPendingDiscordJoin`, `regenerateMyDiscordInvite`
- `applications/server/src/api/invite.ts` — populate `state`, implement both endpoints
- `applications/server/src/repositories/InviteAcceptancesRepository.ts` — `findOpenByUserAndTeam`
- `applications/server/src/utils/joinStatusState.ts` — **create** (the one `state` helper)
- `applications/web/src/components/organisms/PendingDiscordJoinBanner.tsx` — server-sourced, silent, terminal
- `applications/web/src/components/pages/MyProfilePage.tsx` — persistent "Join the team Discord" row
- `packages/i18n/messages/en.json`, `packages/i18n/messages/cs.json`

**Steps**

1. **Domain — `JoinStatus.state`.**
   ```ts
   state: Schema.Literals(['preparing', 'ready', 'expired', 'failed'])
     .pipe(Schema.withDecodingDefaultKey(() => 'preparing')),
   ```
   The decoding default lets an old server's payload decode in a new browser. Keep `discordInviteUrl`
   and `errorCode` — they are what the currently deployed banner reads. **No `'joined'`** (CC-15):
   the only truthful source for that is `team_members.discord_joined_at`, which does not exist until
   PR-8, and `pending_guild_joins.status = 'done'` is permanently sticky. Until PR-8, "already in the
   guild" is expressed as `getMyPendingDiscordJoin → Option.none()`.
2. **`JoinStatus.errorCode` is NOT touched.** It stays pinned to `JoinStatusErrorCode` and
   `projectInviteErrorToWire` stays in place (CC-3). Rev 2's un-pin step was a no-op — the projection
   is applied at the read boundary, so un-pinning the client schema changed nothing the server sent.
   Deleted.
3. **Domain — `getMyPendingDiscordJoin`.**
   ```ts
   HttpApiEndpoint.get('getMyPendingDiscordJoin', '/teams/:teamId/me/discord-join', {
     success: Schema.OptionFromNullOr(JoinStatus),
     error: Forbidden.pipe(HttpApiSchema.status(403)),
     params: { teamId: TeamId },
   }).middleware(AuthMiddleware)
   ```
   This is what removes the localStorage dependency (designer §1 root cause 1).
4. **Domain — `regenerateMyDiscordInvite` (blocker 1 / CC-14).** Same path, `POST`:
   ```ts
   HttpApiEndpoint.post('regenerateMyDiscordInvite', '/teams/:teamId/me/discord-join', {
     success: Schema.OptionFromNullOr(JoinStatus),
     error: Forbidden.pipe(HttpApiSchema.status(403)),
     params: { teamId: TeamId },
   }).middleware(AuthMiddleware)
   ```
   Returning the **same shape** as the GET is deliberate: the client replaces its polled state with
   the response and keeps polling, with no second decode path and no new error tag.
5. **Repository — `findOpenByUserAndTeam(userId, teamId)`** — as PR-4's `findOpenByUserAndInvite` but
   joined through `team_invites ti ON ti.id = ia.team_invite_id` and filtered `ti.team_id = ${teamId}`,
   newest first.
6. **Server — `applications/server/src/utils/joinStatusState.ts` (new).** One pure helper used by
   both handlers, importing the window from `inviteExpiry.ts` (CC-4):
   - `discord_code` present → `'ready'` (+ `discordInviteUrl`). **This wins over everything** — a
     failed `pending_guild_joins` row is not an error if the link works (CC-6/S2).
   - `discord_code_error_code === 'expired'` → `'expired'`
   - any other `discord_code_error_code` → `'failed'` (+ the projected `errorCode`)
   - neither, and `created_at < now() - INVITE_ACCEPTANCE_DERIVED_EXPIRY_DAYS` → `'expired'`,
     **without writing** (the sweep is the writer, and its window is strictly smaller so it always
     gets there first — CC-4)
   - otherwise → `'preparing'`
7. **Server — `getMyPendingDiscordJoin`.** `requireMembership(members, teamId, currentUser.id, forbidden)`,
   then `findOpenByUserAndTeam`, then the helper. `Option.none()` when there is nothing pending.
8. **Server — `regenerateMyDiscordInvite`.** `requireMembership`, resolve the team's active invite
   (`teamInvites.findActiveByTeamId`; if there is none, return `Option.none()` — the UI then shows the
   "ask your captain" copy), then call **PR-4's `resolveOrCreateAcceptance` unchanged**, then the
   same `state` helper. Tap `pendingGuildJoins.enqueue` on the `created: true` branch only (S4 — this
   is an explicit user click). Rate limiting is inside `resolveOrCreateAcceptance` (CC-14); a
   rate-limited call returns the existing row and 200, not an error.
9. **Web — banner rewrite.**
   - Source from `api.invite.getMyPendingDiscordJoin` keyed on the active team; keep
     `getPendingDiscordJoin` (localStorage) only as an *initial* hint while the first request is in
     flight. Server always wins.
   - **Change the poll's error mapping from `ClientError.make('')` to `SilentClientError`**
     (`applications/web/src/lib/runtime.ts:32`). Today `runPromiseClient` (`runtime.ts:214-228`) fires
     `toast.error('')` on every `ClientError` — an **empty error toast every 2 seconds** while polling
     fails. `runtime.ts:221` explicitly swallows `SilentClientError`.
   - Stop the interval on `state === 'expired' | 'failed'` and after N consecutive request failures.
   - Distinct copy per `state`; for `'failed'`, per `errorCode` (designer §4.4 mapping for
     `welcome_channel_missing` / `welcome_channel_deleted` / `bot_missing_perms`). For `'expired'`,
     the designer's §4.2(a) "We need a fresh invite" copy **plus a working "Get a new invite" button**
     wired to `regenerateMyDiscordInvite` (step 4), which resumes polling on success.
   - `handleOpen` must **stop calling `clearPendingDiscordJoin()`** (designer §1 root cause 3) — one
     click on a blocked popup currently destroys the link forever.
10. **Web — `MyProfilePage`.** Add a persistent "Join the team Discord" row per team (designer §2.4,
    read-only form) reading `getMyPendingDiscordJoin`. The banner is dismissible and 24h-capped
    (`STALE_MS`); a non-ephemeral surface is required. Keep it simple — the full `DiscordConnectCard`
    is PR-9, and **PR-9 owns migrating or deleting this row** (CC-11; it is in PR-9's file list).
11. **i18n.** New keys in **both** `en.json` and `cs.json` (lockstep is mandatory), then
    `pnpm codegen && pnpm build` in `packages/i18n`, then call via `tr('key')` from
    `~/lib/translations.js` (never `m.key()` in web code). Reuse, do not duplicate:
    `invite_preparingDiscordInviteTitle`, `invite_preparingDiscordInviteDescription`,
    `invite_discordInviteFailedTitle`, `invite_discordInviteFailedDescription`,
    `invite_joinDiscordButton`. New: `discord_connect_expiredTitle`, `discord_connect_expiredBody`,
    `discord_connect_regenerateButton`, `discord_connect_noLinkTitle`, `discord_connect_noLinkBody`,
    `discord_connect_error_captainAction`, `discord_connect_error_botPerms`,
    `discord_connect_error_generic` (values in designer §10).

**Tests**

`applications/server/test/Invite.test.ts`:
1. `getJoinStatus returns state 'preparing' when neither code nor error is set and the row is fresh`
2. `getJoinStatus returns state 'ready' with a discord.gg URL when discord_code is set`
3. `getJoinStatus returns state 'failed' with errorCode when marked bot_missing_perms`
4. **`getJoinStatus returns state 'expired' and errorCode None for an expired row`** — pins CC-3
5. **`getJoinStatus returns 'ready', not 'failed', when the guild join failed but a discord_code exists`** — pins CC-6
6. `getJoinStatus derives state 'expired' for an un-swept aged row` — pins CC-4's defensive guard
7. `getMyPendingDiscordJoin returns None when the caller has no open acceptance for the team`
8. `getMyPendingDiscordJoin returns 403 for a non-member`
9. `getMyPendingDiscordJoin never returns another user's acceptance`
10. **`regenerateMyDiscordInvite creates a new acceptance when the newest is expired`** — returns state `'preparing'`
11. **`regenerateMyDiscordInvite reuses the open acceptance and creates nothing when one exists`**
12. **`regenerateMyDiscordInvite returns 200 and the existing row when rate-limited`** — no error tag
13. `regenerateMyDiscordInvite enqueues a pending guild join only when it created a row`
14. `regenerateMyDiscordInvite returns 403 for a non-member`
15. `regenerateMyDiscordInvite returns None when the team has no active invite`

`applications/web/src/components/organisms/PendingDiscordJoinBanner.test.tsx` (**new**). Pattern:
`OutstandingPaymentsBanner.test.tsx` (module-mock `~/lib/translations.js`, `@tanstack/react-router`)
and `RulesProgressPanel.test.tsx` (documents mocking `useRun`).

16. `renders nothing when there is no pending join`
17. `renders the preparing state for state 'preparing'`
18. `renders the link for state 'ready'` — expect `<a href="https://discord.gg/abc123">`
19. `renders the failure copy for state 'failed' with errorCode welcome_channel_missing` — assert the *specific* message
20. **`renders the regenerate CTA for state 'expired' and calls regenerateMyDiscordInvite on click`** — the CTA now has an endpoint behind it (blocker 1); assert the API mock was called
21. `resumes polling after a successful regenerate`
22. `stops polling once a terminal state is reached` — fake timers, assert call count stops increasing
23. **`does not raise an error toast when polling fails`** — assert the `sonner` `toast.error` mock is never called
24. `prefers the server state over a stale localStorage entry`
25. `does not clear the stored join when the link is clicked`

**Deploy / rollout.** Domain rebuild (`pnpm build` in `packages/domain`) before typechecking.
Server must be live before the new web bundle calls the two new endpoints — but since both ship in one
release and the web falls back to localStorage + `getJoinStatus` on a 404, a brief window where web is
ahead of server is survivable. **Verify that fallback explicitly before merging.**

**Rollback.** Revert web + server together. The `state` field has a decoding default so a reverted
server's payload still decodes in any un-reverted browser. Acceptances created by the regenerate
endpoint before the revert are ordinary rows and drain normally.

---

## PR-6 — role mapping adoption (must merge and be live before anything emits)

**Goal.** Make `ensureMapping` adopt the guild's **existing** roles instead of creating duplicates —
without adopting a role that carries permissions, and without adopting a role the bot cannot assign.
This is the highest-blast-radius change in the plan and it ships alone.

**Rev 3 delta (blocker 5):** rev 2 matched by name against `discord_guild_roles`, which carries
neither `permissions` nor any way to know the bot's own position — so it could adopt an
`ADMINISTRATOR` role and hand guild admin to every `role:manage` holder, and its "highest position"
tiebreak maximised the chance of picking a role the bot cannot assign. Candidates now come from
`DiscordREST` in the bot. Rev 2's claims "No new RPC and no domain change is needed" and "bot-only"
both survive — the RPC is simply not the source any more.

**No dependency on PR-2.** `Guild/ListGuildRoles` exists in production today and, after this rewrite,
PR-6 does not use it. Start this in parallel with PR-2; it is the long pole for PR-7 **and** PR-8.

**Files**
- `applications/bot/src/rest/roles/ensureMapping.ts` — adopt before create
- `applications/bot/src/rest/roles/adoptableGuildRole.ts` — **create** (the pure selection rule)
- `applications/bot/src/rest/roles/createGuildRole.ts` — unchanged (still the last resort)
- `applications/bot/test/rest/roles/adoptableGuildRole.test.ts` — **create**
- `applications/bot/test/rest/roles/ensureMapping.test.ts` — **create**

**Steps**

0. **Pre-merge check: is `discord_guild_roles` actually populated?** PR-7's and PR-9's diagnostics
   read it, and `guildCreate.ts:49-51` **returns early on an empty `guild.roles` payload**
   (`const roles = guild.roles ?? []; if (roles.length === 0) return Effect.void;`) — so a guild whose
   `GUILD_CREATE` arrived without roles silently keeps a stale table forever, with no error and no
   log. Run before merging:
   ```sql
   SELECT b.guild_id, b.guild_name, count(r.role_id) AS roles
   FROM bot_guilds b
   LEFT JOIN discord_guild_roles r ON r.guild_id = b.guild_id
   GROUP BY 1, 2 HAVING count(r.role_id) = 0;
   ```
   Any row here is a guild whose role list the server has never seen. This does **not** block PR-6
   (which reads Discord directly) but it does block PR-9's reporting, so file it either way. While
   you are in the file: change the early return to `Effect.logWarning(...)` so the next occurrence is
   visible.

1. **`adoptableGuildRole.ts` — a pure function, no Effect, fully unit-testable.**
   ```ts
   export const pickAdoptableRole = (
     roles: ReadonlyArray<{ id: string; name: string; permissions: string; position: number; managed: boolean }>,
     roleName: string,
     botTopPosition: number,
   ): Option.Option<{ id: string; position: number }>
   ```
   A candidate must satisfy **all four**:
   - `role.name === roleName` — exact, **case-sensitive, no trim**. Discord role names are
     case-sensitive; a fuzzy match that adopts the wrong role is worse than creating a new one.
   - `role.managed === false` — bot/integration-owned roles cannot be assigned by us.
   - `role.permissions === '0'` — a **strict string compare against the zero bitfield**, not a mask
     test. `createGuildRole.ts:16` deliberately creates with `permissions: 0`; adoption must preserve
     that guarantee or `handleAssigned.ts` → `addGuildMemberRole` becomes a privilege-escalation
     primitive (a guild's own `Captain` role frequently carries `ADMINISTRATOR`). Rejecting *any*
     non-zero permission is intentionally conservative: it is trivially auditable, it has no bitmask
     edge cases, and the fallback (create a fresh empty role) is safe.
   - `role.position < botTopPosition` — Discord rejects assigning a role at or above the bot's highest
     role with `50013`, and (CC-0) that failure lands in `role_sync_events.error` where nothing
     retries it.

   Among survivors take the **lowest `position`** — furthest below the bot, so the smallest chance of
   a later hierarchy change invalidating the mapping. (Rev 2 took the highest, which maximised it.)
   Return `None` when nothing qualifies, and have the caller log, at warning, the name plus the ids
   and rejection reason of every near-miss (name matched but failed a rule) — that log is how a
   captain finds out why Sideline created a second "Captain" role.

2. **`ensureMapping` — three-tier resolution.** The current chain is `Role/GetMapping` →
   `Effect.catchTag('NoSuchElementError', () => createGuildRole(...))` at line 21. Insert a tier
   between them:
   1. `rpc['Role/GetMapping']({ team_id, role_id })` → `Some` → use it (unchanged)
   2. adopt:
      - `rest.listGuildRoles(guildId)` → `ReadonlyArray<GuildRoleResponse>`, which carries
        `permissions: string`, `position: number`, `managed: boolean` (dfx
        `DiscordREST/Generated.d.ts` `GuildRoleResponse`, `listGuildRoles`)
      - `rest.getMyGuildMember(guildId)` → `PrivateGuildMemberResponse.roles: ReadonlyArray<string>`;
        `botTopPosition` = the max `position` over the guild roles whose id is in that array
        (default `-1` if the lookup fails, which makes `pickAdoptableRole` return `None` and falls
        through to create — fail-safe)
      - `pickAdoptableRole(...)` → `Some` → `rpc['Role/UpsertMapping']({ team_id, role_id,
        discord_role_id })` → return that id
   3. `None`, or **any** failure in tier 2 → `createGuildRole(teamId, roleId, guildId, roleName)`
      (unchanged). Catch `HttpClientError` / `RatelimitedResponse` / `ErrorResponse` around the two
      REST calls and log; a Discord hiccup must not strand the event, and creating a fresh empty role
      is always safe.

   Cache the two REST results per `(guildId)` for the duration of one processor tick if the role loop
   turns out to be chatty — `ProcessorService.ts:74` drains at `concurrency: 1`, so a naive
   implementation issues two extra REST calls per event. A simple `Map` keyed on guild id, built at
   the top of `processTick`, is sufficient; do not add a service for it.

3. **Report-only pass first.** Before the behaviour change merges, run a read-only script (or a
   one-shot log line behind a config flag) that, for every team, lists each Sideline role name and
   the `pickAdoptableRole` verdict — adopted id, or the rejection reason per near-miss. Attach the
   output to the PR. This is what turns "we think this adopts the right roles" into evidence, and it
   is the only place the `permissions === '0'` rule gets validated against real guilds before it can
   grant anything.

4. **Staleness note.** Adoption reads Discord live, so it has no staleness problem. The *server's*
   `discord_guild_roles` copy does (step 0) — but nothing in PR-6 depends on it.

**Tests**

`applications/bot/test/rest/roles/adoptableGuildRole.test.ts` (**new**, pure, no Effect):
1. `adopts an exact-name, unmanaged, zero-permission role below the bot`
2. **`refuses a role with non-zero permissions`** — `permissions: '8'` (ADMINISTRATOR) named "Captain" → `None`. *This is blocker 5(a)'s regression test.*
3. **`refuses a role at or above the bot's top position`** — `position: botTop` → `None`, and `position: botTop + 1` → `None`
4. **`picks the LOWEST position when names collide`** — two valid "Player" roles at 3 and 9 → picks 3. *Inverts rev 2's rule.*
5. `refuses a managed role`
6. `is case-sensitive` — guild has "captain", Sideline has "Captain" → `None`
7. `returns None for an empty role list`

`applications/bot/test/rest/roles/ensureMapping.test.ts` (**new**). Pattern:
`applications/bot/test/rcp/roleProvision/handleProvisionRole.test.ts` (`Layer.succeed` recorders for
`DiscordREST` and `SyncRpc`).
8. `returns the cached mapping without any Discord call` — `Role/GetMapping` returns `Some`; assert `listGuildRoles`, `getMyGuildMember` and `createGuildRole` are all untouched
9. **`reuses an existing guild role with the same name`** — mapping miss; `listGuildRoles` returns a valid candidate; assert `Role/UpsertMapping` called with its id and `rest.createGuildRole` **never called**
10. `creates a role when no name matches`
11. **`creates a role rather than adopting an ADMINISTRATOR role of the same name`** — end-to-end form of test 2
12. `falls back to createGuildRole when listGuildRoles fails`
13. `falls back to createGuildRole when getMyGuildMember fails` — `botTopPosition` unknown must never adopt
14. `logs a warning naming every near-miss and its rejection reason`

**Deploy / rollout.** Bot-only. No domain change, no server change, no migration. **Merge and deploy
this before PR-7 reaches production** — that is the entire reason it is its own PR. Since
`role_sync_events` is empty (root cause D), this PR is a **no-op in production on the day it ships**;
it is pure preparation. That is intentional and is the safest possible way to land it.

**Rollback.** Revert. Any `discord_role_mappings` rows written by the adoption path point at
**pre-existing, zero-permission, assignable** guild roles and are correct under the old code too, so
they can stay.

---

## PR-7 — role emission (root cause D) + manual role sync

**Goal.** Make the server actually emit role sync events — the thing root cause D says it has never
done — and give captains a button that pushes a member's Sideline roles into Discord.

**Rev 3 delta (blocker 6):** rev 2 diagnosed root cause D and then never fixed it. `emitRoleAssigned`
/ `emitRoleUnassigned` / `emitRoleCreated` / `emitRoleDeleted` have **zero callers** outside
`RoleSyncEventsRepository.ts` itself; `role.ts:227` `assignRole` writes `member_roles` plus a
notification and stops; `unassignRole` (line 277) writes only the DELETE; `createRole` (line 50) and
`deleteRole` (line 165) likewise. PR-7 added a button and PR-8 added a guild-join trigger — **neither
touched `role.ts`** — so after all nine PRs a captain assigning a role in the web UI would still get
no Discord propagation. The four `emit*` calls are added here, gated on PR-6 exactly like the button,
so there is no extra sequencing cost. Also: `removedCount` is computed for real (CC-8), and the
result DTO ships in its final shape once (CC-8) instead of being replaced in PR-9.

**Files**
- `packages/domain/src/api/RoleApi.ts` — endpoint + `SyncMemberRolesResult` + `DiscordSyncErrorCode`
- `applications/server/src/utils/syncMemberDiscordRoles.ts` — **create**
- `applications/server/src/repositories/TeamMembersRepository.ts` — effective-roles query
- `applications/server/src/repositories/DiscordRolesRepository.ts` — `listMappingsByTeam`
- `applications/server/src/api/role.ts` — **the four missing `emit*` calls** + the sync handler
- `applications/web/src/components/pages/PlayerDetailPage.tsx` — the button
- `applications/web/src/routes/(authenticated)/teams/$teamId/members.$memberId.tsx` — wire it
- `packages/i18n/messages/{en,cs}.json`

**Steps**

1. **`role.ts` — emit. This is root cause D's actual fix and it comes first.**
   `RoleApiLive`'s prelude gains `RoleSyncEventsRepository` (and `ChannelSyncEventsRepository`, for
   step 4). Then, in each handler, as a **best-effort tap that can never fail its caller** — use
   `Effect.catchCause((cause) => Effect.logWarning('...', cause))` per `AGENTS.md` error-handling rule
   6, which names exactly this case ("emitting sync events alongside a primary write"):
   - **`assignRole`** — after `Effect.tap(() => members.assignRole(memberId, payload.roleId))`
     (line 227), `roleSyncEvents.emitRoleAssigned(teamId, role.id, role.name, memberId, discordId)`.
     `targetMember` is already bound from `members.findRosterMemberByIds`; if it does not expose
     `discord_id`, add it to that query's `Result` (a select-list change, no wire impact). Skip the
     emit when the member has no `discord_id`.
   - **`unassignRole`** — the mirror after `members.unassignRole(memberId, roleId)` (line 277), using
     `emitRoleUnassigned`.
   - **`createRole`** (line 50) — `emitRoleCreated(teamId, role.id, role.name)` after the insert.
   - **`deleteRole`** (line 165) — `emitRoleDeleted(teamId, roleId, role.name)` after
     `roles.archiveRoleById(roleId)` (line 189). Capture `role.name` **before** archiving.
   `_emitIfGuildLinked` (`RoleSyncEventsRepository.ts:81-96`) already no-ops for a team with no
   `guild_id`, so a team without Discord costs one `SELECT` and writes nothing.
2. **Domain — `RoleApi.ts`.** Ship the final result shape now (CC-8):
   ```ts
   export const DiscordSyncErrorCode = Schema.Literals([
     'retryable', 'captain_action', 'user_action', 'unknown',
   ]);

   export class SyncMemberRolesResult extends Schema.Class<SyncMemberRolesResult>('SyncMemberRolesResult')({
     addedCount: Schema.Number,     // role_assigned events enqueued
     removedCount: Schema.Number,   // role_unassigned events enqueued
     skippedCount: Schema.Number,   // 1 when the member has no discord_id, else 0
     roleSyncState: Schema.Literals(['queued', 'ok', 'failed', 'never']),
     lastRoleSyncAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
     lastRoleSyncError: Schema.OptionFromNullOr(DiscordSyncErrorCode),
   }) {}

   HttpApiEndpoint.post('syncMemberDiscordRoles', '/teams/:teamId/members/:memberId/sync-discord-roles', {
     success: SyncMemberRolesResult,
     error: [Forbidden.pipe(HttpApiSchema.status(403)), MemberNotFound.pipe(HttpApiSchema.status(404))],
     params: { teamId: TeamId, memberId: TeamMemberId },
   }).middleware(AuthMiddleware)
   ```
   In PR-7 `roleSyncState` is always `'queued'` and the two `last*` fields are `Option.none()`; PR-8
   and PR-9 fill them in **without changing the DTO, the copy, or the i18n keys**. `role_sync_events`
   and `discord_role_mappings` are both empty and no user has ever seen a role-sync result, so there
   is no client to migrate — shipping `GroupApi.SyncRoleMembersResult` here and replacing it in PR-9
   would be a wire migration for zero clients (over-engineering cut). The four-bucket
   `DiscordSyncErrorCode` is CC-8's decision; do not ship nine codes that map to three remedies.
3. **Repository — effective roles.** `TeamMembersRepository.ts:104-121` already computes the exact
   set (`member_roles` UNION roles inherited through `group_members` → recursive group ancestry →
   `role_groups`) but `string_agg`s them into `role_names`. Add a **sibling** query
   `findEffectiveRoleIdsForMember(teamMemberId)` returning `(role_id, role_name)` rows using the same
   UNION/LATERAL/RECURSIVE body. Do **not** refactor the existing query.
4. **Repository — `listMappingsByTeam(teamId)`** on `DiscordRolesRepository`:
   `SELECT role_id, discord_role_id FROM discord_role_mappings WHERE team_id = $1`. This is what makes
   `removedCount` real.
5. **`syncMemberDiscordRoles.ts`** — a plain helper (`Effect.Do.pipe`, not a repository). Model on
   `applications/server/src/utils/emitGroupRoleBackfill.ts`. Signature
   `(teamId, teamMemberId) => Effect<SyncMemberRolesResult, ...>`:
   - resolve the member's `discord_id`; `None` → return `{added: 0, removed: 0, skipped: 1,
     roleSyncState: 'never', ...}` and emit nothing
   - `desired` = `findEffectiveRoleIdsForMember`
   - `managed` = `listMappingsByTeam(teamId)` — the set of Sideline roles this team has a Discord
     mapping for
   - **added** = every role in `desired` → `emitRoleAssigned`
   - **removed** = every role in `managed` **not** in `desired` → `emitRoleUnassigned`.
     **Restrict removal to `managed`** — never emit an unassign for a Discord role Sideline does not
     own, or the sync starts stripping roles captains granted by hand in Discord. State this
     explicitly in the doc comment and in the risk register.
   - group-derived Discord channel membership: mirror
     `channelSync.emitMembersAddedBatch({ teamId, entries })` exactly as `group.ts:1035` does
   - `_emitIfGuildLinked` no-ops when the team has no `guild_id`, so a team without Discord returns
     all-zero without an error
   - **Cap the fan-out** at a constant (e.g. 25 emissions per member) and log when it trips
6. **`role.ts` — the sync handler.** Follow the `assignRole` prelude verbatim (`role.ts:197-213`):
   `Auth.CurrentUserContext` → `requireMembership` → `requirePermission(membership, 'role:manage', forbidden)`
   → `members.findRosterMemberByIds(teamId, memberId)` with
   `onNone: () => Effect.fail(new RoleApi.MemberNotFound())` → call the helper.
7. **Web.** Add a "Sync Discord roles" `Button variant='ghost' size='sm'` with a `RefreshCw` icon in
   the header of the `roles_currentRoles` card in `PlayerDetailPage.tsx` (mirroring the existing
   `handleStartEditing` ghost button in that header), gated on `canManageRoles`, wired through
   `members.$memberId.tsx` next to `handleAssignRole` (line 177). Client-side **debounce + 60 s
   cooldown** (designer §5.4): a captain clicking this on 40 members otherwise serialises hundreds of
   Discord calls through the `concurrency: 1` role loop
   (`applications/bot/src/rcp/role/ProcessorService.ts:74`).
8. **i18n.** `discord_syncRolesFor`, `discord_syncing`, `discord_syncCooldown`,
   `discord_syncQueuedResult` ("Queued {added} additions and {removed} removals." / "Zařazeno
   {added} přidání a {removed} odebrání."), and the four `DiscordSyncErrorCode` strings. These are the
   **final** keys — PR-9 reuses them and adds only `discord_syncLastSyncedRelative`.

**Tests**

`applications/server/test/api/role.emit.test.ts` (**new** — root cause D's regression tests):
1. **`assignRole emits a role_assigned event`** — recorder has one entry with the member's `discord_id`. *Fails before this PR; this is root cause D.*
2. **`unassignRole emits a role_unassigned event`**
3. **`createRole emits a role_created event`**
4. **`deleteRole emits a role_deleted event with the role name captured before archiving`**
5. `assignRole does not emit when the member has no discord_id`
6. `assignRole still succeeds when the emit fails` — make the recorder fail; assert 200 and a logged warning (pins the `Effect.catchCause` best-effort contract)

`applications/server/test/api/role.syncDiscordRoles.test.ts` (**new**):
7. `403 for a member without role:manage`
8. `404 MemberNotFound for a member of another team`
9. `queues one role_assigned event per effective role and returns addedCount`
10. `includes group-inherited roles` — member in a child group whose ancestor carries a role
11. **`queues role_unassigned for a mapped role the member no longer has, and reports removedCount`** — pins CC-8's "removedCount is real"
12. **`never queues role_unassigned for a Discord role with no mapping`** — the anti-stripping guard
13. `returns skippedCount: 1 and queues nothing for a member with no discord_id`
14. `returns all zero and queues nothing when the team has no guild_id`
15. `is safe to call twice` — the bot's `PUT`/`DELETE` role calls are idempotent
16. `caps the fan-out at the configured maximum`

`applications/server/test/integration/repositories/RoleSyncEventsRepository.test.ts` (**new**):
17. `emitRoleAssigned inserts a row that findUnprocessed returns`
18. `emitRoleAssigned inserts nothing when the team has no guild_id` (the `lookupGuildId` `onNone` branch at line 96)
19. `findEffectiveRoleIdsForMember returns direct and group-inherited roles without duplicates`

Web:
20. `PlayerDetailPage renders the sync button only with role:manage`
21. `the button is disabled during the cooldown`
22. `renders discord_syncQueuedResult with both counts`

**Deploy / rollout.** **PR-6 must be live in production**, not merely merged — this is the first PR
that can put a row in `role_sync_events`, and without PR-6 the bot would create duplicate roles in
every guild (CC-7). Domain rebuild before typecheck. Roll out server + web together.

**Expect a burst on the first captain action, not on deploy.** Step 1 emits only on an explicit
role change; step 6 only on an explicit button click. Nothing fires at startup.

**First-use protocol.** After deploy, assign one role to **one** member of **one** internal team via
the web UI and verify in Discord that the member received the *existing* role and that no new role
appeared in the guild's role list. Then click the sync button on that member. Only then announce.

**Rollback.** Revert web + server. Rows already in `role_sync_events` will still be drained by the
bot; to stop them,
`UPDATE role_sync_events SET processed_at = now(), error = 'cancelled' WHERE processed_at IS NULL`.
(That is safe *as a rollback* precisely because PR-8 makes the pipeline level-based — the next
reconciliation re-derives whatever was cancelled.)

**Watch.** `syncEventsProcessedTotal{sync_type="role"}`, the guild's role count, and
`SELECT count(*) FROM role_sync_events WHERE error IS NOT NULL`.

---

## PR-8 — level-based role reconciliation on guild join

**Goal.** Close the reporter's actual case — "user joined Sideline via web, then later joined
Discord, and gets nothing" — with a trigger that is **self-healing**, fires **zero** events in steady
state, and covers pre-existing members.

**Rev 3 delta (blockers 7 and 8, CC-10):** rev 2's design was two edge gates — a one-shot
`NULL → set` transition on `discord_joined_at`, plus `source !== 'reconcile'`. Both are removed.
- Blocker 7: during the rollout window (server on PR-8, bot still on PR-7) a real `GUILD_MEMBER_ADD`
  arrives with no `source`; `withDecodingDefaultKey(() => 'reconcile')` makes it `'reconcile'`; step 6
  set the timestamp anyway (the `complete` gate was on `ReconcileMembers`, not `RegisterMember`) and
  step 7 suppressed the emission. The transition is consumed, can never fire again, and that member
  is **permanently un-synced** — the reporter's exact bug, silently recreated.
- Blocker 8: `Role/MarkEventFailed` sets `processed_at = now()`
  (`RoleSyncEventsRepository.ts:79`) while `findUnprocessed` selects `WHERE processed_at IS NULL`
  (line 63). One 429, one restart mid-batch, one transient 5xx, and the event is gone forever — with
  the only recovery being PR-7's per-member button, on a 60 s cooldown, for a member nobody knows is
  broken.

Both are fixed by the same change: **emit the diff, not the edge.**

**Files**
- `packages/migrations/src/before/<ts>_add_discord_member_state.ts` — **create**
- `packages/domain/src/rpc/guild/GuildRpcGroup.ts` — `source` on `RegisterMember`, `complete` on `ReconcileMembers`
- `applications/bot/src/events/guildCreate.ts` — paginate members, pass `complete`
- `applications/bot/src/events/index.ts` — pass `source` at the `Guild/RegisterMember` call site (**line 261**; note there is **no `guildMemberAdd.ts`** — the `GuildMemberAdd` dispatch is inline at `events/index.ts:124`, which rev 2's file list got wrong)
- `applications/server/src/rpc/guild/index.ts` — timestamps, `members_backfilled_at`, the diff
- `applications/server/src/utils/reconcileMemberDiscordRoles.ts` — **create**
- `applications/server/src/repositories/TeamMembersRepository.ts` — `markDiscordJoined` / `clearDiscordJoined`

**Steps**

1. **Migration.**
   ```sql
   ALTER TABLE team_members ADD COLUMN discord_joined_at TIMESTAMPTZ;
   CREATE INDEX idx_team_members_discord_not_joined
     ON team_members(team_id) WHERE discord_joined_at IS NULL;

   -- Moved here from PR-9 (review nit): this column is written by Guild/ReconcileMembers, which is
   -- PR-8's RPC, and PR-9's file list omitted it entirely. It belongs with its writer.
   ALTER TABLE bot_guilds ADD COLUMN members_backfilled_at TIMESTAMPTZ;
   ```
   `discord_joined_at` is nullable with no default — `NULL` means **unknown**, the tri-state the
   designer's §3.6 requires and a boolean cannot express. **It no longer gates emission** (CC-10);
   its only consumer is PR-9's `UserTeam.discordJoined`. That is what makes writing it idempotent and
   makes blocker 7's "timestamp consumed" failure mode structurally impossible.
2. **Domain — `Guild/RegisterMember` gains `source` as an `Option` (blocker 7).**
   ```ts
   source: Schema.OptionFromOptionalNullOr(
     Schema.Literals(['member_add', 'reconcile', 'interaction']),
   ),
   ```
   `Option.none()` means **unknown**, not `'reconcile'`. On `None` the server does not set
   `discord_joined_at` and does not run the diff — it logs at debug and returns. `ReconcileMembers`
   supplies `'reconcile'` explicitly server-side, so `None` can only come from a bot older than PR-8,
   and that member is picked up on the very next reconcile from an upgraded bot (minutes later, at
   the next gateway connect) rather than never. **Do not use `withDecodingDefaultKey`** here: a
   default is exactly what made absence indistinguishable from a real reconcile.
3. **Domain — `Guild/ReconcileMembers` gains `complete`.**
   `complete: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(() => false))` — conservative: an old
   bot's payload is treated as possibly-truncated. `complete` gates **only** `discord_joined_at` and
   `bot_guilds.members_backfilled_at`; it does **not** gate the diff, which is per-member and correct
   even on a partial page.
4. **Bot — paginate (S6).** `guildCreate.ts:70` currently does
   `rest.listGuildMembers(guild.id, { limit: 1000 })` — one page, no cursor. Replace with a loop:
   request `{ limit: 1000, after: lastId }` until a page returns `< 1000` rows or a 10-page cap is
   hit; concatenate; set `complete: true` only if the loop terminated on a short page. Keep the
   existing `Effect.catchTag([...], logError)` wrapper so a failure still degrades to a log.
5. **Bot — pass `source`.** The `GuildMemberAdd` dispatch at `applications/bot/src/events/index.ts:124`
   calls `Guild/RegisterMember` at line 261 — pass `Option.some('member_add')`. Grep
   `'Guild/RegisterMember'` across `applications/bot/src` (today that call site is the only one) and
   cover every hit; any interaction-driven call passes `'interaction'`.
6. **Server — `reconcileMemberDiscordRoles.ts` (new). This is the whole PR.**
   `Effect.Do.pipe`, signature
   `(team, teamMember, actualDiscordRoleIds: ReadonlyArray<string>) => Effect<{added: number; removed: number}, ...>`:
   - `managed` = `discordRoles.listMappingsByTeam(team.id)` (PR-7 step 4) — `role_id → discord_role_id`
   - `desired` = `members.findEffectiveRoleIdsForMember(teamMember.id)` (PR-7 step 3), intersected
     with `managed`'s keys, projected to `discord_role_id`
   - `actual` = the payload's `roles`, **intersected with `managed`'s values** — Sideline never
     considers, adds, or removes a Discord role it does not own
   - emit `role_assigned` for `desired \ actual`, `role_unassigned` for `actual \ desired`
   - **In steady state both sets are empty and nothing is emitted.** That is the flood protection,
     and unlike rev 2's transition gate it holds on *every* gateway reconnect, not just the first.
   - Cap emissions per member (reuse PR-7's constant) and per `ReconcileMembers` call (e.g. 200 per
     guild per pass) so the first post-deploy backfill of a large guild drains over several
     reconnects instead of dumping thousands of events into a `concurrency: 1` loop. Log when either
     cap trips, including how many members were skipped.
7. **Server — wire it in (`applications/server/src/rpc/guild/index.ts`).**
   - `registerMember` (line 254): after resolving `newMember`, `Option.match` on `payload.source`:
     `None` → log at debug, do nothing more. `Some(_)` → `members.markDiscordJoined(newMember.id)`
     (idempotent — `SET discord_joined_at = COALESCE(discord_joined_at, now())`), then
     `reconcileMemberDiscordRoles(team, newMember, payload.roles)`.
   - Critically, this must run on the **`already active`** branch (`rpc/guild/index.ts:277-280`),
     which today only logs `Member … already active in team …` — **that branch is exactly the
     reporter's case**. Keep `setupNewMember` (line 93) untouched; it handles the opposite direction
     (Discord roles → Sideline).
   - `Guild/RemoveMember` (line 375): `members.clearDiscordJoined(m.id)` on the branch that
     deactivates **and** on the "already inactive" branch (line 460) — a user who left Discord is not
     in the guild regardless of Sideline membership state.
   - `Guild/ReconcileMembers` (line 479): pass `source: Option.some('reconcile')`; set
     `discord_joined_at` and `bot_guilds.members_backfilled_at = now()` only when `complete === true`;
     run the diff for every member **regardless** of `complete`.
8. **Self-healing is now structural, and `MarkEventFailed` needs no change.** A failed event is
   re-derived on the next reconcile (every gateway connect — i.e. every deploy and every reconnect)
   because the diff is computed from ground truth, not from queue state. Record this explicitly in
   the PR description: *the reason we are not adding an `attempts` column with backoff is that a
   level-based trigger makes retry counting unnecessary.* If, after this ships, the observed
   reconnect cadence turns out to be too slow to be a useful retry interval, the follow-up is a
   periodic server-side reconciliation cron over `bot_guilds` — but it needs a stored snapshot of
   each member's Discord roles to diff against between reconnects, which is a separate design and
   must not be smuggled into this PR.

**Tests** — `applications/server/test/rpc/RegisterMember.test.ts` (extend; the file already has the
full mock-repository harness and a `Guild/RegisterMember RPC — invite_code handling` describe block at
line 417):

1. `registerMember sets discord_joined_at on first observation when source is Some`
2. `registerMember does not overwrite an existing discord_joined_at`
3. `Guild/RemoveMember clears discord_joined_at`
4. **`emits role_assigned for each missing mapped role when an already-active member joins the guild`** — `source: Some('member_add')`, payload `roles: []`. *Fails before this PR; this is the reporter's case.*
5. **`emits nothing when the member's Discord roles already match their Sideline roles`** — the steady-state guarantee that replaces the transition gate
6. **`emits role_unassigned for a mapped Discord role the member should not have`**
7. **`never emits for a Discord role with no mapping`** — the anti-stripping guard
8. **`a second identical member_add for the same member emits nothing`** — idempotence without a transition gate
9. **`a payload with NO source field sets no timestamp and emits nothing`** — blocker 7's regression test; assert *both* recorders empty. *This is the test rev 2 could not have passed.*
10. **`re-running the same reconcile after a simulated MarkEventFailed re-emits the event`** — blocker 8's regression test: mark the event failed, reconcile again, assert the event is re-derived
11. `Guild/ReconcileMembers with complete: false runs the diff but sets no discord_joined_at`
12. `Guild/ReconcileMembers with complete: true sets discord_joined_at and bot_guilds.members_backfilled_at`
13. `Guild/ReconcileMembers stops emitting at the per-guild cap and logs how many members were skipped`
14. `skips role reconciliation when the user has no discord_id`
15. `still runs setupNewMember for a genuinely new member` — regression guard

Bot — `applications/bot/test/events/guildCreate.test.ts` (new or extended):
16. `paginates listGuildMembers with an after cursor until a short page`
17. `sets complete: true when the last page is short`
18. `sets complete: false when the page cap is hit`
19. `passes source 'member_add' from the GuildMemberAdd dispatch` (`events/index.ts:261`)

**Deploy / rollout.** Migration + domain + server + bot. **PR-6 and PR-7 must both be live.** The
migration runs at server startup (`docs/deployment.md` §2.2). `complete` has a conservative decoding
default and `source` is an `Option`, so container start order does not matter — an un-upgraded bot's
`RegisterMember` is simply ignored until the next reconcile.

**Expect one real burst, and size it first.** Unlike rev 2 (whose backfill was silent and therefore
left everyone un-synced), the first `GUILD_CREATE` after this deploy emits the **genuine** backlog:
every member × every mapped role they are missing. Before deploying, size it:
```sql
SELECT t.id, t.name, count(*) AS members
FROM team_members tm JOIN teams t ON t.id = tm.team_id
WHERE tm.active AND t.guild_id IS NOT NULL
GROUP BY 1, 2 ORDER BY 3 DESC;
```
Multiply by the team's mapped role count. The per-guild cap in step 6 bounds each pass; confirm the
cap × reconnect cadence gives an acceptable drain time and record it in the PR. Watch
`syncEventsProcessedTotal{sync_type="role"}` and `SELECT count(*) FROM role_sync_events WHERE
processed_at IS NULL`.

**Rollback.** Revert bot + server. **Do not simply "leave the column"** — rev 2's rollback note did,
and that jams the feature permanently on re-deploy, because rev 2's gate fired only on the
`NULL → set` transition and every row would already be set. Under rev 3 the diff is level-based so a
re-deploy is safe with the column populated, and the column can stay. If you nevertheless want the
tri-state reset (e.g. because a partial backfill wrote bad timestamps), pair the re-deploy with:
```sql
UPDATE team_members tm
SET discord_joined_at = NULL
WHERE tm.discord_joined_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM role_sync_events e
    WHERE e.team_member_id = tm.id AND e.processed_at IS NOT NULL AND e.error IS NULL
  );
UPDATE bot_guilds SET members_backfilled_at = NULL;
```
To stop emissions immediately without a deploy:
`UPDATE role_sync_events SET processed_at = now(), error = 'cancelled' WHERE processed_at IS NULL`
— safe, because the next reconcile re-derives anything still needed.

---

## PR-9 — enforcement, sync fidelity, and banner retirement

**Goal.** Ship the designer's soft gate (§3.1 rung 1), replace the banner with the durable card +
interstitial (CC-11), and fill in the fidelity fields PR-7's DTO already declares.

**Rev 3 delta:** this PR **shrinks**. The result DTO, the copy and the i18n keys shipped in PR-7
(CC-8), so 9b is now "populate three fields and add a classifier", not a wire migration.
`bot_guilds.members_backfilled_at` moved to PR-8's migration. `MyProfilePage.tsx` is in the file list
(CC-11 — rev 2 omitted it, leaving PR-5's row reading a state nothing else uses). `'joined'` joins
`JoinStatus.state` here, from `discord_joined_at` (CC-15). `DiscordSyncErrorCode` is the four-bucket
union from PR-7, not a new nine-code one.

Clean split if it must be cut: **9a** = surfaces + tri-state (`DiscordConnectCard`, interstitial, nav
badge, `UserTeam.discordJoined`, retire the banner); **9b** = the bot-side classifier + the three
fidelity fields; **9c** = the notification (CC-9, droppable).

**Files**
- `packages/migrations/src/before/<ts>_add_member_role_sync_state.ts` — **create** (9b)
- `packages/domain/src/api/Auth.ts` — `UserTeam.discordJoined`
- `packages/domain/src/api/Invite.ts` — `'joined'` on `JoinStatus.state`; `'bot_not_in_guild'` on `JoinStatusErrorCode`
- `packages/domain/src/rpc/role/RoleRpcGroup.ts` — `error_code` on `Role/MarkEventFailed` (9b)
- `packages/domain/src/models/Notification.ts` + `NotificationApi` — CC-9 expand/contract (9c)
- `applications/server/src/utils/inviteErrorWireProjection.ts` — drop the `bot_not_in_guild` mapping only; **keep** the `'expired' → None` collapse (CC-3)
- `applications/server/src/api/auth.ts` — populate `discordJoined` in `myTeams`
- `applications/server/src/api/invite.ts` — derive `'joined'` from `discord_joined_at`
- `applications/bot/src/rcp/role/errorClassifier.ts` — **create** (9b)
- `applications/bot/src/rcp/role/ProcessorService.ts` — use the classifier instead of `String(error)` (9b)
- `applications/web/src/components/atoms/DiscordIcon.tsx` — **create** (extract from `HomePage.tsx`)
- `applications/web/src/components/molecules/{DiscordConnectionBadge,SyncRolesButton}.tsx` — **create**
- `applications/web/src/components/organisms/DiscordConnectCard.tsx` — **create**
- `applications/web/src/components/pages/ConnectDiscordPage.tsx` — **create**
- `applications/web/src/components/pages/MyProfilePage.tsx` — migrate PR-5's row onto `DiscordConnectCard` (CC-11)
- `applications/web/src/routes/(authenticated)/teams/$teamId/connect-discord.tsx` — **create**
- `applications/web/src/routes/(authenticated)/teams/$teamId/index.tsx` — the redirect
- `applications/web/src/components/layouts/{AuthenticatedLayout,AppSidebar}.tsx` — retire banner, add nav item
- `applications/web/src/components/organisms/PendingDiscordJoinBanner.tsx` + `.test.tsx` — **delete** (CC-11)
- `applications/web/src/lib/auth/` — the snooze key helper
- `packages/i18n/messages/{en,cs}.json`

**Steps**

1. **Tri-state, and never gate on unknown.** `UserTeam` gains
   `discordJoined: Schema.Literals(['connected','not_connected','unknown']).pipe(Schema.withDecodingDefaultKey(() => 'unknown'))`.
   Not a boolean — the designer's §3.6 lockout analysis depends on `unknown` being distinguishable,
   and `unknown` renders **nothing**: no redirect, no card, no badge. Populate in `auth.myTeams` from
   `team_members.discord_joined_at` (PR-8): non-null → `'connected'`; null **and**
   `bot_guilds.members_backfilled_at IS NOT NULL` for the team's guild → `'not_connected'`; otherwise
   `'unknown'`. **A guild we failed to read must never be interpreted as "nobody is connected"**
   (designer §3.6 step 2). `members_backfilled_at` already exists — PR-8 added it.
2. **`JoinStatus.state` gains `'joined'` (CC-15).** Derived from `team_members.discord_joined_at`,
   the only source that is *cleared* when the user leaves the guild. `pending_guild_joins.status`
   stays queue-internal and is never read by a UI surface.
3. **Interstitial (CC-12).** Option (a): `routes/(authenticated)/teams/$teamId/connect-discord.tsx`
   with `ssr: false` and `validateSearch` for `next?: string`, rendered inside the sidebar shell.
   **Delete the "mirrors `/profile/complete`" framing from the design doc's §2.1 in the PR
   description.** Content per designer §2.1/§4: selectable `discord.gg` text + copy button (not a
   button-only design — in-app webviews and blocked popups are the common failure),
   `role='status' aria-live='polite'` status region, skeletons on load, "Skip for now", and the
   "Get a new invite" CTA wired to PR-5's `regenerateMyDiscordInvite`.
4. **Redirect.** In `routes/(authenticated)/teams/$teamId/index.tsx` `beforeLoad` (line 13-17),
   **after** the existing `isProfileComplete` redirect, `throw redirect({ to:
   '/teams/$teamId/connect-discord' })` when `discordJoined === 'not_connected' && !snoozed`.
   Dashboard index only — every other team route stays directly reachable.
5. **Snooze.** User-scoped localStorage key per `AGENTS.md` § "User-Scoped `localStorage` Keys":
   `sideline:discord-connect-snoozed:${userId}:${teamId}` = epoch ms. `try/catch` both `getItem` and
   `setItem`; **on throw, treat as snoozed** — never trap a user in a redirect loop because Safari
   private mode threw. 24 h for the first three skips, then 7 days. Snooze suppresses the **redirect
   only**; the card and badge are never suppressed.
6. **Retire the banner (CC-11).** Remove `<PendingDiscordJoinBanner />` from
   `AuthenticatedLayout.tsx:128`, delete the component and its test, **and migrate PR-5's
   `MyProfilePage` row onto `DiscordConnectCard`** so exactly one component reads exactly one state.
7. **Finish CC-3, partially.** Add `'bot_not_in_guild'` to `JoinStatusErrorCode` and delete that one
   mapping from `inviteErrorWireProjection.ts`. **Keep the file and the `'expired' → Option.none()`
   collapse** — `'expired'` is a state, not an error code, and that is permanent (CC-3). Rev 2's
   "delete the projection entirely" is wrong under rev 3.
8. **9b — sync fidelity.** PR-7 already shipped the DTO, the copy and the i18n keys; this only makes
   the values true.
   - Migration: `team_members` gains `last_role_sync_at TIMESTAMPTZ`,
     `last_role_sync_state TEXT`, `last_role_sync_error TEXT`. Columns, not a table — simpler and
     sufficient.
   - `applications/bot/src/rcp/role/errorClassifier.ts` — mirror
     `applications/bot/src/rcp/inviteGenerator/errorClassifier.ts`, **including its `terminal` flag**
     (CC-0): a 429 or a 5xx must not be recorded as a user-visible failure at all. Map to the
     four-bucket `DiscordSyncErrorCode` from PR-7:
     `retryable` (429, 5xx, network), `captain_action` (50013 missing-permission **and** role
     hierarchy — designer open question 4 says merge them if Discord does not distinguish them, and
     it does not: both surface as `50013`, so ship one row with copy naming both remedies),
     `user_action` (10007 unknown member / member left), `unknown`.
   - `ProcessorService.ts:43` records `String(error)`. Replace with the classifier's code + detail.
     Widen `Role/MarkEventFailed` with `error_code: Schema.OptionFromOptionalNullOr(DiscordSyncErrorCode)`
     — additive, bot→server, rolling-deploy safe once the server bundles the union (which it does,
     because PR-7 put `DiscordSyncErrorCode` in the domain).
   - `Role/MarkEventProcessed` and `Role/MarkEventFailed` also write `team_members.last_role_sync_*`,
     which is what fills `roleSyncState` / `lastRoleSyncAt` / `lastRoleSyncError` in PR-7's DTO.
   - Add `discord_syncLastSyncedRelative` to i18n (via `useFormatDate().formatRelative`). **No other
     new keys and no copy replacement** — PR-7's `discord_syncQueuedResult` stays.
9. **9c — the notification (CC-9).** Two-release expand/contract: `NotificationType` gains
   `'discord_connect_pending'`; the list DTO is pinned to a new `LegacyNotificationType`; the server
   projects the new value to an existing literal at the read boundary; un-pin one release later.
   **If this PR is time-boxed, drop 9c entirely.**
10. **Accessibility, non-negotiable** (designer §8): focus the card heading on mount; one
    `role='status' aria-live='polite'` per card and `role='alert'` for failures; never colour-only;
    `sr-only` labels on the copy button and the nav badge dot; the cooldown countdown must **not** be
    announced every second; "Skip for now" is a real `<Button>`, last in tab order, always reachable.

**Tests**

Server:
1. `myTeams returns discordJoined 'connected' for a member with discord_joined_at set`
2. `myTeams returns 'not_connected' only when the guild has members_backfilled_at set`
3. **`myTeams returns 'unknown' for a guild whose backfill never completed`** — the anti-lockout guard
4. `getJoinStatus returns state 'joined' when discord_joined_at is set`
5. **`getJoinStatus returns state 'joined' → not joined again after Guild/RemoveMember clears the timestamp`** — pins CC-15 (the sticky-`'done'` bug rev 2 would have shipped)
6. `getJoinStatus returns the true bot_not_in_guild code once that mapping is removed`
7. **`getJoinStatus still returns errorCode None for an expired row`** — the projection's permanent half survives PR-9

Bot:
8. `classifies 50013 as captain_action`
9. `classifies 10007 (unknown member) as user_action`
10. **`classifies a 429 as retryable and terminal: false`**
11. `classifies an unmapped error as unknown`
12. `MarkEventFailed carries the classified code`

Web:
13. `ConnectDiscordPage renders the selectable discord.gg text and a copy button`
14. **`ConnectDiscordPage's "Get a new invite" CTA calls regenerateMyDiscordInvite`** — the endpoint exists as of PR-5 (blocker 1); assert the API mock, not just the render
15. `the dashboard index redirects when not_connected and not snoozed`
16. **`the dashboard index does NOT redirect when unknown`**
17. `the dashboard index does not redirect while snoozed`
18. `a localStorage throw is treated as snoozed` — no redirect loop
19. `DiscordConnectCard has no dismiss control`
20. `SyncRolesButton disables for 60s after a completed run`
21. `SyncRolesButton renders the specific copy for each of the four DiscordSyncErrorCode buckets`
22. `AuthenticatedLayout no longer renders PendingDiscordJoinBanner`
23. **`MyProfilePage renders DiscordConnectCard, not the PR-5 row`** — CC-11

**Deploy / rollout.** Follow the designer's §3.6 sequence: PR-8 already shipped the read-only backfill
(step 1). This PR enables the UI for `not_connected` only where `members_backfilled_at` is set
(step 2). Consider dark-launching the **redirect** for new joiners only
(`team_members.joined_at > <flag>`) for the first 7 days while the card + badge go live for everyone
— they block nothing. **Wire a kill switch** (a server-side config flag that forces every
`discordJoined` to `'unknown'`, instantly removing all three surfaces) *before* enabling the redirect.

**Rollback.** The kill switch is the rollback for the gate — flip it, no deploy needed. Full revert:
web + server; leave migrations in place. Re-adding the `bot_not_in_guild` projection mapping is the
one step to remember if you revert past step 7.

**Residual risk to state in the PR description.** A user who is in the guild under a *different*
Discord account than the one they sign into Sideline with is permanently `not_connected` and sees a
card they cannot satisfy. Mitigation is the designer's `discord_connect_wrongAccount` copy + the
"Skip for now" escape. **Do not attempt automatic account re-linking.**

---

## Risk register

| Risk | Where | Mitigation |
|---|---|---|
| **A transient Discord failure is written as a terminal error and the user is stranded forever** | PR-3 (invite), PR-8 (roles) | **CC-0.** The classifier carries `terminal`; transient codes leave the row open for the next tick. Role sync is level-based, so a lost event is re-derived. Regression tests 16-18 (PR-3) and 9-10 (PR-8) fail on rev 2's design. |
| Un-filtering drains the backlog at 20 invites/s, minting an invite in every guild | PR-1, PR-3 | **PR-3 step 0** — the sweep runs as a gated pre-deploy step against the old server, not as a startup cron that races `fastPollLoop`. PR-1 gets the same cohort measured first. |
| A captain fixes the welcome channel and nothing retries | PR-3 | `findPending` re-opens `welcome_channel_missing` rows once `teams.welcome_channel_id` is non-null (CC-0 rule 2); `setDiscordCode` clears the stale error |
| Old bot fails to decode a `null` `welcome_channel_id`, halting invite generation for **every** team | PR-2/PR-3 boundary | CC-1 expand/contract; `Schema.OptionFromOptionalNullOr`; PR-3 gated on **`/api/version`** reporting the PR-2 bot version; wire-compat test asserts an old schema decodes new server output |
| Old browser fails to decode a new `InviteGeneratorErrorCode`, blanking the whole join status | PR-2..PR-9 | CC-3 wire-value projection; `'expired'` never reaches `errorCode` at all; three-release schedule; precedent `rsvpWireProjection.ts` |
| The "Get a new invite" CTA has nothing behind it | PR-3/PR-5/PR-9 | CC-14 answers designer open question 3; the endpoint lands in **PR-5** and is the same code path as PR-4's idempotent re-join |
| A retry loop mints a one-time Discord invite per click | PR-4/PR-5 | CC-14 — reuse when open; create only when the newest is terminally failed; 3/hour/user cap; `invite_acceptances` has no unique key to save you |
| **Adoption grants guild ADMINISTRATOR to every `role:manage` holder** | PR-6 | **CC-7** — `permissions === '0'` strict compare, read from `DiscordREST` (the RPC has no permissions column); report-only pass first; unit test 2 |
| Adopting a role above the bot's top role → permanent `50013` | PR-6 | CC-7 — `position < botTopPosition`, and take the **lowest** matching position; fail-safe to create when the bot's position is unknown |
| Waking the role queue creates duplicate zero-permission roles in every guild | PR-6/PR-7 | CC-7 — adoption ships alone and must be **live** before PR-7; first-use protocol on one member of one team |
| **A captain assigns a role in the web UI and nothing reaches Discord** | PR-7 | Root cause D's actual fix — the four `emit*` calls in `role.ts` (PR-7 step 1), with regression tests 1-4 that fail before the PR |
| Role sync strips Discord roles a captain granted by hand | PR-7/PR-8 | Removal is restricted to roles present in `discord_role_mappings` for the team; tests PR-7/12 and PR-8/7 |
| `Guild/ReconcileMembers` on every gateway reconnect floods a `concurrency: 1` queue | PR-8 | CC-10 — the diff is empty in steady state, so reconnects emit **zero** events; per-member and per-guild caps bound the first real backfill |
| **A member who joins during the rollout window is permanently un-synced** | PR-8 | Blocker 7 — `source` is an `Option`; `None` means unknown and does nothing, rather than being defaulted to `'reconcile'`; test 9 |
| Partial member backfill misread as "confirmed absent" → false `not_connected` for a whole guild | PR-8/PR-9 | S6 pagination with `after` + `complete`; `bot_guilds.members_backfilled_at`; `unknown` renders nothing |
| Three surfaces disagree about whether the user is in the guild | PR-5/PR-9 | **CC-15** — `discord_joined_at` is the only source; PR-5 ships no `'joined'` state at all; `MyProfilePage` is in PR-9's file list |
| A user who deliberately left the guild is silently re-added | PR-4 | CC-13 `WHERE status <> 'done'` + S4 (enqueue only from an explicit Join or regenerate click) |
| Rollback SQL permanently jams the feature | PR-4, PR-8 | CC-13 — cancel to `'failed'` (recoverable by `requeueFailedForUser`), never to `'done'`; PR-8's column is safe to keep because the trigger is level-based |
| Auto-join 401s for sessions older than ~7 days (no OAuth refresh anywhere) | PR-4/PR-5 | CC-6/S2 — failure degrades to the link, never to an error; `'ready'` beats everything in the `state` precedence; S5 widens the requeue so a fresh token actually retries; token refresh filed separately with the two facts recorded |
| Aged rows silently stop being selected and the UI hangs forever (the original bug, recreated) | PR-3/PR-5 | CC-4 — no age *filter*; a sweep writes a terminal `'expired'`, plus a derived guard whose window is **strictly larger** and shares one exported constant |
| Sweep and derived guard disagree visibly | PR-3/PR-5 | CC-4 — `INVITE_ACCEPTANCE_DERIVED_EXPIRY_DAYS = SWEEP + 1`, one module, asserted by a unit test |
| Destructive backfill resurrects months-old acceptances | PR-3 | CC-5 — `created_at` is never written; the backlog is **closed**, not reopened; asserted by a test |
| Any authenticated user can read any acceptance and get a working invite | PR-4 | Ownership check in `getJoinStatus`, 404 not 403 |
| A hard gate on an unknown signal bounces the entire existing user base | PR-9 | Tri-state with `unknown` rendering nothing; per-guild backfill gate; dark-launch for new joiners; kill switch wired **before** the redirect |
| `discord_guild_roles` is silently stale (`guildCreate.ts` early-returns on an empty payload) | PR-6 step 0 / PR-9 | Pre-merge query; change the early return to a warning. PR-6 itself reads Discord live and is unaffected |
| Domain package not rebuilt → stale types | PR-2, 5, 7, 8, 9 | `pnpm build` in `packages/domain` before typechecking any consumer |

## Build notes

- **`pnpm build` in `packages/domain`** before typechecking or testing server/web/bot, in every PR
  that touches `packages/domain/src` (PR-2, 5, 7, 8, 9). PR-4 no longer touches the domain.
- **i18n:** add keys to **both** `packages/i18n/messages/en.json` and `cs.json` (lockstep is mandatory;
  a missing key fails the Paraglide build), then `pnpm codegen && pnpm build` in `packages/i18n`, then
  call `tr('key')` from `~/lib/translations.js` — never `m.key()` in web code.
- **Migrations** (PR-3, PR-8, PR-9) live in `packages/migrations/src/before/` and are applied
  automatically at server startup (`docs/deployment.md` §2.2 step 2).
- **Crons** live at `applications/server/src/services/<Name>Cron.ts`, wrap the body in
  `withCronMetrics('<name>')`, and are exported as `cronEffect.pipe(Effect.repeat(Schedule.cron(...)))`
  — reference `applications/server/src/services/AgeCheckCron.ts`. **`Effect.repeat` runs the body once
  immediately at startup**, and `run.ts:252-263` runs every cron concurrently with
  `concurrency: 'unbounded'` and no sequencing against the HTTP server. That is load-bearing for PR-3
  step 0: never rely on a startup cron to have finished before the bot's first poll.
- **Deploy verification uses `GET /api/version` on the server**, not `/info` on the bot. The bot
  re-reports its version every 5 minutes (`applications/bot/src/Bot.ts:110-134`); a boot-only signal
  decays to `"bot":"unknown"` after any server restart and has already produced a false-green deploy
  here.
- **New TanStack routes** need `ssr: false` (PR-9's `connect-discord.tsx`).
- **Server integration tests** need a real Postgres via `applications/server/test/integration/helpers.ts`
  (`TestPgClient`, `cleanDatabase`); unit/RPC tests use the in-memory mock-repository harness
  (`applications/server/test/rpc/RegisterMember.test.ts`, `applications/server/test/Invite.test.ts`).
- **Chore, ship alongside PR-1:** mark `.work-plans/discord-native-onboarding*.md` as Done
  (`discord-native-onboarding.md:3` still says "Status: Backlog"). Their stale Community-gating
  language is the most likely origin of the `is_community_enabled` predicate this whole plan exists to
  remove.

## Tickets to file separately (do not smuggle into these nine PRs)

1. **Discord OAuth token refresh.** The refresh token is **already stored** —
   `applications/server/src/api/auth.ts:158` writes `Option.fromNullishOr(oauth.refreshToken())` into
   `oauth_connections.refresh_token`, a column that has existed since
   `packages/migrations/src/before/1742200000_extract_oauth_connections.ts:13` and is modelled at
   `packages/domain/src/models/OAuthConnection.ts:20`. It has **never been read**: grep `refresh_token`
   across `applications/server/src` and you get only the four write sites in
   `OAuthConnectionsRepository.ts`. The work is one repository read plus one `POST /oauth2/token`, not
   a new subsystem. This is the root fix for the ~7-day auto-join 401 (CC-6/S2).
2. **Roster roles** (`roster_members` → `reconcileRosterRoleExtras`) — its own pipeline, CC-16.
3. **Achievement roles** (`achievement_role_mappings` → `discord_role_provision_events`) — CC-16.
4. **A periodic server-side role reconciliation cron**, if PR-8's per-gateway-connect cadence proves
   too slow as a retry interval. It needs a stored snapshot of each member's Discord roles to diff
   against between reconnects (PR-8 step 8) — a separate design.
