import type { GroupApi } from '@sideline/domain';
import { Discord, GroupModel } from '@sideline/domain';
import { Option, Schema } from 'effect';
import { DISCORD_CHANNEL_TYPE_CATEGORY, DISCORD_CHANNEL_TYPE_TEXT } from '~/lib/discord';

/** Sentinel a `SearchableSelect` uses for "nothing selected". */
export const NONE_VALUE = '__none__';

export const DEFAULT_ROLE_FORMAT = '{emoji} {name}';
export const DEFAULT_CHANNEL_FORMAT = '{emoji}│{name}';
export const DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT = 'events-{discord_id}';

/** Mirrors `DiscordFormatString` in `TeamSettingsApi`. */
export const isFormatValid = (format: string) => format.includes('{name}');

export const renderFormatPreview = (format: string, isChannel: boolean) => {
  const emoji = '\u{1F3C0}';
  const name = isChannel ? 'seniors' : 'Seniors';
  return format.replaceAll('{emoji}', emoji).replaceAll('{name}', name).trim();
};

/**
 * The form/payload boundary. Form state is plain strings so the selects can be
 * controlled; the API wants `Option`s of branded ids.
 */
export const channelToOption = (value: string): Option.Option<Discord.Snowflake> =>
  value !== NONE_VALUE ? Option.some(Discord.Snowflake.makeUnsafe(value)) : Option.none();

export const groupIdToOption = (value: string): Option.Option<GroupModel.GroupId> =>
  value !== NONE_VALUE ? Option.some(Schema.decodeSync(GroupModel.GroupId)(value)) : Option.none();

/** The other direction: an optional id from the API as a select value. */
export const selectValue = (id: Option.Option<string>): string =>
  Option.getOrElse(id, () => NONE_VALUE);

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export const textChannelOptions = (
  channels: ReadonlyArray<GroupApi.DiscordChannelInfo>,
  noneLabel: string,
): ReadonlyArray<SelectOption> => [
  { value: NONE_VALUE, label: noneLabel },
  ...channels
    .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
    .map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
];

export const categoryChannelOptions = (
  channels: ReadonlyArray<GroupApi.DiscordChannelInfo>,
  noneLabel: string,
): ReadonlyArray<SelectOption> => [
  { value: NONE_VALUE, label: noneLabel },
  ...channels
    .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_CATEGORY)
    .map((ch) => ({ value: ch.id, label: ch.name })),
];
