// NOTE: These tests are written in TDD mode BEFORE the implementation of
// buildJoinBoardMessage. The file at ~/rest/events/buildJoinBoardMessage.ts
// does not yet exist. These tests WILL FAIL until the developer implements it.

import * as m from '@sideline/i18n/messages';
import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  buildJoinBoardMessage,
  type JoinRequestEntry,
} from '~/rest/events/buildJoinBoardMessage.js';

const locale = 'en' as const;

// ---------------------------------------------------------------------------
// Minimal JoinRequestEntry fixture
// ---------------------------------------------------------------------------

const baseEntry: JoinRequestEntry = {
  request_id: 'req-1',
  event_id: 'event-1',
  team_id: 'team-1',
  member_display_name: Option.some('Alice'),
  member_discord_id: Option.some('123456789012345678'),
  status: 'pending',
  decided_by_display_name: Option.none(),
};

// ---------------------------------------------------------------------------
// Case 1: Board message — "Request to join" button
// ---------------------------------------------------------------------------

describe('buildJoinBoardMessage — board message', () => {
  it('renders a "Request to join" button with custom_id starting with join-request:', () => {
    const { components } = buildJoinBoardMessage({
      mode: 'board',
      title: 'Summer Tournament',
      teamId: 'team-1',
      eventId: 'event-1',
      locale,
    });

    // Must have at least one action row
    expect(components.length).toBeGreaterThan(0);

    // Collect all buttons across all rows
    const buttons = components.flatMap((row: any) => row.components ?? []);
    expect(buttons.length).toBeGreaterThan(0);

    // Find the "Request to join" button
    const requestButton = buttons.find(
      (btn: any) =>
        btn.label === m.bot_join_request_button({}, { locale }) ||
        (typeof btn.custom_id === 'string' && btn.custom_id.startsWith('join-request:')),
    );
    expect(requestButton).toBeDefined();
    expect(requestButton?.custom_id).toMatch(/^join-request:/);
  });
});

// ---------------------------------------------------------------------------
// Case 2: Review message — PENDING state
// ---------------------------------------------------------------------------

describe('buildJoinBoardMessage — review message (pending)', () => {
  it('renders Accept (join-accept:) and Decline (join-decline:) buttons when status is pending', () => {
    const { components } = buildJoinBoardMessage({
      mode: 'review',
      entry: { ...baseEntry, status: 'pending' },
      teamId: 'team-1',
      locale,
    });

    // Must have buttons
    expect(components.length).toBeGreaterThan(0);
    const buttons = components.flatMap((row: any) => row.components ?? []);
    expect(buttons.length).toBeGreaterThan(0);

    // Accept button
    const acceptButton = buttons.find(
      (btn: any) => typeof btn.custom_id === 'string' && btn.custom_id.startsWith('join-accept:'),
    );
    expect(acceptButton).toBeDefined();
    expect(acceptButton?.label).toBe(m.bot_join_accept_button({}, { locale }));

    // Decline button
    const declineButton = buttons.find(
      (btn: any) => typeof btn.custom_id === 'string' && btn.custom_id.startsWith('join-decline:'),
    );
    expect(declineButton).toBeDefined();
    expect(declineButton?.label).toBe(m.bot_join_decline_button({}, { locale }));
  });
});

// ---------------------------------------------------------------------------
// Case 3: Review message — ACCEPTED state
// ---------------------------------------------------------------------------

describe('buildJoinBoardMessage — review message (accepted)', () => {
  it('renders no buttons and shows accepted-by text in the embed', () => {
    const { embeds, components } = buildJoinBoardMessage({
      mode: 'review',
      entry: {
        ...baseEntry,
        status: 'accepted',
        decided_by_display_name: Option.some('Captain Bob'),
      },
      teamId: 'team-1',
      locale,
    });

    // No interactive buttons when decided
    const buttons = components.flatMap((row: any) => row.components ?? []);
    const interactiveButtons = buttons.filter(
      (btn: any) =>
        typeof btn.custom_id === 'string' &&
        (btn.custom_id.startsWith('join-accept:') || btn.custom_id.startsWith('join-decline:')),
    );
    expect(interactiveButtons).toHaveLength(0);

    // Embed description or fields must contain accepted-by text
    const embedText = embeds
      .flatMap((embed: any) => [
        embed.description ?? '',
        ...(embed.fields ?? []).map((f: any) => f.value ?? ''),
      ])
      .join('\n');
    expect(embedText).toContain('Captain Bob');
  });
});

// ---------------------------------------------------------------------------
// Case 4: Review message — DECLINED state
// ---------------------------------------------------------------------------

describe('buildJoinBoardMessage — review message (declined)', () => {
  it('renders no buttons and shows declined-by text in the embed', () => {
    const { embeds, components } = buildJoinBoardMessage({
      mode: 'review',
      entry: {
        ...baseEntry,
        status: 'declined',
        decided_by_display_name: Option.some('Captain Carol'),
      },
      teamId: 'team-1',
      locale,
    });

    // No interactive buttons when decided
    const buttons = components.flatMap((row: any) => row.components ?? []);
    const interactiveButtons = buttons.filter(
      (btn: any) =>
        typeof btn.custom_id === 'string' &&
        (btn.custom_id.startsWith('join-accept:') || btn.custom_id.startsWith('join-decline:')),
    );
    expect(interactiveButtons).toHaveLength(0);

    // Embed description or fields must contain declined-by text
    const embedText = embeds
      .flatMap((embed: any) => [
        embed.description ?? '',
        ...(embed.fields ?? []).map((f: any) => f.value ?? ''),
      ])
      .join('\n');
    expect(embedText).toContain('Captain Carol');
  });
});
