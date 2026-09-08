import { tr } from '~/lib/translations.js';

// Walk a Discord error tree looking for the deepest human-readable message.
// Discord wraps validation errors as { errors: { <field>: { _errors: [{ code, message }] } } }
// and we want the innermost `message`, not the top-level "Invalid Form Body".
export function extractDiscordMessage(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj._errors)) {
    for (const entry of obj._errors) {
      if (entry && typeof entry === 'object') {
        const msg = (entry as { message?: unknown }).message;
        if (typeof msg === 'string' && msg.length > 0) return msg;
      }
    }
  }
  for (const value of Object.values(obj)) {
    const found = extractDiscordMessage(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function extractGenericDetail(detail: string): string {
  // detail looks like: "Discord error 0: {"message":"Invalid Form Body",...}"
  const jsonStart = detail.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(detail.slice(jsonStart)) as Record<string, unknown>;
      const inner = extractDiscordMessage(body.errors);
      if (inner !== undefined) return inner;
      const topMessage = (body as { message?: unknown }).message;
      if (typeof topMessage === 'string' && topMessage.length > 0) return topMessage;
    } catch {
      /* fall through */
    }
  }
  return detail.split('\n').find((l) => l.trim()) ?? detail;
}

export function getOnboardingErrorMessage(syncError: string | null): string {
  if (!syncError) return '';
  try {
    const parsed = JSON.parse(syncError) as { code?: string; detail?: string };
    if (parsed.code === 'role_deleted') return tr('teamSettings_onboardingErrorRoleDeleted');
    if (parsed.code === 'channel_deleted') return tr('teamSettings_onboardingErrorChannelDeleted');
    if (parsed.code === 'community_not_enabled' || parsed.code === 'community_disabled')
      return tr('teamSettings_onboardingErrorCommunityDisabled');
    if (parsed.code === 'requirements_not_met')
      return tr('teamSettings_onboardingErrorRequirementsNotMet');
    if (parsed.code === 'default_channel_private')
      return tr('teamSettings_onboardingErrorDefaultChannelPrivate');
    if (parsed.code === 'too_many_prompts') return tr('teamSettings_onboardingErrorTooManyPrompts');
    return tr('teamSettings_onboardingErrorGeneric', {
      message: extractGenericDetail(parsed.detail ?? syncError),
    });
  } catch {
    return tr('teamSettings_onboardingErrorGeneric', { message: extractGenericDetail(syncError) });
  }
}
