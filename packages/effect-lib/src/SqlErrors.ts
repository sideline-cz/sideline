import { Effect, Option, Predicate, Schema } from 'effect';
import { SqlError } from 'effect/unstable/sql/SqlError';

const PG_UNIQUE_VIOLATION = '23505';

const PgError = Schema.Struct({ code: Schema.String });
const PgConstraintError = Schema.Struct({ constraint: Schema.String });

const decodeCode = (cause: unknown): Option.Option<string> =>
  Schema.decodeUnknownOption(PgError)(cause).pipe(Option.map((e) => e.code));

const decodeConstraint = (cause: unknown): Option.Option<string> =>
  Schema.decodeUnknownOption(PgConstraintError)(cause).pipe(Option.map((e) => e.constraint));

// Walks the error cause chain looking for a Postgres-style { code: string }.
// The new effect SDK wraps the DB driver error in a typed SqlError subclass
// (e.g. ConstraintError) whose own `.cause` field carries the original error
// with the code. We may need to descend several levels.
const getCode = (cause: unknown, depth = 0): Option.Option<string> => {
  if (depth > 5 || !Predicate.isObject(cause)) return Option.none();
  const direct = decodeCode(cause);
  if (Option.isSome(direct)) return direct;
  if (Predicate.hasProperty(cause, 'cause')) {
    return getCode(cause.cause, depth + 1);
  }
  return Option.none();
};

// Walks the error cause chain looking for a Postgres-style { constraint: string }.
export const getConstraintName = (cause: unknown, depth = 0): Option.Option<string> => {
  if (depth > 5 || !Predicate.isObject(cause)) return Option.none();
  const direct = decodeConstraint(cause);
  if (Option.isSome(direct)) return direct;
  if (Predicate.hasProperty(cause, 'cause')) {
    return getConstraintName(cause.cause, depth + 1);
  }
  return Option.none();
};

export const isUniqueViolation = (error: SqlError): boolean =>
  getCode(error.cause).pipe(
    Option.map((code) => code === PG_UNIQUE_VIOLATION),
    Option.getOrElse(() => false),
  );

export const catchUniqueViolation =
  <E2>(mapError: () => E2) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(
      Effect.catchIf(
        (e) => e instanceof SqlError && isUniqueViolation(e),
        () => Effect.fail(mapError()),
      ),
    );

export const catchUniqueViolationOn =
  <E2>(constraintName: string, onViolation: () => E2) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(
      Effect.catchIf(
        (e) =>
          e instanceof SqlError &&
          isUniqueViolation(e) &&
          Option.match(getConstraintName(e.cause), {
            onNone: () => false,
            onSome: (name) => name === constraintName,
          }),
        () => Effect.fail(onViolation()),
      ),
    );
