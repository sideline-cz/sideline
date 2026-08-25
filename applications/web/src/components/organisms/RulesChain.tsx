import type { Answer, ChainEntry, Lang, Mode, Scenario } from '@sideline/rules';
import { chainView, text } from '@sideline/rules';
import { SIGNALS } from '@sideline/rules/reference';
import { Check, Lock, X } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { tr } from '~/lib/translations.js';

// ---------------------------------------------------------------------------
// Shared building blocks for RulesTrainer.tsx / RulesExam.tsx — split out so
// neither organism needs to import the other (that would be a circular
// import: RulesTrainer renders exam/review screens via RulesExam, and
// RulesExam needs the same step-chain/feedback rendering RulesTrainer's own
// practice screen uses).
// ---------------------------------------------------------------------------

const OFF_LEGEND = '#2f6df6';
const DEF_LEGEND = '#e0483d';
const YOU_LEGEND_RING = '#ffd23f';
const DISC_LEGEND = '#ffe066';

export function Legend({ locale }: { readonly locale: Lang }) {
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

export function RuleChip({
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
// Step chain — the spoiler gate's UI half. Renders exactly what `chainView`
// says: a `locked` step never gets its key label or question, and a step's
// verdict/why text only appears when `showVerdict` is true.
//
// `mode` is threaded straight into `chainView` — 'learn'/'review' behave
// identically there (both reveal a verdict once a step is answered),
// 'exam' never does (see `chainView`'s `blind` flag). `pendingPick` only
// matters in 'exam' mode: it is the option the user just clicked, for which
// the caller has not yet committed the underlying `Answer` (so the demo can
// pace the reveal — see `RulesTrainer.tsx`'s exam pacing). While set, every
// option on the live step renders disabled and the picked one gets a
// neutral "selected" look — never a correctness colour, since the exam
// never shows one.
// ---------------------------------------------------------------------------

export function StepChain({
  scenario,
  answer,
  perms,
  mode,
  locale,
  pendingPick = null,
  onAnswer,
  onOpenRule = () => {},
}: {
  readonly scenario: Scenario;
  readonly answer: Answer;
  readonly perms: ReadonlyArray<ReadonlyArray<number>> | undefined;
  readonly mode: Mode;
  readonly locale: Lang;
  readonly pendingPick?: number | null;
  readonly onAnswer: (pick: number) => void;
  readonly onOpenRule?: (rule: string) => void;
}) {
  const entries: ChainEntry[] = chainView(scenario, answer, mode, perms);
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
        const isPendingStep = mode === 'exam' && entry.state === 'current' && pendingPick !== null;

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
                const pendingSelected = isPendingStep && originalIndex === pendingPick;

                return (
                  <div key={originalIndex} className='flex flex-col gap-1'>
                    <Button
                      type='button'
                      variant={
                        correct
                          ? 'default'
                          : wrong
                            ? 'destructive'
                            : pendingSelected
                              ? 'secondary'
                              : 'outline'
                      }
                      className='h-auto justify-start whitespace-normal text-left'
                      disabled={answered || entry.state !== 'current' || isPendingStep}
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
// Feedback panel — shown once the whole chain is answered. Mode-agnostic:
// 'learn' (end of a practice chain) and 'review' (a fully-answered exam
// question) render identically here.
// ---------------------------------------------------------------------------

export function FeedbackPanel({
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
