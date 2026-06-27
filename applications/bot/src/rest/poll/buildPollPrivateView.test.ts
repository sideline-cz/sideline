// TDD mode — written BEFORE the implementation exists.
// Tests will fail to import until buildPollPrivateView.ts is created.
// buildPollPrivateView is a PURE function — call it directly, no Effect.

import type { Discord } from '@sideline/domain';
import { type Poll, PollRpcModels } from '@sideline/domain';
import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildPollPrivateView } from '~/rest/poll/buildPollPrivateView.js';

const locale = 'en' as const;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POLL_ID = 'poll-private-001' as Poll.PollId;
const CHANNEL_ID = '810000000000000001' as Discord.Snowflake;
const MESSAGE_ID = '810000000000000002' as Discord.Snowflake;

const makeOptionView = (
  optionId: string,
  label: string,
  position: number,
  voteCount = 0,
): PollRpcModels.PollOptionView =>
  new PollRpcModels.PollOptionView({
    option_id: optionId as Poll.PollOptionId,
    label,
    position,
    vote_count: voteCount,
  });

const makePollView = (
  options: PollRpcModels.PollOptionView[],
  myOptionIds: Poll.PollOptionId[] = [],
  status: Poll.PollStatus = 'open',
  multiple = false,
  totalVotes?: number,
): PollRpcModels.PollView =>
  new PollRpcModels.PollView({
    poll_id: POLL_ID,
    discord_channel_id: CHANNEL_ID,
    discord_message_id: Option.some(MESSAGE_ID),
    question: 'What is your favourite food?',
    status,
    multiple,
    allowed_role_id: Option.none(),
    deadline: Option.none(),
    total_votes:
      totalVotes !== undefined ? totalVotes : options.reduce((sum, o) => sum + o.vote_count, 0),
    options,
    my_option_ids: myOptionIds,
  });

// ---------------------------------------------------------------------------
// Tests — per-option poll-vote: buttons exist
// ---------------------------------------------------------------------------

describe('buildPollPrivateView — per-option poll-vote: buttons', () => {
  it('each option produces a poll-vote:{pollId}:{optionId} button', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0),
      makeOptionView('opt-b', 'Sushi', 1),
      makeOptionView('opt-c', 'Tacos', 2),
    ];
    const view = makePollView(options);

    const { components } = buildPollPrivateView(view, locale);

    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);

    expect(allCustomIds.some((id) => id === `poll-vote:${POLL_ID}:opt-a`)).toBe(true);
    expect(allCustomIds.some((id) => id === `poll-vote:${POLL_ID}:opt-b`)).toBe(true);
    expect(allCustomIds.some((id) => id === `poll-vote:${POLL_ID}:opt-c`)).toBe(true);
  });

  it('3 options → 3 poll-vote: buttons total', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0),
      makeOptionView('opt-b', 'Sushi', 1),
      makeOptionView('opt-c', 'Tacos', 2),
    ];
    const view = makePollView(options);

    const { components } = buildPollPrivateView(view, locale);

    const voteButtons = components
      .flatMap((row) => (row as any).components ?? [])
      .filter((c: any) => typeof c.custom_id === 'string' && c.custom_id.startsWith('poll-vote:'));
    expect(voteButtons).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Tests — selected option → Primary (style 1); unselected → Secondary (style 2)
// ---------------------------------------------------------------------------

describe('buildPollPrivateView — button styles (Primary/Secondary)', () => {
  it('selected option (in my_option_ids) → Primary (style 1)', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0, 1),
      makeOptionView('opt-b', 'Sushi', 1, 0),
    ];
    const view = makePollView(options, ['opt-a' as Poll.PollOptionId]);

    const { components } = buildPollPrivateView(view, locale);

    const allButtons = components.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
      style?: number;
    }>;
    const btnA = allButtons.find((b) => b.custom_id === `poll-vote:${POLL_ID}:opt-a`);
    const btnB = allButtons.find((b) => b.custom_id === `poll-vote:${POLL_ID}:opt-b`);

    expect(btnA).toBeDefined();
    expect(btnB).toBeDefined();
    expect(btnA?.style).toBe(1); // Primary
    expect(btnB?.style).toBe(2); // Secondary
  });

  it('multiple-choice with two selected → BOTH are Primary (style 1)', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0, 2),
      makeOptionView('opt-b', 'Sushi', 1, 2),
      makeOptionView('opt-c', 'Tacos', 2, 0),
    ];
    const view = makePollView(
      options,
      ['opt-a' as Poll.PollOptionId, 'opt-b' as Poll.PollOptionId],
      'open',
      true,
    );

    const { components } = buildPollPrivateView(view, locale);

    const allButtons = components.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
      style?: number;
    }>;
    const btnA = allButtons.find((b) => b.custom_id === `poll-vote:${POLL_ID}:opt-a`);
    const btnB = allButtons.find((b) => b.custom_id === `poll-vote:${POLL_ID}:opt-b`);
    const btnC = allButtons.find((b) => b.custom_id === `poll-vote:${POLL_ID}:opt-c`);

    expect(btnA?.style).toBe(1); // Primary (selected)
    expect(btnB?.style).toBe(1); // Primary (selected)
    expect(btnC?.style).toBe(2); // Secondary (not selected)
  });

  it('no selection (empty my_option_ids) → all buttons Secondary (style 2)', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options, []); // no my_option_ids

    const { components } = buildPollPrivateView(view, locale);

    const allButtons = components.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
      style?: number;
    }>;
    const voteButtons = allButtons.filter(
      (b) => typeof b.custom_id === 'string' && b.custom_id.startsWith('poll-vote:'),
    );
    for (const btn of voteButtons) {
      expect(btn.style).toBe(2); // Secondary
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — row layout: 10 options → 3 rows (4/4/2), each row ≤ 4 buttons
// ---------------------------------------------------------------------------

describe('buildPollPrivateView — row layout (4/row cap)', () => {
  it('10 options → 10 buttons, laid out in rows of ≤4', () => {
    const options = Array.from({ length: 10 }, (_, i) =>
      makeOptionView(`opt-${i}`, `Option ${i + 1}`, i),
    );
    const view = makePollView(options);

    const { components } = buildPollPrivateView(view, locale);

    const voteButtons = components
      .flatMap((row) => (row as any).components ?? [])
      .filter((c: any) => typeof c.custom_id === 'string' && c.custom_id.startsWith('poll-vote:'));
    expect(voteButtons).toHaveLength(10);

    // Every row must have ≤ 4 buttons
    for (const row of components) {
      const rowVoteButtons = ((row as any).components ?? []).filter(
        (c: any) => typeof c.custom_id === 'string' && c.custom_id.startsWith('poll-vote:'),
      );
      expect(rowVoteButtons.length).toBeLessThanOrEqual(4);
    }
  });

  it('10 options → 3 rows (rows with vote buttons: 4, 4, 2)', () => {
    const options = Array.from({ length: 10 }, (_, i) =>
      makeOptionView(`opt-${i}`, `Option ${i + 1}`, i),
    );
    const view = makePollView(options);

    const { components } = buildPollPrivateView(view, locale);

    // Count only rows that have poll-vote: buttons
    const voteRows = components.filter((row) =>
      ((row as any).components ?? []).some(
        (c: any) => typeof c.custom_id === 'string' && c.custom_id.startsWith('poll-vote:'),
      ),
    );
    expect(voteRows).toHaveLength(3);

    const rowSizes = voteRows.map(
      (row) =>
        ((row as any).components ?? []).filter(
          (c: any) => typeof c.custom_id === 'string' && c.custom_id.startsWith('poll-vote:'),
        ).length,
    );
    expect(rowSizes).toEqual([4, 4, 2]);
  });
});

// ---------------------------------------------------------------------------
// Tests — button label length limit (ported from buildPollEmbed.test.ts)
// ---------------------------------------------------------------------------

describe('buildPollPrivateView — button label length limit', () => {
  it('80-char option label → button label.length ≤ 80 (emoji+space overhead counted)', () => {
    const label80 = 'A'.repeat(80);
    const options = [makeOptionView('opt-a', label80, 0), makeOptionView('opt-b', 'Short', 1)];
    const view = makePollView(options);

    const { components } = buildPollPrivateView(view, locale);

    const allButtons = components.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
      label?: string;
    }>;
    const voteButtons = allButtons.filter(
      (b) => typeof b.custom_id === 'string' && b.custom_id.startsWith('poll-vote:'),
    );

    for (const btn of voteButtons) {
      expect((btn.label ?? '').length).toBeLessThanOrEqual(80);
    }
  });

  it('short option label (≤77 chars) → button label unchanged (no truncation)', () => {
    const label77 = 'B'.repeat(77);
    const options = [makeOptionView('opt-a', label77, 0), makeOptionView('opt-b', 'Short', 1)];
    const view = makePollView(options);

    const { components } = buildPollPrivateView(view, locale);

    const allButtons = components.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
      label?: string;
    }>;
    const btnForLong = allButtons.find(
      (b) => typeof b.custom_id === 'string' && b.custom_id.includes('opt-a'),
    );

    // Label: emoji (2 chars) + space (1 char) + 77-char label = 80 chars, no ellipsis
    expect(btnForLong?.label).toBeDefined();
    expect((btnForLong?.label ?? '').length).toBeLessThanOrEqual(80);
    expect(btnForLong?.label).not.toContain('…');
  });
});

// ---------------------------------------------------------------------------
// Tests — closed view → buttons disabled: true
// ---------------------------------------------------------------------------

describe('buildPollPrivateView — closed view', () => {
  it('closed poll view → all poll-vote: buttons have disabled: true', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0, 3),
      makeOptionView('opt-b', 'Sushi', 1, 1),
    ];
    const view = makePollView(options, [], 'closed');

    const { components } = buildPollPrivateView(view, locale);

    const allButtons = components.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
      disabled?: boolean;
    }>;
    const voteButtons = allButtons.filter(
      (b) => typeof b.custom_id === 'string' && b.custom_id.startsWith('poll-vote:'),
    );
    // There should still be vote buttons (so user can see what they voted for), but disabled
    expect(voteButtons.length).toBeGreaterThan(0);
    for (const btn of voteButtons) {
      expect(btn.disabled).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — embed present with title (bot_poll_private_title) and question
// ---------------------------------------------------------------------------

describe('buildPollPrivateView — embed title and content', () => {
  it('embed is present with the question in the title', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options);

    const { embeds } = buildPollPrivateView(view, locale);

    expect(embeds).toHaveLength(1);
    const title = embeds[0].title ?? '';
    // Title must contain the question text
    expect(title).toContain('What is your favourite food?');
  });

  it('embed title uses 🗳️ prefix (bot_poll_private_title: 🗳️ {question})', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options);

    const { embeds } = buildPollPrivateView(view, locale);

    const title = embeds[0].title ?? '';
    // Should start with the vote ballot emoji
    expect(title).toMatch(/^🗳️/);
  });
});

// ---------------------------------------------------------------------------
// Tests — NO poll-add: or poll-close: buttons in private view
// ---------------------------------------------------------------------------

describe('buildPollPrivateView — no admin buttons', () => {
  it('private view has NO poll-add: button', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options);

    const { components } = buildPollPrivateView(view, locale);

    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);

    expect(allCustomIds.every((id) => !id?.startsWith('poll-add:'))).toBe(true);
  });

  it('private view has NO poll-close: button', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options);

    const { components } = buildPollPrivateView(view, locale);

    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);

    expect(allCustomIds.every((id) => !id?.startsWith('poll-close:'))).toBe(true);
  });

  it('private view has NO poll-open: button', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options);

    const { components } = buildPollPrivateView(view, locale);

    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);

    expect(allCustomIds.every((id) => !id?.startsWith('poll-open:'))).toBe(true);
  });
});
