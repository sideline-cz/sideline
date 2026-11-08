import type { ActivityLogApi } from '@sideline/domain';
import { ActivityLog } from '@sideline/domain';
import { Option, Schema } from 'effect';

const decodeSeason = Schema.decodeUnknownOption(ActivityLog.ActivitySeasonFilter);

/**
 * Decodes the `season` search param once, for the loader and the page alike.
 * An invalid value is dropped (`{}`), so the default view loads and the UI agrees.
 */
export const validateSeasonSearch = (
  search: Record<string, unknown>,
): { season?: ActivityLog.ActivitySeasonFilter } =>
  Option.match(decodeSeason(search.season), {
    onNone: () => ({}),
    onSome: (season) => ({ season }),
  });

/** Picker output (`string | undefined`) to the typed search value; invalid = default view. */
export const toSeasonSearch = (value: string | undefined) =>
  Option.getOrUndefined(decodeSeason(value));

/**
 * True when `season` is a well-formed id that is not in the loaded seasons (deleted, another
 * team's, or a queued future season). The route drops it so the picker never shows a blank label.
 */
export const isUnknownSeason = (
  seasons: ReadonlyArray<ActivityLogApi.ActivitySeason>,
  season: ActivityLog.ActivitySeasonFilter | undefined,
): boolean =>
  season !== undefined &&
  season !== 'earlier' &&
  seasons.length > 0 &&
  !seasons.some((s) => s.id === season);
