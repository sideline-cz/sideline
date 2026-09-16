import type { Team } from '@sideline/domain';
import { type Discord, FinanceRpcEvents } from '@sideline/domain';
import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  buildBankTokenExpiringComponents,
  buildBankTokenExpiringEmbed,
} from '~/rcp/finance/buildBankTokenExpiringEmbed.js';

const GUILD_ID = '111111111111111111' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const DISCORD_USER_ID = '222222222222222222' as Discord.Snowflake;

const makeEvent = (daysUntilExpiry: number) =>
  new FinanceRpcEvents.BankTokenExpiringEvent({
    id: '00000000-0000-0000-0000-000000000002',
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    user_discord_id: DISCORD_USER_ID,
    days_until_expiry: daysUntilExpiry,
  });

describe('buildBankTokenExpiringEmbed', () => {
  it('is amber at T-14', () => {
    const embed = buildBankTokenExpiringEmbed(makeEvent(14), 'cs');
    expect(embed.color).toBe(0xfee75c);
    expect(embed.title).toBe('⚠️ Token k bance vyprší za 14 dní');
  });

  it('is red at T-7 and T-1, matching the settings banner switch', () => {
    expect(buildBankTokenExpiringEmbed(makeEvent(7), 'en').color).toBe(0xed4245);
    expect(buildBankTokenExpiringEmbed(makeEvent(1), 'en').color).toBe(0xed4245);
  });
});

describe('buildBankTokenExpiringComponents', () => {
  it('returns no rows when WEB_URL is unset', () => {
    expect(buildBankTokenExpiringComponents(TEAM_ID, Option.none(), 'en')).toHaveLength(0);
  });

  it('links to /teams/:teamId/settings when WEB_URL is set', () => {
    const rows = buildBankTokenExpiringComponents(TEAM_ID, Option.some('https://app.test'), 'cs');
    expect(rows).toHaveLength(1);
    const button = (rows[0] as { components: ReadonlyArray<{ url?: string }> }).components[0];
    expect(button?.url).toBe(`https://app.test/teams/${TEAM_ID}/settings`);
  });
});
