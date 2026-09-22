// TDD mode — written BEFORE `~/commands/complete/modal.ts` exists.
// Plain vitest (no Effect runtime needed — `buildProfileCompleteModal` is a pure
// function returning a JSON payload), static imports only (bot AGENTS.md
// "Test File Imports — Static Only").
//
// Spec: .work-plans/discord-full-onboarding.md, Task 6 ("ask for gender inside
// the profile modal") and its "Test specification" §Task 6, items 1-2.
//
// `buildProfileCompleteModal(locale)` returns just the `data` object of a MODAL
// interaction callback: `{ custom_id: 'profile-complete', title, components }`.
// Four components, in order:
//   1. type: 1 action row wrapping a type: 4 text input, custom_id 'profile_name', required: true
//   2. type: 1 action row wrapping a type: 4 text input, custom_id 'profile_birth_date', required: true
//   3. type: 1 action row wrapping a type: 4 text input, custom_id 'profile_jersey_number', required: false
//   4. type: 18 Label component wrapping a type: 3 (STRING_SELECT), custom_id
//      'profile_gender', required: true, three options (gender_male/female/other)
//
// Discord rejects the WHOLE modal if any label or the title exceeds 45 characters
// in ANY locale (bot AGENTS.md rule 5) — test 2 loops both locales.

import { describe, expect, it } from 'vitest';
import { buildProfileCompleteModal } from '~/commands/complete/modal.js';

type ActionRowComponent = {
  type: number;
  components: ReadonlyArray<{
    type: number;
    custom_id: string;
    label?: string;
    required?: boolean;
  }>;
};

type LabelComponent = {
  type: number;
  label: string;
  description?: string;
  component: {
    type: number;
    custom_id: string;
    required?: boolean;
    placeholder?: string;
    min_values?: number;
    max_values?: number;
    options: ReadonlyArray<{ value: string; label: string }>;
  };
};

describe('buildProfileCompleteModal — payload shape', () => {
  it('custom_id is the stateless "profile-complete" (no gender suffix)', () => {
    const modal = buildProfileCompleteModal('cs');
    expect(modal.custom_id).toBe('profile-complete');
  });

  it('has exactly four components, in order: three action rows then one label', () => {
    const modal = buildProfileCompleteModal('cs');
    expect(modal.components).toHaveLength(4);

    const [nameRow, birthDateRow, jerseyRow, genderLabel] = modal.components as [
      ActionRowComponent,
      ActionRowComponent,
      ActionRowComponent,
      LabelComponent,
    ];

    expect(nameRow.type).toBe(1);
    expect(nameRow.components[0]?.custom_id).toBe('profile_name');
    expect(nameRow.components[0]?.required).toBe(true);

    expect(birthDateRow.type).toBe(1);
    expect(birthDateRow.components[0]?.custom_id).toBe('profile_birth_date');
    expect(birthDateRow.components[0]?.required).toBe(true);

    expect(jerseyRow.type).toBe(1);
    expect(jerseyRow.components[0]?.custom_id).toBe('profile_jersey_number');
    expect(jerseyRow.components[0]?.required).toBe(false);

    expect(genderLabel.type).toBe(18);
    expect(genderLabel.component.type).toBe(3);
    expect(genderLabel.component.custom_id).toBe('profile_gender');
    expect(genderLabel.component.required).toBe(true);
    expect(genderLabel.component.options).toHaveLength(3);
  });

  it('the gender select has min_values/max_values of exactly 1 (single choice)', () => {
    const modal = buildProfileCompleteModal('en');
    const genderLabel = modal.components[3] as LabelComponent;
    expect(genderLabel.component.min_values).toBe(1);
    expect(genderLabel.component.max_values).toBe(1);
  });
});

describe("buildProfileCompleteModal — Discord's 45-character modal-label ceiling", () => {
  it.each(['en', 'cs'] as const)(
    'every label and the title are ≤45 characters (locale: %s)',
    (locale) => {
      const modal = buildProfileCompleteModal(locale);
      expect(modal.title.length).toBeLessThanOrEqual(45);

      for (const component of modal.components) {
        if (component.type === 1) {
          for (const input of (component as ActionRowComponent).components) {
            if (input.label !== undefined) {
              expect(input.label.length).toBeLessThanOrEqual(45);
            }
          }
        } else if (component.type === 18) {
          expect((component as LabelComponent).label.length).toBeLessThanOrEqual(45);
        }
      }
    },
  );
});
