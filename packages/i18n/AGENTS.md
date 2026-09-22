# i18n Package (`@sideline/i18n`)

Translation system using Paraglide.js with localStorage and cookie strategies.

## Overview

This package owns the **translation message catalogue** for the monorepo. The actual locale-persistence strategy (`localStorage` / `cookie`) is configured in Paraglide via `project.inlang/settings.json` and consumed by `applications/web/`. See `applications/web/AGENTS.md` for translation file conventions, adding new translations, the locale persistence model, and the `tr()` override helper that wraps the compiled messages on the web side.

## Strategies

- **localStorage** — client-side locale persistence (manual language choice)
- **cookie** — server-side locale detection
- **preferredLanguage** — detects browser language via `navigator.languages` (first visit)
- **baseLocale** — fallback to English when no other strategy resolves

## Build Output (`dist/`)

`pnpm --filter @sideline/i18n build` runs Paraglide compile, then `scripts/pack.js` emits a `dist/` layout that downstream packages import. The directory is gitignored.

| Subpath | Purpose | Consumers |
|---------|---------|-----------|
| `./messages` | Paraglide-generated typed message functions (`m.foo()`). One named export per key. | `applications/bot/**` (direct import) and `applications/web/src/lib/translations.ts` (indirectly via `./registry`). |
| `./runtime` | Paraglide runtime (`getLocale`, `setLocale`, strategy chain). | All apps that need to read/write the active locale. |
| `./registry` | Reflection layer over `./messages` — see below. | `applications/web/src/lib/translations.ts` (`tr()` lookup), `applications/server/src/api/translations.ts` (known-key validation on import). |
| `./raw/en.json` | Verbatim copy of `messages/en.json` from this package, copied by `pack.js`. | Server `/api/translations/export.json` handler (admin downloads merged defaults + overrides). |
| `./raw/cs.json` | Verbatim copy of `messages/cs.json`. | Same as above. |

### `./registry` Exports

`scripts/pack.js` emits `dist/registry.js` + `dist/registry.d.ts` **after** Paraglide compile by re-exporting `./messages.js` as a typed map:

| Export | Type | Purpose |
|--------|------|---------|
| `messagesByKey` | `Record<string, MessageFn>` | Lookup table used by `tr(key, params)` on the web to call a message function without static `import * as m`. |
| `messageKeys` | `readonly string[]` | The full enumerated key set — used to validate admin imports and list keys in the `/admin/translations` UI. |
| `TranslationKey` (type) | `keyof typeof m` | Compile-time-safe union of every translation key. Use this instead of a bare `string` when a function should only accept known keys. |

`MessageFn` signature: `(inputs?: Record<string, unknown>, options?: { locale?: 'en' | 'cs' }) => string`.

## Translation Value Conventions

### Category / Kind Labels Bake In Their Emoji

Translation keys that label a discriminator (kind, category, status) and resolve to a short user-visible noun may bake the emoji into the value itself. Reference: `weeklyChallenge_embed_kind_throwing` → `"🥏 Házecí"` / `"🥏 Throwing"`, `weeklyChallenge_embed_kind_sport` → `"🏃 Sportovní"` / `"🏃 Sport"`. The emoji is part of the localized value, not a separate constant.

Rules:

1. **Bot embed builders and web components MUST NOT prefix another emoji** when consuming such keys. A `KIND_EMOJI: Record<Kind, string>` lookup table at the call site doubles the emoji and is forbidden — read the key as-is and render it.
2. **When adding a new discriminator-label key**, decide once at key-creation time whether the emoji belongs in the value (preferred for short labels) or stays at the call site (preferred when the same label is reused in plain-text contexts without emoji). Mixing both for the same key family is forbidden — every `<feature>_embed_kind_*` sibling must agree.
3. **English and Czech values must agree on the emoji.** If `cs.json` puts `🥏` at the start, `en.json` must put the same `🥏` at the start. Drift breaks visual parity across locales.

### Czech Tone and Vocabulary (`messages/cs.json`)

Czech has a formal/informal split English does not, and the catalogue serves two audiences from one file. Get this wrong and the tone flips mid-product.

| Surface | Form | Reference key |
|---------|------|---------------|
| Bot strings shown to a member (embeds, ephemerals, buttons, modals, channel topics) | **tykání** (informal "ty": *dokonči*, *zkus*, *klepni*) | `bot_verify_blocked_rsvp` |
| Web strings (`applications/web/`) | **vykání** (formal "vy": *dokončete*, *zapíšete*) | `rsvp_profileIncomplete` |
| Product docs site (`applications/docs/`) | **vykání** — see `applications/docs/AGENTS.md` | — |

Rules:

1. **The shipped Czech word for an RSVP is `účast`.** Never `docházka` (that reads as school attendance-taking). This holds in every surface: `rsvp_profileIncomplete`, `bot_verify_blocked_rsvp`, `teamSettings_requireCompleteProfile_help`.
2. **Never use the word `ověření` / `ověřit` (verify/verification) in member-facing Czech copy.** The internals are named "verification" (`profile-verify`, `VerificationChannelCache`, `Sideline Unverified`), but a member is asked to *dokončit profil* — finish their profile. The channel is `nez-zacnes`, not `overeni`. Identifier names and user-visible strings deliberately disagree here.
3. **A new `bot_*` key is tykání and a new web key is vykání, even when they render the same sentence.** Do not reuse one key across both surfaces to save a line — `rsvp_profileIncomplete` and `bot_verify_blocked_rsvp` say the same thing twice on purpose.

### Rules When Modifying `pack.js`

1. **`scripts/pack.js` runs in the same `build` script as Paraglide** (`paraglide-js compile ... && node scripts/pack.js`). Never split them — `registry.js` depends on `messages.js` already existing in `dist/`.
2. **Every entry in `package.json`'s `publishConfig` export map must be emitted by `pack.js`** (or by Paraglide). The current set is `./messages`, `./runtime`, `./registry`, `./raw/en.json`, `./raw/cs.json`. Adding a new subpath requires updating both `pack.js` AND the consumers' import statements.
3. **`./raw/{locale}.json` is a verbatim copy of `messages/{locale}.json`.** Do not transform it — the server's export endpoint relies on it being identical to the source so that "compiled default" and "raw default" never drift.
4. **Never re-add a `messages` runtime field that depends on Effect or a React context.** This package is consumed by the bot, the server, and the web — keep it framework-free.
