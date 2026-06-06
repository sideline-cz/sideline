import { EventRpcModels } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildEventListEmbed } from '~/rest/events/buildEventListEmbed.js';

const locale = 'en' as const;

const makeEntry = (
  overrides: Partial<EventRpcModels.GuildEventListEntry> = {},
): EventRpcModels.GuildEventListEntry =>
  new EventRpcModels.GuildEventListEntry({
    event_id: 'event-1',
    title: 'Weekly Training',
    start_at: DateTime.makeUnsafe('2023-11-14T22:13:20.000Z'),
    end_at: Option.none(),
    location: Option.none(),
    location_url: Option.none(),
    event_type: 'training',
    yes_count: 3,
    no_count: 1,
    maybe_count: 2,
    all_day: false,
    ...overrides,
  });

describe('buildEventListEmbed — location in entry', () => {
  it('renders plain location text when location_url is None', () => {
    const entry = makeEntry({ location: Option.some('Main Field'), location_url: Option.none() });
    const { embeds } = buildEventListEmbed({
      events: [entry],
      total: 1,
      offset: 0,
      guildId: 'guild-1',
      locale,
    });
    const description = embeds[0].description ?? '';
    expect(description).toContain('Main Field');
    // Should NOT be wrapped in markdown link brackets
    expect(description).not.toContain('[Main Field](');
  });

  it('renders a markdown link when location and location_url are both Some', () => {
    const entry = makeEntry({
      location: Option.some('Main Field'),
      location_url: Option.some('https://maps.google.com/x'),
    });
    const { embeds } = buildEventListEmbed({
      events: [entry],
      total: 1,
      offset: 0,
      guildId: 'guild-1',
      locale,
    });
    const description = embeds[0].description ?? '';
    expect(description).toContain('[Main Field](<https://maps.google.com/x>)');
  });

  it('omits location line entirely when location is None even if location_url is Some', () => {
    const entry = makeEntry({
      location: Option.none(),
      location_url: Option.some('https://x'),
    });
    const { embeds } = buildEventListEmbed({
      events: [entry],
      total: 1,
      offset: 0,
      guildId: 'guild-1',
      locale,
    });
    const description = embeds[0].description ?? '';
    // Location pin emoji should not appear
    expect(description).not.toContain('\u{1F4CD}');
  });
});
