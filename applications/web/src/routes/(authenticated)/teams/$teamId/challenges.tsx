import { type Roster, Team, WeeklyChallenge, type WeeklyChallengeApi } from '@sideline/domain';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { WeeklyChallengesPage } from '~/components/pages/WeeklyChallengesPage';
import { ApiClient, ClientError, SilentClientError, useRun, warnAndCatchAll } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/challenges')({
  ssr: false,
  component: ChallengesRoute,
  loader: async ({ params, context }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        Effect.all({
          challengeList: api.weeklyChallenge.listChallenges({
            params: { teamId },
            query: { limit: Option.none() },
          }),
          members: api.roster.listMembers({ params: { teamId } }).pipe(
            Effect.tapError((err) =>
              Effect.logWarning('Roster fetch failed, showing empty member list', err),
            ),
            Effect.catch(() => Effect.succeed<ReadonlyArray<Roster.RosterPlayer>>([])),
          ),
        }),
      ),
      warnAndCatchAll,
      context.run,
    );
  },
});

function ChallengesRoute() {
  const { teamId } = Route.useParams();
  const data = Route.useLoaderData();
  const run = useRun();
  const router = useRouter();

  const challengeList: WeeklyChallengeApi.WeeklyChallengeListResponse = data.challengeList;
  const members: ReadonlyArray<Roster.RosterPlayer> = data.members;

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);

  // Map WeeklyChallengeView[] to page-level plain objects. Branded ids
  // (TeamId, TeamMemberId, WeeklyChallengeId, WeeklyChallengeTitle) are
  // assignable to `string` without explicit casts.
  const challenges = challengeList.challenges.map((view) => ({
    challenge: {
      id: view.challenge.id,
      teamId: view.challenge.team_id,
      // week_start_date is a Date — convert to ISO string for the page
      weekStartDate: view.challenge.week_start_date.toISOString(),
      kind: view.challenge.kind,
      title: view.challenge.title,
      description: Option.getOrNull(view.challenge.description),
      createdBy: view.challenge.created_by,
    },
    completedMemberIds: [...view.completedMemberIds],
    isActive: view.isActive,
  }));

  // Map roster members to page Member shape
  const memberList = members.map((m) => ({
    memberId: m.memberId,
    name: Option.getOrElse(m.name, () => m.username),
  }));

  const currentMemberId: string | null = Option.getOrNull(challengeList.currentMemberId);

  const handleMarkComplete = async (challengeId: string) => {
    const challengeIdBranded = Schema.decodeSync(WeeklyChallenge.WeeklyChallengeId)(challengeId);
    await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.weeklyChallenge.markCompleted({
          params: { teamId: teamIdBranded, challengeId: challengeIdBranded },
        }),
      ),
      Effect.catchTags({
        WeeklyChallengeNotActive: () =>
          Effect.fail(ClientError.make(tr('challenges_error_notActive'))),
        WeeklyChallengeNotFound: () =>
          Effect.fail(ClientError.make(tr('challenges_error_notFound'))),
        WeeklyChallengeForbidden: () =>
          Effect.fail(ClientError.make(tr('challenges_error_forbidden'))),
      }),
      // Catch remaining network/HTTP errors with a generic message
      Effect.mapError((e) =>
        e instanceof ClientError ? e : ClientError.make(tr('challenges_error_notActive')),
      ),
      run(),
    );
    router.invalidate();
  };

  const handleUnmarkComplete = async (challengeId: string) => {
    const challengeIdBranded = Schema.decodeSync(WeeklyChallenge.WeeklyChallengeId)(challengeId);
    await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.weeklyChallenge.unmarkCompleted({
          params: { teamId: teamIdBranded, challengeId: challengeIdBranded },
        }),
      ),
      Effect.catchTags({
        WeeklyChallengeNotActive: () =>
          Effect.fail(ClientError.make(tr('challenges_error_notActive'))),
        WeeklyChallengeNotFound: () =>
          Effect.fail(ClientError.make(tr('challenges_error_notFound'))),
        WeeklyChallengeForbidden: () =>
          Effect.fail(ClientError.make(tr('challenges_error_forbidden'))),
      }),
      // Catch remaining network/HTTP errors with a generic message
      Effect.mapError((e) =>
        e instanceof ClientError ? e : ClientError.make(tr('challenges_error_notActive')),
      ),
      run(),
    );
    router.invalidate();
  };

  const handleCreateChallenge = async (formData: {
    weekStart: Date;
    kind: WeeklyChallenge.WeeklyChallengeKind;
    title: string;
    description: string | null;
  }): Promise<{ _tag?: string } | undefined> => {
    // Per plan §9 risk 5: weekStart is already UTC-midnight from MondayPicker
    // Inline-displayable errors (AlreadyExists, OutOfRange) are returned as tagged objects
    // so NewChallengeDialog can show them inline without a toast.
    // Truly generic errors (Forbidden) go through run() to show a toast.
    let inlineError: { _tag: string } | null = null;

    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.weeklyChallenge.createChallenge({
          params: { teamId: teamIdBranded },
          payload: {
            weekStart: formData.weekStart,
            kind: formData.kind,
            title: formData.title,
            description: formData.description ? Option.some(formData.description) : Option.none(),
          },
        }),
      ),
      Effect.catchTags({
        // Inline errors: set tag for dialog, use SilentClientError to suppress toast
        WeeklyChallengeAlreadyExistsForWeek: (e) => {
          inlineError = { _tag: e._tag };
          return Effect.fail(new SilentClientError({ message: e._tag }));
        },
        WeeklyChallengeWeekOutOfRange: (e) => {
          inlineError = { _tag: e._tag };
          return Effect.fail(new SilentClientError({ message: e._tag }));
        },
        // Generic error: toast via run()
        WeeklyChallengeForbidden: () =>
          Effect.fail(new ClientError({ message: tr('challenges_error_forbidden') })),
      }),
      // Catch remaining network/HTTP errors with a generic message
      Effect.mapError((e) =>
        e instanceof ClientError || e instanceof SilentClientError
          ? e
          : new ClientError({ message: tr('challenges_error_forbidden') }),
      ),
      run({ success: tr('challenges_success_created') }),
    );
    if (Option.isSome(result)) {
      router.invalidate();
      return undefined;
    }
    // Return the inline error tag for dialog display (or undefined if toast handled it)
    return inlineError ?? undefined;
  };

  const handleDeleteChallenge = async (challengeId: string) => {
    const challengeIdBranded = Schema.decodeSync(WeeklyChallenge.WeeklyChallengeId)(challengeId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.weeklyChallenge.deleteChallenge({
          params: { teamId: teamIdBranded, challengeId: challengeIdBranded },
        }),
      ),
      Effect.catchTags({
        WeeklyChallengeNotFound: () =>
          Effect.fail(ClientError.make(tr('challenges_error_notFound'))),
        WeeklyChallengeForbidden: () =>
          Effect.fail(ClientError.make(tr('challenges_error_forbidden'))),
      }),
      // Catch remaining network/HTTP errors with a generic message
      Effect.mapError((e) =>
        e instanceof ClientError ? e : ClientError.make(tr('challenges_error_notFound')),
      ),
      run({ success: tr('challenges_success_deleted') }),
    );
    if (Option.isSome(result)) {
      router.invalidate();
    }
  };

  const handleUpdateChallenge = async (
    challengeId: string,
    formData: { title: string; description: string | null },
  ) => {
    const challengeIdBranded = Schema.decodeSync(WeeklyChallenge.WeeklyChallengeId)(challengeId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.weeklyChallenge.updateChallenge({
          params: { teamId: teamIdBranded, challengeId: challengeIdBranded },
          payload: {
            title: formData.title,
            description: formData.description ? Option.some(formData.description) : Option.none(),
          },
        }),
      ),
      Effect.catchTags({
        WeeklyChallengeNotFound: () =>
          Effect.fail(ClientError.make(tr('challenges_error_notFound'))),
        WeeklyChallengeForbidden: () =>
          Effect.fail(ClientError.make(tr('challenges_error_forbidden'))),
      }),
      // Catch remaining network/HTTP errors with a generic message
      Effect.mapError((e) =>
        e instanceof ClientError ? e : ClientError.make(tr('challenges_error_notFound')),
      ),
      run({ success: tr('challenges_success_updated') }),
    );
    if (Option.isSome(result)) {
      router.invalidate();
    }
  };

  return (
    <WeeklyChallengesPage
      teamId={teamId}
      canCreate={challengeList.canCreate}
      currentMemberId={currentMemberId}
      teamTimezone={challengeList.team.timezone}
      challenges={challenges}
      members={memberList}
      onMarkComplete={handleMarkComplete}
      onUnmarkComplete={handleUnmarkComplete}
      onDeleteChallenge={handleDeleteChallenge}
      onUpdateChallenge={handleUpdateChallenge}
      onCreateChallenge={handleCreateChallenge}
    />
  );
}
