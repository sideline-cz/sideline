import { describe, expect, it } from 'vitest';
import type { TemplateVars } from '../src/applyTemplate.js';
import { applyTemplate } from '../src/applyTemplate.js';

const baseVars: TemplateVars = {
  memberMention: '<@111>',
  memberName: 'Alice',
  inviterMention: '<@222>',
  inviterName: 'Bob',
  groupName: 'Strikers',
  teamName: 'FC Sideline',
};

describe('applyTemplate', () => {
  it('all known placeholders present → all substituted', () => {
    const template =
      'Welcome {memberMention} ({memberName})! Invited by {inviterMention} ({inviterName}). Group: {groupName}. Team: {teamName}.';
    const result = applyTemplate(template, baseVars);
    expect(result).toBe(
      'Welcome <@111> (Alice)! Invited by <@222> (Bob). Group: Strikers. Team: FC Sideline.',
    );
  });

  it('unknown placeholder {foo} left intact', () => {
    const result = applyTemplate('Hello {memberName}, {foo}!', baseVars);
    expect(result).toBe('Hello Alice, {foo}!');
  });

  it('empty inviterMention → empty string substituted (no orphan tokens)', () => {
    const vars: TemplateVars = { ...baseVars, inviterMention: '' };
    const result = applyTemplate('Invited by {inviterMention} here', vars);
    expect(result).toBe('Invited by  here');
    expect(result).not.toContain('{inviterMention}');
  });

  it('empty groupName → empty string substituted', () => {
    const vars: TemplateVars = { ...baseVars, groupName: '' };
    const result = applyTemplate('Group: {groupName}', vars);
    expect(result).toBe('Group: ');
    expect(result).not.toContain('{groupName}');
  });

  it('repeated {memberMention} → all replaced', () => {
    const result = applyTemplate('{memberMention} and {memberMention} again', baseVars);
    expect(result).toBe('<@111> and <@111> again');
  });

  it('template with no placeholders → unchanged', () => {
    const template = 'No placeholders here!';
    expect(applyTemplate(template, baseVars)).toBe(template);
  });

  it('template containing { literal but not a placeholder → only valid placeholder replaced', () => {
    const result = applyTemplate('{a {memberName}', baseVars);
    expect(result).toBe('{a Alice');
  });

  it('very long input (10k chars with one placeholder) → returns full string', () => {
    const filler = 'x'.repeat(10_000);
    const template = `${filler}{memberName}${filler}`;
    const result = applyTemplate(template, baseVars);
    expect(result).toBe(`${filler}Alice${filler}`);
    expect(result.length).toBe(10_000 + 5 + 10_000); // 'Alice' = 5 chars
  });

  it('unicode in vars (CJK + emoji) preserved', () => {
    const vars: TemplateVars = {
      ...baseVars,
      memberName: '田中 🎉',
      teamName: '東京FC',
    };
    const result = applyTemplate('Hello {memberName} from {teamName}', vars);
    expect(result).toBe('Hello 田中 🎉 from 東京FC');
  });

  it('empty template → empty string', () => {
    expect(applyTemplate('', baseVars)).toBe('');
  });
});
