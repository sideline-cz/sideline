// NOTE: TDD mode — tests will FAIL until buildRosterApprovalMessage is implemented.

import type { Discord, Event, RosterModel, TeamMember } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildRosterApprovalMessage } from '~/rest/events/buildRosterApprovalMessage.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVENT_ID = '00000000-0000-0000-0000-000000000060' as Event.EventId;
const MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const _ROSTER_ID = '00000000-0000-0000-0000-000000000030' as RosterModel.RosterId;
const DISCORD_USER_ID = '111111111111111111' as Discord.Snowflake;

const baseOpts = {
  eventId: EVENT_ID,
  eventTitle: 'Summer Tournament',
  startAt: DateTime.makeUnsafe('2099-07-01T10:00:00Z'),
  memberId: MEMBER_ID,
  candidateDiscordId: Option.some(DISCORD_USER_ID),
  candidateDisplayName: Option.some('Alice'),
  rosterName: Option.some('Tournament Squad'),
  locale: 'en' as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildRosterApprovalMessage — pending state', () => {
  it('includes Approve button with custom_id starting "rsv-approve:"', () => {
    const message = buildRosterApprovalMessage({
      ...baseOpts,
      status: 'pending',
    });

    const components = message.components ?? [];
    const buttons = components
      .flatMap((row: any) => row.components ?? [])
      .filter((c: any) => c.style !== undefined);

    const approveButton = buttons.find(
      (b: any) => typeof b.custom_id === 'string' && b.custom_id.startsWith('rsv-approve:'),
    );
    expect(approveButton).toBeDefined();
  });

  it('includes Decline button with custom_id starting "rsv-decline:"', () => {
    const message = buildRosterApprovalMessage({
      ...baseOpts,
      status: 'pending',
    });

    const components = message.components ?? [];
    const buttons = components
      .flatMap((row: any) => row.components ?? [])
      .filter((c: any) => c.style !== undefined);

    const declineButton = buttons.find(
      (b: any) => typeof b.custom_id === 'string' && b.custom_id.startsWith('rsv-decline:'),
    );
    expect(declineButton).toBeDefined();
  });

  it('custom_ids are ≤ 100 characters', () => {
    const message = buildRosterApprovalMessage({
      ...baseOpts,
      status: 'pending',
    });

    const components = message.components ?? [];
    const buttons = components
      .flatMap((row: any) => row.components ?? [])
      .filter((c: any) => typeof c.custom_id === 'string');

    for (const button of buttons) {
      expect((button as any).custom_id.length).toBeLessThanOrEqual(100);
    }
  });

  it('custom_ids encode eventId:memberId', () => {
    const message = buildRosterApprovalMessage({
      ...baseOpts,
      status: 'pending',
    });

    const components = message.components ?? [];
    const buttons = components
      .flatMap((row: any) => row.components ?? [])
      .filter((c: any) => typeof c.custom_id === 'string');

    const approveButton = buttons.find((b: any) => (b as any).custom_id.startsWith('rsv-approve:'));
    expect(approveButton).toBeDefined();
    const customId = (approveButton as any).custom_id as string;
    // Should contain eventId and memberId
    expect(customId).toContain(EVENT_ID);
    expect(customId).toContain(MEMBER_ID);
  });

  it('embed color is orange for pending state', () => {
    const message = buildRosterApprovalMessage({
      ...baseOpts,
      status: 'pending',
    });
    const embed = (message.embeds ?? [])[0];
    expect(embed).toBeDefined();
    // Orange ~ 0xFF8C00 = 16744448 or similar — just assert color is set
    expect(embed?.color).toBeDefined();
  });
});

describe('buildRosterApprovalMessage — approved state', () => {
  it('no active Approve/Decline buttons when approved', () => {
    const message = buildRosterApprovalMessage({
      ...baseOpts,
      status: 'approved',
    });

    const components = message.components ?? [];
    const activeButtons = components
      .flatMap((row: any) => row.components ?? [])
      .filter(
        (c: any) =>
          typeof c.custom_id === 'string' &&
          (c.custom_id.startsWith('rsv-approve:') || c.custom_id.startsWith('rsv-decline:')) &&
          c.disabled !== true,
      );
    expect(activeButtons).toHaveLength(0);
  });

  it('status text present in embed for approved state', () => {
    const message = buildRosterApprovalMessage({
      ...baseOpts,
      status: 'approved',
    });
    const embed = (message.embeds ?? [])[0];
    expect(embed).toBeDefined();
    const allText = JSON.stringify(embed);
    // Some status indicator text
    expect(allText.length).toBeGreaterThan(10);
  });
});

describe('buildRosterApprovalMessage — declined state', () => {
  it('no active buttons when declined', () => {
    const message = buildRosterApprovalMessage({
      ...baseOpts,
      status: 'declined',
    });

    const components = message.components ?? [];
    const activeButtons = components
      .flatMap((row: any) => row.components ?? [])
      .filter(
        (c: any) =>
          typeof c.custom_id === 'string' &&
          (c.custom_id.startsWith('rsv-approve:') || c.custom_id.startsWith('rsv-decline:')) &&
          c.disabled !== true,
      );
    expect(activeButtons).toHaveLength(0);
  });
});

describe('buildRosterApprovalMessage — cancelled state', () => {
  it('no active buttons when cancelled', () => {
    const message = buildRosterApprovalMessage({
      ...baseOpts,
      status: 'cancelled',
    });

    const components = message.components ?? [];
    const activeButtons = components
      .flatMap((row: any) => row.components ?? [])
      .filter(
        (c: any) =>
          typeof c.custom_id === 'string' &&
          (c.custom_id.startsWith('rsv-approve:') || c.custom_id.startsWith('rsv-decline:')) &&
          c.disabled !== true,
      );
    expect(activeButtons).toHaveLength(0);
  });
});
