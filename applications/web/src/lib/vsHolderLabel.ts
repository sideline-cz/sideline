import { tr } from '~/lib/translations.js';

/**
 * A variable symbol stays reserved after its holder leaves the team — `uq_team_members_team_variable_symbol`
 * deliberately has no `active` predicate, so a late transfer quoting an old symbol can never be
 * attributed to whoever came after them. That makes "taken by a name you don't recognise" a normal
 * state rather than a glitch, so both conflict messages say when the holder has left.
 */
export const vsHolderLabel = (name: string | null, active: boolean): string => {
  const member = name ?? tr('members_fieldEmpty');
  return active ? member : tr('members_vs_formerMember', { member });
};
