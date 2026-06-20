import type { EventRsvpApi, TeamGenerationApi } from '@sideline/domain';
import { Event, Team } from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import React from 'react';

import { PlayerCard } from '~/components/molecules/PlayerCard.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Skeleton } from '~/components/ui/skeleton';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface TeamGeneratorSectionProps {
  teamId: string;
  eventId: string;
  rsvpYesAttendees: ReadonlyArray<EventRsvpApi.RsvpEntry>;
  onRefresh: () => void;
}

type GenerationState =
  | { _tag: 'initial' }
  | { _tag: 'loading' }
  | { _tag: 'result'; data: TeamGenerationApi.GenerateTeamsResponse }
  | { _tag: 'posted'; data: TeamGenerationApi.GenerateTeamsResponse };

interface LocalTeam {
  index: number;
  members: TeamGenerationApi.GeneratedTeamMember[];
}

function buildLocalTeams(data: TeamGenerationApi.GenerateTeamsResponse): LocalTeam[] {
  return data.teams.map((t) => ({
    index: t.index,
    members: [...t.members],
  }));
}

function calcAvgRating(members: ReadonlyArray<TeamGenerationApi.GeneratedTeamMember>): number {
  if (members.length === 0) return 0;
  const sum = members.reduce((acc, m) => acc + m.rating, 0);
  return Math.round(sum / members.length);
}

const TEAM_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

export function TeamGeneratorSection({
  teamId,
  eventId,
  rsvpYesAttendees,
  onRefresh,
}: TeamGeneratorSectionProps) {
  const run = useRun();

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const eventIdBranded = Schema.decodeSync(Event.EventId)(eventId);

  const [state, setState] = React.useState<GenerationState>({ _tag: 'initial' });
  const [localTeams, setLocalTeams] = React.useState<LocalTeam[]>([]);
  const [originalTeams, setOriginalTeams] = React.useState<LocalTeam[]>([]);
  const [edited, setEdited] = React.useState(false);

  // Swap mode state
  const [swapMode, setSwapMode] = React.useState(false);
  const [swapSelection, setSwapSelection] = React.useState<{
    teamIndex: number;
    memberId: string;
  } | null>(null);

  // Dialog state
  const [resetDialogOpen, setResetDialogOpen] = React.useState(false);
  const [postDialogOpen, setPostDialogOpen] = React.useState(false);
  const [posting, setPosting] = React.useState(false);

  const eligibleCount = rsvpYesAttendees.length;

  // Derived balance
  const avgRatings = React.useMemo(
    () => localTeams.map((t) => calcAvgRating(t.members)),
    [localTeams],
  );

  const eloDiff = React.useMemo(() => {
    if (avgRatings.length < 2) return 0;
    return Math.abs(avgRatings[0] - avgRatings[1]);
  }, [avgRatings]);

  const handleGenerate = React.useCallback(async () => {
    setState({ _tag: 'loading' });
    setSwapMode(false);
    setSwapSelection(null);
    setEdited(false);

    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.teamGeneration.generateTeams({
          params: { teamId: teamIdBranded, eventId: eventIdBranded },
          payload: { teamCount: Option.none() },
        }),
      ),
      Effect.tapError((e) => Effect.logWarning('teamGen: generateTeams failed', e)),
      Effect.catchTag('TeamGenerationInsufficientPlayers', () =>
        Effect.fail(ClientError.make(tr('teamGen_insufficientPlayers'))),
      ),
      Effect.catchTag('TeamGenerationUnsupportedTeamCount', () =>
        Effect.fail(ClientError.make(tr('teamGen_insufficientPlayers'))),
      ),
      Effect.catchTag('TeamGenerationForbidden', () =>
        Effect.fail(ClientError.make(tr('teamGen_forbidden'))),
      ),
      Effect.catchTag('TeamGenerationEventNotGeneratable', () =>
        Effect.fail(ClientError.make(tr('teamGen_notGeneratable'))),
      ),
      // Preserve the specific messages mapped above; only fall back for unhandled errors.
      Effect.mapError((e) =>
        e._tag === 'ClientError' ? e : ClientError.make(tr('teamGen_generateFailed')),
      ),
      run({}),
    );

    if (Option.isSome(result)) {
      const teams = buildLocalTeams(result.value);
      setLocalTeams(teams);
      setOriginalTeams(teams.map((t) => ({ ...t, members: [...t.members] })));
      setState({ _tag: 'result', data: result.value });
    } else {
      setState({ _tag: 'initial' });
    }
  }, [teamIdBranded, eventIdBranded, run]);

  const handleSwapCardClick = React.useCallback(
    (teamIndex: number, member: TeamGenerationApi.GeneratedTeamMember) => {
      if (!swapMode) return;

      if (swapSelection === null) {
        setSwapSelection({ teamIndex, memberId: member.teamMemberId });
        return;
      }

      if (swapSelection.teamIndex === teamIndex && swapSelection.memberId === member.teamMemberId) {
        // Same card — deselect
        setSwapSelection(null);
        return;
      }

      if (swapSelection.teamIndex === teamIndex) {
        // Same team — reselect within team
        setSwapSelection({ teamIndex, memberId: member.teamMemberId });
        return;
      }

      // Different team — perform swap
      const fromTeamIdx = swapSelection.teamIndex;
      const fromMemberId = swapSelection.memberId;
      const toTeamIdx = teamIndex;
      const toMemberId = member.teamMemberId;

      setLocalTeams((prev) => {
        const next = prev.map((t) => ({ ...t, members: [...t.members] }));
        const fromTeam = next.find((t) => t.index === fromTeamIdx);
        const toTeam = next.find((t) => t.index === toTeamIdx);
        if (!fromTeam || !toTeam) return prev;

        const fromIdx = fromTeam.members.findIndex((m) => m.teamMemberId === fromMemberId);
        const toIdx = toTeam.members.findIndex((m) => m.teamMemberId === toMemberId);
        if (fromIdx === -1 || toIdx === -1) return prev;

        const tmp = fromTeam.members[fromIdx];
        fromTeam.members[fromIdx] = toTeam.members[toIdx];
        toTeam.members[toIdx] = tmp;
        return next;
      });

      setEdited(true);
      setSwapSelection(null);
    },
    [swapMode, swapSelection],
  );

  const handleResetConfirm = () => {
    setResetDialogOpen(false);
    setLocalTeams(originalTeams.map((t) => ({ ...t, members: [...t.members] })));
    setEdited(false);
    setSwapSelection(null);
  };

  const handlePostConfirm = React.useCallback(async () => {
    setPostDialogOpen(false);
    setPosting(true);

    // Send only member IDs per team; the server re-loads names/ratings from DB
    // to prevent embed injection / rating spoofing.
    const teamsPayload = localTeams.map((t) => ({
      memberIds: t.members.map((m) => m.teamMemberId),
    }));

    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.teamGeneration.postTeamsToDiscord({
          params: { teamId: teamIdBranded, eventId: eventIdBranded },
          payload: { teams: teamsPayload },
        }),
      ),
      Effect.tapError((e) => Effect.logWarning('teamGen: postTeamsToDiscord failed', e)),
      Effect.catchTag('TeamGenerationForbidden', () =>
        Effect.fail(ClientError.make(tr('teamGen_forbidden'))),
      ),
      Effect.catchTag('TeamGenerationEventNotGeneratable', () =>
        Effect.fail(ClientError.make(tr('teamGen_notGeneratable'))),
      ),
      Effect.catchTag('TeamGenerationRosterChanged', () => {
        onRefresh();
        return Effect.fail(ClientError.make(tr('teamGen_rosterChanged')));
      }),
      Effect.catchTag('TeamGenerationPostPending', () =>
        Effect.fail(ClientError.make(tr('teamGen_postPending'))),
      ),
      Effect.catchTag('TeamGenerationDiscordPostFailed', () => {
        onRefresh();
        return Effect.fail(ClientError.make(tr('teamGen_postFailed')));
      }),
      // Preserve the specific messages mapped above; only fall back for unhandled errors.
      Effect.mapError((e) =>
        e._tag === 'ClientError' ? e : ClientError.make(tr('teamGen_postFailed')),
      ),
      run({ success: tr('teamGen_postSuccess') }),
    );

    setPosting(false);

    if (Option.isSome(result)) {
      setState((prev) => {
        if (prev._tag === 'result' || prev._tag === 'posted') {
          return { _tag: 'posted', data: prev.data };
        }
        return prev;
      });
    }
  }, [localTeams, teamIdBranded, eventIdBranded, run, onRefresh]);

  const generateDisabledReason = eligibleCount < 2 ? tr('teamGen_insufficientPlayers') : undefined;
  const generateHelpId = 'team-gen-generate-help';

  const isResultOrPosted = state._tag === 'result' || state._tag === 'posted';

  return (
    <>
      <Card className='mb-6' id='team-generator'>
        <CardHeader>
          <div className='flex items-center justify-between gap-2 flex-wrap'>
            <CardTitle className='text-base'>{tr('teamGen_section')}</CardTitle>
            {state._tag === 'posted' && <Badge variant='secondary'>{tr('teamGen_posted')}</Badge>}
            {edited && state._tag !== 'posted' && (
              <Badge variant='outline'>{tr('teamGen_edited')}</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className='flex flex-col gap-4'>
          {/* Empty state */}
          {eligibleCount === 0 && state._tag === 'initial' && (
            <div className='flex flex-col gap-1'>
              <p className='text-sm text-muted-foreground'>{tr('teamGen_emptyNoAttendees')}</p>
              <p className='text-xs text-muted-foreground'>{tr('teamGen_emptyHint')}</p>
            </div>
          )}

          {/* Initial state with attendees */}
          {state._tag === 'initial' && eligibleCount > 0 && (
            <p className='text-sm text-muted-foreground'>
              {tr('teamGen_sectionDescription')}{' '}
              {tr('teamGen_eligibleCount', { count: eligibleCount })}
            </p>
          )}

          {/* Toolbar */}
          <div className='flex flex-wrap gap-2 items-center'>
            {state._tag === 'initial' || state._tag === 'loading' ? (
              <Button
                onClick={handleGenerate}
                disabled={state._tag === 'loading' || !!generateDisabledReason}
                aria-describedby={generateDisabledReason ? generateHelpId : undefined}
              >
                {state._tag === 'loading' ? tr('teamGen_generating') : tr('teamGen_generate')}
              </Button>
            ) : (
              <>
                <Button variant='outline' onClick={handleGenerate}>
                  {tr('teamGen_regenerate')}
                </Button>
                {isResultOrPosted && (
                  <>
                    <Button
                      variant={swapMode ? 'default' : 'outline'}
                      size='sm'
                      onClick={() => {
                        setSwapMode((v) => !v);
                        setSwapSelection(null);
                      }}
                    >
                      {tr('teamGen_swapMode')}
                    </Button>
                    {edited && (
                      <Button variant='ghost' size='sm' onClick={() => setResetDialogOpen(true)}>
                        {tr('teamGen_resetToGenerated')}
                      </Button>
                    )}
                    <Button onClick={() => setPostDialogOpen(true)} disabled={posting} size='sm'>
                      {posting
                        ? tr('teamGen_posting')
                        : state._tag === 'posted'
                          ? tr('teamGen_repost')
                          : tr('teamGen_postToDiscord')}
                    </Button>
                  </>
                )}
              </>
            )}
          </div>

          {generateDisabledReason && state._tag === 'initial' && (
            <p id={generateHelpId} className='text-xs text-muted-foreground'>
              {generateDisabledReason}
            </p>
          )}

          {/* Swap mode hint */}
          {swapMode && (
            <p className='text-xs text-muted-foreground' aria-live='polite'>
              {tr('teamGen_swapModeActive')}
            </p>
          )}

          {/* Loading skeleton */}
          {state._tag === 'loading' && (
            <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
              {['skeleton-team-a', 'skeleton-team-b'].map((teamKey) => (
                <div key={teamKey} className='flex flex-col gap-2'>
                  <Skeleton className='h-6 w-32' />
                  {[
                    `${teamKey}-row-0`,
                    `${teamKey}-row-1`,
                    `${teamKey}-row-2`,
                    `${teamKey}-row-3`,
                  ].map((rowKey) => (
                    <Skeleton key={rowKey} className='h-12 w-full' />
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Results */}
          {isResultOrPosted && (
            <>
              {/* Balance summary */}
              <p aria-live='polite' className='text-sm text-muted-foreground'>
                {avgRatings.length >= 2
                  ? tr('teamGen_balanceSummary', {
                      avg1: avgRatings[0],
                      avg2: avgRatings[1],
                      diff: eloDiff,
                    })
                  : null}
              </p>

              {/* Warnings */}
              {state.data.warnings.length > 0 && (
                <div className='flex flex-col gap-2'>
                  {state.data.warnings.map((w) => (
                    <div
                      key={w._tag === 'EloOutlier' ? `${w._tag}-${w.teamMemberId}` : w._tag}
                      className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800'
                      role='alert'
                    >
                      {w._tag === 'UnevenTeamSizes' && tr('teamGen_warningUnevenTeamSizes')}
                      {w._tag === 'InsufficientGenderMix' &&
                        tr('teamGen_warningInsufficientGenderMix')}
                      {w._tag === 'EloOutlier' && tr('teamGen_warningEloOutlier')}
                    </div>
                  ))}
                </div>
              )}

              {/* Team columns */}
              <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
                {localTeams.map((team, teamIdx) => {
                  const color = TEAM_COLORS[teamIdx] ?? '#6b7280';
                  const avgRating = avgRatings[teamIdx] ?? 0;
                  return (
                    <section
                      key={team.index}
                      aria-label={tr('teamGen_teamName', { n: team.index + 1 })}
                    >
                      <div className='flex items-center gap-2 mb-2'>
                        <span
                          className='w-3 h-3 rounded-full shrink-0'
                          style={{ backgroundColor: color }}
                          aria-hidden='true'
                        />
                        <h3 className='font-medium text-sm'>
                          {tr('teamGen_teamName', { n: team.index + 1 })}
                        </h3>
                        <span className='text-xs text-muted-foreground ml-auto'>
                          {tr('teamGen_playerCount', { count: team.members.length })}
                          {' · '}
                          {tr('teamGen_avgElo', { rating: avgRating })}
                        </span>
                      </div>
                      <div className='flex flex-col gap-1'>
                        {team.members.map((member) => {
                          const isSelected =
                            swapSelection !== null &&
                            swapSelection.teamIndex === team.index &&
                            swapSelection.memberId === member.teamMemberId;

                          return (
                            <PlayerCard
                              key={member.teamMemberId}
                              player={member}
                              selectable={swapMode}
                              selected={isSelected}
                              onSelect={() => handleSwapCardClick(team.index, member)}
                              teamColor={color}
                            />
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>

              <p className='text-xs text-muted-foreground'>
                {tr('teamGen_iterationsUsed', { n: state.data.iterationsUsed })}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Reset dialog */}
      <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr('teamGen_resetConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{tr('teamGen_resetConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('teamGen_resetConfirmCancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleResetConfirm}>
              {tr('teamGen_resetConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Post to Discord confirm dialog */}
      <AlertDialog open={postDialogOpen} onOpenChange={setPostDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr('teamGen_postConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{tr('teamGen_postConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('teamGen_postConfirmCancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handlePostConfirm}>
              {tr('teamGen_postConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
