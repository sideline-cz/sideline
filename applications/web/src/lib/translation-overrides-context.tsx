import { useQuery } from '@tanstack/react-query';
import { Effect, Layer, Logger, Option, References } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import React from 'react';
import { ClientConfig, client } from '~/lib/client.js';
import { ApiClient } from '~/lib/runtime.js';
import { setTranslationOverrides } from '~/lib/translations.js';

type Overrides = Record<string, { en?: string; cs?: string }>;

interface TranslationOverridesValue {
  version: number;
  overrides: Overrides;
}

const TranslationOverridesContext = React.createContext<TranslationOverridesValue | null>(null);

const AppLayer = Layer.mergeAll(
  Layer.effect(ApiClient, client),
  Logger.layer([Logger.consolePretty()]),
  Layer.succeed(References.MinimumLogLevel, 'Info' as const),
);

function buildOverrides(
  rows: ReadonlyArray<{ key: string; locale: string; value: string }>,
): Overrides {
  const overrides: Overrides = {};
  for (const row of rows) {
    if (!overrides[row.key]) {
      overrides[row.key] = {};
    }
    const locale = row.locale;
    if (locale === 'en' || locale === 'cs') {
      overrides[row.key][locale] = row.value;
    }
  }
  return overrides;
}

async function fetchTranslations(serverUrl: string): Promise<TranslationOverridesValue> {
  const effect = ApiClient.asEffect().pipe(
    Effect.flatMap((api) => api.translations.list()),
    Effect.provide(AppLayer),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(ClientConfig, { baseUrl: serverUrl }),
    Effect.option,
  );

  const result = await Effect.runPromise(effect);

  if (Option.isNone(result)) {
    return { version: 0, overrides: {} };
  }

  const data = result.value;
  return {
    version: data.version,
    overrides: buildOverrides(data.overrides),
  };
}

interface TranslationOverridesProviderProps {
  children: React.ReactNode;
  serverUrl: string;
}

export function TranslationOverridesProvider({
  children,
  serverUrl,
}: TranslationOverridesProviderProps) {
  const { data } = useQuery({
    queryKey: ['translations'],
    queryFn: () => fetchTranslations(serverUrl),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

  React.useEffect(() => {
    if (data) {
      setTranslationOverrides(data.overrides);
    }
  }, [data]);

  const value = data ?? { version: 0, overrides: {} };

  return (
    <TranslationOverridesContext.Provider value={value}>
      {children}
    </TranslationOverridesContext.Provider>
  );
}

export function useTranslationOverrides(): TranslationOverridesValue {
  const ctx = React.useContext(TranslationOverridesContext);
  return ctx ?? { version: 0, overrides: {} };
}
