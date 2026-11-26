import { ActivityType } from '@sideline/domain';
import { Option } from 'effect';

// Complete literal classes: Tailwind cannot see interpolated names (see lib/rules/palette.ts)
export const ACTIVITY_COLOR_CLASSES: Record<ActivityType.ActivityTypeColor, string> = {
  emerald: 'bg-emerald-500',
  sky: 'bg-sky-500',
  amber: 'bg-amber-500',
  violet: 'bg-violet-500',
  rose: 'bg-rose-500',
  teal: 'bg-teal-500',
  orange: 'bg-orange-500',
  fuchsia: 'bg-fuchsia-500',
};

const PALETTE = ActivityType.ActivityTypeColor.literals;

export const FALLBACK_COLOR = 'bg-primary';

// The team's pick wins; otherwise the colour is derived from the type's position in the team's
// full type list, so it stays put whatever the group filter shows.
// ponytail: derived colours repeat after 8 types; add hues if a team defines more
export const activityTypeColors = (
  types: ReadonlyArray<{ name: string; color?: Option.Option<ActivityType.ActivityTypeColor> }>,
): ReadonlyMap<string, string> =>
  new Map(
    types.map((t, i) => [
      t.name,
      ACTIVITY_COLOR_CLASSES[
        Option.getOrElse(t.color ?? Option.none(), () => PALETTE[i % PALETTE.length])
      ],
    ]),
  );
