// `updateTeamInfo` is one PATCH shared by three cards. Each owns a disjoint
// slice and must leave the other two alone — the welcome card once posted a
// payload without the rules-quiz fields it had just enabled the button for,
// which "succeeded", toasted "saved", and discarded the edit.
//
// The rules-quiz fields have since moved to their real owner
// (`updateTeamSettings`, see settingsForm.test.ts); what these tests pin is
// the property that let the mix-up go unnoticed — that a builder must not
// silently write a field belonging to another card, and that between them the
// three cards account for the whole DTO.

import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { NONE_VALUE } from './shared';
import {
  onboardingRequestFrom,
  profileRequestFrom,
  untouchedTeamInfo,
  welcomeRequestFrom,
} from './teamInfoForm';

const ALL_KEYS = Object.keys(untouchedTeamInfo) as ReadonlyArray<keyof typeof untouchedTeamInfo>;

/** The keys a request actually asks the server to write. */
const touched = (request: typeof untouchedTeamInfo): ReadonlyArray<string> =>
  ALL_KEYS.filter((key) => {
    // The DTO's fields are `Option`s of several different shapes; only
    // presence matters here.
    const value: Option.Option<unknown> = request[key];
    return Option.isSome(value);
  });

const sorted = (keys: ReadonlyArray<string>): ReadonlyArray<string> => [...keys].sort();

const PROFILE = profileRequestFrom({
  teamName: 'Sharks',
  description: '',
  sport: '',
  logoUrl: '',
});

const WELCOME = welcomeRequestFrom({
  welcomeChannel: NONE_VALUE,
  systemLogChannel: NONE_VALUE,
  achievementChannel: NONE_VALUE,
  welcomeTemplate: '',
});

const ONBOARDING = onboardingRequestFrom({
  rulesChannel: NONE_VALUE,
  rulesRole: NONE_VALUE,
  locale: 'cs',
});

describe('untouchedTeamInfo', () => {
  it('touches nothing', () => {
    expect(touched(untouchedTeamInfo)).toEqual([]);
  });
});

describe('each card writes only the fields it owns', () => {
  it('team profile', () => {
    expect(sorted(touched(PROFILE))).toEqual(['description', 'logoUrl', 'name', 'sport']);
  });

  it('welcome message', () => {
    expect(sorted(touched(WELCOME))).toEqual([
      'achievementChannelId',
      'systemLogChannelId',
      'welcomeChannelId',
      'welcomeMessageTemplate',
    ]);
  });

  it('onboarding', () => {
    expect(sorted(touched(ONBOARDING))).toEqual([
      'onboardingLocale',
      'onboardingRulesRoleId',
      'rulesChannelId',
    ]);
  });

  it('between them they cover the whole DTO exactly once', () => {
    const all = [...touched(PROFILE), ...touched(WELCOME), ...touched(ONBOARDING)];
    expect(new Set(all).size, 'two cards write the same field').toBe(all.length);
    expect(sorted(all)).toEqual(sorted(ALL_KEYS));
  });
});

describe('profileRequestFrom', () => {
  it('clears an emptied optional field rather than omitting it', () => {
    const request = profileRequestFrom({
      teamName: '  Sharks  ',
      description: '   ',
      sport: 'ultimate',
      logoUrl: '',
    });
    expect(request.name).toStrictEqual(Option.some('Sharks'));
    expect(request.description).toStrictEqual(Option.some(Option.none()));
    expect(request.sport).toStrictEqual(Option.some(Option.some('ultimate')));
    expect(request.logoUrl).toStrictEqual(Option.some(Option.none()));
  });
});
