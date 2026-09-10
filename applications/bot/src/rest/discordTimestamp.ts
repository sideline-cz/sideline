import { DateTime, Option } from 'effect';

export type DiscordTimestampStyle = 'D' | 'F' | 'R' | 'd' | 'f' | 't';

/** Discord renders these client-side, in the VIEWER's timezone. Only `D`/`d` hide the clock. */
export const discordTimestampFromEpochSeconds = (
  seconds: number,
  style: DiscordTimestampStyle = 'f',
): string => `<t:${seconds}:${style}>`;

export const toDiscordTimestamp = (dt: DateTime.Utc, style: DiscordTimestampStyle = 'f'): string =>
  discordTimestampFromEpochSeconds(Math.floor(Number(DateTime.toEpochMillis(dt)) / 1000), style);

/** Discord renders <t:…:D> client-side, in the VIEWER's zone. Anchoring the display
 *  instant at 12:00Z of the intended calendar date renders that date for every viewer
 *  whose UTC offset is in [-12, +12). It is the maximum-margin choice: no single
 *  instant can cover the full -12…+14 span, which is 26 hours wide. Do NOT "improve"
 *  this to 10:00Z to rescue +14 — that breaks -11 instead, and -11 has more members.
 *  This is NOT storage.
 *
 *  TOTAL BY CONSTRUCTION. `DateTime.makeUnsafe` THROWS an IllegalArgumentError on a malformed
 *  input, and a date-only string arriving over the wire is a plain `Schema.String` — so one
 *  bad producer value would become a DEFECT inside a reconcile path. `DateTime.make` returns
 *  an Option and cannot throw; fall back to the raw instant, which is exactly the
 *  pre-this-fix render. */
export const discordDateInstant = (dateOnly: string, fallbackInstant: DateTime.Utc): DateTime.Utc =>
  Option.getOrElse(DateTime.make(`${dateOnly}T12:00:00Z`), () => fallbackInstant);
