# Discord Native Onboarding — Web UX/UI Design Spec

Companion to `.work-plans/discord-native-onboarding.md`. Scope: the new
"Onboarding" card on `TeamSettingsPage` that lets a captain configure
the rules channel, the entry role, and the locale, and observe the
sync state. Sync itself runs server-side; the card is a thin reflection
of DB state.

## 1. Card layout

The card slots into the existing single-column `flex flex-col gap-6
max-w-2xl` stack on `TeamSettingsPage`, immediately after the **Welcome
Message** card (they are conceptually adjacent: welcome message =
post-join greeting in the team channel; onboarding = Discord-native
gating before that channel is reachable). Card uses the same shadcn
`Card / CardHeader / CardContent` shell, `MessageSquare`-family lucide
icon (suggest `ShieldCheck` to differentiate from the Welcome card),
and `text-base` title.

Save / Discard footer follows the existing two-button pattern already
used by Profile / Settings / Welcome (primary `Button` plus a muted
"unsaved changes" line). No card-level destructive actions.

### Empty (never configured) — community feature OK

```
┌─ Onboarding ────────────────────────────────────────────────┐
│  ShieldCheck  Onboarding                                    │
│  Configure how Discord greets new members of your server.   │
├─────────────────────────────────────────────────────────────┤
│  Status                                                     │
│  [ ⚪ Pending sync ]   (read-only badge, neutral)           │
│                                                             │
│  Rules channel                                              │
│  Members must acknowledge this channel's rules before they  │
│  can post.                                                  │
│  [ SearchableSelect — # general ▾                       ]  │
│                                                             │
│  Onboarding role                                            │
│  Granted when a member acknowledges the rules.              │
│  [ SearchableSelect — ● Select a role…                  ▾] │
│                                                             │
│  Onboarding language                                        │
│  Discord shows this server's onboarding in the chosen       │
│  language for all new members.                              │
│  ┌───────────────┬───────────────┐                          │
│  │  English      │  Čeština      │  ← ToggleGroup           │
│  └───────────────┴───────────────┘                          │
│                                                             │
│  [Save changes]   You have unsaved changes.                 │
└─────────────────────────────────────────────────────────────┘
```

### Configured & synced

```
│  Status                                                     │
│  [ ✅ Synced 4 minutes ago ]   (success badge, green tone)  │
│                                                             │
│  Rules channel    [ # rules ▾ ]                             │
│  Onboarding role  [ ● @Member ▾ ]                           │
│  Onboarding language  [ English | Čeština ]                 │
│                                                             │
│  [Save changes (disabled)]                                  │
```

### Failed sync

```
│  Status                                                     │
│  [ ❌ Failed: The configured Discord role no longer  ] [Retry now] │
│      exists. Pick another role and re-save.                 │
│  ↳ <details> expands to full multi-line error (pre-wrap)    │
│                                                             │
│  …same fields as configured state, fully interactive…       │
│                                                             │
│  [Save changes]                                             │
```

### Disabled — Community feature missing

```
┌─ Onboarding (disabled) ─────────────────────────────────────┐
│  ⚠  Discord onboarding can't be configured until you enable │
│     Community features in your server. [Learn how →]        │
│                                                             │
│  Status                                                     │
│  [ ⚪ Pending sync ]   ← OUTSIDE the disabled fieldset      │
│                                                             │
│  ┌─ <fieldset disabled> ───────────────────────────────┐    │
│  │  …all fields rendered but disabled, opacity-60…    │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

The warning sits inside the card body (not a full-card overlay) so the
captain still sees what they would be configuring. Use a shadcn `Alert`
(install via `pnpm dlx shadcn@latest add alert`) with `variant=
'destructive'` is wrong here — use the default/`warning` variant. The
field block (rules channel + role + locale + Save / Discard footer) is
wrapped in a `<fieldset disabled>` so every control becomes
non-interactive natively. **The Status section (badge + Retry button +
failure `<details>`) lives OUTSIDE the `<fieldset disabled>`** — see §5
for the a11y rationale.

## 2. Component breakdown

| Field | Component (path) | Prop overrides | a11y notes |
|---|---|---|---|
| **Rules channel** | `~/components/atoms/SearchableSelect` (existing — same as `welcome-channel` in `TeamSettingsPage.tsx`) | `id='onboarding-rules-channel'`, `pinnedValues={[NONE_VALUE]}`, options = `discordChannels.filter(ch => ch.type === DISCORD_CHANNEL_TYPE_TEXT)`. Empty (`NONE_VALUE`) is a valid choice. | `<label htmlFor='onboarding-rules-channel'>` + helper `<p id='onboarding-rules-channel-help'>` + `aria-describedby` on the trigger. When cleared, render the inline hint with `role='note'`. |
| **Onboarding role** | `~/components/atoms/SearchableSelect` (same component as Rules channel — pass roles instead of channels). Options derive from `discordRoles: ReadonlyArray<{ id: string; name: string; color: number; position: number }>` on the loader, returned by the new architect-side `Guild/ListGuildRoles(guild_id)` RPC (parallel to `GroupApi.DiscordChannelInfo`). Filter out `@everyone` (id === guild_id) and managed roles client-side as a defensive fallback if the server doesn't already. | `id='onboarding-role'`, `pinnedValues={[NONE_VALUE]}`, options have `label='@RoleName'` rendered with a Discord-style color swatch prefix: a `span.size-2.rounded-full` whose `backgroundColor` is derived from `role.color` (`#${color.toString(16).padStart(6,'0')}`); when `color === 0`, fall back to `bg-muted-foreground`. | Same label-association pattern. Required field → `aria-required='true'` and `<FormMessage>` for the "required" error. The color swatch is decorative; render with `aria-hidden='true'` so the role name is the only thing announced. |
| **Locale** | `~/components/ui/toggle-group` (install: `pnpm dlx shadcn@latest add toggle-group`) — single-select variant. `RadioGroup` is also acceptable but `ToggleGroup` matches the segment-control look the plan asks for. | `type='single'`, `value={locale}`, items = `[ {value:'en',label:m.lang_en()}, {value:'cs',label:m.lang_cs()} ]`. `disabled={!isCommunityEnabled}`. | Wrap in `<fieldset>` with `<legend className='sr-only'>{m.teamSettings_onboardingLocale()}</legend>` so screen readers announce the group purpose. Each item gets `aria-label`. |
| **Status badge** | `~/components/ui/badge` (existing) | `variant` mapped to status: `pending` → `secondary`, `done` → custom success token, `failed` → `destructive`. Sync-in-flight is folded into `pending` visually (see §7). | Wrap in a `<div role='status' aria-live='polite'>` so optimistic transitions ("Pending sync") are announced. Failed-state full error in a `<details>` with `white-space: pre-wrap` on the body. |
| **Retry now** | `~/components/ui/button` `variant='outline' size='sm'` | Visible only when `status === 'failed'`. `disabled` while the click handler is in flight. | `aria-describedby` pointing at the failure message so the button context is clear. |
| **Save / Discard footer** | `~/components/ui/button` (matches existing `Settings save button` block in `TeamSettingsPage.tsx`) | Disabled when `!hasOnboardingChanges \|\| !isCommunityEnabled`. Add a sibling `variant='ghost'` "Discard" button that resets local state to loader values. | Keep tab order: rules channel → role → locale → save → discard → retry. |
| **Community-feature warning** | `~/components/ui/alert` (install: `pnpm dlx shadcn@latest add alert`) | `variant='warning'` (or default with a yellow icon). Body contains the copy + a `<a>` link wrapped in `<Button asChild variant='link'>`. | `role='alert'` (the shadcn Alert sets it). The link target should be the product-docs page — copy the convention from `applications/docs/src/content/docs/guides/discord-integration.mdx`. |

`SearchableSelect` is already the convention for dynamic Discord lists
(`TeamSettingsPage.tsx` uses it for every channel select); reusing it
keeps the card visually identical to its neighbours and means roles
reuse all the same keyboard-nav / search / pinned-value affordances
already shipped.

## 3. Sync status microcopy & i18n keys

Suggested keys (snake_case, same convention as
`teamSettings_welcome*` already in `packages/i18n/messages/en.json`):

| Key | en | cs |
|---|---|---|
| `teamSettings_onboardingTitle` | Onboarding | Onboarding |
| `teamSettings_onboardingDescription` | Configure how Discord greets new members of your server. | Nastavte, jak Discord přivítá nové členy vašeho serveru. |
| `teamSettings_onboardingRulesChannel` | Rules channel | Kanál s pravidly |
| `teamSettings_onboardingRulesChannelHelp` | Members must acknowledge the rules in this channel before they can post. | Členové musí potvrdit pravidla v tomto kanálu, než budou moci psát. |
| `teamSettings_onboardingRulesChannelClearedHint` | Without a rules channel, the rules prompt won't be shown to new members. | Bez kanálu s pravidly se výzva k potvrzení pravidel novým členům nezobrazí. |
| `teamSettings_onboardingRole` | Onboarding role | Onboardingová role |
| `teamSettings_onboardingRoleHelp` | Granted to a member after they acknowledge the rules. | Přiřazena členovi poté, co potvrdí pravidla. |
| `teamSettings_onboardingNoRoles` | No Discord roles available yet. Create one in your Discord server first. | V Discordu zatím nejsou žádné role. Vytvořte ji nejprve na svém Discord serveru. |
| `teamSettings_onboardingNoChannels` | No text channels found yet. Create one in Discord first. | Zatím nebyl nalezen žádný textový kanál. Vytvořte jej nejprve v Discordu. |
| `teamSettings_onboardingLocale` | Onboarding language | Jazyk onboardingu |
| `teamSettings_onboardingLocaleHelp` | Discord shows this server's onboarding in the chosen language for all new members. | Discord zobrazuje onboarding tohoto serveru ve zvoleném jazyce všem novým členům. |
| `teamSettings_onboardingStatusPending` | Pending sync | Čeká se na synchronizaci |
| `teamSettings_onboardingStatusSynced` | Synced {relativeTime} | Synchronizováno {relativeTime} |
| `teamSettings_onboardingStatusFailed` | Failed: {error} | Selhalo: {error} |
| `teamSettings_onboardingErrorRoleDeleted` | The configured Discord role no longer exists. Pick another role and re-save. | Nakonfigurovaná Discord role již neexistuje. Vyberte jinou roli a uložte znovu. |
| `teamSettings_onboardingErrorChannelDeleted` | The rules channel no longer exists. Pick another channel and re-save. | Kanál s pravidly již neexistuje. Vyberte jiný kanál a uložte znovu. |
| `teamSettings_onboardingErrorCommunityDisabled` | Discord Community features are no longer enabled in this server. | Funkce Discord Community již na tomto serveru nejsou zapnuté. |
| `teamSettings_onboardingErrorGeneric` | Couldn't sync to Discord: {message} | Synchronizace s Discordem se nezdařila: {message} |
| `teamSettings_onboardingRetry` | Retry now | Zkusit znovu |
| `teamSettings_onboardingRetryQueued` | Retry queued. | Opakování zařazeno do fronty. |
| `teamSettings_onboardingCommunityRequiredTitle` | Community features required | Vyžadovány funkce komunity |
| `teamSettings_onboardingCommunityRequiredBody` | Discord onboarding can't be configured until you enable Community features in your server. | Onboarding Discordu nelze nastavit, dokud na svém serveru nezapnete funkce komunity. |
| `teamSettings_onboardingCommunityLearnMore` | Learn how → | Jak na to → |
| `teamSettings_onboardingSaved` | Onboarding settings saved. | Onboarding byl uložen. |
| `teamSettings_onboardingSavedSyncing` | Saved. Syncing to Discord… | Uloženo. Synchronizuji s Discordem… |
| `teamSettings_onboardingSaveFailed` | Failed to save onboarding settings. | Uložení onboardingu se nezdařilo. |

`{relativeTime}` is computed on the client via the existing
`useFormatDate().formatRelative(syncedAt)` hook (see
`applications/web/AGENTS.md` § Date Formatting), so the same string
("4 minutes ago" / "před 4 minutami") drops in for free.

**Typed-error → copy mapping.** The architect surfaces a discriminated
union on the failure row (`{ kind: 'role_deleted' | 'channel_deleted' |
'community_disabled' | 'generic'; message?: string }`). The renderer
picks copy by `kind`:

| `kind` | Key |
|---|---|
| `role_deleted` | `teamSettings_onboardingErrorRoleDeleted` |
| `channel_deleted` | `teamSettings_onboardingErrorChannelDeleted` |
| `community_disabled` | `teamSettings_onboardingErrorCommunityDisabled` |
| `generic` | `teamSettings_onboardingErrorGeneric` (`{message}` = truncated first non-empty line) |

For typed errors (`role_deleted` / `channel_deleted` /
`community_disabled`) the badge renders the typed copy; the
`<details>` body still reveals the raw upstream message verbatim for
support purposes.

## 4. Interaction details

- **Rules channel cleared** → the rules-prompt won't be pushed. Show
  an inline `<p role='note' className='text-xs text-muted-foreground
  mt-1'>` with `m.teamSettings_onboardingRulesChannelClearedHint()`.
  The role select stays enabled and saveable — captains may want the
  role configured now and add the rules channel later.
- **Form dirty** → reuse the existing footer pattern from
  `TeamSettingsPage.tsx`: primary `Button` + muted "You have unsaved
  changes." copy. Add a sibling `Button variant='ghost'` "Discard"
  that resets all three fields back to loader values. Disable both
  buttons while `savingOnboarding === true`.
- **Save action** → on submit:
  1. Local state immediately flips the status badge to `pending` ("Pending sync").
  2. **Immediately fire a sonner toast** with copy
     `m.teamSettings_onboardingSavedSyncing()` ("Saved. Syncing to
     Discord…" / "Uloženo. Synchronizuji s Discordem…"). The toast
     auto-dismisses after ~3 s (sonner default). This disambiguates the
     save from the persistent badge — without it, when the badge was
     already "Pending sync" before the save, the captain has no signal
     that anything happened.
  3. `useRun()` invokes the new RPC (`Team/UpdateOnboardingConfig`).
     The success toast from `useRun` is suppressed (`success: undefined`)
     in favour of step 2 — we don't want two stacked toasts.
  4. On error, `useRun` shows the standard error toast; we additionally
     render the failure inline next to the status badge on the next
     loader pass.
  5. `router.invalidate()` after success so the loader re-fetches the
     canonical sync row.
- **Retry now** → calls a separate RPC (`Team/RetryOnboardingSync`) that resets `next_retry_at = null` and `status = 'pending'`. Click handler:
  1. Optimistically hide the failure error and flip the badge to `pending`.
  2. Show toast with `loading: m.teamSettings_onboardingRetryQueued()`.
  3. `router.invalidate()` on success — the badge will snap back to `failed` if the next pollLoop tick fails again, but we never sit on a stale "synced" state.

## 5. Edge cases & accessibility

- **Empty channel/role list (brand-new guild)** — `discordChannels` /
  `discordRoles` are loaded by the route loader, so there's no client
  loading spinner; either it's there or it isn't. When the filtered
  list is empty:
  - The `SearchableSelect` trigger renders with placeholder
    `m.teamSettings_channelNone()` / `m.teamSettings_onboardingRole()`.
  - The dropdown's empty-state slot (the same slot
    `SearchableSelect` already uses for "no results" when the user
    types a query that matches nothing) renders the actionable copy
    `m.teamSettings_onboardingNoRoles()` ("No Discord roles available
    yet. Create one in your Discord server first.") /
    `m.teamSettings_onboardingNoChannels()`. **This is distinct from
    the no-results-for-query state**: an unfiltered empty list calls
    out the missing-Discord-resource explicitly, instead of the
    generic "no results found".
  - Save is **not** blocked — the form simply has nothing to point at.
- **Long Discord error messages** — Discord errors are often
  multi-line JSON blobs (`{ "errors": { "roles_ids": { "0": { "_errors":
  [...] } } } }`) rather than a single sentence. **Truncate by line,
  not by char-count.** The badge body shows the **first non-empty
  line** of the error (trimmed); a trailing `…` is appended when more
  lines exist. The `<details>` block sitting directly underneath the
  badge reveals the full error verbatim with `white-space: pre-wrap`
  so JSON indentation and `\n`s render readably and are selectable for
  support copy-paste. Do not use a shadcn `Tooltip` here — the full
  error must be selectable. The `<summary>` is keyboard-accessible by
  default.
- **Status section DOM placement (a11y)** — When `isCommunityEnabled
  === false`, the form fields are wrapped in `<fieldset disabled>` so
  every control becomes non-interactive natively. **The Status section
  (badge + Retry button + failure `<details>`) MUST live OUTSIDE that
  fieldset.** Some screen readers (notably JAWS in browse mode) skip
  or under-announce content inside a disabled fieldset, and the badge
  must remain announceable: it's the only signal a captain has about
  what's happening server-side. The failure `<details>` summary must
  also stay focusable so the captain can read the full error even
  when the form is locked. **a11y test note:** verify with NVDA + JAWS
  that the `<div role='status' aria-live='polite'>` wrapping the badge
  announces transitions ("Pending sync" → "Failed: …") regardless of
  the disabled-fieldset state, and that `<summary>` receives focus via
  Tab in both states.
- **Keyboard focus order** — `tabIndex` follows DOM order; design the
  card so DOM order is: status `<summary>` (when expandable) → rules
  channel → onboarding role → locale toggle → Save → Discard → Retry
  now → "Learn how" link. The Status badge itself is not focusable;
  the failure expander (`<details>`) is. The community-required
  `Alert` link is focusable via the link inside.
- **Screen-reader announcements** — wrap the status badge in
  `<div role='status' aria-live='polite' aria-atomic='true'>` so
  changes from "Pending sync" → "Synced 4 minutes ago" → "Failed: …"
  are announced without stealing focus. Toast on save success/failure
  is an additional channel (sonner already has `aria-live`).
- **Color contrast / status tokens** — use existing semantic tokens,
  not raw hex:
  - `pending` → shadcn `Badge variant='secondary'` (uses
    `bg-secondary text-secondary-foreground`, contrast ≥ 4.5:1 in both
    light/dark themes by shadcn defaults).
  - `done` → custom variant added to `badge.tsx`: `bg-green-100
    text-green-900 dark:bg-green-950 dark:text-green-200`. Contrast
    ≥ 7:1.
  - `failed` → shadcn `Badge variant='destructive'`. Already AA-compliant.
  - Never encode the state by color alone — every state has both an
    icon (✅ / ⚠ / ❌ / ⚪) **and** a textual label.
- **Role-color swatch contrast** — the swatch is a decorative dot
  (`size-2 rounded-full`), not a text background, so WCAG text-contrast
  rules don't apply. Render it `aria-hidden='true'` and rely on the
  role name as the announceable label.

## 6. Out of scope (mirrors the plan)

- No per-prompt editor — Sideline manages exactly one prompt; the
  card shows no "prompts" UI at all.
- No welcome-screen description editor — the description is a locked
  i18n template at sync time, parameterised on the team name.
- No raw-JSON edit mode — captains never see Discord's onboarding
  payload. All Discord-side state is conveyed exclusively through the
  status badge + the optional failure expander.
- No per-channel emoji editor for the Welcome Screen "featured
  channels" — emojis are baked into the i18n template.

## 7. Concurrent-save / "Syncing…" state — design decision

The architect's new 4-state machine on the sync row (`pending →
syncing → done | failed`) makes a captain saving while a sync is
already in flight safe: the row is re-flipped to `pending` mid-sync
and picked up on the next pollLoop tick. The UX consequence is that,
without further work, the badge could oscillate `Syncing…` → `Pending
sync` → `Syncing…` → `Done`, which is noisy and reveals
implementation detail.

**Decision: fold `syncing` into `Pending sync` visually.** The captain's
mental model is binary — "is it done yet or not?" — and a third badge
state ("Syncing…" with a spinner) buys nothing except more flicker
during concurrent saves. The badge therefore renders:

| Server state | Badge shown |
|---|---|
| `pending` | ⚪ Pending sync |
| `syncing` | ⚪ Pending sync (same copy, same neutral tone) |
| `done` | ✅ Synced {relativeTime} |
| `failed` | ❌ Failed: … |

We reserve the option to introduce a distinct "Syncing…" badge later
if user research shows captains genuinely need progress feedback —
e.g. if sync routinely takes more than a few seconds. For the day-1
median case (sub-second sync against Discord's API) the simpler model
wins.

The save toast (`m.teamSettings_onboardingSavedSyncing()` —
"Saved. Syncing to Discord…") covers the immediate-feedback gap that
a "Syncing…" badge would otherwise fill, and auto-dismisses in ~3 s.

---

**Design dependencies for implementation:**

- New shadcn primitives: `alert`, `toggle-group` (must run
  `pnpm -C ./applications/web dlx shadcn@latest add alert toggle-group`).
- New `success` Badge variant in `components/ui/badge.tsx` (one-line
  diff to the `cva` definition).
- New domain field `discordRoles: ReadonlyArray<DiscordRoleInfo>` —
  shape `{ id: string; name: string; color: number; position: number }`
  — loaded into the team-settings loader, sourced from the architect's
  new day-1 `Guild/ListGuildRoles(guild_id)` RPC. Server should pre-filter
  `@everyone` and managed roles; web filters defensively as a fallback.
- Typed sync-error union (`role_deleted | channel_deleted |
  community_disabled | generic`) on the `OnboardingSyncRow` returned
  from the loader, used to pick badge copy in §3.
- New i18n keys above added to both `packages/i18n/messages/en.json`
  and `cs.json`, then `pnpm codegen`.
