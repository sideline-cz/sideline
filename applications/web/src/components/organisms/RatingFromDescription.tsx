import { Team, TeamMember } from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import { Check, Loader2, Sparkles } from 'lucide-react';
import React from 'react';
import { Badge } from '~/components/ui/badge.js';
import { Button } from '~/components/ui/button.js';
import { Input } from '~/components/ui/input.js';
import { Label } from '~/components/ui/label.js';
import { Textarea } from '~/components/ui/textarea.js';
import { ApiClient, ClientError, SilentClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const DESC_MAX = 280;
const RATING_MIN = 800;
const RATING_MAX = 1800;
const RATING_STEP = 25;

type RatingFromDescriptionState =
  | { _tag: 'idle' }
  | { _tag: 'describing'; text: string }
  | { _tag: 'loadingSuggestion'; text: string }
  | {
      _tag: 'suggestion';
      text: string;
      suggestedRating: number;
      currentRating: number;
      rationale: string;
      generated: boolean;
      minRating: number;
      maxRating: number;
    }
  | {
      _tag: 'applying';
      text: string;
      currentRating: number;
      rationale: string;
      generated: boolean;
      minRating: number;
      maxRating: number;
    }
  | { _tag: 'error'; text: string };

interface RatingFromDescriptionProps {
  teamId: string;
  teamMemberId: string;
  onRefresh: () => void;
}

export function RatingFromDescription({
  teamId,
  teamMemberId,
  onRefresh,
}: RatingFromDescriptionProps) {
  const run = useRun();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const memberIdBranded = Schema.decodeSync(TeamMember.TeamMemberId)(teamMemberId);

  const [state, setState] = React.useState<RatingFromDescriptionState>({ _tag: 'idle' });

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const numberInputRef = React.useRef<HTMLInputElement>(null);

  // Autofocus textarea when entering describing state
  React.useEffect(() => {
    if (state._tag === 'describing') {
      textareaRef.current?.focus();
    }
  }, [state._tag]);

  // Move focus to number input when suggestion arrives
  React.useEffect(() => {
    if (state._tag === 'suggestion') {
      numberInputRef.current?.focus();
    }
  }, [state._tag]);

  const handleOpenDescribing = () => {
    setState({ _tag: 'describing', text: '' });
  };

  const handleCancel = () => {
    setState({ _tag: 'idle' });
  };

  const handleTextChange = (text: string) => {
    if (state._tag === 'describing') {
      setState({ _tag: 'describing', text });
    }
  };

  const handleSuggest = React.useCallback(async () => {
    if (state._tag !== 'describing') return;
    const { text } = state;

    setState({ _tag: 'loadingSuggestion', text });

    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.playerRating.estimateRatingFromDescription({
          params: { teamId: teamIdBranded, memberId: memberIdBranded },
          payload: { description: text },
        }),
      ),
      Effect.tapError((e) => Effect.logWarning('RatingFromDescription: suggest failed', e)),
      // Use SilentClientError so no toast fires — we show inline amber box instead
      Effect.mapError((e) => new SilentClientError({ message: String(e) })),
      run({}),
    );

    if (Option.isSome(result)) {
      const r = result.value;
      setState({
        _tag: 'suggestion',
        text,
        suggestedRating: r.suggestedRating,
        currentRating: r.suggestedRating,
        rationale: r.rationale,
        generated: r.generated,
        minRating: r.minRating,
        maxRating: r.maxRating,
      });
    } else {
      setState({ _tag: 'error', text });
    }
  }, [state, teamIdBranded, memberIdBranded, run]);

  const handleRetry = React.useCallback(async () => {
    if (state._tag !== 'error') return;
    const text = state.text;
    setState({ _tag: 'loadingSuggestion', text });
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.playerRating.estimateRatingFromDescription({
          params: { teamId: teamIdBranded, memberId: memberIdBranded },
          payload: { description: text },
        }),
      ),
      Effect.tapError((e) => Effect.logWarning('RatingFromDescription: retry failed', e)),
      // Use SilentClientError so no toast fires — we show inline amber box instead
      Effect.mapError((e) => new SilentClientError({ message: String(e) })),
      run({}),
    );

    if (Option.isSome(result)) {
      const r = result.value;
      setState({
        _tag: 'suggestion',
        text,
        suggestedRating: r.suggestedRating,
        currentRating: r.suggestedRating,
        rationale: r.rationale,
        generated: r.generated,
        minRating: r.minRating,
        maxRating: r.maxRating,
      });
    } else {
      setState({ _tag: 'error', text });
    }
  }, [state, teamIdBranded, memberIdBranded, run]);

  const handleRatingChange = (value: number) => {
    if (state._tag !== 'suggestion') return;
    const clamped = Math.max(state.minRating, Math.min(state.maxRating, value));
    setState({ ...state, currentRating: clamped });
  };

  const handleRatingInputChange = (raw: string) => {
    if (state._tag !== 'suggestion') return;
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) {
      setState({ ...state, currentRating: parsed });
    } else {
      setState({ ...state, currentRating: NaN });
    }
  };

  const handleEditText = () => {
    if (state._tag !== 'suggestion') return;
    setState({ _tag: 'describing', text: state.text });
  };

  const handleApply = React.useCallback(async () => {
    if (state._tag !== 'suggestion') return;
    const { currentRating, text, rationale, generated, minRating, maxRating } = state;

    setState({ _tag: 'applying', text, currentRating, rationale, generated, minRating, maxRating });

    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.playerRating.applySeedRating({
          params: { teamId: teamIdBranded, memberId: memberIdBranded },
          payload: { rating: currentRating },
        }),
      ),
      Effect.catchTag('PlayerRatingSeedNotAllowed', () => {
        onRefresh();
        return Effect.fail(ClientError.make(tr('members_ratingAlreadyRated')));
      }),
      Effect.mapError((e) =>
        e._tag === 'ClientError' ? e : ClientError.make(tr('members_ratingSuggestFailed')),
      ),
      run({ success: tr('members_ratingApplied') }),
    );

    if (Option.isSome(result)) {
      onRefresh();
      setState({ _tag: 'idle' });
    } else {
      // On error, go back to suggestion so captain can retry or cancel
      setState({
        _tag: 'suggestion',
        text,
        suggestedRating: currentRating,
        currentRating,
        rationale,
        generated,
        minRating,
        maxRating,
      });
    }
  }, [state, teamIdBranded, memberIdBranded, run, onRefresh]);

  if (state._tag === 'idle') {
    return (
      <div className='mt-3'>
        <Button variant='outline' size='sm' onClick={handleOpenDescribing}>
          <Sparkles className='size-4 mr-1.5' aria-hidden='true' />
          {tr('members_ratingSuggestEntry')}
        </Button>
      </div>
    );
  }

  if (state._tag === 'error') {
    return (
      <div className='mt-3 flex flex-col gap-2'>
        <div
          role='alert'
          className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800'
        >
          {tr('members_ratingSuggestFailed')}
        </div>
        <div className='flex gap-2'>
          <Button size='sm' onClick={handleRetry}>
            {tr('members_ratingRetry')}
          </Button>
          <Button variant='ghost' size='sm' onClick={handleCancel}>
            {tr('members_ratingCancel')}
          </Button>
        </div>
      </div>
    );
  }

  if (state._tag === 'describing' || state._tag === 'loadingSuggestion') {
    const isLoading = state._tag === 'loadingSuggestion';
    const text = state.text;
    const trimmedLength = text.trim().length;
    const descHintId = 'rating-desc-hint';
    const descCounterId = 'rating-desc-counter';
    const descEmptyId = 'rating-desc-empty';
    const canSuggest = trimmedLength >= 3 && !isLoading;

    return (
      <div className='mt-3 flex flex-col gap-3'>
        <div className='flex flex-col gap-1'>
          <Label htmlFor='rating-desc-textarea'>{tr('members_ratingDescLabel')}</Label>
          <Textarea
            id='rating-desc-textarea'
            ref={textareaRef}
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            placeholder={tr('members_ratingDescPlaceholder')}
            maxLength={DESC_MAX}
            disabled={isLoading}
            aria-describedby={`${descHintId} ${descCounterId}${!canSuggest && trimmedLength < 3 ? ` ${descEmptyId}` : ''}`}
            className='resize-none'
            rows={3}
          />
          <div className='flex items-center justify-between gap-2'>
            <p id={descHintId} className='text-xs text-muted-foreground'>
              {tr('members_ratingDescHint')}
            </p>
            <p
              id={descCounterId}
              aria-live='polite'
              className='text-xs text-muted-foreground tabular-nums'
            >
              {tr('members_ratingDescCounter', { count: text.length, max: DESC_MAX })}
            </p>
          </div>
          {!canSuggest && trimmedLength < 3 && text.length > 0 && (
            <p id={descEmptyId} className='text-xs text-muted-foreground'>
              {tr('members_ratingDescEmpty')}
            </p>
          )}
          {trimmedLength === 0 && (
            <p id={descEmptyId} className='text-xs text-muted-foreground sr-only'>
              {tr('members_ratingDescEmpty')}
            </p>
          )}
        </div>
        {isLoading && (
          <p aria-live='polite' className='text-xs text-muted-foreground'>
            {tr('members_ratingSuggesting')}
          </p>
        )}
        <div className='flex gap-2'>
          <Button
            size='sm'
            disabled={!canSuggest}
            aria-describedby={!canSuggest ? descEmptyId : undefined}
            onClick={handleSuggest}
          >
            {isLoading ? (
              <>
                <Loader2 className='size-4 mr-1.5 animate-spin' aria-hidden='true' />
                {tr('members_ratingSuggesting')}
              </>
            ) : (
              tr('members_ratingSuggest')
            )}
          </Button>
          <Button variant='ghost' size='sm' disabled={isLoading} onClick={handleCancel}>
            {tr('members_ratingCancel')}
          </Button>
        </div>
      </div>
    );
  }

  if (state._tag === 'suggestion' || state._tag === 'applying') {
    const isApplying = state._tag === 'applying';
    const { currentRating, rationale, generated, minRating, maxRating } = state;
    const suggestedRating = state._tag === 'suggestion' ? state.suggestedRating : currentRating;

    const ratingIsValid =
      !Number.isNaN(currentRating) && currentRating >= RATING_MIN && currentRating <= RATING_MAX;
    const isEdited = currentRating !== suggestedRating;
    const ratingInvalidId = 'rating-value-invalid';
    const rationaleId = 'rating-rationale';

    const badgeLabel = () => {
      if (!generated) return tr('members_ratingFallbackBadge');
      if (isEdited) return tr('members_ratingEdited');
      return tr('members_ratingAiBadge');
    };

    return (
      <div className='mt-3 flex flex-col gap-3'>
        <div className='flex flex-col gap-1'>
          <Label htmlFor='rating-number-input'>{tr('members_ratingSuggestedLabel')}</Label>
          <div className='flex items-center gap-2'>
            <Button
              type='button'
              variant='outline'
              size='sm'
              disabled={isApplying || currentRating <= minRating}
              aria-label={tr('members_ratingDecrease')}
              onClick={() => handleRatingChange(currentRating - RATING_STEP)}
            >
              −
            </Button>
            <Input
              id='rating-number-input'
              ref={numberInputRef}
              type='number'
              value={Number.isNaN(currentRating) ? '' : currentRating}
              onChange={(e) => handleRatingInputChange(e.target.value)}
              min={minRating}
              max={maxRating}
              step={RATING_STEP}
              disabled={isApplying}
              aria-describedby={!ratingIsValid ? ratingInvalidId : rationaleId}
              className='w-24 text-center tabular-nums'
            />
            <Button
              type='button'
              variant='outline'
              size='sm'
              disabled={isApplying || currentRating >= maxRating}
              aria-label={tr('members_ratingIncrease')}
              onClick={() => handleRatingChange(currentRating + RATING_STEP)}
            >
              +
            </Button>
            <Badge variant={generated && !isEdited ? 'default' : 'secondary'}>{badgeLabel()}</Badge>
          </div>
          {!ratingIsValid && (
            <p id={ratingInvalidId} className='text-xs text-destructive'>
              {tr('members_ratingValueInvalid')}
            </p>
          )}
          <p id={rationaleId} aria-live='polite' className='text-xs text-muted-foreground italic'>
            {rationale}
          </p>
        </div>
        {isApplying && (
          <p aria-live='polite' className='text-xs text-muted-foreground'>
            {tr('members_ratingApplying')}
          </p>
        )}
        <div className='flex gap-2 flex-wrap'>
          <Button
            size='sm'
            disabled={!ratingIsValid || isApplying}
            aria-describedby={!ratingIsValid ? ratingInvalidId : undefined}
            onClick={handleApply}
          >
            {isApplying ? (
              <>
                <Loader2 className='size-4 mr-1.5 animate-spin' aria-hidden='true' />
                {tr('members_ratingApplying')}
              </>
            ) : (
              <>
                <Check className='size-4 mr-1.5' aria-hidden='true' />
                {tr('members_ratingApply')}
              </>
            )}
          </Button>
          {state._tag === 'suggestion' && (
            <Button variant='outline' size='sm' onClick={handleEditText}>
              {tr('members_ratingEditText')}
            </Button>
          )}
          <Button variant='ghost' size='sm' disabled={isApplying} onClick={handleCancel}>
            {tr('members_ratingCancel')}
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
