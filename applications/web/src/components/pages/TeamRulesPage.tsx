import type { RulesTrainerApi } from '@sideline/domain';
import { getLocale } from '@sideline/i18n/runtime';
import { LEVELS } from '@sideline/rules';
import { BookOpen } from 'lucide-react';
import { RulesProgressPanel } from '~/components/organisms/RulesProgressPanel.js';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import { strengthPercent } from '~/lib/rules/strength.js';
import { tr } from '~/lib/translations.js';

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

function RankBadge({ rank, label }: { readonly rank: number; readonly label: string }) {
  return (
    <div className='flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground font-medium text-sm'>
      <span className='sr-only'>{label}</span>
      {rank}
    </div>
  );
}

/**
 * Member route surfacing the rules-trainer leaderboard (Phase 3 step 14 of
 * `docs/plans/rules-trainer.md`) — this is `getRulesLeaderboard`'s first
 * caller. No TanStack Router imports on purpose (Atomic Design boundary):
 * the route file supplies `leaderboard` as a prop, already fetched.
 *
 * The caller is always signed in here (this page lives under
 * `(authenticated)`), so `RulesProgressPanel` is mounted unconditionally
 * with `isSignedIn`.
 *
 * `leaderboard.scope` — not `entries.length` — decides whether the
 * "you only see yourself" note renders: a genuinely one-member team would
 * make an entry-count check ambiguous (see `RulesLeaderboardResponse` in
 * `RulesTrainerApi.ts`).
 */
export function TeamRulesPage({ leaderboard }: TeamRulesPageProps) {
  const locale = getLocale();
  const { entries, scope } = leaderboard;

  return (
    <div className='mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8'>
      <header className='flex flex-wrap items-center justify-between gap-3'>
        <h1 className='text-2xl font-bold'>{tr('rules_navTitle')}</h1>
        <Button asChild variant='outline'>
          <a href='/rules'>
            <BookOpen className='size-4' />
            {tr('rules_openTrainer')}
          </a>
        </Button>
      </header>

      <RulesProgressPanel locale={locale} isSignedIn />

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
                  <div className='shrink-0 text-right'>
                    <p className='text-sm font-medium'>{formatStrength(entry.strength)}</p>
                    <p className='text-xs text-muted-foreground'>
                      {tr('rules_leaderboardMastery')}
                    </p>
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
