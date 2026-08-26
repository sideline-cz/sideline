import type { Answer, ExamState, Lang, Scenario, ScenarioId } from '@sideline/rules';
import { text } from '@sideline/rules';
import { Check, X } from 'lucide-react';
import { FeedbackPanel, Legend, StepChain } from '~/components/organisms/RulesChain.js';
import { RulesFieldSvg } from '~/components/organisms/RulesFieldSvg.js';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import { RULES_ACCENT, VERDICT } from '~/lib/rules/palette.js';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

// ---------------------------------------------------------------------------
// Exam question — the untimed, single-sitting final test. Renders exactly
// one step of the chain at a time (`chainView`'s own `blind` behaviour in
// `mode: 'exam'`), never a verdict, never `why`, never a rule chip, never a
// locked placeholder. `RulesTrainer.tsx` owns all the state transitions
// (see its exam-pacing doc comment); this component is pure presentation.
// ---------------------------------------------------------------------------

interface RulesExamQuestionProps {
  readonly locale: Lang;
  readonly scenario: Scenario;
  readonly answer: Answer;
  readonly perms: ReadonlyArray<ReadonlyArray<number>> | undefined;
  readonly questionIndex: number;
  readonly questionCount: number;
  readonly pendingPick: number | null;
  readonly animT: number;
  readonly slow: boolean;
  readonly onPlay: () => void;
  readonly onToggleSlow: () => void;
  readonly onAnswer: (pick: number) => void;
}

export function RulesExamQuestion({
  locale,
  scenario,
  answer,
  perms,
  questionIndex,
  questionCount,
  pendingPick,
  animT,
  slow,
  onPlay,
  onToggleSlow,
  onAnswer,
}: RulesExamQuestionProps) {
  return (
    <Card>
      <CardContent className='flex flex-col gap-4'>
        <div className='flex flex-wrap items-center gap-2'>
          <Badge className={cn('border-transparent', RULES_ACCENT.soft)}>
            🎓 {tr('rules_examQ', undefined, { locale })} {questionIndex + 1} / {questionCount}
          </Badge>
          <Badge variant='outline'>{text(scenario.topic, locale)}</Badge>
          {/* Amber, matching the ring the pitch SVG draws around "you" — same
              treatment as the practice screen's role badge. */}
          <Badge className='ml-auto border-transparent bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200'>
            {tr('rules_yourRole', undefined, { locale })}: {text(scenario.role, locale)}
          </Badge>
        </div>

        <h2 className='text-xl font-semibold'>{text(scenario.title, locale)}</h2>

        <RulesFieldSvg scenario={scenario} t={animT} locale={locale} />

        <div className='flex flex-wrap items-center gap-3'>
          <Button type='button' className={RULES_ACCENT.cta} onClick={onPlay}>
            {animT > 0
              ? tr('rules_replay', undefined, { locale })
              : tr('rules_play', undefined, { locale })}
          </Button>
          <Button type='button' variant={slow ? 'default' : 'outline'} onClick={onToggleSlow}>
            {tr('rules_slow', undefined, { locale })}
          </Button>
          <div className='ml-auto'>
            <Legend locale={locale} />
          </div>
        </div>

        <p className='text-sm'>
          <b>{tr('rules_situation', undefined, { locale })}:</b> {text(scenario.situation, locale)}
        </p>
        <p className='font-medium'>{text(scenario.question, locale)}</p>

        <StepChain
          scenario={scenario}
          answer={answer}
          perms={perms}
          mode='exam'
          locale={locale}
          pendingPick={pendingPick}
          onAnswer={onAnswer}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Exam results — score via `examScore` (computed by the caller), banded
// message per `app.js:567` (`s >= round(n*0.8)` → top, `s >= ceil(n/2)` →
// mid, else low). Each question lists its own per-step tally and opens
// review on click.
// ---------------------------------------------------------------------------

const BAND_TEXT: Readonly<Record<ExamBandKey, string>> = {
  rules_examTop: VERDICT.correctText,
  rules_examMid: 'text-amber-600 dark:text-amber-400',
  rules_examLow: VERDICT.wrongText,
};

type ExamBandKey = 'rules_examTop' | 'rules_examMid' | 'rules_examLow';

export function examBandKey(score: number, n: number): ExamBandKey {
  if (n === 0) return 'rules_examLow';
  if (score >= Math.round(n * 0.8)) return 'rules_examTop';
  if (score >= Math.ceil(n / 2)) return 'rules_examMid';
  return 'rules_examLow';
}

interface RulesExamResultsProps {
  readonly locale: Lang;
  readonly examState: ExamState;
  readonly score: number;
  readonly scenariosById: ReadonlyMap<ScenarioId, Scenario>;
  readonly onReview: (questionIndex: number) => void;
  readonly onExamAgain: () => void;
  readonly onToPractice: () => void;
}

export function RulesExamResults({
  locale,
  examState,
  score,
  scenariosById,
  onReview,
  onExamAgain,
  onToPractice,
}: RulesExamResultsProps) {
  const n = examState.qs.length;
  const bandKey = examBandKey(score, n);

  return (
    <Card>
      <CardContent className='flex flex-col gap-4'>
        <h2 className='text-xl font-semibold'>
          🎓 {tr('rules_examResTitle', undefined, { locale })}
        </h2>
        {/* Banded colour, same three bands as the message below it — the
            number was the only thing on this screen carrying the result, and
            it carried it in plain black. */}
        <div className='text-3xl font-bold'>
          <span className={BAND_TEXT[bandKey]}>{score}</span>
          <span className='text-muted-foreground'> / {n}</span>
        </div>
        <p className={cn('text-sm font-medium', BAND_TEXT[bandKey])}>
          {tr(bandKey, undefined, { locale })}
        </p>
        <p className='text-sm text-muted-foreground'>
          {tr('rules_reviewHintExam', undefined, { locale })}
        </p>
        <div className='flex flex-col gap-1'>
          {examState.qs.map((id, k) => {
            const sc = scenariosById.get(id);
            const a = examState.answers[k];
            if (!sc || !a) return null;
            const okSteps = a.steps.filter((s) => s.ok).length;
            const total = a.steps.length;
            return (
              <button
                key={id}
                type='button'
                onClick={() => onReview(k)}
                className={cn(
                  'flex items-center gap-2 rounded-md border p-2 text-left text-sm transition-colors',
                  a.ok ? VERDICT.correctRow : VERDICT.wrongRow,
                )}
              >
                {a.ok ? (
                  <Check className={cn('size-4', VERDICT.correctText)} aria-hidden='true' />
                ) : (
                  <X className={cn('size-4', VERDICT.wrongText)} aria-hidden='true' />
                )}
                <span className='font-medium'>{k + 1}.</span>
                <span>{text(sc.title, locale)}</span>
                <Badge variant='outline'>
                  {okSteps}/{total} {tr('rules_chainSteps', undefined, { locale })}
                </Badge>
                <Badge variant='outline' className='ml-auto'>
                  {text(sc.topic, locale)}
                </Badge>
              </button>
            );
          })}
        </div>
        <div className='flex flex-wrap gap-2'>
          <Button type='button' className={RULES_ACCENT.cta} onClick={onExamAgain}>
            {tr('rules_examAgain', undefined, { locale })}
          </Button>
          <Button type='button' variant='outline' onClick={onToPractice}>
            {tr('rules_toPractice', undefined, { locale })}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Review — a single exam question, fully revealed (`chainView`'s `mode:
// 'review'` shows every step already `answered`, so `showVerdict` is true
// throughout — see `RulesChain.tsx`'s `StepChain`). Uses `ExamState.perms[k]`
// so the option order matches what the user actually saw sitting the exam.
// ---------------------------------------------------------------------------

interface RulesReviewProps {
  readonly locale: Lang;
  readonly scenario: Scenario;
  readonly answer: Answer;
  readonly perms: ReadonlyArray<ReadonlyArray<number>> | undefined;
  readonly questionIndex: number;
  readonly questionCount: number;
  readonly animT: number;
  readonly slow: boolean;
  readonly onPlay: () => void;
  readonly onToggleSlow: () => void;
  readonly onOpenRule: (rule: string) => void;
  readonly onBackToResults: () => void;
}

export function RulesReview({
  locale,
  scenario,
  answer,
  perms,
  questionIndex,
  questionCount,
  animT,
  slow,
  onPlay,
  onToggleSlow,
  onOpenRule,
  onBackToResults,
}: RulesReviewProps) {
  return (
    <>
      <div>
        <Button type='button' variant='outline' onClick={onBackToResults}>
          {tr('rules_backToResults', undefined, { locale })}
        </Button>
      </div>
      <Card>
        <CardContent className='flex flex-col gap-4'>
          <div className='flex flex-wrap items-center gap-2'>
            <Badge className={cn('border-transparent', RULES_ACCENT.soft)}>
              🎓 {tr('rules_examQ', undefined, { locale })} {questionIndex + 1} / {questionCount}
            </Badge>
            <Badge variant='outline'>{text(scenario.topic, locale)}</Badge>
            {/* Amber, matching the ring the pitch SVG draws around "you" — same
                treatment as the practice screen's role badge. */}
            <Badge className='ml-auto border-transparent bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200'>
              {tr('rules_yourRole', undefined, { locale })}: {text(scenario.role, locale)}
            </Badge>
          </div>

          <h2 className='text-xl font-semibold'>{text(scenario.title, locale)}</h2>

          <RulesFieldSvg scenario={scenario} t={animT} locale={locale} />

          <div className='flex flex-wrap items-center gap-3'>
            <Button type='button' className={RULES_ACCENT.cta} onClick={onPlay}>
              {animT > 0
                ? tr('rules_replay', undefined, { locale })
                : tr('rules_play', undefined, { locale })}
            </Button>
            <Button type='button' variant={slow ? 'default' : 'outline'} onClick={onToggleSlow}>
              {tr('rules_slow', undefined, { locale })}
            </Button>
            <div className='ml-auto'>
              <Legend locale={locale} />
            </div>
          </div>

          <p className='text-sm'>
            <b>{tr('rules_situation', undefined, { locale })}:</b>{' '}
            {text(scenario.situation, locale)}
          </p>
          <p className='font-medium'>{text(scenario.question, locale)}</p>

          <StepChain
            scenario={scenario}
            answer={answer}
            perms={perms}
            mode='review'
            locale={locale}
            onAnswer={() => {}}
            onOpenRule={onOpenRule}
          />

          <FeedbackPanel
            scenario={scenario}
            answer={answer}
            locale={locale}
            onOpenRule={onOpenRule}
          />
        </CardContent>
      </Card>
    </>
  );
}
