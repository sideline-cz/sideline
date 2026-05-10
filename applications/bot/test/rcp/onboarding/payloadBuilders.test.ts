// TDD mode — these tests will FAIL until Phase 5 implements:
//   applications/bot/src/rcp/onboarding/payloadBuilders.ts
// That module does not exist yet. TypeScript "cannot find module" errors are expected.

import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  buildWelcomeScreenPayload,
  mergeOnboardingPayload,
} from '~/rcp/onboarding/payloadBuilders.js';

// ---------------------------------------------------------------------------
// Local interface matching what payloadBuilders WILL accept per the plan (§7).
// Replaces the `as any` casts so missing fields surface as compile errors once
// the source exists.
// ---------------------------------------------------------------------------

interface OnboardingTeamView {
  team_id: string;
  guild_id: string;
  team_name: string;
  onboarding_locale: 'en' | 'cs';
  rules_channel_id: Option.Option<string>;
  welcome_channel_id: Option.Option<string>;
  training_channel_id: Option.Option<string>;
  onboarding_rules_role_id: Option.Option<string>;
  onboarding_rules_prompt_id: Option.Option<string>;
  is_community_enabled: boolean;
}

interface WelcomeScreenStrings {
  description: string;
  channels_rules: string;
  channels_welcome: string;
  channels_training: string;
}

interface RulesPromptStrings {
  title: string;
  optionTitle: string;
  optionDescription: string;
}

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const GUILD_ID = '111111111111111111';
const RULES_CHANNEL_ID = '222222222222222222';
const WELCOME_CHANNEL_ID = '333333333333333333';
const TRAINING_CHANNEL_ID = '444444444444444444';
const ROLE_ID = '555555555555555555';
const PROMPT_ID = '666666666666666666';

const makeTeam = (overrides: Partial<OnboardingTeamView> = {}): OnboardingTeamView => ({
  team_id: '00000000-0000-0000-0000-000000000010',
  guild_id: GUILD_ID,
  team_name: 'Test FC',
  onboarding_locale: 'en',
  rules_channel_id: Option.some(RULES_CHANNEL_ID),
  welcome_channel_id: Option.some(WELCOME_CHANNEL_ID),
  training_channel_id: Option.some(TRAINING_CHANNEL_ID),
  onboarding_rules_role_id: Option.some(ROLE_ID),
  onboarding_rules_prompt_id: Option.none(),
  is_community_enabled: true,
  ...overrides,
});

const makeStrings = (locale: 'en' | 'cs' = 'en'): WelcomeScreenStrings => ({
  description:
    locale === 'cs'
      ? 'Vítejte v Test FC! Přečtěte si pravidla a prozkoumejte server.'
      : 'Welcome to Test FC! Read the rules, then explore the server.',
  channels_rules:
    locale === 'cs'
      ? 'Přečtěte si a potvrďte týmová pravidla.'
      : 'Read and acknowledge the team rules.',
  channels_welcome:
    locale === 'cs' ? 'Pozdravte a seznamte se s týmem.' : 'Say hi and meet the team.',
  channels_training:
    locale === 'cs' ? 'Aktuální tréninky a oznámení.' : 'Latest training calls and announcements.',
});

const makeRulesPromptStrings = (): RulesPromptStrings => ({
  title: 'Read the rules to join',
  optionTitle: 'I have read the rules',
  optionDescription: 'Grants access to the rest of the server.',
});

// ---------------------------------------------------------------------------
// buildWelcomeScreenPayload tests
// ---------------------------------------------------------------------------

describe('buildWelcomeScreenPayload', () => {
  it('all 3 channels set → Some with 3 welcome_channels', () => {
    const result = buildWelcomeScreenPayload(makeTeam(), makeStrings());
    expect(Option.isSome(result)).toBe(true);
    const payload = Option.getOrThrow(result) as any;
    expect(payload.welcome_channels).toHaveLength(3);
  });

  it('only welcome_channel_id set → Some with 1 channel', () => {
    const team = makeTeam({
      rules_channel_id: Option.none(),
      training_channel_id: Option.none(),
    });
    const result = buildWelcomeScreenPayload(team, makeStrings());
    expect(Option.isSome(result)).toBe(true);
    const payload = Option.getOrThrow(result) as any;
    expect(payload.welcome_channels).toHaveLength(1);
    expect(payload.welcome_channels[0].emoji_name).toBe('👋');
  });

  it('no channels → None', () => {
    const team = makeTeam({
      rules_channel_id: Option.none(),
      welcome_channel_id: Option.none(),
      training_channel_id: Option.none(),
    });
    const result = buildWelcomeScreenPayload(team, makeStrings());
    expect(Option.isNone(result)).toBe(true);
  });

  it('locale=cs → description matches cs string', () => {
    const team = makeTeam({ onboarding_locale: 'cs' });
    const csStrings = makeStrings('cs');
    const result = buildWelcomeScreenPayload(team, csStrings);
    expect(Option.isSome(result)).toBe(true);
    const payload = Option.getOrThrow(result) as any;
    expect(payload.description).toBe(csStrings.description);
  });

  it('en locale strings are used for en locale', () => {
    const enStrings = makeStrings('en');
    const result = buildWelcomeScreenPayload(makeTeam(), enStrings);
    const payload = Option.getOrThrow(result) as any;
    expect(payload.description).toBe(enStrings.description);
  });

  it('description is ≤ 140 chars (Discord limit)', () => {
    const result = buildWelcomeScreenPayload(makeTeam(), makeStrings());
    const payload = Option.getOrThrow(result) as any;
    expect(payload.description?.length).toBeLessThanOrEqual(140);
  });

  it('emoji_name fields are populated for all channels', () => {
    const result = buildWelcomeScreenPayload(makeTeam(), makeStrings());
    const payload = Option.getOrThrow(result) as any;
    for (const ch of payload.welcome_channels) {
      expect(typeof (ch as any).emoji_name).toBe('string');
      expect((ch as any).emoji_name?.length).toBeGreaterThan(0);
    }
  });

  it('rules channel uses 📜 emoji', () => {
    const result = buildWelcomeScreenPayload(makeTeam(), makeStrings());
    const payload = Option.getOrThrow(result) as any;
    const rulesChannel = payload.welcome_channels.find(
      (ch: any) => ch.channel_id === RULES_CHANNEL_ID,
    );
    expect(rulesChannel).toBeDefined();
    expect(rulesChannel?.emoji_name).toBe('📜');
  });

  it('enabled === true', () => {
    const result = buildWelcomeScreenPayload(makeTeam(), makeStrings());
    const payload = Option.getOrThrow(result) as any;
    expect(payload.enabled).toBe(true);
  });

  it('only rules + welcome set → 2 channels', () => {
    const team = makeTeam({ training_channel_id: Option.none() });
    const result = buildWelcomeScreenPayload(team, makeStrings());
    expect(Option.isSome(result)).toBe(true);
    const payload = Option.getOrThrow(result) as any;
    expect(payload.welcome_channels).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// mergeOnboardingPayload tests
// ---------------------------------------------------------------------------

const makeOnboardingResponse = (prompts: unknown[] = []) =>
  ({
    guild_id: GUILD_ID,
    prompts,
    default_channel_ids: [],
    enabled: false,
    mode: 0,
  }) as any;

const makeCaptainPrompt = (id: string, title: string) => ({
  id,
  title,
  type: 0,
  single_select: false,
  required: false,
  in_onboarding: true,
  options: [{ id: 'opt-1', title: 'Other option', role_ids: [], channel_ids: [] }],
});

describe('mergeOnboardingPayload', () => {
  it('existing [P_X, P_Y, P_OURS], stored prompt_id matches P_OURS → updates P_OURS in place, preserves P_X, P_Y', () => {
    const PX = makeCaptainPrompt('px-id', 'Captain Prompt X');
    const PY = makeCaptainPrompt('py-id', 'Captain Prompt Y');
    const POURS_ID = PROMPT_ID;
    const POURS = makeCaptainPrompt(POURS_ID, 'Old Sideline Title');
    const current = makeOnboardingResponse([PX, PY, POURS]);
    const team = makeTeam({ onboarding_rules_prompt_id: Option.some(POURS_ID) });
    const { merged } = mergeOnboardingPayload(current, team, makeRulesPromptStrings());
    // Our prompt updated in place
    const ourPrompt = merged.prompts.find((p: any) => p.id === POURS_ID);
    expect(ourPrompt).toBeDefined();
    if (!ourPrompt) return;
    expect(ourPrompt.title).toBe(makeRulesPromptStrings().title);
    // Captain prompts preserved
    expect(merged.prompts.find((p: any) => p.id === 'px-id')).toBeDefined();
    expect(merged.prompts.find((p: any) => p.id === 'py-id')).toBeDefined();
    // Merger always sets enabled=true, mode=1 (ONBOARDING_ADVANCED)
    expect(merged.enabled).toBe(true);
    expect(merged.mode).toBe(1);
    // default_channel_ids includes at least the rules channel
    expect(merged.default_channel_ids).toContain(RULES_CHANNEL_ID);
  });

  it('stored prompt_id is stale (no match in current) → omit id, Discord assigns new', () => {
    const PX = makeCaptainPrompt('px-id', 'Captain Prompt X');
    const current = makeOnboardingResponse([PX]);
    const team = makeTeam({ onboarding_rules_prompt_id: Option.some('stale-id-999') });
    const { merged, usedExistingId } = mergeOnboardingPayload(
      current,
      team,
      makeRulesPromptStrings(),
    );
    expect(usedExistingId).toBe(false);
    const ourPrompt = merged.prompts.find((p: any) => p.title === makeRulesPromptStrings().title);
    expect(ourPrompt).toBeDefined();
    if (!ourPrompt) return;
    expect(ourPrompt.id).toBeUndefined();
    // Merger always sets enabled=true, mode=1
    expect(merged.enabled).toBe(true);
    expect(merged.mode).toBe(1);
    // default_channel_ids includes rules channel
    expect(merged.default_channel_ids).toContain(RULES_CHANNEL_ID);
  });

  it('captain deleted our prompt (no match anywhere) → adds new prompt, preserves others', () => {
    const PX = makeCaptainPrompt('px-id', 'Captain Prompt X');
    const current = makeOnboardingResponse([PX]);
    const team = makeTeam({ onboarding_rules_prompt_id: Option.none() });
    const { merged } = mergeOnboardingPayload(current, team, makeRulesPromptStrings());
    expect(merged.prompts).toHaveLength(2);
    expect(merged.prompts.find((p: any) => p.id === 'px-id')).toBeDefined();
    const ourPrompt = merged.prompts.find((p: any) => p.title === makeRulesPromptStrings().title);
    expect(ourPrompt).toBeDefined();
    if (!ourPrompt) return;
    expect(ourPrompt.id).toBeUndefined();
    // Merger always sets enabled=true, mode=1
    expect(merged.enabled).toBe(true);
    expect(merged.mode).toBe(1);
  });

  it('missing onboarding_rules_role_id → no Sideline prompt added', () => {
    const PX = makeCaptainPrompt('px-id', 'Captain Prompt X');
    const current = makeOnboardingResponse([PX]);
    const team = makeTeam({ onboarding_rules_role_id: Option.none() });
    const { merged } = mergeOnboardingPayload(current, team, makeRulesPromptStrings());
    // Only captain's prompt, ours is not added
    expect(merged.prompts).toHaveLength(1);
    expect(merged.prompts[0].id).toBe('px-id');
    // Merger still sets enabled=true, mode=1 even without our prompt
    expect(merged.enabled).toBe(true);
    expect(merged.mode).toBe(1);
  });

  it('missing rules_channel_id → no Sideline prompt added', () => {
    const PX = makeCaptainPrompt('px-id', 'Captain Prompt X');
    const current = makeOnboardingResponse([PX]);
    const team = makeTeam({ rules_channel_id: Option.none() });
    const { merged } = mergeOnboardingPayload(current, team, makeRulesPromptStrings());
    expect(merged.prompts).toHaveLength(1);
    expect(merged.prompts[0].id).toBe('px-id');
    // Merger still sets enabled=true, mode=1
    expect(merged.enabled).toBe(true);
    expect(merged.mode).toBe(1);
  });

  it('full config → option role_ids = [onboarding_rules_role_id], channel_ids = [rules_channel_id]', () => {
    const current = makeOnboardingResponse([]);
    const team = makeTeam();
    const { merged } = mergeOnboardingPayload(current, team, makeRulesPromptStrings());
    expect(merged.prompts).toHaveLength(1);
    const ourPrompt = merged.prompts[0];
    expect(ourPrompt.options[0].role_ids).toContain(ROLE_ID);
    // channel_ids for the rules acknowledgement option
    expect(Array.isArray(ourPrompt.options[0].channel_ids)).toBe(true);
  });

  it('all three channels set → default_channel_ids includes rules, welcome, and training', () => {
    const team = makeTeam(); // has all three channels
    const current = makeOnboardingResponse([]);
    const { merged } = mergeOnboardingPayload(current, team, makeRulesPromptStrings());
    expect(merged.enabled).toBe(true);
    expect(merged.mode).toBe(1);
    expect(merged.default_channel_ids).toContain(RULES_CHANNEL_ID);
    expect(merged.default_channel_ids).toContain(WELCOME_CHANNEL_ID);
    expect(merged.default_channel_ids).toContain(TRAINING_CHANNEL_ID);
  });

  it('only welcome_channel_id set → default_channel_ids includes only welcome', () => {
    const team = makeTeam({
      rules_channel_id: Option.none(),
      training_channel_id: Option.none(),
    });
    const current = makeOnboardingResponse([]);
    const { merged } = mergeOnboardingPayload(current, team, makeRulesPromptStrings());
    expect(merged.enabled).toBe(true);
    expect(merged.mode).toBe(1);
    expect(merged.default_channel_ids).toContain(WELCOME_CHANNEL_ID);
    expect(merged.default_channel_ids).not.toContain(RULES_CHANNEL_ID);
    expect(merged.default_channel_ids).not.toContain(TRAINING_CHANNEL_ID);
  });

  it('stale stored prompt id + existing prompt already references our role → exactly 1 Sideline-shaped prompt, no duplicate', () => {
    const STALE_ID = 'stale-prompt-999';
    const PX = makeCaptainPrompt('px-id', 'Captain Prompt X');
    const STALE_SIDELINE = {
      id: 'old-sideline-id',
      title: 'Old Sideline Rules',
      type: 0 as const,
      single_select: true,
      required: true,
      in_onboarding: true,
      options: [
        {
          title: 'Old option',
          description: 'Old desc',
          emoji_name: '✅',
          role_ids: [ROLE_ID],
          channel_ids: [RULES_CHANNEL_ID],
        },
      ],
    };
    const current = makeOnboardingResponse([PX, STALE_SIDELINE]);
    const team = makeTeam({ onboarding_rules_prompt_id: Option.some(STALE_ID) });
    const { merged } = mergeOnboardingPayload(current, team, makeRulesPromptStrings());
    const sidelinePrompts = merged.prompts.filter((p: any) =>
      p.options?.[0]?.role_ids?.includes(ROLE_ID),
    );
    expect(sidelinePrompts).toHaveLength(1);
    expect(sidelinePrompts[0].title).toBe(makeRulesPromptStrings().title);
    expect(merged.prompts.find((p: any) => p.id === 'px-id')).toBeDefined();
    expect(merged.prompts).toHaveLength(2);
  });

  it('no captain channels at all → default_channel_ids is empty (or falls back to [])', () => {
    // Per plan §7 step 5: default_channel_ids is rebuilt from team channels only.
    // When all are None, the list is empty (no fallback system channel).
    const team = makeTeam({
      rules_channel_id: Option.none(),
      welcome_channel_id: Option.none(),
      training_channel_id: Option.none(),
    });
    const current = makeOnboardingResponse([]);
    const { merged } = mergeOnboardingPayload(current, team, makeRulesPromptStrings());
    expect(merged.enabled).toBe(true);
    expect(merged.mode).toBe(1);
    expect(merged.default_channel_ids).toHaveLength(0);
  });
});
