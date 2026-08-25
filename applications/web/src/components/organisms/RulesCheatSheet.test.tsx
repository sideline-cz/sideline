// Every row of all three `CHEAT_SHEET` tables must render, plus the hand
// signals from `SIGNALS` — see `RulesTrainer.test.tsx` for the "unavailable
// during an exam" half of this requirement (that's a `RulesTrainer` state
// invariant, not something this presentational component can assert about
// itself).

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => key,
  setTranslationOverrides: vi.fn(),
}));

const FIXTURE_CHEAT_SHEET = {
  cheatStallH: { en: ['After…', 'Resumes at', 'Rule'], cs: ['Po…', 'Pokračuje na', 'Pravidlo'] },
  cheatStallRows: {
    en: [
      ['Accepted breach by defence', '"Stalling 1"', '9.5.1'],
      ['Accepted breach by offence', 'max 9', '9.5.2'],
      ['Contested stall-out', '"Stalling 8"', '9.5.3'],
    ],
    cs: [
      ['Uznaný prohřešek obrany', '„Stalling 1“', '9.5.1'],
      ['Uznaný prohřešek útoku', 'max 9', '9.5.2'],
      ['Kontestovaný stall-out', '„Stalling 8“', '9.5.3'],
    ],
  },
  cheatWhoRows: {
    en: [
      ['"Foul"', 'Only the fouled player'],
      ['"Travel"', 'Any defensive player'],
    ],
    cs: [
      ['„Foul“', 'Jen faulovaný hráč'],
      ['„Travel“', 'Kterýkoli bránící hráč'],
    ],
  },
  cheatGoldRows: {
    en: [
      ['Disc in the air', 'play continues'],
      ['Did it affect the play?', 'the result stands'],
    ],
    cs: [
      ['Disk ve vzduchu', 'hraje se dál'],
      ['Ovlivnilo to hru?', 'výsledek platí'],
    ],
  },
};

const FIXTURE_SIGNALS = {
  '1': { en: 'Start / stop', cs: 'Start / stop' },
  '7': { en: 'Travel', cs: 'Travel' },
};

vi.mock('@sideline/rules/reference', () => ({
  CHEAT_SHEET: FIXTURE_CHEAT_SHEET,
  SIGNALS: FIXTURE_SIGNALS,
}));

const { RulesCheatSheet } = await import('~/components/organisms/RulesCheatSheet.js');

describe('RulesCheatSheet', () => {
  it('renders every row of all three tables, plus every hand signal', () => {
    render(<RulesCheatSheet locale='en' open={true} onOpenChange={() => {}} />);

    for (const row of FIXTURE_CHEAT_SHEET.cheatStallRows.en) {
      expect(screen.getByText(row[0])).not.toBeNull();
      expect(screen.getByText(row[1])).not.toBeNull();
      expect(screen.getByText(`§ ${row[2]}`)).not.toBeNull();
    }
    for (const row of FIXTURE_CHEAT_SHEET.cheatWhoRows.en) {
      expect(screen.getByText(row[0])).not.toBeNull();
      expect(screen.getByText(row[1])).not.toBeNull();
    }
    for (const row of FIXTURE_CHEAT_SHEET.cheatGoldRows.en) {
      expect(screen.getByText(row[0])).not.toBeNull();
      expect(screen.getByText(row[1])).not.toBeNull();
    }
    for (const [id, entry] of Object.entries(FIXTURE_SIGNALS)) {
      expect(screen.getByText(`#${id} ${entry.en}`)).not.toBeNull();
    }
  });

  it('renders the Czech table content when locale is cs', () => {
    render(<RulesCheatSheet locale='cs' open={true} onOpenChange={() => {}} />);

    expect(screen.getByText(FIXTURE_CHEAT_SHEET.cheatStallRows.cs[0][0])).not.toBeNull();
    expect(screen.getByText(FIXTURE_CHEAT_SHEET.cheatWhoRows.cs[0][0])).not.toBeNull();
    expect(screen.getByText(FIXTURE_CHEAT_SHEET.cheatGoldRows.cs[0][0])).not.toBeNull();
  });

  it('renders nothing when closed', () => {
    render(<RulesCheatSheet locale='en' open={false} onOpenChange={() => {}} />);
    expect(screen.queryByText(FIXTURE_CHEAT_SHEET.cheatStallRows.en[0][0])).toBeNull();
  });
});
