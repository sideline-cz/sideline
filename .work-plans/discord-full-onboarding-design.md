# Full onboarding using Discord — UX/UI design spec

**Surface:** Discord only (one read-only channel, blocked-action ephemerals, one button, one modal).
**Owner of this doc:** design — copy, choreography, failure states. The architect owns data/code.
**Primary language:** Czech. The Czech column of the i18n table is the original; English is the translation.
**Companion:** `.work-plans/discord-full-onboarding.md` (implementation plan). The i18n table in §6
here and the one there are the same table. If they drift, this one is wrong.

---

## 0. The whole thing in one screen

The story's cohort is *"uzivatel dostane discord link"* — a member who joins through a plain,
captain-made Discord invite. **That member gets no welcome message today** (see §1.1), so the
welcome embed cannot be the spine of this flow. The two surfaces that actually reach them are the
read-only channel they land in and the ephemeral they get the first time they try to do something.

```
                         ┌─ PRIMARY ─────────────────────────────────────────────┐
member joins guild  ───► │ #nez-zacnes : hidden from everyone except the          │
  (any invite)           │               unverified role. Pinned bot embed        │
                         │               + [Dokončit profil]                      │
                         └───────────────────────────────────────────────────────┘

                         ┌─ PRIMARY ─────────────────────────────────────────────┐
member taps RSVP /  ───► │ ephemeral: "Ještě tě neznáme 👀" + [Dokončit profil]   │
  Vzít trénink /         │ — reaches the whole pre-existing incomplete cohort,    │
  a carpool seat         │   needs no backfill, fires at the moment it matters    │
                         └───────────────────────────────────────────────────────┘

                         ┌─ BONUS (web-invite cohort only, ~none of this story) ─┐
                         │ #welcome : captain's embed + [Dokončit profil]         │
                         └───────────────────────────────────────────────────────┘

[Dokončit profil] ──► MODAL (jméno · datum narození · pohlaví ▾ · číslo dresu)
        └─ submit ──► ephemeral success
                 ──► unverified role revoked → #nez-zacnes disappears for them
                 ──► one line in the captain-only system log channel
                 ──► the member re-taps whatever stopped them (one tap, no new state)
```

Nothing is announced publicly. Verification is a private, 20-second errand, not a ceremony.

---

## 1. The join moment

### 1.1 Who actually gets a welcome message — verified against the code

`GuildMemberAdd` runs `Guild/RegisterMember`, which returns welcome meta and drives `sendSystemLog`
+ `sendWelcome` (`applications/bot/src/events/index.ts`). But `buildWelcomeMeta`
(`applications/server/src/rpc/guild/index.ts`) returns `welcome: Option.none()` whenever
`inviteContext` is `None`, and `resolveInviteContext` resolves an invite context from exactly two
sources: a **Sideline-minted per-acceptance Discord code**, or an `invite_acceptances` row younger
than 15 minutes (`applications/server/src/repositories/InviteAcceptancesRepository.ts:343`).

A member who joins through a plain captain-made Discord invite has neither. **They get no welcome
message at all today.** That member is this story's entire cohort.

So the join moment has three cases, and the design is built around the first:

| Cohort | How they arrived | What they see at join |
|---|---|---|
| **Discord-native** (this story) | plain guild invite pasted by the captain | no welcome embed. `#nez-zacnes` is at the top of their sidebar with a pinned card, **plus** one standalone bot message in the welcome channel pinging them, if the team has one configured |
| **Web-invite** | `/invite/` link, per-acceptance code | the captain's welcome embed, now carrying the `[Dokončit profil]` button |
| **Already complete** | either | exactly what they see today. No prompt, no button. |

### 1.2 The welcome embed — bonus, not the flow

`buildWelcomeEmbed` (`applications/bot/src/services/welcomeRenderer.ts`) is **unchanged**: no new
field, no new signature. When `profile_complete === false` and a welcome embed is being sent
anyway, the bot attaches one action row with the shared `[Dokončit profil]` button to that same
`createMessage` call. One message, one ping, zero new copy.

That is the whole of the welcome-embed work. It is a convenience for the web-invite cohort —
people who already walked through a web form and are the *least* likely to need it. Do not spend
design or review effort here, and do not let it grow an explanatory embed field.

### 1.3 The standalone join prompt (no welcome embed)

For the Discord-native cohort, the bot posts **one** standalone message into the team's welcome
channel:

```
@Jana Nováková
┌──────────────────────────────────────────────────┐
│ Vítej! Než začneš, dokonči si profil — jméno,    │
│ datum narození a pohlaví. Potom si můžeš         │
│ zapisovat účast na tréninky a zápasy.            │
└──────────────────────────────────────────────────┘
[ Dokončit profil ]
```

Rules:

- **It is a standalone bot message, not a field on the captain's embed.** The captain's welcome is
  their voice; this is the system's. Mixing them means a template edit can silently break the CTA.
- **The string is rendered server-side and arrives in the DTO.** The bot renders no templates
  (bot AGENTS.md → welcome-flow rules 1 and 3), so `bot_verify_welcome_prompt` is resolved on the
  server against the **guild** locale and shipped as a finished string. Architect ask #5.
- `content: <@user.id>` with `allowed_mentions: { parse: [], users: [user.id] }`, matching
  `sendWelcome`. One ping, never a role ping.
- **No welcome channel configured → post nothing.** Not a DM, not a per-member message into
  `#nez-zacnes`. A DM fallback is a whole extra failure surface (`50007`, closed DMs, guild-less
  button state) for a message that §3 already delivers at a strictly better moment. The pinned
  card in `#nez-zacnes` and the blocked-action ephemeral are the safety net; the join prompt is an
  accelerator.
  *Skipped: DM fallback. Add it if the pilot shows people never find the channel.*

### 1.4 The button

**PRIMARY, one per message, no emoji in the label**, label `bot_verify_button` ("Dokončit
profil"). Rationale: `bot_claim_button` and `bot_rules_answer_button` — the two other "do the
thing" buttons in this bot — are emoji-free verbs; emoji in this codebase is reserved for *state*
markers (`🟢 Vzal/a si`, `🟠 Bez trenéra`, `💬`, `🗑️`). One label key is reused across every
surface, so the affordance is literally the same word everywhere the member meets it.

**The button is persistent, shared and stateless.** `custom_id` is the bare string `profile-verify`
— no per-member, per-event or per-guild payload. Anyone can press it, including someone who joined
months ago and someone who is already done; the latter gets `bot_verify_already_done`. A guild-less
press (DM) answers `bot_complete_no_guild`, exactly like `/dokoncit` does today.

---

## 2. The verify flow

### 2.1 The spec: one tap, one modal

The gender picker lives **inside the modal**. This is confirmed on both directions of the wire:

- **Outbound** — `LabelComponentForModalRequest` (type 18, with `label` + `description`) wrapping a
  `StringSelectComponentForModalRequest`, at
  `applications/bot/node_modules/dfx/dist/DiscordREST/Generated.d.ts:4622-4638`.
- **Inbound** — `ModalSubmitLabelComponent` at
  `applications/bot/node_modules/discord-api-types/payloads/v10/_interactions/modalSubmit.d.ts:9-11,41-45`.

```
[ Dokončit profil ]  ─────────────────────►  ┌ Dokončení profilu ──────────────┐
                                             │ Jméno a příjmení                 │
                                             │ [ Jana Nováková            ]     │
                                             │                                  │
                                             │ Datum narození                   │
                                             │ [ 24. 8. 2005              ]     │
                                             │                                  │
                                             │ Pohlaví                          │
                                             │ Kvůli soupiskám a rozdělení.     │  ← Label description
                                             │ [ Vyber…                  ▾]     │
                                             │                                  │
                                             │ Číslo dresu                      │
                                             │ Nepovinné, můžeš doplnit potom.  │
                                             │ [ např. 7                  ]     │
                                             │                    [ Uložit ]    │
                                             └──────────────────────────────────┘
```

One tap → one form → done. This removes an entire class of drop-off: the member who taps "Muž" and
is then ambushed by a form they did not expect.

Modal `title` = `bot_complete_modal_title` (cs "Dokončení profilu", 17 chars). Every label is
≤45 in both locales (16 / 14 / 7 / 11), per bot AGENTS.md rule 5.

Gender select: `custom_id: profile_gender`, `required: true`, `min_values: 1`, `max_values: 1`,
options `gender_male` / `gender_female` / `gender_other` (existing keys, already used by
`genderLabel`), `placeholder: bot_complete_gender_placeholder`.

**Consequences, all subtractive:**

- The modal `custom_id` no longer has to carry gender. `decodeGenderFromCustomId` **disappears**;
  gender is read out of the submitted components like every other field.
- The entry button carries no state at all (§1.4), so there is no `custom_id` budget question
  anywhere in this story. The longest id in the flow is `profile-verify` at 14 characters.
- The intermediate gender step, and its three extra `custom_id`s, do not exist.

**Architect ask #2:** `modalValueOption` in `interactions/profile-complete.ts` only walks
`row.type === 1` action rows. It must also walk `type: 18` Label components (`.component`) and read
a select's `values[0]` instead of `.value`. Keep the existing action-row branch — four lines, and
the `/dokoncit` slash path keeps working unchanged through rollout.

### 2.2 Fallback, used only if the spike fails

Before building §2.1, run **one manual spike against a real guild**: send a modal containing a
type-18 Label wrapping a string select and confirm both that Discord accepts it and that the submit
payload parses. The types say yes on both ends; the spike is 20 minutes and removes the only
remaining unknown.

If — and only if — the spike fails, fall back to an intermediate **ephemeral with a three-button
row**, and keep `decodeGenderFromCustomId`:

```
Ještě jedna věc — jak tě máme vést na soupisce?
[ Muž ]  [ Žena ]  [ Jiné ]              ← 3 × SECONDARY, custom_id profile-verify:{gender}
```

Buttons, not a select, in that case: one tap instead of two; all three options visible instead of
hidden behind a placeholder; `Muž`/`Žena`/`Jiné` are 3–4 chars, inside bot AGENTS.md rule 6's cap;
and a select with a `Vyber pohlaví…` placeholder reads like a government form. All three SECONDARY,
so none looks like the "right" answer. `bot_verify_gender_prompt` is the only i18n key this
fallback needs, and it is the only key in §6 marked *fallback-only*.

### 2.3 Success

**Ephemeral. Nothing is posted publicly.** Reasons, in order: the modal contains a birth date; a
public "X se ověřil" line is noise the team did not ask for; and the team already got a welcome
message about this person. The one party who genuinely wants to know is the captain — they get one
line in the **existing captain-only system log channel** (`system_log_channel_id`, already wired in
`events/index.ts`), reusing `buildSystemLogEmbed`'s English-literal style (`title: 'Profile
completed'`, fields Member / Jersey). That log is English-only today; do not key it until the rest
of it is keyed.

One success body, `bot_verify_success`. It states **what just unlocked** and tells the member to
re-tap whatever stopped them, because their mental model is "I was stopped", not "I filled a form".
It also names `/dokoncit` as the way back in, so nobody hunts for a settings page to fix a typo'd
birth date.

Side effects on success:
1. Revoke the unverified role → `#nez-zacnes` vanishes from their sidebar (§4).
2. One system log line for the captain.

There is **no resume of the blocked action**. See §3.2.

### 2.4 Failure states — every one of them

| # | Failure | Where detected | Key | Recovery affordance |
|---|---|---|---|---|
| 1 | Name blank | bot, `parseName` | `bot_complete_invalid_name` (existing) | ephemeral + `[Dokončit profil]` re-open button |
| 2 | Birth date unparseable / future / pre-1900 | bot, `parseBirthDate` | `bot_verify_invalid_date` | same |
| 3 | Under `Auth.MIN_AGE` (6) | bot, `parseBirthDate` | `bot_verify_too_young` | same |
| 4 | Jersey not 0–99 | bot, `parseJerseyNumber` | `bot_complete_invalid_jersey` (existing, good) | same |
| 5 | Gender missing / not one of the three | bot, select `values[0]` | `bot_verify_gender_missing` | same |
| 6 | Not a member of this team | RPC `CompleteProfileNotMember` | `bot_verify_not_member` | text tells them to rejoin via the invite or ping the captain — no button, a button cannot fix it |
| 7 | Guild not registered with Sideline | RPC `CompleteProfileGuildNotFound` | `bot_verify_guild_not_registered` | none; tells them to nudge the captain |
| 8 | RPC unreachable / server defect | `RpcClientError`, `catchCause` backstop | `bot_verify_unavailable` | "nic se neztratilo, zkus to za chvíli" + button |
| 9 | Pressed in a DM, no guild context | bot, `guild_id` undefined | `bot_complete_no_guild` (existing) | none |
| 10 | Already verified (someone presses an old button) | RPC / pre-check | `bot_verify_already_done` | none; mentions `/dokoncit` |

Every one is an **ephemeral** and must land through the existing deferred-then-update pattern with
the `Effect.catchCause` backstop, so the member is never stranded on "Sideline is thinking…" (the
backstop already exists in `profile-complete.ts` — keep it).

Failures 1–5 and 8 carry a `[Dokončit profil]` button in the same ephemeral. Discord throws away
modal input on rejection; without a re-open button the member has to go find the original message
again, and that is where people give up. The button is stateless, so this costs nothing.

**Architect asks #3 and #4** (both cheap, both real UX):

- **#3 — accept Czech date input.** `24. 8. 2005`, `24.8.2005` and `24/8/2005` normalise to
  `2005-08-24` before hitting `Auth.BirthDateString`. A Czech recreational player does not type ISO
  dates, and "Neplatné datum narození" after typing your own birthday correctly is the single most
  infuriating dead end this flow can produce. Normalise in the bot; `Auth.BirthDateString` stays
  the authority.
- **#4 — split "invalid" from "too young".** `parseBirthDate` currently collapses format errors,
  future dates and `MIN_AGE` into one `'invalid'`. Telling a 5-year-old's date "neplatné datum"
  sends them into a retry loop on a correctly typed value. Return a tagged error.

---

## 3. The blocked-action ephemeral — the most-read copy in this story

This is the surface that reaches the **pre-existing** incomplete cohort with no backfill, no role
and no channel, and it fires at the exact second the member cares. It has to stand entirely on its
own.

### 3.1 What it looks like

Member taps `Ano` on their personal event card. The card does not change. An ephemeral appears,
visible only to them:

```
Ještě tě neznáme 👀

Účast si zapíšeš, až budeš mít dokončený profil — jméno, datum
narození a pohlaví. Zabere to chvilku a je to jednou provždy.

Potom se sem vrať a klepni na Ano znovu.

[ Dokončit profil ]
```

Four things, in this order, and the order is the design:

1. **What is wrong, framed as ours.** "Ještě tě neznáme" — not "nemáte oprávnění", not "ověření
   vyžadováno", no red ❌. The member did not fail a check; we are missing something.
2. **What is blocked and why.** "Účast si zapíšeš, až budeš mít dokončený profil" names the exact
   action they just attempted, then names the three fields — people abandon flows of unknown
   length, so the cost is stated before the ask.
3. **The way out, inline.** The button is in the same message. No channel to find, no scrolling, no
   second surface.
4. **What to do afterwards.** "Potom se sem vrať a klepni na **{response}** znovu." One tap. This
   replaces the deleted resume promise (§3.2) and is honest about it.

`{response}` is interpolated from `localizeRsvpResponse` — the member's own word (`Ano` / `Ne` /
`Možná`) echoed back, so it is obvious which tap needs repeating.

Two siblings with the same four-beat structure, differing only in beats 2 and 4:

| Blocked action | Key | Beat 4 |
|---|---|---|
| RSVP (`Event/SubmitRsvp`) | `bot_verify_blocked_rsvp` | "klepni na **{response}** znovu" |
| Claim a training (`Event/ClaimTraining`) | `bot_verify_blocked_claim` | "klepni na **Vzít trénink** znovu" |
| Reserve a carpool seat (`Carpool/ReserveSeat`) | `bot_verify_blocked_carpool` | "klepni na auto znovu" |

Three keys, not one generic one: naming the action the member just tried is the whole first half of
the message, and a generic "dokonči si profil" ephemeral on a carpool button reads like a bug.

### 3.2 There is no resume — and that is fine

**Deleted from this spec:** "Tvoje **Ano** uložím hned potom", the `pvr:` modal prefix, the
`custom_id` budget table, and the `bot_verify_success_rsvp` / `bot_verify_success_rsvp_failed`
keys. We are not building the resume.

Why it is an acceptable trade, stated once so nobody re-opens it: the resume saves the member
exactly **one tap** on a button that is still on screen, and costs a pending-intent encoding, a
second modal handler, a second success copy, a failure copy for "profile saved but the RSVP
didn't", and a stale-intent case when the event was deleted mid-modal. With gender moved into the
modal (§2.1) the `custom_id` pressure that made the encoding look cheap is gone anyway. One tap
beats five new states.

What the copy has to do instead is **tell them to re-tap** — beat 4 above, and the matching line in
`bot_verify_success`. A member who is not told will assume their `Ano` went through. That one
sentence is load-bearing; do not cut it for length.

Do **not** add a verify button to the personal event card itself: it already carries 4–5 buttons,
it is rebuilt by the reconcile loop, and the ephemeral already reaches the member at the right
moment.

### 3.3 Where the block is enforced

**Server-side**, in a shared helper the RSVP write paths, `Event/ClaimTraining` and
`Carpool/ReserveSeat` all call. Confirmed in the implementation plan. Reasons:

- The web app RSVPs through the same RPC and gets the same gate for free.
- A bot-side check drifts from the server's idea of "complete" the first time the field set changes.
- It is less bot code, not more: one more `Effect.catchTag` next to the ones already in `rsvp.ts`,
  `upcoming-rsvp.ts`, `claim.ts` and `carpool.ts`.

**Architect ask #1, and it is the one that can ruin this story: the profile-incomplete error must
be distinguishable from "not a member".** They are the same HTTP outcome and completely different
human situations — one is "do this 20-second thing", the other is "you're in the wrong server".
Collapsing them into `bot_rsvp_not_member` / `bot_carpool_err_not_member` would be the single worst
outcome here.

**Architect ask #6 — scope of the block.** Gated: RSVP writes (`rsvp:`, `upcoming-rsvp:`, and their
message add/clear siblings), claiming a training, reserving a carpool seat. **Not** gated: reading
anything, the rules quiz (`/rules` is a fun, zero-stakes way for a newcomer to poke at the bot —
blocking it is pure hostility), `/dokoncit` itself, and leaving a carpool seat you somehow already
hold. And do **not** implement the block as a Discord-permission lockout of the whole server: that
hides the welcome channel and the team chat from someone who just arrived, and turns a club into a
border crossing. Discord-level restriction is for `#nez-zacnes` visibility only.

---

## 4. The read-only unverified channel — the other primary surface

### 4.1 Name and topic

| | cs | en |
|---|---|---|
| channel name | `nez-zacnes` | `start-here` |
| topic | `Dokonči si profil a máš přístup ke všemu ostatnímu. Až to uděláš, kanál ti zmizí — to je v pořádku.` | `Finish your profile and everything else opens up. Once you do, this channel disappears — that's normal.` |

`nez-zacnes` ("než začneš") over `ověření`: it describes the member's situation, not the system's
process. ASCII-only, because Discord channel names with diacritics are inconsistent across clients
and unsearchable by keyboard. The topic pre-empts the "wait, where did that channel go?" support
question before it is ever asked.

Channel position: top of the channel list, above every category, so it is the first thing in the
sidebar of someone who just arrived.

### 4.2 The pinned first message

One bot-owned embed, posted and pinned at channel creation, **never** per-member. Colour `0x5865f2`
(blurple, same as `DEFAULT_WELCOME_COLOR` and the other neutral/informational embeds in this bot —
green and red stay reserved for outcomes).

```
┌──────────────────────────────────────────────────┐
│ Vítej! Ještě tě neznáme 👋                       │
│                                                   │
│ Sideline tvému týmu hlídá tréninky, účast         │
│ a soupisky. Než se do toho pustíš, potřebujeme    │
│ tři údaje. Nic víc, nikam je neposíláme.          │
│                                                   │
│ Co se ti tím otevře                               │
│ • Zapisování účasti na tréninky a zápasy          │
│ • Místo ve spolujízdě                             │
│ • Soupisky a zbytek serveru                       │
│                                                   │
│ Proč to po tobě chceme                            │
│ Jméno kvůli soupisce, datum narození kvůli        │
│ věkovým kategoriím, pohlaví kvůli mixed           │
│ rozdělení. Vidí to jen tvůj tým.                  │
│                                                   │
│ Zabere to chvilku · potom ti tenhle kanál zmizí   │
└──────────────────────────────────────────────────┘
[ Dokončit profil ]
```

Both fields are non-inline (they are sentences, not data points). The **"Proč to po tobě chceme"**
field is the single most important anti-KYC move in this design: a form that explains why it asks
each thing stops feeling like a check and starts feeling like a teammate asking. Do not cut it to
save vertical space.

Not configurable per team. A captain-editable template here would be a second welcome-template
feature for a message nobody reads twice; the captain's voice already has `#welcome`.
*Skipped: per-team template. Add it when a captain actually asks.*

### 4.3 Visibility mechanics — hidden by default, granted to the minority

Two permission overwrites at channel creation, using constants that already exist at
`applications/bot/src/rest/permissions.ts:11-13,44-51`:

| Target | Overwrite |
|---|---|
| `@everyone` (the guild id) | `deny(HIDDEN)` — deny `ViewChannel` |
| the bot-owned unverified role | `allow/deny(CHANNEL_ACCESS_VIEW)` — allow `ViewChannel` + `ReadMessageHistory`, deny `SendMessages`, `AddReactions`, `SendMessagesInThreads` and both thread-create permissions |

Direction matters, and this is the reason it is this way round rather than the inverse
(`@everyone` ALLOW + a `Ověřeno` role DENY):

- **Grant to the minority, at join.** The unverified role is added by the `guildMemberAdd` handler
  the bot is already running, one REST call for one member.
- **No backfill, ever.** The inverse topology would need the verified role granted to every
  already-verified member on day one: N REST calls through a pipeline that has no "grant to
  everyone" path, and a half-finished run leaves real members staring at a channel telling them
  they are not verified. There is no safe flag position for that.
- **Failure is silent, not loud.** If the bot cannot create the role or add it, the channel stays
  hidden from everyone. Nobody is confused; the flow falls back to §3, which needs none of this.
  Under the inverse topology the same failure shows an "ještě tě neznáme" channel to the entire
  verified roster.
- **The read-only property comes free.** `CHANNEL_ACCESS_VIEW` already denies send/react/threads,
  so the channel cannot rot into a chat, and it does so without a separate `@everyone`
  `SEND_MESSAGES` deny.

Revoke is one `deleteGuildMemberRole` on the profile-complete success path, while the bot is
holding the interaction.

**Degradations:**

| Situation | Behaviour |
|---|---|
| Bot lacks `MANAGE_ROLES` / `MANAGE_CHANNELS`, or the role was deleted | The channel exists but nobody holds the role, so **nobody sees it** — including the unverified. Log a warning once, never fail the join. The member is still reached by §3. This is the steady-state failure and it is invisible, not embarrassing. |
| **Verified member still sees the channel** | The genuine exception, not the steady state: it means the revoke REST call failed after a successful save. Cosmetic. They read a harmless explainer; pressing the button answers `bot_verify_already_done` with a pointer to `/dokoncit`. Cleared the next time they run `/dokoncit`. Never an error. |
| Team has no verification channel | The whole channel is optional and ships last. §1.3 and §3 carry the flow without it. |

**What happens to the channel and the message after someone verifies:** nothing. The message is
shared, the channel is permanent, and the next person to join needs both. **Never** delete the
message, **never** garbage-collect the channel when the unverified count hits zero — an empty
`#nez-zacnes` costs nothing and recreating it costs a captain a support ticket.

The channel and role are bot-owned and discovered by name (the `ensureSudoRole` /
`createChannelWithRole` shapes), with no `discord_role_mappings` row and no Sideline `roles` row —
that absence is what keeps `reconcileMemberDiscordRoles` from ever touching them. No new DB column
is needed; this is not an architect ask.

**Architect ask #7:** a team already using Discord native onboarding has a rules role
(`OnboardingRoleCache`, `teamSettings_onboardingRulesRole`). Do **not** stack a second gate on top
of it; a member facing "read the rules" *and then* "dokonči si profil" as two separate walls will
bounce. Either reuse that role or make the two mutually exclusive per team.

---

## 5. Tone

Rules applied to every Czech string in the table:

1. **Tykání, always,** on every bot surface. The newer bot copy (`bot_complete_*`, `bot_claim_*`,
   `bot_rules_*`) already uses it. **Web strings are vykání**, matching
   `profile_complete_title: "Dokončete svůj profil"` — the two registers do not meet on one screen.
2. **Never the word "ověření"** in member-facing copy. It is *dokončení profilu*. "Verification" is
   what a bank does to you; "dokonči si profil" is what a teammate asks. The role is named
   internally; the copy never says it.
3. **Never "docházka".** It is **účast**, matching the shipped vocabulary: `bot_rsvp_modal_title` =
   "Účast — {response}", `bot_rsvp_recorded` = "Vaše účast … byla zaznamenána". "Zapisovat
   docházku" reads like a school register; this is a sports team.
4. **One person per message.** Do not open with "Ještě tě **neznáme**" and close with "uložím" —
   pick *we* or *I* and hold it. Every string in §6 is *we*.
5. **Say why, once, where it matters** (the pinned channel embed) rather than apologetically
   everywhere.
6. **No exclamation marks except on success.** One 🎉 at the finish line; nowhere else.
7. **Emoji: one per message, maximum, and only as a state marker.** 👀 on the block, 👋 on the
   channel card, 🎉 on success, ✅ on already-done. No emoji on buttons.
8. **Short sentences.** This is read on a phone, at a sports hall, one-handed.

---

## 6. i18n key table — the deliverable

This table is the contract with `.work-plans/discord-full-onboarding.md`. Czech is the original.
All bot keys are tykání; the three web/settings keys at the bottom are vykání.

| key | en | cs |
|---|---|---|
| `bot_verify_button` | `Finish my profile` | `Dokončit profil` |
| `bot_verify_welcome_prompt` | `Welcome! Before you start, finish your profile — name, date of birth and gender. Then you can sign up for trainings and matches.` | `Vítej! Než začneš, dokonči si profil — jméno, datum narození a pohlaví. Potom si můžeš zapisovat účast na tréninky a zápasy.` |
| `bot_verify_channel_name` | `start-here` | `nez-zacnes` |
| `bot_verify_channel_topic` | `Finish your profile and everything else opens up. Once you do, this channel disappears — that's normal.` | `Dokonči si profil a máš přístup ke všemu ostatnímu. Až to uděláš, kanál ti zmizí — to je v pořádku.` |
| `bot_verify_intro_title` | `Welcome! We don't know you yet 👋` | `Vítej! Ještě tě neznáme 👋` |
| `bot_verify_intro_description` | `Sideline keeps your team's trainings, attendance and rosters in one place. Before you jump in we need three things. Nothing more, and they go nowhere else.` | `Sideline tvému týmu hlídá tréninky, účast a soupisky. Než se do toho pustíš, potřebujeme tři údaje. Nic víc, nikam je neposíláme.` |
| `bot_verify_intro_unlocks_name` | `What this opens up` | `Co se ti tím otevře` |
| `bot_verify_intro_unlocks_value` | `• Signing up for trainings and matches\n• A seat in a carpool\n• Rosters and the rest of the server` | `• Zapisování účasti na tréninky a zápasy\n• Místo ve spolujízdě\n• Soupisky a zbytek serveru` |
| `bot_verify_intro_why_name` | `Why we ask` | `Proč to po tobě chceme` |
| `bot_verify_intro_why_value` | `Your name for the roster, your date of birth for age categories, your gender for mixed line-ups. Only your team sees it.` | `Jméno kvůli soupisce, datum narození kvůli věkovým kategoriím, pohlaví kvůli mixed rozdělení. Vidí to jen tvůj tým.` |
| `bot_verify_intro_footer` | `Takes a moment · after that this channel disappears` | `Zabere to chvilku · potom ti tenhle kanál zmizí` |
| `bot_verify_blocked_rsvp` | `**We don't know you yet** 👀\n\nYou can sign up once your profile is finished — name, date of birth and gender. It takes a moment and you only do it once.\n\nThen come back here and tap **{response}** again.` | `**Ještě tě neznáme** 👀\n\nÚčast si zapíšeš, až budeš mít dokončený profil — jméno, datum narození a pohlaví. Zabere to chvilku a je to jednou provždy.\n\nPotom se sem vrať a klepni na **{response}** znovu.` |
| `bot_verify_blocked_claim` | `**We don't know you yet** 👀\n\nYou can take a training once your profile is finished — name, date of birth and gender. It takes a moment and you only do it once.\n\nThen tap **Claim training** again.` | `**Ještě tě neznáme** 👀\n\nTrénink si vezmeš, až budeš mít dokončený profil — jméno, datum narození a pohlaví. Zabere to chvilku a je to jednou provždy.\n\nPotom klepni na **Vzít trénink** znovu.` |
| `bot_verify_blocked_carpool` | `**We don't know you yet** 👀\n\nYou can take a seat once your profile is finished — name, date of birth and gender. It takes a moment and you only do it once.\n\nThen tap the car again.` | `**Ještě tě neznáme** 👀\n\nMísto v autě si zabereš, až budeš mít dokončený profil — jméno, datum narození a pohlaví. Zabere to chvilku a je to jednou provždy.\n\nPotom klepni na auto znovu.` |
| `bot_verify_success` | `Done, {name}! 🎉 You're in — if something stopped you a moment ago, just tap it again.\nSaved: {birthDate} · {gender}{jersey}. Change it anytime with /complete.` | `Hotovo, {name}! 🎉 Teď se můžeš zapisovat na všechno. Jestli tě před chvílí něco zastavilo, klepni na to ještě jednou.\nUloženo: {birthDate} · {gender}{jersey}. Kdykoliv si to změníš přes /dokoncit.` |
| `bot_verify_already_done` | `Your profile is already done ✅ Want to change something? Run /complete.` | `Profil už máš hotový ✅ Chceš něco změnit? Napiš /dokoncit.` |
| `bot_verify_invalid_date` | `That date doesn't look right. Write it like 24. 8. 2005 or 2005-08-24.` | `Tohle datum nesedí. Napiš ho jako 24. 8. 2005 nebo 2005-08-24.` |
| `bot_verify_too_young` | `Sideline is for ages 6 and up — check the date of birth.` | `Sideline je od 6 let — zkontroluj si datum narození.` |
| `bot_verify_gender_missing` | `Pick one of the three options, then submit again.` | `Vyber jednu ze tří možností a odešli to znovu.` |
| `bot_verify_not_member` | `You're not on this team's roster yet. Try rejoining with the invite link, or give your captain a nudge.` | `Zatím nejsi na soupisce tohoto týmu. Zkus se připojit znovu přes pozvánku, nebo se ozvi kapitánovi.` |
| `bot_verify_guild_not_registered` | `This server isn't connected to Sideline yet. Give your captain a nudge.` | `Tenhle server ještě není propojený se Sideline. Dej vědět kapitánovi.` |
| `bot_verify_unavailable` | `Sideline isn't answering right now. Try again in a minute — nothing was lost.` | `Sideline teď neodpovídá. Zkus to za chvíli znovu — nic se neztratilo.` |
| `bot_verify_gender_prompt` *(fallback only, §2.2)* | `One more thing — how should we list you on the roster?` | `Ještě jedna věc — jak tě máme vést na soupisce?` |
| `bot_complete_gender_label` | `Gender` | `Pohlaví` |
| `bot_complete_gender_description` | `Used for rosters and mixed line-ups.` | `Kvůli soupiskám a rozdělení na tréninku.` |
| `bot_complete_gender_placeholder` | `Pick one…` | `Vyber…` |
| `bot_complete_jersey_description` | `Optional — you can add it later.` | `Nepovinné, můžeš doplnit potom.` |
| `rsvp_profileIncomplete` *(web, vykání)* | `Finish your profile before you can RSVP.` | `Než zapíšete účast, dokončete svůj profil.` |
| `teamSettings_requireCompleteProfile` *(web, vykání)* | `Require a complete profile` | `Vyžadovat dokončený profil` |
| `teamSettings_requireCompleteProfile_help` *(web, vykání)* | `Members without a name, date of birth and gender cannot RSVP, claim trainings or reserve a carpool seat. They get a button in Discord that walks them through it.` | `Členové bez jména, data narození a pohlaví nemohou zapisovat účast, brát si tréninky ani si rezervovat místo ve spolujízdě. V Discordu dostanou tlačítko, které je provede vyplněním.` |

`{jersey}` in `bot_verify_success` is a pre-formatted fragment (`""` or `" · #7"`), mirroring the
existing `bot_complete_success` / `bot_complete_success_with_jersey` split — or keep two keys if the
architect prefers no empty-string interpolation.

### 6.1 Existing keys whose copy changes

| key | today (cs) | proposed (cs) | proposed (en) | why |
|---|---|---|---|---|
| `bot_complete_name_label` | `Jméno` | `Jméno a příjmení` | `Full name` | a roster needs the surname; "Jméno" alone gets first names |
| `bot_complete_birth_date_label` | `Datum narození (RRRR-MM-DD)` | `Datum narození` | `Date of birth` | format belongs in the placeholder, not the label |
| `bot_complete_birth_date_placeholder` | `2005-08-24` | `24. 8. 2005` | `2005-08-24` | Czech members type Czech dates (pairs with architect ask #3) |
| `bot_complete_jersey_label` | `Číslo dresu (nepovinné)` | `Číslo dresu` | `Jersey number` | "(nepovinné)" moves into the Label `description` |

### 6.2 Existing keys reused unchanged

`gender_male`, `gender_female`, `gender_other` (select options and the success summary),
`bot_complete_modal_title`, `bot_complete_name_placeholder`, `bot_complete_jersey_placeholder`,
`bot_complete_invalid_name`, `bot_complete_invalid_jersey`, `bot_complete_no_guild`,
`bot_complete_error`, `bot_complete_not_member` (the `/dokoncit` path keeps it),
`rsvp_yes` / `rsvp_no` / `rsvp_maybe` (the `{response}` interpolation),
`bot_claim_button` and `bot_carpool_btn_reserve` (quoted back at the member in the blocked copy).

### 6.3 Keys deliberately **not** added

| Considered | Why not |
|---|---|
| `bot_rsvp_profile_incomplete` | tykání string inside the vykání `bot_rsvp_*` family. The blocked copy belongs to `bot_verify_*`. |
| `bot_verify_dm_title` / `bot_verify_dm_description` | no DM fallback (§1.3). |
| `bot_verify_blocked_other` | three named actions are gated, each gets its own named copy (§3.1). A generic variant is only worth adding when a fourth action is gated. |
| `bot_verify_success_rsvp`, `bot_verify_success_rsvp_failed` | no resume (§3.2). |
| `bot_verify_stale` | the entry button is stateless, so it never goes stale. |
| `bot_welcome_group_field` | see §8 — out of scope. |
| `bot_verify_welcome_field_name` / `_value` | the join prompt is a standalone message, not an embed field (§1.3). |

---

## 7. Architect asks, collected

| # | Ask | Cost | What breaks in UX without it |
|---|---|---|---|
| 1 | A profile-incomplete tagged error **distinct** from "not a member", on the RSVP, claim and carpool-reserve paths | small | the block message becomes "Nejsi členem tohoto týmu" — a dead end that sends people to the captain instead of to a button |
| 2 | `modalValueOption` walks `type: 18` Label components and reads select `values[0]` | ~10 lines | the flow gains a whole extra step (§2.2 fallback) |
| 3 | Normalise `24. 8. 2005` → ISO before `Auth.BirthDateString` | ~5 lines | the most common Czech input is rejected as invalid |
| 4 | `parseBirthDate` returns tagged `'invalid' \| 'too_young'` | ~5 lines | under-6 users get "neplatné datum" and retry forever |
| 5 | `Guild/RegisterMember` returns `profile_complete`, the verify channel id, **and the rendered `bot_verify_welcome_prompt` string** (guild locale) | fields on an existing response | the join prompt either never fires for the plain-invite cohort, or the bot starts rendering templates — both are rule violations |
| 6 | Block scope = RSVP writes + claim training + carpool reserve seat; **not** a server-wide permission lockout, **not** `/rules`, **not** reads | decision | a newcomer is locked out of the team chat they were just invited to |
| 7 | Decide: the bot-owned unverified role vs the existing native-onboarding rules role — never both | decision | two consecutive walls for a brand-new member |

---

## 8. Explicitly skipped

- **Keying `'Group'`** — hardcoded English at `applications/bot/src/services/welcomeRenderer.ts:13`.
  Keying it would change `buildWelcomeEmbed`'s signature, which takes no locale today. Real, but
  unrelated to this story. *Out of scope; fix it when that function next needs a locale anyway.*
- **A DM fallback at join** — §1.3. Extra failure surface for a message §3 delivers better.
- **Resuming the blocked action after verifying** — §3.2. One re-tap beats five new states.
- **Per-team template for the pinned channel embed** — *add it when a captain asks.*
- **Public "X joined the roster" announcement** — the captain-only system log line covers the real
  need.
- **A verify button on the personal event card** — that card is full and the ephemeral already
  catches them.
- **Reminder nags to members who stay unverified for N days** — *add it when the drop-off is
  measured, not guessed.*
- **Web-app changes beyond the three keys in §6** — the `/invite/` flow already exists and is
  unaffected.

---

## Appendix A — a pre-existing register inconsistency this story exposes

**Not in scope. Not required to ship. Do not fold into any task in the implementation plan.**

`bot_rsvp_*` Czech strings are **vykání** (`Vaše účast (**{response}**) byla zaznamenána!`,
`Nejste členem tohoto týmu.`), while `bot_complete_*` / `bot_claim_*` / all of `bot_verify_*` are
tykání. In this flow a member reads the tykání block message and the vykání RSVP confirmation
within three seconds of each other, which is exactly where the seam shows. It was already there
before this story and it will still be there after.

If it is ever done, as its own tiny diff:

| key | today (cs) | proposed (cs) |
|---|---|---|
| `bot_rsvp_recorded` | Vaše účast (**{response}**) byla zaznamenána! | Účast **{response}** zapsána. |
| `bot_rsvp_message_saved` | Vaše účast … Zpráva uložena. | Účast **{response}** zapsána.\n\n💬 Zpráva uložena. |
| `bot_rsvp_message_cleared` | Vaše účast … Zpráva smazána. | Účast **{response}** zapsána.\n\n🗑️ Zpráva smazána. |
| `bot_rsvp_not_member` | Nejste členem tohoto týmu. | Nejsi členem tohoto týmu. |
| `bot_rsvp_not_group_member` | Nejste členem skupiny přiřazené k této události. | Nejsi ve skupině, které se tahle událost týká. |
| `bot_rsvp_deadline_passed` | Termín pro potvrzení účasti vypršel. | Na tuhle událost už se zapisovat nedá. |
| `bot_rsvp_user_error` | Nepodařilo se identifikovat vašeho Discord uživatele. | Nepodařilo se načíst tvůj Discord účet. |
| `bot_rsvp_late_hint` | 💡 Připomínka pro tuto událost už byla odeslána. Příště zkuste odpovědět dříve — pomůže to vašemu týmu s plánováním! | 💡 Připomínka pro tuhle událost už byla odeslaná. Příště zkus odpovědět dřív, tým to ocení. |

**`bot_rsvp_late_hint` carries two halves and only one of them is tone.** "Připomínka … už byla
odeslána" is *information* — it tells the member why their late answer matters and that teammates
were already pinged. A rewrite that drops that clause and keeps only "zkus odpovědět dřív" deletes
the reason and leaves a scold. Keep the clause.
