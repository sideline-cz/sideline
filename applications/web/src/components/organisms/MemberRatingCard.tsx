import type { PlayerRatingApi } from '@sideline/domain';
import { Team, TeamMember } from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import { Minus, Sparkles, TrendingDown, TrendingUp } from 'lucide-react';
import React from 'react';
import { RatingFromDescription } from '~/components/organisms/RatingFromDescription.js';
import { Badge } from '~/components/ui/badge.js';
import { Button } from '~/components/ui/button.js';
import { Skeleton } from '~/components/ui/skeleton.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '~/components/ui/tooltip.js';
import { ApiClient, SilentClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

type InsightState =
  | { _tag: 'idle' }
  | { _tag: 'loading' }
  | { _tag: 'loaded'; insight: string; generated: boolean }
  | { _tag: 'error' };

interface MemberRatingCardProps {
  rating: PlayerRatingApi.MemberRatingResponse;
  teamId?: string;
  teamMemberId?: string;
  onRefresh?: () => void;
}

export function MemberRatingCard({
  rating,
  teamId,
  teamMemberId,
  onRefresh,
}: MemberRatingCardProps) {
  const isEmpty = rating.gamesPlayed === 0;
  const run = useRun();

  const [insightState, setInsightState] = React.useState<InsightState>({ _tag: 'idle' });

  const handleGenerateInsight = React.useCallback(async () => {
    if (!teamId || !teamMemberId) return;
    setInsightState({ _tag: 'loading' });

    const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
    const memberIdBranded = Schema.decodeSync(TeamMember.TeamMemberId)(teamMemberId);

    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.playerRating.getRatingInsight({
          params: { teamId: teamIdBranded, memberId: memberIdBranded },
        }),
      ),
      Effect.tapError((e) => Effect.logWarning('MemberRatingCard: getRatingInsight failed', e)),
      Effect.mapError((e) => new SilentClientError({ message: String(e) })),
      run({}),
    );

    if (Option.isSome(result)) {
      setInsightState({
        _tag: 'loaded',
        insight: result.value.insight,
        generated: result.value.generated,
      });
    } else {
      setInsightState({ _tag: 'error' });
    }
  }, [teamId, teamMemberId, run]);

  return (
    <div className='mt-6'>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <h2 className='text-lg font-semibold mb-4 w-fit cursor-default'>
              {tr('members_ratingTitle')}
            </h2>
          </TooltipTrigger>
          <TooltipContent>
            <p>{tr('members_ratingTooltip')}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {isEmpty ? (
        <>
          <p className='text-muted-foreground'>{tr('members_ratingNoGames')}</p>
          {teamId && teamMemberId && onRefresh ? (
            <RatingFromDescription
              teamId={teamId}
              teamMemberId={teamMemberId}
              onRefresh={onRefresh}
            />
          ) : null}
        </>
      ) : (
        <>
          <div className='flex items-center gap-3 mb-4'>
            <p className='text-3xl font-bold tabular-nums'>{rating.rating}</p>
            {rating.isCalibrating ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant='secondary'>
                      {tr('members_ratingCalibratingBadge', {
                        played: rating.gamesPlayed,
                        threshold: rating.calibrationThreshold,
                      })}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      {tr('members_ratingCalibratingHint', {
                        threshold: rating.calibrationThreshold,
                      })}
                    </p>
                    {Option.isSome(rating.previousRating) ? (
                      <p>
                        {tr('members_ratingPreviousTooltip', {
                          previous: rating.previousRating.value,
                          current: rating.rating,
                        })}
                      </p>
                    ) : null}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <>
                {Option.isSome(rating.lastDelta) ? (
                  <TrendPill delta={rating.lastDelta.value} />
                ) : null}
                {Option.isSome(rating.previousRating) ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className='text-sm text-muted-foreground cursor-default underline decoration-dotted'>
                          {rating.previousRating.value}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>
                          {tr('members_ratingPreviousTooltip', {
                            previous: rating.previousRating.value,
                            current: rating.rating,
                          })}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : null}
              </>
            )}
          </div>

          <div className='grid grid-cols-3 gap-4'>
            <div>
              <p className='text-xl font-semibold tabular-nums'>{rating.wins}</p>
              <p className='text-sm text-muted-foreground'>{tr('members_ratingWins')}</p>
            </div>
            <div>
              <p className='text-xl font-semibold tabular-nums'>{rating.losses}</p>
              <p className='text-sm text-muted-foreground'>{tr('members_ratingLosses')}</p>
            </div>
            <div>
              <p className='text-xl font-semibold tabular-nums'>{rating.draws}</p>
              <p className='text-sm text-muted-foreground'>{tr('members_ratingDraws')}</p>
            </div>
          </div>

          {rating.isCalibrating ? (
            <div className='mt-3'>
              <div className='flex justify-between text-xs text-muted-foreground mb-1'>
                <span>
                  {rating.gamesPlayed} / {rating.calibrationThreshold}
                </span>
              </div>
              <div className='h-1.5 w-full rounded-full bg-secondary overflow-hidden'>
                <div
                  className='h-full rounded-full bg-primary transition-all'
                  style={{
                    width: `${Math.min(100, (rating.gamesPlayed / rating.calibrationThreshold) * 100)}%`,
                  }}
                />
              </div>
            </div>
          ) : null}

          {/* AI Form Insight — only shown when player has games and teamId/teamMemberId are provided */}
          {teamId && teamMemberId ? (
            <div className='mt-4'>
              <p className='text-sm font-medium mb-2'>{tr('members_ratingFormLabel')}</p>
              {insightState._tag === 'idle' && (
                <Button
                  variant='ghost'
                  size='sm'
                  className='text-muted-foreground hover:text-foreground gap-1.5'
                  onClick={handleGenerateInsight}
                >
                  <Sparkles className='size-3.5' aria-hidden='true' />
                  {tr('members_ratingFormGenerate')}
                </Button>
              )}
              {insightState._tag === 'loading' && (
                <div
                  className='flex flex-col gap-1.5'
                  role='status'
                  aria-label={tr('members_ratingFormGenerating')}
                >
                  <Skeleton className='h-4 w-full' />
                  <Skeleton className='h-4 w-3/4' />
                </div>
              )}
              {insightState._tag === 'loaded' && (
                <div className='flex items-start gap-2'>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className={`mt-1 inline-block size-2 shrink-0 rounded-full ${insightState.generated ? 'bg-primary' : 'bg-muted-foreground'}`}
                          aria-hidden='true'
                        />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>
                          {insightState.generated
                            ? tr('members_ratingFormSourceAi')
                            : tr('members_ratingFormSourceFallback')}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <p
                    aria-live='polite'
                    className='text-sm text-muted-foreground italic leading-snug'
                  >
                    {insightState.insight}
                  </p>
                </div>
              )}
              {insightState._tag === 'error' && (
                <p className='text-sm text-muted-foreground'>
                  {tr('members_ratingFormUnavailable')}
                </p>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function TrendPill({ delta }: { delta: number }) {
  if (delta > 0) {
    return (
      <span className='inline-flex items-center gap-1 text-sm text-green-600'>
        <TrendingUp className='size-4' aria-hidden='true' />
        {tr('members_ratingTrendUp', { delta: `+${delta}` })}
      </span>
    );
  }

  if (delta < 0) {
    return (
      <span className='inline-flex items-center gap-1 text-sm text-red-600'>
        <TrendingDown className='size-4' aria-hidden='true' />
        {tr('members_ratingTrendDown', { delta: String(delta) })}
      </span>
    );
  }

  return (
    <span className='inline-flex items-center gap-1 text-sm text-muted-foreground'>
      <Minus className='size-4' aria-hidden='true' />
      {tr('members_ratingTrendFlat')}
    </span>
  );
}
