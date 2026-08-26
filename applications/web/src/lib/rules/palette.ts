import type { Level } from '@sideline/rules';

/**
 * Per-package colour identity for the Rules Trainer.
 *
 * The trainer's nine packages are a difficulty ramp (level 1 "The pull" →
 * level 9 "Advanced"), so the hues ramp with them: emerald → teal → cyan →
 * sky → blue → indigo → violet → fuchsia → rose. A reader can tell two
 * packages apart at a glance, and "further along the ramp" reads as
 * "further along the material".
 *
 * **Every class string here must be a complete, literal Tailwind class.**
 * Tailwind scans source text, so an interpolated `bg-${hue}-500` produces no
 * CSS at all — hence the fully-written-out record rather than a hue name
 * plus template strings. `LeaderboardPage.tsx`'s medal badges use the same
 * literal-class-with-explicit-`dark:` convention.
 *
 * Deliberately NOT built on the `--chart-1…5` theme tokens: those swap hue
 * between light and dark (`--chart-1` is orange in light, blue in dark), so
 * a package's identity would not survive a theme toggle.
 */
export interface LevelAccent {
  /** Accent-coloured text on the page background — headings, counts. */
  readonly text: string;
  /** Filled bar/indicator on a muted track. */
  readonly bar: string;
  /** Low-emphasis filled chip — an unselected badge or number pill. */
  readonly soft: string;
  /** High-emphasis filled chip — a selected number pill. */
  readonly solid: string;
  /** Container styling for a SELECTED package card. */
  readonly selected: string;
  /** Container styling for an unselected package card, including its hover. */
  readonly idle: string;
}

export const LEVEL_ACCENT: Readonly<Record<Level, LevelAccent>> = {
  1: {
    text: 'text-emerald-600 dark:text-emerald-400',
    bar: 'bg-emerald-500',
    soft: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
    solid: 'bg-emerald-500 text-white dark:bg-emerald-400 dark:text-emerald-950',
    selected: 'border-emerald-500 bg-emerald-50 dark:border-emerald-400 dark:bg-emerald-500/10',
    idle: 'border-border hover:border-emerald-400 hover:bg-emerald-50/60 dark:hover:bg-emerald-500/5',
  },
  2: {
    text: 'text-teal-600 dark:text-teal-400',
    bar: 'bg-teal-500',
    soft: 'bg-teal-100 text-teal-700 dark:bg-teal-500/20 dark:text-teal-300',
    solid: 'bg-teal-500 text-white dark:bg-teal-400 dark:text-teal-950',
    selected: 'border-teal-500 bg-teal-50 dark:border-teal-400 dark:bg-teal-500/10',
    idle: 'border-border hover:border-teal-400 hover:bg-teal-50/60 dark:hover:bg-teal-500/5',
  },
  3: {
    text: 'text-cyan-600 dark:text-cyan-400',
    bar: 'bg-cyan-500',
    soft: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-300',
    solid: 'bg-cyan-500 text-white dark:bg-cyan-400 dark:text-cyan-950',
    selected: 'border-cyan-500 bg-cyan-50 dark:border-cyan-400 dark:bg-cyan-500/10',
    idle: 'border-border hover:border-cyan-400 hover:bg-cyan-50/60 dark:hover:bg-cyan-500/5',
  },
  4: {
    text: 'text-sky-600 dark:text-sky-400',
    bar: 'bg-sky-500',
    soft: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300',
    solid: 'bg-sky-500 text-white dark:bg-sky-400 dark:text-sky-950',
    selected: 'border-sky-500 bg-sky-50 dark:border-sky-400 dark:bg-sky-500/10',
    idle: 'border-border hover:border-sky-400 hover:bg-sky-50/60 dark:hover:bg-sky-500/5',
  },
  5: {
    text: 'text-blue-600 dark:text-blue-400',
    bar: 'bg-blue-500',
    soft: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300',
    solid: 'bg-blue-500 text-white dark:bg-blue-400 dark:text-blue-950',
    selected: 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-500/10',
    idle: 'border-border hover:border-blue-400 hover:bg-blue-50/60 dark:hover:bg-blue-500/5',
  },
  6: {
    text: 'text-indigo-600 dark:text-indigo-400',
    bar: 'bg-indigo-500',
    soft: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300',
    solid: 'bg-indigo-500 text-white dark:bg-indigo-400 dark:text-indigo-950',
    selected: 'border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-500/10',
    idle: 'border-border hover:border-indigo-400 hover:bg-indigo-50/60 dark:hover:bg-indigo-500/5',
  },
  7: {
    text: 'text-violet-600 dark:text-violet-400',
    bar: 'bg-violet-500',
    soft: 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300',
    solid: 'bg-violet-500 text-white dark:bg-violet-400 dark:text-violet-950',
    selected: 'border-violet-500 bg-violet-50 dark:border-violet-400 dark:bg-violet-500/10',
    idle: 'border-border hover:border-violet-400 hover:bg-violet-50/60 dark:hover:bg-violet-500/5',
  },
  8: {
    text: 'text-fuchsia-600 dark:text-fuchsia-400',
    bar: 'bg-fuchsia-500',
    soft: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-300',
    solid: 'bg-fuchsia-500 text-white dark:bg-fuchsia-400 dark:text-fuchsia-950',
    selected: 'border-fuchsia-500 bg-fuchsia-50 dark:border-fuchsia-400 dark:bg-fuchsia-500/10',
    idle: 'border-border hover:border-fuchsia-400 hover:bg-fuchsia-50/60 dark:hover:bg-fuchsia-500/5',
  },
  9: {
    text: 'text-rose-600 dark:text-rose-400',
    bar: 'bg-rose-500',
    soft: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300',
    solid: 'bg-rose-500 text-white dark:bg-rose-400 dark:text-rose-950',
    selected: 'border-rose-500 bg-rose-50 dark:border-rose-400 dark:bg-rose-500/10',
    idle: 'border-border hover:border-rose-400 hover:bg-rose-50/60 dark:hover:bg-rose-500/5',
  },
};

/**
 * Right/wrong styling for an answered step.
 *
 * Explicit emerald/red rather than the `--success` / `--destructive` theme
 * tokens: in dark mode `--success` is `oklch(0.35 0.1 150)` — a near-black
 * green — and the correct option is a `disabled` button, so the shared
 * `disabled:opacity-50` on top of it made the single most important thing in
 * an answered step the *least* legible one. Hence `disabled:opacity-100` on
 * both verdict states; the untouched options stay faded, which is the point.
 *
 * The two are separated by border, fill AND the ✓/✕ in the step header, so
 * red/green colour-blindness does not lose the verdict.
 */
export const VERDICT = {
  correctOption:
    'border-emerald-500 bg-emerald-100 text-emerald-900 hover:bg-emerald-100 disabled:opacity-100 dark:border-emerald-400 dark:bg-emerald-400/25 dark:text-emerald-50',
  wrongOption:
    'border-red-500 bg-red-100 text-red-900 hover:bg-red-100 disabled:opacity-100 dark:border-red-400 dark:bg-red-400/25 dark:text-red-50',
  correctStep:
    'border-emerald-500/60 bg-emerald-50 dark:border-emerald-400/40 dark:bg-emerald-500/10',
  wrongStep: 'border-red-500/60 bg-red-50 dark:border-red-400/40 dark:bg-red-500/10',
  /** ✓ / ✕ glyphs, and any other accent-on-background verdict text. */
  correctText: 'text-emerald-600 dark:text-emerald-400',
  wrongText: 'text-red-600 dark:text-red-400',
  /** A clickable row summarising one answered scenario or exam question. */
  correctRow:
    'border-emerald-500/50 bg-emerald-50 hover:bg-emerald-100 dark:border-emerald-400/40 dark:bg-emerald-500/10 dark:hover:bg-emerald-500/20',
  wrongRow:
    'border-red-500/50 bg-red-50 hover:bg-red-100 dark:border-red-400/40 dark:bg-red-500/10 dark:hover:bg-red-500/20',
  /** A filled pip / badge for a fully-correct result. */
  correctSolid: 'border-transparent bg-emerald-600 text-white dark:bg-emerald-500 dark:text-white',
} as const;

/**
 * The trainer's own brand accent — the same blue the pitch SVG paints the
 * offence in (`#2f6df6`, see `RulesChain.tsx`'s `OFF_LEGEND`), so the chrome
 * around a scenario and the scenario itself read as one thing.
 */
export const RULES_ACCENT = {
  text: 'text-blue-600 dark:text-blue-400',
  soft: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300',
  solid: 'bg-blue-600 text-white dark:bg-blue-500',
  border: 'border-blue-500/40 dark:border-blue-400/30',
  surface: 'bg-blue-50 dark:bg-blue-500/10',
  /**
   * Override for the trainer's own primary buttons — the two that drive the
   * flow forward (start a practice run, replay the demo).
   *
   * This is the one place the trainer departs from the app's monochrome
   * `primary`, and it is deliberate: both buttons sit inside screens that are
   * otherwise fully colour-coded, where a black (light) / white (dark) pill
   * reads as the least important thing present. Everything else — "select
   * all", "clear", the cheat sheet, the exam entry point — stays on the
   * shared `outline`/`default` variants.
   */
  cta: 'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:text-blue-950 dark:hover:bg-blue-400',
} as const;
