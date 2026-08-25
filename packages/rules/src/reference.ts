import cheatsheet from './content/cheatsheet.json' with { type: 'json' };
import rules from './content/rules.json' with { type: 'json' };
import signals from './content/signals.json' with { type: 'json' };
import type { CheatSheet, RuleEntry, SignalEntry } from './types.js';

/**
 * Rule quotes, keyed by rule number (e.g. `'7.12'`). Subpath
 * `@sideline/rules/reference` — small (20 KB gz) and needed by web to render
 * a `§` chip, so it is kept out of the eager `@sideline/rules/content` entry.
 */
export const RULES: Readonly<Record<string, RuleEntry>> = rules;

/** Hand-signal descriptions, keyed by signal id (e.g. `'7'`). */
export const SIGNALS: Readonly<Record<string, SignalEntry>> = signals;

/**
 * The cheat-sheet tables: the stall-count restart table, who may make which
 * call, and the "golden rules" summaries.
 *
 * This is **content, not chrome**, so it lives here rather than in the
 * `@sideline/i18n` catalogue — every row carries a rulebook citation
 * (`9.5.1`, `15.4`, `16.2`), which is the parent plan's own test for content:
 * "versioned alongside the rulebook citations they encode". Routing it through
 * `tr()` would also have meant ~45 flat catalogue keys for what is naturally
 * three tables. Only the surrounding headings go through `tr()`
 * (`rules_cheatTitle`, `rules_cheatStall`, …), and those are already there.
 */
export const CHEAT_SHEET: CheatSheet = cheatsheet;
