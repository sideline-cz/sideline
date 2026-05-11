import { Array as Arr, Option } from 'effect';

export interface OnboardingTeamView {
  readonly team_id: string;
  readonly guild_id: string;
  readonly team_name: string;
  readonly onboarding_locale: 'en' | 'cs';
  readonly rules_channel_id: Option.Option<string>;
  readonly welcome_channel_id: Option.Option<string>;
  readonly training_channel_id: Option.Option<string>;
  readonly onboarding_rules_role_id: Option.Option<string>;
  readonly onboarding_rules_prompt_id: Option.Option<string>;
  readonly is_community_enabled: boolean;
}

export interface WelcomeScreenStrings {
  readonly description: string;
  readonly channels_rules: string;
  readonly channels_welcome: string;
  readonly channels_training: string;
}

export interface RulesPromptStrings {
  readonly title: string;
  readonly optionTitle: string;
  readonly optionDescription: string;
}

export interface WelcomeChannelEntry {
  readonly channel_id: string;
  readonly description: string;
  readonly emoji_name: string;
}

export interface WelcomeScreenPatchRequestPartial {
  readonly enabled: true;
  readonly description: string;
  readonly welcome_channels: ReadonlyArray<WelcomeChannelEntry>;
}

export interface OnboardingPromptOption {
  readonly id?: string;
  readonly title: string;
  readonly description: string;
  readonly emoji_name: string;
  readonly role_ids: ReadonlyArray<string>;
  readonly channel_ids: ReadonlyArray<string>;
}

export interface OnboardingPrompt {
  readonly id?: string;
  readonly title: string;
  readonly type: 0;
  readonly single_select: boolean;
  readonly required: boolean;
  readonly in_onboarding: boolean;
  readonly options: ReadonlyArray<OnboardingPromptOption>;
}

export interface UpdateGuildOnboardingRequest {
  readonly enabled: true;
  readonly mode: 1;
  readonly prompts: ReadonlyArray<OnboardingPrompt>;
  readonly default_channel_ids: ReadonlyArray<string>;
}

export interface MergeResult {
  readonly merged: UpdateGuildOnboardingRequest;
  readonly usedExistingId: boolean;
}

const MAX_DESC_LEN = 140;
const MAX_CHANNEL_DESC_LEN = 50;

const truncate = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

export const buildWelcomeScreenPayload = (
  team: OnboardingTeamView,
  strings: WelcomeScreenStrings,
): Option.Option<WelcomeScreenPatchRequestPartial> => {
  // Welcome Screen channels are shown to users before they join, so each must be
  // viewable by @everyone. The rules channel is private by design (the rules prompt
  // is the gate that grants access), so it must never appear here.
  const channels: WelcomeChannelEntry[] = [];

  if (Option.isSome(team.welcome_channel_id)) {
    channels.push({
      channel_id: team.welcome_channel_id.value,
      description: truncate(strings.channels_welcome, MAX_CHANNEL_DESC_LEN),
      emoji_name: '👋',
    });
  }

  if (Option.isSome(team.training_channel_id)) {
    channels.push({
      channel_id: team.training_channel_id.value,
      description: truncate(strings.channels_training, MAX_CHANNEL_DESC_LEN),
      emoji_name: '🏃',
    });
  }

  if (channels.length === 0) {
    return Option.none();
  }

  const rawDesc = strings.description;
  const description = rawDesc.length > MAX_DESC_LEN ? rawDesc.slice(0, MAX_DESC_LEN) : rawDesc;

  return Option.some({
    enabled: true,
    description,
    welcome_channels: channels,
  });
};

// Accepts any prompt shape that can identify itself by id and expose role_ids per option.
// Discord's GET response (OnboardingPromptResponse) and our PUT request (OnboardingPrompt)
// both satisfy this, so callers can pass the response straight through without casts.
export const mergeOnboardingPayload = <
  P extends {
    readonly id?: string;
    readonly options: ReadonlyArray<{ readonly role_ids?: ReadonlyArray<string> }>;
  },
>(
  current: {
    readonly prompts: ReadonlyArray<P>;
    readonly default_channel_ids?: ReadonlyArray<string>;
  },
  team: OnboardingTeamView,
  rulesPromptStrings: RulesPromptStrings,
): MergeResult => {
  const storedPromptId = Option.getOrUndefined(team.onboarding_rules_prompt_id);
  const roleId = Option.getOrUndefined(team.onboarding_rules_role_id);
  const channelId = Option.getOrUndefined(team.rules_channel_id);

  const existingPrompt =
    storedPromptId !== undefined ? current.prompts.find((p) => p.id === storedPromptId) : undefined;
  const usedExistingId = existingPrompt !== undefined;

  const otherPrompts: ReadonlyArray<P> = (() => {
    const filtered =
      storedPromptId !== undefined
        ? Arr.filter(current.prompts, (p) => p.id !== storedPromptId)
        : [...current.prompts];
    if (!usedExistingId && storedPromptId !== undefined && roleId !== undefined) {
      return Arr.filter(
        filtered,
        (p) => !p.options.some((opt) => (opt.role_ids ?? []).includes(roleId)),
      );
    }
    return filtered;
  })();

  // Discord PUT requires `id` on every prompt and expects a snowflake-shaped numeric
  // string. For new prompts (no stored id, or stored id doesn't match anything in
  // current.prompts), supply a placeholder of digits only; Discord replaces it with the
  // real snowflake in the response, which we read via findNewPromptId.
  const promptId =
    usedExistingId && storedPromptId !== undefined ? storedPromptId : Date.now().toString();

  const sidelinePrompt: OnboardingPrompt | undefined =
    roleId !== undefined && channelId !== undefined
      ? {
          id: promptId,
          title: rulesPromptStrings.title,
          type: 0,
          single_select: true,
          required: true,
          in_onboarding: true,
          options: [
            {
              title: rulesPromptStrings.optionTitle,
              description: rulesPromptStrings.optionDescription,
              emoji_name: '✅',
              role_ids: [roleId],
              channel_ids: [channelId],
            },
          ],
        }
      : undefined;

  // Discord caps onboarding at 5 prompts. If preserving every captain-authored prompt
  // plus ours would exceed the cap, keep ours (it's the load-bearing one) and trim the
  // oldest captain prompts to make room.
  const MAX_PROMPTS = 5;
  const truncatedOtherPrompts: ReadonlyArray<P> = sidelinePrompt
    ? otherPrompts.slice(0, MAX_PROMPTS - 1)
    : otherPrompts.slice(0, MAX_PROMPTS);
  const prompts: ReadonlyArray<OnboardingPrompt | P> = sidelinePrompt
    ? [...truncatedOtherPrompts, sidelinePrompt]
    : truncatedOtherPrompts;

  // Discord requires every channel in default_channel_ids to be viewable by @everyone.
  // The rules channel is private by design (the rules prompt is the gate that grants
  // access), so it must NEVER appear here. Welcome/training are surfaced via the Welcome
  // Screen, not default channels. We trust the guild owner's existing default-channel
  // list and only strip the rules channel if a prior sync mistakenly added it.
  const rulesChannelId = Option.getOrUndefined(team.rules_channel_id);
  const existingChannelIds = current.default_channel_ids ?? [];
  const defaultChannelIds: ReadonlyArray<string> =
    rulesChannelId !== undefined
      ? Arr.filter(existingChannelIds, (id) => id !== rulesChannelId)
      : existingChannelIds;

  return {
    merged: {
      enabled: true,
      mode: 1,
      prompts: prompts as ReadonlyArray<OnboardingPrompt>,
      default_channel_ids: defaultChannelIds,
    },
    usedExistingId,
  };
};
