/**
 * Read-only view of the Rules Trainer's server-side progress (Phase 2 step
 * 12 of `docs/plans/rules-trainer.md`) — mastery decays (see
 * `packages/rules/src/engine/mastery.ts`), so this must convey "fading" as
 * much as "achieved".
 *
 * Self-contained data-fetching organism, mirroring
 * `PendingDiscordJoinBanner`'s pattern (`useState` + `useEffect` + `useRun`,
 * no loader): the caller only ever supplies `locale`/`isSignedIn` (and an
 * optional `refreshToken` to force a refetch after a submit or an import),
 * never the summary itself.
 *
 * Guarded on `isSignedIn` INSIDE this component, not only by the caller —
 * `GET /rules/progress` requires auth (`AuthMiddleware`), so calling it
 * while signed out would just 401. When signed out, this renders nothing
 * but a quiet `rules_signInToSave` hint — no mastery rows, no network call.
 */
import type { RulesProgress } from '@sideline/domain';
import type { Lang } from '@sideline/rules';
import { LEVEL_META, text } from '@sideline/rules';
import { Effect } from 'effect';
import React from 'react';
import { Badge } from '~/components/ui/badge';
import { Card, CardContent } from '~/components/ui/card';
import { isLevel } from '~/lib/rules/level.js';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface RulesProgressPanelProps {
  readonly locale: Lang;
  readonly isSignedIn: boolean;
  /** Bump (e.g. `n => n + 1`) to force a refetch — the summary otherwise
   * only loads once per `isSignedIn` transition. */
  readonly refreshToken?: number;
}

/** A plain styled div bar — there is no `progress` shadcn primitive
 * installed, and the generator must not be run for this feature. */
function StrengthBar({ label, strength }: { readonly label: string; readonly strength: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(strength * 100)));
  return (
    <div
      role='progressbar'
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className='h-2 w-full overflow-hidden rounded-full bg-muted'
    >
      <div className='h-full rounded-full bg-primary' style={{ width: `${pct}%` }} />
    </div>
  );
}

export function RulesProgressPanel({
  locale,
  isSignedIn,
  refreshToken = 0,
}: RulesProgressPanelProps) {
  const run = useRun();
  const [summary, setSummary] = React.useState<RulesProgress.RulesMasterySummary | null>(null);

  // `refreshToken` is never read in the body below — it exists purely so a
  // caller can force this effect to re-run (bumping it after a submit or an
  // import) without this component exposing an imperative refetch method.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken is a deliberate re-fetch trigger, not a value read here
  React.useEffect(() => {
    // Never call `myProgress` while signed out — it would 401 (see
    // `RulesTrainerApi`'s `AuthMiddleware`). This is the load-bearing guard;
    // callers additionally choose not to mount the mastery UI at all, but
    // this component does not rely on that.
    if (!isSignedIn) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    void ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.rulesTrainer.myProgress()),
      Effect.tap((result) =>
        Effect.sync(() => {
          if (!cancelled) setSummary(result);
        }),
      ),
      Effect.mapError(() => ClientError.make('')),
      run(),
    );
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, refreshToken, run]);

  if (!isSignedIn) {
    return (
      <p className='text-xs text-muted-foreground'>
        {tr('rules_signInToSave', undefined, { locale })}
      </p>
    );
  }

  // Still loading (or the fetch failed silently, per `useRun`'s own toast) —
  // never render a stale/blank mastery panel in either case.
  if (summary === null) return null;

  const hasAnyProgress = summary.packages.some((p) => p.everCorrectCount > 0);

  return (
    <Card>
      <CardContent className='flex flex-col gap-3'>
        <h2 className='text-lg font-semibold'>
          {tr('rules_progressTitle', undefined, { locale })}
        </h2>

        {!hasAnyProgress && (
          <p className='text-sm text-muted-foreground'>
            {tr('rules_progressEmpty', undefined, { locale })}
          </p>
        )}

        {hasAnyProgress && (
          <>
            <div className='flex flex-col gap-3'>
              {summary.packages
                .filter((p) => isLevel(p.level))
                .map((p) => {
                  // `isLevel` was just checked by the filter above, but a
                  // `.filter` predicate does not narrow `p.level` for the
                  // rest of this closure — re-check so `LEVEL_META[p.level]`
                  // never needs a cast.
                  if (!isLevel(p.level)) return null;
                  const name = text(LEVEL_META[p.level].name, locale);
                  return (
                    <div key={p.level} className='flex flex-col gap-1'>
                      <div className='flex flex-wrap items-center justify-between gap-2 text-sm'>
                        <span className='font-medium'>{name}</span>
                        <div className='flex items-center gap-2'>
                          {p.mastered && (
                            <Badge variant='secondary'>
                              {tr('rules_progressMastered', undefined, { locale })}
                            </Badge>
                          )}
                          <span className='text-xs text-muted-foreground'>
                            {tr(
                              'rules_progressFresh',
                              { fresh: p.freshCount, total: p.total },
                              { locale },
                            )}
                          </span>
                        </div>
                      </div>
                      <StrengthBar label={name} strength={p.strength} />
                    </div>
                  );
                })}
            </div>

            <div className='flex flex-col gap-1 border-t pt-3'>
              <div className='flex flex-wrap items-center justify-between gap-2 text-sm'>
                <span className='font-medium'>
                  {tr('rules_progressOverall', undefined, { locale })}
                </span>
                <span className='text-xs text-muted-foreground'>
                  {tr(
                    'rules_progressMasteredCount',
                    { count: summary.overall.masteredCount, total: summary.packages.length },
                    { locale },
                  )}
                </span>
              </div>
              <StrengthBar
                label={tr('rules_progressOverall', undefined, { locale })}
                strength={summary.overall.strength}
              />
            </div>

            <p className='text-xs text-muted-foreground'>
              {tr('rules_progressDecayNote', undefined, { locale })}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
