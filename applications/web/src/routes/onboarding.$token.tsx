import type { OnboardingApi } from '@sideline/domain';
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { Effect, Option } from 'effect';
import { OnboardingPage } from '~/components/pages/OnboardingPage';
import { getLogin, setPendingOnboarding } from '~/lib/auth';
import { ApiClient, ClientError, useRun, warnAndCatchAll } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

type OnboardingStep = 'identity' | 'discord';

const isOnboardingStep = (value: unknown): value is OnboardingStep =>
  value === 'identity' || value === 'discord';

type PreviewResult =
  | { _tag: 'ok'; preview: OnboardingApi.OnboardingTokenPreview }
  | { _tag: 'not-found' }
  | { _tag: 'expired' }
  | { _tag: 'revoked' }
  | { _tag: 'consumed' };

export const Route = createFileRoute('/onboarding/$token')({
  component: OnboardingRoute,
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { step?: OnboardingStep } =>
    isOnboardingStep(search.step) ? { step: search.step } : {},
  loader: async ({ params, context }) => {
    const previewResult: PreviewResult = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.onboarding.previewOnboardingToken({ params: { plaintextToken: params.token } }),
      ),
      Effect.map((preview): PreviewResult => ({ _tag: 'ok', preview })),
      Effect.catchTag('OnboardingTokenNotFound', () =>
        Effect.succeed({ _tag: 'not-found' } as PreviewResult),
      ),
      Effect.catchTag('OnboardingTokenExpired', () =>
        Effect.succeed({ _tag: 'expired' } as PreviewResult),
      ),
      Effect.catchTag('OnboardingTokenRevoked', () =>
        Effect.succeed({ _tag: 'revoked' } as PreviewResult),
      ),
      Effect.catchTag('OnboardingTokenAlreadyConsumed', () =>
        Effect.succeed({ _tag: 'consumed' } as PreviewResult),
      ),
      warnAndCatchAll,
      context.run,
    );
    return { previewResult };
  },
});

function OnboardingRoute() {
  const { token } = Route.useParams();
  const { previewResult } = Route.useLoaderData();
  const { userOption, environment } = Route.useRouteContext();
  const { step: searchStep } = useSearch({ from: Route.id });
  const navigate = useNavigate({ from: Route.fullPath });
  const run = useRun();

  const activeStep = searchStep ?? 'identity';
  const handleStepChange = (step: OnboardingStep) => {
    navigate({ search: { step } });
  };

  const handleSignIn = () => {
    Effect.runSync(setPendingOnboarding(token));
    getLogin()
      .pipe(
        Effect.tapError((e) => Effect.logWarning('Failed to generate login URL', e)),
        Effect.mapError(() => ClientError.make('Failed to generate login URL')),
        run(),
      )
      .then((url) => {
        if (Option.isSome(url)) {
          window.location.href = url.value.toString();
        }
      });
  };

  const handleComplete = async (values: OnboardingApi.CompleteOnboardingRequest) => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.onboarding.completeOnboarding({
          params: { plaintextToken: token },
          payload: values,
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('onboarding_error_submitFailed'))),
      run({ success: tr('onboarding_success_title') }),
    );
    if (Option.isSome(result)) {
      await navigate({ to: '/teams/$teamId', params: { teamId: result.value.teamId } });
    }
  };

  return (
    <OnboardingPage
      token={token}
      previewResult={previewResult}
      userOption={userOption}
      activeStep={activeStep}
      onStepChange={handleStepChange}
      onSignIn={handleSignIn}
      onComplete={handleComplete}
      discordClientId={environment.DISCORD_CLIENT_ID}
    />
  );
}
