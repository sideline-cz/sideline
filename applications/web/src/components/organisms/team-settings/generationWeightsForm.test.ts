import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  type GenerationWeightsFormValues,
  generationWeightsRequestFrom,
  hasGenerationWeightsErrors,
  validateGenerationWeights,
} from './generationWeightsForm';
import { isFormDirty } from './useCardForm';

const BASE: GenerationWeightsFormValues = {
  weightElo: 1,
  weightSize: 1,
  weightGender: 1,
  defaultTeamCount: '2',
  maxIterations: '100',
};

const EDITED: GenerationWeightsFormValues = {
  weightElo: 3,
  weightSize: 2,
  weightGender: 0.5,
  defaultTeamCount: '4',
  maxIterations: '500',
};

const FIELDS = Object.keys(BASE) as ReadonlyArray<keyof GenerationWeightsFormValues>;
const edit = (key: keyof GenerationWeightsFormValues): GenerationWeightsFormValues => ({
  ...BASE,
  [key]: EDITED[key],
});

describe('GenerationWeightsFormValues', () => {
  describe('every field enables the Save button', () => {
    it.each(FIELDS)('%s', (key) => {
      expect(isFormDirty(BASE, edit(key))).toBe(true);
    });
  });

  describe('every field the form tracks is actually sent', () => {
    const baseRequest = JSON.stringify(generationWeightsRequestFrom(BASE));
    it.each(FIELDS)('%s', (key) => {
      expect(JSON.stringify(generationWeightsRequestFrom(edit(key)))).not.toBe(baseRequest);
    });
  });
});

describe('generationWeightsRequestFrom', () => {
  it('sends the counts as numbers, not the strings the inputs hold', () => {
    const req = generationWeightsRequestFrom(EDITED);
    expect(req.defaultTeamCount).toStrictEqual(Option.some(4));
    expect(req.maxIterations).toStrictEqual(Option.some(500));
  });
});

// The card used to compute a single `isValid`, disable Save with it, and
// display nothing — so the button greyed out and never said which number was
// wrong. These pin the per-field messages that replaced that.
describe('validateGenerationWeights', () => {
  it('accepts the saved values', () => {
    expect(validateGenerationWeights(BASE)).toEqual({});
    expect(hasGenerationWeightsErrors(validateGenerationWeights(BASE))).toBe(false);
  });

  it.each(['', '1', '21', 'abc'])('rejects a team count of %s and names the field', (v) => {
    expect(validateGenerationWeights({ ...BASE, defaultTeamCount: v }).defaultTeamCount).toBe(
      'teamGenSettings_defaultTeamCountInvalid',
    );
  });

  it.each(['', '-1', '10001'])('rejects max iterations of %s and names the field', (v) => {
    expect(validateGenerationWeights({ ...BASE, maxIterations: v }).maxIterations).toBe(
      'teamGenSettings_maxIterationsInvalid',
    );
  });

  it('allows zero iterations — that is snake-draft only, not an empty field', () => {
    expect(validateGenerationWeights({ ...BASE, maxIterations: '0' })).toEqual({});
  });

  it('reports both fields at once so each renders under its own input', () => {
    const errors = validateGenerationWeights({
      ...BASE,
      defaultTeamCount: '',
      maxIterations: '99999',
    });
    expect(Object.keys(errors).sort()).toEqual(['defaultTeamCount', 'maxIterations']);
  });
});
