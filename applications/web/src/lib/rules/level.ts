import type { Level } from '@sideline/rules';

/** Runtime narrowing for the `Level` union (`1..9`) — a type predicate, not a
 * cast, so callers get real narrowing without ever writing `as Level`. */
export function isLevel(value: number): value is Level {
  return (
    value === 1 ||
    value === 2 ||
    value === 3 ||
    value === 4 ||
    value === 5 ||
    value === 6 ||
    value === 7 ||
    value === 8 ||
    value === 9
  );
}
