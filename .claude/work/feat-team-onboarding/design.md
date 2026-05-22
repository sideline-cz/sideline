# Team Onboarding — UX/UI Design Spec

Two-surface flow that lets a global admin mint a single-use onboarding token bound to a specific Discord user, hand it to a prospective team captain, and have that captain self-serve the entire team-creation step on a public page that requires Discord sign-in before any team data is captured.

The design mirrors existing Sideline patterns end-to-end — no new layout primitives, no new icon system, no new colour tokens. Anything not specified below should follow `applications/web/AGENTS.md` defaults.

---

## 1. Surface Inventory

### New routes

| Route | Purpose | Auth gate | File |
|---|---|---|---|
| `/admin/team-onboarding` | Global-admin index: form to mint a token + list of pending tokens | `beforeLoad`: `user?.isGlobalAdmin` else `redirect({ to: '/' })` | `routes/(authenticated)/admin/team-onboarding.tsx` |
| `/onboarding/$token` | Public captain-facing onboarding wizard | None on the route itself — the wizard renders an unauthenticated splash until Discord sign-in is complete | `routes/onboarding.$token.tsx` |

### New pages (`src/components/pages/`)

| Component | Drives route | Notes |
|---|---|---|
| `TeamOnboardingAdminPage` | `/admin/team-onboarding` | Single-page-with-dialog pattern (see web AGENTS.md). Inline mint card on top, table of pending tokens below. |
| `OnboardingPage` | `/onboarding/$token` | Token-state router: dispatches to one of five sub-screens based on `OnboardingTokenStatus` (the new one being `wrongCaptain`). |

### New organisms (`src/components/organisms/`)

| Component | Owns | Notes |
|---|---|---|
| `MintOnboardingTokenForm` | Mint card on admin page | React Hook Form + Effect Schema, `useRun()`. |
| `OnboardingTokenTable` | Token list on admin page | Table identical in shape to `TeamInvitesPage` invite table. |
| `OnboardingWizard` | The 2-step wizard inside `OnboardingPage` | Owns step state, draft state, submit. Only mounted after the bound Discord user is authenticated. |
| `OnboardingTokenLinkCard` | Generated-link panel reused inside the mint card after success | Mirrors the post-create branch of `CreateInviteDialog`. |
| `OnboardingSignInGate` | Unauthenticated splash on `/onboarding/$token` | Shows only the brand line and the "Sign in with Discord" CTA. No form fields. |

### New molecules (`src/components/molecules/`)

| Component | Purpose |
|---|---|
| `WizardStepper` | Horizontal stepper showing 2 steps with current/done/upcoming states. Pure presentational, accepts `steps` and `currentStep`. |
| `OnboardingTokenStatusBadge` | Wraps `Badge` from ui with the four token states (active/expired/consumed/revoked). Maps state → `Badge` variant. |

### New atoms (`src/components/atoms/`)

| Component | Purpose |
|---|---|
| `LogoUploadField` | Logo dropzone + preview avatar + clear button. Wraps an `<input type='file' accept='image/*'>` hidden behind a clickable card. Returns either a public URL (after upload) or `null`. Only rendered post-auth inside Step 1. |
| `DiscordIdField` | Snowflake input. Numeric-only with paste sanitation (strips `<@!>` mention wrappers). Validates the 17–20-digit Discord ID shape on blur. |

### Reused

- `ui/{button,card,input,textarea,form,dialog,select,separator,badge,avatar,alert,skeleton}` — Shadcn primitives only.
- `LanguageSwitcher` — header of public onboarding page (visible even in the unauthenticated splash).
- `SearchableSelect` (`components/atoms/`) — Discord guild / channel pickers.
- `useFormatDate` — relative + absolute timestamps for token expiry.
- `useRun()` / `ApiClient` / `ClientError` — every API call.
- `tr()` from `~/lib/translations.js` — every user-facing string.

---

## 2. Admin Page — `/admin/team-onboarding`

### User flow

1. Global admin opens `/admin/team-onboarding` from the sidebar (new admin sub-item next to "Translations").
2. Sees a **Mint card** at the top of the page and a **Pending tokens** table below.
3. Fills in placeholder team name + the captain's Discord user ID, picks a TTL, clicks **Generate onboarding link**.
4. The card swaps in-place to a success state with the URL pre-filled in a read-only input, a copy button, the bound Discord ID, and the expiry timestamp.
5. Clicking **Mint another** resets the card. The pending tokens table re-fetches and the newly minted row appears at the top with status `Active`.
6. For each pending row the admin can copy the link again or revoke it.

### Layout (desktop)

```
┌───────────────────────────────────────────────────────────────────────────┐
│  ← Back to admin                                                           │
│  Team onboarding                                                           │
│                                                                            │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │ ◔  Generate a new onboarding link                                 │    │
│  │    A link that lets a captain set up their team. One-time use,    │    │
│  │    bound to a single Discord account.                             │    │
│  │ ─────────────────────────────────────────────────────────────────│    │
│  │  Team name placeholder *                                          │    │
│  │  [ FC Sidewinders                                  ]              │    │
│  │  Shown only to you in the pending list. The captain renames.      │    │
│  │                                                                   │    │
│  │  Captain Discord ID *                                             │    │
│  │  [ 123456789012345678                               ]             │    │
│  │  Send this link only to this captain. Other Discord accounts      │    │
│  │  cannot use it.                                                   │    │
│  │                                                                   │    │
│  │  Token expires after                                              │    │
│  │  ( ) 24 hours   ( ) 72 hours   (•) 7 days                         │    │
│  │                                                                   │    │
│  │  [ Generate onboarding link ]   Cancel                            │    │
│  └───────────────────────────────────────────────────────────────────┘    │
│                                                                            │
│  Pending tokens                                                            │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ Team placeholder │ Discord ID         │ Created │ Expires │ Status│    │
│  ├──────────────────────────────────────────────────────────────────┤    │
│  │ FC Sidewinders   │ 1234…5678          │ today   │ in 7d   │Active │    │
│  │  └ [Copy link]  [Revoke]                                          │    │
│  │ Lokomotiv U17    │ 9876…5432          │ 2d ago  │ in 5d   │Active │    │
│  │ Old Stars        │ 5544…3322          │ 6h ago  │ in 18h  │Active │    │
│  │ Beach Devs       │ 1122…3344          │ 9d ago  │ —       │Used   │    │
│  │ Practice Lads    │ 7788…9900          │ 9d ago  │ 2d ago  │Expired│    │
│  └──────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────────┘
```

Responsive collapse follows `TeamInvitesPage`:
- `<sm`: hide Created column.
- `<md`: hide Discord ID column. Status badge always visible.
- `<lg`: hide Expires column (move into Status badge as `Expires in 5d`).

The Discord ID column shows the first four and last four digits joined with `…` for visual scanning; full ID is in the row's tooltip and copyable via the row-action menu.

### Success-state Mint card (after token is generated)

```
┌───────────────────────────────────────────────────────────────────┐
│ ✓  Link generated for FC Sidewinders                              │
│    Send this link only to Discord ID 123456789012345678.          │
│    It expires in 7 days. Other Discord accounts cannot use it.    │
│ ─────────────────────────────────────────────────────────────────│
│  Onboarding link                                                  │
│  [ https://sideline.app/onboarding/a1b2c3...     ] [ Copy ⧉ ]    │
│  Link copied!                                                     │
│                                                                   │
│  Bound Discord ID: 123456789012345678                             │
│  Expires: 29 May 2026, 14:23                                      │
│                                                                   │
│  [ Mint another ]   [ Done ]                                      │
└───────────────────────────────────────────────────────────────────┘
```

### Component breakdown

- **Card 1 — Mint card** (`MintOnboardingTokenForm`). Two states: `idle` (form) and `success` (link panel). State lives in the organism, not the page.
- **Card 2 — Token table** (`OnboardingTokenTable`). Loads from route loader, paginated via the same approach as `TeamInvitesPage` (no pagination yet, but `ORDER BY created_at DESC` + stable tiebreaker).
- Both cards stacked vertically inside `max-w-3xl` centered container; page header uses the existing `← Back` + `<h1>` pattern from `TeamSettingsPage`.

### Form fields & validation

| Field | Type | Validation | Schema |
|---|---|---|---|
| `proposedName` | text | required, 1–100 chars | `Schema.NonEmptyString.pipe(Schema.maxLength(100))` |
| `boundDiscordId` | Snowflake (numeric string) | required, 17–20 digits, all numeric | `Discord.Snowflake` (existing branded type from the backend; same one used for guild/channel IDs) |
| `expiryDuration` | radio | one of `'P1D' \| 'P3D' \| 'P7D'` | `Schema.Literal('P1D', 'P3D', 'P7D')`, default `'P7D'` |

Server-rejected duplicates (e.g. the same Discord ID already has an active token) surface via `Effect.catchTag('TokenAlreadyExists', ...)` → `tr('teamOnboarding_error_tokenAlreadyExists')` toast; the form stays open with the Discord ID field focused. Server-rejected unknown Discord users surface via `Effect.catchTag('DiscordUserUnknown', ...)` → `tr('teamOnboarding_error_discordUserUnknown')` inline `FormMessage` on the Discord ID field.

### Token states & badge mapping

| Status | Badge variant | Tooltip / sub-label |
|---|---|---|
| `active` | `default` (primary) | `Expires in {relative}` |
| `expired` | `outline` | `Expired {relative}` |
| `consumed` | `success` | `Team created {relative} · View team →` |
| `revoked` | `secondary` | `Revoked by {adminName}` |

(`consumed` rows include a `View team →` link pointing to `/teams/$teamId` — link is hidden if the row was created by another admin and the current admin lacks `viewAllTeams`.)

### States — Admin page

- **Loading** (loader fetches in parallel: list of pending tokens). Render `<Skeleton className='h-9 w-40'/>` for the header + a 3-row skeleton table inside the second Card.
- **Empty pending list**. Show the table card with `<p className='text-muted-foreground py-6 text-center'>{tr('teamOnboarding_empty')}</p>` — matches `TeamInvitesPage`.
- **Mint error**. Toast via `run({})`'s default error path. Form stays editable, button re-enables. No inline error block for transport failures — only for validation failures (handled by `FormMessage`).
- **Copy fallback**. If `navigator.clipboard.writeText` rejects, fall back to selecting the input via `inputRef.current?.select()` and show `tr('teamOnboarding_copyFallback')`.

---

## 3. Public Onboarding Page — `/onboarding/$token`

### Token-state router

`OnboardingPage` reads the loader-fetched `tokenState` (a tagged union from the API) and renders one of five sub-views. The loader does NOT throw on `expired` / `consumed` / `invalid` / `wrongCaptain` — those are first-class UX states, not errors.

```
              ┌── valid + signedOut    ──→  <OnboardingSignInGate token={...} />
              │
              ├── valid + signedIn(ok) ──→  <OnboardingWizard token={...} viewer={...} />
              │
tokenState ──┼── wrongCaptain          ──→  <OnboardingMessageCard variant='destructive' ... />
              │
              ├── expired              ──→  <OnboardingMessageCard variant='warning'    ... />
              │
              ├── consumed             ──→  <OnboardingMessageCard variant='success'    ... />
              │
              └── invalid              ──→  <OnboardingMessageCard variant='destructive' ... />
```

`OnboardingMessageCard` is a tiny inline component inside `OnboardingPage.tsx` (does not warrant its own file). It wraps an `Alert` + `CardHeader` + optional `CardContent` action button.

The `wrongCaptain` branch is only reachable after Discord sign-in: the server compares the viewer's Discord ID against the token's `boundDiscordId` and returns this tag if they differ.

### Shell (all variants)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Sideline                                          [ Czech │ English ]│
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                        ┌──────────────────────────┐                  │
│                        │      (state content)     │                  │
│                        └──────────────────────────┘                  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

Header is the same `flex items-center justify-between px-6 py-4 border-b` block used by `InvitePage` and `CreateTeamPage`; centered `max-w-lg` card; never any sidebar (the wizard is gated on Discord sign-in, not on a Sideline session).

### State: VALID + SIGNED OUT — Sign-in gate

The first thing the captain sees. No form fields. No previewed team data. Just the brand line and a single CTA.

```
┌────────────────────────────────────────────────────────────┐
│                                                            │
│                Set up your team on Sideline                │
│                                                            │
│   Sign in with Discord to continue. This link is bound to  │
│   a specific Discord account — only that account can use   │
│   it.                                                      │
│                                                            │
│              [ Sign in with Discord ]                      │
│                                                            │
│   We'll bring you back here after sign-in.                 │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

(`setPendingOnboardingToken(token)` is stashed in localStorage before redirecting, exactly like `setPendingInvite` does in `routes/invite.$code.tsx`. The post-sign-in callback restores the token from localStorage and re-renders the route.)

### State: VALID + SIGNED IN — Wizard

2-step linear wizard. Stepper at the top of the card, Back / Next at the bottom. No skip-ahead; the user can go back without losing data (state lives in the organism for the lifetime of the page).

```
┌────────────────────────────────────────────────────────────┐
│   ●———————————○                                            │
│  Identity  ·  Discord                                      │
│  ──────────────────────────────────────────────────────── │
│                                                            │
│   (step content)                                           │
│                                                            │
│  ──────────────────────────────────────────────────────── │
│            [ ← Back ]              [ Next → ]              │
└────────────────────────────────────────────────────────────┘
```

#### Step 1 — Identity

```
┌────────────────────────────────────────────────────────────┐
│  Set up your team                                          │
│  Tell us about your team. Only the name is required.       │
│                                                            │
│  Team name *                                               │
│  [ FC Sidewinders                                ]         │
│                                                            │
│  Short description (optional)                              │
│  [                                                ]        │
│  [                                                ]        │
│  140 characters max · shows on the team dashboard          │
│                                                            │
│  Sport (optional)                                          │
│  [ Football                              ▾ ]               │
│  Searchable; type a custom one if it isn't listed.         │
│                                                            │
│  Team logo (optional)                                      │
│  ┌──────────────────────────────────────────────────┐     │
│  │                  [ click or drop ]                │     │
│  │           PNG, JPG, or SVG · max 2 MB             │     │
│  └──────────────────────────────────────────────────┘     │
│                                                            │
│  [ Next → ]                                                │
└────────────────────────────────────────────────────────────┘
```

After upload:

```
┌──────────────────────────────────────────────────────┐
│   ┌────┐                                             │
│   │ FC │   logo.png · 124 KB     [ Replace ] [ ✕ ]   │
│   └────┘                                             │
└──────────────────────────────────────────────────────┘
```

The `LogoUploadField` is only ever rendered inside the post-auth Step 1. The unauthenticated splash never shows it.

#### Step 2 — Discord

This step always runs post-auth (the wizard is unreachable otherwise), so there's no nested "sign in" branch.

```
┌────────────────────────────────────────────────────────────┐
│  Discord server                                            │
│  Pick the server your team uses, then choose two channels. │
│                                                            │
│  ┌──────────────────────────────────────────────────┐     │
│  │ ◔  FC Sidewinders Server                         │ →   │  (clickable row, hover bg)
│  │    Owner · Bot active                            │     │
│  │ ◔  Tuesday Pickup                                │ →   │
│  │    Bot not added                                 │     │
│  └──────────────────────────────────────────────────┘     │
│  Don't see your server? [ Refresh ]                        │
│                                                            │
│  (If chosen server has bot NOT added, expand into:)        │
│  ┌──────────────────────────────────────────────────┐     │
│  │ ⚠  Add the Sideline bot to Tuesday Pickup        │     │
│  │    [ Add Sideline Bot ↗ ]   [ I've added it ]    │     │
│  └──────────────────────────────────────────────────┘     │
│                                                            │
│  Welcome channel (optional)                                │
│  Where new members see your team's welcome message.        │
│  This channel must be visible to all members.              │
│  [ # general                              ▾ ]              │
│                                                            │
│  System log channel (optional)                             │
│  Hidden channel where captain-only join events are logged. │
│  Keep this hidden from members.                            │
│  [ # captain-log                          ▾ ]              │
│  ⓘ Auto-detected as a private channel — good.             │
│                                                            │
│  Team language                                             │
│  ( ) English   (•) Čeština                                 │
│  Sets the default language for system messages.            │
│                                                            │
│  [ ← Back ]                       [ Create team ]          │
└────────────────────────────────────────────────────────────┘
```

The two channel selects reuse `SearchableSelect` with the same option shape as `TeamSettingsPage` (`{ value: id, label: '# name' }`, filter by `DISCORD_CHANNEL_TYPE_TEXT`). The system-log channel gets a small `ⓘ` line that turns green when the API reports the channel as captain-only (i.e. `everyone-role` does NOT have `VIEW_CHANNEL`), and shows an amber warning `⚠ Anyone can see this channel — pick a private one to keep join logs captain-only.` otherwise.

Both channel selects are **optional**; the captain can defer the choice and configure channels later from `TeamSettingsPage`. Locale defaults to the browser locale (or Czech if matched).

After "Create team" → API call → on success, navigate to **success screen** (replaces the wizard card).

#### Success screen

```
┌──────────────────────────────────────────────────────┐
│                       ✓                              │
│                                                      │
│           Welcome to Sideline, FC Sidewinders!       │
│                                                      │
│   Your team is ready. You're set as the captain.     │
│   You can invite players, set up rosters, and        │
│   configure everything else from your dashboard.     │
│                                                      │
│            [ Go to your team dashboard → ]           │
└──────────────────────────────────────────────────────┘
```

### State: WRONG CAPTAIN (403)

Reached when the viewer signs in with a Discord account that does not match the token's `boundDiscordId`. The wizard never mounts.

```
┌──────────────────────────────────────────────────────┐
│                       ⛔                             │
│                                                      │
│            This link is for a different captain       │
│                                                      │
│   You're signed in as @your.handle (ID 9876…5432).   │
│   This link is bound to a different Discord account. │
│   Ask your admin to send you a new link for          │
│   @your.handle.                                      │
│                                                      │
│      [ Sign in as a different user ]   [ Home ]      │
│                                                      │
└──────────────────────────────────────────────────────┘
```

`variant='destructive'` styling. The "Sign in as a different user" CTA clears the current session (`POST /auth/logout`) and redirects to `/login?next=/onboarding/$token` so the captain can retry with the right account.

### State: EXPIRED

```
┌──────────────────────────────────────────────────────┐
│                       ⏱                             │
│                                                      │
│              This onboarding link expired            │
│                                                      │
│   Ask the person who sent you the link to issue a    │
│   new one.                                           │
│                                                      │
│                  [ Back to Sideline ]                │
└──────────────────────────────────────────────────────┘
```

`variant='warning'` on the `Alert` inside, plus the `Clock` icon from `lucide-react`.

### State: CONSUMED

```
┌──────────────────────────────────────────────────────┐
│                       ✓                              │
│                                                      │
│           This link has already been used            │
│                                                      │
│   The team was created on 4 May 2026. If that was    │
│   you, sign in to access your team.                  │
│                                                      │
│        [ Sign in with Discord ]   [ Home ]           │
└──────────────────────────────────────────────────────┘
```

`variant='success'` styling but informational.

### State: INVALID

```
┌──────────────────────────────────────────────────────┐
│                       ⚠                              │
│                                                      │
│             This onboarding link is invalid          │
│                                                      │
│   The link is malformed or no longer exists.         │
│   Check the URL or ask for a fresh link.             │
│                                                      │
│                  [ Back to Sideline ]                │
└──────────────────────────────────────────────────────┘
```

`variant='destructive'` styling.

### States — Wizard

- **Loading** (loader resolving token state + Discord viewer). Centered `<Skeleton className='h-64 w-full max-w-lg' />` inside the same outer shell.
- **Submitting** (final step). The "Create team" button uses `form.formState.isSubmitting` to show `tr('onboarding_creating')` and disable both Back and Create.
- **Submission error**. Toast via `run({ success: ... })`; user stays on Step 2 with values intact. Specific tagged errors:
  - `TokenAlreadyConsumed` → swap the whole card to the CONSUMED state (race: someone else completed the same token between loader fetch and submit).
  - `TokenExpired` → swap to EXPIRED.
  - `TokenWrongCaptain` → swap to WRONG CAPTAIN (race: viewer was signed in under the right account when the page loaded but switched accounts mid-flow).
  - `DiscordPermissionDenied` → inline `Alert variant='destructive'` above the buttons with `tr('onboarding_error_discord_permission')`.
  - Anything else → generic toast `tr('onboarding_error_submitFailed')`.
- **File upload error**. Inline `<p className='text-xs text-destructive'>` below the `LogoUploadField` zone, do NOT block Next — uploads on Step 1 are optional, so any upload failure simply leaves logo unset.

### State diagram (token + viewer)

```
                   (load /onboarding/$token)
                              │
                              ▼
                       ┌──────────────┐
                       │  fetch token │
                       └──────┬───────┘
                              │
        ┌────────────┬────────┼────────┬────────────────┐
        ▼            ▼        ▼        ▼                ▼
     invalid     expired  consumed   valid          (server error)
        │            │        │        │                │
        │            │        │        ▼                │
        │            │        │   viewer signed in?     │
        │            │        │     ┌───┴────┐          │
        │            │        │     no       yes        │
        │            │        │      │        │         │
        │            │        │      ▼        ▼         │
        │            │        │  signInGate   id match? │
        │            │        │     │        ┌──┴───┐   │
        │            │        │     │       no      yes │
        │            │        │     │        │       │  │
        ▼            ▼        ▼     │        ▼       ▼  ▼
   invalid card  expired   consumed │  wrongCaptain  wizard  routeError
                  card      card    │     card
                                    └────────── (sign in) ─→ re-enter
```

---

## 4. Microcopy (primary CTAs & helper text)

All keys live under `teamOnboarding_*` (admin surface) and `onboarding_*` (public surface).

### Admin (`teamOnboarding_*`)

| Key | English | Czech |
|---|---|---|
| `teamOnboarding_title` | Team onboarding | Onboarding týmu |
| `teamOnboarding_mintTitle` | Generate a new onboarding link | Vygenerovat nový onboarding odkaz |
| `teamOnboarding_mintDescription` | A one-time link that lets a captain set up their team. The link is bound to a single Discord account. | Jednorázový odkaz, kterým si kapitán nastaví svůj tým. Odkaz je svázaný s jedním Discord účtem. |
| `teamOnboarding_teamNameLabel` | Team name placeholder | Pracovní název týmu |
| `teamOnboarding_teamNameHelp` | Shown only to you in the list below. The captain picks the final name. | Vidíte jen vy v seznamu níže. Kapitán vybere finální název. |
| `teamOnboarding_discordIdLabel` | Captain Discord ID | Discord ID kapitána |
| `teamOnboarding_discordIdHelp` | Send this link only to this captain. Other Discord accounts cannot use it. | Pošlete odkaz pouze tomuto kapitánovi. Jiné Discord účty ho nepoužijí. |
| `teamOnboarding_discordIdPlaceholder` | e.g. 123456789012345678 | např. 123456789012345678 |
| `teamOnboarding_expiryLabel` | Token expires after | Token vyprší za |
| `teamOnboarding_expiry24h` | 24 hours | 24 hodin |
| `teamOnboarding_expiry72h` | 72 hours | 72 hodin |
| `teamOnboarding_expiry7d` | 7 days | 7 dní |
| `teamOnboarding_mintSubmit` | Generate onboarding link | Vygenerovat odkaz |
| `teamOnboarding_minting` | Generating… | Generuji… |
| `teamOnboarding_mintSuccessTitle` | Link generated for {teamName} | Odkaz pro {teamName} vygenerován |
| `teamOnboarding_mintSuccessDescription` | Send this link only to Discord ID {discordId}. It expires in {expiry}. Other Discord accounts cannot use it. | Pošlete odkaz pouze Discord ID {discordId}. Vyprší za {expiry}. Jiné Discord účty ho nepoužijí. |
| `teamOnboarding_linkLabel` | Onboarding link | Onboarding odkaz |
| `teamOnboarding_boundDiscordIdLabel` | Bound Discord ID | Svázané Discord ID |
| `teamOnboarding_expiresAt` | Expires | Vyprší |
| `teamOnboarding_copyLink` | Copy link | Zkopírovat odkaz |
| `teamOnboarding_linkCopied` | Link copied! | Odkaz zkopírován! |
| `teamOnboarding_copyFallback` | Press ⌘C / Ctrl+C to copy. | Stiskněte ⌘C / Ctrl+C ke zkopírování. |
| `teamOnboarding_mintAnother` | Mint another | Vygenerovat další |
| `teamOnboarding_done` | Done | Hotovo |
| `teamOnboarding_pendingTitle` | Pending tokens | Nevyužité tokeny |
| `teamOnboarding_empty` | No tokens yet. Generate one above to get started. | Zatím žádné tokeny. Vygenerujte první výše. |
| `teamOnboarding_col_team` | Team placeholder | Pracovní název |
| `teamOnboarding_col_discordId` | Discord ID | Discord ID |
| `teamOnboarding_col_created` | Created | Vytvořeno |
| `teamOnboarding_col_expires` | Expires | Vyprší |
| `teamOnboarding_col_status` | Status | Stav |
| `teamOnboarding_status_active` | Active | Aktivní |
| `teamOnboarding_status_expired` | Expired | Vypršelo |
| `teamOnboarding_status_consumed` | Used | Použito |
| `teamOnboarding_status_revoked` | Revoked | Zrušeno |
| `teamOnboarding_revoke` | Revoke | Zrušit |
| `teamOnboarding_revokeConfirm` | Revoke this onboarding link? The captain will no longer be able to use it. | Zrušit tento onboarding odkaz? Kapitán už ho nepoužije. |
| `teamOnboarding_revokeSuccess` | Token revoked. | Token zrušen. |
| `teamOnboarding_revokeFailed` | Failed to revoke token. | Zrušení tokenu se nezdařilo. |
| `teamOnboarding_viewTeam` | View team | Zobrazit tým |
| `teamOnboarding_error_tokenAlreadyExists` | An active token already exists for this Discord ID. | Pro toto Discord ID už aktivní token existuje. |
| `teamOnboarding_error_discordUserUnknown` | We can't find a Discord user with that ID. Double-check it. | Discord uživatele s tímto ID neznáme. Zkontrolujte ID. |
| `teamOnboarding_validation_discordIdInvalid` | Enter a valid Discord ID (17–20 digits, numbers only). | Zadejte platné Discord ID (17–20 číslic). |

### Public (`onboarding_*`)

| Key | English | Czech |
|---|---|---|
| `onboarding_step_identity` | Identity | Identita |
| `onboarding_step_discord` | Discord | Discord |
| `onboarding_signIn_title` | Set up your team on Sideline | Nastavte svůj tým v Sideline |
| `onboarding_signIn_description` | Sign in with Discord to continue. This link is bound to a specific Discord account — only that account can use it. | Pokračujte přihlášením přes Discord. Tento odkaz je svázaný s konkrétním Discord účtem a jiný účet ho nepoužije. |
| `onboarding_signIn_button` | Sign in with Discord | Přihlásit přes Discord |
| `onboarding_signIn_returnHint` | We'll bring you back here after sign-in. | Po přihlášení vás sem vrátíme. |
| `onboarding_identity_title` | Set up your team | Nastavení týmu |
| `onboarding_identity_description` | Tell us about your team. Only the name is required. | Pár údajů o týmu. Povinný je jen název. |
| `onboarding_teamNameLabel` | Team name | Název týmu |
| `onboarding_teamNamePlaceholder` | e.g. FC Sidewinders | např. FC Sidewinders |
| `onboarding_descriptionLabel` | Short description (optional) | Krátký popis (volitelné) |
| `onboarding_descriptionHelp` | 140 characters max · shows on the team dashboard. | Max 140 znaků · zobrazí se na nástěnce týmu. |
| `onboarding_sportLabel` | Sport (optional) | Sport (volitelné) |
| `onboarding_sportHelp` | Searchable; type a custom one if it isn't listed. | Lze vyhledat; pokud chybí, zadejte vlastní. |
| `onboarding_logoLabel` | Team logo (optional) | Logo týmu (volitelné) |
| `onboarding_logoHint` | PNG, JPG, or SVG · max 2 MB | PNG, JPG nebo SVG · max 2 MB |
| `onboarding_logoReplace` | Replace | Vyměnit |
| `onboarding_logoRemove` | Remove logo | Odstranit logo |
| `onboarding_logoUploadFailed` | Couldn't upload that file. Try another one. | Nepodařilo se nahrát. Zkuste jiný soubor. |
| `onboarding_discord_title` | Discord server | Discord server |
| `onboarding_discord_description` | Pick the server your team uses, then choose two channels. | Vyberte server, který tým používá, a dva kanály. |
| `onboarding_welcomeChannelLabel` | Welcome channel (optional) | Uvítací kanál (volitelné) |
| `onboarding_welcomeChannelHelp` | Where new members see your team's welcome message. This channel must be visible to all members. | Kde noví členové uvidí uvítací zprávu. Musí být viditelný pro všechny členy. |
| `onboarding_systemChannelLabel` | System log channel (optional) | Systémový kanál (volitelné) |
| `onboarding_systemChannelHelp` | Hidden channel where captain-only join events are logged. Keep this hidden from members. | Skrytý kanál pro záznam událostí jen pro kapitány. Členové by ho vidět neměli. |
| `onboarding_systemChannelPrivateOk` | Auto-detected as a private channel — good. | Rozpoznán jako soukromý kanál — v pořádku. |
| `onboarding_systemChannelPublicWarn` | Anyone can see this channel — pick a private one to keep join logs captain-only. | Tento kanál je viditelný pro všechny — vyberte soukromý, aby zápisy zůstaly jen pro kapitány. |
| `onboarding_localeLabel` | Team language | Jazyk týmu |
| `onboarding_localeHelp` | Sets the default language for system messages. | Nastaví výchozí jazyk systémových zpráv. |
| `onboarding_locale_en` | English | Angličtina |
| `onboarding_locale_cs` | Čeština | Čeština |
| `onboarding_back` | Back | Zpět |
| `onboarding_next` | Next | Pokračovat |
| `onboarding_create` | Create team | Vytvořit tým |
| `onboarding_creating` | Creating your team… | Vytvářím tým… |
| `onboarding_success_title` | Welcome to Sideline, {teamName}! | Vítejte v Sideline, {teamName}! |
| `onboarding_success_description` | Your team is ready. You're set as the captain. You can invite players, set up rosters, and configure everything else from your dashboard. | Tým je připravený. Jste kapitán. Z nástěnky můžete pozvat hráče, založit soupisky a vše ostatní nastavit. |
| `onboarding_success_cta` | Go to your team dashboard | Přejít na nástěnku týmu |
| `onboarding_wrongCaptain_title` | This link is for a different captain | Tento odkaz patří jinému kapitánovi |
| `onboarding_wrongCaptain_description` | You're signed in as {viewerHandle} ({viewerId}). This link is bound to a different Discord account. Ask your admin to send you a new link for {viewerHandle}. | Jste přihlášen jako {viewerHandle} ({viewerId}). Tento odkaz patří jinému Discord účtu. Požádejte správce o nový odkaz pro {viewerHandle}. |
| `onboarding_wrongCaptain_switchUser` | Sign in as a different user | Přihlásit jiným účtem |
| `onboarding_expired_title` | This onboarding link expired | Onboarding odkaz vypršel |
| `onboarding_expired_description` | Ask the person who sent you the link to issue a new one. | Požádejte odesílatele o nový odkaz. |
| `onboarding_consumed_title` | This link has already been used | Tento odkaz už byl použit |
| `onboarding_consumed_description` | The team was created on {date}. If that was you, sign in to access your team. | Tým byl vytvořen {date}. Pokud jste to byli vy, přihlaste se. |
| `onboarding_consumed_signIn` | Sign in with Discord | Přihlásit přes Discord |
| `onboarding_invalid_title` | This onboarding link is invalid | Onboarding odkaz není platný |
| `onboarding_invalid_description` | The link is malformed or no longer exists. Check the URL or ask for a fresh link. | Odkaz je poškozený nebo neexistuje. Zkontrolujte URL nebo si vyžádejte nový. |
| `onboarding_home` | Back to Sideline | Zpět na Sideline |
| `onboarding_error_submitFailed` | Couldn't create your team. Please try again. | Tým se nepodařilo vytvořit. Zkuste to znovu. |
| `onboarding_error_discord_permission` | We couldn't access the Discord server. Make sure the bot is added and has Manage Channels permission. | Discord server není dostupný. Zkontrolujte, že bot je přidán a má oprávnění Manage Channels. |
| `onboarding_validation_teamNameRequired` | Pick a team name. | Vyberte název týmu. |
| `onboarding_validation_teamNameTooLong` | Team name is too long (max 100 characters). | Název je příliš dlouhý (max 100 znaků). |
| `onboarding_validation_descriptionTooLong` | Description is too long (max 140 characters). | Popis je příliš dlouhý (max 140 znaků). |

---

## 5. Wizard Form Fields & Validation

The full wizard payload is one Effect Schema struct; per-step validation is enforced by gating the **Next** button on `form.trigger([fieldsOfThisStep])`.

```ts
const OnboardingFormSchema = Schema.Struct({
  // Step 1 — Identity
  teamName: Schema.NonEmptyString.pipe(
    Schema.maxLength(100, { message: () => tr('onboarding_validation_teamNameTooLong') }),
  ).annotate({ message: () => tr('onboarding_validation_teamNameRequired') }),
  description: Schema.OptionFromNullOr(
    Schema.NonEmptyString.pipe(
      Schema.maxLength(140, { message: () => tr('onboarding_validation_descriptionTooLong') }),
    ),
  ),
  sport: Schema.OptionFromNullOr(Schema.NonEmptyString),
  logoUrl: Schema.OptionFromNullOr(Schema.NonEmptyString),

  // Step 2 — Discord
  guildId: Discord.Snowflake,
  welcomeChannelId: Schema.OptionFromNullOr(Discord.Snowflake),
  systemLogChannelId: Schema.OptionFromNullOr(Discord.Snowflake),
  locale: Schema.Literal('en', 'cs'),
});
```

Per-step gating:

| Step | Triggered fields | Next/Create button enabled when |
|---|---|---|
| 1 — Identity | `teamName`, `description`, `sport`, `logoUrl` | `teamName` is non-empty AND ≤100 (description/sport/logo are optional) |
| 2 — Discord | `guildId`, `welcomeChannelId`, `systemLogChannelId`, `locale` | `guildId` populated AND bot present in guild AND `locale` chosen (channels remain optional) |

---

## 6. Empty / Loading / Error State Matrix

| Surface | Loading | Empty | Error | Success |
|---|---|---|---|---|
| Admin mint card | n/a (form is always interactive) | n/a | Toast + form stays editable; `TokenAlreadyExists` focuses Discord ID field; `DiscordUserUnknown` shows inline FormMessage | In-place swap to link panel |
| Admin token table | 3-row skeleton (rounded `Skeleton h-10 w-full`) | `tr('teamOnboarding_empty')` muted centred text | Toast (network); loader's `warnAndCatchAll` shows the standard `RouteErrorComponent` for hard failures | Live row added on mint success via `router.invalidate()` |
| Public sign-in gate | Page-level skeleton (`h-48 w-full max-w-lg`) inside the public shell | n/a | n/a (sign-in CTA is the only interactive element) | Redirect to Discord OAuth; on return, wizard mounts |
| Public wizard | Page-level skeleton (`h-64 w-full max-w-lg`) inside the public shell | n/a | Per-step inline `Alert variant='destructive'` for Discord/permission errors; toast for transport errors; token-state errors swap the whole card | Success card with primary CTA |
| Wrong-captain card | n/a | n/a | n/a (this IS an error state) | n/a |
| Logo upload | Field switches to "Uploading…" with a tiny spinner | n/a | Inline `<p className='text-xs text-destructive'>` under the dropzone, Next stays enabled | Avatar + filename + Replace/Remove |

---

## 7. Accessibility

- **Public page** uses `<header>` / `<main>` landmarks just like `InvitePage` for screen-reader navigation. The wizard `<form>` lives inside `<main>`.
- **Sign-in gate** announces its purpose via the `<h1>` heading; the CTA is a single `<Button>` with no decorative-only icons.
- **Stepper** (`WizardStepper`):
  - `role="list"` on the outer container, `role="listitem"` on each step.
  - `aria-current="step"` on the active step.
  - Step labels are real text (no icon-only steps). Each step number is decorative (`aria-hidden`).
- **Wizard buttons**:
  - `Back` is `<Button variant='ghost'>` with `type='button'`.
  - `Next` and `Create team` are `type='submit'` so Enter inside any field advances the step.
  - `disabled={!stepIsValid || form.formState.isSubmitting}` — never grey out the whole form (only the submit button).
- **Token state cards** use `output aria-live='polite'` around the status badge + retry actions, matching the pattern in `TeamSettingsPage`.
- **Wrong-captain card** uses `role='alert'` on the heading so screen readers announce it the moment it mounts (the most common cause of confusion).
- **Copy-to-clipboard** button has a `<span className='sr-only'>{tr('teamOnboarding_copyLink')}</span>`; after copy, `Link copied!` text appears in an `aria-live='polite'` region so screen readers announce it.
- **Discord ID input** (`DiscordIdField`) uses `inputMode='numeric'` and `autoComplete='off'`; the helper text is associated via `aria-describedby`.
- **Logo upload** uses a visible label + a hidden `<input type='file'>` paired by `id`/`htmlFor`. Drop-zone has `role='button'` and `tabIndex={0}` with keyboard handlers (`Enter` / `Space` trigger the file input).
- **System-channel privacy hint** uses `role='status'` so the green-OK / amber-warning transition is announced when the user changes the select.
- **Focus management**:
  - On post-sign-in return, focus moves to the Step 1 heading.
  - On step change, focus moves to the first input/select of the new step.
  - On success screen, focus moves to the primary CTA.
  - On state swap (e.g. valid → wrongCaptain after sign-in), focus moves to the heading inside the new card.
- **Colour**: all status badges have a text label in addition to colour — never colour-only.
- **Keyboard**: every interactive element reachable via Tab; the SearchableSelect already supports keyboard search.

---

## 8. Component Build Order (suggested)

1. `WizardStepper` molecule + Vitest test (renders correct `aria-current`, step labels, dot/line styles for the 2-step shape).
2. `OnboardingTokenStatusBadge` molecule + Vitest test (status → variant mapping).
3. `DiscordIdField` atom + Vitest test (paste-sanitisation strips `<@…>` wrappers, only allows 17–20 digit values).
4. `LogoUploadField` atom — start with URL field only (defer real upload to a follow-up task; the prop accepts a `(file) => Promise<Option<string>>` uploader so the UI shape is stable).
5. `MintOnboardingTokenForm` organism + `OnboardingTokenLinkCard` (success state).
6. `OnboardingTokenTable` organism.
7. `TeamOnboardingAdminPage` page (composes 5 + 6) + route file with `beforeLoad` admin guard.
8. `OnboardingSignInGate` organism (no Sideline-session dependency — only needs the token).
9. `OnboardingWizard` organism — Step 1 first (works as soon as auth is present), then Step 2 (depends on guild + channel API endpoints).
10. `OnboardingPage` page (state router for valid/wrongCaptain/expired/consumed/invalid + signed-out/signed-in fork) + route file.
11. Add navigation entry in `AppSidebar.tsx` under the admin section, gated on `user.isGlobalAdmin`.

---

## 9. Out of Scope (explicit non-goals)

- Sending the onboarding link from Sideline. The admin copies it and DMs the captain on Discord themselves.
- Inviting the captain's first players. That belongs to the existing `/teams/$teamId/invites` surface, which the success-screen CTA naturally leads into.
- Choosing roles / availability during onboarding. Per memory rules, roles are captain-assigned later; we do NOT add a step for this.
- Bulk minting / CSV import of tokens. Single-token mint only for v1.
- Editing a token after mint (e.g. extending expiry, re-binding to a different Discord ID). Revoke + re-mint is the supported path.
- Soft pre-binding via username (e.g. `@captain.handle`). Discord IDs are stable; usernames are not. Bind by ID only.
