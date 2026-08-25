// Local-only practice progress for the rules trainer (Phase 1 — no server, no
// auth; see docs/plans/rules-trainer.md). Stored under a single versioned
// localStorage key so a future shape change can detect + discard an older
// payload instead of crashing on it.
//
// Keyed by `ScenarioId`, never by array index: the engine's own state
// (`RunState.answers`) is id-keyed for exactly this reason — inserting a new
// scenario into a package must never silently shift a stored user's answers
// onto the wrong scenario (see `packages/rules/src/engine/state.ts`).
import type { Answer, Level, ScenarioId, StepPick } from '@sideline/rules';
import { isLevel } from './level.js';

const STORAGE_KEY = 'sideline.rules.progress.v1';
const CURRENT_VERSION = 1;

export interface RulesProgress {
  readonly version: typeof CURRENT_VERSION;
  readonly answers: Readonly<Record<ScenarioId, Answer>>;
  readonly sel: readonly Level[];
}

export function emptyProgress(sel: readonly Level[] = []): RulesProgress {
  return { version: CURRENT_VERSION, answers: {}, sel };
}

function isStepPick(value: unknown): value is StepPick {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const pickOk = record.pick === null || typeof record.pick === 'number';
  return pickOk && typeof record.ok === 'boolean';
}

function isAnswer(value: unknown): value is Answer {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.steps) &&
    record.steps.every(isStepPick) &&
    typeof record.done === 'boolean' &&
    typeof record.ok === 'boolean'
  );
}

function isUnknownLevel(value: unknown): value is Level {
  return typeof value === 'number' && isLevel(value);
}

function isRulesProgress(value: unknown): value is RulesProgress {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== CURRENT_VERSION) return false;
  if (!Array.isArray(record.sel) || !record.sel.every(isUnknownLevel)) return false;
  if (typeof record.answers !== 'object' || record.answers === null) return false;
  return Object.values(record.answers).every(isAnswer);
}

/**
 * Reads progress from `localStorage`. Never throws: a missing key, a
 * malformed JSON payload, a payload from an older `version`, or
 * `localStorage` being unavailable (private browsing, SSR-less test
 * environments, etc.) all resolve to a fresh empty progress rather than
 * propagating.
 */
export function loadProgress(): RulesProgress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return emptyProgress();
    const parsed: unknown = JSON.parse(raw);
    if (!isRulesProgress(parsed)) return emptyProgress();
    return parsed;
  } catch {
    return emptyProgress();
  }
}

/** Writes progress to `localStorage`. Never throws (quota exceeded, private
 * browsing, or `localStorage` unavailable all fail silently — progress just
 * does not persist for this session). */
export function saveProgress(progress: RulesProgress): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // localStorage unavailable or over quota — progress does not persist,
    // but the trainer itself must keep working in-memory.
  }
}
