import {
  type AnyRouter,
  notFound,
  type RedirectOptions,
  type RegisteredRouter,
  redirect,
} from '@tanstack/react-router';
import {
  Cause,
  Data,
  Effect,
  Exit,
  Layer,
  Logger,
  ManagedRuntime,
  Match,
  type Option,
  References,
  Result,
  ServiceMap,
} from 'effect';
import React from 'react';
import { toast } from 'sonner';
import { ClientConfig, client } from '~/lib/client';

export class ClientError extends Data.TaggedError('ClientError')<{
  readonly message: string;
}> {
  static make = (message: string) => new ClientError({ message });
}

export class SilentClientError extends Data.TaggedError('SilentClientError')<{
  readonly message: string;
}> {}

type Client = Effect.Success<typeof client>;

export class ApiClient extends ServiceMap.Service<ApiClient, Client>()('ApiClient') {}

export class Redirect extends Data.TaggedError('Redirect')<{
  readonly redirect: () => never;
}> {
  static make = <
    TRouter extends AnyRouter = RegisteredRouter,
    TFrom extends string = string,
    TTo extends string | undefined = undefined,
    TMaskFrom extends string = TFrom,
    TMaskTo extends string = '.',
  >(
    options: RedirectOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>,
  ) =>
    new Redirect({
      redirect: () => {
        throw redirect(options);
      },
    });
}

export class NotFound extends Data.TaggedError('NotFound') {
  static make = () => new NotFound();
}

export const warnAndCatchAll = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, NotFound, R> =>
  effect.pipe(
    Effect.tapError((e) => Effect.logWarning('Unexpected loader error', e)),
    Effect.catch(() => Effect.fail(new NotFound())),
  );

export const resolveServerExit = async <A>(
  exit: Exit.Exit<Result.Result<A, Redirect | NotFound>>,
  aborted: boolean,
): Promise<A> => {
  if (Exit.isSuccess(exit)) {
    return Result.match(exit.value, {
      onSuccess: (d) => d,
      onFailure: (e) =>
        Match.value(e).pipe(
          Match.tag('Redirect', (r) => r.redirect()),
          Match.tag('NotFound', () => {
            throw notFound();
          }),
          Match.exhaustive,
        ),
    });
  }
  // Failure exit = interrupt/defect (typed Redirect/NotFound were captured by Effect.result into the success channel)
  if (aborted || Cause.hasInterruptsOnly(exit.cause)) {
    // Navigation was superseded (or the fiber was interrupted) — drop this run so a bare
    // interrupt/undefined never escapes to the router. The new navigation owns the outcome.
    return new Promise<never>(() => {});
  }
  const squashed = Cause.squash(exit.cause);
  throw squashed instanceof Error
    ? squashed
    : new Error(`Unexpected runtime defect: ${String(squashed)}`);
};

const ApiClientLive = Layer.effect(ApiClient, client);

const makeAppLayer = (options: {
  readonly serverUrl: string;
  readonly telemetryLayer: Layer.Layer<never>;
}) => {
  // ClientConfig must be: (a) provided to ApiClientLive as a dependency, and
  // (b) kept in the merged layer's output so ManagedRuntime exposes it to effects
  // that declare `ApiClient | ClientConfig` as their requirement.
  const clientConfigLayer = Layer.succeed(ClientConfig, { baseUrl: options.serverUrl });
  return Layer.mergeAll(
    ApiClientLive.pipe(Layer.provide(clientConfigLayer)),
    clientConfigLayer,
    Logger.layer([Logger.consolePretty()]),
    Layer.succeed(References.MinimumLogLevel, 'Info' as const),
    options.telemetryLayer,
  );
};

let _runtime: ManagedRuntime.ManagedRuntime<ApiClient | ClientConfig, never> | null = null;

export const initRuntime = (options: {
  readonly serverUrl: string;
  readonly telemetryLayer: Layer.Layer<never>;
}): void => {
  if (_runtime !== null) return;
  _runtime = ManagedRuntime.make(makeAppLayer(options));
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => void _runtime?.dispose(), { once: true });
  }
};

const getRuntime = (): ManagedRuntime.ManagedRuntime<ApiClient | ClientConfig, never> => {
  if (_runtime === null) throw new Error('Runtime not initialized — call initRuntime() first');
  return _runtime;
};

export type RunOptions = { readonly success?: string; readonly loading?: string };

export type Run = (
  options?: RunOptions,
) => <A>(
  effect: Effect.Effect<A, ClientError | SilentClientError, ApiClient | ClientConfig>,
) => Promise<Option.Option<A>>;

const RunContext = React.createContext<Run>(
  () => () => new Promise((_, reject) => reject('Not implemented')),
);

export const RunProvider = RunContext.Provider;

export const useRun = () => React.useContext(RunContext);

export class ServerRunner {
  private abortController?: AbortController;

  constructor(_serverUrl: string, abortController?: AbortController) {
    this.abortController = abortController;
  }

  async run<A>(
    effect: Effect.Effect<A, Redirect | NotFound, ApiClient | ClientConfig>,
  ): Promise<A> {
    const exit = await getRuntime().runPromiseExit(effect.pipe(Effect.result), {
      signal: this.abortController?.signal,
    });
    return resolveServerExit(exit, this.abortController?.signal.aborted ?? false);
  }
}

export const runPromiseServer =
  (_serverUrl: string) =>
  (abortController?: AbortController) =>
  async <A>(
    effect: Effect.Effect<A, Redirect | NotFound, ApiClient | ClientConfig>,
  ): Promise<A> => {
    const exit = await getRuntime().runPromiseExit(effect.pipe(Effect.result), {
      signal: abortController?.signal,
    });
    return resolveServerExit(exit, abortController?.signal.aborted ?? false);
  };

/**
 * Fire-and-forget an Effect using the shared runtime.
 * Useful for recording metrics/spans from non-Effect callbacks (e.g. Web Vitals, error handlers).
 * Null-safe — silently no-ops if the runtime hasn't been initialized yet.
 */
export const runEffect = (effect: Effect.Effect<void>): void => {
  if (_runtime === null) return;
  void _runtime.runFork(effect);
};

export const runPromiseClient =
  (_serverUrl: string) =>
  (options?: RunOptions) =>
  async <A>(
    effect: Effect.Effect<A, ClientError | SilentClientError, ApiClient | ClientConfig>,
  ): Promise<Option.Option<A>> => {
    const toastId = options?.loading ? toast.loading(options.loading) : undefined;
    const effectResponse = effect.pipe(
      Effect.tapError((e) => Effect.logError('Client error', e)),
      Effect.tapError((e) =>
        Effect.sync(() => {
          if (e._tag === 'SilentClientError') return;
          if (toastId !== undefined) {
            toast.error(e.message, { id: toastId });
          } else {
            toast.error(e.message);
          }
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          if (toastId !== undefined) {
            if (options?.success) {
              toast.success(options.success, { id: toastId });
            } else {
              toast.dismiss(toastId);
            }
          } else if (options?.success) {
            toast.success(options.success);
          }
        }),
      ),
      Effect.option,
    );
    return await getRuntime().runPromise(effectResponse);
  };
