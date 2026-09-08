import { Discord, GroupApi } from '@sideline/domain';
import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  DISCORD_CHANNEL_TYPE_CATEGORY,
  DISCORD_CHANNEL_TYPE_TEXT,
  DISCORD_CHANNEL_TYPE_VOICE,
} from '~/lib/discord';
import {
  categoryChannelOptions,
  channelToOption,
  isFormatValid,
  NONE_VALUE,
  renderFormatPreview,
  selectValue,
  textChannelOptions,
} from './shared';

// A `SearchableSelect` is a string-valued control, so an absent id has to be
// spelled as a sentinel on the way in and turned back into `None` on the way
// out. Getting one direction wrong sends the literal '__none__' to Discord.
describe('the NONE_VALUE round trip', () => {
  it('reads an absent id as the sentinel', () => {
    expect(selectValue(Option.none())).toBe(NONE_VALUE);
  });

  it('reads a present id as itself', () => {
    expect(selectValue(Option.some('123'))).toBe('123');
  });

  it('sends the sentinel as a cleared field, not an empty id', () => {
    expect(channelToOption(NONE_VALUE)).toStrictEqual(Option.none());
  });

  it('sends a picked channel as its id', () => {
    expect(channelToOption('123')).toStrictEqual(Option.some('123'));
  });
});

describe('isFormatValid', () => {
  it('requires the name placeholder, mirroring DiscordFormatString', () => {
    expect(isFormatValid('{emoji} {name}')).toBe(true);
    expect(isFormatValid('{emoji}')).toBe(false);
  });
});

describe('renderFormatPreview', () => {
  it('lower-cases the sample name for channels only', () => {
    expect(renderFormatPreview('{name}', true)).toBe('seniors');
    expect(renderFormatPreview('{name}', false)).toBe('Seniors');
  });

  it('drops the padding a removed emoji leaves behind', () => {
    expect(renderFormatPreview(' {name}', false)).toBe('Seniors');
  });
});

const channel = (id: string, name: string, type: number) =>
  new GroupApi.DiscordChannelInfo({
    id: Discord.Snowflake.makeUnsafe(id),
    name,
    type,
    parentId: Option.none(),
  });

const CHANNELS = [
  channel('1', 'general', DISCORD_CHANNEL_TYPE_TEXT),
  channel('2', 'Team', DISCORD_CHANNEL_TYPE_CATEGORY),
  channel('3', 'random', DISCORD_CHANNEL_TYPE_TEXT),
  channel('4', 'voice', DISCORD_CHANNEL_TYPE_VOICE),
];

describe('channel option builders', () => {
  it('offers text channels with a leading hash', () => {
    expect(textChannelOptions(CHANNELS, 'None')).toEqual([
      { value: NONE_VALUE, label: 'None' },
      { value: '1', label: '# general' },
      { value: '3', label: '# random' },
    ]);
  });

  it('offers categories plainly, and excludes voice channels from both', () => {
    expect(categoryChannelOptions(CHANNELS, 'None')).toEqual([
      { value: NONE_VALUE, label: 'None' },
      { value: '2', label: 'Team' },
    ]);
  });
});
