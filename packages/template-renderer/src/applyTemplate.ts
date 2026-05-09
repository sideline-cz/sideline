export type TemplateVars = {
  readonly memberMention: string;
  readonly memberName: string;
  readonly inviterMention: string;
  readonly inviterName: string;
  readonly groupName: string;
  readonly teamName: string;
};

const TEMPLATE_KEYS = [
  'memberMention',
  'memberName',
  'inviterMention',
  'inviterName',
  'groupName',
  'teamName',
] as const;
type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/**
 * Replaces known {placeholders} from `vars`. Unknown placeholders are left intact.
 * Pure, no I/O.
 */
export const applyTemplate = (template: string, vars: TemplateVars): string =>
  template.replace(/\{(\w+)\}/g, (full, key: string) =>
    (TEMPLATE_KEYS as readonly string[]).includes(key) ? vars[key as TemplateKey] : full,
  );
