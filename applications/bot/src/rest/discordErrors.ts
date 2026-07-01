/** Shared helpers for classifying dfx Discord REST `ErrorResponse` errors by HTTP
 * status / Discord JSON error code. Used by the `/sudo` command and its
 * `sudo-leave` button — kept local to those two call sites (see AGENTS.md scope
 * note) rather than folded into the older, independently-evolved copies in
 * summon/summarize/carpool. */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const numberProp = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
};

const recordProp = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = record[key];
  return isRecord(value) ? value : {};
};

/** Discord's REST error has the HTTP status on `err.response.status` and the
 * Discord JSON error code on `err.data.code`. Only 403 / code 50013 count as
 * "bot lacks permission". */
export const isDiscordPermissionError = (error: unknown): boolean => {
  if (!isRecord(error)) return false;
  const response = recordProp(error, 'response');
  const data = recordProp(error, 'data');
  const httpStatus = numberProp(response, 'status') ?? numberProp(error, 'status');
  if (httpStatus === 403) return true;
  const discordCode = numberProp(data, 'code') ?? numberProp(error, 'code');
  return discordCode === 50013;
};

/** 404 (Unknown Member/User/Role) means the role assignment is already gone — treat as
 * success rather than an error. Covers HTTP 404 and Discord JSON error codes
 * Unknown Member (10007), Unknown Role (10011), Unknown User (10013) — the last three
 * can arrive without an HTTP status when surfaced via `err.data.code` alone (e.g. when
 * removing a role from a member who has already left the guild). */
export const isDiscordNotFoundError = (error: unknown): boolean => {
  if (!isRecord(error)) return false;
  const response = recordProp(error, 'response');
  const data = recordProp(error, 'data');
  const httpStatus = numberProp(response, 'status') ?? numberProp(error, 'status');
  if (httpStatus === 404) return true;
  const discordCode = numberProp(data, 'code') ?? numberProp(error, 'code');
  return discordCode === 10007 || discordCode === 10011 || discordCode === 10013;
};
