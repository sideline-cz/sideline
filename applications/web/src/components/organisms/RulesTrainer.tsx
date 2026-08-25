import type {
  Answer,
  ChainEntry,
  Lang,
  Level,
  RulesPackage,
  Scenario,
  ScenarioId,
} from '@sideline/rules';
import {
  animLimit,
  answerStep,
  blankAnswer,
  buildRunPerms,
  chainView,
  LEVEL_META,
  LEVELS,
  pool,
  score,
  text,
} from '@sideline/rules';
import { RULES, SIGNALS } from '@sideline/rules/reference';
import { Check, Lock, X } from 'lucide-react';
import React from 'react';
import { RulesFieldSvg } from '~/components/organisms/RulesFieldSvg.js';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Skeleton } from '~/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group';
import { useAnimationFrame } from '~/hooks/useAnimationFrame.js';
import { isLevel } from '~/lib/rules/level.js';
import { WEB_PACKAGE_LOADERS } from '~/lib/rules/loaders.js';
import { loadProgress, saveProgress } from '~/lib/rules/progress.js';
import { tr } from '~/lib/translations.js';

interface RulesTrainerProps {
  readonly locale: Lang;
}

type Screen = 'intro' | 'loadingPractice' | 'practiceError' | 'practice' | 'summary';

type PackagesByLevel = Readonly<Partial<Record<Level, RulesPackage>>>;
type AnswersById = Readonly<Record<ScenarioId, Answer>>;
type PermsById = Readonly<Record<ScenarioId, ReadonlyArray<ReadonlyArray<number>>>>;

const OFF_LEGEND = '#2f6df6';
const DEF_LEGEND = '#e0483d';
const YOU_LEGEND_RING = '#ffd23f';
const DISC_LEGEND = '#ffe066';

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

function Legend({ locale }: { readonly locale: Lang }) {
  return (
    <div className='flex flex-wrap items-center gap-4 text-xs text-muted-foreground'>
      <span className='flex items-center gap-1.5'>
        <span className='inline-block size-3 rounded-full' style={{ background: OFF_LEGEND }} />
        {tr('rules_legendOff', undefined, { locale })}
      </span>
      <span className='flex items-center gap-1.5'>
        <span className='inline-block size-3 rounded-full' style={{ background: DEF_LEGEND }} />
        {tr('rules_legendDef', undefined, { locale })}
      </span>
      <span className='flex items-center gap-1.5'>
        <span
          className='inline-block size-3 rounded-full'
          style={{ background: OFF_LEGEND, boxShadow: `0 0 0 2px ${YOU_LEGEND_RING}` }}
        />
        {tr('rules_legendYou', undefined, { locale })}
      </span>
      <span className='flex items-center gap-1.5'>
        <span className='inline-block size-2.5 rounded-full' style={{ background: DISC_LEGEND }} />
        {tr('rules_legendDisc', undefined, { locale })}
      </span>
    </div>
  );
}

function RuleChip({
  rule,
  onOpen,
}: {
  readonly rule: string;
  readonly onOpen: (rule: string) => void;
}) {
  return (
    <Button variant='outline' size='sm' type='button' onClick={() => onOpen(rule)}>
      § {rule}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Intro screen — package picker
// ---------------------------------------------------------------------------

function IntroScreen({
  locale,
  sel,
  onToggleLevel,
  onSelectAll,
  onSelectNone,
  onStart,
}: {
  readonly locale: Lang;
  readonly sel: readonly Level[];
  readonly onToggleLevel: (levels: readonly Level[]) => void;
  readonly onSelectAll: () => void;
  readonly onSelectNone: () => void;
  readonly onStart: () => void;
}) {
  const totalSituations = LEVELS.reduce((n, l) => n + LEVEL_META[l].scenarioCount, 0);
  const pickedSituations = sel.reduce((n, l) => n + LEVEL_META[l].scenarioCount, 0);
  const canStart = sel.length > 0;

  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardContent className='flex flex-col gap-4'>
          <h1 className='text-2xl font-semibold'>
            {tr('rules_introTitle', undefined, { locale })}
          </h1>
          <p className='text-muted-foreground'>{tr('rules_introLead', undefined, { locale })}</p>
          <div className='flex flex-wrap gap-4 text-sm'>
            <span>
              <b>{totalSituations}</b> {tr('rules_statSituations', undefined, { locale })}
            </span>
            <span>
              <b>{LEVELS.length}</b> {tr('rules_statPackages', undefined, { locale })}
            </span>
            <span>{tr('rules_statLangs', undefined, { locale })}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className='flex flex-col gap-3'>
          <h2 className='text-lg font-semibold'>{tr('rules_howTitle', undefined, { locale })}</h2>
          <div className='grid gap-3 sm:grid-cols-3'>
            <div className='flex flex-col gap-1'>
              <span className='font-medium'>{tr('rules_introHow1', undefined, { locale })}</span>
              <span className='text-sm text-muted-foreground'>
                {tr('rules_introHow1t', undefined, { locale })}
              </span>
            </div>
            <div className='flex flex-col gap-1'>
              <span className='font-medium'>{tr('rules_introHow2', undefined, { locale })}</span>
              <span className='text-sm text-muted-foreground'>
                {tr('rules_introHow2t', undefined, { locale })}
              </span>
            </div>
            <div className='flex flex-col gap-1'>
              <span className='font-medium'>{tr('rules_introHow3', undefined, { locale })}</span>
              <span className='text-sm text-muted-foreground'>
                {tr('rules_introHow3t', undefined, { locale })}
              </span>
            </div>
          </div>
          <p className='text-sm text-muted-foreground'>
            {tr('rules_introPersp', undefined, { locale })}
          </p>
          <Legend locale={locale} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className='flex flex-col gap-4'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h2 className='text-lg font-semibold'>{tr('rules_pickPkgs', undefined, { locale })}</h2>
            <div className='flex gap-2'>
              <Button type='button' variant='outline' size='sm' onClick={onSelectAll}>
                {tr('rules_pkgAll', undefined, { locale })}
              </Button>
              <Button type='button' variant='outline' size='sm' onClick={onSelectNone}>
                {tr('rules_pkgNone', undefined, { locale })}
              </Button>
            </div>
          </div>

          <ToggleGroup
            type='multiple'
            variant='outline'
            className='grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3'
            value={sel.map((l) => String(l))}
            onValueChange={(values: string[]) => {
              const levels = values.map((v) => Number(v)).filter(isLevel);
              onToggleLevel(levels);
            }}
          >
            {LEVELS.map((level) => (
              <ToggleGroupItem
                key={level}
                value={String(level)}
                className='h-auto flex-col items-start gap-1 whitespace-normal p-3 text-left'
              >
                <span className='text-xs font-semibold text-muted-foreground'>
                  {LEVEL_META[level].scenarioCount}
                </span>
                <span className='font-medium'>
                  {tr(`rules_level_${level}_name`, undefined, { locale })}
                </span>
                <span className='text-xs text-muted-foreground'>
                  {tr(`rules_level_${level}_desc`, undefined, { locale })}
                </span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <div className='flex flex-wrap items-center gap-3'>
            <Button type='button' size='lg' disabled={!canStart} onClick={onStart}>
              {tr('rules_start', undefined, { locale })} ({pickedSituations})
            </Button>
            <span className='text-sm text-muted-foreground'>
              {canStart
                ? `${pickedSituations} ${tr('rules_statSituations', undefined, { locale })} · ${sel.length}/${LEVELS.length} ${tr('rules_statPackages', undefined, { locale })} ${tr('rules_selSum', undefined, { locale })}`
                : tr('rules_selNone', undefined, { locale })}
            </span>
          </div>
        </CardContent>
      </Card>

      <p className='text-xs text-muted-foreground'>
        WFDF Rules of Ultimate 2025–2028 · CC BY 4.0 World Flying Disc Federation
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step chain — the spoiler gate's UI half. Renders exactly what `chainView`
// says: a `locked` step never gets its key label or question, and a step's
// verdict/why text only appears when `showVerdict` is true.
// ---------------------------------------------------------------------------

function StepChain({
  scenario,
  answer,
  perms,
  locale,
  onAnswer,
  onOpenRule,
}: {
  readonly scenario: Scenario;
  readonly answer: Answer;
  readonly perms: ReadonlyArray<ReadonlyArray<number>> | undefined;
  readonly locale: Lang;
  readonly onAnswer: (pick: number) => void;
  readonly onOpenRule: (rule: string) => void;
}) {
  const entries: ChainEntry[] = chainView(scenario, answer, 'learn', perms);
  const n = scenario.steps.length;

  return (
    <div className='flex flex-col gap-3'>
      {entries.map((entry) => {
        if (entry.state === 'hidden') return null;
        const step = scenario.steps[entry.index];
        if (!step) return null;

        const stepLabel = `${tr('rules_stepWord', undefined, { locale })} ${entry.index + 1}/${n}`;

        if (entry.state === 'locked') {
          return (
            <div
              key={entry.index}
              className='rounded-md border border-dashed p-3 text-sm text-muted-foreground'
            >
              <div className='mb-1 flex items-center gap-2 font-medium'>
                <Lock className='size-3.5' aria-hidden='true' />
                {stepLabel}
              </div>
              <p>{tr('rules_stepLocked', undefined, { locale })}</p>
            </div>
          );
        }

        const rec = entry.state === 'answered' ? answer.steps[entry.index] : undefined;
        const keyLabel = entry.showKeyLabel
          ? ` · ${tr(`rules_k${step.k}`, undefined, { locale })}`
          : '';

        return (
          <div
            key={entry.index}
            className={`rounded-md border p-3 ${entry.state === 'answered' ? (rec?.ok ? 'border-success' : 'border-destructive') : ''}`}
          >
            <div className='mb-2 flex items-center gap-2 text-sm font-medium'>
              <span>
                {stepLabel}
                {keyLabel}
              </span>
              {entry.showVerdict &&
                (rec?.ok ? (
                  <Check className='size-4 text-success' aria-hidden='true' />
                ) : (
                  <X className='size-4 text-destructive' aria-hidden='true' />
                ))}
            </div>
            <p className='mb-3 text-sm'>{text(step.q, locale)}</p>
            <div className='flex flex-col gap-2'>
              {entry.order.map((originalIndex, pos) => {
                const opt = step.opts[originalIndex];
                if (!opt) return null;
                const letter = ['A', 'B', 'C', 'D'][pos] ?? String(pos + 1);
                const answered = entry.state === 'answered';
                const isPicked = rec?.pick === originalIndex;
                const showVerdictStyle = entry.showVerdict;
                const correct = showVerdictStyle && opt.ok === true;
                const wrong = showVerdictStyle && isPicked && opt.ok !== true;

                return (
                  <div key={originalIndex} className='flex flex-col gap-1'>
                    <Button
                      type='button'
                      variant={correct ? 'default' : wrong ? 'destructive' : 'outline'}
                      className='h-auto justify-start whitespace-normal text-left'
                      disabled={answered || entry.state !== 'current'}
                      onClick={() => onAnswer(originalIndex)}
                    >
                      <span className='mr-2 font-mono text-xs opacity-70'>{letter}</span>
                      {text(opt.t, locale)}
                    </Button>
                    {showVerdictStyle && (
                      <p className='pl-2 text-xs text-muted-foreground'>{text(opt.why, locale)}</p>
                    )}
                  </div>
                );
              })}
            </div>
            {entry.showVerdict && step.rules.length > 0 && (
              <div className='mt-3 flex flex-wrap gap-2'>
                {step.rules.map((rule) => (
                  <RuleChip key={rule} rule={rule} onOpen={onOpenRule} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feedback panel — shown once the whole chain is answered.
// ---------------------------------------------------------------------------

function FeedbackPanel({
  scenario,
  answer,
  locale,
  onOpenRule,
}: {
  readonly scenario: Scenario;
  readonly answer: Answer;
  readonly locale: Lang;
  readonly onOpenRule: (rule: string) => void;
}) {
  const okCount = answer.steps.filter((s) => s.ok).length;
  const total = answer.steps.length;
  const verdict = answer.ok
    ? `${tr('rules_correct', undefined, { locale })} ${tr('rules_chainDone', undefined, { locale })}`
    : `${tr('rules_incorrect', undefined, { locale })} ${okCount}/${total} ${tr('rules_chainSteps', undefined, { locale })}`;

  return (
    <div
      className={`rounded-md border p-4 ${answer.ok ? 'border-success bg-success/10' : 'border-destructive bg-destructive/10'}`}
    >
      <p className='font-semibold'>{verdict}</p>
      <p className='mt-1 text-sm'>{text(scenario.explain, locale)}</p>
      {scenario.note && (
        <p className='mt-2 text-sm text-muted-foreground'>
          <b>{tr('rules_alsoNote', undefined, { locale })}:</b> {text(scenario.note, locale)}
        </p>
      )}
      <div className='mt-3 flex flex-wrap items-center gap-2'>
        <span className='text-xs font-semibold text-muted-foreground'>
          {tr('rules_refs', undefined, { locale })}
        </span>
        {scenario.rules.map((rule) => (
          <RuleChip key={rule} rule={rule} onOpen={onOpenRule} />
        ))}
      </div>
      {scenario.signals && scenario.signals.length > 0 && (
        <div className='mt-2 flex flex-wrap items-center gap-2'>
          <span className='text-xs font-semibold text-muted-foreground'>
            {tr('rules_signals', undefined, { locale })}
          </span>
          {scenario.signals.map((signalId) => {
            const entry = SIGNALS[String(signalId)];
            if (!entry) return null;
            return (
              <Badge key={signalId} variant='outline'>
                #{signalId} {text(entry, locale)}
              </Badge>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main organism
// ---------------------------------------------------------------------------

export function RulesTrainer({ locale }: RulesTrainerProps) {
  const [hydrated, setHydrated] = React.useState(false);
  const [sel, setSel] = React.useState<readonly Level[]>(LEVELS);
  const [answers, setAnswers] = React.useState<AnswersById>({});
  const [packages, setPackages] = React.useState<PackagesByLevel>({});
  const [perms, setPerms] = React.useState<PermsById>({});
  const [screen, setScreen] = React.useState<Screen>('intro');
  const [currentId, setCurrentId] = React.useState<ScenarioId | null>(null);
  const [openRule, setOpenRule] = React.useState<string | null>(null);

  const [animT, setAnimT] = React.useState(0);
  const [animPlaying, setAnimPlaying] = React.useState(false);
  const [slow, setSlow] = React.useState(false);

  // Load saved progress once. Never read localStorage during render.
  React.useEffect(() => {
    const progress = loadProgress();
    setAnswers(progress.answers);
    if (progress.sel.length > 0) setSel(progress.sel);
    setHydrated(true);
  }, []);

  // Persist progress whenever it changes, once the initial load has landed
  // (otherwise this would immediately overwrite a saved run with the
  // pre-hydration defaults).
  React.useEffect(() => {
    if (!hydrated) return;
    saveProgress({ version: 1, answers, sel });
  }, [hydrated, answers, sel]);

  const scenarios = React.useMemo(
    () => sel.flatMap((l) => packages[l]?.scenarios ?? []),
    [sel, packages],
  );
  const scenariosById = React.useMemo(
    () => new Map(scenarios.map((sc) => [sc.id, sc] as const)),
    [scenarios],
  );
  const poolIds = React.useMemo(() => pool(scenarios, sel), [scenarios, sel]);

  // House lazy-load pattern (see RootDocument's DevtoolsPanel): useState +
  // useEffect + a cancelled flag, no React.lazy/Suspense. Fetches only the
  // packages the run actually needs via the web-local loader map (see
  // `~/lib/rules/loaders.ts` for why web cannot use the package's own
  // `PACKAGE_LOADERS`), never the eager
  // `@sideline/rules/content` entry.
  React.useEffect(() => {
    if (screen !== 'loadingPractice') return;
    const missing = sel.filter((l) => packages[l] === undefined);

    if (missing.length > 0) {
      let cancelled = false;
      Promise.all(missing.map((l) => WEB_PACKAGE_LOADERS[l]()))
        .then((loaded) => {
          if (cancelled) return;
          setPackages((prev) => {
            const next = { ...prev };
            missing.forEach((level, i) => {
              next[level] = loaded[i];
            });
            return next;
          });
        })
        .catch(() => {
          if (!cancelled) setScreen('practiceError');
        });
      return () => {
        cancelled = true;
      };
    }

    // Everything selected is loaded — build the run once and enter practice.
    if (poolIds.length === 0) {
      setScreen('practiceError');
      return;
    }
    setPerms(buildRunPerms(scenarios, sel));
    const firstUnanswered = poolIds.find((id) => !(answers[id]?.done ?? false));
    setCurrentId(firstUnanswered ?? poolIds[0] ?? null);
    setScreen('practice');
  }, [screen, sel, packages, poolIds, scenarios, answers]);

  const currentScenario = currentId ? (scenariosById.get(currentId) ?? null) : null;
  const currentIndex = currentId ? poolIds.indexOf(currentId) : -1;
  const currentAnswer = currentScenario
    ? (answers[currentScenario.id] ?? blankAnswer())
    : blankAnswer();
  const limit = currentScenario
    ? animLimit({ mode: 'learn', scenario: currentScenario, answer: currentAnswer })
    : 0;

  // Reset/autoplay the demo when navigating to a (possibly new) scenario.
  // Deliberately scoped to `currentId` only — answering a step must not
  // rewind or restart the demo (see `handleAnswer` below).
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation-only reset is the design
  React.useEffect(() => {
    if (screen !== 'practice' || currentId === null) return;
    const scenario = scenariosById.get(currentId);
    if (!scenario) return;
    const answer = answers[currentId] ?? blankAnswer();
    setAnimT(answer.done ? scenario.dur : 0);
    setAnimPlaying(false);
    if (answer.done) return;
    const timer = setTimeout(() => setAnimPlaying(true), 500);
    return () => clearTimeout(timer);
  }, [currentId]);

  useAnimationFrame((dt) => {
    setAnimT((prev) => Math.min(prev + dt * (slow ? 0.42 : 1), limit));
  }, animPlaying);

  React.useEffect(() => {
    if (animPlaying && animT >= limit) setAnimPlaying(false);
  }, [animPlaying, animT, limit]);

  const handleToggleLevels = (levels: readonly Level[]) => {
    setSel([...levels].sort((a, b) => a - b));
  };

  const handleAnswer = (scenario: Scenario, pick: number) => {
    const runState = {
      lang: locale,
      mode: 'learn' as const,
      current: scenario.id,
      sel,
      answers,
      perms,
      exam: null,
      reviewQ: 0,
    };
    const next = answerStep(runState, scenario, pick);
    if (next === runState) return;
    setAnswers(next.answers);
    if (next.answers[scenario.id]?.done) setAnimPlaying(true);
  };

  const handleNext = () => {
    if (currentId === null) return;
    const idx = poolIds.indexOf(currentId);
    if (idx !== -1 && idx < poolIds.length - 1) {
      setCurrentId(poolIds[idx + 1] ?? null);
      return;
    }
    const allDone = poolIds.every((id) => answers[id]?.done ?? false);
    if (allDone) {
      setScreen('summary');
      return;
    }
    const nextUnanswered = poolIds.find((id) => !(answers[id]?.done ?? false));
    if (nextUnanswered) setCurrentId(nextUnanswered);
  };

  const handleGoto = (id: ScenarioId) => {
    setCurrentId(id);
    setScreen('practice');
  };

  const handleRestart = () => {
    setAnswers({});
    setPerms({});
    setCurrentId(null);
    setScreen('intro');
  };

  const runStateForScore = currentId
    ? {
        lang: locale,
        mode: 'learn' as const,
        current: currentId,
        sel,
        answers,
        perms,
        exam: null,
        reviewQ: 0,
      }
    : null;
  const currentScore = runStateForScore ? score(runStateForScore, scenarios) : 0;

  return (
    <div className='flex flex-col gap-4'>
      {screen === 'intro' && (
        <IntroScreen
          locale={locale}
          sel={sel}
          onToggleLevel={handleToggleLevels}
          onSelectAll={() => setSel(LEVELS)}
          onSelectNone={() => setSel([])}
          onStart={() => setScreen('loadingPractice')}
        />
      )}

      {screen === 'loadingPractice' && (
        <Card>
          <CardContent className='flex flex-col gap-3'>
            <Skeleton className='h-6 w-48' />
            <Skeleton className='h-40 w-full' />
            <Skeleton className='h-24 w-full' />
          </CardContent>
        </Card>
      )}

      {screen === 'practiceError' && (
        <Card>
          <CardContent className='flex flex-col gap-3'>
            <h2 className='text-lg font-semibold'>{tr('error_title', undefined, { locale })}</h2>
            <p className='text-sm text-muted-foreground'>
              {tr('error_message', undefined, { locale })}
            </p>
            <Button type='button' onClick={() => setScreen('loadingPractice')}>
              {tr('error_tryAgain', undefined, { locale })}
            </Button>
          </CardContent>
        </Card>
      )}

      {screen === 'practice' && currentScenario && (
        <>
          <div className='flex flex-wrap items-center gap-2'>
            {poolIds.map((id, pos) => {
              const a = answers[id];
              const isCurrent = id === currentId;
              return (
                <button
                  key={id}
                  type='button'
                  onClick={() => handleGoto(id)}
                  className={`flex size-7 items-center justify-center rounded-full border text-xs ${
                    isCurrent
                      ? 'border-primary bg-primary text-primary-foreground'
                      : a?.done
                        ? a.ok
                          ? 'border-success bg-success/20'
                          : 'border-destructive bg-destructive/20'
                        : 'border-muted-foreground/30'
                  }`}
                >
                  {pos + 1}
                </button>
              );
            })}
            <Badge variant='secondary' className='ml-auto'>
              {currentScore} / {poolIds.length}
            </Badge>
          </div>

          <Card>
            <CardContent className='flex flex-col gap-4'>
              <div className='flex flex-wrap items-center gap-2'>
                <Badge variant='outline'>Level {currentScenario.level}</Badge>
                <Badge variant='outline'>{text(currentScenario.topic, locale)}</Badge>
                <Badge className='ml-auto'>
                  {tr('rules_yourRole', undefined, { locale })}:{' '}
                  {text(currentScenario.role, locale)}
                </Badge>
              </div>

              <h2 className='text-xl font-semibold'>
                {currentIndex + 1}/{poolIds.length} · {text(currentScenario.title, locale)}
              </h2>

              <RulesFieldSvg scenario={currentScenario} t={animT} locale={locale} />

              <div className='flex flex-wrap items-center gap-3'>
                <Button
                  type='button'
                  onClick={() => {
                    setAnimT(0);
                    setAnimPlaying(true);
                  }}
                >
                  {animT > 0
                    ? tr('rules_replay', undefined, { locale })
                    : tr('rules_play', undefined, { locale })}
                </Button>
                <Button
                  type='button'
                  variant={slow ? 'default' : 'outline'}
                  onClick={() => setSlow((v) => !v)}
                >
                  {tr('rules_slow', undefined, { locale })}
                </Button>
                {!currentAnswer.done && (
                  <span className='flex items-center gap-1 text-xs font-medium text-muted-foreground'>
                    <Lock className='size-3' aria-hidden='true' />
                    {tr('rules_revealHint', undefined, { locale })}
                  </span>
                )}
                <div className='ml-auto'>
                  <Legend locale={locale} />
                </div>
              </div>

              <p className='text-sm'>
                <b>{tr('rules_situation', undefined, { locale })}:</b>{' '}
                {text(currentScenario.situation, locale)}
              </p>
              <p className='font-medium'>{text(currentScenario.question, locale)}</p>

              <StepChain
                scenario={currentScenario}
                answer={currentAnswer}
                perms={perms[currentScenario.id]}
                locale={locale}
                onAnswer={(pick) => handleAnswer(currentScenario, pick)}
                onOpenRule={setOpenRule}
              />

              {currentAnswer.done && (
                <FeedbackPanel
                  scenario={currentScenario}
                  answer={currentAnswer}
                  locale={locale}
                  onOpenRule={setOpenRule}
                />
              )}

              {currentAnswer.done && (
                <div>
                  <Button type='button' onClick={handleNext}>
                    {currentIndex === poolIds.length - 1
                      ? tr('rules_finish', undefined, { locale })
                      : tr('rules_next', undefined, { locale })}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {screen === 'summary' && (
        <Card>
          <CardContent className='flex flex-col gap-4'>
            <h2 className='text-xl font-semibold'>{tr('rules_sumTitle', undefined, { locale })}</h2>
            <div className='text-3xl font-bold'>
              {currentScore} / {poolIds.length}
            </div>
            <p className='text-sm text-muted-foreground'>
              {tr('rules_reviewHint', undefined, { locale })}
            </p>
            <div className='flex flex-col gap-1'>
              {poolIds.map((id, pos) => {
                const sc = scenariosById.get(id);
                const a = answers[id];
                if (!sc) return null;
                return (
                  <button
                    key={id}
                    type='button'
                    onClick={() => handleGoto(id)}
                    className='flex items-center gap-2 rounded-md border p-2 text-left text-sm hover:bg-accent'
                  >
                    {a?.ok ? (
                      <Check className='size-4 text-success' aria-hidden='true' />
                    ) : (
                      <X className='size-4 text-destructive' aria-hidden='true' />
                    )}
                    <span className='font-medium'>{pos + 1}.</span>
                    <span>{text(sc.title, locale)}</span>
                    <Badge variant='outline' className='ml-auto'>
                      {text(sc.topic, locale)}
                    </Badge>
                  </button>
                );
              })}
            </div>
            <div>
              <Button type='button' variant='outline' onClick={handleRestart}>
                {tr('rules_restart', undefined, { locale })}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={openRule !== null} onOpenChange={(open) => !open && setOpenRule(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {tr('rules_ruleTitle', undefined, { locale })} — § {openRule}
            </DialogTitle>
          </DialogHeader>
          <p className='text-sm'>
            {openRule && RULES[openRule] ? text(RULES[openRule], locale) : ''}
          </p>
          <p className='text-xs text-muted-foreground'>
            {tr('rules_ruleNote', undefined, { locale })}
          </p>
          <DialogFooter>
            <Button type='button' onClick={() => setOpenRule(null)}>
              {tr('rules_close', undefined, { locale })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
