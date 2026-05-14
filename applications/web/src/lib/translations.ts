import { messagesByKey } from '@sideline/i18n/registry';
import { getLocale } from '@sideline/i18n/runtime';

type Overrides = Record<string, { en?: string; cs?: string }>;

let currentOverrides: Overrides = {};

export const setTranslationOverrides = (next: Overrides): void => {
  currentOverrides = next;
};

const interpolate = (template: string, params: Record<string, unknown> | undefined): string => {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = params[key];
    return v === undefined || v === null ? `{${key}}` : String(v);
  });
};

export const tr = (
  key: string,
  params?: Record<string, unknown>,
  options?: { locale?: 'en' | 'cs' },
): string => {
  const locale = options?.locale ?? getLocale();
  const override = currentOverrides[key]?.[locale];
  if (override !== undefined) {
    return interpolate(override, params);
  }
  if (Object.hasOwn(messagesByKey, key)) {
    const fn = messagesByKey[key];
    return fn(params, { locale });
  }
  console.warn(`[tr] Unknown translation key: ${key}`);
  return key;
};
