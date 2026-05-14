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

### Rules When Modifying `pack.js`

1. **`scripts/pack.js` runs in the same `build` script as Paraglide** (`paraglide-js compile ... && node scripts/pack.js`). Never split them — `registry.js` depends on `messages.js` already existing in `dist/`.
2. **Every entry in `package.json`'s `publishConfig` export map must be emitted by `pack.js`** (or by Paraglide). The current set is `./messages`, `./runtime`, `./registry`, `./raw/en.json`, `./raw/cs.json`. Adding a new subpath requires updating both `pack.js` AND the consumers' import statements.
3. **`./raw/{locale}.json` is a verbatim copy of `messages/{locale}.json`.** Do not transform it — the server's export endpoint relies on it being identical to the source so that "compiled default" and "raw default" never drift.
4. **Never re-add a `messages` runtime field that depends on Effect or a React context.** This package is consumed by the bot, the server, and the web — keep it framework-free.
