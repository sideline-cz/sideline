import React from 'react';

type Primitive = string | number | boolean;

export interface CardForm<T> {
  /** Current edits. The request payload is built from exactly this object. */
  readonly values: T;
  readonly setField: <K extends keyof T>(key: K, value: T[K]) => void;
  /** True when any field differs from the saved values. */
  readonly isDirty: boolean;
}

/** Exported so the invariant can be tested without rendering a card. */
export const isFormDirty = <T extends Record<string, Primitive>>(baseline: T, values: T): boolean =>
  (Object.keys(baseline) as ReadonlyArray<keyof T>).some((key) => values[key] !== baseline[key]);

/**
 * One form object per Save button.
 *
 * `isDirty` is *derived* from the same object the request payload is built
 * from, so a field cannot be edited-but-untracked (its own Save button stays
 * disabled) or tracked-but-unsent. Both used to be hand-written lists that
 * agreed only by discipline, and twice they stopped agreeing — most recently
 * the rules-quiz fields, compared in the welcome card's flag while the
 * settings handler was the one sending them. The result was a section you
 * could edit but not save, whose only enabled button silently discarded the
 * edit.
 *
 * `baseline` is the saved state as the page currently knows it, recomputed
 * from props on every render: after a save the loader is invalidated, fresh
 * props arrive, and the form goes clean without a reset.
 */
export const useCardForm = <T extends Record<string, Primitive>>(baseline: T): CardForm<T> => {
  const [values, setValues] = React.useState(baseline);

  const setField = React.useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  return { values, setField, isDirty: isFormDirty(baseline, values) };
};
