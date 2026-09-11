// NOTE: TDD mode — tests will FAIL until buildRosterApprovalMessage is implemented.

import type { Discord, Event, RosterModel, TeamMember } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
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
  // PR 3b (all-day-discord-start-time-plan.md §11.1 row B1-B5): `startDate` is a new
  // required field on buildRosterApprovalMessage's opts, carrying the team-local calendar
  // date derived server-side. Only meaningful for the all-day branch — a fixed UTC-date
  // string here keeps every pre-existing (timed) test in this file byte-for-byte unchanged.
  startDate: '2099-07-01',
  memberId: MEMBER_ID,
  candidateDiscordId: Option.some(DISCORD_USER_ID),
  candidateDisplayName: Option.some('Alice'),
  rosterName: Option.some('Tournament Squad'),
  locale: 'en' as const,
  // PR 1 (all-day-discord-start-time-plan.md §5 PR 1 step 5): `allDay` is a new required
  // field on buildRosterApprovalMessage's opts. `false` here keeps every pre-existing
  // test in this file byte-for-byte unchanged (§7.4).
  allDay: false,
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

// ---------------------------------------------------------------------------
// PR 1 §7.4 — Event field: date, not a fake noon clock time, for all-day events.
// Plan: all-day-discord-start-time-plan.md §7.4, builder tests for buildRosterApprovalMessage.
// ---------------------------------------------------------------------------
describe('buildRosterApprovalMessage — Event field with allDay (PR 1 / PR 3b)', () => {
  const locale = 'en' as const;
  const ALL_DAY_MARKER = ` · ${m.bot_embed_all_day({}, { locale })}`;
  const NOON_JUL_15 = DateTime.makeUnsafe('2026-07-15T12:00:00Z'); // 1784116800
  // Team-local midnight anchor (a Prague event on 2026-07-15 is stored at
  // 2026-07-14T22:00:00Z, CEST +02:00), NOT the retired noon-UTC sentinel. The byte-exact
  // assertion below only passes if the code reads `startDate`, not a UTC read of `startAt`
  // (which would yield 2026-07-14 — one day early).
  const MIDNIGHT_JUL_15 = DateTime.makeUnsafe('2026-07-14T22:00:00Z');

  it("allDay false → Event field is exactly **{title}** — <t:S:f> (today's output)", () => {
    const message = buildRosterApprovalMessage({
      ...baseOpts,
      status: 'pending',
      allDay: false,
      startAt: NOON_JUL_15,
    });
    const fields = message.embeds[0]?.fields ?? [];
    const eventField = fields.find(
      (f) => f.name === m.bot_roster_approval_field_event({}, { locale }),
    );
    expect(eventField?.value).toBe(`**${baseOpts.eventTitle}** — <t:1784116800:f>`);
  });

  it('allDay true → Event field is exactly **{title}** — <t:S:D> · All day', () => {
    const message = buildRosterApprovalMessage({
      ...baseOpts,
      status: 'pending',
      allDay: true,
      startAt: MIDNIGHT_JUL_15,
      startDate: '2026-07-15',
    });
    const fields = message.embeds[0]?.fields ?? [];
    const eventField = fields.find(
      (f) => f.name === m.bot_roster_approval_field_event({}, { locale }),
    );
    expect(eventField?.value).toBe(
      `**${baseOpts.eventTitle}** — <t:1784116800:D>${ALL_DAY_MARKER}`,
    );
  });

  it('all-day regression (B1): reads startDate, not a UTC read of startAt', () => {
    // A Prague all-day event on 2026-09-16, stored at team-local midnight. A UTC read of
    // this instant yields 2026-09-15 — one day early, for every viewer east of UTC (the
    // entire default fleet). Reading `startDate` yields the correct 2026-09-16.
    const message = buildRosterApprovalMessage({
      ...baseOpts,
      status: 'pending',
      allDay: true,
      startAt: DateTime.makeUnsafe('2026-09-15T22:00:00Z'),
      startDate: '2026-09-16',
    });
    const fields = message.embeds[0]?.fields ?? [];
    const eventField = fields.find(
      (f) => f.name === m.bot_roster_approval_field_event({}, { locale }),
    );
    expect(eventField?.value).toContain('<t:1789560000:D>'); // 2026-09-16T12:00:00Z
    expect(eventField?.value).not.toContain('<t:1789473600:D>'); // 2026-09-15T12:00:00Z
  });
});
