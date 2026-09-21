import { DisplayName } from '@sideline/domain';
import { Option, pipe, Schedule } from 'effect';
import type { Permission } from './permissions.js';

export const POLL_BATCH_SIZE = 50;

export const retryPolicy = Schedule.exponential('1 second').pipe(Schedule.both(Schedule.recurs(3)));

export const allow = (permission: Permission) => Number(permission.allow ?? 0);

export const deny = (permission: Permission) => Number(permission.deny ?? 0);

const pickName = (entry: {
  readonly name: Option.Option<string>;
  readonly nickname: Option.Option<string>;
  readonly display_name: Option.Option<string>;
  readonly username: Option.Option<string>;
}): Option.Option<string> =>
  DisplayName.pickDisplayName({
    name: entry.name,
    nickname: entry.nickname,
    displayName: entry.display_name,
    username: entry.username,
  }).pipe(Option.map((u) => `**${u}**`));

export const formatName = (entry: {
  readonly name: Option.Option<string>;
  readonly nickname: Option.Option<string>;
  readonly display_name: Option.Option<string>;
  readonly username: Option.Option<string>;
}) =>
  pipe(
    pickName(entry),
    Option.getOrElse(() => 'Unknown'),
  );

export const formatNamePlain = (entry: {
  readonly name: Option.Option<string>;
  readonly nickname: Option.Option<string>;
  readonly display_name: Option.Option<string>;
  readonly username: Option.Option<string>;
}): string =>
  DisplayName.pickDisplayName({
    name: entry.name,
    nickname: entry.nickname,
    displayName: entry.display_name,
    username: entry.username,
  }).pipe(Option.getOrElse(() => 'Unknown'));

export const formatNameWithMention = (entry: {
  readonly discord_id: Option.Option<string>;
  readonly name: Option.Option<string>;
  readonly nickname: Option.Option<string>;
  readonly display_name: Option.Option<string>;
  readonly username: Option.Option<string>;
}): string => {
  const name = pickName(entry);
  const mention = Option.map(entry.discord_id, (id) => `<@${id}>`);
  return Option.match(name, {
    onNone: () => Option.getOrElse(mention, () => 'Unknown'),
    onSome: (n) =>
      Option.match(mention, {
        onNone: () => n,
        onSome: (m) => `${n} (${m})`,
      }),
  });
};

/** Discord embed field values are capped at 1024 characters. */
export const EMBED_FIELD_VALUE_LIMIT = 1024;

/** Fetch cap for an event's RSVP-attendee list. */
export const YES_EMBED_LIMIT = 20;

/**
 * Joins entry strings with `, `, truncating with a localised "…and N more" suffix if the
 * joined result would exceed `limit` characters. Keeps the output safe for Discord embed
 * field values (max 1024 chars), which would otherwise cause `createMessage` to fail for
 * large teams.
 */
export const joinEntriesWithLimit = (
  entries: ReadonlyArray<string>,
  andMore: (count: number) => string,
  limit: number = EMBED_FIELD_VALUE_LIMIT,
): string => {
  const separator = ', ';
  const full = entries.join(separator);
  if (full.length <= limit) return full;

  let taken: Array<string> = [];
  let current = '';
  for (let i = 0; i < entries.length; i++) {
    const remaining = entries.length - i;
    const candidate = taken.length === 0 ? entries[i] : `${current}${separator}${entries[i]}`;
    const suffix = `${separator}${andMore(remaining)}`;
    if (candidate.length + suffix.length > limit) break;
    taken = [...taken, entries[i]];
    current = candidate;
  }

  const rest = entries.length - taken.length;
  if (taken.length === 0) return andMore(entries.length);
  return `${current}${separator}${andMore(rest)}`;
};
