import { NodeRuntime } from '@effect/platform-node';
import { Effect, Layer, Logger, type LogLevel, Option, References } from 'effect';
import { DevTools } from 'effect/unstable/devtools';

const LogLayer = (logLevel: Option.Option<LogLevel.LogLevel>) =>
  Layer.mergeAll(
    Logger.layer([Logger.consolePretty()]),
    Layer.succeed(
      References.MinimumLogLevel,
      Option.getOrElse(logLevel, () => 'Info' as const),
    ),
  );

const DevToolsLayer = (env: 'development' | 'production') =>
  env === 'production' ? Layer.empty : DevTools.layer();

const RuntimeLayer = (
  env: 'development' | 'production',
  logLevel: Option.Option<LogLevel.LogLevel>,
  additionalLayers: Layer.Layer<never> = Layer.empty,
) => Layer.mergeAll(LogLayer(logLevel), DevToolsLayer(env), additionalLayers);

export const runMain =
  (
    env: 'development' | 'production',
    logLevel: Option.Option<LogLevel.LogLevel> = Option.none(),
    additionalLayers: Layer.Layer<never> = Layer.empty,
  ) =>
  // No `as never` cast here: any requirement not provided by RuntimeLayer must be
  // resolved by the caller. NodeRuntime.runMain requires `R = never`, so a missing
  // layer dependency (e.g. an unprovided repository) fails `pnpm check` at the call
  // site instead of crashing the app at startup.
  <A, E>(effect: Effect.Effect<A, E, never>): void =>
    NodeRuntime.runMain(Effect.provide(effect, RuntimeLayer(env, logLevel, additionalLayers)));
