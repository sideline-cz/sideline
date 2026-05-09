# Domain Package (`@sideline/domain`)

Core domain models, schemas, API contracts, and RPC endpoint definitions. This package has **no I/O dependencies** — it's pure domain logic.

## Structure

```
src/
├── models/          — Entity definitions (User, Session, Team, etc.)
├── api/             — Shared HTTP API contracts (HttpApiGroup spec)
└── rpc/             — RPC endpoint definitions (schemas + groups)
```

## Model.Class

Use `Model.Class` from `@effect/sql` to define database models with variant-based schemas:

```typescript
import { Model } from '@effect/sql';
import { Schema } from 'effect';

export const UserId = Schema.String.pipe(Schema.brand('UserId'));
export type UserId = typeof UserId.Type;

export class User extends Model.Class<User>('User')({
  id: Model.Generated(UserId),
  discord_id: Schema.String,
  discord_avatar: Schema.OptionFromNullOr(Schema.String),
  discord_access_token: Model.Sensitive(Schema.String),
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
```

### Field Helpers

- **`Model.Generated(schema)`** — DB-generated fields (excluded from `insert` variant)
- **`Model.Sensitive(schema)`** — fields excluded from `json` variants (tokens, secrets)
- **`Model.DateTimeInsertFromDate`** — auto-managed insert timestamp (`Date` → `DateTime.Utc`)
- **`Model.DateTimeUpdateFromDate`** — auto-managed timestamp for both insert and update
- **`Schema.OptionFromNullOr(schema)`** — nullable DB columns (decodes `T | null` → `Option<T>`, encodes back to `T | null`)

### Conventions

- Use **snake_case** field names matching DB columns directly — no `fieldFromKey` mapping needed
- Use **branded types** for IDs (e.g., `UserId`, `TeamId`) instead of raw `Schema.String`
- Use `.make()` for known-valid literals, `Schema.decodeSync()` at system boundaries
- **DateTime convention**: Always use Effect's `DateTime` classes (`DateTime.Utc`, `DateTime.Zoned`) — never raw JS `Date`. Store instants as `TIMESTAMPTZ` in the DB and use `Schemas.DateTimeFromDate` from `@sideline/effect-lib`.

## Schema Patterns

- **Never use `Schema.optional`** — always use `Schema.optionalWith({ as: 'Option' })`, `Schema.OptionFromNullOr(...)`, or `Schema.OptionFromOptionalKey(...)` so optional values are `Option<T>` instead of `T | undefined`
- **`Schema.OptionFromNullOr`** for nullable API/DB fields — decodes `null`/`undefined` → `Option.none()`, values → `Option.some(value)`. Use this when the field is always present in the wire format and `null` is the explicit "absent" marker (e.g. nullable DB columns, JOIN results).
- **`Schema.OptionFromOptionalKey`** for tolerant struct fields where the key may be entirely **absent** from the input but `null` is **not** accepted as a value — decodes missing key → `Option.none()`, present value → `Option.some(value)`. Use this for forwards/backwards-compatible JSON payloads where older producers omit the key (e.g. extending an embedded state object with a new flag without breaking in-flight values).

### Shared Schemas Across API Contracts

When multiple API groups need the same schema, define it in one `api/*.ts` file and re-export from others:

```typescript
// src/api/GroupApi.ts — defines HexColor
export const HexColor = Schema.String.pipe(Schema.pattern(/^#[0-9a-fA-F]{6}$/));

// src/api/Roster.ts — re-exports HexColor
import { HexColor } from '~/api/GroupApi.js';
export { HexColor };
```

Current shared schemas:

| Schema | Defined in | Re-exported by |
|--------|-----------|----------------|
| `HexColor` | `src/api/GroupApi.ts` | `src/api/Roster.ts` |

### Externally-Fetched URLs (SSRF guard)

Any user-supplied URL that the server (or a downstream service such as Discord) will fetch or render MUST be validated with the shared `isPublicHttpsUrl` predicate exported from `src/api/EventApi.ts`. Reference implementations: `EventImageUrl` and `EventLocationUrl` in `src/api/EventApi.ts`.

`isPublicHttpsUrl(value: string): boolean` enforces all of the following:

1. Rejects strings containing unencoded `<`, `>`, or whitespace (these break URL parsing and Discord `<…>` wrapping).
2. Parses with `new URL(value)` — rejects otherwise.
3. `url.protocol === 'https:'` — rejects `http:`, `data:`, `javascript:`, `file:`, `ftp:`, etc.
4. `url.username === ''` and `url.password === ''` — rejects URLs with embedded userinfo.
5. Hostname (after stripping IPv6 brackets) is NOT a private-IPv4 literal: `127.x.x.x`, `10.x.x.x`, `172.(16–31).x.x`, `192.168.x.x`, `169.254.x.x`, `0.x.x.x`. The check uses an exact dotted-quad regex so domains like `10.example.com` are not falsely rejected.
6. Hostname is NOT the literal `localhost` or `0.0.0.0` (exact match — subdomains like `localhost.example.com` are allowed).
7. Hostname does NOT match the private-IPv6 pattern: `::1`, `::`, `fc00::/7` (`fc..:`/`fd..:`), link-local `fe80::/10` (`fe8x:`–`febx:`), and IPv4-mapped `::ffff:`.

When adding a new URL-bearing field:

1. Define the schema using `Schema.check(Schema.isMaxLength(2048))` plus a `Schema.makeFilter<string>` predicate that calls `isPublicHttpsUrl` and returns `true` on success or a field-specific human-readable error string on failure (so decode errors are descriptive). Do NOT reimplement the checks inline.
2. Re-use the same `isPublicHttpsUrl` import on the consumer side (web, bot) when you need a defensive render guard — never duplicate the logic. Example: `applications/bot/src/rest/events/locationDisplay.ts` falls back to plain text when the URL fails this check.

Do NOT replace the IPv4/IPv6 patterns with a synchronous DNS lookup — domain schemas must remain pure (no I/O). The patterns block IP-literal URLs at the schema layer; defence-in-depth (e.g. egress filtering, DNS rebinding mitigation) is the consuming service's responsibility.

## RPC Folder Import Rule

Files under `src/rpc/**` must import models from their concrete paths (e.g. `import * as Discord from '~/models/Discord.js'`), **not** via the barrel `~/index.js`. The barrel re-exports both `models/*` and `rpc/*`, and rpc files transitively pulled in through the barrel before their model dependencies finish initialising — at runtime this surfaces as `Cannot read properties of undefined (reading 'ast')` when a `Schema.TaggedClass` or `RpcGroup.make` references e.g. `Team.TeamId`. Always import models directly inside `src/rpc/**`.

## Build Requirement

**Critical**: After changing source files in this package, always rebuild before running type checks or tests in consuming packages:

```bash
pnpm build
```

Workspace packages use `publishConfig.directory: "dist"`, so pnpm symlinks consumers to `packages/domain/dist/`. Stale `.d.ts` files in `dist/` cause false type errors.
