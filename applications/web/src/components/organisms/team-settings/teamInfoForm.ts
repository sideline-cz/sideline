import type { Onboarding, TeamApi } from '@sideline/domain';
import { Option } from 'effect';
import { channelToOption, selectValue } from './shared';

/**
 * `updateTeamInfo` is a PATCH shared by three cards that each own a disjoint
 * slice of it, so every handler has to say "don't touch" about the other two
 * cards' fields. Spelling that list out by hand three times is how the welcome
 * card ended up posting a payload that the edit it had just enabled was not
 * in. Spread this instead: a field added to the DTO defaults to untouched
 * everywhere, and each builder names only what its own card owns.
 */
export const untouchedTeamInfo: TeamApi.UpdateTeamRequest = {
  name: Option.none(),
  description: Option.none(),
  sport: Option.none(),
  logoUrl: Option.none(),
  welcomeChannelId: Option.none(),
  systemLogChannelId: Option.none(),
  achievementChannelId: Option.none(),
  welcomeMessageTemplate: Option.none(),
  rulesChannelId: Option.none(),
  onboardingRulesRoleId: Option.none(),
  onboardingLocale: Option.none(),
};

/** `''` means "clear it" for the nullable text fields. */
const optionalText = (value: string): Option.Option<Option.Option<string>> =>
  Option.some(value.trim() ? Option.some(value.trim()) : Option.none());

// ---------------------------------------------------------------------------
// Team profile card
// ---------------------------------------------------------------------------

export type ProfileFormValues = {
  teamName: string;
  description: string;
  sport: string;
  logoUrl: string;
};

export const profileFormFrom = (info: TeamApi.TeamInfo): ProfileFormValues => ({
  teamName: info.name,
  description: Option.getOrElse(info.description, () => ''),
  sport: Option.getOrElse(info.sport, () => ''),
  logoUrl: Option.getOrElse(info.logoUrl, () => ''),
});

/**
 * An empty name used to be a bare `return` in the save handler — Save just did
 * nothing. Naming the field lets the card say so.
 */
export const findInvalidProfileField = (values: ProfileFormValues): string | undefined =>
  values.teamName.trim().length === 0 ? 'teamSettings_teamName' : undefined;

export const profileRequestFrom = (values: ProfileFormValues): TeamApi.UpdateTeamRequest => ({
  ...untouchedTeamInfo,
  name: Option.some(values.teamName.trim()),
  description: optionalText(values.description),
  sport: optionalText(values.sport),
  logoUrl: optionalText(values.logoUrl),
});

// ---------------------------------------------------------------------------
// Welcome message card
// ---------------------------------------------------------------------------

export type WelcomeFormValues = {
  welcomeChannel: string;
  systemLogChannel: string;
  achievementChannel: string;
  welcomeTemplate: string;
};

export const welcomeFormFrom = (info: TeamApi.TeamInfo): WelcomeFormValues => ({
  welcomeChannel: selectValue(info.welcomeChannelId),
  systemLogChannel: selectValue(info.systemLogChannelId),
  achievementChannel: selectValue(info.achievementChannelId),
  welcomeTemplate: Option.getOrElse(info.welcomeMessageTemplate, () => ''),
});

export const welcomeRequestFrom = (values: WelcomeFormValues): TeamApi.UpdateTeamRequest => ({
  ...untouchedTeamInfo,
  welcomeChannelId: Option.some(channelToOption(values.welcomeChannel)),
  systemLogChannelId: Option.some(channelToOption(values.systemLogChannel)),
  achievementChannelId: Option.some(channelToOption(values.achievementChannel)),
  welcomeMessageTemplate: optionalText(values.welcomeTemplate),
});

// ---------------------------------------------------------------------------
// Onboarding card
// ---------------------------------------------------------------------------

export type OnboardingFormValues = {
  rulesChannel: string;
  rulesRole: string;
  locale: Onboarding.OnboardingLocale;
};

export const onboardingFormFrom = (info: TeamApi.TeamInfo): OnboardingFormValues => ({
  rulesChannel: selectValue(info.rulesChannelId),
  rulesRole: selectValue(info.onboardingRulesRoleId),
  locale: info.onboardingLocale,
});

export const onboardingRequestFrom = (values: OnboardingFormValues): TeamApi.UpdateTeamRequest => ({
  ...untouchedTeamInfo,
  rulesChannelId: Option.some(channelToOption(values.rulesChannel)),
  onboardingRulesRoleId: Option.some(channelToOption(values.rulesRole)),
  onboardingLocale: Option.some(values.locale),
});
