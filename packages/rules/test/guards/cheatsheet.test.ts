/**
 * G19 — the cheat-sheet tables have matching EN/CS shape.
 *
 * Unlike every other content file, these tables are localised WHOLE
 * (`Localized<string[][]>`) rather than field by field, so the two languages
 * can drift out of *alignment* while both remain present and non-empty. G9
 * would stay green while the Czech table showed a different set of rows to the
 * English one, with rulebook citations attached to the wrong entries.
 */
import { describe, expect, it } from 'vitest';
import type { CheatSheet } from '~/types.js';
import { findCheatSheetShapeViolations } from './lib.js';

const { CHEAT_SHEET } = await import('~/reference.js');

const base: CheatSheet = {
  cheatStallH: { en: ['a', 'b'], cs: ['a', 'b'] },
  cheatStallRows: {
    en: [
      ['1', '2'],
      ['3', '4'],
    ],
    cs: [
      ['1', '2'],
      ['3', '4'],
    ],
  },
  cheatWhoRows: { en: [['x', 'y']], cs: [['x', 'y']] },
  cheatGoldRows: { en: [['p', 'q']], cs: [['p', 'q']] },
};

describe('G19 — cheat-sheet EN/CS shape', () => {
  it('real content: both languages line up', () => {
    expect(findCheatSheetShapeViolations(CHEAT_SHEET)).toEqual([]);
  });

  it('real content: the stall table matches its declared column count', () => {
    const width = CHEAT_SHEET.cheatStallH.en.length;
    for (const row of CHEAT_SHEET.cheatStallRows.en) {
      expect(row.length).toBe(width);
    }
  });

  it('bites: a row dropped from the Czech table', () => {
    const bad: CheatSheet = {
      ...base,
      cheatStallRows: { en: base.cheatStallRows.en, cs: [['1', '2']] },
    };
    expect(findCheatSheetShapeViolations(bad)).toEqual(['cheatStallRows: en has 2 rows, cs has 1']);
  });

  it('bites: a cell merged away in one language, leaving a ragged row', () => {
    const bad: CheatSheet = {
      ...base,
      cheatWhoRows: { en: [['x', 'y']], cs: [['x y']] },
    };
    expect(findCheatSheetShapeViolations(bad)).toEqual([
      'cheatWhoRows row 1: en has 2 cells, cs has 1',
    ]);
  });

  it('bites: an empty cell that G9-style presence checks would miss', () => {
    const bad: CheatSheet = {
      ...base,
      cheatGoldRows: { en: [['p', '   ']], cs: [['p', 'q']] },
    };
    expect(findCheatSheetShapeViolations(bad)).toEqual(['cheatGoldRows row 1 cell 2: en is empty']);
  });

  it('bites: a stall row wider than the declared header', () => {
    const bad: CheatSheet = {
      ...base,
      cheatStallRows: {
        en: [
          ['1', '2', '3'],
          ['3', '4'],
        ],
        cs: [
          ['1', '2', '3'],
          ['3', '4'],
        ],
      },
    };
    expect(findCheatSheetShapeViolations(bad)).toContain(
      'cheatStallRows row 1: 3 cells but cheatStallH declares 2 columns',
    );
  });
});
