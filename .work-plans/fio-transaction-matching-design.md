# Fio bank transaction matching — UX/UI design specification

**Scope:** user-facing design only. No application code is changed by this doc.
**Primary user:** the club treasurer of Ultimate Frisbee Horní Počernice — a
volunteer, ~20–30 paying members across two teams, reconciling by hand today, and
who must hand evidence to Praha 20 for grant contract **S/12/2026/0109** by
**31. 1. 2027**.
**Secondary user:** players, who receive a payment request in Discord and whose
one failure mode is paying without a variable symbol.
**Language:** Czech is primary. All copy below is given in Czech with the English
source string beside it (the repo's base locale is `en`; `cs` is the translation).
**Companion doc:** `.work-plans/fio-transaction-matching.md` (implementation
plan). Where the two touch — match-reason literals, status literals, file names,
the QR delivery channel — **the plan owns the names and this doc owns the copy
and the interaction**. §12 lists every point where this revision moved to meet it.

---

## 0. TL;DR for the implementer

| # | Screen | Route / surface | Verdict |
|---|--------|-----------------|---------|
| 1 | Fio connection | card on `/teams/$teamId/settings` | sibling of `EmailForwardingCard`, same 3-state secret field |
| 2 | Matching queue | **new** `/teams/$teamId/finances/bank?tab=queue` | the primary screen; hand-rolled table like `AssignmentsTab` |
| 3 | Variable symbol | `/teams/$teamId/members` + `members/$memberId` | new column, new field, active gap-surfacing Alert |
| 4 | QR payment | the **existing** payment-reminder DM + `/teams/$teamId/my-payments` | SPAYD payload is diacritic-free; embed copy is not |
| 5 | Grant export | `/teams/$teamId/finances/bank?tab=export` | CSV + formal PDF |

**Zero new Shadcn primitives are required.** Everything is buildable from
`components/ui/*` as it stands today (§9).

**Read §12 first if you have already read an earlier draft of this document.**
Twelve rulings from the adversarial review against the implementation plan
changed this spec; §12 is the diff.

---

## 1. Existing conventions found (audit)

### 1.1 Layout, navigation, page shell

| What | Where | Note |
|---|---|---|
| Sidebar nav groups `team` / `coach` / `administration` | `applications/web/src/components/layouts/AppSidebar.tsx:72-252` | finance entries (`finance_navTitle`, `fees_navTitle`, `expenses_navTitle`) all sit in the **coach** group behind `requiredPermission: 'finance:view'` (`AppSidebar.tsx:189-210`) |
| Nav "needs attention" dot | `AppSidebar.tsx:58-70` (`NavItem.needsAttention`) + `:300-304` | a 2 px destructive `Badge` with an `sr-only` label — a **boolean dot, not a count** |
| Page shell / content padding | `applications/web/src/components/layouts/AuthenticatedLayout.tsx:158-160` | `div.flex.flex-1.flex-col.gap-4.p-4.pt-0` — pages do **not** add their own container width except settings-style pages which use `max-w-2xl` |
| Breadcrumbs | `AuthenticatedLayout.tsx:23-99` | hand-maintained `if (routeId.includes(...))` chain — a new route needs a new branch (`/finances/expenses` is at `:88-90`) |
| Page header pattern | `applications/web/src/components/pages/TeamMembersPage.tsx:33-40`, `TeamSettingsPage.tsx:55-62` | `<Button asChild variant='ghost' size='sm'>` back-link + `<h1 className='text-2xl font-bold'>` |
| Route pending UI | `applications/web/src/components/layouts/RoutePendingComponent.tsx` | a centred spinner with `aria-label={tr('loading_text')}`; `Skeleton` exists (`components/ui/skeleton.tsx`) and is used for **in-page** async regions only |

### 1.2 Finance pages (the closest neighbours)

| What | Where |
|---|---|
| Tab bar, URL-synced via `validateSearch` | `applications/web/src/routes/(authenticated)/teams/$teamId/finances.tsx:23-31,100-110` + `components/pages/FinancesOverviewPage.tsx:292-405` (`role='tablist'`, `aria-selected`, `Button variant='secondary'|'ghost'` with `border-b-2`) |
| KPI strip | `FinancesOverviewPage.tsx:103-118` (`KpiCard`) + `:419-449` (`grid grid-cols-2 gap-3 sm:grid-cols-4`) |
| Filter chips | `FinancesOverviewPage.tsx:126-132,224-240` and `AssignmentsTab.tsx:49-55,120-140` — `<button type='button' aria-pressed>` pills, `rounded-full border px-3 py-1 text-xs` |
| Search box | `AssignmentsTab.tsx:113-119` uses `<Input type='search'>`; `FinancesOverviewPage.tsx:217-223` still uses a raw `<input type='search'>` (**debt** — use `Input`) |
| Data table | `AssignmentsTab.tsx:152-223`, `FinancesOverviewPage.tsx:244-283`, `MyPaymentsPage.tsx:209-285`, `ExpensesListPage.tsx:127-…` — every one is a **hand-rolled `<table className='w-full text-sm'>` inside `div.overflow-x-auto`** |
| Empty states | three distinct ones in `AssignmentsTab.tsx:100-107` (nothing at all), `:144-150` (nothing after filtering, + "Clear filters" button), `FinancesOverviewPage.tsx:186-203` (the happy "all paid" state) |
| Status badge | `components/molecules/PaymentStatusBadge.tsx` — icon + word + colour, `data-status` attribute for tests |
| Money | `src/lib/finance/formatMoney.ts`, `parseAmount.ts`, `computeKpis.ts`, `sortAssignments.ts` |
| Record-payment dialog | `components/organisms/RecordPaymentDialog.tsx` — `Dialog` + plain `useState` form + `Schema.decodeSync(Fee.AmountMinor)` at submit (`:321`) |
| Void semantics already exist | `packages/domain/src/models/Payment.ts:24-26` (`voided_at`, `voided_by_user_id`, `void_reason`), surfaced by `components/organisms/MyPaymentHistoryRow.tsx:91-124` as `opacity-60` + `line-through` + a "Zrušeno" chip |

> **Confirmed: there is no generic sortable/filterable table component.**
> `components/ui/` has no `table.tsx`, and `applications/web/package.json` has no
> `@tanstack/react-table`. Nine pages hand-roll the same `<table>` + chips +
> search trio. **This spec does not fix that** — introducing a shared table is a
> separate refactor PR and must not ride along inside the Fio feature. §9 says
> what to build instead.

### 1.3 The IMAP card — the precedent this feature must mirror

`applications/web/src/components/organisms/team-settings/EmailForwardingCard.tsx`
is the only existing "connect a third-party account with a secret credential"
screen. Its shape:

* **Card, not a page.** One `<Card>` among six on `/teams/$teamId/settings`
  (`components/pages/TeamSettingsPage.tsx:64-101`), `max-w-2xl`, icon + `CardTitle` +
  `CardDescription` header (`EmailForwardingCard.tsx:246-253`).
* **`useCardForm`, not React Hook Form.** The page has six independent Save
  buttons, so the whole `organisms/team-settings/` directory uses
  `useCardForm.ts` with a `*Form.ts` module of pure functions
  (`xFormFrom` / `xRequestFrom` / `validateX`) beside it, plus a unit test that
  asserts *editing any field both flips the dirty flag and changes the request
  JSON*. `emailForwardingForm.ts` + `emailForwardingForm.test.ts` are the model.
* **Write-only secret, three states** (`EmailForwardingCard.tsx:448-512`):
  1. *unset* → `<Input type='password' autoComplete='new-password'>` + help text;
  2. *set, not replacing* → `ShieldCheck` icon + "Password is set" + a
     `variant='outline'` **Replace** button;
  3. *replacing* → the password input plus a **Cancel** button that clears the
     value and returns to state 2.
  The whole block sits inside `<div aria-live='polite'>`. The typed secret is
  deliberately kept **out** of the form values object because "did it change" is
  not an `!==` question (`emailForwardingForm.ts` → `imapSecretPayload`).
* **Connection status is a sentence, not a badge** (`:217-242,530-534`):
  an `Intl.RelativeTimeFormat` line — "Last synced 4 minutes ago (last UID 812)"
  or "Never synced" — inside a second `aria-live='polite'` region, explicitly
  *not* `role='status'` so it does not collide with the neighbouring card.
* **Per-field errors, never a single toast**, each with `aria-invalid` +
  `aria-describedby` (`:360-375`).
* **Disabled sub-sections are `<fieldset disabled>` + `opacity-60`** (`:348`, `:551`).
* **Destructive/irreversible actions get an `AlertDialog`** (`:671-691`, token regeneration).
* Save row: `<Button disabled={saving || !hasChanges || …}>` plus a muted
  "You have unsaved changes." line (`:656-666`; the shared version is
  `team-settings/SaveRow.tsx`).

Two known deviations in that file, **do not copy them**: it calls
`navigator.clipboard.writeText` directly (`:141`) instead of
`~/lib/clipboard.copyToClipboard`, and it hardcodes the English string
`'(regenerate token to reveal URL)'` (`:296`).

### 1.4 i18n

* **Czech is a first-class supported locale.** `packages/i18n/project.inlang/settings.json`
  → `"languageTags": ["en", "cs"]`, `sourceLanguageTag: "en"`. Both
  `packages/i18n/messages/en.json` and `cs.json` currently hold **2 454 keys each**;
  a missing key fails the Paraglide build.
* **Adding a string:** add the key to *both* JSON files → `pnpm codegen` →
  `pnpm build` (so `messagesByKey` in `@sideline/i18n/registry` picks it up).
* **Referencing it from the web:** `tr('key', { param })` from
  `~/lib/translations.js`. Importing `@sideline/i18n/messages` from
  `applications/web/**` is a Biome lint failure.
* **Referencing it from the bot:** `import * as m from '@sideline/i18n/messages'`
  then `m.bot_x_y({ param }, { locale })`. Bot-consumed keys **must** be prefixed
  `bot_` so the `/admin/translations` page can badge them "requires redeploy".
* **Closed unions resolve through an explicit `Record<Union, () => string>`**
  of literal `tr('…')` calls (`src/lib/event-labels.ts:13` idiom). A computed key
  (`` tr(`bank_reason_${reason}`) ``) is banned: `tr()` does not throw on a miss,
  it ships the raw key to the user's screen, and `lib/staticTrKeys.test.ts`
  cannot see it. **This rule governs the match-reason copy in §3.**
  (`PaymentStatusBadge.tsx:50` violates it — pre-existing debt, not precedent.)
* Czech register in the finance family is **formal vykání** —
  `finance_empty_noFeesBody` → "Vytvořte první poplatek…",
  `bot_finance_status_summary` → "Dlužíte {amount}…". Every new key below keeps
  vykání, including the player-facing Discord copy.
* **Found while auditing:** `teamSettings_unsavedChanges` cs value is
  `"Mate neulozone zmeny."` — diacritics missing. Fix to
  `"Máte neuložené změny."` in the same PR; this feature reuses that key.

### 1.5 Discord bot

| What | Where |
|---|---|
| Embed builders live under `src/rest/<feature>/` | `applications/bot/AGENTS.md` § Folder Naming; processors in `src/rcp/<feature>/` import them, never the reverse |
| dfx `UI.*` builders are mandatory | `UI.row([...])`, `UI.button({ style, … })` — never hand-written `type: 1/2` JSON; `style` must always be passed explicitly. Reference: `src/rest/email/buildEmailEmbeds.ts` (`import { UI } from 'dfx'`) |
| Row width, not the 80-char API limit, bounds button labels | >2 buttons per row ⇒ short labels; put the prose in the embed |
| Attachments | `Ix.response({ …, ...filesField(files) })` — `src/rest/rules/clips.ts:86` — the `files` key must be **absent**, not `[]`; the embed points at `attachment://<filename>` (`clips.ts:72`) |
| An `UPDATE_MESSAGE` that omits the attachment **drops** it | `AGENTS.md` § Building Message Components rule 7 — a persistent QR must be re-sent on every press |
| Locale | `userLocale(interaction)` / `guildLocale`; DMs use the **user's** locale (`src/commands/finance/statusHandler.ts:22`) |
| Existing finance embed | `src/rcp/finance/buildPaymentReminderEmbed.ts` — colours `0x5865f2` blurple / `0xfee75c` amber / `0xed4245` red, four inline fields, `footer: { text: 'Sideline' }`. It is still English-only and inline — **`bot_payment_reminder_*` keys must be added, per `AGENTS.md`** (§6.4) |
| Money | `src/rest/finance/formatMoney.ts` → `"1 500 Kč (CZK)"` |
| Any message carrying non-bot-authored text needs `allowed_mentions: { parse: [] }` | e.g. a bank counterparty name or payment message |

### 1.6 What is reusable as-is

`Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`, `Button`,
`Input`, `Label`, `Textarea`, `Select`, `SearchableSelect`, `Checkbox`,
`ToggleGroup`, `Switch`, `Separator`, `Badge`, `Alert`/`AlertTitle`/`AlertDescription`
(incl. `variant='warning'`), `Dialog`, `AlertDialog`, `Sheet`, `Popover`,
`Tooltip`, `Skeleton`, `DatePicker`, `sonner` toasts via `useRun()`,
`PaymentStatusBadge`, `SaveRow`, `useCardForm`, `formatMoney`, `parseAmount`,
`copyToClipboard`, `useFormatDate`, `DirtyFieldLabel` (currently private inside
`PlayerDetailPage.tsx:700`).

---

## 2. Screen 1 — Fio connection (team settings)

### 2.1 Purpose

Let a non-technical treasurer connect the club's Fio account **read-only**, and
— the harder half — tell them the truth about the connection when Fio itself
refuses to. Fio answers *every* token problem with a bodyless **HTTP 500**: no
401, no 403, no message. A brand-new token that has not finished activating, a
token that expired last week, and a Fio outage are byte-identical on the wire.
The UI therefore reasons from **what we stored** (token creation time, last
success) rather than from what the API said.

### 2.2 Placement

A new `<FioBankCard>` on `/teams/$teamId/settings`, rendered from
`TeamSettingsPage.tsx` immediately **after** `EmailForwardingCard` (both are
"connect an external account"; keeping them adjacent teaches the pattern once).
Gate: `finance:manage_fees`.

### 2.3 Layout

```
┌─ Landmark, 🏦 Propojení s bankou (Fio) ─────────────────────────────┐
│ Načítáme platby z účtu klubu a párujeme je s předpisy.              │
├─────────────────────────────────────────────────────────────────────┤
│ [ STATUS BLOCK — one of six, §2.5 ]                                 │
│                                                                      │
│  Zapnuto                                        ( • )  ← Switch     │
│  Bez zapnutí se pohyby nenačítají.                                   │
│  ───────────────────────────────────────────────────────────────    │
│  Číslo účtu klubu                                                    │
│  ┌────────┐   ┌──────────────────┐   ┌────────┐                      │
│  │ 000000 │ – │ 2600123456       │ / │ 2010   │ (pevné, jen Fio)     │
│  └────────┘   └──────────────────┘   └────────┘                      │
│  předčíslí     číslo účtu             kód banky                      │
│  Účet: 2600123456/2010 · IBAN CZ65 2010 0000 0026 0012 3456          │
│  ───────────────────────────────────────────────────────────────    │
│  API token                                                           │
│  ✅ Token je uložený.                      [ Nahradit token ]        │
│     (stav „set, not replacing" — mirror of the IMAP secret)          │
│  ───────────────────────────────────────────────────────────────    │
│  ▸ Kde token vezmu? (rozbalovací návod — §2.4)                       │
│  ───────────────────────────────────────────────────────────────    │
│  Načítání historie                                                   │
│  Poslední úspěšné načtení: před 12 minutami · 342 pohybů celkem      │
│  [ Načíst starší pohyby ]   (→ §2.5 F, the 90-day unlock flow)       │
│                                                                      │
│  [ Uložit změny ]   Máte neuložené změny.                            │
└─────────────────────────────────────────────────────────────────────┘
```

The bank-code box is a **read-only `Input`** showing `2010` with the help line
"Podporujeme zatím jen účty vedené u Fio banky." — not a disabled select, not a
free field the treasurer can get wrong.

### 2.4 "Kde token vezmu?" — the how-to disclosure

A `<Button variant='link' size='sm'>` toggling a `useState` boolean that reveals
an inline `<ol>`. **Not a Tooltip** (never opens on touch) and **not a Popover**
(it is long-form reference the treasurer reads while tabbing between two browser
windows). It renders **expanded by default** in the `not_connected` and
`invalid` states, collapsed otherwise.

Content (key `fio_help_*`):

1. Přihlaste se do **Internetbankingu Fio** (`ib.fio.cz`).
2. Otevřete **Nastavení → API**.
3. Klikněte na **Vytvořit nový token**.
4. U práv zvolte **„Sledování účtu"** — token bude umět jen *číst* pohyby.
5. Vyberte účet klubu a potvrďte.
6. Token se zobrazí **jen jednou**. Zkopírujte ho a vložte sem.

Below the list, a **persistent** (non-dismissible) `<Alert variant='warning'>`
with `AlertTriangle`:

> **Nikdy nevytvářejte token s právem zadávat platební příkazy.**
> Token se sem ukládá proto, aby Sideline viděl příchozí platby. Kdyby takový
> token někdo zneužil, s právem „Sledování účtu" nemůže z účtu odeslat ani
> korunu. S právem zadávat příkazy ano.

And a plain muted line under the token input:

> Token platí **nejvýše 180 dní**. Prodlužuje se sám pokaždé, když se přihlásíte
> do Internetbankingu nebo Smartbankingu — pokud se dlouho nepřihlásíte, token
> tiše vyprší. Upozorníme vás 14 dní předem.

### 2.5 Connection status — the states

One `<FioStatusBlock>` at the top of the card, driven by a **server-computed
status literal** (`BankSyncStatusCode` in `packages/domain/src/models/BankSyncConfig.ts`).
The web must not re-derive it from timestamps — the bot's T−14 DM and this banner
have to agree, and a threshold that lives in two places drifts the first time one
of them moves.

**Two independent channels, not one ladder.** The earlier draft ranked
`expiring_soon` inside the exclusive ladder, which meant a five-minute Fio outage
could hide the single most valuable warning on the screen for hours. It is now a
**second, additive banner**:

* **Exclusive status** (first match wins):
  `misconfigured` › `invalid` › `sync_failing` › `activating` › `ok` › `not_connected`
* **Additive banner**, rendered above the exclusive one whenever present and the
  status is not `not_connected` / `misconfigured`: `expiring_soon`.

`history_locked` is in **neither** — it is a property of the backfill panel (F),
never of the live connection, because live sync is unaffected by it.

Wire contract this implies:

```
status:        'not_connected' | 'activating' | 'ok' | 'sync_failing'
             | 'invalid' | 'misconfigured'
expiringSoon:  Option<{ daysLeft: number; expiresOn: string }>
neverSucceeded: boolean          // lastSuccessAt is None — drives the D2 copy
tokenCreatedAt, lastSuccessAt, lastSyncedAt, importedCount, pendingCount
```

**Mapping onto the plan's `bankSyncStatus.ts` decision table (D11):**

| D11 condition | This spec's state |
|---|---|
| `fio_error` AND token < 5 min old | `activating` |
| `fio_error`, **below** the threshold (see 2.5 D′) | `sync_failing` |
| `fio_error`, at/over the threshold, `last_success_at` present | `invalid` (copy variant 1) |
| `fio_error`, at/over the threshold, `last_success_at` NULL | `invalid` (copy variant 2) |
| `token_created_at + 180d ≤ now` | `invalid` (copy variant 1) |
| decrypt failure / server key missing | `misconfigured` |
| `token_created_at + 180d − now ≤ 14d` | (additive) `expiringSoon` |
| `history_locked` | backfill panel only |
| `rate_limited` / `too_many_movements` | never rendered — mapped to the underlying state |

The plan's three separate literals `token_expired` / `token_rejected` /
`token_expired_by_date` collapse into **one** `invalid` state with **two copy
variants**, because the treasurer's action is the same in all three. The variant
split is on `neverSucceeded`, and it is worth keeping: a token that has never
once worked is far more likely to be a copy-paste accident than an expiry, and
the instruction differs (see D′).

---

**A. `not_connected` — nikdy nepropojeno**

`<Alert variant='default'>` + `Landmark` icon.

> **Banka zatím není propojená.**
> Zadejte číslo účtu a API token z Fio Internetbankingu. Návod je níž.

No spinner, no red. Nothing is wrong yet.

---

**B. `ok` — připojeno, běží**

A `<Badge variant='success'>` with `CheckCircle` in the card header row (the
`DiscordConnectionBadge.tsx` shape exactly), plus a sentence under it inside
`<div aria-live='polite'>`:

> ✅ **Připojeno.** Poslední načtení: **před 12 minutami**. Celkem načteno
> **342 pohybů**, z toho **7 čeká na přiřazení** → *[Přejít na přiřazování]*

The count link is the shortcut back to §3. Relative time via
`Intl.RelativeTimeFormat` exactly as `EmailForwardingCard.tsx:217-242`.

---

**C. `activating` — token se aktivuje (~5 minut)**

The state that would otherwise be reported as a bug. Fio needs roughly five
minutes after a token is created before it works; until then it looks exactly
like a dead token.

`<Alert variant='default'>` + `Clock` icon (**deliberately not warning-coloured** —
nothing is broken):

> **Token se aktivuje.** Fio potřebuje po vytvoření tokenu asi **5 minut**, než
> ho začne uznávat. Zkusíme to sami znovu — nemusíte nic dělat.
> Zbývá přibližně **3 min 20 s**. *[Zkusit hned]*

The countdown derives from `tokenCreatedAt + 5 min`. It renders in plain text
inside `aria-live='off'`; only the *transition* out of this state is announced
(a per-second live region is unusable with a screen reader). **This state is
only shown while `now - tokenCreatedAt < 5 min`.** At 5 min + 1 s the state
resolves to `ok` or `invalid` — never lingers as "activating", which would turn
reassurance into a lie.

---

**D′. `sync_failing` — načítání zlobí, zatím nic nedělejte**

**The state that stops the UI crying wolf.** Fio answers every problem —
including its own five-minute outage — with a bodyless 500. Declaring the token
dead on the first failure would tell the treasurer to replace a perfectly good
token, and they would do it, because the alert said so.

**Threshold (agreed with the plan):** the status becomes `invalid` only at
**≥ 3 consecutive failures AND > 6 h since the last success**. Below that
threshold it is `sync_failing`, and the copy contains no instruction at all:

`<Alert variant='default'>` + `RefreshCw` — **not** destructive, **not** warning:

> **Načítání z banky se teď nedaří.** Zkoušíme to dál sami. Poslední úspěšné
> načtení: **dnes v 6:04**. Zatím není potřeba nic dělat — když to nepůjde ani
> po několika hodinách, dáme vám vědět.

No buttons. A state whose correct response is "wait" must not offer an action;
offering one is an invitation to take it.

---

**D. `invalid` — token neplatí**

Reached only at the threshold above (or when `tokenCreatedAt + 180 d` has simply
passed). `<Alert variant='destructive'>` + `AlertTriangle`, in **two copy
variants** keyed on `neverSucceeded`:

*Variant 1 — the token used to work (`neverSucceeded === false`):*

> **Token přestal platit.** Od **3. 2. 2027** se nepodařilo načíst žádné pohyby.
> Fio tokeny platí nejvýš 180 dní a prodlužují se jen tehdy, když se přihlásíte
> do Internetbankingu nebo Smartbankingu.
> **Co s tím:** vytvořte v Internetbankingu nový token (Nastavení → API, právo
> „Sledování účtu") a vložte ho sem.
>
> `[ Nahradit token ]`   `[ Návod krok za krokem ]`

*Variant 2 — the token has never once worked (`neverSucceeded === true`):*

> **Token se nepodařilo použít ani jednou.** Nejčastěji to znamená překlep při
> kopírování.
> **Zkontrolujte:** token má přesně **64 znaků** a nesmí v něm být mezera ani
> zalomení řádku. Zkopírujte ho z Internetbankingu znovu celý.
> Pokud jste ho vytvořili právě teď, počkejte 5 minut — Fio ho tak dlouho
> aktivuje.
>
> `[ Nahradit token ]`   `[ Návod krok za krokem ]`

One state literal, two sentences of copy. The plan's `token_rejected` distinction
is worth keeping as copy precisely because the *remedy* differs — "generate a new
one" is the wrong advice for a token that was pasted with a trailing newline.

`Nahradit token` sets `replacingSecret = true` **and moves focus to the token
input** (`inputRef.current?.focus()`), so the destructive alert is not a dead
end. `Návod` expands §2.4.

Deliberately **not** said: "HTTP 500", "unauthorized", "API error". The
treasurer cannot act on any of those.

---

**G. `misconfigured` — chyba na naší straně**

A server-side key problem (the encryption key is missing or rotated, so the
stored token cannot be decrypted). It is **not** the treasurer's token and must
never be described as one — a treasurer who replaces a good token because of our
key problem loses their 180-day clock and learns nothing.

`<Alert variant='destructive'>` + `ServerCrash`:

> **Propojení s bankou je dočasně nefunkční kvůli chybě na naší straně.**
> Váš token je v pořádku — **neměňte ho**. Ozvěte se prosím správci Sideline.

No `Nahradit token` button in this state. The only affordance is a support link.

---

**E. `expiring_soon` — token brzy vyprší (T−14)**

The highest-value element in this whole screen. Without it, the treasurer's
first signal is silence, and silence is indistinguishable from "no one paid this
month". It fires **14 days before `tokenCreatedAt + 180 days`** and escalates at
**T−7**, which is a DM beat too (§6.5), so the banner turning red and the second
DM arriving are the same event rather than two unrelated surprises.

`<Alert variant='warning'>` + `CalendarClock`, rendered **above** the card body
and **above whatever exclusive status is showing** (it is additive, not ranked —
see the two-channel rule above), and mirrored as a banner on the matching-queue
page (§3.4) so it cannot be missed by a treasurer who never opens Settings:

> **Token vyprší za 9 dní** (5. 3. 2027).
> Až vyprší, přestanou se načítat platby a nikdo vám to neřekne — proto to
> hlásíme dopředu.
> **Stačí jedna ze dvou věcí:**
> • přihlaste se do Internetbankingu nebo Smartbankingu Fio — tím se token sám
>   prodlouží; nebo
> • vytvořte nový token a vložte ho sem.
>
> `[ Vytvořit nový token ]` *(link to `ib.fio.cz`, `target='_blank' rel='noopener noreferrer'`)*  `[ Nahradit token ]`

At **T−7** the same block switches to `variant='destructive'`. No new state
literal — a `daysLeft <= 7` branch on the same block, driven by the API's
`expiringSoon: boolean` + `tokenExpiresAt`, so there is one place to read.

**Out-of-app escalation — ships with the feature, not as a follow-up.** At
**T−14 / T−7 / T−1** the bot DMs the treasurer the same two sentences
(`bot_fio_tokenExpiring_*`, §6.5). A settings screen nobody opens cannot warn
anybody, and this warning exists precisely because the failure it prevents is
silent. (This settles the plan's Q6: ship the nudge.)

---

**F. `history_locked` — Fio nevydá pohyby starší než 90 dní**

Lives **inside the "Načíst starší pohyby" panel**, not in the header ladder.
Fio returns HTTP 422 for any range older than 90 days unless the treasurer opens
a **10-minute unlock window** in Internetbanking.

Flow:

```
[ Načíst starší pohyby ]  ← click
        ↓
┌─ Dialog: Načíst starší pohyby ───────────────────────────────┐
│ Fio vydá pohyby starší než 90 dní jen v 10minutovém okně,    │
│ které musíte otevřít v Internetbankingu.                     │
│                                                              │
│ 1. Otevřete Internetbanking → Nastavení → API.               │
│ 2. U svého tokenu klikněte na ikonu 🔒 zámku.                │
│ 3. Vraťte se sem a do 10 minut spusťte načtení.              │
│                                                              │
│ Období:  [ 1. 1. 2026 ] – [ 31. 12. 2026 ]   ← DatePicker ×2 │
│                                                              │
│              [ Zrušit ]   [ Odemkl jsem, načíst ]            │
└──────────────────────────────────────────────────────────────┘
        ↓ (running)
  Načítám pohyby… (může trvat několik minut)   ⟳ aria-busy
  Okno vyprší za 8:41                          ← plain text, aria-live='off'
        ↓
  ✅ Načteno 214 pohybů. 9 čeká na přiřazení. [Přejít na přiřazování]
  — nebo —
  ⚠️ Fio historii nevydalo. Okno se nejspíš zavřelo nebo se neotevřelo.
     Zkuste zámek v Internetbankingu znovu a spusťte načtení do 10 minut.
     [ Zkusit znovu ]
```

The countdown is decoration; the **error copy is the real design**, because the
window silently closing is the likely outcome and the treasurer must be told the
remedy, not the status code.

**This flow only works because the backfill is a bounded loop inside the
request.** A cron doing one chunk per hour would need ~7 hours to walk a year of
history, against a window that closes after 10 minutes — the spinner would be
lying and the import would fail every time. Six to twelve chunked requests run
synchronously inside the endpoint fit inside the window, which is what makes
„Načítám pohyby… může trvat několik minut" an honest sentence. If the chunking
ever moves back to a cron, **this entire screen has to be redesigned**, not
merely re-worded.

---

**Never shown to the treasurer:** HTTP **409** (rate limit — Fio permits one
call per 30 s per token) and HTTP **413** (too many rows). Both are internal
retry/pagination concerns. Surfacing them would train the treasurer to treat
normal operation as breakage. They belong in logs and SigNoz only.

### 2.6 Fields and validation

| Field | Control | Validation | Error (cs) |
|---|---|---|---|
| Zapnuto | `Switch` | — | — |
| Předčíslí | `Input inputMode='numeric'`, optional | 0–6 digits | „Předčíslí má nejvýš 6 číslic." |
| Číslo účtu | `Input inputMode='numeric'`, required when enabled | 2–10 digits **+ Czech modulo-11 weight check** | „Číslo účtu neprošlo kontrolním součtem. Není tam překlep?" |
| Kód banky | `Input readOnly value='2010'` | — | — |
| API token | 3-state secret, exactly `EmailForwardingCard.tsx:448-512` | non-empty when replacing; length sanity (Fio tokens are exactly 64 chars) — warn, do not block | „Token vypadá nezvykle krátce. Zkopírovali jste ho celý? Fio token má 64 znaků." |
| **Token vytvořen dne** | `DatePicker`, defaults to **today**, `toYear = currentYear` | not in the future | „Datum nemůže být v budoucnosti." |
| Název příjemce | `Input`, **required when enabled** | non-empty | „Vyplňte název klubu tak, jak ho má banka." |
| IČO | `Input inputMode='numeric'`, optional | 8 digits + mod-11 checksum | „IČO má 8 číslic a neprošlo kontrolním součtem." |
| Sídlo | `Input`, optional | — | — |

**The modulo-11 account check and the IBAN are imported, not written here.**
Both come from `packages/domain/src/models/CzIban.ts` (the plan's D6) — the web
calls the shared function so the browser and the server cannot disagree about
whether an account number is valid. The check is worth having client-side: a
mistyped account number otherwise produces the exact same bodyless 500 as a bad
token, and the treasurer will spend an evening replacing a perfectly good token.

**„Token vytvořen dne" needs its own explanation**, because it looks like
bureaucracy and is in fact the input to the single most valuable warning on the
screen:

> Fio nám neřekne, kdy token vyprší. Počítáme 180 dní od tohoto data a 14 dní
> předem vás upozorníme. Necháte-li dnešní datum, bude upozornění přesné.

It defaults to today and is only worth editing when pasting a token that was
created earlier. (This settles the plan's Q4: yes, the field earns its place —
without it the T−14 warning is correct only for tokens pasted the day they were
made, and a wrong expiry date is worse than none.)

**Klub identification — three fields that exist for the PDF, not for Fio.**
„Název příjemce" doubles as the SPAYD `RN` field and the PDF header, so it is
required whenever the connection is enabled. IČO and Sídlo are **optional here
and consequential in §7.4**: a grant annex submitted to Praha 20 under the club's
legal name is expected to carry its IČO, because that is how the contract
identifies the recipient. They render in a collapsed „Údaje pro dokumenty"
sub-section with the line:

> Vytisknou se v hlavičce PDF výpisu pro úřad. Bez nich se dokument vygeneruje,
> ale bude bez identifikace klubu.

The bank name („Fio banka, a.s.") is **not** a field — only Fio is supported, so
it is a constant derived from the bank code.

Live preview line under the account row, `tabular-nums`:
`Účet: 2600123456/2010 · IBAN CZ65 2010 0000 0026 0012 3456`. The IBAN is what
the SPAYD QR needs (§6), so showing it here is also a correctness check the
treasurer can eyeball against their bank statement.

### 2.7 States

* **Loading** — the card is rendered from route loader data like its siblings; no
  per-card skeleton. While a save is in flight: `Button` → "Ukládání…",
  `disabled`, the rest of the card stays interactive (the IMAP card's behaviour).
* **Empty** — state A above.
* **Error (save failed)** — `run({ success })` toasts the failure automatically;
  field-level problems render under their own input with `aria-invalid` +
  `aria-describedby`. Never a bare disabled Save with no message.
* **Success** — toast "Nastavení banky uloženo." + the status block re-renders
  from the server response. The token input clears and returns to state 2.
* **Partial** — account saved but token rejected: the card keeps the account
  values and the status block moves to `activating` (a token pasted seconds ago
  is always `activating` first, never `invalid` — the five-minute rule in §2.5 C
  exists precisely so that a fresh save is never greeted with "your token is
  dead"). The two are independent; a bad token must not discard a correct
  account number.
* **Saving resets the failure counters**, so pasting a new token self-heals the
  backoff immediately and the status block leaves `invalid` / `sync_failing`
  without waiting for the next poll.

### 2.8 Form architecture (binding)

`organisms/team-settings/FioBankCard.tsx` + `fioBankForm.ts` +
`fioBankForm.test.ts`, following `useCardForm`. **File names follow the
implementation plan** — one name per component, and the plan's is the one the
task list and the test list already reference.

* `FioBankFormValues = { enabled: boolean; autoMatchEnabled: boolean; prefix:
  string; accountNumber: string; recipientName: string; registeredId: string;
  registeredAddress: string; tokenCreatedAt: string; syncWindowDays: number }`
  — primitives only, `tokenCreatedAt` as a `YYYY-MM-DD` string per the
  `DatePicker` contract.
* `fioTokenSet` / `replacingSecret` / `fioToken` stay **outside** the form values
  and are OR-ed into `hasChanges`, exactly as `EmailForwardingCard.tsx:97-108`
  does for `imapSecret`, and for the same reason: "did the secret change" is not
  an `!==` question.
* `fioTokenPayload({ fioTokenSet, replacingSecret, fioToken })` returns
  `Option<string>` — `Option.none()` means "do not touch the stored token".
* `fioBankForm.test.ts` asserts, for every key of a `BASE` object typed
  `FioBankFormValues`, that editing it both flips `isFormDirty` and changes the
  JSON of `fioBankRequestFrom` — the invariant test mandated by `AGENTS.md`.

---

## 3. Screen 2 — Transaction matching queue (the primary screen)

### 3.1 Purpose

Everything the system could not match confidently, in one place, resolvable one
row at a time without leaving the page. The treasurer's real question per row is
never "what is this transaction" — the bank already told them. It is **"why is
this on my desk?"** So the failure reason is the loudest element in the row,
ahead of the amount.

### 3.2 Route and navigation

* Route file `routes/(authenticated)/teams/$teamId/finances_.bank.tsx`
  → `/teams/:teamId/finances/bank`, matching the existing `finances_.fees.tsx` /
  `finances_.expenses.tsx` siblings. `ssr: false`.
* Tabs synced to the URL via `validateSearch` with a hand-written type guard
  (`isBankTab`), per the `finances.tsx:23-31` precedent:
  `?tab=queue` (default) · `?tab=matched` · `?tab=export`.
* Sidebar: new item in the **coach** group, after `expenses_navTitle`:
  `title: tr('bank_navTitle')` ("Bankovní pohyby"), icon `Landmark`,
  `requiredPermission: 'finance:record_payments'`.
  `needsAttention: true` when the queue is non-empty **or** the Fio token is
  invalid/expiring. The existing dot is boolean; a count badge would need a new
  field on `Auth.UserTeam` — see §11 Q1. Ship the dot.
* **Why `finance:record_payments` and not `finance:view`.** Captains hold
  `finance:view` but not `finance:record_payments` (`packages/domain/src/models/Role.ts:77`).
  This page lists the **name, account number and payment message of everyone who
  paid the club** — including, per §7.4's own worked example, a sponsor and the
  municipality. That is not roster-level information, and the people who can act
  on it are exactly the people who may record payments. The same gate applies to
  the ledger, the export and the QR-details endpoint.
* Breadcrumbs: add a branch to `AuthenticatedLayout.tsx` beside the
  `/finances/expenses` one at `:88`.

### 3.3 Page layout (desktop ≥ `md`)

```
← Zpět na tým
Bankovní pohyby                                       ✅ Připojeno · před 12 min

[ K přiřazení (7) ] [ Přiřazené ] [ Export pro dotaci ]      ← tablist, URL-synced

┌────────┬────────────┬────────────┬────────────┐
│ Čeká   │ Nepřiřazeno│ Přiřazeno  │ Bez VS     │   ← KpiCard ×4, grid-cols-2 sm:grid-cols-4
│ 7      │ 14 200 Kč  │ 34 z 41    │ 3 členové  │
└────────┴────────────┴────────────┴────────────┘
  ↑ the 4th KPI links to §5's "members with no VS" filter

[Hledat: jméno, VS, částka…]  ( Vše )( Bez VS )( Neznámý VS )( Částka nesedí )( Nejednoznačné )( Nic otevřeného )
                                                                         ← chips, aria-pressed

┌──┬────────────┬───────────┬──────────────────────┬─────────────────────────────┬──────────┐
│☐ │ Datum      │ Částka    │ Protistrana          │ Proč nesedí                 │          │
├──┼────────────┼───────────┼──────────────────────┼─────────────────────────────┼──────────┤
│☐ │ 3. 3. 2026 │  1 500 Kč │ Jan Novák            │ ⃠ Bez variabilního symbolu   │[Přiřadit]│
│  │            │           │ 1234567890/0800      │ Podle jména to vypadá na     │   ⋯      │
│  │            │           │ VS: —                │ Jana Nováka (VS 2026014).    │          │
│  │            │           │ Zpráva: prispevek    │                              │          │
├──┼────────────┼───────────┼──────────────────────┼─────────────────────────────┼──────────┤
│☐ │ 2. 3. 2026 │  1 200 Kč │ Petra Svobodová      │ ≠ Nižší částka, než je      │[Přiřadit]│
│  │            │           │ VS: 2026007          │   předpis                    │   ⋯      │
│  │            │           │ Zpráva: —            │ Předpis 1 500 Kč · chybí     │          │
│  │            │           │                      │ 300 Kč                       │          │
└──┴────────────┴───────────┴──────────────────────┴─────────────────────────────┴──────────┘

[ 2 vybrané ]  [ Označit jako jiný příjem ]  [ Ignorovat ]   ← sticky bulk bar, only when n>0
```

Table markup follows `AssignmentsTab.tsx:152-223`: `div.overflow-x-auto` >
`table.w-full.text-sm`, `thead tr.border-b`, `tbody tr.border-b.hover:bg-muted/50`,
money right-aligned with `tabular-nums`.

### 3.4 Banners above the table

Rendered in this order, each independently dismissible-never:

1. **Token expiring / invalid** (§2.5 D/E) — mirrored here so a treasurer who
   lives on this page sees it. Body ends with a link to Settings.
2. **Members with no VS** (§5) — `<Alert variant='warning'>`:
   "**3 členové nemají variabilní symbol.** Jejich platby nepůjde spárovat
   automaticky. `[Doplnit symboly]`"
3. **Unlock hint** — only when the oldest unmatched row is >85 days old:
   "Pohyby starší než 90 dní už Fio nevydá bez odemčení historie."

### 3.5 The "Proč nesedí" column — nine treatments

This is the design's centre of gravity. Each reason gets: a **glyph** (shape),
a **short label** (text), a **one-line explanation with the concrete numbers**,
and a **default action** pre-selected in the resolve dialog. Colour is a fourth,
redundant channel only.

**The literals are the plan's, imported — not invented here.** The union is
`BankTransactionMatchReason` in `packages/domain/src/models/BankTransaction.ts`,
and `src/lib/finance/matchReasons.ts` keys an explicit
`Record<BankTransactionMatchReason, { label; hint; Icon; dashed }>` off it. That
is exactly the type safety §1.4 argues for, now enforced across the package
boundary: adding a reason to the engine fails the web build until its Czech copy
exists, instead of shipping a raw key to the treasurer's screen. Every entry is a
literal `tr('…')` call; a computed key stays banned.

| Wire literal (plan) | Engine case | Glyph | Label (cs) | Explanation line (cs, with data) | Default action |
|---|---|---|---|---|---|
| `no_vs` | — | `Ban` ⃠ | **Bez variabilního symbolu** | „Platba nemá VS. Podle jména to vypadá na **{member}** (VS {vs})." / „Platba nemá VS a podle jména nikoho nepoznáváme." | Přiřadit, s předvyplněným tipem |
| `no_member_for_vs` | H | `HelpCircle` ? | **VS nikomu nepatří** | „VS **{vs}** nemá v týmu žádný člen." | Přiřadit ručně |
| `ambiguous_member` | Step 1 | `Users` ⁂ | **VS má víc členů** | „VS **{vs}** má přiřazený víc než jeden člen. Opravte to v seznamu členů." | Otevřít členy |
| `amount_mismatch_under` | D | `ArrowDownRight` ↘ | **Nižší částka, než je předpis** | „{member} má předpis **{due}**, přišlo **{paid}**. Chybí **{diff}**." | Částečná úhrada |
| `overpayment` | E | `ArrowUpRight` ↗ | **Vyšší částka, než je předpis** | „{member} má předpis **{due}**, přišlo **{paid}**. Přeplatek **{diff}**." | **žádná předvolba** — §3.6.1 |
| `ambiguous_multiple_exact` | C | `CopyCheck` ⧉ | **Sedí na víc předpisů** | „Částka **{amount}** přesně odpovídá **{count}** předpisům člena {member}. Ke kterému platba patří?" | Vybrat předpis |
| `ambiguous_multiple_open` | F | `Layers` ≣ | **Víc otevřených předpisů** | „{member} má **{count}** otevřených předpisů a částka nesedí ani na jeden. Rozdělit?" | Rozdělit |
| `no_open_assignment` | G | `CheckCheck` ✓✓ | **Člen nemá nic otevřeného** | „{member} nemá žádný otevřený předpis." + *(duplicate hint, below)* | Jiný příjem / Ignorovat |
| `currency_mismatch` | Step 0 | `Coins` ¤ | **Jiná měna, než je předpis** | „Platba je v **{txCurrency}**, předpisy člena {member} jsou v **{feeCurrency}**." | Jiný příjem / Ignorovat |

Two notes on the set:

1. **`currency_mismatch` is in the engine's Step 0 guard and had no label.** It
   would have rendered `bank_reason_currency_mismatch` verbatim to a treasurer.
   It is rare and it is cheap to label; label it.
2. **Duplicates are a hint, never a state.** The engine gets them for free —
   after the first match the assignment is `paid` and stops being a candidate, so
   a repeat transfer lands in `no_open_assignment`. The *UX* value of naming it
   survives as a **hint on that reason**: when a `matched` transaction exists in
   the same team with the same normalised VS and the same absolute amount, append

   > Vypadá to na duplikát platby z **{date}**. *[Zobrazit původní]*

   with a one-click action beside it. **That action resolves as
   `not_relevant`**, with the reason pre-filled („Duplikát platby z {date}") —
   there is no `duplicate` resolution kind, no „Duplikát" filter chip, no
   duplicate badge and no separate count anywhere in this spec. `resolution_kind`
   has exactly two values, `other_income` and `not_relevant`, and the duplicate
   is a well-worded instance of the second.

   **Also cut from the earlier draft:** `non_member_payment` (no producer — the
   engine emits `no_vs` / `no_member_for_vs` for a non-member, so the
   „Jiný příjem klubu" affordance hangs off those two reasons) and
   `refund_or_reversal` (see §3.9.1).

Rendering: `<MatchReasonBadge reason={r} />` — `inline-flex items-center gap-1
rounded-md border px-2 py-0.5 text-xs font-medium` with the icon `aria-hidden`
and the label as real text; the border is **dashed** for the four
"ambiguous, needs a decision" reasons (`ambiguous_member`,
`ambiguous_multiple_exact`, `ambiguous_multiple_open`, `no_open_assignment`) and
solid for the rest — a shape channel that survives greyscale, per the
`RoleBadge.tsx` precedent. `data-reason={reason}` for tests.

The explanation line sits **under** the badge as `text-xs text-muted-foreground`
and is the thing the treasurer actually reads. It always names the member and
the two amounts — never "amount mismatch" in the abstract.

**Why `amount_mismatch_under` is a queue reason and not an auto-match.** The
engine could safely credit a partial payment against a member's single open
assignment — it never overpays and never closes an unpaid item. It is
nevertheless queued, because "safe" is about the *amount*, not about the
*attribution*: a member who sends 300 Kč meant for tournament entry, at a moment
when their only open item is the autumn membership fee, gets it booked against
the membership fee, and the grant evidence then says something that did not
happen. Ten seconds of treasurer time beats a wrong row in an audited ledger.

### 3.6 Resolve dialog — `Přiřadit platbu`

One always-mounted `<Dialog>` driven by `open={resolveTarget !== null}` with the
target frozen in a `useRef` (AGENTS.md § Dialogs Must Be Always-Mounted). Radio
group of four modes; the default comes from the reason table above.

```
┌─ Přiřadit platbu · 1 200 Kč · 2. 3. 2026 ────────────────────────────┐
│ Protistrana  Petra Svobodová · 1234567890/0800                       │
│ VS 2026007 · Zpráva: „prispevek podzim"                              │
│ ≠ Nižší částka, než je předpis — chybí 300 Kč                        │
├──────────────────────────────────────────────────────────────────────┤
│ ( • ) Přiřadit členovi                                               │
│       Člen    [ Petra Svobodová            ▾ ]  ← SearchableSelect    │
│       Předpis [ Příspěvek podzim 2026 · zbývá 1 500 Kč  ▾ ]           │
│                                                                      │
│       Částka je nižší než předpis. Co s tím?      ← under-payment    │
│        ( • ) Částečná úhrada — zbývá 300 Kč, předpis zůstane otevřený│
│        ( ) Částečná úhrada a zbytek odpustit                         │
│              → po uložení otevřeme „Odpustit předpis"                │
│                                                                      │
│       Částka je vyšší než předpis. Co s tím?      ← over-payment     │
│        ( ) Přiřadit celých 1 800 Kč                                  │
│              Na předpisu vznikne přeplatek 300 Kč, zapíšeme ho do    │
│              poznámky k platbě.                                      │
│        ( ) Rozdělit — zbytek přiřadit na další předpis               │
│              (nic předvybraného — viz §3.6.1)                        │
│                                                                      │
│ ( ) Rozdělit mezi víc předpisů                                       │
│       Příspěvek podzim 2026   [ 1 000 ] Kč                           │
│       Turnajové startovné     [   200 ] Kč     [+ Přidat předpis]    │
│       Rozděleno 1 200 Kč z 1 200 Kč ✅          ← live, blocks submit │
│                                                                      │
│ ( ) Jiný příjem klubu (ne členský příspěvek)                         │
│       Popis [ dar od sponzora                     ]  ← required      │
│                                                                      │
│ ( ) Ignorovat tuto platbu                                            │
│       Důvod [ duplikát platby z 1. 3.             ]  ← required      │
│                                                                      │
│ Poznámka (nepovinná) [                            ]                  │
├──────────────────────────────────────────────────────────────────────┤
│                                   [ Zrušit ]   [ Přiřadit ]          │
└──────────────────────────────────────────────────────────────────────┘
```

Rules:

1. **Only the selected mode's fields are enabled.** Unselected branches render
   inside `<fieldset disabled>` with `opacity-60` — the `EmailForwardingCard.tsx:348`
   idiom — so they stay readable (the treasurer can see what the other options
   would ask for) without being tabbable.
2. **The split sub-form blocks submit until the remainder is exactly zero**, with
   a live line "Rozděleno 1 200 Kč z 1 200 Kč" that turns into
   "Zbývá rozdělit 200 Kč" (with `aria-live='polite'`) when it does not balance.
   Never a silent disabled button.
3. **"Zbytek odpustit" is a hand-off, not a new write path.** The earlier draft
   had this option write a waiver inline, which needs a
   `fee_assignments.stored_status` write the API does not have. It does not need
   one: the app already ships `WaiveAssignmentDialog`. So the option records the
   partial payment through the ordinary `match` endpoint and then **opens the
   existing waive dialog** for the remaining assignment, pre-filled with
   „Zbytek po částečné úhradě z {date}". Two existing endpoints, zero new ones,
   and the waiver keeps landing in the place the rest of the app already reads it
   from.
4. **The over-payment branch must leave the queue.** See §3.6.1 — an option that
   cannot terminate is worse than no option.
5. **Amounts use `parseAmount` + `Schema.decodeSync(Fee.AmountMinor)`** at
   submit, never `as unknown as`. The dialog must also honour the API's rule that
   an allocation may exceed an assignment's outstanding amount **only** through
   the explicit over-payment opt-in of §3.6.1. In every other mode the amount
   inputs stay within the outstanding amount and show
   „Na tento předpis zbývá {outstanding}. Víc půjde přiřadit jen jako přeplatek."
   — which points at the opt-in instead of dead-ending the treasurer.
6. On success: toast "Platba přiřazena." + `router.invalidate()` + the row leaves
   the queue with focus moving to the next row's Přiřadit button (§8.3).

#### 3.6.1 Overpayment — allocate the whole amount, on an explicit opt-in

**Decided (user, Q5): the treasurer may allocate the full transaction amount to
one assignment**, leaving `paid_minor > amount_minor` on that assignment. The
overage is recorded **in the payment note**, the transaction reaches `matched`
and leaves the queue. There is no residue state, no unallocated remainder and no
credit balance.

This is the right call and it needs one guard rail, which is the whole of this
subsection: **it must be an explicit opt-in with the consequence stated in plain
Czech before confirming — never a default, and never an automatic rounding-up.**
A treasurer who is shown „Přiřadit celých 1 800 Kč" and confirms it has made a
decision; a system that quietly rounds 1 800 onto a 1 500 fee has made it for
them, and the difference only becomes visible during an audit.

The option, rendered inside the over-payment branch of the resolve dialog:

```
Částka je vyšší než předpis. Co s tím?
 ( ) Přiřadit celých 1 800 Kč
       Na předpisu „Příspěvek podzim 2026" vznikne přeplatek 300 Kč.
       Zapíšeme ho do poznámky k platbě.
 ( ) Rozdělit — zbytek přiřadit na další předpis
```

1. **Neither option is pre-selected.** The reason table (§3.5) gives every other
   reason a sensible default; this one deliberately has none, because both
   answers are legitimate and only the treasurer knows which. The submit button
   stays disabled until one is chosen — with the hint „Vyberte, co se má stát
   s přeplatkem." so a disabled button is never silent.
2. **The consequence sentence names the fee and the amount**, not the mechanism.
   „Na předpisu **{fee}** vznikne přeplatek **{diff}**" is something a volunteer
   treasurer can evaluate; „`paid_minor` will exceed `amount_minor`" is not.
3. **The note text is generated, shown, and editable.** Default:
   „Přeplatek {diff} oproti předpisu {fee}." It is the only durable record of the
   overage, it is what the treasurer will read back in January 2027, and it goes
   into the export's *Poznámka* column — so it must be visible at the moment it
   is written, not composed invisibly by the server.
4. **Split stays available and is often better.** When the member has another
   open fee, „Rozdělit" produces two clean allocations and no overpayment at all;
   the dialog lists the member's other open assignments right under that option
   so the better answer is one click away rather than a mode switch.
5. **The over-allocated assignment must read as over-paid, not as an error**,
   wherever it renders afterwards (`AssignmentsTab`, `MyPaymentsPage`): status
   stays `paid`, and the outstanding column shows `0`, which
   `outstandingMinor()` already clamps (`AssignmentsTab.tsx:65-68`). Nothing
   downstream should show a negative outstanding amount.

### 3.7 Row overflow menu (`⋯`)

`DropdownMenu` per row: *Zobrazit detail pohybu* (a `Sheet` with every raw field
Fio returned — date, amount, counterparty account+bank, VS/KS/SS, message for
recipient, comment, Fio transaction id), *Označit jako jiný příjem*,
*Nepatří k žádnému předpisu*, *Zkopírovat údaje*.

### 3.8 Bulk actions

Only the two operations that are safe to do blind:

* **Nepatří k žádnému předpisu** (`not_relevant`) — one shared reason, asked once
  in an `AlertDialog`.
* **Označit jako jiný příjem** (`other_income`) — one shared description.

Both are the same endpoint with a different `resolution_kind`; neither is a new
write path.

**Bulk assign-to-member is deliberately absent.** Assignment is a per-row
judgement about a specific person's specific fee; a bulk version would be the
single easiest way to create a mess that then needs twenty undos. The sticky bar
appears only when `selected.length > 0`, is `role='region'` with
`aria-label={tr('bank_bulk_regionLabel')}`, and announces the count via a live
region.

### 3.9 Undo / un-match — voiding, not deleting

Reachable from the `Přiřazené` tab's row menu. **There is no 10-second "undo"
in the success toast** — the earlier draft offered one and it contradicted this
dialog's own mandatory reason: a toast-undo cannot collect a reason, so it would
have produced voids with an empty `void_reason`, i.e. exactly the audit hole the
dialog exists to close. One path, one reason, always.

```
┌─ Zrušit přiřazení platby ────────────────────────────────────┐
│ Platba 1 500 Kč z 3. 3. 2026 je přiřazená k předpisu         │
│ „Příspěvek podzim 2026" člena Jan Novák.                     │
│                                                              │
│ Zrušením se předpis vrátí mezi nezaplacené a platba se vrátí │
│ do fronty k přiřazení.                                       │
│ **Záznam se nemaže.** Zůstane v historii označený jako       │
│ zrušený, s vaším jménem, časem a důvodem — kvůli auditu.     │
│                                                              │
│ Důvod zrušení *  [ přiřazeno omylem jinému členovi        ]  │
│                                                              │
│                        [ Zrušit ]   [ Zrušit přiřazení ]     │
└──────────────────────────────────────────────────────────────┘
```

* `AlertDialog`, per AGENTS.md § Confirm Before Destructive Actions. The
  mutation fires from `<AlertDialogAction>`, never from the trigger.
* **The reason field is required** (min 3 chars) — it lands in `void_reason` and
  is what makes the audit trail worth keeping. The copy says so out loud, which
  is also what stops the treasurer typing "asdf".
* The voided payment then renders in history exactly like today's voided
  payments: `opacity-60` + `line-through` + the existing
  `my_payments_history_voided` chip (`MyPaymentHistoryRow.tsx:91-124`) — **reuse
  that key, do not mint a second "Zrušeno"**.
* The transaction returns to the queue carrying a `History` **Vráceno k
  přiřazení** badge and a "Zobrazit zrušené přiřazení" link, so it is obvious the
  row has history. (The glyph moved from `↩` to `History` so it cannot be read as
  a bank reversal — see §3.9.1.)
* **The link rows survive the void.** The `bank_transaction_payments` rows stay;
  only the payments are voided. So "show the cancelled assignment" always has
  something to show, and a row that has been matched and unmatched twice reads as
  two entries, not as a blank.

### 3.9.1 What is not designed here: bank reversals

An outgoing movement that reverses an earlier incoming one gets **no special
machinery**: no `reversal_pending` state, no pin-to-top-of-queue, no linked
"void the original" button. At a few hundred transactions a year this is a
mechanism for an event that approximately never happens, and every state in the
queue costs the treasurer a concept to learn.

An outgoing row appears in the ledger like any other movement, the treasurer can
`ignore` it with a required reason (or resolve it as club expenditure), and it
stays in the export because the auditor must see every movement. If a reversal
ever does need the original payment voided, that is §3.9 — the ordinary unmatch,
with a reason, which is the correct audit event anyway.

### 3.10 The `Přiřazené` tab — auditing what the machine did

Auto-matched transactions must not be invisible; a treasurer who cannot see them
cannot trust them, and the auditor will ask.

```
[ Vše ] [ Přiřazeno automaticky ] [ Přiřazeno ručně ] [ Jiný příjem ] [ Ignorováno ] [ Zrušeno ]

│ 1. 3. 2026 │ 1 500 Kč │ Jan Novák      │ ✅ Automaticky · VS 2026014 │ ⋯ │
│            │          │ VS 2026014     │ → Příspěvek podzim 2026     │   │
```

Each row expands (the `MyPaymentsPage.tsx:232-249` chevron pattern:
`aria-expanded`, `aria-controls`, `ChevronRight` rotating) to reveal the
**evidence**, in words:

> Spárováno automaticky **1. 3. 2026 v 6:04** podle variabilního symbolu
> **2026014** → **Jan Novák** → předpis **Příspěvek podzim 2026** (1 500 Kč).
> Částka odpovídá přesně.

with `[ Zrušit přiřazení ]` leading to §3.9. Default sort: newest first.

### 3.11 States

* **Loading (route)** — `RoutePendingComponent`. **Loading (tab switch)** — the
  data region gets `opacity-60 pointer-events-none transition-opacity` +
  `aria-busy`, driven by `useRouterState({ select: s => s.status === 'pending' })`,
  per AGENTS.md; the tabs stay clickable.
* **Empty — the healthy steady state.** This is the state the treasurer should
  see most days and it should feel like an achievement, not like a blank page.
  Modelled on `finance_empty_allPaid` (`FinancesOverviewPage.tsx:186-203`):

  ```
              ✅  (CheckCircle2, size-10, text-green-600)

          Hotovo. Všechny platby jsou přiřazené.

     Za posledních 30 dní se automaticky spárovalo 34 z 36 plateb.
        Poslední načtení z banky: dnes v 6:04.

              [ Zobrazit přiřazené platby ]
  ```

  The two sentences are doing real work: they say the system is alive (so an
  empty queue is not mistaken for a broken import) and they quantify how much
  hand-work was avoided.
* **Empty after filtering** — muted line + `[ Vymazat filtry ]`, reusing
  `expenses_clearFilters` (`AssignmentsTab.tsx:144-150` pattern).
* **Never connected** — the queue is replaced by a call to action:
  "Banka zatím není propojená. `[Propojit účet]`" → `/teams/$teamId/settings`.
* **Error** — loader failure surfaces through `warnAndCatchAll` + toast; per-row
  action failures toast via `run()` and leave the row in place.
* **Partial** — a bulk action where some rows succeeded:
  "Zpracováno 5 ze 7 plateb. 2 se nepodařilo — zkuste je jednotlivě." and the
  two failed rows stay selected.

---

## 4. Responsive behaviour — the queue on a phone

A treasurer reconciling from the sofa is a realistic and probably common case,
so the phone layout is a **first-class layout, not a squeezed table**.

Below `md` the `<table>` collapses to a **card list**. The same `<table>`
element is kept (so the semantics and the tests survive) and the cells restack
via utility classes, the `PlayerRow.tsx:46-53` technique of hiding columns and
re-showing their content under the primary cell — but here taken all the way:

```
┌──────────────────────────────────────────────┐
│ ⃠ Bez variabilního symbolu                   │  ← reason FIRST on mobile
│                                              │
│ 1 500 Kč                          3. 3. 2026 │  ← text-lg font-bold / muted
│ Jan Novák · 1234567890/0800                  │
│ VS: —  ·  Zpráva: prispevek                  │
│                                              │
│ Podle jména to vypadá na Jana Nováka.        │
│                                              │
│ [        Přiřadit        ]              ⋯    │  ← w-full, min-h-11 (44 px)
└──────────────────────────────────────────────┘
```

Concretely:

1. **Reason on top, amount second.** On desktop the eye scans left-to-right and
   the reason column is the destination; on a phone, the first line is the only
   line guaranteed to be read, so the reason takes it.
2. `hidden md:table-cell` on the Datum / Protistrana / Proč columns; their
   content is re-rendered inside the first cell in a `md:hidden` block.
3. **`overflow-x-auto` is not the mobile answer.** Horizontal scroll inside a
   vertically scrolling page is the thing that makes phone tables unusable. The
   existing finance pages do this; this page does not.
4. Primary action is a full-width `Button` ≥ 44 px tall. The overflow `⋯` is a
   44×44 icon button with an `sr-only` label.
5. **Checkbox column is hidden below `md`.** Bulk selection on a phone is a
   mis-tap generator; the mobile flow is one row at a time.
6. **The resolve dialog becomes a `Sheet` (`side='bottom'`) below `sm`.** A
   centred `Dialog` with five radio branches and a split sub-form does not fit
   above the keyboard. Same content, same focus rules.
7. KPI strip stays `grid-cols-2` (already the existing breakpoint).
8. Filter chips wrap (`flex-wrap`) exactly as `AssignmentsTab.tsx:120`.
9. The sticky bulk bar, if ever shown on mobile, must clear
   `env(safe-area-inset-bottom)`.

---

## 5. Screen 3 — Variable symbol in member administration

### 5.1 The model question, stated

The story says "each member's number doubles as their payment variable symbol,
unique within a team". The existing `TeamMember.jersey_number`
(`packages/domain/src/models/TeamMember.ts:10-13`) is `0–99`, optional, and not
unique — it is a **jersey** number and must not be overloaded. This spec assumes
a **new, distinct member field**: `variable_symbol`, digits only, ≤ 10 chars,
unique per team, nullable. See §11 Q2. The UI below is unchanged either way; only
the label would move.

Recommended default when auto-assigning: `{year}{seq3}` → `2026014`. It is
human-readable, sorts, and tells the treasurer at a glance which season a payment
belongs to.

### 5.2 Roster list — `/teams/$teamId/members`

Add a **VS column** to `TeamMembersPage.tsx` / `PlayerRow.tsx`:

```
│ Hráč                    │ VS       │ # │ Role        │        │
│ 🧑 Jan Novák            │ 2026014  │ 7 │ Hráč        │ [Upravit] │
│ 🧑 Petra Svobodová      │ ⚠ Chybí  │ 4 │ Kapitánka   │ [Upravit] │
```

* Header `<th className='hidden sm:table-cell …'>VS</th>` — shown from `sm`, one
  breakpoint earlier than the `#`/Role columns (`TeamMembersPage.tsx:58-63`),
  because it is the more consequential number.
* Value in `tabular-nums`.
* **Missing VS is not an em-dash.** `members_fieldEmpty` ("—") is what the roster
  uses for "not filled in"; a missing VS is not neutral, it is a defect. Render
  `<span className='inline-flex items-center gap-1 text-xs …'><AlertTriangle
  className='size-3' aria-hidden/>{tr('members_vs_missing')}</span>` — icon +
  the word "Chybí", never colour alone. On mobile (`md:hidden` block under the
  name) the missing-VS marker is shown even though the column is hidden; a
  present VS is not (it is not news).

### 5.3 Surfacing the gap actively

A member with no VS is precisely a member whose payments can never auto-match.
That must be pushed, not waited for.

Three places, all driven by one server-supplied `membersWithoutVsCount`:

1. **Roster page banner** — above the search box, only when count > 0:

   > ⚠️ **{count} členů nemá variabilní symbol.** Jejich platby z banky nepůjde
   > spárovat automaticky — budete je muset přiřazovat ručně.
   > `[ Zobrazit jen tyto ]`  `[ Přidělit symboly automaticky ]`

   `Zobrazit jen tyto` toggles a `bez VS` filter chip (the chip row is new on
   this page; it follows `AssignmentsTab.tsx:120-140`).
2. **Bank page KPI + banner** (§3.3, §3.4) — the treasurer's daily surface.
3. **Member detail** — an inline `<Alert variant='warning'>` in the profile card
   when the member has no VS, with the field pre-focused when arriving from the
   banner's deep link (`?focus=vs`).

**`Přidělit symboly automaticky`** opens an `AlertDialog` that *shows the
proposed assignment before doing it* — never a blind bulk write:

```
┌─ Přidělit variabilní symboly ────────────────────────────┐
│ Doplníme symboly 3 členům, kteří je nemají. Ostatních    │
│ se to nedotkne.                                          │
│                                                          │
│   Petra Svobodová   →  2026015                           │
│   Martin Dvořák     →  2026016                           │
│   Eva Černá         →  2026017                           │
│                                                          │
│ Symboly jdou později změnit u každého člena zvlášť.      │
│                                                          │
│                      [ Zrušit ]   [ Přidělit ]           │
└──────────────────────────────────────────────────────────┘
```

### 5.4 Editing — `/teams/$teamId/members/$memberId`

A new field in the existing edit form (`PlayerDetailPage.tsx:311-395`), placed
**between** Jméno and Datum narození (it is identity, not sport):

```
Variabilní symbol •                    ← DirtyFieldLabel
[ 2026014                            ]
Použije se jako VS u plateb příspěvků. Musí být jedinečný v rámci týmu.
```

* Same `FormField` + `DirtyFieldLabel` + `FormMessage` shape as every sibling.
* Schema: `Schema.NullOr(Schema.String.pipe(Schema.check(/^\d{1,10}$/ …)))` with
  message `tr('validation_variableSymbol')` → „Variabilní symbol smí obsahovat
  jen číslice (nejvýš 10)."
* Read-only view (`ProfileReadOnlyView`, `PlayerDetailPage.tsx:591-613`) gains a
  `<strong>Variabilní symbol:</strong> 2026014` line.
* **Duplicate reporting.** The server answers 409; the client maps it to a
  **field-level** error, not a toast:

  > Tento symbol už má **Petra Svobodová**. *[Zobrazit člena]*

  rendered under the input with `aria-invalid` + `aria-describedby`, and the
  submit stays enabled so the treasurer can simply retype. A toast would vanish
  before they had read the other member's name.
* Also validated client-side against the roster already in memory, so the common
  case (typing a number that is visibly taken) is caught before the round trip —
  with the *same* message, so the two paths are indistinguishable.

### 5.5 States

* **Loading** — route loader; no skeleton.
* **Empty** — `members_noPlayers` (existing).
* **Error** — 409 as above; anything else toasts via `run()`.
* **Success** — the form re-baselines via `form.reset(submittedValues)` per the
  dirty-state rule; the roster banner count drops on `router.invalidate()`.

---

## 6. Screen 4 — QR payment (SPAYD) delivery

### 6.1 Goal

**Nobody pays without a variable symbol.** Everything below is subordinate to
that. The QR carries the VS; the fallback text carries the VS; the embed repeats
the VS in a copyable code block. If a player pays by any of the three routes, the
payment auto-matches.

### 6.2 The two-text rule — say it once, loudly

The QR payload is built in Czech-payment convention: **uppercase ASCII, no
diacritics**. This is *not* a bug and must not be "fixed" by a later reviewer.

* A QR code encodes `[A-Z0-9 $%*+\-./:]` in **alphanumeric mode** at ~5.5 bits
  per character. One `ř` forces the whole payload into **byte mode** at 8 bits
  per character, which pushes the symbol up a version or two: more modules, finer
  modules, a visibly larger and measurably harder-to-scan code on a phone screen
  held over a laptop.
* Czech payment messages are conventionally unaccented anyway — banks' own
  statement exports look like this — so `PRISPEVEK PODZIM 2026 NOVAK` reads as
  completely normal to a Czech payer.

| Surface | Diacritics | Example |
|---|---|---|
| **SPAYD payload `MSG:`** | **NO — uppercase ASCII only** | `PRISPEVEK PODZIM 2026 NOVAK` |
| Embed title / description / field labels / field values | **YES — full Czech** | „Příspěvek podzim 2026 · Jan Novák" |
| Fallback copy block (account, amount, VS) | numbers only | `2600123456/2010` |
| Web QR card, all visible text | **YES** | „Příspěvek podzim 2026" |
| PDF export (§7) | **YES — mandatory** | „Příspěvek podzim 2026 · Novák" |
| CSV export (§7) | **YES** | as stored |

An implementation note to keep the two from drifting: the transliterated string
is produced **only** at the SPAYD-payload boundary and is never stored back onto
the entity.

**There is exactly one implementation and it is not in the web.**
`transliterateToSpaydAscii` and `buildSpayd` live in
`packages/domain/src/models/Spayd.ts`, and the CZ IBAN builder in
`packages/domain/src/models/CzIban.ts` (the plan's D6). `@sideline/domain` is
already a dependency of the web, the server and the bot, so all three call the
same function. A `web/src/lib/finance/spayd.ts` — which an earlier draft of this
document asked for — would be a second implementation of the one rule this
section exists to make un-drifted, which is self-defeating. `normalize('NFD')`
appears in `Spayd.ts` and nowhere else in the monorepo.

### 6.3 SPAYD payload spec

```
SPD*1.0*ACC:CZ6520100000002600123456*AM:1500.00*CC:CZK*X-VS:2026014*MSG:PRISPEVEK PODZIM 2026 NOVAK*DT:20261031
```

| Field | Rule |
|---|---|
| `ACC` | IBAN of the club account, derived from prefix/number/2010 (§2.6 shows it to the treasurer so they can sanity-check it) |
| `AM` | major units, `.` decimal separator, 2 decimals |
| `CC` | `CZK` |
| `X-VS` | digits only, ≤ 10 — the member's variable symbol (§5) |
| `MSG` | **≤ 60 characters**, uppercase ASCII |
| `DT` | due date `YYYYMMDD` |

**`MSG` is capped at 60 characters and over-length values are silently truncated
by the reading app** — the payer sees a half-word and nobody is told. So the
template must fit *by construction*, not by luck:

```
MSG := trunc60( upperAscii(feeName) + " " + upperAscii(surname) )
```

with a **budget algorithm**, not a blind `slice(0, 60)`:

1. Transliterate both parts (NFD → strip combining marks → uppercase → replace
   anything outside `[A-Z0-9 .,:/-]` with a space → collapse runs of spaces).
2. If the joined string ≤ 60: done.
3. Otherwise drop the surname (the VS already identifies the payer — the surname
   is a courtesy, the fee name is the information) and retry.
4. If still > 60, truncate the fee name **at the last word boundary ≤ 60**.
   Never mid-word: `PRISPEVEK NA HALOVOU SEZONU PODZIM ZI` is worse than
   `PRISPEVEK NA HALOVOU SEZONU PODZIM`.

Worked examples — **these strings are correct as written**:

| Fee name (stored) | Surname | `MSG` (QR) | len |
|---|---|---|---|
| Příspěvek podzim 2026 | Novák | `PRISPEVEK PODZIM 2026 NOVAK` | 27 |
| Startovné — Mistrovství ČR 2026 | Svobodová | `STARTOVNE - MISTROVSTVI CR 2026 SVOBODOVA` | 41 |
| Členský příspěvek na halovou sezónu 2026/2027 | Dvořák | `CLENSKY PRISPEVEK NA HALOVOU SEZONU 2026/2027` | 45 (surname dropped) |
| Příspěvek na dopravu na turnaj do Českých Budějovic | Černá | `PRISPEVEK NA DOPRAVU NA TURNAJ DO CESKYCH` | 41 (word-boundary cut) |

**Design consequence for fee naming:** a fee whose name alone exceeds ~55
characters will always lose its tail in the QR. The fee form (`FeeFormDialog`)
should show a soft counter once the name passes 45 characters: „Delší názvy se
do QR kódu nevejdou celé." — a nudge, not a block.

**Truncation, never rejection.** An over-long `MSG` must be budgeted down by the
algorithm above and the QR produced anyway. Refusing to build the payload —
which an earlier version of the implementation plan did — means a fee with a long
name produces **no QR at all**, so the player types the transfer by hand, and the
one thing this whole feature exists to prevent (a payment with no variable
symbol) becomes *more* likely for exactly the fees that are hardest to describe.
A shortened message still carries a correct `X-VS`; a missing QR carries
nothing.

### 6.4 The Discord message — the **existing** payment reminder, extended

**There is no new QR message and no new outbox event.** The QR rides the payment
reminder DM the app already sends: `PaymentReminderCron` → `payment_reminder_sync_events`
→ `src/rcp/finance/handlePaymentReminderReady.ts` →
`src/rcp/finance/buildPaymentReminderEmbed.ts`. An earlier draft specified a
second `buildPaymentQrEmbed` + `handlePaymentQrReady` pair, which would have put
**two DMs per assignment per reminder cadence** in a player's inbox. Five
reminder kinds already exist; doubling them is how a useful nudge becomes muted
spam.

What changes in that builder: three additions (a VS field, the fallback code
block, the QR image) and one overdue correction (it is currently English-only and
inline — it must move to `bot_payment_reminder_*` keys per the bot's i18n rule).
Locale = `userLocale`.

**One consequence the architect has to decide on.** Reminders are emitted at
`due_in_3d` / `due_today` / `overdue_3d` / `overdue_10d` / `overdue_21d`. Riding
them means **a player first sees the QR three days before the due date** — for a
fee created six weeks ahead, that is six weeks of silence followed by a
three-day window. The cheap fix is one new `PaymentReminderKind` (`assigned`,
fired once when the assignment is created), which reuses the entire existing
pipeline — cron row, outbox, handler, embed — and changes nothing else. Without
it the QR arrives late and the "pay early" behaviour the club wants never gets
prompted. **Recommendation: add the kind.**

```
┌────────────────────────────────────────────────────────┐
│ 💸 Příspěvek podzim 2026                    (blurple)  │
│                                                        │
│ Ahoj! Tady jsou údaje k platbě příspěvku. Nejrychlejší │
│ je naskenovat QR kód v bankovní aplikaci.              │
│                                                        │
│ Částka            Splatnost          Variabilní symbol │
│ 1 500 Kč (CZK)    31. 10. 2026       2026014           │
│  (inline)          (inline)           (inline)         │
│                                                        │
│ Nejde naskenovat? Zadejte ručně:                       │
│ ```                                                    │
│ Účet:  2600123456/2010                                 │
│ Částka: 1500,00 Kč                                     │
│ VS:     2026014                                        │
│ Zpráva: PRISPEVEK PODZIM 2026 NOVAK                    │
│ ```                                                    │
│                                                        │
│ ⚠️ Bez variabilního symbolu platbu nespárujeme.        │
│                                                        │
│ [══════ QR image, attachment://qr-<id>.png ══════]     │
│                                                        │
│ Sideline · Ultimate Frisbee Horní Počernice            │
└────────────────────────────────────────────────────────┘
[ Moje platby ]   ← UI.row([UI.button({ style: 5, label, url })])  // style 5 = Link
```

Construction rules:

* **Extend `applications/bot/src/rcp/finance/buildPaymentReminderEmbed.ts`**
  (already pure — keep it pure: no Effect, no REST). The `Match.value(kind)` table
  stays; the new fields are appended for every kind, and `copyForKind` gains the
  `assigned` arm (§6.4 head).
* Colour stays keyed on the reminder kind, using the constants already in that
  file at `:11-13`: `0x5865f2` blurple for `due_in_3d`, `0xfee75c` amber for
  `due_today`, `0xed4245` red for the three overdue kinds. Colour is redundant —
  the description sentence already says which it is.
* **Field layout:** the existing embed has four inline fields (Fee / Amount / Due
  / Outstanding). Adding a fifth (VS) makes an awkward 3+2 grid, so **drop
  `Fee`** — it is already the embed title — leaving four: Částka / Splatnost /
  Variabilní symbol / Zbývá. Four inline fields are two tidy rows on a phone.
* The fallback block is in the `description`, not a field, so it renders full
  width and the code fence stays copyable.
* `image: { url: 'attachment://qr-<assignmentId>.png' }` plus
  `...filesField([qrFile])` — the key **absent** when there is no QR
  (`clips.ts:86`). A missing QR degrades to text-only, never to a failed send.
* `allowed_mentions: { parse: [] }` — the fee name is user-authored text.
* **One button only.** A single link `Moje platby` → the web page in §6.6.
  Two-plus buttons would trigger the row-width ellipsis problem on a phone
  (`AGENTS.md` rule 6), and there is no second action worth the risk.
* `footer.text` = club name (the current builder hardcodes `'Sideline'` at
  `:90`); a payment request should name who is being paid.
* **The QR is attached only when it can be correct.** No club account configured,
  or the member has no variable symbol → no image, no fallback block, and the
  reminder falls back to exactly today's text. A QR without a VS is worse than no
  QR (§6.7).
* **If the message is ever edited** (e.g. "zaplaceno"), remember that an
  `UPDATE_MESSAGE` without the attachment drops it and leaves `attachment://`
  pointing at nothing — re-send the file or drop `image` in the same update.

The QR **PNG is rendered server-side**, not by the bot, for the same reason the
rules clips are baked at build time: the bot should not own image generation. The
bot receives it over the existing RPC surface (`Finance/GetPaymentQr` →
`{ spayd, png_base64, filename }`) and wraps the bytes in a `File` exactly as
`clipAttachment` does. Minimum 300×300 px with a quiet zone, error-correction
level **M** (the payload is short; L buys nothing and M survives a fingerprint on
the screen).

### 6.5 Other bot messages this feature owes

**Token expiring (treasurer DM), T−14 / T−7 / T−1** — §2.5 E, delivered through
the `bank_token_expiring` outbox event. Without this, a settings banner warns
only the person who opens settings.

> ⚠️ **Token k bance vyprší za 9 dní**
> Po vypršení se přestanou načítat platby z účtu klubu.
> Stačí se přihlásit do Internetbankingu nebo Smartbankingu Fio — tím se token
> prodlouží. Nebo vytvořte nový a vložte ho v Sideline do nastavení týmu.
> `[ Otevřít nastavení ]`

Keys `bot_fio_tokenExpiring_*`. Colour amber at T−14, red at T−7 and T−1 —
matching the banner's own switch at T−7 so the two surfaces never disagree about
how alarmed to be.

**Weekly matching digest (treasurer DM), optional, phase 2** —
„Ve frontě čeká 7 plateb k přiřazení (14 200 Kč)." with a link. Flagged as
optional so it can be dropped without touching anything else.

### 6.6 Where a player sees their own fees and QR codes on the web

`/teams/$teamId/my-payments` (`components/pages/MyPaymentsPage.tsx`) already
lists every assignment with status, due date and an expandable payment history.
Add a **second** expander per outstanding row — a `QrCode` icon button beside
the existing chevron:

```
│ ▸ │ Příspěvek podzim 2026 │ 31. 10. 2026 │ — │ 🟡 Čeká na platbu │ [⧉ Zaplatit] │
     └ expanded ────────────────────────────────────────────────────────────────┐
       ┌──────────────┐   Účet          2600123456/2010          [⧉]            │
       │  ███ ▄▄ ███  │   Částka        1 500 Kč                 [⧉]            │
       │  █ █ ██ █ █  │   Variabilní    2026014                  [⧉]            │
       │  ███ ▀▀ ███  │     symbol                                              │
       └──────────────┘   Zpráva pro    PRISPEVEK PODZIM 2026 NOVAK  [⧉]        │
                            příjemce                                            │
                          Splatnost     31. 10. 2026                            │
                                                                                │
       Naskenujte QR kód v bankovní aplikaci. Variabilní symbol je              │
       potřeba — bez něj platbu nespárujeme.       [ Zkopírovat všechny údaje ] │
       └────────────────────────────────────────────────────────────────────────┘
```

* **On a phone the QR is the secondary affordance, not the primary one** — you
  cannot scan your own screen. Below `sm`, the copy rows come first and the QR
  renders underneath at a smaller size with the caption „QR kód pro naskenování
  z jiného zařízení." Every value has its own copy button plus one
  „Zkopírovat všechny údaje".
* All copying goes through `copyToClipboard` from `~/lib/clipboard`
  (never `navigator.clipboard.writeText` — the bare call throws in insecure
  contexts). Copy buttons are icon-only with `sr-only` labels
  („Zkopírovat číslo účtu" …) and flip to a `Check` icon + „Zkopírováno" for 2 s.
* The QR `<img>` carries a **useful `alt`**, not `alt=""`:
  „QR kód pro platbu 1 500 Kč, variabilní symbol 2026014" — a screen-reader user
  gets the payment details, which is the whole information content of the image.
* `loading='lazy'`, fixed `width`/`height` so the row does not jump.
* Rows that are `paid` or `waived` show no QR.
* `OutstandingPaymentsBanner` (dashboard) gains no QR — it links here.

### 6.7 States (QR surfaces)

* **Loading** — the QR is fetched per row on expand, via the `useQuery` +
  `useRun` per-row lazy pattern already used by `MyPaymentHistoryRow.tsx`
  (`retry: false`, `throwOnError: false`). Placeholder: a `Skeleton` at the QR's
  exact dimensions.

  **It cannot be a bare `<img src="…/qr.png">`.** This app authenticates with a
  **Bearer token held in `localStorage`** (`src/lib/token.ts`, `getToken`), and
  an `<img>` request carries no `Authorization` header — the endpoint would
  answer 401 and every player would see a broken image. The fetch goes through
  `useQrObjectUrl` (fetch-with-Bearer → `response.blob()` →
  `URL.createObjectURL`), the same flow `EmailDetailPage.tsx:184-225` uses for
  attachment downloads. **The hook's exact shape is load-bearing and is specified
  in §9.2.1** — a naive version renders one member's QR under another member's
  name, which produces a real payment with the wrong variable symbol.
* **Error** — „QR kód se nepodařilo vytvořit. Údaje k platbě najdete vedle."
  The text details still render; the payment is never blocked by an image.
* **No club account configured** — „Klub zatím nemá nastavený bankovní účet.
  Ozvěte se pokladníkovi." No QR, no fake account number.
* **Member has no VS** — the QR must **not** be generated without a VS (it would
  create exactly the unmatched payment this feature exists to prevent). Instead:
  „Nemáte přidělený variabilní symbol. Ozvěte se pokladníkovi — bez něj nejde
  platbu spárovat." and the treasurer sees the same member in §5.3's banner.

---

## 7. Screen 5 — Export for the grant audit

### 7.1 Purpose

Produce the evidence pack for Praha 20, contract **S/12/2026/0109**, due
**31. 1. 2027**: bank movements over a chosen period with counterparty, variable
symbol and message. CSV for the treasurer's own arithmetic; PDF as the document
that is actually submitted.

### 7.2 Placement and layout

Third tab of the bank page, `?tab=export`, titled **„Export pro dotaci"** —
named after the job, not the file format, because that is what the treasurer is
looking for in January.

```
┌─ Export bankovních pohybů ─────────────────────────────────────────┐
│ Vyexportujte pohyby na účtu za zvolené období — jako podklad pro   │
│ vyúčtování dotace nebo pro účetnictví.                             │
│                                                                    │
│ Období                                                             │
│ ( Tento rok ) ( Minulý rok ) ( Celá historie ) ( Vlastní rozsah )  │
│ Od [ 1. 1. 2026 ▾ ]   Do [ 31. 12. 2026 ▾ ]     ← DatePicker ×2    │
│                                                                    │
│ Formát                                                             │
│ [  CSV (pro Excel)  |  PDF (pro úřad)  ]        ← ToggleGroup      │
│                                                                    │
│ Označení dokumentu (nepovinné)                  ← PDF only         │
│ [ Smlouva č. S/12/2026/0109                                      ] │
│ Vytiskne se v hlavičce dokumentu.                                  │
│                                                                    │
│ ─────────────────────────────────────────────────────────────────  │
│ ✅ Celé období je načtené z banky.                                 │
│ Ve vybraném období je 143 pohybů.                                  │
│ Počáteční zůstatek 41 250 Kč · Příjmy 128 400 Kč ·                 │
│ Výdaje 96 210 Kč · Konečný zůstatek 73 440 Kč                      │
│                                                                    │
│ [ Stáhnout PDF ]                                                   │
│ CSV se otevře v Excelu v češtině: oddělovač středník, desetinná    │
│ čárka.                                                             │
└────────────────────────────────────────────────────────────────────┘
```

#### 7.2.1 Completeness — the warning that keeps the document honest

This panel renders authoritative-looking totals over **whatever happened to be
ingested**. If a history unlock failed in July, January–June was never fetched,
and a January 2027 „Tento rok" export produces a document that looks complete,
is not, and goes to a municipal office under the club's legal name. That is the
worst failure this feature can produce, and it is silent.

**A single `earliestIngestedOn` date is not enough**, and an earlier draft of
this section used one. It only catches a range that starts *before* the first
movement we ever fetched. A poller outage of three days in July sits **inside**
the range, passes that test, and the panel confidently prints
„✅ Celé období je načtené z banky" over a document with a hole in it — false
assurance in precisely the case the check exists to catch.

The summary DTO therefore carries **`coverageGaps: [{ from, to }]`**, and the
panel has three completeness states, rendered **above** the download button:

**(a) Covered** — `coverageGaps` is **empty** (not "starts late enough"):

> ✅ Celé období je načtené z banky.

A positive confirmation is not decoration here: it is what makes the warning
credible on the day it appears.

**(b) Gaps present** — `coverageGaps.length > 0`. `<Alert variant='warning'>`,
**enumerating the actual intervals** rather than describing them:

> ⚠️ **Výpis by nebyl úplný.** Z banky nejsou načtené pohyby za:
> • **1. 1. 2026 – 12. 7. 2026**
> • **3. 9. 2026 – 6. 9. 2026**
> V dokumentu by tato období chyběla.
> `[ Načíst chybějící období ]`  `[ Exportovat jen od 13. 7. 2026 ]`
> `[ Exportovat s upozorněním ]`

The list is rendered as a real `<ul>`, capped at five intervals with
„…a další {n} období" beyond that — a treasurer with six holes needs to press
*Načíst chybějící období*, not read a wall of dates.

* `Načíst chybějící období` opens the backfill dialog (§2.5 F) pre-filled with
  the **union** of the gaps (earliest `from` → latest `to`) — the only option
  that actually fixes it, so it is first and primary.
* `Exportovat jen od …` narrows the range to the longest fully-covered stretch,
  and the header of the resulting document then honestly says so. It is offered
  **only when a leading gap exists**; it cannot repair an interior hole, and
  offering it there would be a fake fix.
* `Exportovat s upozorněním` is deliberately the third, `variant='outline'`
  option and **stamps the PDF** with a line directly under the period:

  > *Upozornění: z banky nebyla načtena tato období: 1. 1. 2026 – 12. 7. 2026,
  > 3. 9. 2026 – 6. 9. 2026. Pohyby za tato období ve výpisu chybí.*

  All intervals are printed, never truncated — the PDF is the artefact an auditor
  keeps, so its stamp is the one place the full list must survive.

  The stamp is not suppressible. A treasurer whose bank account genuinely opened
  mid-period has a legitimate need for this path; a treasurer who has a gap needs
  the reader to know. Both are served by the same sentence.
* **CSV gets the on-screen warning but no in-file stamp.** A comment block above
  the header row would break the file for the very Excel the format exists for:
  the UTF-8 BOM is followed immediately by that free-text line, Excel takes it as
  the header row, and the double-clickable file the format was chosen for stops
  working. The gap list travels as an **`X-Export-Coverage-Gaps` response
  header** instead, so it is still machine-readable, and the panel says plainly:
  „Upozornění se do CSV nevkládá; do PDF ano."

**(c) Nothing ingested at all** — the export is disabled with
„Z banky zatím nejsou načtené žádné pohyby." and a link to the connection card.

* **Presets reuse existing keys** `finance_period_thisYear`,
  `finance_period_allTime`, `finance_period_custom` — do not mint duplicates
  (`AGENTS.md` i18n rule 6). Only „Minulý rok" is new.
* Date inputs are `<DatePicker>` with `fromYear={currentYear-5}`
  `toYear={currentYear}`, **not** `<input type='date'>`. (`ExpensesListPage.tsx:241,253`
  still uses the native input — that is documented debt, not a pattern to copy.)
* **The count + totals line is live** and updates as the range changes. It is
  the cheapest possible protection against submitting an empty or wrong-period
  file to a municipality.
* **Opening and closing balances are part of the summary, not an extra.** They
  are what an auditor reconciles against the paper bank statement: if the opening
  balance, the movements and the closing balance agree with the bank's own
  statement, the document is self-proving. Without them the annex is a list that
  has to be taken on trust. They require the server to carry
  `openingBalanceMinor` / `closingBalanceMinor` for the period.
* The button label names the format the toggle selected („Stáhnout PDF" /
  „Stáhnout CSV") — never a generic „Exportovat".

### 7.3 Generating / ready states

The primary path is synchronous, following `DataExportCard.tsx:76-98` (build a
Blob, `URL.createObjectURL`, click a hidden anchor, revoke):

| State | UI |
|---|---|
| **Idle** | button enabled, preview line shown |
| **Generating** | `<Button disabled aria-busy='true'>` → „Připravuji soubor…" + spinner; the range controls stay enabled but changing them cancels nothing (the in-flight request wins). A `role='status'` live region announces „Připravuji soubor." |
| **Ready (sync)** | download fires automatically; toast „Soubor stažen." + a muted line „Stažen soubor `vypis-2026-01-01_2026-12-31.pdf`." with a „Stáhnout znovu" link kept until the range changes |
| **Slow (> 5 s)** | the copy changes to „Připravuji soubor… u delších období to může trvat i minutu." — no progress bar, because we have no honest percentage |
| **Ready (async fallback)** | if the server ever moves to a job queue: a card „Soubor je připravený." + `[ Stáhnout ]` + „Odkaz platí 15 minut." Designed now so the switch costs no redesign |
| **Empty range** | button disabled **with a message**: „Ve vybraném období nejsou žádné pohyby. Zkuste jiné období." Never a silently dead button |
| **Error** | toast via `run()` + an inline `Alert variant='destructive'`: „Soubor se nepodařilo vytvořit. Zkuste to prosím znovu." with `[ Zkusit znovu ]` |
| **Not connected** | the tab renders „Banka zatím není propojená." + link to settings |

Filename convention (both formats):
`vypis-{team-slug}-{from}_{to}.{csv|pdf}` → `vypis-ufhp-2026-01-01_2026-12-31.pdf`.

### 7.4 The PDF — a document, not a screen dump

This is submitted to a municipal office and will be read on paper by someone who
has never seen Sideline. It must look like an accounting annex.

```
┌────────────────────────────────────────────────────────────────────────┐
│  VÝPIS BANKOVNÍCH POHYBŮ                                               │
│  Smlouva č. S/12/2026/0109                        ← optional label     │
│                                                                        │
│  Ultimate Frisbee Horní Počernice, z. s.          ← recipient_name     │
│  IČO: 12345678 · Sídlo: Náchodská 1, Praha 20     ← NEW config fields  │
│  Číslo účtu: 2600123456/2010 (Fio banka, a.s.)                         │
│  Období: 1. 1. 2026 – 31. 12. 2026                                     │
│  Počáteční zůstatek k 1. 1. 2026:            41 250,00 Kč              │
│  ────────────────────────────────────────────────────────────────────  │
│  Datum      Protistrana              Účet protistrany  VS       Zpráva                Částka │
│  05.01.2026 Jan Novák                1234567890/0800   2026014  Příspěvek podzim   1 500,00 │
│  07.01.2026 Městská část Praha 20    2000150005/6000   —        Dotace 2026      120 000,00 │
│  12.01.2026 Tisk Dvořák s.r.o.       4711000123/0300   —        Dresy             −8 400,00 │
│  ────────────────────────────────────────────────────────────────────  │
│  Počet pohybů: 143                                                     │
│  Příjmy celkem:              128 400,00 Kč                             │
│  Výdaje celkem:               96 210,00 Kč                             │
│  Konečný zůstatek k 31. 12. 2026:            73 440,00 Kč              │
│  ────────────────────────────────────────────────────────────────────  │
│  Vygenerováno: 14. 1. 2027 v 19:42 · Sideline            Strana 1 / 4  │
└────────────────────────────────────────────────────────────────────────┘
```

Non-negotiables:

1. **Full Czech diacritics everywhere.** The backend embeds a Unicode font
   precisely for this. „Příspěvek", „Městská část", „Dvořák" — a document to a
   municipality with `Prispevek` in it looks like an error, and the header
   already carries the club's legal name which contains `č`.
   The diacritic-free strings of §6.2 **never** appear here — except in the
   *Zpráva* column, where the payer's own text is reproduced verbatim (if they
   sent `PRISPEVEK PODZIM 2026 NOVAK`, that is what the bank recorded and that is
   what the evidence must say).
2. **Czech number formatting**: space as thousands separator, comma as decimal,
   two decimals, right-aligned, `Kč` in the totals block. Czech date format
   `DD.MM.YYYY`.
3. **Outgoing amounts carry a minus sign**, not red text — it prints black.
4. **Repeating header row on every page**, page numbers `Strana n / m`, and the
   generation timestamp in the footer of every page.
5. **Nothing interactive, no colour blocks, no logo-as-decoration.** A4 portrait,
   ≥ 10 pt body.
6. Long counterparty names wrap rather than truncate; the *Zpráva* column
   truncates with `…` at a documented width and the full text stays in the CSV.
7. **Opening and closing balance frame the table** (§7.2 bullet). They are the
   two numbers an auditor checks against the bank's own statement, and they turn
   the annex from a list into something self-proving.
8. **The incompleteness stamp (§7.2.1 b), when applicable**, goes directly under
   the period line, in italics, and is never suppressible.

**Three header fields do not exist in the data model yet** — the config table
holds only `recipient_name`. This document is grant-audit evidence submitted
under the club's legal identity, and a Czech grant annex is expected to carry the
recipient's **IČO**, because that is how the contract identifies them. So:

| Field | Source | If missing |
|---|---|---|
| Club name | existing `recipient_name` | falls back to the team name; required when the connection is enabled (§2.6) |
| **IČO** | **new** `bank_sync_config.registered_id` — 8 digits + mod-11 check | line omitted; the export panel shows a non-blocking hint |
| **Sídlo** | **new** `bank_sync_config.registered_address` — free text | line omitted; same hint |
| Bank name | constant „Fio banka, a.s." derived from the bank code | n/a |

The hint in the export panel, when either is empty — a nudge, never a block:

> Doplňte IČO a sídlo klubu v nastavení banky. Na dokumentu pro úřad se
> očekávají. *[Otevřít nastavení]*

Blocking the export on them would be wrong: a treasurer at 23:40 on 31. 1. 2027
needs the file more than they need the perfect header, and the missing line is
visible on the document itself.

### 7.5 The CSV — and what to tell the treasurer about it

The file opens in **Czech Excel**, which means the backend's choices have
consequences the UI has to set expectations for:

| Backend choice | Consequence | UI copy |
|---|---|---|
| **Semicolon** delimiter | Czech Excel's default list separator is `;`, so a double-click opens it correctly with no import wizard | „Oddělovač je středník." |
| **Comma** decimal separator (`1234,50`) | `1234,50` is a *number* to Czech Excel; `1234.50` would land as text and `=SUM()` would return empty. Unambiguous because the delimiter is `;` | „Desetinná čárka." |
| UTF-8 **with BOM**, emitted once at index 0 | without the BOM Czech Excel decodes ANSI and „Novák" becomes „NovÃ¡k" | (no copy — it just has to work) |
| Leading zeros are **lost, and cannot be saved** | `0123456789` opens as `123456789`. **Quoting does not prevent this** — a CSV field's quotes are structural, not a type marker, and a leading apostrophe is not a fix either: Excel's text marker applies to typed cells, not to CSV import, where it renders literally as part of the value | **must be said out loud** — see below |

**The earlier draft of this table claimed account numbers were „quoted as text"
and marked it „(no copy)".** That was wrong twice over: the mitigation does not
exist, and marking it silent left the treasurer with no warning about a loss that
was deliberately accepted rather than fixed. The decision was to **document** the
leading-zero loss (no XLSX dependency, PDF is the authoritative audit artefact),
and a documented loss with no user-facing sentence is an undocumented loss.

Help lines under the CSV option:

> Soubor je připravený pro Excel v češtině — oddělovač je středník a desetinná
> čárka. Stačí ho otevřít dvojklikem. V Google Sheets zvolte při importu
> oddělovač „středník".

> ⚠️ V Excelu mohou variabilní symboly a čísla účtů ztratit úvodní nuly
> (`0123456789` se otevře jako `123456789`). **Pro úřad použijte PDF — tam jsou
> správně.** Když potřebujete CSV, otevřete ho přes **Data → Z textu/CSV** a
> sloupci „Variabilní symbol" nastavte typ **Text**.

The warning sits with the format toggle, not in a tooltip: it changes which
format the treasurer should pick for the grant annex, so it has to be readable
before the choice is made.

Columns (header row in Czech): `Datum;Protistrana;Účet protistrany;Variabilní
symbol;Zpráva pro příjemce;Částka;Měna;Stav přiřazení;Přiřazeno k;Poznámka`.
The last three make the CSV usable as a reconciliation working file, which is
what the treasurer will actually do with it.

---

## 8. Accessibility

### 8.1 Never colour alone — the load-bearing rule here

The reason a transaction failed to match is the single most important piece of
information on the primary screen, and it **must survive greyscale, forced-colors
mode, a colour-blind reader and a screen reader**. Every status in this feature
therefore carries **at least three** channels:

| Status family | Icon (shape) | Text | Border/fill | Machine |
|---|---|---|---|---|
| Match reason ×9 | distinct lucide glyph per reason (§3.5) | full label, always visible — never truncated to the icon | solid vs **dashed** border splits "clear defect" from "needs judgement" | `data-reason` |
| Bank-sync status ×6 + the additive expiry banner | `CheckCircle` / `Clock` / `RefreshCw` / `AlertTriangle` / `CalendarClock` / `ServerCrash` / `Landmark` — one glyph per state, none shared | a sentence, not a word | Alert variant | `data-bank-sync-status` |
| Payment status | reuses `PaymentStatusBadge` unchanged | | | `data-status` |
| Voided | `line-through` + `opacity-60` + the word „Zrušeno" | | | `data-voided` |

An icon is never the only carrier of meaning, and a colour is never the only
differentiator between two reasons. `RoleBadge.tsx` is the in-repo precedent for
shape-plus-icon-plus-accessible-name and this follows it exactly.

Contrast: reuse the theme tokens (`--warning`, `--success`, `--destructive` and
their `-foreground` pairs, `applications/web/src/styles.css:36-50,76-89`) and the
amber/red utility pairs already shipped in `PaymentStatusBadge.tsx:17-38`, which
carry explicit dark-mode variants. **Do not invent new colour pairs** — the
existing set is already contrast-checked in both themes. The one thing to verify
before merge: the dashed-border reason badge at `text-xs` must still clear 3:1
against `--card` for its non-text border in dark mode.

### 8.2 Keyboard

* Every action is a real `<Button>` / `<a>`. No click handlers on `<Badge>`
  (it is a bare `<span>`, not focusable) and no `div onClick`.
* **Queue table tab order** per row: checkbox → `Přiřadit` → `⋯`. The row itself
  is not focusable; there is no "click the row" affordance to discover.
* Filter chips are `<button aria-pressed>` in a `<fieldset>`, reachable by Tab,
  toggled with Space/Enter — the `AssignmentsTab.tsx:120-140` shape.
* The bulk bar is `role='region'` with an `aria-label`, placed **after** the
  table in DOM order so Tab reaches it having passed the rows it acts on.
* `Escape` closes every dialog and sheet and is never suppressed — including the
  resolve dialog, even with unsaved input (a confirmation on Escape would be a
  worse trade than a lost half-filled form).
* The QR expander in `/my-payments` is a button with `aria-expanded` +
  `aria-controls`, matching the existing history expander (`MyPaymentsPage.tsx:234-247`).

### 8.3 Focus management

1. **Dialog open** → Radix moves focus to the first focusable element. In the
   resolve dialog that is the mode radio group; the treasurer can choose a branch
   before touching anything else.
2. **Dialog close** → focus returns to the trigger. Radix does this only when the
   dialog stays mounted, which is why AGENTS.md forbids conditional mounting;
   this feature's dialogs are all `open`-driven with a frozen `useRef` payload.
3. **Row removed after a successful resolve** → focus would otherwise fall to
   `<body>` and the keyboard user is dumped at the top of the document. Move
   focus to the **next row's `Přiřadit` button**, or to the empty-state heading
   when that was the last row. This is the single most valuable focus decision on
   the page, because the whole screen is "resolve, repeat".
4. **`Nahradit token` (§2.5 D)** → focus moves into the now-revealed token input.
5. **`Doplnit symboly` deep link** (`?focus=vs`) → focus moves to the VS input on
   the member detail page after load.
6. **Empty-state heading** is `tabIndex={-1}` so it can receive focus from (3).

### 8.4 Screen-reader labelling

* The write-only token block sits in `<div aria-live='polite'>`, mirroring
  `EmailForwardingCard.tsx:448`, so the unset → set → replacing transition is
  announced.
* The Fio status sentence is a **`aria-live='polite'` region, not `role='status'`**
  — the settings page already has two other live regions and `role='status'`
  instances collide (the reason for the comment at `EmailForwardingCard.tsx:530-531`).
* Failures use `role='alert'` (assertive) so they interrupt; successes use the
  toast **or** a polite region, never both — announcing the same string twice is
  a worse experience than announcing it once.
* Every icon is `aria-hidden='true'` and every icon-only control has an
  `sr-only` label: „Zkopírovat číslo účtu", „Další akce pro platbu z 3. 3. 2026",
  „Zobrazit historii přiřazení".
* Table headers are real `<th>`; the checkbox column header is
  `<th><span className='sr-only'>Vybrat</span></th>`, and the per-row checkbox is
  labelled with the transaction („Vybrat platbu 1 500 Kč z 3. 3. 2026") rather
  than a bare „Vybrat".
* The QR image's `alt` carries the payment data (§6.6) — it is information, not
  decoration.
* The split sub-form's balance line is `aria-live='polite'` so the remainder is
  announced as amounts are typed; the countdowns (token activation, 10-minute
  unlock window) are **`aria-live='off'`** — a per-second announcement is
  unusable — with only the state transition announced.
* `aria-busy` on any region that is refetching; `aria-invalid` +
  `aria-describedby` on every field that can be rejected.

### 8.5 Touch and motion

* Tap targets ≥ 44 px on every mobile control (primary row action is `w-full`).
* No hover-only disclosure anywhere: a Radix `Tooltip` never opens on tap, so
  any information reachable *only* by hovering must be a `Popover` or inline
  text. The reason explanation lines are inline text for exactly this reason.
* The chevron rotation and the dialog transitions are the only motion; both
  inherit the app's existing `transition-*` utilities and respect
  `prefers-reduced-motion` through Tailwind's defaults.

---

## 9. Component inventory — reuse vs. new

### 9.1 Reused unchanged

`ui/`: `card`, `button`, `input`, `label`, `textarea`, `select`, `checkbox`,
`switch`, `separator`, `badge`, `alert`, `alert-dialog`, `dialog`, `sheet`,
`popover`, `dropdown-menu`, `skeleton`, `toggle-group`, `date-picker`,
`sonner`.
`atoms/`: `SearchableSelect`.
`molecules/`: `PaymentStatusBadge`.
`organisms/team-settings/`: `SaveRow`, `useCardForm`.
`lib/`: `finance/formatMoney`, `finance/parseAmount`, `clipboard.copyToClipboard`,
`datetime`, `runtime.useRun`.
`hooks/`: `useFormatDate`, `useDateFnsLocale`.

**No new Shadcn primitive needs installing.** In particular: do **not** add
`ui/table`, `ui/collapsible`, `ui/progress` or `@tanstack/react-table` for this
feature. The disclosure in §2.4 is a `useState` boolean; the tables follow the
nine existing hand-rolled ones; there is no honest progress percentage to show.

### 9.2 New — web

**File names follow the implementation plan wherever it names one.** Two names
for one component is how a duplicate file gets written — and this table diverged
from the plan in revision 2 while saying that very sentence, which is why it is
now `Fio*` throughout, matching `fioBankForm.test.ts` in the plan's test list.

| Layer | File | Responsibility |
|---|---|---|
| *(import)* | `@sideline/domain` → `Spayd.ts`, `CzIban.ts`, `BankTransaction.ts`, `BankSyncApi.ts` | SPAYD payload + transliteration, CZ IBAN + modulo-11, the `BankTransactionMatchReason` union, DTOs. **The web writes none of these** (§6.2) |
| lib | `src/lib/finance/matchReasons.ts` | `Record<BankTransactionMatchReason, { label; hint; Icon; dashed }>` of literal `tr()` calls, keyed off the **imported** union (§1.4 + §3.5) + unit test |
| lib | `src/lib/finance/useQrObjectUrl.ts` + `.test.ts` | `useQrObjectUrl(teamId, feeId, assignmentId) → { url, state: 'loading' \| 'ready' \| 'error' }`. **Spec and required tests in §9.2.1** — the naive version has three failure modes and one of them renders another member's QR |
| atom | `atoms/QrPaymentCode.tsx` | presentational only: takes `{ url, state }` from the hook, renders the `<img>` with the informative `alt`, fixed dimensions, `Skeleton` while loading, retry on error. **It owns no fetch** |
| molecule | `molecules/MatchReasonBadge.tsx` | icon + label + solid/dashed border + `data-reason` |
| molecule | `molecules/FioStatusBadge.tsx` | the status badge, `DiscordConnectionBadge.tsx` shape |
| molecule | `molecules/PaymentDetailsList.tsx` | the account/amount/VS/message rows with per-row copy buttons (shared by the web QR card and the resolve dialog's detail sheet) |
| organism | `organisms/team-settings/FioBankCard.tsx` + `fioBankForm.ts` + `fioBankForm.test.ts` | §2 — plan-named |
| organism | `organisms/bank/FioStatusBlock.tsx` | the status blocks + the additive expiry banner + the T−7 escalation branch (§2.5) |
| organism | `organisms/bank/BackfillDialog.tsx` | the 10-minute unlock flow (§2.5 F) |
| organism | `organisms/bank/UnmatchedQueue.tsx` | table/card-list, chips, search, selection, bulk bar |
| organism | `organisms/MatchTransactionDialog.tsx` | the four-mode dialog incl. the split sub-form (§3.6) — plan-named |
| organism | `organisms/bank/UnmatchDialog.tsx` | the void confirm with the required reason (§3.9) |
| organism | `organisms/bank/MatchedList.tsx` | the audit tab with expandable evidence (§3.10) |
| organism | `organisms/bank/BankExportPanel.tsx` | §7 incl. the completeness states (§7.2.1) |
| organism | `organisms/AssignVariableSymbolsDialog.tsx` | the preview-then-apply bulk assign (§5.3) — see §11A |
| page | `pages/BankTransactionsPage.tsx` | tab shell, KPI strip, banners; controlled/uncontrolled tab props per the `FinancesOverviewPage` contract — plan-named |
| route | `routes/(authenticated)/teams/$teamId/finances_.bank.tsx` | `ssr: false`, `validateSearch` + `isBankTab` guard, loader |

Edits to existing files: `AppSidebar.tsx` (nav item), `AuthenticatedLayout.tsx`
(breadcrumb branch), `TeamSettingsPage.tsx` (card), `TeamMembersPage.tsx` +
`PlayerRow.tsx` (VS column + banner), `PlayerDetailPage.tsx` (VS field),
`MyPaymentsPage.tsx` (QR expander), `FeeFormDialog.tsx` (soft 45-char counter),
`WaiveAssignmentDialog.tsx` (accept a pre-filled reason, §3.6 rule 3).

**Promote `DirtyFieldLabel`** out of `PlayerDetailPage.tsx:700` into
`molecules/DirtyFieldLabel.tsx` — the VS field is its third consumer and copying
it a third time is how the `sr-only` half gets dropped.

#### 9.2.1 `useQrObjectUrl` — the shape, because the naive version is wrong three ways

"Authenticated fetch → blob → `createObjectURL`, revoke in cleanup" is a correct
*sentence* and an under-specified *effect*. The obvious implementation breaks in
three ways, and the obvious test (render five rows, unmount, assert five revokes)
passes against all three:

1. **StrictMode double-invoke leak.** React 18/19 in development mounts, unmounts
   and remounts. The cleanup runs **before the first `fetch` resolves**, so the
   first object URL is created after its own cleanup has already run and is never
   revoked.
2. **Out-of-order responses — the one that actually matters.** The treasurer or
   player expands row A, then row B. If A's response resolves *after* B's, the
   last `setState` wins and the component renders **A's QR under B's heading**.
   A player scanning it pays a correct amount to a correct account with **another
   member's variable symbol** — the payment then auto-matches to the wrong person
   and the ledger is wrong in a way nobody notices until reconciliation. This is
   the single worst outcome in the whole feature and it is a four-line fix.
3. **Revoke racing the render.** Putting `url` in the dependency array (or
   closing over the state value in the cleanup) revokes the URL the DOM is
   currently painting, and the user sees a broken-image glyph.

Required shape:

```ts
React.useEffect(() => {
  let cancelled = false;
  let objectUrl: string | undefined;

  setState('loading');
  void (async () => {
    try {
      const res = await fetch(url, { headers });   // Bearer from lib/token.ts
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      objectUrl = URL.createObjectURL(blob);
      if (cancelled) { URL.revokeObjectURL(objectUrl); return; }  // (1)
      setUrl(objectUrl);                                          // (2)
      setState('ready');
    } catch {
      if (!cancelled) setState('error');
    }
  })();

  return () => {
    cancelled = true;
    if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
  };
}, [teamId, feeId, assignmentId]);   // (3) never `url`, never the state value
```

* The `cancelled` flag is captured **per effect run**, so a stale run can neither
  set state nor outlive its own cleanup — that closes (1) and (2) with the same
  mechanism.
* `objectUrl` is a local `let`, not state, so the cleanup revokes exactly the URL
  that run created — that closes (3).
* Deps are the three identifiers only.

**Two tests, both of which the "five rows, five revokes" test misses:**

1. Mount the hook inside `<React.StrictMode>` and assert
   `createObjectURL.mock.calls.length === revokeObjectURL.mock.calls.length`
   after unmount. Catches (1).
2. Render with `assignmentId = A`, change it to `B` **before A's fetch resolves**,
   then resolve A after B. Assert the rendered `url` is **B's** and that A's
   object URL was revoked. Catches (2) — the wrong-QR race.

### 9.3 New — bot

| File | Responsibility |
|---|---|
| **edit** `src/rcp/finance/buildPaymentReminderEmbed.ts` | add the VS field, the fallback code block, the optional `qrAttachmentUrl` → `image.url`, an `assigned` arm in `copyForKind`, and move the inline English to `bot_payment_reminder_*` keys (§6.4). **No new QR message family.** Note the path: this builder lives under `src/rcp/finance/`, not `src/rest/finance/` (which holds only `formatMoney.ts`) — an earlier draft of this table had it in the wrong directory |
| **edit** `src/rcp/finance/handlePaymentReminderReady.ts` | fetch the QR over `Finance/GetPaymentQr`, wrap it with `filesField`, keep the existing ack ordering (`MarkReminderSent` → `MarkPaymentReminderProcessed`) |
| `src/rcp/finance/handleBankTokenExpiring.ts` *(new)* | treasurer DM + ack for the `bank_token_expiring` event (§6.5) |
| **edit** `src/rcp/finance/ProcessorService.ts` | `Match.tag('bank_token_expiring', handleBankTokenExpiring)` |
| tests under `test/rcp/finance/` mirroring 1:1 | incl. the retry-count assertion, and a test that a **missing** QR still sends the text-only reminder |

### 9.4 Explicitly *not* built

* A shared sortable/filterable table component (separate refactor, §1.2).
* Bulk assign-to-member (§3.8).
* Any UI for HTTP 409 / 413 (§2.5).
* A progress bar for export (§7.3).
* Client-side SPAYD/QR rendering — the payload and the PNG are server-side, and
  the pure modules live in `@sideline/domain` (§6.2).
* A second QR Discord message (§6.4) — it extends the existing reminder.
* Any bank-reversal machinery (§3.9.1).
* A toast-level undo (§3.9).

---

## 10. New i18n keys

Add to **both** `packages/i18n/messages/en.json` and `cs.json` (lockstep is
mandatory — a missing key fails the Paraglide build), then `pnpm codegen &&
pnpm build`. Web calls `tr('key')`; the bot calls `m.bot_key({}, { locale })`.
Czech register: **formal vykání**, matching the existing `finance_*` /
`bot_finance_*` family.

### 10.1 Reused, do not duplicate

`finance_kpi_outstanding`, `finance_kpi_overdue`, `finance_filter_all`,
`finance_period_thisYear`, `finance_period_allTime`, `finance_period_custom`,
`finance_payment_method_bank_transfer`, `finance_column_status`,
`finance_column_member`, `expenses_clearFilters`, `common_cancel`,
`loading_text`, `form_fieldChanged`, `members_saving`, `members_saveChanges`,
`members_unsavedChanges`, `members_noPlayers`, `teamSettings_unsavedChanges`,
`profile_saving`, `profile_saveChanges`, `my_payments_history_voided`,
`team_settings`, `team_backToTeams`.

> **Fix in the same PR:** `teamSettings_unsavedChanges` cs is currently
> `"Mate neulozone zmeny."` → `"Máte neuložené změny."`

### 10.2 Fio connection (`fio_*`)

| Key | en | cs |
|---|---|---|
| `fio_card_title` | Bank connection (Fio) | Propojení s bankou (Fio) |
| `fio_card_description` | We read payments from the club account and match them to fees. | Načítáme platby z účtu klubu a párujeme je s předpisy. |
| `fio_enabled_label` | Enabled | Zapnuto |
| `fio_enabled_help` | Without this, no movements are imported. | Bez zapnutí se pohyby nenačítají. |
| `fio_account_label` | Club account number | Číslo účtu klubu |
| `fio_account_prefix` | Prefix | Předčíslí |
| `fio_account_number` | Account number | Číslo účtu |
| `fio_account_bankCode` | Bank code | Kód banky |
| `fio_account_bankCodeHelp` | We currently support Fio bank accounts only. | Podporujeme zatím jen účty vedené u Fio banky. |
| `fio_account_preview` | Account: {account} · IBAN {iban} | Účet: {account} · IBAN {iban} |
| `fio_account_errorPrefix` | The prefix has at most 6 digits. | Předčíslí má nejvýš 6 číslic. |
| `fio_account_errorChecksum` | The account number failed its checksum. Is there a typo? | Číslo účtu neprošlo kontrolním součtem. Není tam překlep? |
| `fio_token_label` | API token | API token |
| `fio_token_set` | The token is saved. | Token je uložený. |
| `fio_token_replace` | Replace token | Nahradit token |
| `fio_token_cancel` | Cancel | Zrušit |
| `fio_token_placeholder` | Paste the token from Fio Internetbanking | Vložte token z Fio Internetbankingu |
| `fio_token_help` | The token is shown only once in Internetbanking. | Token se v Internetbankingu zobrazí jen jednou. |
| `fio_token_replaceHelp` | Paste the new token. The old one stops being used on save. | Vložte nový token. Ten starý se po uložení přestane používat. |
| `fio_token_errorShort` | The token looks unusually short. Did you copy all of it? A Fio token is 64 characters. | Token vypadá nezvykle krátce. Zkopírovali jste ho celý? Fio token má 64 znaků. |
| `fio_tokenCreatedAt_label` | Token created on | Token vytvořen dne |
| `fio_tokenCreatedAt_help` | Fio doesn't tell us when the token expires. We count 180 days from this date and warn you 14 days ahead. Leave today's date and the warning will be accurate. | Fio nám neřekne, kdy token vyprší. Počítáme 180 dní od tohoto data a 14 dní předem vás upozorníme. Necháte-li dnešní datum, bude upozornění přesné. |
| `fio_tokenCreatedAt_errorFuture` | The date can't be in the future. | Datum nemůže být v budoucnosti. |
| `fio_recipientName_label` | Recipient name | Název příjemce |
| `fio_recipientName_help` | Appears in the payment QR code and in the header of the PDF statement. | Objeví se v QR kódu k platbě a v hlavičce PDF výpisu. |
| `fio_recipientName_required` | Fill in the club name exactly as the bank has it. | Vyplňte název klubu tak, jak ho má banka. |
| `fio_documents_section` | Details for documents | Údaje pro dokumenty |
| `fio_documents_help` | Printed in the header of the PDF statement for the authority. Without them the document is still generated, but carries no club identification. | Vytisknou se v hlavičce PDF výpisu pro úřad. Bez nich se dokument vygeneruje, ale bude bez identifikace klubu. |
| `fio_registeredId_label` | Company ID (IČO) | IČO |
| `fio_registeredId_error` | An IČO has 8 digits and this one failed its checksum. | IČO má 8 číslic a neprošlo kontrolním součtem. |
| `fio_registeredAddress_label` | Registered address | Sídlo |
| `fio_token_validity` | The token is valid for at most 180 days. It renews itself whenever you sign in to Internetbanking or Smartbanking — if you don't sign in for a long time, it expires quietly. We'll warn you 14 days ahead. | Token platí nejvýše 180 dní. Prodlužuje se sám pokaždé, když se přihlásíte do Internetbankingu nebo Smartbankingu — pokud se dlouho nepřihlásíte, token tiše vyprší. Upozorníme vás 14 dní předem. |
| `fio_help_toggle` | Where do I get the token? | Kde token vezmu? |
| `fio_help_step1` | Sign in to Fio Internetbanking (ib.fio.cz). | Přihlaste se do Internetbankingu Fio (ib.fio.cz). |
| `fio_help_step2` | Open Settings → API. | Otevřete Nastavení → API. |
| `fio_help_step3` | Click Create new token. | Klikněte na Vytvořit nový token. |
| `fio_help_step4` | Choose the "Account monitoring" permission — the token will only be able to read movements. | U práv zvolte „Sledování účtu" — token bude umět jen číst pohyby. |
| `fio_help_step5` | Pick the club account and confirm. | Vyberte účet klubu a potvrďte. |
| `fio_help_step6` | The token is shown only once. Copy it and paste it here. | Token se zobrazí jen jednou. Zkopírujte ho a vložte sem. |
| `fio_help_warningTitle` | Never create a token that can submit payment orders. | Nikdy nevytvářejte token s právem zadávat platební příkazy. |
| `fio_help_warningBody` | The token is stored here so Sideline can see incoming payments. If someone misused a token with the "Account monitoring" permission, they still could not send a single crown out of the account. With order-submitting rights they could. | Token se sem ukládá proto, aby Sideline viděl příchozí platby. Kdyby takový token někdo zneužil, s právem „Sledování účtu" nemůže z účtu odeslat ani korunu. S právem zadávat příkazy ano. |
| `fio_status_notConnectedTitle` | The bank isn't connected yet. | Banka zatím není propojená. |
| `fio_status_notConnectedBody` | Enter the account number and the API token from Fio Internetbanking. The how-to is below. | Zadejte číslo účtu a API token z Fio Internetbankingu. Návod je níž. |
| `fio_status_ok` | Connected | Připojeno |
| `fio_status_okDetail` | Last import: {time}. {imported} movements in total, {pending} waiting to be matched. | Poslední načtení: {time}. Celkem načteno {imported} pohybů, z toho {pending} čeká na přiřazení. |
| `fio_status_activatingTitle` | The token is activating. | Token se aktivuje. |
| `fio_status_activatingBody` | Fio needs about 5 minutes after a token is created before it accepts it. We'll retry by ourselves — you don't need to do anything. | Fio potřebuje po vytvoření tokenu asi 5 minut, než ho začne uznávat. Zkusíme to sami znovu — nemusíte nic dělat. |
| `fio_status_activatingRemaining` | About {time} left. | Zbývá přibližně {time}. |
| `fio_status_activatingRetry` | Try now | Zkusit hned |
| `fio_status_invalidTitle` | The token stopped working. | Token přestal platit. |
| `fio_status_invalidBody` | No movements have been imported since {date}. Fio tokens last at most 180 days and renew only when you sign in to Internetbanking or Smartbanking. | Od {date} se nepodařilo načíst žádné pohyby. Fio tokeny platí nejvýš 180 dní a prodlužují se jen tehdy, když se přihlásíte do Internetbankingu nebo Smartbankingu. |
| `fio_status_invalidAction` | Create a new token in Internetbanking (Settings → API, "Account monitoring" permission) and paste it here. | Vytvořte v Internetbankingu nový token (Nastavení → API, právo „Sledování účtu") a vložte ho sem. |
| `fio_status_neverWorkedTitle` | The token has never worked, not once. | Token se nepodařilo použít ani jednou. |
| `fio_status_neverWorkedBody` | Most often that means a copy-paste slip. Check that the token is exactly 64 characters with no space or line break in it, and copy it from Internetbanking again in full. If you created it just now, wait 5 minutes — Fio takes that long to activate it. | Nejčastěji to znamená překlep při kopírování. Zkontrolujte, že má token přesně 64 znaků a není v něm mezera ani zalomení řádku, a zkopírujte ho z Internetbankingu znovu celý. Pokud jste ho vytvořili právě teď, počkejte 5 minut — Fio ho tak dlouho aktivuje. |
| `fio_status_syncFailingTitle` | Importing from the bank isn't working right now. | Načítání z banky se teď nedaří. |
| `fio_status_syncFailingBody` | We keep retrying by ourselves. Last successful import: {time}. There's nothing to do yet — if it's still failing in a few hours, we'll tell you. | Zkoušíme to dál sami. Poslední úspěšné načtení: {time}. Zatím není potřeba nic dělat — když to nepůjde ani po několika hodinách, dáme vám vědět. |
| `fio_status_misconfiguredTitle` | The bank connection is temporarily broken on our side. | Propojení s bankou je dočasně nefunkční kvůli chybě na naší straně. |
| `fio_status_misconfiguredBody` | Your token is fine — don't change it. Please contact the Sideline administrator. | Váš token je v pořádku — neměňte ho. Ozvěte se prosím správci Sideline. |
| `fio_status_expiringTitle` | The token expires in {days} days | Token vyprší za {days} dní |
| `fio_status_expiringDate` | (on {date}) | (dne {date}) |
| `fio_status_expiringBody` | When it expires, payments stop being imported and nobody will tell you — that's why we're saying this in advance. | Až vyprší, přestanou se načítat platby a nikdo vám to neřekne — proto to hlásíme dopředu. |
| `fio_status_expiringOption1` | Sign in to Fio Internetbanking or Smartbanking — that renews the token by itself; or | Přihlaste se do Internetbankingu nebo Smartbankingu Fio — tím se token sám prodlouží; nebo |
| `fio_status_expiringOption2` | create a new token and paste it here. | vytvořte nový token a vložte ho sem. |
| `fio_status_openInternetbanking` | Open Fio Internetbanking | Otevřít Internetbanking Fio |
| `fio_backfill_button` | Import older movements | Načíst starší pohyby |
| `fio_backfill_title` | Import older movements | Načíst starší pohyby |
| `fio_backfill_body` | Fio only releases movements older than 90 days during a 10-minute window that you have to open in Internetbanking. | Fio vydá pohyby starší než 90 dní jen v 10minutovém okně, které musíte otevřít v Internetbankingu. |
| `fio_backfill_step1` | Open Internetbanking → Settings → API. | Otevřete Internetbanking → Nastavení → API. |
| `fio_backfill_step2` | Click the padlock icon next to your token. | U svého tokenu klikněte na ikonu zámku. |
| `fio_backfill_step3` | Come back here and start the import within 10 minutes. | Vraťte se sem a do 10 minut spusťte načtení. |
| `fio_backfill_action` | I've unlocked it, import | Odemkl jsem, načíst |
| `fio_backfill_running` | Importing movements… this can take a few minutes. | Načítám pohyby… může trvat několik minut. |
| `fio_backfill_window` | The window expires in {time} | Okno vyprší za {time} |
| `fio_backfill_success` | Imported {count} movements. {pending} are waiting to be matched. | Načteno {count} pohybů. {pending} čeká na přiřazení. |
| `fio_backfill_lockedTitle` | Fio didn't release the history. | Fio historii nevydalo. |
| `fio_backfill_lockedBody` | The window has most likely closed, or it was never opened. Try the padlock in Internetbanking again and start the import within 10 minutes. | Okno se nejspíš zavřelo nebo se neotevřelo. Zkuste zámek v Internetbankingu znovu a spusťte načtení do 10 minut. |
| `fio_save_success` | Bank settings saved. | Nastavení banky uloženo. |
| `fio_save_error` | The bank settings could not be saved. | Nastavení banky se nepodařilo uložit. |

### 10.3 Matching queue (`bank_*`)

| Key | en | cs |
|---|---|---|
| `bank_navTitle` | Bank movements | Bankovní pohyby |
| `bank_pageTitle` | Bank movements | Bankovní pohyby |
| `bank_tab_queue` | To match | K přiřazení |
| `bank_tab_matched` | Matched | Přiřazené |
| `bank_tab_export` | Grant export | Export pro dotaci |
| `bank_kpi_waiting` | Waiting | Čeká |
| `bank_kpi_unmatchedAmount` | Unmatched | Nepřiřazeno |
| `bank_kpi_matchedRatio` | Matched | Přiřazeno |
| `bank_kpi_membersWithoutVs` | Without a VS | Bez VS |
| `bank_searchPlaceholder` | Search name, VS, amount… | Hledat: jméno, VS, částka… |
| `bank_filter_noVs` | Without a VS | Bez VS |
| `bank_filter_unknownVs` | Unknown VS | Neznámý VS |
| `bank_filter_amountMismatch` | Amount doesn't match | Částka nesedí |
| `bank_filter_ambiguous` | Ambiguous | Nejednoznačné |
| `bank_filter_noOpen` | Nothing open | Nic otevřeného |
| `bank_col_date` | Date | Datum |
| `bank_col_amount` | Amount | Částka |
| `bank_col_counterparty` | Counterparty | Protistrana |
| `bank_col_reason` | Why it doesn't match | Proč nesedí |
| `bank_col_vs` | VS | VS |
| `bank_col_message` | Message | Zpráva |

**Key names track the wire literals of `BankTransactionMatchReason`** so the
`Record` in `matchReasons.ts` reads one-to-one and a reviewer can check coverage
by eye. Nine reasons, nine labels — a reason with no label renders its raw key.

| Key | en | cs |
|---|---|---|
| `bank_reason_noVs` | No variable symbol | Bez variabilního symbolu |
| `bank_reason_noVsHintGuess` | The payment has no VS. By the name this looks like {member} (VS {vs}). | Platba nemá VS. Podle jména to vypadá na {member} (VS {vs}). |
| `bank_reason_noVsHintNone` | The payment has no VS and we don't recognise the name. | Platba nemá VS a podle jména nikoho nepoznáváme. |
| `bank_reason_noMemberForVs` | The VS belongs to nobody | VS nikomu nepatří |
| `bank_reason_noMemberForVsHint` | No member in the team has VS {vs}. | VS {vs} nemá v týmu žádný člen. |
| `bank_reason_ambiguousMember` | Several members share this VS | VS má víc členů |
| `bank_reason_ambiguousMemberHint` | More than one member has VS {vs}. Fix it in the member list. | VS {vs} má přiřazený víc než jeden člen. Opravte to v seznamu členů. |
| `bank_reason_amountMismatchUnder` | Lower than the fee | Nižší částka, než je předpis |
| `bank_reason_amountMismatchUnderHint` | {member} has a fee of {due}, {paid} arrived. {diff} is missing. | {member} má předpis {due}, přišlo {paid}. Chybí {diff}. |
| `bank_reason_overpayment` | Higher than the fee | Vyšší částka, než je předpis |
| `bank_reason_overpaymentHint` | {member} has a fee of {due}, {paid} arrived. Overpayment {diff}. | {member} má předpis {due}, přišlo {paid}. Přeplatek {diff}. |
| `bank_reason_ambiguousMultipleExact` | Matches several fees exactly | Sedí na víc předpisů |
| `bank_reason_ambiguousMultipleExactHint` | {amount} matches {count} of {member}'s fees exactly. Which one is it? | Částka {amount} přesně odpovídá {count} předpisům člena {member}. Ke kterému platba patří? |
| `bank_reason_ambiguousMultipleOpen` | Several open fees | Víc otevřených předpisů |
| `bank_reason_ambiguousMultipleOpenHint` | {member} has {count} open fees and the amount matches none of them. Split it? | {member} má {count} otevřených předpisů a částka nesedí ani na jeden. Rozdělit? |
| `bank_reason_noOpenAssignment` | Nothing open for this member | Člen nemá nic otevřeného |
| `bank_reason_noOpenAssignmentHint` | {member} has no open fee. | {member} nemá žádný otevřený předpis. |
| `bank_reason_duplicateHint` | This looks like a duplicate of the payment from {date}. | Vypadá to na duplikát platby z {date}. |
| `bank_reason_duplicateShowOriginal` | Show the original | Zobrazit původní |
| `bank_reason_currencyMismatch` | Different currency from the fee | Jiná měna, než je předpis |
| `bank_reason_currencyMismatchHint` | The payment is in {txCurrency}, {member}'s fees are in {feeCurrency}. | Platba je v {txCurrency}, předpisy člena {member} jsou v {feeCurrency}. |
| `bank_action_assign` | Assign | Přiřadit |
| `bank_action_more` | More actions for the payment of {amount} on {date} | Další akce pro platbu {amount} z {date} |
| `bank_action_detail` | Show movement detail | Zobrazit detail pohybu |
| `bank_action_otherIncome` | Mark as other income | Označit jako jiný příjem |
| `bank_action_ignore` | Ignore | Ignorovat |
| `bank_action_copyDetails` | Copy details | Zkopírovat údaje |
| `bank_resolve_title` | Assign payment | Přiřadit platbu |
| `bank_resolve_modeAssign` | Assign to a member | Přiřadit členovi |
| `bank_resolve_modeSplit` | Split across several fees | Rozdělit mezi víc předpisů |
| `bank_resolve_modeOther` | Other club income (not a membership fee) | Jiný příjem klubu (ne členský příspěvek) |
| `bank_resolve_modeIgnore` | Doesn't belong to any fee | Nepatří k žádnému předpisu |
| `bank_resolve_ignoreDuplicateReason` | Duplicate of the payment from {date} | Duplikát platby z {date} |
| `bank_resolve_member` | Member | Člen |
| `bank_resolve_fee` | Fee | Předpis |
| `bank_resolve_feeOption` | {fee} · {remaining} remaining | {fee} · zbývá {remaining} |
| `bank_resolve_underTitle` | The amount is lower than the fee. What now? | Částka je nižší než předpis. Co s tím? |
| `bank_resolve_underPartial` | Partial payment — {diff} remains, the fee stays open | Částečná úhrada — zbývá {diff}, předpis zůstane otevřený |
| `bank_resolve_underWaive` | Partial payment, and waive the rest | Částečná úhrada a zbytek odpustit |
| `bank_resolve_underWaiveHint` | After saving we'll open "Waive fee" for the remaining {diff}. | Po uložení otevřeme „Odpustit předpis" na zbývajících {diff}. |
| `bank_resolve_underWaiveReason` | Remainder after the partial payment of {date} | Zbytek po částečné úhradě z {date} |
| `bank_resolve_overTitle` | The amount is higher than the fee. What now? | Částka je vyšší než předpis. Co s tím? |
| `bank_resolve_overFull` | Assign the whole {amount} | Přiřadit celých {amount} |
| `bank_resolve_overFullHint` | The fee "{fee}" will end up {diff} overpaid. We'll write that into the payment note. | Na předpisu „{fee}" vznikne přeplatek {diff}. Zapíšeme ho do poznámky k platbě. |
| `bank_resolve_overFullNote` | Overpayment of {diff} against the fee {fee}. | Přeplatek {diff} oproti předpisu {fee}. |
| `bank_resolve_overSplit` | Split — assign the remainder to another fee | Rozdělit — zbytek přiřadit na další předpis |
| `bank_resolve_overChoose` | Choose what should happen to the overpayment. | Vyberte, co se má stát s přeplatkem. |
| `bank_resolve_allocationLimit` | {outstanding} is left on this fee. Anything more can only be assigned as an overpayment. | Na tento předpis zbývá {outstanding}. Víc půjde přiřadit jen jako přeplatek. |
| `bank_resolve_splitAdd` | Add a fee | Přidat předpis |
| `bank_resolve_splitBalanced` | Split {allocated} of {total} | Rozděleno {allocated} z {total} |
| `bank_resolve_splitRemaining` | {remaining} left to split | Zbývá rozdělit {remaining} |
| `bank_resolve_otherDescription` | Description | Popis |
| `bank_resolve_ignoreReason` | Reason | Důvod |
| `bank_resolve_note` | Note (optional) | Poznámka (nepovinná) |
| `bank_resolve_submit` | Assign | Přiřadit |
| `bank_resolve_success` | Payment assigned. | Platba přiřazena. |
| `bank_resolve_error` | The payment could not be assigned. | Platbu se nepodařilo přiřadit. |
| `bank_bulk_regionLabel` | Actions for the selected payments | Akce pro vybrané platby |
| `bank_bulk_selected` | {count} selected | {count} vybrané |
| `bank_bulk_partial` | Processed {done} of {total} payments. {failed} failed — try them one by one. | Zpracováno {done} z {total} plateb. {failed} se nepodařilo — zkuste je jednotlivě. |
| `bank_select_row` | Select the payment of {amount} on {date} | Vybrat platbu {amount} z {date} |
| `bank_select_all` | Select | Vybrat |
| `bank_unmatch_title` | Cancel the payment assignment | Zrušit přiřazení platby |
| `bank_unmatch_body` | The payment of {amount} from {date} is assigned to the fee "{fee}" of {member}. | Platba {amount} z {date} je přiřazená k předpisu „{fee}" člena {member}. |
| `bank_unmatch_effect` | Cancelling returns the fee to unpaid and the payment to the matching queue. | Zrušením se předpis vrátí mezi nezaplacené a platba se vrátí do fronty k přiřazení. |
| `bank_unmatch_audit` | The record is not deleted. It stays in the history marked as cancelled, with your name, the time and the reason — for the audit trail. | Záznam se nemaže. Zůstane v historii označený jako zrušený, s vaším jménem, časem a důvodem — kvůli auditu. |
| `bank_unmatch_reason` | Reason for cancelling | Důvod zrušení |
| `bank_unmatch_reasonRequired` | Give a reason — it stays in the audit trail. | Uveďte důvod — zůstane v auditní stopě. |
| `bank_unmatch_confirm` | Cancel the assignment | Zrušit přiřazení |
| `bank_unmatch_success` | The assignment was cancelled. | Přiřazení bylo zrušeno. |
| `bank_returned_badge` | Returned for matching | Vráceno k přiřazení |
| `bank_returned_link` | Show the cancelled assignment | Zobrazit zrušené přiřazení |
| `bank_matched_filterAll` | All | Vše |
| `bank_matched_filterAuto` | Matched automatically | Přiřazeno automaticky |
| `bank_matched_filterManual` | Matched by hand | Přiřazeno ručně |
| `bank_matched_filterOther` | Other income | Jiný příjem |
| `bank_matched_filterIgnored` | Ignored | Ignorováno |
| `bank_matched_filterVoided` | Cancelled | Zrušeno |
| `bank_matched_auto` | Automatically · VS {vs} | Automaticky · VS {vs} |
| `bank_matched_evidence` | Matched automatically on {date} by variable symbol {vs} → {member} → fee {fee} ({amount}). | Spárováno automaticky {date} podle variabilního symbolu {vs} → {member} → předpis {fee} ({amount}). |
| `bank_matched_evidenceExact` | The amount matches exactly. | Částka odpovídá přesně. |
| `bank_matched_toggle` | Show matching detail | Zobrazit detail přiřazení |
| `bank_empty_title` | All done. Every payment is matched. | Hotovo. Všechny platby jsou přiřazené. |
| `bank_empty_stats` | In the last 30 days {auto} of {total} payments matched automatically. | Za posledních 30 dní se automaticky spárovalo {auto} z {total} plateb. |
| `bank_empty_lastSync` | Last import from the bank: {time}. | Poslední načtení z banky: {time}. |
| `bank_empty_showMatched` | Show matched payments | Zobrazit přiřazené platby |
| `bank_empty_noResults` | No movement matches these filters. | Žádný pohyb neodpovídá filtrům. |
| `bank_notConnectedTitle` | The bank isn't connected yet. | Banka zatím není propojená. |
| `bank_notConnectedCta` | Connect the account | Propojit účet |
| `bank_oldMovementsHint` | Movements older than 90 days can't be fetched from Fio without unlocking the history. | Pohyby starší než 90 dní už Fio nevydá bez odemčení historie. |

### 10.4 Variable symbol (`members_vs_*`, `validation_*`)

| Key | en | cs |
|---|---|---|
| `members_vs_column` | VS | VS |
| `members_vs_label` | Variable symbol | Variabilní symbol |
| `members_vs_help` | Used as the VS on fee payments. Must be unique within the team. | Použije se jako VS u plateb příspěvků. Musí být jedinečný v rámci týmu. |
| `members_vs_missing` | Missing | Chybí |
| `members_vs_missingAria` | This member has no variable symbol | Tento člen nemá variabilní symbol |
| `members_vs_bannerTitle` | {count} members have no variable symbol. | {count} členů nemá variabilní symbol. |
| `members_vs_bannerBody` | Their bank payments can't be matched automatically — you'd have to assign them by hand. | Jejich platby z banky nepůjde spárovat automaticky — budete je muset přiřazovat ručně. |
| `members_vs_bannerShowOnly` | Show only these | Zobrazit jen tyto |
| `members_vs_bannerAssign` | Assign symbols automatically | Přidělit symboly automaticky |
| `members_vs_filterMissing` | Without a VS | Bez VS |
| `members_vs_assignTitle` | Assign variable symbols | Přidělit variabilní symboly |
| `members_vs_assignBody` | We'll fill in symbols for {count} members who don't have one. Nobody else is affected. | Doplníme symboly {count} členům, kteří je nemají. Ostatních se to nedotkne. |
| `members_vs_assignNote` | Symbols can be changed later for each member individually. | Symboly jdou později změnit u každého člena zvlášť. |
| `members_vs_assignConfirm` | Assign | Přidělit |
| `members_vs_assignSuccess` | Variable symbols assigned. | Variabilní symboly přiděleny. |
| `members_vs_duplicate` | {member} already has this symbol. | Tento symbol už má {member}. |
| `members_vs_duplicateShow` | Show member | Zobrazit člena |
| `validation_variableSymbol` | The variable symbol may only contain digits (10 at most). | Variabilní symbol smí obsahovat jen číslice (nejvýš 10). |

### 10.5 Export (`bank_export_*`)

| Key | en | cs |
|---|---|---|
| `bank_export_title` | Export of bank movements | Export bankovních pohybů |
| `bank_export_description` | Export the account movements for a chosen period — as evidence for a grant report or for your accountant. | Vyexportujte pohyby na účtu za zvolené období — jako podklad pro vyúčtování dotace nebo pro účetnictví. |
| `bank_export_period` | Period | Období |
| `bank_export_periodLastYear` | Last year | Minulý rok |
| `bank_export_from` | From | Od |
| `bank_export_to` | To | Do |
| `bank_export_format` | Format | Formát |
| `bank_export_formatCsv` | CSV (for Excel) | CSV (pro Excel) |
| `bank_export_formatPdf` | PDF (for the authority) | PDF (pro úřad) |
| `bank_export_docLabel` | Document label (optional) | Označení dokumentu (nepovinné) |
| `bank_export_docLabelHelp` | Printed in the document header. | Vytiskne se v hlavičce dokumentu. |
| `bank_export_docLabelPlaceholder` | Contract no. S/12/2026/0109 | Smlouva č. S/12/2026/0109 |
| `bank_export_summary` | There are {count} movements in the selected period. | Ve vybraném období je {count} pohybů. |
| `bank_export_summaryTotals` | Opening balance {opening} · Income {income} · Expenses {expenses} · Closing balance {closing} | Počáteční zůstatek {opening} · Příjmy {income} · Výdaje {expenses} · Konečný zůstatek {closing} |
| `bank_export_covered` | The whole period has been imported from the bank. | Celé období je načtené z banky. |
| `bank_export_gapTitle` | The statement wouldn't be complete. | Výpis by nebyl úplný. |
| `bank_export_gapBody` | These periods haven't been imported from the bank: | Z banky nejsou načtené pohyby za: |
| `bank_export_gapItem` | {from} – {to} | {from} – {to} |
| `bank_export_gapMissingNote` | Those periods would be missing from the document. | V dokumentu by tato období chyběla. |
| `bank_export_gapMore` | …and {n} more periods | …a další {n} období |
| `bank_export_gapBackfill` | Import the missing period | Načíst chybějící období |
| `bank_export_gapNarrow` | Export only from {date} | Exportovat jen od {date} |
| `bank_export_gapAnyway` | Export with a warning | Exportovat s upozorněním |
| `bank_export_gapStamp` | Warning: these periods were not imported from the bank: {periods}. Movements for them are missing from this statement. | Upozornění: z banky nebyla načtena tato období: {periods}. Pohyby za tato období ve výpisu chybí. |
| `bank_export_gapCsvNote` | The warning is printed in the PDF, not in the CSV. | Upozornění se do CSV nevkládá; do PDF ano. |
| `bank_export_nothingIngested` | No movements have been imported from the bank yet. | Z banky zatím nejsou načtené žádné pohyby. |
| `bank_export_missingClubDetails` | Fill in the club's IČO and registered address in the bank settings. They're expected on a document for the authority. | Doplňte IČO a sídlo klubu v nastavení banky. Na dokumentu pro úřad se očekávají. |
| `bank_export_openSettings` | Open settings | Otevřít nastavení |
| `bank_export_downloadCsv` | Download CSV | Stáhnout CSV |
| `bank_export_downloadPdf` | Download PDF | Stáhnout PDF |
| `bank_export_preparing` | Preparing the file… | Připravuji soubor… |
| `bank_export_preparingLong` | Preparing the file… for longer periods this can take up to a minute. | Připravuji soubor… u delších období to může trvat i minutu. |
| `bank_export_done` | File downloaded. | Soubor stažen. |
| `bank_export_downloaded` | Downloaded {filename}. | Stažen soubor {filename}. |
| `bank_export_again` | Download again | Stáhnout znovu |
| `bank_export_ready` | The file is ready. | Soubor je připravený. |
| `bank_export_readyExpiry` | The link is valid for 15 minutes. | Odkaz platí 15 minut. |
| `bank_export_emptyRange` | There are no movements in the selected period. Try a different period. | Ve vybraném období nejsou žádné pohyby. Zkuste jiné období. |
| `bank_export_error` | The file could not be created. Please try again. | Soubor se nepodařilo vytvořit. Zkuste to prosím znovu. |
| `bank_export_retry` | Try again | Zkusit znovu |
| `bank_export_csvHelp` | The file is ready for Excel in Czech — semicolon delimiter and a decimal comma. Just open it with a double click. In Google Sheets, choose the "semicolon" delimiter on import. | Soubor je připravený pro Excel v češtině — oddělovač je středník a desetinná čárka. Stačí ho otevřít dvojklikem. V Google Sheets zvolte při importu oddělovač „středník". |
| `bank_export_csvLeadingZeros` | In Excel, variable symbols and account numbers can lose their leading zeros (`0123456789` opens as `123456789`). **Use the PDF for the authority — there they're correct.** If you need the CSV, open it via Data → From Text/CSV and set the "Variable symbol" column type to Text. | V Excelu mohou variabilní symboly a čísla účtů ztratit úvodní nuly (`0123456789` se otevře jako `123456789`). **Pro úřad použijte PDF — tam jsou správně.** Když potřebujete CSV, otevřete ho přes Data → Z textu/CSV a sloupci „Variabilní symbol" nastavte typ Text. |

**PDF document strings** (rendered server-side, still i18n keys —
`bank_pdf_*`): `title` „VÝPIS BANKOVNÍCH POHYBŮ", `account` „Číslo účtu",
`period` „Období", `colDate` „Datum", `colCounterparty` „Protistrana",
`colAccount` „Účet protistrany", `colVs` „Variabilní symbol",
`colMessage` „Zpráva pro příjemce", `colAmount` „Částka",
`totalCount` „Počet pohybů", `totalIncome` „Příjmy celkem",
`totalExpenses` „Výdaje celkem", `openingBalance` „Počáteční zůstatek k {date}",
`closingBalance` „Konečný zůstatek k {date}", `registeredId` „IČO",
`registeredAddress` „Sídlo", `bankName` „Fio banka, a.s.",
`generatedAt` „Vygenerováno: {date} v {time}", `page` „Strana {n} / {total}",
and `gapStamp` (the §7.2.1 b warning, reusing `bank_export_gapStamp`).

### 10.6 Player-facing QR — web (`my_payments_qr_*`)

| Key | en | cs |
|---|---|---|
| `my_payments_qr_toggle` | Pay | Zaplatit |
| `my_payments_qr_toggleAria` | Show payment details and QR code | Zobrazit údaje k platbě a QR kód |
| `my_payments_qr_account` | Account | Účet |
| `my_payments_qr_amount` | Amount | Částka |
| `my_payments_qr_vs` | Variable symbol | Variabilní symbol |
| `my_payments_qr_message` | Message for the recipient | Zpráva pro příjemce |
| `my_payments_qr_dueDate` | Due date | Splatnost |
| `my_payments_qr_instructions` | Scan the QR code in your banking app. The variable symbol is required — without it we can't match the payment. | Naskenujte QR kód v bankovní aplikaci. Variabilní symbol je potřeba — bez něj platbu nespárujeme. |
| `my_payments_qr_mobileCaption` | QR code for scanning from another device. | QR kód pro naskenování z jiného zařízení. |
| `my_payments_qr_copyAll` | Copy all details | Zkopírovat všechny údaje |
| `my_payments_qr_copyAccount` | Copy the account number | Zkopírovat číslo účtu |
| `my_payments_qr_copyAmount` | Copy the amount | Zkopírovat částku |
| `my_payments_qr_copyVs` | Copy the variable symbol | Zkopírovat variabilní symbol |
| `my_payments_qr_copyMessage` | Copy the message | Zkopírovat zprávu |
| `my_payments_qr_copied` | Copied | Zkopírováno |
| `my_payments_qr_alt` | QR code for a payment of {amount}, variable symbol {vs} | QR kód pro platbu {amount}, variabilní symbol {vs} |
| `my_payments_qr_error` | The QR code could not be created. The payment details are next to it. | QR kód se nepodařilo vytvořit. Údaje k platbě najdete vedle. |
| `my_payments_qr_noAccount` | The club doesn't have a bank account set up yet. Get in touch with the treasurer. | Klub zatím nemá nastavený bankovní účet. Ozvěte se pokladníkovi. |
| `my_payments_qr_noVs` | You don't have a variable symbol assigned. Get in touch with the treasurer — without it the payment can't be matched. | Nemáte přidělený variabilní symbol. Ozvěte se pokladníkovi — bez něj nejde platbu spárovat. |

### 10.7 Discord (`bot_*` — redeploy-only)

| Key | en | cs |
|---|---|---|
**These extend the existing payment-reminder embed** (§6.4), which is why they
are `bot_payment_reminder_*` and not a new `bot_payment_qr_*` family. The five
`title` / `description` strings currently hardcoded in English inside
`buildPaymentReminderEmbed.ts:17-62` move here at the same time — that file is
the last English-only user-facing surface in the bot.

| Key | en | cs |
|---|---|---|
| `bot_payment_reminder_amount` | Amount | Částka |
| `bot_payment_reminder_due` | Due date | Splatnost |
| `bot_payment_reminder_vs` | Variable symbol | Variabilní symbol |
| `bot_payment_reminder_outstanding` | Remaining | Zbývá |
| `bot_payment_reminder_qrHint` | The quickest way is to scan the QR code in your banking app. | Nejrychlejší je naskenovat QR kód v bankovní aplikaci. |
| `bot_payment_reminder_fallbackTitle` | Can't scan it? Enter it by hand: | Nejde naskenovat? Zadejte ručně: |
| `bot_payment_reminder_fallbackAccount` | Account | Účet |
| `bot_payment_reminder_fallbackAmount` | Amount | Částka |
| `bot_payment_reminder_fallbackVs` | VS | VS |
| `bot_payment_reminder_fallbackMessage` | Message | Zpráva |
| `bot_payment_reminder_vsWarning` | ⚠️ Without the variable symbol we can't match your payment. | ⚠️ Bez variabilního symbolu platbu nespárujeme. |
| `bot_payment_reminder_button` | My payments | Moje platby |
| `bot_payment_reminder_dueIn3dTitle` | Heads up — payment due soon | Připomínka — blíží se splatnost |
| `bot_payment_reminder_dueTodayTitle` | Payment due today | Dnes je splatnost |
| `bot_payment_reminder_overdueTitle` | Payment overdue | Platba po splatnosti |
| `bot_payment_reminder_assignedTitle` | A new fee for you | Nový předpis k úhradě |
| `bot_fio_tokenExpiring_title` | ⚠️ The bank token expires in {days} days | ⚠️ Token k bance vyprší za {days} dní |
| `bot_fio_tokenExpiring_body` | Once it expires, payments stop being imported from the club account. Just sign in to Fio Internetbanking or Smartbanking — that renews the token. Or create a new one and paste it into the team settings in Sideline. | Po vypršení se přestanou načítat platby z účtu klubu. Stačí se přihlásit do Internetbankingu nebo Smartbankingu Fio — tím se token prodlouží. Nebo vytvořte nový a vložte ho v Sideline do nastavení týmu. |
| `bot_fio_tokenExpiring_button` | Open settings | Otevřít nastavení |
| `bot_fio_digest_title` | 🏦 Payments waiting to be matched | 🏦 Platby čekají na přiřazení |
| `bot_fio_digest_body` | {count} payments ({amount}) are waiting in the queue. | Ve frontě čeká {count} plateb ({amount}). |
| `bot_fio_digest_button` | Open matching | Otevřít přiřazování |

---

## 11. Open questions for the architect

Five of the eight questions in the first draft are now answered by the
implementation plan and by the review; they are kept below with their answers so
nobody re-opens them.

**Q1 — Sidebar count badge.** `NavItem.needsAttention` is a boolean dot
(`AppSidebar.tsx:68`). Showing "7" would need a count on `Auth.UserTeam`, which
is loaded on every page. Worth it, or ship the dot?
*Design default: ship the dot.* **Still open.**

**Q2 — Which "member number" is the variable symbol?** **Answered:** a new
`team_members.variable_symbol` (`TEXT`, digit-checked, unique per team,
nullable), matched on a leading-zero-normalised form (plan D3). Not
`jersey_number`. §5 stands as written.

**Q3 — Who computes the connection-status literal?** **Answered: the server**
(`bankSyncStatus.ts`), emitted as `BankSyncStatusCode`. §2.5 gives the mapping
from the plan's D11 conditions onto the six exclusive states plus the additive
expiry banner, including the 3-failures-and-6-hours threshold and the two
`invalid` copy variants.

**Q4 — Does the queue keep transactions that were ignored?** **Answered (closed): yes.**
`match_state = 'ignored'` with a required reason and the ignoring user, reversible
via unmatch, and **ignored rows stay in the export** — they are still bank
movements the auditor must see. §3.10's `Ignorováno` filter is correct.

**Q5 — Overpayment semantics.** **Answered (user).** On an explicit opt-in the
treasurer allocates the **full transaction amount**, the assignment ends up with
`paid_minor > amount_minor`, the overage is recorded in the **payment note**, and
the row reaches `matched` and leaves the queue. No residue state, no credit
balance. §3.6.1 specifies the opt-in, the consequence sentence shown before
confirming, the editable note, and the rule that nothing downstream may render a
negative outstanding amount.

**Q6 — Where do the `Jiný příjem` rows land?** **Answered (closed):** a
`resolution_kind` on the existing resolve/ignore path — **no separate
`other-income` endpoint** — with two values, `other_income` and `not_relevant`.
That is §11A item 1's recommendation adopted: „Ignorováno" next to a 120 000 Kč
municipal grant is the defect, and a label fixes it. The third value
(`duplicate`) was **cut**; see §3.5 note 2.

**Q7 — Export job shape.** §7.3 designs the synchronous download as primary and
an async "ready" card as a fallback. If a 5-year PDF is expected to exceed the
request timeout, say so now and the async state becomes primary — the UI is
already specified for it. **Still open.**

**Q8 — QR image lifetime.** **Answered:** rendered server-side on demand
(`QrRenderer` + `Finance/GetPaymentQr`), never stored. Consequence for the web is
in §6.7 — it must be an authenticated blob fetch, **not** an `<img src>`, because
this app authenticates with a Bearer token that an image request cannot carry.

**Q9 — Does `PaymentReminderKind` gain an `assigned` kind?** **Answered: yes.**
Fired once at assignment creation, carrying the QR, with a neutral
first-contact title („Nový předpis — zaplať QR kódem", `COLOR_BLUE`, no urgency)
— it is the first message about a fee, not a nag. A seeding migration prevents a
backlog blast on first deploy.

**Q10 — New: IČO and sídlo as config fields.** (§7.4.) The PDF is grant evidence
submitted under the club's legal identity and a Czech grant annex is expected to
carry the recipient's IČO; the config model holds only `recipient_name`. Two
nullable columns and two optional inputs. *Design recommendation: add them, and
degrade gracefully when empty rather than blocking the export.*

---

## 11A. Scope calls — features this spec designs that the plan does not task

Flagged honestly, with a verdict each, so they can be cut deliberately rather
than discovered missing in January 2027.

1. **„Jiný příjem klubu" as a resolve mode — keep, but as copy, not a new write
   path.** *Essential-ish.* The club's largest single movements are the
   municipal grant and hall-rental refunds, and the treasurer must be able to
   account for them. But it does **not** need an endpoint: it is the existing
   `ignore` (required reason, stays in the export, reversible) with a category
   picker in front of it and a different word on the badge. Rendering „Ignorováno"
   against a 120 000 Kč grant in an audit export is the actual defect here, and
   it is fixed by a label. **Cost: near zero. Recommend keep.**
2. **„Beru jako vyrovnané v plné výši" — already rewritten to need nothing new.**
   §3.6 rule 3 hands off to the existing `WaiveAssignmentDialog` instead of
   writing `fee_assignments.stored_status` itself. **Cost: a pre-filled reason
   prop. Recommend keep.**
3. **Bulk ignore / bulk other-income — keep.** A loop over an endpoint that
   already exists, with one shared reason collected once. It matters exactly once
   per club and matters a lot: the first backfill can import a year of movements,
   and resolving 200 historical rows one dialog at a time is how a treasurer
   abandons the feature in week one. **Recommend keep.** (Bulk *assign* stays
   cut — §3.8.)
4. **Auto-assign variable symbols, preview-then-apply, `{year}{seq3}` — keep, and
   sequence it early.** *This one is closest to essential.* Until members have
   symbols, **nothing auto-matches**, so a club onboarding 30 members gets zero
   value from the entire feature until someone has visited 30 member pages. It
   needs one endpoint that returns the proposed pairs and one that applies them.
   **If it is cut**, the roster banner must at minimum deep-link member-by-member
   (`?focus=vs`) and say how many are left — otherwise the gap is invisible work.
5. **`possible_duplicate` — already downgraded.** Not a reason literal any more;
   a hint on `no_open_assignment` computed from one indexed lookup (§3.5 note 2).
   **Cost: one query. Recommend keep; cutting it costs only the hint sentence.**
6. **`currency_mismatch` label — not optional.** The engine can emit it today
   (Step 0 guard). Without copy it renders a raw key. **Must ship.**

---

## 12. What changed in this revision

Twelve rulings from the adversarial review against
`.work-plans/fio-transaction-matching.md`. Recorded so a reader of the earlier
draft can diff, and so the reasoning is not lost.

| # | Ruling | Where |
|---|---|---|
| 1 | Under-payments are **queued**, not auto-matched — attribution risk beats convenience | §3.5 (new `amount_mismatch_under` row + rationale) |
| 2 | An over-long SPAYD `MSG` is **budgeted and truncated**, never rejected — a rejected payload means no QR at all | §6.3 |
| 3 | Backfill is a bounded in-request loop, so the 10-minute unlock flow is implementable as drawn | §2.5 F (unchanged, now confirmed) |
| 4 | Bank ledger is gated on **`finance:record_payments`**, not `finance:view` — Captains would otherwise see every counterparty's name and account | §3.2 (unchanged, now confirmed) |
| 5 | The token-expiry Discord DM **ships with the feature** | §2.5 E, §6.5 |
| 6 | The **server** computes the status literal; six exclusive states, `expiring_soon` additive; `token_expired`/`token_rejected`/`token_expired_by_date` collapse into one `invalid` with two copy variants | §2.5 (rewritten) |
| 7 | Aggregates (`BankSyncSummaryView`) are being added, so the KPIs have something to render | §3.3, §7.2 (unchanged) |
| 8 | **Match-reason literals are the plan's**, imported from `BankTransactionMatchReason`; four previously unlabelled reasons gained Czech copy; `non_member_payment` folded onto `no_vs`/`no_member_for_vs`; `currency_mismatch` labelled | §3.5, §10.3 (rewritten) |
| 9 | SPAYD/IBAN/transliteration live in **`@sideline/domain`**, not `web/src/lib/finance/`; the modulo-11 check moves into `CzIban.ts` | §2.6, §6.2, §9.2 |
| 10 | **One** QR Discord message: the existing payment reminder, extended — not a second DM family | §6.4, §9.3, §10.7 (rewritten) |
| 11 | Bank-reversal machinery **cut** — `reversal_pending`, pin-to-top and the `↩` badge all go | §3.9.1 (new), §3.5 |
| 12 | The 10-second toast undo is **dropped**; the mandatory void reason stays | §3.9, §10.3 |
| +13 | PDF header needs IČO and sídlo, which do not exist yet — asked for, with graceful degradation | §2.6, §7.4, §10.2 |
| +14 | Export **completeness** states: a range starting before the earliest ingested movement warns, narrows, or stamps the PDF; opening/closing balances added | §7.2.1, §7.4 |
| +15 | Status copy must not cry wolf: new `sync_failing` (below threshold, no action) and `misconfigured` (our key problem — never "replace your token") | §2.5 D′, §2.5 G |
| +16 | Overpayment must be able to leave the queue; consequence copy specified for both candidate mechanisms | §3.6.1 |
| +17 | Un-tasked features flagged with verdicts | §11A |

### 12.1 Second review pass

| # | Ruling | Where |
|---|---|---|
| R2-1 | **Won:** the additive `expiringSoon` banner + the `sync_failing` literal are adopted by the plan; the API gains `expiringSoon` / `tokenExpiresAt` so the banner has something to key off | §2.5 (unchanged) |
| R2-2 | **Won:** no comment block in the CSV — the BOM would make Excel read it as the header row; the gap list travels as an `X-Export-Coverage-Gaps` header | §7.2.1 |
| R2-3 | **Lost:** `earliestIngestedOn` replaced by `coverageGaps: [{from,to}]` — a scalar misses an interior outage and prints "complete" over a hole | §7.2.1 (rewritten) |
| R2-4 | **Fixed:** overpayment now allocates the **full** amount on explicit opt-in, overage recorded in the payment note, row reaches `matched`. The "leave it unallocated" mechanism and the "never round up" instruction are both gone | §3.5, §3.6, §3.6.1, §10.3, §11 Q5 |
| R2-5 | **Fixed:** `resolution_kind` has two values; the duplicate hint resolves as `not_relevant` with a pre-filled reason. No duplicate state, chip, badge or count anywhere | §3.5 note 2, §3.7, §3.8, §10.3 |
| R2-6 | **Fixed:** the CSV "quoted as text" claim was false and is deleted; the leading-zero loss now has explicit warning copy plus the Data → Z textu/CSV instruction, and the PDF is named as the authoritative artefact | §7.5, §10.5 |
| R2-7 | **Fixed:** file names re-aligned to the plan (`FioBankCard`, `fioBankForm`, `FioStatusBlock`, `FioStatusBadge`, `handleBankTokenExpiring`, and `buildPaymentReminderEmbed` under `src/rcp/finance/`, not `src/rest/`) | §2.2, §2.8, §9.2, §9.3 |
| R2-8 | **New:** `useQrObjectUrl` fully specified — cancellation flag, local `objectUrl`, deps without `url`, plus the two tests that catch the StrictMode leak and the wrong-QR race | §9.2.1 |
| R2-9 | **Fixed:** nine reasons in the a11y table, `no_open_assignment` cites case G only, Q4/Q5/Q6 marked answered, token-expiry cadence aligned to the plan's T−14 / T−7 / T−1 (banner escalates at T−7, the same day the second DM lands) | §2.5 E, §3.5, §6.5, §8.1, §11 |

**Two findings from the first pass that the review did not ask for**, both of
which would have shipped broken:

* **The QR cannot be a bare `<img src>`** — web auth is a Bearer token in
  `localStorage` (`src/lib/token.ts`), which an image request cannot send, so the
  endpoint would 401 for every player. The fix is the existing blob-download flow
  (`EmailDetailPage.tsx:184-225`) plus `revokeObjectURL` on unmount. §6.7.
* **Riding the existing reminder means the QR arrives three days before the due
  date**, i.e. weeks of silence for a fee created in advance. One new
  `PaymentReminderKind` fixes it with no new pipeline. §6.4. **Adopted** — the
  plan now carries an `assigned` kind, a neutral first-contact arm in
  `copyForKind`, and a seeding migration so existing assignments are not blasted
  on first deploy.
