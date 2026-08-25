/**
 * `text` — the localized-content accessor, ported from the source's `T`.
 * `''` is a legitimate authored value (some `why`/`note` fields are
 * intentionally blank), so the fallback must check `!== undefined`, not use
 * `??` or `||`, which would treat an empty string as missing and fall back
 * to `en` when the author meant blank. Chrome strings (`ui.json`) are a
 * Phase 1 concern via the i18n catalogue — this function is for scenario
 * *content* only (decision D1).
 */
import type { Lang, Localized } from '../types.js';

export function text<T>(localized: Localized<T>, lang: Lang): T {
  return localized[lang] !== undefined ? localized[lang] : localized.en;
}
