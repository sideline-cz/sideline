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

- **Never use `Schema.optional`** — always use `Schema.optionalWith({ as: 'Option' })`, `Schema.OptionFromNullOr(...)`, `Schema.OptionFromOptionalKey(...)`, or `Schema.OptionFromOptional(...)` so optional values are `Option<T>` instead of `T | undefined`
- **`Schema.OptionFromNullOr`** for nullable API/DB fields — decodes `null`/`undefined` → `Option.none()`, values → `Option.some(value)`. Use this when the field is always present in the wire format and `null` is the explicit "absent" marker (e.g. nullable DB columns, JOIN results).
- **`Schema.OptionFromOptionalKey`** for tolerant struct fields where the key may be entirely **absent** from the input but `null` is **not** accepted as a value — decodes missing key → `Option.none()`, present value → `Option.some(value)`. Use this for forwards/backwards-compatible JSON payloads where older producers omit the key (e.g. extending an embedded state object with a new flag without breaking in-flight values).
- **`Schema.OptionFromOptional`** for two distinct cases — decodes missing key → `Option.none()`, present value → `Option.some(decoded)`:
  1. **HTTP query-string parameters** declared on an `HttpApiEndpoint`'s `query: { ... }` block. Query parameters are always either omitted entirely or present as a string; `null` is not a valid wire value. Reference: `packages/domain/src/api/FinanceApi.ts` `listPayments` (`memberId`, `feeId`, `from`, `to`, `includeVoided`).
  2. **Partial PATCH request payload fields** on an `HttpApiEndpoint.patch(...)` `payload: Schema.Struct({ ... })` where a missing key means "do not update this column". Reference: `packages/domain/src/api/ExpenseApi.ts` `UpdateExpenseRequest` (`amountMinor`, `currency`, `spentAt`, `category`, `description`). The server-side repository threads each `Option` into a `CASE WHEN ${Option.isSome(patch.X)} THEN ${Option.getOrNull(patch.X)} ELSE X END` UPDATE clause — see `ExpensesRepository.updateQuery` and the "Atomic Conditional UPDATE Pattern" section in `applications/server/AGENTS.md`.
  Do not use `Schema.OptionFromNullOr` for PATCH payloads — the wire contract is "missing key" not "`null` value"; mixing the two confuses clients about how to express "do not touch".

### Query-String Boolean Helper

HTTP query strings carry every value as a string, so booleans must be defined with an explicit string-to-boolean transform — never `Schema.Boolean` alone (it accepts the literal JS boolean only). Use this exact helper, defined once per API file that needs it:

```typescript
import { Schema, SchemaGetter } from 'effect';

const BooleanFromString = Schema.Literals(['true', 'false']).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((s: 'true' | 'false') => s === 'true'),
    encode: SchemaGetter.transform((b: boolean) => (b ? 'true' : 'false') as 'true' | 'false'),
  }),
);
```

Reference: `packages/domain/src/api/FinanceApi.ts` (`BooleanFromString` used as `Schema.OptionFromOptional(BooleanFromString)` for the `listPayments` `includeVoided` query parameter). Rules:

1. **Restrict the wire vocabulary to exactly `'true'` and `'false'`.** `Schema.Literals(['true', 'false'])` rejects `'1'`, `'yes'`, `''`, and `'TRUE'` — clients must send the canonical lowercase form so the server cannot accept ambiguous values.
2. **Wrap with `Schema.OptionFromOptional(...)` when the flag is optional.** Omit the query key entirely to mean "absent"; the handler then resolves the default with `Option.getOrElse(query.flag, () => false)` so the default lives in handler code, not in the wire schema.
3. **Do not export `BooleanFromString` from the package barrel.** Define it once at the top of the API file that uses it (alongside the `HttpApiGroup`); other API files that need it should copy the four-line helper rather than depend on cross-file imports for a trivial primitive.

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

## Wire-Format Date-String Helpers (`src/models/<Resource>Date.ts`)

When a user-facing wire format carries a calendar date as a `YYYY-MM-DD` string (HTTP payload, RPC field, slash-command option) but the DB stores it as `TIMESTAMPTZ`, the **conversion from wire string to `Date` lives in a dedicated `src/models/<Resource>Date.ts` module** in `@sideline/domain` — never inline in the server handler or in the web/bot. Both producers (web, bot) and the server import the same helper so anchoring + validation cannot drift.

Reference: `packages/domain/src/models/ActivityLogDate.ts` exports `parseLoggedAtDateInPrague(s) => Option<Date>` and `formatPragueDate(d) => string`. Used by `applications/server/src/api/activity-logs.ts`, `applications/server/src/rpc/activity/index.ts`, and `applications/web/src/components/organisms/ActivityLogList.tsx`.

Rules:

1. **The module exports two pure functions: a `parse...` returning `Option<Date>` and a `format...` returning `string`.** Parsing returns `Option.none()` on any invalid input — never throw, never return `null`. Formatting always returns the canonical `YYYY-MM-DD` (use `new Intl.DateTimeFormat('en-CA', { timeZone: '<IANA>' })` — `en-CA` guarantees ISO 8601 ordering).
2. **Validate the format with a `/^\d{4}-\d{2}-\d{2}$/` regex AND a calendar round-trip** (`new Date(Date.UTC(y, m-1, d)).toISOString().slice(0,10) === input`). The regex alone accepts `2025-02-30`; the round-trip catches it.
3. **Anchor the resulting `Date` to noon in the business timezone** (e.g. Prague noon UTC), not midnight. Midnight anchoring lands inside a DST gap once a year and silently shifts the row to the previous day; noon is DST-safe in every IANA zone. The DST-safe anchoring algorithm: start with `new Date(Date.UTC(y, m-1, d, 12, 0, 0))`, read the zone's hour back via `Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false })`, and subtract `(pragueHour - 12) * 3600000ms` to correct for the zone offset.
4. **Bound accepted dates to `±MAX_DAYS_OFFSET` from today in the business timezone** (current value: 730 days for activity logs). Compute "today" with the same `formatPragueDate(new Date())` so the bound matches the anchoring. Dates outside the window return `Option.none()` — this prevents backfilling decades-old rows or scheduling logs in the far future.
5. **The module has no Effect, no I/O, no schema imports beyond `Option` from `effect`.** It is consumed by the web (browser), the bot (Node), and the server (Node) — keep it framework-free. Call sites in the server lift the `Option<Date>` into an `Effect` failure with `Options.toEffect(() => new <Resource>InvalidDate())` from `@sideline/effect-lib`.
6. **Re-export from `packages/domain/src/index.ts` as `export * as <Resource>Date from './models/<Resource>Date.js';`** (namespace export) — consumers then write `<Resource>Date.parseLoggedAtDateInPrague(...)` and `<Resource>Date.formatPragueDate(...)`. Do not flat-export the function names; the namespace prefix prevents collisions when multiple resources have their own date helpers.
7. **The matching wire-format schema lives in the same API/RPC file as the endpoint** (e.g. `LoggedAtDate = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)))` in `ActivityLogApi.ts`) — the schema enforces the wire pattern at the HTTP boundary; the `parse...` helper does the calendar + bounds validation and the timezone-aware anchoring. Both layers are required: the schema rejects obvious garbage early; the helper handles the semantic checks the schema cannot express.

## Code-Defined Catalogs

Some domain enumerations ship as a **code-defined catalog** in `src/models/` rather than as DB-seeded rows. Use this pattern when every entry needs structured per-entry metadata (predicates, flags, thresholds) that is consumed identically by server, bot, and web, and the list is small + change-controlled (PR-only, not user-editable at runtime).

Reference implementations:

| Catalog | File | Per-entry metadata | Consumers |
|---------|------|-------------------|-----------|
| `ActivityTypeSlug` | `src/models/ActivityType.ts` | none — just `Schema.Literals` enum | server, web |
| `ACHIEVEMENTS` | `src/models/Achievement.ts` | `slug`, `grantsDiscordRole: boolean`, `isEarned: (input) => boolean` predicate | server (`AchievementEvaluator`), bot (sync handler), web (grid) |

Rules:

1. **Slug schema is the source of truth.** Export a `Schema.Literals([...])` (e.g. `AchievementSlug`) and derive the catalog array's `slug` field type from it. The literal union is what crosses the wire / appears in DB rows; the catalog array adds local-only metadata.
2. **Catalog entries are pure.** Predicates (`isEarned`, etc.) take a plain readonly input record and return a boolean — no Effect, no I/O, no `Map` mutation. The domain package has no I/O dependencies; the catalog runs in every consumer.
3. **Expose a `*_BY_SLUG: ReadonlyMap` derived from the array** so consumers do not re-`find()` on every lookup. Build it once at module load: `new Map(ARRAY.map((a) => [a.slug, a]))`.
4. **i18n keys are derived, not stored.** Export pure key-builder functions (`i18nTitleKey(slug)`, `i18nDescriptionKey(slug)`) that return the message key string. The catalog never embeds translated text — i18n keys live in `@sideline/i18n/messages/*.json`.
5. **When adding an entry**: append to the `Schema.Literals([...])` AND to the `ACHIEVEMENTS` array (or equivalent) in the same PR, then add i18n keys for `title`/`description` in `cs.json` and `en.json`. Never gate entries behind feature flags inside the catalog — keep the array statically enumerable.

### Per-Team Overrides for Code-Defined Catalogs

When a code-defined catalog entry carries a numeric or scalar threshold that captains must be able to tune per team (e.g. "100 activities to earn Centurion" → some teams want 50), keep the **catalog entry's `defaultThreshold` static in code** and store per-team overrides in a dedicated `<catalog>_settings` table. Reference implementation: `achievement_settings (team_id, achievement_slug, threshold_override)` overrides `ACHIEVEMENTS[*].defaultThreshold`.

Rules:

1. **Override table is keyed by `(team_id, <slug>)`** with `PRIMARY KEY (team_id, <slug>)` so a missing row means "use the catalog default" — never insert a row whose value equals the default just to be explicit.
2. **The catalog still ships the default.** The override table is read into a `ReadonlyMap<Slug, number>` and consumed via a pure resolver: `effectiveThreshold(slug, overrides): number` returns `overrides.get(slug) ?? catalogEntry.defaultThreshold`. Never mutate the catalog entry to apply an override.
3. **Resolver lives in the domain catalog file** (`packages/domain/src/models/<Catalog>.ts`), not in the server repository — so server, bot, and web all import the same `effectiveThreshold` and cannot drift.
4. **Server reads overrides once per evaluation** via a repository method like `findOverridesByTeam(teamId) => Effect<ReadonlyMap<Slug, number>>` and threads the map through the evaluator. Do not call the override resolver inside a hot per-member loop without first hoisting the `Map` lookup out of the loop.
5. **Deleting an override row is the way to "reset to default"** — never store the default value in the override table as a sentinel. The override repository exposes a `deleteOverride(teamId, slug)` method for this.

## Permission Catalog (`src/models/Role.ts`)

`Permission` is a `Schema.Literals([...])` enum that lists every permission string usable in `role_permissions.permission`. Reference entries: `team:manage`, `roster:view`, `member:edit`, `finance:view`, `finance:manage_fees`, `finance:record_payments`.

Rules when adding, renaming, or splitting permissions:

1. **Append the new literal to `Permission.literals`** AND add it to the relevant entry of `defaultPermissions` (`Admin`, `Captain`, `Player`, `Treasurer`). The full list of built-in role names is `builtInRoleNames` in `src/models/Role.ts` — keep it in sync with `Object.keys(defaultPermissions)` (the unit test `packages/domain/test/Role.test.ts` enforces this invariant). `allPermissions` is derived from the literal union and updates automatically.
2. **`defaultPermissions` only seeds permissions for newly-created teams.** Built-in roles (`Admin`, `Captain`, `Player`, `Treasurer`) on teams that already exist in production keep whatever `role_permissions` rows they were originally seeded with. When the goal is to grant an existing built-in role a brand-new permission (i.e. adding to `defaultPermissions[<role>]`, not splitting an existing one), ship a backfill migration in the same PR that inserts the new permission into the matching `is_built_in = true` rows. Reference template — copy the structure exactly, only changing the role name and the `VALUES` list:
   ```typescript
   // packages/migrations/src/before/<timestamp>_grant_<role>_<perms>.ts
   import { Effect } from 'effect';
   import { SqlClient } from 'effect/unstable/sql';

   export default Effect.flatMap(
     Effect.service(SqlClient.SqlClient),
     (sql) => sql`
       INSERT INTO role_permissions (role_id, permission)
       SELECT r.id, perm
       FROM roles r
       CROSS JOIN (VALUES ('<perm-a>'), ('<perm-b>')) AS p(perm)
       WHERE r.name = 'Captain' AND r.is_built_in = true
       ON CONFLICT DO NOTHING
     `,
   );
   ```
   Reference migrations: `1746600000_grant_captain_team_invite.ts` (single permission), `1783100000_grant_captain_activity_type_perms.ts` (multiple permissions via `VALUES` list), `1784000000_introduce_treasurer_role.ts` (one role-row insert + per-role permission inserts chained via `Effect.Do.pipe(Effect.tap, Effect.tap, …)` when the same migration must seed multiple roles in one transaction). `ON CONFLICT DO NOTHING` is required on every statement — re-running the migration on a DB that already has the row must be a no-op. When introducing a **new built-in role** (not just a new permission on an existing role), the first statement inserts the role row per team (`INSERT INTO roles (team_id, name, is_built_in) SELECT t.id, '<RoleName>', true FROM teams t ON CONFLICT (team_id, name) DO NOTHING`) and subsequent statements seed its permissions using the role-name `WHERE` clause shown above.
3. **Splitting one permission into multiple (e.g. `finance:manage` → `finance:manage_fees` + `finance:record_payments`) is a breaking migration.** Existing `role_permissions` rows store the old string and will fail `Permission` decoding after the split. Ship a migration that rewrites stored rows to the new vocabulary in the same PR — never let a deploy land where the production DB carries a permission string that no longer parses.
4. **Use `<domain>:<verb>` or `<domain>:<verb>_<noun>` snake_case after the colon.** Examples: `finance:manage_fees`, `member:remove`. Do not mix dialects (no `finance.manageFees`, no `manage-fees`).
5. **Captain ≠ Admin ≠ Treasurer by default.** When introducing a permission, decide explicitly which built-in role(s) get it. **Admin** holds every permission in `Permission.literals` — it is the all-powerful role used by team creators. **Captain** runs day-to-day events and roster operations and gets `finance:view` (read-only) but no money-moving finance perms. **Treasurer** is a built-in delegation role holding `finance:view`, `finance:manage_fees`, and `finance:record_payments` — assign it to a non-captain member who handles money without elevating them to Admin. **Player** is the baseline (`roster:view`, `member:view`).
6. **Server handlers gate every protected endpoint with `requirePermission(membership, '<perm>', forbidden)`** — the domain catalog is the only source of truth for permission strings; do not hard-code literal strings in server handlers, always reference `Permission.literals` or pass the literal through a typed parameter.
7. **Prefer reusing an existing permission over minting a new literal when a new feature falls inside an existing permission cluster.** Before adding a new entry to `Permission.literals`, ask: does this action belong to the same trust boundary as an existing permission? If yes, reuse the existing literal and document the reuse with a one-line code comment at every server handler that gates on it. Reference: `applications/server/src/api/expenses.ts` — `createExpense` / `updateExpense` / `deleteExpense` all gate on the pre-existing `finance:manage_fees` (with comment `// 'finance:manage_fees' also gates expense write operations; Captain remains read-only by lacking this permission.`) instead of introducing a new `finance:manage_expenses` literal. Adding a redundant literal forces a permission-split migration on every existing team's built-in roles (see rule 3) and gives no UX benefit when the trust boundary is unchanged. Mint a new literal ONLY when the boundary differs (e.g. a role should be able to do X but not Y).
8. **When adding or removing a built-in permission, ship a backfill migration in the same PR.** `defaultPermissions` is the seed contract for newly-created teams — mutating it does NOT touch existing teams. To keep production parity, every PR that changes `defaultPermissions[<role>]` must include a migration under `packages/migrations/src/before/` that grants the new permission to existing teams' built-in roles using the `INSERT … SELECT r.id, perm FROM roles r CROSS JOIN (VALUES ...) AS p(perm) WHERE r.name = '<Role>' AND r.is_built_in = true ON CONFLICT DO NOTHING` pattern (see `1746600000_grant_captain_team_invite.ts`, `1783100000_grant_captain_activity_type_perms.ts`, `1784000000_introduce_treasurer_role.ts`). Removing a permission from `defaultPermissions[<role>]` is additive on the code side: the migration must NOT delete existing `role_permissions` rows (admins may have legitimately granted them per team). Drift is verified by `packages/domain/test/Role.test.ts` (every default ∈ `Permission.literals`, Admin == `allPermissions`, Captain has `finance:view` only among finance perms, etc.) and by the integration test `applications/server/test/integration/repositories/RolesRepository.test.ts` which seeds a new team and asserts every built-in role matches `defaultPermissions[name]`.

## HTTP API Error Tag Conventions

When defining `HttpApiGroup` endpoints in `src/api/*.ts`, follow these tag conventions so handlers and clients can branch on a stable, semantic set of errors:

| Class name pattern | HTTP status | When to use |
|--------------------|-------------|-------------|
| `<Resource>Forbidden` (tag `'<Resource>Forbidden'`) | 403 | Caller lacks the required permission on the team. Always required on any captain-/admin-scoped endpoint. |
| `<Resource>Protected` (tag `'<Resource>Protected'`) | 422 | The target row is **immutable by class** (e.g. a built-in / global row in a team-scoped resource). Distinct from `Forbidden` — the caller may have permission, but this specific row cannot be mutated. |
| `<Resource>NotFound` (tag `'<Resource>NotFound'`) | 404 | Row does not exist OR exists but is not visible to this team. Never include the resource id in the payload — the absence of the row is the only signal. |
| `<Resource>NameAlreadyTaken` (tag `'<Resource>NameAlreadyTaken'`, payload `{ name: Schema.String }`) | 409 | Unique-name constraint hit. Payload carries the conflicting name so the client can render a field-level error. |
| `<Resource>Has<Children>` (tag e.g. `'ActivityTypeHasLogs'`, payload `{ usageCount: Schema.Number }`) | 409 | Delete blocked by referential integrity. Payload carries the count so the client can render "in use by N items". |

Reference: `packages/domain/src/api/ActivityTypeApi.ts` defines all five tags.

Rules:

1. **The tag string must include the resource prefix.** Use `'ActivityTypeForbidden'`, not bare `'Forbidden'` — the tag must be unique across all `HttpApiGroup` definitions so the client's `Effect.catchTag` can disambiguate without import gymnastics. The `class` name (`Forbidden`) may stay short within the file because it is namespaced by its module.
2. **Never reuse `Forbidden` for an immutable-row error.** A 403 means "you cannot do this action"; a 422 `Protected` means "this row cannot be the target of this action". Collapsing them prevents the web UI from rendering the right message ("permission denied" vs "built-in row, cannot edit").
3. **Tag classes are payload-bearing where it improves error UX.** `NameAlreadyTaken` carries the name (so the form field error reads "'gym' is already used"); `HasLogs` carries the count (so the dialog reads "Cannot delete — 12 logs reference this type"). Empty payloads (`{}`) are correct for purely categorical errors (`Forbidden`, `Protected`, `NotFound`).
4. **Lifecycle-state errors get one tag per terminal state on the same resource.** When a resource has a non-trivial lifecycle (e.g. an onboarding token transitions `active → consumed | revoked | expired`), define one resource-prefixed tag per terminal state (`<Resource>TokenExpired` / `<Resource>TokenAlreadyConsumed` / `<Resource>TokenRevoked`) rather than collapsing into a single `<Resource>TokenInvalid`. The client renders distinct UI per state ("This link expired, ask for a new one" vs "This link was already used"), and the HTTP-status mapping is per-state (`410 Gone` for expired/revoked, `409 Conflict` for already-consumed, `404` only when the row does not exist at all). Reference: `packages/domain/src/api/OnboardingApi.ts` — `OnboardingTokenNotFound` (404), `OnboardingTokenExpired` (410), `OnboardingTokenRevoked` (410), `OnboardingTokenAlreadyConsumed` (409), plus `OnboardingWrongCaptain` (403) and `OnboardingGuildAlreadyClaimed` (409) for non-state preconditions on the same endpoint.

## RPC Folder Import Rule

Files under `src/rpc/**` must import models from their concrete paths (e.g. `import * as Discord from '~/models/Discord.js'`), **not** via the barrel `~/index.js`. The barrel re-exports both `models/*` and `rpc/*`, and rpc files transitively pulled in through the barrel before their model dependencies finish initialising — at runtime this surfaces as `Cannot read properties of undefined (reading 'ast')` when a `Schema.TaggedClass` or `RpcGroup.make` references e.g. `Team.TeamId`. Always import models directly inside `src/rpc/**`.

## Build Requirement

**Critical**: After changing source files in this package, always rebuild before running type checks or tests in consuming packages:

```bash
pnpm build
```

Workspace packages use `publishConfig.directory: "dist"`, so pnpm symlinks consumers to `packages/domain/dist/`. Stale `.d.ts` files in `dist/` cause false type errors.
