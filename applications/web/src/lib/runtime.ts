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

const AppLayer = Layer.mergeAll(
  ApiClientLive,
  Logger.layer([Logger.consolePretty()]),
  Layer.succeed(References.MinimumLogLevel, 'Info' as const),
);

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
  private serverUrl: string;
  private abortController?: AbortController;

  constructor(serverUrl: string, abortController?: AbortController) {
    this.serverUrl = serverUrl;
    this.abortController = abortController;
  }

  async run<A>(
    effect: Effect.Effect<A, Redirect | NotFound, ApiClient | ClientConfig>,
  ): Promise<A> {
    const effectResponse = effect.pipe(
      Effect.result,
      Effect.provide(AppLayer),
      Effect.provideService(ClientConfig, {
        baseUrl: this.serverUrl,
      }),
    );
    const exit = await Effect.runPromiseExit(effectResponse, {
      signal: this.abortController?.signal,
    });
    return resolveServerExit(exit, this.abortController?.signal.aborted ?? false);
  }
}

export const runPromiseServer =
  (serverUrl: string) =>
  (abortController?: AbortController) =>
  async <A>(
    effect: Effect.Effect<A, Redirect | NotFound, ApiClient | ClientConfig>,
  ): Promise<A> => {
    const effectResponse = effect.pipe(
      Effect.result,
      Effect.provide(AppLayer),
      Effect.provideService(ClientConfig, {
        baseUrl: serverUrl,
      }),
    );
    const exit = await Effect.runPromiseExit(effectResponse, {
      signal: abortController?.signal,
    });
    return resolveServerExit(exit, abortController?.signal.aborted ?? false);
  };

export const runPromiseClient =
  (serverUrl: string) =>
  (options?: RunOptions) =>
  async <A>(
    effect: Effect.Effect<A, ClientError | SilentClientError, ApiClient | ClientConfig>,
  ): Promise<Option.Option<A>> => {
    const toastId = options?.loading ? toast.loading(options.loading) : undefined;
    const effectResponse = effect.pipe(
      Effect.provide(AppLayer),
      Effect.provideService(ClientConfig, {
        baseUrl: serverUrl,
      }),
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
      // Error is already shown to the user via toast above — convert to Option.none
      Effect.option,
    );
    return await Effect.runPromise(effectResponse);
  };
