import rules from './content/rules.json' with { type: 'json' };
import signals from './content/signals.json' with { type: 'json' };
import type { RuleEntry, SignalEntry } from './types.js';

/**
 * Rule quotes, keyed by rule number (e.g. `'7.12'`). Subpath
 * `@sideline/rules/reference` — small (20 KB gz) and needed by web to render
 * a `§` chip, so it is kept out of the eager `@sideline/rules/content` entry.
 */
export const RULES: Readonly<Record<string, RuleEntry>> = rules;

/** Hand-signal descriptions, keyed by signal id (e.g. `'7'`). */
export const SIGNALS: Readonly<Record<string, SignalEntry>> = signals;
