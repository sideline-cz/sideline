import type {
  Answer,
  ExamState,
  Lang,
  Level,
  Mode,
  RulesPackage,
  Scenario,
  ScenarioId,
} from '@sideline/rules';
import {
  advanceExam,
  animLimit,
  answerStep,
  blankAnswer,
  buildRunPerms,
  EXAM_N,
  examAnswer,
  examScore,
  LEVEL_META,
  LEVELS,
  openReview,
  pool,
  score,
  startExam,
  text,
} from '@sideline/rules';
import { RULES } from '@sideline/rules/reference';
import { Effect, Option } from 'effect';
import { Check, Lock, X } from 'lucide-react';
import React from 'react';
import { FeedbackPanel, Legend, StepChain } from '~/components/organisms/RulesChain.js';
import { RulesCheatSheet } from '~/components/organisms/RulesCheatSheet.js';
import {
  RulesExamQuestion,
  RulesExamResults,
  RulesReview,
} from '~/components/organisms/RulesExam.js';
import { RulesFieldSvg } from '~/components/organisms/RulesFieldSvg.js';
import { RulesProgressPanel } from '~/components/organisms/RulesProgressPanel.js';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
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
import { useAnimationFrame } from '~/hooks/useAnimationFrame.js';
import { WEB_PACKAGE_LOADERS } from '~/lib/rules/loaders.js';
import { LEVEL_ACCENT, RULES_ACCENT, VERDICT } from '~/lib/rules/palette.js';
import { loadProgress, saveProgress } from '~/lib/rules/progress.js';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

interface RulesTrainerProps {
  readonly locale: Lang;
  /** Plain boolean, never the `User` object (see `RulesTrainerPage`) — drives
   * whether the progress panel/submit/import wiring below is reachable at
   * all. Defaults to `false` so every existing direct-render test of this
   * organism keeps behaving exactly as before. */
  readonly isSignedIn?: boolean;
}

/** One scenario's submitted picks, in chain order — shared by the
 * practice-completion, exam-completion and import submit paths below. Never
 * casts `id` to `ScenarioId`: `SubmitAttemptRequest.results[].scenario_id`
 * (see `RulesTrainerApi`) decodes as a plain `Schema.String`, precisely so
 * callers never need a runtime `ScenarioId` constructor (there isn't one).
 */
function attemptResults(
  entries: ReadonlyArray<readonly [string, Answer | undefined]>,
): ReadonlyArray<{
  readonly scenario_id: string;
  readonly steps: ReadonlyArray<Option.Option<number>>;
}> {
  return entries.map(([scenario_id, answer]) => ({
    scenario_id,
    steps: (answer?.steps ?? []).map((s) => Option.fromNullOr(s.pick)),
  }));
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

type Screen =
  | 'intro'
  | 'loadingPractice'
  | 'practiceError'
  | 'practice'
  | 'summary'
  | 'loadingExam'
  | 'exam'
  | 'examResults'
  | 'review';

type PackagesByLevel = Readonly<Partial<Record<Level, RulesPackage>>>;
type AnswersById = Readonly<Record<ScenarioId, Answer>>;
type PermsById = Readonly<Record<ScenarioId, ReadonlyArray<ReadonlyArray<number>>>>;

// ---------------------------------------------------------------------------
// Intro screen — package picker
// ---------------------------------------------------------------------------

/**
 * One package in the picker.
 *
 * Deliberately a plain `<button aria-pressed>` rather than a
 * `ToggleGroupItem`: the shadcn toggle group is a *segmented control*, so
 * every item carries `data-[spacing=0]:rounded-none` and
 * `data-[variant=outline]:border-l-0` and only the first/last item keeps a
 * rounded edge. Laid out as a gapped grid — which is what nine packages
 * need — that produced borderless, square-cornered cards whose `on` state
 * was the same faint `bg-accent` as their hover state. That is the
 * "click and hover are the same" report.
 *
 * The selected state now differs from hover on four axes at once — accent
 * border, accent surface, filled number pill, and a filled check mark —
 * so it survives both colour-blindness and a hover that never lifts on
 * touch devices.
 */
function PackageCard({
  level,
  locale,
  selected,
  onToggle,
}: {
  readonly level: Level;
  readonly locale: Lang;
  readonly selected: boolean;
  readonly onToggle: (level: Level) => void;
}) {
  const accent = LEVEL_ACCENT[level];

  return (
    <button
      type='button'
      aria-pressed={selected}
      onClick={() => onToggle(level)}
      className={cn(
        'flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? accent.selected : cn('bg-card', accent.idle),
      )}
    >
      <span className='flex w-full items-center gap-2'>
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-bold',
            selected ? accent.solid : accent.soft,
          )}
        >
          {level}
        </span>
        <span className='min-w-0 flex-1 font-medium'>
          {tr(`rules_level_${level}_name`, undefined, { locale })}
        </span>
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-full border',
            selected ? cn('border-transparent', accent.solid) : 'border-muted-foreground/40',
          )}
          aria-hidden='true'
        >
          {selected && <Check className='size-3.5' strokeWidth={3} />}
        </span>
      </span>
      <span className='text-xs text-muted-foreground'>
        {tr(`rules_level_${level}_desc`, undefined, { locale })}
      </span>
      {/* `mt-auto` bottom-aligns the count across a row: grid items stretch to
          the tallest card, and package descriptions run one to three lines. */}
      <span className={cn('mt-auto text-xs font-semibold', accent.text)}>
        {LEVEL_META[level].scenarioCount} {tr('rules_statSituations', undefined, { locale })}
      </span>
    </button>
  );
}

/** One of the three "how it works" steps, with an accent-numbered marker. */
function HowStep({
  index,
  title,
  body,
}: {
  readonly index: number;
  readonly title: string;
  readonly body: string;
}) {
  return (
    <div className='flex gap-3'>
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-bold',
          RULES_ACCENT.soft,
        )}
      >
        {index}
      </span>
      <span className='flex flex-col gap-1'>
        <span className='font-medium'>{title}</span>
        <span className='text-sm text-muted-foreground'>{body}</span>
      </span>
    </div>
  );
}

function IntroScreen({
  locale,
  sel,
  onToggleLevel,
  onSelectAll,
  onSelectNone,
  onStart,
  onStartExam,
  onOpenCheat,
}: {
  readonly locale: Lang;
  readonly sel: readonly Level[];
  readonly onToggleLevel: (level: Level) => void;
  readonly onSelectAll: () => void;
  readonly onSelectNone: () => void;
  readonly onStart: () => void;
  readonly onStartExam: () => void;
  readonly onOpenCheat: () => void;
}) {
  const totalSituations = LEVELS.reduce((n, l) => n + LEVEL_META[l].scenarioCount, 0);
  const pickedSituations = sel.reduce((n, l) => n + LEVEL_META[l].scenarioCount, 0);
  const canStart = sel.length > 0;
  const examCount = Math.min(EXAM_N, pickedSituations || totalSituations);

  return (
    <div className='flex flex-col gap-4'>
      <Card className={cn('overflow-hidden', RULES_ACCENT.border)}>
        <CardContent className={cn('flex flex-col gap-4', RULES_ACCENT.surface)}>
          <h1 className='text-2xl font-semibold'>
            {tr('rules_introTitle', undefined, { locale })}
          </h1>
          <p className='text-muted-foreground'>{tr('rules_introLead', undefined, { locale })}</p>
          <div className='flex flex-wrap gap-2 text-sm'>
            <span className={cn('rounded-full px-3 py-1 font-medium', RULES_ACCENT.soft)}>
              <b>{totalSituations}</b> {tr('rules_statSituations', undefined, { locale })}
            </span>
            <span className='rounded-full bg-violet-100 px-3 py-1 font-medium text-violet-700 dark:bg-violet-500/20 dark:text-violet-300'>
              <b>{LEVELS.length}</b> {tr('rules_statPackages', undefined, { locale })}
            </span>
            <span className='rounded-full bg-emerald-100 px-3 py-1 font-medium text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'>
              {tr('rules_statLangs', undefined, { locale })}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className='flex flex-col gap-3'>
          <h2 className='text-lg font-semibold'>{tr('rules_howTitle', undefined, { locale })}</h2>
          <div className='grid gap-3 sm:grid-cols-3'>
            <HowStep
              index={1}
              title={tr('rules_introHow1', undefined, { locale })}
              body={tr('rules_introHow1t', undefined, { locale })}
            />
            <HowStep
              index={2}
              title={tr('rules_introHow2', undefined, { locale })}
              body={tr('rules_introHow2t', undefined, { locale })}
            />
            <HowStep
              index={3}
              title={tr('rules_introHow3', undefined, { locale })}
              body={tr('rules_introHow3t', undefined, { locale })}
            />
          </div>
          <p className='text-sm text-muted-foreground'>
            {tr('rules_introPersp', undefined, { locale })}
          </p>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <Legend locale={locale} />
            <Button type='button' variant='outline' size='sm' onClick={onOpenCheat}>
              {tr('rules_cheat', undefined, { locale })}
            </Button>
          </div>
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

          <div className='grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3'>
            {LEVELS.map((level) => (
              <PackageCard
                key={level}
                level={level}
                locale={locale}
                selected={sel.includes(level)}
                onToggle={onToggleLevel}
              />
            ))}
          </div>

          <div className='flex flex-wrap items-center gap-3'>
            <Button
              type='button'
              size='lg'
              className={RULES_ACCENT.cta}
              disabled={!canStart}
              onClick={onStart}
            >
              {tr('rules_start', undefined, { locale })} ({pickedSituations})
            </Button>
            <Button
              type='button'
              size='lg'
              variant='outline'
              disabled={!canStart}
              onClick={onStartExam}
            >
              🎓 {tr('rules_startExam', undefined, { locale })} ({examCount})
            </Button>
            <span className='text-sm text-muted-foreground'>
              {canStart
                ? `${pickedSituations} ${tr('rules_statSituations', undefined, { locale })} · ${sel.length}/${LEVELS.length} ${tr('rules_statPackages', undefined, { locale })} ${tr('rules_selSum', undefined, { locale })}`
                : tr('rules_selNone', undefined, { locale })}
            </span>
          </div>
          <p className='text-xs text-muted-foreground'>
            {tr('rules_examDesc', undefined, { locale })}
          </p>
        </CardContent>
      </Card>

      <p className='text-xs text-muted-foreground'>
        WFDF Rules of Ultimate 2025–2028 · CC BY 4.0 World Flying Disc Federation
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main organism
// ---------------------------------------------------------------------------

export function RulesTrainer({ locale, isSignedIn = false }: RulesTrainerProps) {
  const run = useRun();
  const [hydrated, setHydrated] = React.useState(false);
  const [sel, setSel] = React.useState<readonly Level[]>(LEVELS);
  const [answers, setAnswers] = React.useState<AnswersById>({});
  const [packages, setPackages] = React.useState<PackagesByLevel>({});
  const [perms, setPerms] = React.useState<PermsById>({});
  const [screen, setScreen] = React.useState<Screen>('intro');
  const [currentId, setCurrentId] = React.useState<ScenarioId | null>(null);
  const [openRule, setOpenRule] = React.useState<string | null>(null);
  const [cheatOpen, setCheatOpen] = React.useState(false);

  // Server-side progress (Phase 2 step 12) — `importedAt` mirrors the
  // additive `RulesProgress.importedAt` field (see `~/lib/rules/progress.js`)
  // and is read back on hydration below so a save mid-session never wipes it.
  const [importedAt, setImportedAt] = React.useState<number | undefined>(undefined);
  const [saveStatus, setSaveStatus] = React.useState<SaveStatus>('idle');
  const [importStatus, setImportStatus] = React.useState<SaveStatus>('idle');
  // Bumped after a successful submit/import so `RulesProgressPanel` refetches
  // — it otherwise only fetches once per `isSignedIn` transition.
  const [progressRefreshToken, setProgressRefreshToken] = React.useState(0);
  // Guards "submit once per completed run" (not per render, and not again on
  // a re-visit of an already-submitted summary/results screen) — reset
  // wherever a NEW practice run or exam sitting starts.
  const practiceSubmittedRef = React.useRef(false);
  const examSubmittedRef = React.useRef(false);

  // Exam/review — a single sitting, never persisted (see `AGENTS.md`'s "no
  // I/O" note and the plan's explicit "do not persist exam state").
  const [examState, setExamState] = React.useState<ExamState | null>(null);
  const [reviewQ, setReviewQ] = React.useState(0);
  // The option just clicked in the exam, while the engine's own `Answer`
  // update is deliberately held back for the pacing delay below — see
  // `handleExamAnswer`.
  const [examPendingPick, setExamPendingPick] = React.useState<number | null>(null);
  const examTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (examTimerRef.current !== null) clearTimeout(examTimerRef.current);
    },
    [],
  );

  // The cheat sheet must never be reachable during an exam (`app.js:238`
  // hid the same button) — force it closed the moment the exam screen is
  // entered, rather than relying solely on no screen ever rendering the
  // trigger there.
  React.useEffect(() => {
    if (screen === 'exam') setCheatOpen(false);
  }, [screen]);

  const [animT, setAnimT] = React.useState(0);
  const [animPlaying, setAnimPlaying] = React.useState(false);
  const [slow, setSlow] = React.useState(false);

  // Load saved progress once. Never read localStorage during render.
  React.useEffect(() => {
    const progress = loadProgress();
    setAnswers(progress.answers);
    if (progress.sel.length > 0) setSel(progress.sel);
    setImportedAt(progress.importedAt);
    setHydrated(true);
  }, []);

  // Persist progress whenever it changes, once the initial load has landed
  // (otherwise this would immediately overwrite a saved run with the
  // pre-hydration defaults). `importedAt` is spread in only when set —
  // `exactOptionalPropertyTypes` (see `tsconfig.base.json`) rejects an
  // explicit `importedAt: undefined`, and omitting the key entirely is also
  // what keeps a never-imported payload identical to before this feature.
  React.useEffect(() => {
    if (!hydrated) return;
    saveProgress({ version: 1, answers, sel, ...(importedAt === undefined ? {} : { importedAt }) });
  }, [hydrated, answers, sel, importedAt]);

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
    if (screen !== 'loadingPractice' && screen !== 'loadingExam') return;
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

    // Everything selected is loaded.
    if (poolIds.length === 0) {
      setScreen('practiceError');
      return;
    }

    if (screen === 'loadingExam') {
      const ex = startExam(scenarios, sel);
      if (ex.qs.length === 0) {
        setScreen('practiceError');
        return;
      }
      setExamState(ex);
      setReviewQ(0);
      setExamPendingPick(null);
      setScreen('exam');
      return;
    }

    // Build the practice run once and enter practice.
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

  const examQId = examState ? examState.qs[examState.i] : undefined;
  const examScenario = examQId ? (scenariosById.get(examQId) ?? null) : null;
  const examCurrentAnswer = examState
    ? (examState.answers[examState.i] ?? blankAnswer())
    : blankAnswer();
  const examCurrentPerms = examState ? examState.perms[examState.i] : undefined;

  const reviewQId = examState ? examState.qs[reviewQ] : undefined;
  const reviewScenario = reviewQId ? (scenariosById.get(reviewQId) ?? null) : null;
  const reviewAnswer = examState ? (examState.answers[reviewQ] ?? blankAnswer()) : blankAnswer();
  const reviewPerms = examState ? examState.perms[reviewQ] : undefined;

  // The scenario/answer/mode actually driving the field animation right
  // now — one indirection so `animLimit` (the spoiler gate) and the replay
  // controls work identically whether the active screen is practice, the
  // exam, or a review.
  const activeMode: Mode = screen === 'exam' ? 'exam' : screen === 'review' ? 'review' : 'learn';
  const activeScenario =
    screen === 'exam' ? examScenario : screen === 'review' ? reviewScenario : currentScenario;
  const activeAnswer =
    screen === 'exam' ? examCurrentAnswer : screen === 'review' ? reviewAnswer : currentAnswer;
  const activeId = activeScenario?.id ?? null;

  const limit = activeScenario
    ? animLimit({ mode: activeMode, scenario: activeScenario, answer: activeAnswer })
    : 0;

  // Reset/autoplay the demo when navigating to a (possibly new) scenario —
  // in ANY of the three modes that show one (practice, exam, review).
  // Deliberately scoped to `activeId`/`screen` only — answering a step
  // must not rewind or restart the demo (see `handleAnswer` /
  // `handleExamAnswer` below), and `activeId` stays constant while
  // stepping through a single scenario's chain in every mode.
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation-only reset is the design
  React.useEffect(() => {
    if (screen !== 'practice' && screen !== 'exam' && screen !== 'review') return;
    if (activeId === null) return;
    const scenario = scenariosById.get(activeId);
    if (!scenario) return;
    // Practice resumes at rest if the chain was already completed earlier
    // (e.g. navigating back via the pips); exam/review always restart the
    // lead-up from 0 for the newly-entered question.
    const restAtDur = screen === 'practice' && (answers[activeId]?.done ?? false);
    setAnimT(restAtDur ? scenario.dur : 0);
    setAnimPlaying(false);
    if (restAtDur) return;
    const timer = setTimeout(() => setAnimPlaying(true), 500);
    return () => clearTimeout(timer);
  }, [activeId, screen]);

  useAnimationFrame((dt) => {
    setAnimT((prev) => Math.min(prev + dt * (slow ? 0.42 : 1), limit));
  }, animPlaying);

  React.useEffect(() => {
    if (animPlaying && animT >= limit) setAnimPlaying(false);
  }, [animPlaying, animT, limit]);

  // Kept sorted ascending: `sel` is both the practice pool's order (see
  // `pool`) and the `packages` array POSTed with an attempt, so a click order
  // of 3-then-1 must not produce a different run from 1-then-3.
  const handleToggleLevel = (level: Level) => {
    setSel((prev) =>
      prev.includes(level)
        ? prev.filter((l) => l !== level)
        : [...prev, level].sort((a, b) => a - b),
    );
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
    setExamState(null);
    setExamPendingPick(null);
    practiceSubmittedRef.current = false;
    examSubmittedRef.current = false;
    setSaveStatus('idle');
    setScreen('intro');
  };

  const handleStartPractice = () => {
    practiceSubmittedRef.current = false;
    setSaveStatus('idle');
    setScreen('loadingPractice');
  };

  /**
   * POSTs one attempt (Phase 2 step 12, `docs/plans/rules-trainer.md`) for
   * `mode: 'practice'` or `'exam'` — shared by the two auto-submit effects
   * below. Guarded by `isSignedIn` at every call site, never here, so a
   * missing guard at a call site fails loudly (a stray call while signed
   * out would 401) rather than silently no-op.
   */
  const submitAttempt = async (
    mode: 'practice' | 'exam',
    results: ReadonlyArray<{
      readonly scenario_id: string;
      readonly steps: ReadonlyArray<Option.Option<number>>;
    }>,
  ) => {
    setSaveStatus('saving');
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.rulesTrainer.submitAttempt({ payload: { mode, packages: sel, results } }),
      ),
      Effect.mapError(() =>
        ClientError.make(tr('rules_progressSaveFailed', undefined, { locale })),
      ),
      run({}),
    );
    // A failed submit must not touch local progress — `answers`/`sel` (the
    // device's own source of truth) are never read from `result`, only the
    // status shown to the player changes.
    setSaveStatus(Option.isSome(result) ? 'saved' : 'failed');
    if (Option.isSome(result)) setProgressRefreshToken((t) => t + 1);
  };

  // Submit exactly once when a practice run reaches its summary screen —
  // guarded by the ref (not state) so a re-render never re-fires it, and
  // reset at every new-run entry point (`handleStartPractice`/`handleRestart`).
  // Deliberately scoped to `[screen, isSignedIn]` only: `poolIds`/`answers`/
  // `submitAttempt` are read once, at the moment `summary` is entered, not
  // tracked for changes — this must fire once per run, not on every answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: submit-once-on-entry is the design
  React.useEffect(() => {
    if (!isSignedIn) return;
    if (screen !== 'summary') return;
    if (practiceSubmittedRef.current) return;
    practiceSubmittedRef.current = true;
    void submitAttempt('practice', attemptResults(poolIds.map((id) => [id, answers[id]] as const)));
  }, [screen, isSignedIn]);

  // Same idea for the exam, at `examResults` — `examState` carries its own
  // `qs`/`answers` (index-parallel, not id-keyed; see `engine/state.ts`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: submit-once-on-entry is the design
  React.useEffect(() => {
    if (!isSignedIn) return;
    if (screen !== 'examResults') return;
    if (examSubmittedRef.current) return;
    if (!examState) return;
    examSubmittedRef.current = true;
    void submitAttempt(
      'exam',
      attemptResults(examState.qs.map((id, i) => [id, examState.answers[i]] as const)),
    );
  }, [screen, isSignedIn, examState]);

  const unimportedAnswerCount = Object.keys(answers).length;
  const showImportPrompt = isSignedIn && importedAt === undefined && unimportedAnswerCount > 0;

  const handleImportLocalProgress = async () => {
    setImportStatus('saving');
    const results = attemptResults(Object.entries(answers));
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.rulesTrainer.submitAttempt({
          payload: { mode: 'practice', packages: sel.length > 0 ? sel : LEVELS, results },
        }),
      ),
      Effect.mapError(() =>
        ClientError.make(tr('rules_progressSaveFailed', undefined, { locale })),
      ),
      run({}),
    );
    if (Option.isSome(result)) {
      setImportedAt(Date.now());
      setImportStatus('saved');
      setProgressRefreshToken((t) => t + 1);
    } else {
      // Import failing leaves `importedAt` unset and every local answer in
      // place — the prompt simply stays offered for a retry.
      setImportStatus('failed');
    }
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

  // A `RunState` for the engine's exam/review transitions — `sel`/`answers`/
  // `perms` are along for the ride (the type requires them) but none of
  // `examAnswer`/`advanceExam`/`openReview`/`examScore` ever read them; only
  // `exam` (and, for `openReview`, the `k` argument) matters.
  const buildExamRunState = (mode: Mode, current: ScenarioId) => ({
    lang: locale,
    mode,
    current,
    sel,
    answers,
    perms,
    exam: examState,
    reviewQ,
  });

  const handleStartExam = () => {
    if (sel.length === 0) return;
    examSubmittedRef.current = false;
    setSaveStatus('idle');
    setScreen('loadingExam');
  };

  /**
   * One click in the exam. Mirrors the source's `examAnswer` pacing
   * (`AGENTS.md`: 450ms once the chain completes, 350ms between steps)
   * exactly: the underlying `Answer` update is computed immediately (so an
   * invalid pick is rejected up front, same as `answerStep`), but is only
   * COMMITTED to `examState` after the delay — until then, `examPendingPick`
   * disables the step's options and marks the clicked one, with no verdict,
   * so the visible chain does not silently jump to the next step/question a
   * frame after the click.
   */
  const handleExamAnswer = (scenario: Scenario, pick: number) => {
    if (!examState || examPendingPick !== null) return;
    const probe = buildExamRunState('exam', scenario.id);
    const afterAnswer = examAnswer(probe, scenario, pick);
    if (afterAnswer === probe || !afterAnswer.exam) return;
    const nextExam = afterAnswer.exam;
    const justAnswered = nextExam.answers[examState.i];
    const done = justAnswered?.done ?? false;

    setExamPendingPick(pick);
    examTimerRef.current = setTimeout(
      () => {
        examTimerRef.current = null;
        setExamPendingPick(null);
        if (done) {
          const advanced = advanceExam({ ...probe, exam: nextExam });
          setExamState(advanced.exam);
          setScreen(advanced.mode === 'examResults' ? 'examResults' : 'exam');
        } else {
          setExamState(nextExam);
        }
      },
      done ? 450 : 350,
    );
  };

  const handleOpenReview = (k: number) => {
    if (!examState) return;
    const qId = examState.qs[k];
    if (qId === undefined) return;
    const next = openReview(buildExamRunState('examResults', qId), k);
    setReviewQ(next.reviewQ);
    setScreen('review');
  };

  const handleBackToResults = () => setScreen('examResults');

  const handleExamAgain = () => {
    const ex = startExam(scenarios, sel);
    if (ex.qs.length === 0) return;
    examSubmittedRef.current = false;
    setSaveStatus('idle');
    setExamState(ex);
    setReviewQ(0);
    setExamPendingPick(null);
    setScreen('exam');
  };

  const handleExamToPractice = () => {
    setExamState(null);
    setScreen('intro');
  };

  const firstExamId = examState?.qs[0];
  const examResultsScore =
    examState && firstExamId !== undefined
      ? examScore(buildExamRunState('examResults', firstExamId))
      : 0;

  return (
    <div className='flex flex-col gap-4'>
      {screen === 'intro' && (
        <>
          {showImportPrompt && (
            <Alert>
              <AlertTitle>{tr('rules_importTitle', undefined, { locale })}</AlertTitle>
              <AlertDescription>
                <p>{tr('rules_importBody', { count: unimportedAnswerCount }, { locale })}</p>
                <div className='flex items-center gap-2'>
                  <Button type='button' size='sm' onClick={() => void handleImportLocalProgress()}>
                    {importStatus === 'saving'
                      ? tr('rules_progressSaving', undefined, { locale })
                      : tr('rules_importCta', undefined, { locale })}
                  </Button>
                  {importStatus === 'failed' && (
                    <span className='text-xs text-destructive'>
                      {tr('rules_progressSaveFailed', undefined, { locale })}
                    </span>
                  )}
                </div>
              </AlertDescription>
            </Alert>
          )}

          <RulesProgressPanel
            locale={locale}
            isSignedIn={isSignedIn}
            refreshToken={progressRefreshToken}
          />

          <IntroScreen
            locale={locale}
            sel={sel}
            onToggleLevel={handleToggleLevel}
            onSelectAll={() => setSel(LEVELS)}
            onSelectNone={() => setSel([])}
            onStart={handleStartPractice}
            onStartExam={handleStartExam}
            onOpenCheat={() => setCheatOpen(true)}
          />
        </>
      )}

      {(screen === 'loadingPractice' || screen === 'loadingExam') && (
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
                  className={cn(
                    'flex size-7 items-center justify-center rounded-full border text-xs font-medium transition-colors',
                    isCurrent
                      ? cn('border-transparent ring-2 ring-blue-500/40', RULES_ACCENT.solid)
                      : a?.done
                        ? a.ok
                          ? 'border-emerald-500 bg-emerald-100 text-emerald-800 dark:border-emerald-400 dark:bg-emerald-400/25 dark:text-emerald-100'
                          : 'border-red-500 bg-red-100 text-red-800 dark:border-red-400 dark:bg-red-400/25 dark:text-red-100'
                        : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted',
                  )}
                >
                  {pos + 1}
                </button>
              );
            })}
            <Badge
              className={cn(
                'ml-auto border-transparent',
                currentScore === poolIds.length && poolIds.length > 0
                  ? VERDICT.correctSolid
                  : RULES_ACCENT.soft,
              )}
            >
              {currentScore} / {poolIds.length}
            </Badge>
          </div>

          <Card>
            <CardContent className='flex flex-col gap-4'>
              <div className='flex flex-wrap items-center gap-2'>
                {/* The package's own accent (see `~/lib/rules/palette.ts`) —
                    the same colour this scenario's package carries on the
                    picker and in the progress panel. */}
                <Badge
                  className={cn('border-transparent', LEVEL_ACCENT[currentScenario.level].soft)}
                >
                  Level {currentScenario.level}
                </Badge>
                <Badge variant='outline'>{text(currentScenario.topic, locale)}</Badge>
                {/* Amber, matching the ring the pitch SVG draws around "you". */}
                <Badge className='ml-auto border-transparent bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200'>
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
                  className={RULES_ACCENT.cta}
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
                <Button type='button' variant='ghost' size='sm' onClick={() => setCheatOpen(true)}>
                  {tr('rules_cheat', undefined, { locale })}
                </Button>
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
                mode='learn'
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
                  <Button type='button' className={RULES_ACCENT.cta} onClick={handleNext}>
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
              <span
                className={
                  currentScore === poolIds.length && poolIds.length > 0
                    ? VERDICT.correctText
                    : RULES_ACCENT.text
                }
              >
                {currentScore}
              </span>
              <span className='text-muted-foreground'> / {poolIds.length}</span>
            </div>
            {isSignedIn && saveStatus !== 'idle' && (
              <p
                className={
                  saveStatus === 'failed'
                    ? 'text-sm text-destructive'
                    : 'text-sm text-muted-foreground'
                }
              >
                {saveStatus === 'saving' && tr('rules_progressSaving', undefined, { locale })}
                {saveStatus === 'saved' && tr('rules_progressSaved', undefined, { locale })}
                {saveStatus === 'failed' && tr('rules_progressSaveFailed', undefined, { locale })}
              </p>
            )}
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
                    className={cn(
                      'flex items-center gap-2 rounded-md border p-2 text-left text-sm transition-colors',
                      a?.ok ? VERDICT.correctRow : VERDICT.wrongRow,
                    )}
                  >
                    {a?.ok ? (
                      <Check className={cn('size-4', VERDICT.correctText)} aria-hidden='true' />
                    ) : (
                      <X className={cn('size-4', VERDICT.wrongText)} aria-hidden='true' />
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
            <div className='flex flex-wrap gap-2'>
              <Button type='button' onClick={handleStartExam}>
                🎓 {tr('rules_startExam', undefined, { locale })}
              </Button>
              <Button type='button' variant='outline' onClick={handleRestart}>
                {tr('rules_restart', undefined, { locale })}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {screen === 'exam' && examState && examScenario && (
        <RulesExamQuestion
          locale={locale}
          scenario={examScenario}
          answer={examCurrentAnswer}
          perms={examCurrentPerms}
          questionIndex={examState.i}
          questionCount={examState.qs.length}
          pendingPick={examPendingPick}
          animT={animT}
          slow={slow}
          onPlay={() => {
            setAnimT(0);
            setAnimPlaying(true);
          }}
          onToggleSlow={() => setSlow((v) => !v)}
          onAnswer={(pick) => handleExamAnswer(examScenario, pick)}
        />
      )}

      {screen === 'examResults' && examState && (
        <>
          {isSignedIn && saveStatus !== 'idle' && (
            <p
              className={
                saveStatus === 'failed'
                  ? 'text-sm text-destructive'
                  : 'text-sm text-muted-foreground'
              }
            >
              {saveStatus === 'saving' && tr('rules_progressSaving', undefined, { locale })}
              {saveStatus === 'saved' && tr('rules_progressSaved', undefined, { locale })}
              {saveStatus === 'failed' && tr('rules_progressSaveFailed', undefined, { locale })}
            </p>
          )}
          <RulesExamResults
            locale={locale}
            examState={examState}
            score={examResultsScore}
            scenariosById={scenariosById}
            onReview={handleOpenReview}
            onExamAgain={handleExamAgain}
            onToPractice={handleExamToPractice}
          />
        </>
      )}

      {screen === 'review' && examState && reviewScenario && (
        <RulesReview
          locale={locale}
          scenario={reviewScenario}
          answer={reviewAnswer}
          perms={reviewPerms}
          questionIndex={reviewQ}
          questionCount={examState.qs.length}
          animT={animT}
          slow={slow}
          onPlay={() => {
            setAnimT(0);
            setAnimPlaying(true);
          }}
          onToggleSlow={() => setSlow((v) => !v)}
          onOpenRule={setOpenRule}
          onBackToResults={handleBackToResults}
        />
      )}

      <RulesCheatSheet locale={locale} open={cheatOpen} onOpenChange={setCheatOpen} />

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
