import { Option } from 'effect';

/**
 * Collapse a nested optional patch field to a nullable SQL bind value:
 * outer None = field absent (caller guards with the CASE WHEN), inner None = explicit null.
 */
export const nestedOptionToNullable = <A>(o: Option.Option<Option.Option<A>>): A | null =>
  Option.isNone(o) ? null : Option.getOrNull(o.value);
