import type { RulesTrainerApi } from '@sideline/domain';
import { getLocale } from '@sideline/i18n/runtime';
import { LEVELS } from '@sideline/rules';
import { RulesTrainer } from '~/components/organisms/RulesTrainer.js';
import { Badge } from '~/components/ui/badge';
import { Card, CardContent } from '~/components/ui/card';
import { VERDICT } from '~/lib/rules/palette.js';
import { strengthPercent } from '~/lib/rules/strength.js';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

interface TeamRulesPageProps {
  readonly leaderboard: RulesTrainerApi.RulesLeaderboardResponse;
}

/**
 * Same `[0, 100]` clamp-and-round as `RulesProgressPanel`'s (unexported)
 * `StrengthBar` helper, so a member's own progress panel and their row on
 * this leaderboard never disagree on how a decayed `strength` rounds to a
 * percentage.
 */
function formatStrength(strength: number): string {
  const pct = strengthPercent(strength);
  return `${pct}%`;
}

/**
 * Medal colours for the top three, muted for everyone else — the same
 * treatment (and the same literal Tailwind classes) as the activity
 * leaderboard's `RankBadge` in `LeaderboardPage.tsx`, so the two
 * leaderboards in this app do not rank people in two different visual
 * languages.
 */
function RankBadge({ rank, label }: { readonly rank: number; readonly label: string }) {
  const medal =
    rank === 1
      ? 'bg-yellow-400 text-yellow-900 font-bold dark:bg-yellow-500 dark:text-yellow-950'
      : rank === 2
        ? 'bg-slate-300 text-slate-700 font-bold dark:bg-slate-400 dark:text-slate-900'
        : rank === 3
          ? 'bg-amber-600 text-amber-50 font-bold dark:bg-amber-700'
          : 'bg-muted text-muted-foreground font-medium';

  return (
    <div
      className={cn('flex size-8 shrink-0 items-center justify-center rounded-full text-sm', medal)}
    >
      <span className='sr-only'>{label}</span>
      {rank}
    </div>
  );
}

/**
 * The team's Rules Trainer page — the trainer itself, plus this team's
 * leaderboard (Phase 3 step 14 of `docs/plans/rules-trainer.md`, the first
 * caller of `getRulesLeaderboard`).
 *
 * The trainer is mounted here, not just linked to: this route lives inside
 * the authenticated app shell (sidebar, team context, no `/en`/`/cs` path
 * segment), which is where a signed-in member should be practising. The
 * public `/en/rules` + `/cs/rules` routes still exist and still render the
 * same organism — they are the free, indexable, signed-out entry point and
 * the redirect target for `rules.sideline.cz`.
 *
 * `locale` comes from `getLocale()` rather than a path segment. That is the
 * opposite of the public routes, which must thread their locale explicitly
 * (Paraglide has no `url` strategy, so `getLocale()` would contradict
 * `/cs/rules`); inside `(authenticated)` there is no path locale to
 * contradict, so `getLocale()` IS the truth. See `applications/web/AGENTS.md`.
 *
 * No `RulesProgressPanel` of its own — `RulesTrainer` already renders one on
 * its intro screen for a signed-in player, and the caller here is always
 * signed in. Mounting a second would show the same mastery rows twice.
 *
 * `leaderboard.scope` — not `entries.length` — decides whether the
 * "you only see yourself" note renders: a genuinely one-member team would
 * make an entry-count check ambiguous (see `RulesLeaderboardResponse` in
 * `RulesTrainerApi.ts`).
 *
 * No TanStack Router imports on purpose (Atomic Design boundary): the route
 * file supplies `leaderboard` as a prop, already fetched.
 */
export function TeamRulesPage({ leaderboard }: TeamRulesPageProps) {
  const locale = getLocale();
  const { entries, scope } = leaderboard;

  return (
    <div className='mx-auto flex max-w-4xl flex-col gap-6'>
      <RulesTrainer locale={locale} isSignedIn />

      <Card>
        <CardContent className='flex flex-col gap-3'>
          <h2 className='text-lg font-semibold'>{tr('rules_leaderboardTitle')}</h2>

          {scope === 'self' && (
            <p className='text-xs text-muted-foreground'>{tr('rules_leaderboardSelfOnly')}</p>
          )}

          {entries.length === 0 ? (
            <p className='text-sm text-muted-foreground'>{tr('rules_leaderboardEmpty')}</p>
          ) : (
            <div className='flex flex-col gap-2'>
              {entries.map((entry) => (
                <div
                  key={entry.teamMemberId}
                  className='flex items-center gap-3 rounded-lg border border-border bg-card p-3'
                >
                  <RankBadge rank={entry.rank} label={tr('rules_leaderboardRank')} />
                  <div className='min-w-0 flex-1'>
                    <p className='truncate text-sm font-medium'>{entry.displayName}</p>
                    <p className='text-xs text-muted-foreground'>
                      {tr('rules_leaderboardPackagesMastered')}: {entry.masteredCount}/
                      {LEVELS.length}
                    </p>
                  </div>
                  <div className='flex shrink-0 items-center gap-2'>
                    {entry.masteredCount === LEVELS.length && (
                      <Badge className={VERDICT.correctSolid}>
                        {entry.masteredCount}/{LEVELS.length}
                      </Badge>
                    )}
                    <div className='text-right'>
                      <p className='text-sm font-semibold text-blue-600 dark:text-blue-400'>
                        {formatStrength(entry.strength)}
                      </p>
                      <p className='text-xs text-muted-foreground'>
                        {tr('rules_leaderboardMastery')}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
