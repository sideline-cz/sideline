/** Cast-free primitives for probing the shape of `unknown` values — typically
 * dfx/Discord REST error payloads or poll `Cause` reasons whose types are `unknown`.
 *
 * These replace the ad-hoc `value as Record<string, unknown>` / `record[key] as number`
 * casts that were duplicated across the error classifiers (`discordErrors.ts`,
 * `Bot.ts` transient-poll detection, `rcp/channel/ProcessorService.ts` permanent-error
 * detection). Each higher-level classifier keeps its own domain logic and only shares
 * these building blocks. */

/** Narrows `unknown` to an indexable record. Excludes `null` (which is `typeof 'object'`). */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Returns the value as a record, or `undefined` when it is not one. Convenient for
 * optional chaining: `asRecord(v.response)?.status`. */
export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

/** Reads a numeric property from an arbitrary value, returning `undefined` when the
 * value is not a record or the property is absent / non-numeric. */
export const numberProp = (value: unknown, key: string): number | undefined => {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === 'number' ? v : undefined;
};
