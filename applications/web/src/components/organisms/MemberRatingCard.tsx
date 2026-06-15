import type { PlayerRatingApi } from '@sideline/domain';
import { Option } from 'effect';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { Badge } from '~/components/ui/badge.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '~/components/ui/tooltip.js';
import { tr } from '~/lib/translations.js';

interface MemberRatingCardProps {
  rating: PlayerRatingApi.MemberRatingResponse;
}

export function MemberRatingCard({ rating }: MemberRatingCardProps) {
  const isEmpty = rating.gamesPlayed === 0;

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
        <p className='text-muted-foreground'>{tr('members_ratingNoGames')}</p>
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
