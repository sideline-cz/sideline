// Complete literal classes: Tailwind cannot see interpolated names (see lib/rules/palette.ts)
const PALETTE = [
  'bg-emerald-500',
  'bg-sky-500',
  'bg-amber-500',
  'bg-violet-500',
  'bg-rose-500',
  'bg-teal-500',
  'bg-orange-500',
  'bg-fuchsia-500',
] as const;

export const FALLBACK_COLOR = 'bg-primary';

// Keyed by the team's full type list, so a type keeps its colour whatever the group filter shows.
// ponytail: colours repeat after 8 types; add hues if a team defines more
export const activityTypeColors = (typeNames: ReadonlyArray<string>): ReadonlyMap<string, string> =>
  new Map(typeNames.map((name, i) => [name, PALETTE[i % PALETTE.length]]));
