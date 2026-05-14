import { Auth, Translations } from '@sideline/domain';
import rawCs from '@sideline/i18n/raw/cs.json' with { type: 'json' };
import rawEn from '@sideline/i18n/raw/en.json' with { type: 'json' };
import { messagesByKey } from '@sideline/i18n/registry';
import { Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { TranslationsRepository } from '~/repositories/TranslationsRepository.js';
import { TranslationCache } from '~/services/TranslationCache.js';
import { requireGlobalAdmin } from '~/utils/requireGlobalAdmin.js';

const knownKeys: ReadonlySet<string> = new Set(Object.keys(messagesByKey));

const forbidden = new Translations.TranslationForbidden();

const applyLocaleUpdate = (
  repository: {
    delete_: (args: {
      key: Translations.TranslationKey;
      locale: Translations.Locale;
    }) => Effect.Effect<number>;
    upsert: (args: {
      key: Translations.TranslationKey;
      locale: Translations.Locale;
      value: Translations.TranslationValue;
      updatedBy: Auth.UserId;
    }) => Effect.Effect<number>;
  },
  key: Translations.TranslationKey,
  locale: Translations.Locale,
  valueOpt: Option.Option<string | null>,
  updatedBy: Auth.UserId,
): Effect.Effect<void> =>
  Option.match(valueOpt, {
    onNone: () => Effect.void,
    onSome: (value) =>
      value === null
        ? repository.delete_({ key, locale }).pipe(Effect.asVoid)
        : repository.upsert({ key, locale, value, updatedBy }).pipe(Effect.asVoid),
  });

export const TranslationsApiLive = HttpApiBuilder.group(Api, 'translations', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('cache', () => TranslationCache.asEffect()),
    Effect.bind('repository', () => TranslationsRepository.asEffect()),
    Effect.map(({ cache, repository }) =>
      handlers
        .handle('list', () =>
          cache
            .get()
            .pipe(
              Effect.map(
                ({ version, overrides }) =>
                  new Translations.TranslationsResponse({ version, overrides }),
              ),
            ),
        )
        .handle('upsert', ({ params: { key }, payload }) =>
          Effect.Do.pipe(
            Effect.tap(() => requireGlobalAdmin(forbidden)),
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.tap(({ currentUser }) =>
              Effect.all(
                [
                  applyLocaleUpdate(repository, key, 'en', payload.en, currentUser.id),
                  applyLocaleUpdate(repository, key, 'cs', payload.cs, currentUser.id),
                ],
                { concurrency: 1 },
              ),
            ),
            Effect.flatMap(() => cache.get()),
            Effect.map(
              ({ version, overrides }) =>
                new Translations.TranslationsResponse({ version, overrides }),
            ),
          ),
        )
        .handle('import_', ({ payload }) =>
          Effect.Do.pipe(
            Effect.tap(() => requireGlobalAdmin(forbidden)),
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.flatMap(({ currentUser }) => {
              const unknownKeys = payload.overrides
                .map((e) => e.key)
                .filter((k) => !knownKeys.has(k));

              if (unknownKeys.length > 0) {
                return Effect.fail(new Translations.UnknownTranslationKeys({ keys: unknownKeys }));
              }

              return repository
                .importMerge({
                  entries: payload.overrides,
                  updatedBy: currentUser.id,
                })
                .pipe(
                  Effect.flatMap(() => cache.get()),
                  Effect.map(
                    ({ version, overrides }) =>
                      new Translations.TranslationsResponse({ version, overrides }),
                  ),
                );
            }),
          ),
        )
        .handle('exportJson', () =>
          Effect.Do.pipe(
            Effect.tap(() => requireGlobalAdmin(forbidden)),
            Effect.flatMap(() => cache.get()),
            Effect.map(({ overrides }) => {
              const en: Record<string, string> = { ...(rawEn as Record<string, string>) };
              const cs: Record<string, string> = { ...(rawCs as Record<string, string>) };

              for (const override of overrides) {
                if (override.locale === 'en') {
                  en[override.key] = override.value;
                } else if (override.locale === 'cs') {
                  cs[override.key] = override.value;
                }
              }

              return { en, cs } as Record<string, Record<string, string>>;
            }),
          ),
        ),
    ),
  ),
);
