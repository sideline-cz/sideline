import { Effect, type Option } from 'effect';

/**
 * Builds a `nullable` accessor for reading an `Option`-typed property off a
 * decoded SQL event row, failing with the caller's error when the property is
 * `None`.
 *
 * Each RPC event module (`role/events.ts`, `channel/events.ts`) keeps its own
 * `EventPropertyMissing` error and supplies it here via `makeError`. Those error
 * classes are intentionally NOT unified: they carry differently-branded `id`
 * types AND — critically — a miss marks a role event as `markFailed` (retryable)
 * but a channel event as `markPermanentlyFailed` (terminal). DO NOT hoist the
 * `EventPropertyMissing` classes into this shared module; doing so would silently
 * change one module's failure semantics. Only the mechanical accessor (and the
 * two generic casts it needs to bridge the mapped-type constraint) is shared.
 */
export const makeNullableEventProperty =
  <Id, Err>(makeError: (args: { event_type: string; id: Id; property: string }) => Err) =>
  <
    K extends keyof E & string,
    E extends {
      readonly event_type: string;
      readonly id: Id;
    } & {
      [key in K]: E[K] extends Option.Option<infer T> ? Option.Option<T> : never;
    },
  >(
    event: E,
    key: K,
  ) =>
    Effect.fromOption(event[key] as Option.Option<unknown>).pipe(
      Effect.catchTag('NoSuchElementError', () =>
        Effect.fail(makeError({ event_type: event.event_type, id: event.id, property: key })),
      ),
    ) as Effect.Effect<E[K] extends Option.Option<infer T> ? T : never, Err>;
