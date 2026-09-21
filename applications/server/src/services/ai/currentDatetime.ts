/**
 * `current_datetime` — the only zero-parameter tool. Plan
 * `.work-plans/ai-app-interaction.md` §8 / §13.5.
 *
 * `computeCurrentDatetime` is a pure time computation over `DateTime.now`
 * (hence driven by `TestClock` like every other clock read in this codebase),
 * kept separate from the tool wiring (`readTools.ts#currentDatetime`) so it
 * is directly unit-testable with a zone table without a `ToolContext`.
 */
import { DateTime, Effect, Option } from 'effect';

export interface CurrentDatetimeResult {
  readonly nowUtcIso: string;
  readonly teamTimezone: string;
  readonly todayTeamLocal: string; // YYYY-MM-DD, in `teamTimezone`
  readonly nowTeamLocal: string; // YYYY-MM-DDTHH:mm, in `teamTimezone`
  readonly utcOffsetMinutes: number; // teamTimezone's offset from UTC at `nowUtcIso`
}

const pad2 = (n: number): string => n.toString().padStart(2, '0');

/**
 * `team_settings.timezone` is untrusted free-form TEXT (no CHECK constraint —
 * see `applications/server/AGENTS.md`), so an invalid IANA zone id must
 * degrade to `Europe/Prague` rather than throw. Same fallback and the same
 * reasoning as `resolveZoned` in `src/api/event.ts`. The REQUESTED zone
 * string is still echoed back as `teamTimezone` — only the computation falls
 * back, not the reported label.
 */
export const computeCurrentDatetime = (
  teamTimezone: string,
): Effect.Effect<CurrentDatetimeResult> =>
  DateTime.now.pipe(
    Effect.map((now) => {
      const zoned = Option.getOrElse(DateTime.setZoneNamed(now, teamTimezone), () =>
        DateTime.setZoneNamedUnsafe(now, 'Europe/Prague'),
      );
      const parts = DateTime.toParts(zoned);
      const todayTeamLocal = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
      const nowTeamLocal = `${todayTeamLocal}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
      return {
        nowUtcIso: DateTime.formatIso(now),
        teamTimezone,
        todayTeamLocal,
        nowTeamLocal,
        utcOffsetMinutes: DateTime.zonedOffset(zoned) / 60000,
      };
    }),
  );
