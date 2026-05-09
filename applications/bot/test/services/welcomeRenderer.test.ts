import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildSystemLogEmbed, buildWelcomeEmbed } from '~/services/welcomeRenderer.js';

describe('buildWelcomeEmbed', () => {
  it('returns APIEmbed with color, description, and author.name = memberDisplayName', () => {
    const embed = buildWelcomeEmbed({
      rendered: 'Welcome to the team!',
      groupName: Option.some('Strikers'),
      colorInt: 0x5865f2,
      memberDisplayName: 'Alice',
    });
    expect(embed.description).toBe('Welcome to the team!');
    expect(embed.color).toBe(0x5865f2);
    expect(embed.author).toBeDefined();
    expect(embed.author?.name).toBe('Alice');
  });

  it('uses memberDisplayName in author.name (not a mention)', () => {
    const embed = buildWelcomeEmbed({
      rendered: 'Hi!',
      groupName: Option.none(),
      colorInt: 0xff0000,
      memberDisplayName: 'Bob The Player',
    });
    expect(embed.author?.name).toBe('Bob The Player');
    // Should NOT contain a raw Discord mention in author.name
    expect(embed.author?.name).not.toMatch(/^<@/);
  });

  it('honors explicit colorInt', () => {
    const embed = buildWelcomeEmbed({
      rendered: 'Hi!',
      groupName: Option.none(),
      colorInt: 0xff0000,
      memberDisplayName: 'Alice',
    });
    expect(embed.color).toBe(0xff0000);
  });
});

describe('buildSystemLogEmbed', () => {
  it('includes member username, invite code field, and group name field', () => {
    const embed = buildSystemLogEmbed({
      username: 'alice',
      memberId: '111',
      inviteCode: Option.some('CODE123'),
      inviterId: Option.some('222'),
      groupName: Option.some('Strikers'),
    });
    expect(embed.fields).toBeDefined();
    const fields = embed.fields ?? [];
    const inviteField = fields.find(
      (f: { name: string; value: string }) =>
        f.value === 'CODE123' || f.name.toLowerCase().includes('invite'),
    );
    const groupField = fields.find(
      (f: { name: string; value: string }) =>
        f.value === 'Strikers' || f.name.toLowerCase().includes('group'),
    );
    expect(inviteField).toBeDefined();
    expect(groupField).toBeDefined();
  });

  it('with inviterId: None → does not include an inviter field', () => {
    const embed = buildSystemLogEmbed({
      username: 'alice',
      memberId: '111',
      inviteCode: Option.some('CODE123'),
      inviterId: Option.none(),
      groupName: Option.some('Strikers'),
    });
    const fields = embed.fields ?? [];
    const inviterUserField = fields.find(
      (f: { name: string; value: string }) =>
        f.name.toLowerCase().includes('inviter') || f.name.toLowerCase().includes('invited by'),
    );
    expect(inviterUserField).toBeUndefined();
  });

  it('with groupName: None → shows "—" or omits group field', () => {
    const embed = buildSystemLogEmbed({
      username: 'alice',
      memberId: '111',
      inviteCode: Option.some('CODE123'),
      inviterId: Option.none(),
      groupName: Option.none(),
    });
    const fields = embed.fields ?? [];
    const groupField = fields.find((f: { name: string; value: string }) =>
      f.name.toLowerCase().includes('group'),
    );
    if (groupField) {
      expect(groupField.value).toMatch(/^[—-]$/);
    }
  });

  it('with inviteCode: None → renders "—" in invite code field', () => {
    const embed = buildSystemLogEmbed({
      username: 'alice',
      memberId: '111',
      inviteCode: Option.none(),
      inviterId: Option.none(),
      groupName: Option.none(),
    });
    const fields = embed.fields ?? [];
    const inviteField = fields.find((f: { name: string; value: string }) =>
      f.name.toLowerCase().includes('invite'),
    );
    expect(inviteField).toBeDefined();
    expect(inviteField?.value).toBe('—');
  });
});
