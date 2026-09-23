# Configurable verify-channel intro

Notion `3e493506-0818-801d-bd27-e50083429b6e` · branch `feat/configurable-welcome-channel` · High · Discord Bot · Production

One deliverable:

- **A** — `teams.verify_intro_template`: a per-team override for the **body text** (embed `description`) of the pinned intro message in the `nez-zacnes` / `start-here` channel. Title, fields and footer stay hardcoded.

**Deliverable B (verify channel in the Discord Welcome Screen) is dropped.** See "Why B is gone" below. `applications/bot/src/rcp/onboarding/payloadBuilders.ts`'s `buildWelcomeScreenPayload`, `WelcomeScreenStrings` and `updateGuildWelcomeScreen` are **untouched** — the only edit to that file is one field on the `OnboardingTeamView` interface (A12), which is a row-shape type, not a welcome-screen input.

---

## Why B is gone

The verify channel is created with `deny(HIDDEN)` on `@everyone` (`applications/bot/src/rest/channels/ensureVerificationChannel.ts:59-60`); its only allow-overwrite is the unverified role. The Welcome Screen is rendered to users who are **not yet in the guild** and therefore cannot hold that role, and Discord requires every welcome-screen channel to be `@everyone`-viewable — `applications/bot/src/rcp/onboarding/errorClassifier.ts:151-163` already classifies the resulting 50035 `WELCOME_CHANNEL_PERMISSIONS_REQUIRED`. The entry would be rejected for every team. Making the channel `@everyone`-readable to satisfy the welcome screen would defeat the channel's entire purpose. Dropped, not deferred.

---

## Where the spec and the code disagree — read this first

1. **`TeamsRepository` has no "joined view" carrying `welcome_message_template`.** The spec says to mirror it through "(row schema, insert, update, joined view)". The five occurrences in `applications/server/src/repositories/TeamsRepository.ts` are: `TeamUpdateInput` (:15), the insert column list (:59) and values (:66), the `UPDATE ... SET` (:116) and the hand-written `update` input type (:135). `claimPendingOnboardingSyncs`'s `PendingOnboardingSyncRow` (:22-34) is the only joined projection in the file and it does **not** carry `welcome_message_template`. Nothing to mirror — but this feature adds `verify_intro_template` to that projection for its own reason (A5, A12: the sync loop needs it).

2. **Do NOT add the field to `Team.Team.insert`.** The spec asks for the column in the insert path plus `provisionNewTeam.ts` (`Option.none()`). Following that literally makes the field required on `typeof Team.Team.insert.Type`, which breaks **106 files / 125 call sites** of `teams.insert({...})` fixture literals across the server test suite — for zero behavioural gain, since `Option.none()` and the DB's `NULL` default are the same thing. Use `Model.Generated(...)` instead (select + update + json, **not** insert — see `effect/unstable/schema/Model.d.ts:163-177`). `provisionNewTeam.ts` and the insert SQL stay untouched. Deliberate deviation; if a reviewer insists on the literal spec, the cost is the 106-file fixture sweep.

3. **`buildWelcomeMeta` needs no new query and no new join** — the spec is right. `registerMemberWithReconcile` already loads the whole row via `deps.teams.findByGuildId` (`SELECT *` → decoded as `Team.Team`), so adding the column to the domain model makes it available on both branches for free.

4. **`ensureVerificationChannel`'s early return is real, and it is why the update path cannot live there.** `ensureVerificationChannel.ts:50-52` returns `Option.some(existing.id)` before any message work, and it is only reached from `grantUnverified` (`applications/bot/src/events/index.ts:269-287`) on a `VerificationChannelCache` miss — i.e. on a `guildMemberAdd`, with the profile gate on, an incomplete profile, and an expired 60s cache. A captain who saves the template may wait weeks for that to fire, and a cold-cache join burst would turn it into N `listPins` calls, a 429 storm, and added join latency. **So the early return stays exactly as it is.** The update path moves to the onboarding sync loop (A12), which is the code that already exists to push team settings into Discord.

5. **`verify_intro_template` DOES flip `onboarding_sync_status` to pending.** `hasOnboardingFieldChange` (`applications/server/src/api/team.ts:13-33`) gains the field (A6). This is the trigger for A12's reconcile — without it the sync loop never learns the template changed and the feature is a no-op for every existing team. (This reverses an earlier draft of this plan, which left `hasOnboardingFieldChange` alone.)

6. **dfx has both pin APIs.** `deprecatedListPins` (`GET /channels/{id}/pins`) and `listPins` (`GET /channels/{id}/messages/pins`). The create path already uses the new `createPin`, so use **`listPins`**.

---

## Order of operations

domain → migration → server (repo → api → rpc) → bot → web → i18n. `packages/domain` and `packages/i18n` both need a `pnpm build` before the apps typecheck.

---

## Deliverable A

### A1 — `packages/migrations/src/before/<timestamp>_add_teams_verify_intro_template.ts` (create)

```ts
import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Per-team override for the BODY of the pinned intro embed in the verify channel
// (`nez-zacnes` / `start-here`). NULL = use the built-in `m.bot_verify_intro_description`.
// Plain text, no template placeholders — unlike `welcome_message_template`.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS verify_intro_template TEXT
  `,
);
```

Timestamp: the highest existing `before/` id is `1792400001`. `1792500000` works today — **re-check `ls -1 packages/migrations/src/before/ | sort | tail -1` at commit time and after every rebase**; the slot is claimed by merge order.

### A2 — `packages/domain/src/models/Team.ts`

After `welcome_message_template` (:23):

```ts
  // Body text of the pinned intro embed in the verify channel. NULL = built-in copy.
  // Model.Generated = select + update + json, NOT insert: the column defaults to NULL
  // and nothing ever sets it at insert time, so keeping it off the insert variant spares
  // 100+ fixture literals a field they would all pass Option.none() to.
  verify_intro_template: Model.Generated(Schema.OptionFromNullOr(Schema.String)),
```

(Field-level JSDoc is hoisted by the domain barrel codegen — use `//`, not `/** */`.)

### A3 — `packages/domain/src/api/TeamApi.ts`

`TeamInfo` (after :19):
```ts
  verifyIntroTemplate: Schema.OptionFromNullOr(Schema.String),
```

`UpdateTeamRequest` (after :46-48):
```ts
  // isMinLength(1): an empty string is NOT the same as absent here. Discord rejects
  // `embeds[0].description: ""` with a 400, and the create path's createMessage retry
  // has no `while: !isPermanentError` guard — a 400 there would burn the retries and
  // leave the channel permanently without an intro message. Clearing the field must
  // arrive as an explicit null (Some(None)), never as ''.
  verifyIntroTemplate: Schema.OptionFromOptional(
    Schema.OptionFromNullOr(
      Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(2000))),
    ),
  ),
```
2000, not `welcomeMessageTemplate`'s 500: this becomes an embed `description` (Discord's per-field cap is 4096, the whole-embed cap 6000, and the hardcoded title/fields/footer eat ~600).

The web form already maps whitespace to `Some(None)` via `optionalText` (`teamInfoForm.ts:28-29`), so `isMinLength(1)` only ever fires for a non-web API caller. A8's `Option.filter` is the second belt — see there.

### A4 — `packages/domain/src/rpc/guild/GuildRpcGroup.ts`

Two DTOs.

**`RegisterMember` success struct**, next to `verify_locale` (:151) — feeds the join/create path:
```ts
        // `teams.verify_intro_template`. Absent key = an old server → fall back to the
        // built-in copy, so OptionFromOptionalKey, not OptionFromNullOr: the rolling
        // deploy order is bot → server → web, so a new bot talks to an old server first.
        verify_intro_template: Schema.OptionFromOptionalKey(Schema.String),
```

**`PendingOnboardingSyncEntry`** (:20-30), after `onboarding_rules_prompt_id` — feeds the sync/update path (A12). Same rolling-deploy reasoning:
```ts
  verify_intro_template: Schema.OptionFromOptionalKey(Schema.String),
```

### A5 — `applications/server/src/repositories/TeamsRepository.ts`

- `TeamUpdateInput` (after :15): `verify_intro_template: Schema.OptionFromNullOr(Schema.String),`
- `updateTeamQuery` SQL (after :116): `verify_intro_template = ${input.verify_intro_template},`
- `update`'s input type (after :135): `readonly verify_intro_template: Option.Option<string>;`
- `PendingOnboardingSyncRow` (:22-34), after `onboarding_rules_prompt_id`: `verify_intro_template: Schema.OptionFromNullOr(Schema.String),`
- `claimPendingOnboardingSyncs` SQL (:149-178): add `verify_intro_template` to the CTE's `RETURNING` list (:159-161) **and** to the outer `SELECT` (:163-172) as `c.verify_intro_template,`. Both, or the decode fails.
- **insert untouched** (see deviation #2).

### A6 — `applications/server/src/api/team.ts`

- `teamToInfo` (after :60): `verifyIntroTemplate: team.verify_intro_template,`
- `nextFields` (`Effect.let` at :120-142) gains:
```ts
              verify_intro_template: Option.getOrElse(
                payload.verifyIntroTemplate,
                () => existing.verify_intro_template,
              ),
```
- `teams.update({...})` (:143-162): `verify_intro_template: nextFields.verify_intro_template,` (read it off `nextFields`, like `welcome_channel_id` does — `hasOnboardingFieldChange` compares the same object).
- `hasOnboardingFieldChange` (:13-33) gains the field in **both** parameter types and in the comparison chain:
```ts
  Option.getOrNull(existing.verify_intro_template) !==
    Option.getOrNull(next.verify_intro_template) ||
```
- the `existing` literal passed at :166-175 gains `verify_intro_template: existing.verify_intro_template,`.

This is the trigger for the whole update path (deviation #5). Saving the template marks the team's onboarding sync pending; the bot's poll picks it up within one tick and runs A12's reconcile.

### A7 — `applications/server/src/rpc/guild/index.ts`

- `WelcomeMeta` (after :109): `readonly verify_intro_template: Option.Option<string>;`
- `buildWelcomeMeta`'s `team` parameter type (after `welcome_message_template` at :345): `readonly verify_intro_template: Option.Option<string>;`
- `noWelcome` literal (:375-382): `verify_intro_template: team.verify_intro_template,`
- the welcome-branch literal (:417-431): same line, next to `verify_locale: team.onboarding_locale,`.

Both branches — a plain-Discord-invite join gets `welcome: None` and is exactly the cohort that only ever sees the pinned card.

### A8 — `applications/bot/src/rest/channels/ensureVerificationChannel.ts`

**Create path only.** The `if (existing !== undefined) return Effect.succeed(Option.some(...))` early return at :50-52 is unchanged — no `listPins`, no `updateMessage`, no reconcile in this file (deviation #4). A team that sets the template *before* its first join still gets it on the freshly created message, which is why the parameter has to reach here at all.

Signature gains a 4th parameter:

```ts
export const ensureVerificationChannel = (
  guildId: DiscordSchemas.Snowflake,
  unverifiedRoleId: DiscordSchemas.Snowflake,
  locale: Locale,
  introTemplate: Option.Option<string>,
) => ...
```

Extract and **export** the embed builder — A12 imports it, so the create and update paths can never drift:

```ts
/**
 * The intro embed, shared by the create path below and by the sync-loop reconcile in
 * `~/rcp/onboarding/ProcessorService.ts`. Only `description` is team-configurable.
 *
 * No `sanitizeRendered` here, unlike the sibling `welcome_message_template`: this text
 * lands in an embed `description`, and embeds never resolve mentions into pings. The
 * 2000-char cap is enforced at the API boundary (`TeamApi.UpdateTeamRequest`).
 *
 * `Option.filter` on blank: `isMinLength(1)` guards the API, this guards everything
 * else (a row written before that check shipped, a direct DB edit). Discord 400s on
 * `description: ""`, and on the create path that 400 is unretryable-but-unguarded.
 */
export const buildIntroEmbed = (locale: Locale, introTemplate: Option.Option<string>) => ({
  color: DEFAULT_WELCOME_COLOR,
  title: m.bot_verify_intro_title({}, { locale }),
  description: introTemplate.pipe(
    Option.filter((t) => t.trim() !== ''),
    Option.getOrElse(() => m.bot_verify_intro_description({}, { locale })),
  ),
  fields: [
    { name: m.bot_verify_intro_unlocks_name({}, { locale }), value: m.bot_verify_intro_unlocks_value({}, { locale }) },
    { name: m.bot_verify_intro_why_name({}, { locale }), value: m.bot_verify_intro_why_value({}, { locale }) },
  ],
  footer: { text: m.bot_verify_intro_footer({}, { locale }) },
});
```

The create branch's `rest.createMessage(...)` (:78-99) now passes `embeds: [buildIntroEmbed(locale, introTemplate)]`. Everything else on that branch — `components: [UI.row([buildVerifyButton(locale)])]`, the `createPin`, the retries, the `catchIf(isPermanentError)` — is unchanged.

**Doc comment (:22-38)** — add two lines:
- the intro body is now team-configurable via `teams.verify_intro_template`, reconciled on the onboarding sync loop, not here;
- **known ceiling:** name-based resolution means flipping `onboarding_locale` (cs ↔ en) orphans the existing channel — a new one is created under the new name and the old one keeps its pinned card. Pre-existing behaviour, not introduced here, but the reconcile in A12 inherits it (it will silently target the channel matching the *current* locale, i.e. none). Out of scope.

### A9 — `applications/bot/src/events/index.ts`

- `grantUnverified` (:255-258) gains a 4th parameter `introTemplate: Option.Option<string>` and forwards it at the `ensureVerificationChannel(guildId, roleId, verifyLocale, introTemplate)` call (:272).
- `handleWelcomeMeta`'s meta type (:312-324) gains `readonly verify_intro_template: Option.Option<string>;`.
- the `grantUnverified(...)` call at :362 gains `meta.verify_intro_template`.
- `revokeUnverified` unchanged.

Pure threading — no reconcile, no extra REST call, no change to the `VerificationChannelCache` behaviour.

### A10 — web

`applications/web/src/components/organisms/team-settings/teamInfoForm.ts`:
- `untouchedTeamInfo`: `verifyIntroTemplate: Option.none(),`
- `WelcomeFormValues`: `verifyIntroTemplate: string;` (a primitive — `useCardForm` requires it)
- `welcomeFormFrom`: `verifyIntroTemplate: Option.getOrElse(info.verifyIntroTemplate, () => ''),`
- `welcomeRequestFrom`: `verifyIntroTemplate: optionalText(values.verifyIntroTemplate),` (already trims → an empty textarea sends `Some(None)`, never `''`)

`applications/web/src/components/organisms/team-settings/WelcomeMessageCard.tsx` — one more block after the existing `welcome-template` `<Textarea>` block (and **before** the `welcomePreview` block, which stays bound to `welcomeTemplate` only):

```tsx
          <div>
            <Label htmlFor='verify-intro-template'>{tr('teamSettings_verifyIntro')}</Label>
            <p className='text-xs text-muted-foreground mt-1 mb-2'>
              {tr('teamSettings_verifyIntroHelp')}
            </p>
            <Textarea
              id='verify-intro-template'
              rows={4}
              maxLength={2000}
              value={values.verifyIntroTemplate}
              onChange={(e) => setField('verifyIntroTemplate', e.target.value)}
            />
          </div>
```

No placeholder prop and **no preview pane** — this is plain text with no template placeholders.

**The help text carries the conditional, not the component.** The verify channel only exists when `require_complete_profile` is on, and that checkbox lives in a *different* card (`GeneralLimitsCard.tsx:60-75`). With the gate off this textarea is dead UI. Say so in the copy (A11) rather than wiring cross-card state into `useCardForm` — one sentence beats a shared form context.

### A11 — i18n

`packages/i18n/messages/cs.json` and `en.json`, inserted in alphabetical position near `teamSettings_welcomeTemplate` (:2805). Web copy ⇒ **vykání**, and never the word `ověření`/`ověřit`:

| key | cs | en |
|---|---|---|
| `teamSettings_verifyIntro` | `Úvodní zpráva pro nové členy` | `Intro message for new members` |
| `teamSettings_verifyIntroHelp` | `Text připnuté zprávy v kanálu „nez-zacnes". Kanál vzniká jen tehdy, když je zapnuté „Vyžadovat vyplněný profil" (karta Obecné) — jinak se zpráva nikde nezobrazí. Necháte-li prázdné, použije se výchozí text. Bez zástupných symbolů.` | `Body text of the pinned message in the start-here channel. That channel only exists when "Require complete profile" (General card) is on — otherwise this text is never shown. Leave empty to use the default. No placeholders.` |

Only two keys. No `bot_onboarding_welcomeScreen_channels_verify` (Deliverable B is gone).

### A12 — `applications/bot/src/rcp/onboarding/ProcessorService.ts` (the load-bearing part)

`makeProcessTeam` already holds a `DiscordREST`, already runs per-team at `concurrency: 1` (no double-post race), and already only runs for teams the server has flagged pending — which A6 now does on a template save.

**`applications/bot/src/rcp/onboarding/payloadBuilders.ts`** — one line, on the `OnboardingTeamView` interface (:3-13), after `onboarding_rules_prompt_id`:
```ts
  readonly verify_intro_template: Option.Option<string>;
```
Right home: `OnboardingTeamView` is already the bot-side shape of the pending-sync row, not a welcome-screen input — it carries `is_community_enabled` and `onboarding_rules_prompt_id`, neither of which `buildWelcomeScreenPayload` reads. One more row field is consistent; moving the interface would be a larger diff for no gain. `buildWelcomeScreenPayload` and `WelcomeScreenStrings` stay exactly as they are.

**`applications/bot/src/interactions/profile-verify.ts`** — export the id so no one retypes it:
```ts
/** The one entry `custom_id`. Exported so the sync-loop reconcile can recognise our own
 *  pinned message without writing the literal (see this file's doc comment). */
export const VERIFY_BUTTON_ID = 'profile-verify';
```
and use it in `buildVerifyButton` (:28) and in `Ix.id(...)` (:41).

**Imports in `ProcessorService.ts`.** Careful: line 1 already binds the name `Discord` (`import { type Discord, Team } from '@sideline/domain'`). Do **not** add `import * as Discord from 'dfx/types'`. Named imports instead:
```ts
import { UI } from 'dfx';
import { ChannelTypes, MessageComponentTypes } from 'dfx/types';
import { buildIntroEmbed } from '~/rest/channels/ensureVerificationChannel.js';
import { buildVerifyButton, VERIFY_BUTTON_ID } from '~/interactions/profile-verify.js';
import { isPermanentError } from '~/rest/discordErrors.js';
import { retryPolicy } from '~/rest/utils.js';
```

**The reconcile.** A module-level helper above `makeProcessTeam`:

```ts
/**
 * Keeps the pinned intro message in the verify channel in step with
 * `teams.verify_intro_template`. Runs on the onboarding sync loop — saving the field
 * flips the team to `pending` (server `hasOnboardingFieldChange`), so a captain's edit
 * lands within one poll tick. Deliberately NOT on the join path: `ensureVerificationChannel`
 * returns early for an existing channel, and hanging a listPins/updateMessage off a
 * `guildMemberAdd` would add join latency and a 429 storm on a cold-cache join burst.
 *
 * Requires the bot to hold Administrator to read and write inside its own
 * `@everyone`-hidden channel — the install link grants it (`permissions=8`,
 * `applications/web/src/components/pages/CreateTeamPage.tsx:77`).
 *
 * Best-effort throughout: any failure logs a warning and resolves. It must never fail the
 * onboarding sync, never reach `classifyOnboardingError`, and never block
 * `MarkOnboardingSyncDone`.
 */
const reconcileVerifyIntro = (
  discord: ServiceMap.Service.Shape<typeof DiscordREST>,
  team: OnboardingTeamView,
): Effect.Effect<void> => {
  const locale = team.onboarding_locale;
  const embed = buildIntroEmbed(locale, team.verify_intro_template);
  const sameCopy = (e: { title?: string; description?: string; footer?: { text: string } }) =>
    e.title === embed.title &&
    e.description === embed.description &&
    e.footer?.text === embed.footer.text;

  return Effect.Do.pipe(
    Effect.bind('channels', () =>
      discord
        .listGuildChannels(team.guild_id)
        .pipe(Effect.retry({ schedule: retryPolicy, while: (e) => !isPermanentError(e) })),
    ),
    Effect.flatMap(({ channels }) => {
      const name = m.bot_verify_channel_name({}, { locale });
      // type 0 = GUILD_TEXT. A *category* named `start-here` would otherwise match and
      // every message call against it would 400.
      const channel = channels.find((c) => c.name === name && c.type === ChannelTypes.GUILD_TEXT);
      if (channel === undefined) return Effect.void; // no join yet, or the captain renamed it
      const channelId = channel.id;

      return discord
        .listPins(channelId, { limit: 50 })
        .pipe(
          Effect.retry({ schedule: retryPolicy, while: (e) => !isPermanentError(e) }),
          Effect.flatMap((pins) => {
            // Our own message. `custom_id: 'profile-verify'` is NOT globally unique — the
            // bot stamps it on ten other messages (rsvp, upcoming-rsvp, carpool, claim,
            // the welcome embed). The invariant that holds is narrower and sufficient:
            // the only *pinnable* profile-verify message in *this* channel is the one
            // this code posts. The channel is bot-owned and write-locked to members.
            const own = pins.items.find((p) =>
              p.message.components.some(
                (row) =>
                  row.type === MessageComponentTypes.ACTION_ROW &&
                  row.components.some(
                    (c) =>
                      c.type === MessageComponentTypes.BUTTON && c.custom_id === VERIFY_BUTTON_ID,
                  ),
              ),
            );

            // No pin of ours: the captain deleted or merely unpinned it (they hold
            // Administrator). Post a fresh one. "No own pin" IS the idempotency guard —
            // do not replace this with an unconditional early return.
            if (own === undefined) {
              return discord
                .createMessage(channelId, {
                  embeds: [embed],
                  components: [UI.row([buildVerifyButton(locale)])],
                })
                .pipe(
                  Effect.retry({ schedule: retryPolicy, while: (e) => !isPermanentError(e) }),
                  Effect.flatMap((message) =>
                    discord.createPin(channelId, message.id).pipe(Effect.retry(retryPolicy)),
                  ),
                  Effect.tap(() =>
                    Effect.logInfo(`Reposted the verify intro message in guild ${team.guild_id}`),
                  ),
                  Effect.asVoid,
                );
            }

            // Compare title + description + footer, not description alone, so a future
            // i18n copy edit to the hardcoded parts also propagates to existing channels.
            const current = own.message.embeds[0];
            if (current !== undefined && sameCopy(current)) return Effect.void;

            // Partial edit: `components` (the verify button) is left untouched.
            return discord
              .updateMessage(channelId, own.message.id, { embeds: [embed] })
              .pipe(
                Effect.retry({ schedule: retryPolicy, while: (e) => !isPermanentError(e) }),
                Effect.tap(() =>
                  Effect.logInfo(`Refreshed the verify intro message in guild ${team.guild_id}`),
                ),
                Effect.asVoid,
              );
          }),
        );
    }),
    // ponytail: first page of pins only (limit 50). A channel with >50 pins whose intro
    // is not in the first page silently skips the refresh — paginate with `before` if a
    // real guild ever hits that.
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `Verify intro reconcile failed for guild ${team.guild_id}; continuing the onboarding sync`,
        cause,
      ),
    ),
  );
};
```

**Wiring in `makeProcessTeam`.** `syncDiscord` (:84-87) becomes:

```ts
    const syncDiscord = disableOnboarding.pipe(
      Effect.flatMap(() => patchWelcomeScreen),
      Effect.flatMap(() => reconcileVerifyIntro(discord, team)),
      Effect.as(Option.none<Discord.Snowflake>()),
    );
```

`resolveStrings`, `buildWelcomeScreenPayload`, `patchWelcomeScreen`, `disableOnboarding`, `MarkOnboardingSyncDone`, `MarkOnboardingSyncSkipped` and the `Effect.catch(classifyOnboardingError)` tail are **all unchanged**. `reconcileVerifyIntro`'s return type is `Effect<void>` (error channel `never`) — the compiler enforces that it cannot reach the classifier.

~~The `is_community_enabled: false` branch (:39-53) returns before `syncDiscord` is built, so a non-community guild never calls `listGuildChannels`.~~ **REVISED during review — this was wrong and would have shipped the feature broken for most teams.** The verify channel is not a Community feature: it is created from the join path (`grantUnverified` → `ensureVerificationChannel`) and gated only on `profile_gate_enabled`, while the claim query `COALESCE`s `is_community_enabled` to `false` for any guild not yet in `bot_guilds`. Sitting behind that short-circuit meant a non-Community team could edit the template and silently never see it applied — while also gaining an `onboarding_sync_error` banner. The reconcile therefore runs **before** the Community short-circuit, and before `patchWelcomeScreen` too (a failing welcome-screen patch marks the row `'failed'`, and only `'pending'` rows are re-claimed, so anything sequenced after it is lost forever for that team).

No `as` casts anywhere: `row.type === MessageComponentTypes.ACTION_ROW` narrows `ActionRowComponentResponse`, `c.type === MessageComponentTypes.BUTTON` narrows `ButtonComponentResponse` (whose `custom_id` is `string | undefined`).

dfx calls used (all already on `DiscordREST`, `dfx@1.0.11`):
- `listPins(channelId, { limit?, before? }) => Effect<PinnedMessagesResponse>`, `PinnedMessagesResponse = { items: ReadonlyArray<{ pinned_at: string; message: MessageResponse }>; has_more: boolean }` (`dfx/dist/DiscordREST/Generated.d.ts:2651-2662, :5349`).
- `updateMessage(channelId, messageId, MessageEditRequestPartial) => Effect<MessageResponse>` (:5354).
- `createMessage` / `createPin` — same shape the create path already uses.

---

## Test specification

### T1 — `applications/bot/test/rest/channels/ensureVerificationChannel.test.ts` (extend)

**Harness changes:** every existing `ensureVerificationChannel(GUILD, ROLE, 'en')` call gains a 4th arg `Option.none()`. No new REST methods to stub — the file's proxy fallback (`() => Effect.succeed(undefined)`) is fine because this file no longer calls `listPins`/`updateMessage`.

**Cases (create path only):**
1. *no template* — channel absent, `Option.none()` → `createMessage` body's `embeds[0].description === m.bot_verify_intro_description({}, { locale: 'en' })`. (The existing "posts exactly one intro embed" test can absorb this.)
2. *with template* — `Option.some('Custom body.')` → `embeds[0].description === 'Custom body.'`; `title` still equals `m.bot_verify_intro_title(...)`, `fields` has length 2, `footer.text` unchanged (title/fields/footer stay hardcoded).
3. *blank template* — `Option.some('   ')` → falls back to `m.bot_verify_intro_description(...)`, **never** an empty `description` (the `Option.filter` belt; a `''` description 400s Discord and the create-path retry has no permanent-error guard).
4. *locale* — `'cs'` + `Option.none()` → `description === m.bot_verify_intro_description({}, { locale: 'cs' })`.
5. *existing channel, unchanged* — the current "returns its id, does NOT create a channel, does NOT post a second pinned message" test **stays green as-is** with the added 4th arg, and `listPins`/`updateMessage` are never called. This is the regression guard for deviation #4: no reconcile on the join path.

**Layers:** `Layer.succeed(DiscordREST, proxy)` only, as today.

*(T2 — the old `payloadBuilders` welcome-screen spec — is deleted. `buildWelcomeScreenPayload`'s existing tests are untouched and must stay green.)*

### T3 — `applications/bot/test/rcp/onboarding/ProcessorService.test.ts` (extend)

**Harness changes (required — `makeRest`'s proxy `throw`s on unmocked methods, so every existing test in the file fails the moment production calls `listGuildChannels`):**
- add `listGuildChannels`, `listPins`, `createMessage`, `createPin`, `updateMessage` to `RestCalls` and to `defaults`.
- defaults: `listGuildChannels` → `Effect.succeed([{ id: VERIFY_CHANNEL_ID, name: 'start-here', type: 0 }])` (the `en` value of `m.bot_verify_channel_name`); `listPins` → `Effect.succeed({ items: [ownPin(...)], has_more: false })`; `createMessage` → `Effect.succeed({ id: '900000000000000199' })`; `createPin`/`updateMessage` → `Effect.succeed(undefined)` / `Effect.succeed({ id })`.
- `makePendingSync` gains `verify_intro_template: Option.none()`.
- a pinned-message fixture builder:
  ```ts
  const ownPin = (embed: Record<string, unknown>) => ({
    pinned_at: '2024-01-01T00:00:00Z',
    message: {
      id: '900000000000000199',
      embeds: [{ type: 'rich', ...embed }],
      components: [
        { type: 1, id: 1, components: [{ type: 2, id: 2, custom_id: 'profile-verify', style: 1 }] },
      ],
    },
  });
  ```
  Build the "matching" embed from `buildIntroEmbed('en', Option.none())` so the copy-comparison test does not hardcode i18n strings.

**Cases:**
1. *pin exists and differs* — `verify_intro_template: Option.some('New body')`, `listPins` returns `ownPin(buildIntroEmbed('en', Option.none()))` → `updateMessage` called **once** with `(VERIFY_CHANNEL_ID, '900000000000000199', { embeds: [expect.objectContaining({ description: 'New body' })] })`; `createMessage` and `createPin` **not** called; `MarkOnboardingSyncDone` called.
2. *pin matches* — `verify_intro_template: Option.none()` and `listPins` returns `ownPin(buildIntroEmbed('en', Option.none()))` → `updateMessage`, `createMessage`, `createPin` **all** uncalled; `MarkOnboardingSyncDone` still called.
3. *template cleared* — pin carries a custom `description`, `verify_intro_template: Option.none()` → `updateMessage` called with `description === m.bot_verify_intro_description({}, { locale: 'en' })` (clearing restores the default; it does not freeze the old override).
4. *no own pin → posts and pins* — `listPins` returns `{ items: [], has_more: false }` → `createMessage` called once into `VERIFY_CHANNEL_ID` with the intro embed **and** `components` carrying `custom_id: 'profile-verify'`, then `createPin` called once with the returned message id; `updateMessage` **not** called. Same expectation for a pin whose only button is `custom_id: 'something-else'`.
5. *channel not found* — `listGuildChannels` returns only unrelated channels → `listPins` **not** called, no failure, `MarkOnboardingSyncDone` called.
6. *category collision* — `listGuildChannels` returns `{ id: X, name: 'start-here', type: 4 }` (GUILD_CATEGORY) only → treated as not found; `listPins` **not** called.
7. *reconcile failure does not fail the sync* — `listPins` fails with a permanent `{ _tag: 'ErrorResponse', response: { status: 403 }, data: { code: 50013 } }` → `MarkOnboardingSyncDone` called, `MarkOnboardingSyncFailed` **not** called. Repeat for `listGuildChannels` failing and for `updateMessage` failing.
8. *welcome screen untouched* — in the happy path, `updateGuildWelcomeScreen` is called exactly once with a payload whose `welcome_channels` has length 1 and is the welcome channel; no verify id appears anywhere in it. This is the guard that Deliverable B stayed dropped.
9. *locale* — `onboarding_locale: 'cs'` → the channel is matched against `'nez-zacnes'`; with a `nez-zacnes` text channel present the reconcile proceeds and any `updateMessage` body carries the cs copy.
10. *`is_community_enabled: false`* → the reconcile **still runs** (it is not a Community feature), then `MarkOnboardingSyncSkipped`; `putGuildsOnboarding` and `updateGuildWelcomeScreen` stay uncalled.
11. *welcome-screen patch fails* → the reconcile already ran before it, and `MarkOnboardingSyncFailed` is still reported.
12. *`createPin` fails permanently after a successful post* → the message is rolled back with `deleteMessage`, so the next edit doesn't repost a duplicate.

### T4 — `applications/bot/test/events/guildMemberAddVerifyPrompt.test.ts` (extend)

The DTO fixtures (`withWelcome` / `withoutWelcome`, :60-95) gain `verify_intro_template: Option.Option<string>` defaulting to `Option.none()`.

**Cases:**
1. *plain-invite cohort (`welcome: None`, gate on, profile incomplete) with `verify_intro_template: Some('Team body')`* → the `createMessage` into the freshly created verify channel carries `embeds[0].description === 'Team body'`.
2. *same with `Option.none()`* → the built-in `m.bot_verify_intro_description` is used.
3. *`profile_gate_enabled: false`* → `grantUnverified` is not reached at all; no verify-channel REST traffic.

### T5 — `applications/server/test/api/teamOnboarding.test.ts` (extend)

`teamState`'s type + `resetTeamState` gain `verify_intro_template: Option.Option<string>` / `Option.none()`.

**Cases:**
1. `PATCH /teams/:id` with `{ verifyIntroTemplate: Some(Some('hello')) }` → 200, response `verifyIntroTemplate` is `Some('hello')`, and **`onboarding_sync_status` IS flipped to pending** (`markOnboardingSyncPending` called once). This is the assertion that pins deviation #5 and the whole update path — without it the feature is dead for existing teams.
2. `PATCH` with `{ verifyIntroTemplate: Some(None) }` → stored value becomes `None`, and the sync is **also** flipped to pending (clearing must reach Discord too).
3. `PATCH` that re-sends the **same** template while changing nothing else → sync **not** flipped (the `Option.getOrNull(...) !== Option.getOrNull(...)` comparison, not a blanket flip).
4. `PATCH` that omits `verifyIntroTemplate` entirely while changing `name` → the stored template is preserved (the Option-preserving `Option.getOrElse(payload.x, () => existing.x)` shape).
5. `PATCH` with `{ verifyIntroTemplate: Some(Some('')) }` → **400**, rejected by `isMinLength(1)`; nothing stored, sync not flipped.

### T6 — `applications/server/test/integration/repositories/TeamsRepository.test.ts` (extend)

`update` fixtures (:177, :227, :302, :432) gain `verify_intro_template`.

**Cases:**
1. `update({ …, verify_intro_template: Option.some('hi') })` → `findById` returns `Some('hi')`.
2. `update({ …, verify_intro_template: Option.none() })` → `findById` returns `None`.
3. a freshly `insert`ed team has `verify_intro_template === Option.none()` (proves the `Model.Generated` + DB-NULL default works without touching the insert path).
4. `claimPendingOnboardingSyncs` on a pending team with `verify_intro_template: Some('x')` → the returned row carries `Some('x')` (the projection change in A5; the decode fails loudly if either the CTE `RETURNING` or the outer `SELECT` was missed).

### T7 — `applications/web/src/components/organisms/team-settings/teamInfoForm.test.ts` (extend)

The `'between them they cover the whole DTO exactly once'` test fails until `untouchedTeamInfo` and `welcomeRequestFrom` both learn the field — that is the intended TDD signal.

**Cases:**
1. `'welcome message'` expected list becomes `['achievementChannelId', 'systemLogChannelId', 'verifyIntroTemplate', 'welcomeChannelId', 'welcomeMessageTemplate']`.
2. `welcomeRequestFrom({ …, verifyIntroTemplate: '  ' })` → `Some(None)` (whitespace clears via `optionalText`, so the web never trips `isMinLength(1)`).
3. `welcomeFormFrom(info)` with `verifyIntroTemplate: Option.none()` → `''`.

**Fixture sweep (will not typecheck otherwise):** `applications/web/src/components/organisms/team-settings/UnsavedChangesGuard.test.tsx:131` and `applications/web/src/components/pages/TeamSettingsPage.test.tsx:102` construct a full `TeamInfo` — add `verifyIntroTemplate: Option.none(),` to both.

### T8 — `packages/i18n/test/keyParity.test.ts`

No edit; it fails automatically if either of the two new keys lands in only one locale file.

---

## Risks

- **Silent no-op for existing teams** (deviation #4) — the whole reason A12 exists. The trigger chain is `PATCH /teams/:id` → `hasOnboardingFieldChange` → `markOnboardingSyncPending` → bot poll → `reconcileVerifyIntro`. Break any link and the feature ships dead. Pinned by T5 case 1 and T3 cases 1–4.
- **Name-based channel resolution.** The reconcile finds the channel by `m.bot_verify_channel_name` + `type === GUILD_TEXT`. A captain who renames the channel, or a team that flips `onboarding_locale`, orphans it — the reconcile silently skips (T3 case 5) and, on the next join, `ensureVerificationChannel` creates a second channel under the new name. Pre-existing behaviour of the no-`verify_channel_id`-column design; documented in A8's doc comment, not fixed here.
- **Bot must hold Administrator** to `listPins`/`updateMessage`/`createMessage` inside its own `@everyone`-hidden channel. The install link grants it (`permissions=8`, `CreateTeamPage.tsx:77`). A guild that stripped it degrades to a logged warning, not a failed sync (T3 case 7).
- **Empty string bricks the channel.** `isMaxLength(2000)` alone accepts `''` and Discord 400s on `embeds[0].description: ""`; on the create path that 400 hits an unguarded `Effect.retry(retryPolicy)` and the channel ends up with no intro message at all. Two guards: `isMinLength(1)` at the API (A3, T5 case 5) and `Option.filter` in `buildIntroEmbed` (A8, T1 case 3).
- **`custom_id: 'profile-verify'` is not globally unique.** The bot stamps it on ten other call sites (`rsvp.ts` ×3, `upcoming-rsvp.ts` ×3, `carpool.ts` ×2, `claim.ts`, `events/index.ts`). The invariant the reconcile relies on is narrower: *within the bot-owned verify channel*, the only pinnable message carrying it is ours. Use the exported `VERIFY_BUTTON_ID`, never the literal — `profile-verify.ts`'s own doc comment says no caller should write it.
- **Rolling deploy order is bot → server → web.** A new bot against an old server sees `verify_intro_template` absent from both the `RegisterMember` and `PendingOnboardingSyncs` DTOs — handled by `Schema.OptionFromOptionalKey` (A4). A new server against an old bot sends a key the bot ignores. Web last, so the field is writable only once the server accepts it.
- **`Model.Generated` misnomer.** The column is not DB-generated; it is "never set at insert". The comment in A2 must say so, or the next reader adds it to the insert list and pays the 106-file sweep.
- **`listPins` pagination** capped at `limit: 50`; carries a `// ponytail:` comment naming the ceiling.
- **Migration timestamp** is claimed by merge order — re-check after every rebase.
- **No new table** → no `EXPORT_MANIFEST` / GDPR entry needed.

## Build notes

1. `packages/domain/` changed → `pnpm build` (or at least `pnpm --filter @sideline/domain build`) before the server/bot/web typecheck.
2. `packages/i18n/messages/*.json` changed → `pnpm codegen` + `pnpm --filter @sideline/i18n build` so `m.*` and `messagesByKey` pick up the two new keys; the web `tr()` calls fail the build otherwise.
3. `packages/migrations/` changed → rebuild before running the server integration suite; those tests import the **compiled** migrations (`rm -rf packages/migrations/dist packages/migrations/*.tsbuildinfo` then build, or the rebuild silently emits nothing and you test the old SQL).
4. If `pnpm check` blames files you never touched, it is stale `.tsbuildinfo` — codegen, remove it, rebuild.
5. Run the server integration slice you touched (`TeamsRepository`, `teamOnboarding`), not the full suite — it dies on the container locally.
