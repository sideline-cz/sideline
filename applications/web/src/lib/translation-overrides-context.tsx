import { useQuery } from '@tanstack/react-query';
import { Effect, Exit, Layer, Logger, Option, References } from 'effect';
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

const ServerUrlContext = React.createContext<string>('');

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
  // Use Effect.exit so that defects (including interrupts from React Query's
  // AbortSignal or an aborted fetch during the post-login redirect sequence)
  // never escape as an unhandled rejection.  Only a successful fetch with data
  // produces a result; any failure — typed or otherwise — silently returns the
  // empty default so the app keeps working without translations.
  const exit = await Effect.runPromiseExit(
    ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.translations.list()),
      Effect.provide(AppLayer),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(ClientConfig, { baseUrl: serverUrl }),
      Effect.option,
    ),
  );

  if (!Exit.isSuccess(exit) || Option.isNone(exit.value)) {
    return { version: 0, overrides: {} };
  }

  const result = exit.value;

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
    // Key by serverUrl so the query refetches against the correct API base URL
    // once it resolves (an empty base URL would silently target the page origin).
    queryKey: ['translations', serverUrl],
    queryFn: () => fetchTranslations(serverUrl),
    enabled: serverUrl.length > 0,
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
    <ServerUrlContext.Provider value={serverUrl}>
      <TranslationOverridesContext.Provider value={value}>
        {children}
      </TranslationOverridesContext.Provider>
    </ServerUrlContext.Provider>
  );
}

export function useTranslationOverrides(): TranslationOverridesValue {
  const ctx = React.useContext(TranslationOverridesContext);
  return ctx ?? { version: 0, overrides: {} };
}

export function useServerUrl(): string {
  return React.useContext(ServerUrlContext);
}
