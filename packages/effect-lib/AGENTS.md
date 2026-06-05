# Effect Lib Package (`@sideline/effect-lib`)

Shared Effect-TS utilities used across the monorepo.

## Key Exports

### Bind Utilities

`Bind.remove` strips internal dependencies from service types in the repository pattern:

```typescript
import { Bind } from '@sideline/effect-lib';

// In repository definition — remove internals from the service type
SqlClient.SqlClient.pipe(
  Effect.bindTo('sql'),
  Effect.bind('repo', () => Model.makeRepository(...)),
  Effect.let('findById', ({ repo }) => (id) => repo.findById(id)),
  Bind.remove('sql'),
  Bind.remove('repo'),
)
```

### DateTime Schemas

`Schemas.DateTimeFromDate` — converts between JS `Date` and Effect `DateTime.Utc`. Use in domain models:

```typescript
import { Schemas } from '@sideline/effect-lib';

// For non-nullable DateTime fields
created_at: Schemas.DateTimeFromDate

// For nullable DateTime fields
deleted_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate)
```

### Option → Effect Lifting

`Options.toEffect` converts an `Option<T>` into an `Effect<T, E>` that fails with a typed tagged error when the option is `None`. Always prefer this helper over an inline `Option.match({ onNone: () => Effect.fail(...), onSome: Effect.succeed })` — the helper reads bottom-up at the call site (`Options.toEffect(() => new NotFound())`) and keeps the not-found error close to the `.flatMap` that introduces it.

```typescript
import { Options } from '@sideline/effect-lib';

// In an API handler — typical "find or 404" pattern
Effect.bind('row', () =>
  repo.findById(id).pipe(
    Effect.flatMap(Options.toEffect(() => new ResourceNotFound())),
  ),
),

// Lifting a domain-helper's Option<Date> into a 400 InvalidDate failure
ActivityLogDate.parseLoggedAtDateInPrague(dateStr).pipe(
  Options.toEffect(() => new ActivityLogApi.InvalidLoggedAtDate()),
)
```

Rules:

1. **Always use `Options.toEffect(() => new <Tag>())` over inline `Option.match`** when the `onSome` branch would be a bare `Effect.succeed`. Reserve `Option.match` for cases where the `onSome` branch is non-trivial (e.g. a chained `.pipe(Effect.map(...))`).
2. **The error factory is a thunk** (`() => new NotFound()`) — `Options.toEffect` only invokes it on `None`, so constructing the error has no cost on the happy path.
3. **For the converse direction** (`Option<Effect<T, E>>` → `Effect<Option<T>, E>`), use `Options.extractEffect`. This is the right shape when an optional input must be parsed/validated via an Effect-returning function before being threaded into a downstream pipeline.

### SQL Error Handling

Utilities for handling PostgreSQL-specific errors (unique constraint violations, etc.). All exports live in `src/SqlErrors.ts` and walk the `SqlError` `.cause` chain (max depth 5) to find the underlying Postgres driver error.

| Export | Signature | Purpose |
|--------|-----------|---------|
| `isUniqueViolation` | `(error: SqlError) => boolean` | `true` when the cause chain carries Postgres `code === '23505'` (unique violation). |
| `getConstraintName` | `(cause: unknown, depth?) => Option<string>` | Walks the cause chain for a Postgres `{ constraint: string }` and returns the constraint name. Use to distinguish **which** unique index fired when a table has more than one. |
| `catchUniqueViolation` | `<E2>(mapError: () => E2) => <A,E,R>(self) => Effect<A, E \| E2, R>` | Catches **any** unique violation and replaces it with `mapError()`. Use when the table has exactly one unique constraint. |
| `catchUniqueViolationOn` | `<E2>(constraintName: string, onViolation: () => E2) => <A,E,R>(self) => Effect<A, E \| E2, R>` | Catches a unique violation **only** when `getConstraintName` matches `constraintName`. Use when a table has multiple unique constraints and each must map to a distinct domain error. |

Rules:

1. **Use `catchUniqueViolationOn` (not `catchUniqueViolation`) when a table has more than one unique constraint.** Passing the exact index name keeps each constraint mapped to its own domain error. Example: `insertAdopted` in `TeamChannelsRepository` chains `catchUniqueViolationOn('uq_team_channels_discord_channel', ...)` → `DiscordChannelAlreadyAdoptedError` then `catchUniqueViolationOn('<name>(name)', ...)` → `ChannelNameAlreadyTakenError`.
2. **The `constraintName` argument must match the Postgres index/constraint name exactly** as defined in the migration (e.g. `uq_team_channels_discord_channel`). A typo silently falls through to the next catch.
