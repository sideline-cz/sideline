import type { Auth } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Array, Data, Effect, Option, Schema } from 'effect';
import { HomePage } from '~/components/pages/HomePage';
import {
  clearPendingInvite,
  clearPendingOnboarding,
  finishLogin,
  getLastTeamId,
  getLogin,
  getPendingInvite,
  getPendingOnboarding,
} from '~/lib/auth';
import { client } from '../lib/client';
import { Redirect } from '../lib/runtime';

class SkipError extends Data.TaggedError('SkipError') {}

const redirectIfPendingOnboarding = getPendingOnboarding.pipe(
  Effect.tap(() => clearPendingOnboarding),
  Effect.flatMap((pending) =>
    Option.isSome(pending)
      ? Effect.fail(Redirect.make({ to: '/onboarding/$token', params: { token: pending.value } }))
      : Effect.void,
  ),
);

const redirectIfPendingInvite = getPendingInvite.pipe(
  Effect.tap(() => clearPendingInvite),
  Effect.flatMap((pending) =>
    Option.isSome(pending)
      ? Effect.fail(Redirect.make({ to: '/invite/$code', params: { code: pending.value } }))
      : Effect.void,
  ),
);

export const Route = createFileRoute('/')({
  component: HomeRoute,
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({
      token: Schema.optional(Schema.NullOr(Schema.String)),
      error: Schema.optional(Schema.NullOr(Schema.String)),
      reason: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  beforeLoad: ({ search, context }) =>
    Effect.Do.pipe(
      Effect.flatMap(() => Effect.fromOption(Option.fromNullishOr(search.token))),
      Effect.flatMap(finishLogin),
      Effect.flatMap(() => Effect.fail(Redirect.make({ to: '.' }))),
      Effect.catchTag('NoSuchElementError', () => Effect.void),
      Effect.tap(
        Option.match(context.userOption, {
          onSome: () => Effect.void,
          onNone: () => Effect.fail(new SkipError()),
        }),
      ),
      Effect.flatMap(() => redirectIfPendingOnboarding),
      Effect.flatMap(() => redirectIfPendingInvite),
      Effect.flatMap(() => client),
      Effect.flatMap((c) => c.auth.myTeams()),
      Effect.catchTag(['Unauthorized', 'BadRequest', 'HttpClientError', 'SchemaError'], () =>
        Effect.succeed([] as readonly Auth.UserTeam[]),
      ),
      Effect.tap((teams) =>
        getLastTeamId.pipe(
          Effect.flatMap((lastTeamIdOption) =>
            Option.match(lastTeamIdOption, {
              onSome: (teamId) =>
                Option.isSome(Array.findFirst(teams, (t) => t.teamId === teamId))
                  ? Effect.fail(Redirect.make({ to: '/teams/$teamId', params: { teamId } }))
                  : Effect.void,
              onNone: () => Effect.void,
            }),
          ),
        ),
      ),
      Effect.map(Array.head),
      Effect.flatMap(Effect.fromOption),
      Effect.flatMap((team) =>
        Effect.fail(Redirect.make({ to: '/teams/$teamId', params: { teamId: team.teamId } })),
      ),
      Effect.catchTag('NoSuchElementError', () =>
        Effect.fail(Redirect.make({ to: '/create-team' })),
      ),
      Effect.catchTag('SkipError', () => Effect.void),
      context.run,
    ),
  loader: ({ context }) =>
    getLogin().pipe(
      Effect.map((url) => url.toString()),
      Effect.tapError((e) => Effect.logWarning('Failed to generate login URL', e)),
      // Intentional UI error boundary: any login URL failure redirects to /error page.
      // The tapError above already logs the cause for debugging.
      Effect.catch(() => Effect.succeed('/error')),
      Effect.bindTo('loginUrl'),
      context.run,
    ),
});

function HomeRoute() {
  const { loginUrl } = Route.useLoaderData();
  const { error, reason } = Route.useSearch();

  return (
    <HomePage
      loginUrl={loginUrl}
      error={Option.fromNullishOr(error)}
      reason={Option.fromNullishOr(reason)}
    />
  );
}
