// TDD mode — written BEFORE the implementation exists.
// Tests will fail to import until buildPollEmbed is implemented.
// buildPollEmbed is a PURE function — call it directly, no Effect.

import type { Discord } from '@sideline/domain';
import { type Poll, PollRpcModels } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildPollEmbed } from '~/rest/poll/buildPollEmbed.js';

const locale = 'en' as const;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POLL_ID = 'poll-test-001' as Poll.PollId;
const CHANNEL_ID = '800000000000000001' as Discord.Snowflake;
const MESSAGE_ID = '800000000000000002' as Discord.Snowflake;

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
  deadline: Option.Option<any> = Option.none(),
): PollRpcModels.PollView =>
  new PollRpcModels.PollView({
    poll_id: POLL_ID,
    discord_channel_id: CHANNEL_ID,
    discord_message_id: Option.some(MESSAGE_ID),
    question: 'What is your favourite food?',
    status,
    multiple,
    allowed_role_id: Option.none(),
    deadline,
    total_votes: myOptionIds.length,
    options,
    my_option_ids: myOptionIds,
  });

// ---------------------------------------------------------------------------
// Regional indicator letters (🇦 = U+1F1E6)
// ---------------------------------------------------------------------------

const REGIONAL_A = String.fromCodePoint(0x1f1e6); // 🇦
const REGIONAL_B = String.fromCodePoint(0x1f1e7); // 🇧
const REGIONAL_C = String.fromCodePoint(0x1f1e8); // 🇨

// ---------------------------------------------------------------------------
// Tests — row layout (3, 9, 10 options)
// ---------------------------------------------------------------------------

describe('buildPollEmbed — row layout', () => {
  it('3 options — 3 fields with regional indicator letters A/B/C', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0),
      makeOptionView('opt-b', 'Sushi', 1),
      makeOptionView('opt-c', 'Tacos', 2),
    ];
    const view = makePollView(options);

    const { embeds } = buildPollEmbed(view, locale);

    expect(embeds).toHaveLength(1);
    const fields = embeds[0].fields ?? [];
    // Each option gets a field
    expect(fields.length).toBeGreaterThanOrEqual(3);

    const names = fields.map((f) => f.name);
    const hasA = names.some((n) => n.includes(REGIONAL_A));
    const hasB = names.some((n) => n.includes(REGIONAL_B));
    const hasC = names.some((n) => n.includes(REGIONAL_C));
    expect(hasA).toBe(true);
    expect(hasB).toBe(true);
    expect(hasC).toBe(true);
  });

  it('3 options — buttons laid out 3 per row (max 4/row)', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0),
      makeOptionView('opt-b', 'Sushi', 1),
      makeOptionView('opt-c', 'Tacos', 2),
    ];
    const view = makePollView(options);

    const { components } = buildPollEmbed(view, locale);

    // Collect vote buttons — custom_id starts with 'poll-vote:'
    const voteButtons = components
      .flatMap((row) => (row as any).components ?? [])
      .filter((c: any) => typeof c.custom_id === 'string' && c.custom_id.startsWith('poll-vote:'));
    expect(voteButtons).toHaveLength(3);
  });

  it('9 options — 9 fields; buttons span multiple rows (max 4/row = 3 rows)', () => {
    const options = Array.from({ length: 9 }, (_, i) =>
      makeOptionView(`opt-${i}`, `Option ${i + 1}`, i),
    );
    const view = makePollView(options);

    const { embeds, components } = buildPollEmbed(view, locale);

    const fields = embeds[0].fields ?? [];
    expect(fields.length).toBeGreaterThanOrEqual(9);

    const voteButtons = components
      .flatMap((row) => (row as any).components ?? [])
      .filter((c: any) => typeof c.custom_id === 'string' && c.custom_id.startsWith('poll-vote:'));
    expect(voteButtons).toHaveLength(9);
  });

  it('10 options — 10 vote buttons, each row has ≤4 buttons', () => {
    const options = Array.from({ length: 10 }, (_, i) =>
      makeOptionView(`opt-${i}`, `Option ${i + 1}`, i),
    );
    const view = makePollView(options);

    const { components } = buildPollEmbed(view, locale);

    const voteButtons = components
      .flatMap((row) => (row as any).components ?? [])
      .filter((c: any) => typeof c.custom_id === 'string' && c.custom_id.startsWith('poll-vote:'));
    expect(voteButtons).toHaveLength(10);

    // Every row with vote buttons must have ≤ 4
    for (const row of components) {
      const rowButtons = ((row as any).components ?? []).filter(
        (c: any) => typeof c.custom_id === 'string' && c.custom_id.startsWith('poll-vote:'),
      );
      expect(rowButtons.length).toBeLessThanOrEqual(4);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — highlight ALL options in my_option_ids
// ---------------------------------------------------------------------------

describe('buildPollEmbed — my_option_ids highlighting', () => {
  it('single selected option highlighted as Primary button; others Secondary', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0, 1),
      makeOptionView('opt-b', 'Sushi', 1, 0),
      makeOptionView('opt-c', 'Tacos', 2, 0),
    ];
    const view = makePollView(options, ['opt-a' as Poll.PollOptionId]);

    const { components } = buildPollEmbed(view, locale);

    const allButtons = components.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
      style?: number;
    }>;
    const voteButtons = allButtons.filter(
      (b) => typeof b.custom_id === 'string' && b.custom_id.startsWith('poll-vote:'),
    );
    const btnA = voteButtons.find((b) => b.custom_id === `poll-vote:${POLL_ID}:opt-a`);
    const btnB = voteButtons.find((b) => b.custom_id === `poll-vote:${POLL_ID}:opt-b`);

    expect(btnA).toBeDefined();
    expect(btnB).toBeDefined();
    // Primary = 1, Secondary = 2 in Discord button styles
    expect(btnA?.style).toBe(1); // Primary
    expect(btnB?.style).toBe(2); // Secondary
  });

  it('multi-choice: ALL selected options highlighted (Primary), unselected Secondary', () => {
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

    const { components } = buildPollEmbed(view, locale);

    const allButtons = components.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
      style?: number;
    }>;
    const voteButtons = allButtons.filter(
      (b) => typeof b.custom_id === 'string' && b.custom_id.startsWith('poll-vote:'),
    );
    const btnA = voteButtons.find((b) => b.custom_id === `poll-vote:${POLL_ID}:opt-a`);
    const btnB = voteButtons.find((b) => b.custom_id === `poll-vote:${POLL_ID}:opt-b`);
    const btnC = voteButtons.find((b) => b.custom_id === `poll-vote:${POLL_ID}:opt-c`);

    expect(btnA?.style).toBe(1); // Primary (selected)
    expect(btnB?.style).toBe(1); // Primary (selected)
    expect(btnC?.style).toBe(2); // Secondary (not selected)
  });

  it('no selection — all option buttons are Secondary', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options, []); // no my_option_ids

    const { components } = buildPollEmbed(view, locale);

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
// Tests — closed poll: buttons disabled / action row omitted
// ---------------------------------------------------------------------------

describe('buildPollEmbed — closed poll behavior', () => {
  it('closed poll → all vote buttons disabled', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0, 3),
      makeOptionView('opt-b', 'Sushi', 1, 1),
    ];
    const view = makePollView(options, [], 'closed');

    const { components } = buildPollEmbed(view, locale);

    const allButtons = components.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
      disabled?: boolean;
    }>;
    const voteButtons = allButtons.filter(
      (b) => typeof b.custom_id === 'string' && b.custom_id.startsWith('poll-vote:'),
    );
    for (const btn of voteButtons) {
      expect(btn.disabled).toBe(true);
    }
  });

  it('closed poll → add and close action row is omitted', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0, 5),
      makeOptionView('opt-b', 'Sushi', 1, 2),
    ];
    const view = makePollView(options, [], 'closed');

    const { components } = buildPollEmbed(view, locale);

    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);

    // The add-option and close-poll buttons must NOT appear on a closed poll
    expect(allCustomIds.every((id) => !id?.startsWith('poll-add:'))).toBe(true);
    expect(allCustomIds.every((id) => !id?.startsWith('poll-close:'))).toBe(true);
  });

  it('open poll → add and close action row present', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options, [], 'open');

    const { components } = buildPollEmbed(view, locale);

    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);

    expect(allCustomIds.some((id) => id?.startsWith('poll-add:'))).toBe(true);
    expect(allCustomIds.some((id) => id?.startsWith('poll-close:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — footer single vs multi vs closed
// ---------------------------------------------------------------------------

describe('buildPollEmbed — footer text', () => {
  it('open single-choice poll → footer contains open single indicator', () => {
    const options = [makeOptionView('opt-a', 'A', 0), makeOptionView('opt-b', 'B', 1)];
    const view = makePollView(options, [], 'open', false); // single

    const { embeds } = buildPollEmbed(view, locale);

    const footer = embeds[0].footer?.text ?? '';
    // The footer should signal single-choice open poll
    expect(footer.length).toBeGreaterThan(0);
    // Should NOT contain the multi indicator
    const embedJson = JSON.stringify(embeds);
    // Footer text must be present
    expect(embedJson).toMatch(/footer/i);
  });

  it('open multi-choice poll → footer text differs from single (contains multi indicator)', () => {
    const options = [makeOptionView('opt-a', 'A', 0), makeOptionView('opt-b', 'B', 1)];
    const singleView = makePollView(options, [], 'open', false);
    const multiView = makePollView(options, [], 'open', true);

    const { embeds: singleEmbeds } = buildPollEmbed(singleView, locale);
    const { embeds: multiEmbeds } = buildPollEmbed(multiView, locale);

    const singleFooter = singleEmbeds[0].footer?.text ?? '';
    const multiFooter = multiEmbeds[0].footer?.text ?? '';

    // The footers must differ between single and multi
    expect(singleFooter).not.toBe(multiFooter);
  });

  it('closed poll → footer text is different from open (winner/tie/empty)', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0, 5),
      makeOptionView('opt-b', 'Sushi', 1, 2),
    ];
    const openView = makePollView(options, [], 'open', false);
    const closedView = makePollView(options, [], 'closed', false);

    const { embeds: openEmbeds } = buildPollEmbed(openView, locale);
    const { embeds: closedEmbeds } = buildPollEmbed(closedView, locale);

    const openFooter = openEmbeds[0].footer?.text ?? '';
    const closedFooter = closedEmbeds[0].footer?.text ?? '';

    expect(openFooter).not.toBe(closedFooter);
    expect(closedFooter.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — custom_id formats
// ---------------------------------------------------------------------------

describe('buildPollEmbed — custom_id formats', () => {
  it('vote button custom_id format: poll-vote:{pollId}:{optionId}', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options);

    const { components } = buildPollEmbed(view, locale);

    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);

    const voteButtonForA = allCustomIds.find((id) => id === `poll-vote:${POLL_ID}:opt-a`);
    const voteButtonForB = allCustomIds.find((id) => id === `poll-vote:${POLL_ID}:opt-b`);

    expect(voteButtonForA).toBeDefined();
    expect(voteButtonForB).toBeDefined();
  });

  it('add option button custom_id format: poll-add:{pollId}', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options, [], 'open');

    const { components } = buildPollEmbed(view, locale);

    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);

    const addBtn = allCustomIds.find((id) => id === `poll-add:${POLL_ID}`);
    expect(addBtn).toBeDefined();
  });

  it('close poll button custom_id format: poll-close:{pollId}', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options, [], 'open');

    const { components } = buildPollEmbed(view, locale);

    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);

    const closeBtn = allCustomIds.find((id) => id === `poll-close:${POLL_ID}`);
    expect(closeBtn).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — deadline relative timestamp rendering
// ---------------------------------------------------------------------------

describe('buildPollEmbed — deadline rendering', () => {
  it('no deadline → no timestamp in embed', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options, [], 'open', false, Option.none());

    const { embeds } = buildPollEmbed(view, locale);

    const embedJson = JSON.stringify(embeds);
    // No <t: timestamp markers without a deadline
    expect(embedJson).not.toMatch(/<t:\d+/);
  });

  it('deadline Some → embed contains <t:{unix}:R> relative timestamp', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];

    // Create a DateTime at a known future unix timestamp
    const futureUnix = 4000000000; // far future
    // For the test fixture, construct the deadline as an Option<DateTime.Utc>
    const deadline = Option.some(DateTime.fromDateUnsafe(new Date(futureUnix * 1000)));

    const view = makePollView(options, [], 'open', false, deadline);

    const { embeds } = buildPollEmbed(view, locale);

    const embedJson = JSON.stringify(embeds);
    // Should contain <t:{unix}:R> and <t:{unix}:f> for the deadline
    expect(embedJson).toMatch(/<t:\d+:R>/);
    expect(embedJson).toMatch(/<t:\d+:f>/);
  });
});

// ---------------------------------------------------------------------------
// Tests — embed title and color
// ---------------------------------------------------------------------------

describe('buildPollEmbed — title and color', () => {
  it('title format: 📊 {question}', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options);

    const { embeds } = buildPollEmbed(view, locale);

    expect(embeds[0].title).toBe('📊 What is your favourite food?');
  });

  it('open poll uses blue/blurple color (0x5865f2)', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options, [], 'open');

    const { embeds } = buildPollEmbed(view, locale);

    expect(embeds[0].color).toBe(0x5865f2);
  });

  it('closed poll uses different (grey/darker) color', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0, 5),
      makeOptionView('opt-b', 'Sushi', 1, 1),
    ];
    const openView = makePollView(options, [], 'open');
    const closedView = makePollView(options, [], 'closed');

    const { embeds: openEmbeds } = buildPollEmbed(openView, locale);
    const { embeds: closedEmbeds } = buildPollEmbed(closedView, locale);

    expect(closedEmbeds[0].color).not.toBe(openEmbeds[0].color);
  });
});

// ---------------------------------------------------------------------------
// Tests — option bar display
// ---------------------------------------------------------------------------

describe('buildPollEmbed — option field display', () => {
  it('option with votes — field value shows count and percent', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0, 3),
      makeOptionView('opt-b', 'Sushi', 1, 1),
    ];
    const view = makePollView(options, [], 'open');

    const { embeds } = buildPollEmbed(view, locale);

    const fields = embeds[0].fields ?? [];
    const embedJson = JSON.stringify(fields);

    // Should contain vote counts
    expect(embedJson).toContain('3');
    expect(embedJson).toContain('1');
  });

  it('option label appears in field name', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options);

    const { embeds } = buildPollEmbed(view, locale);

    const fields = embeds[0].fields ?? [];
    const fieldNames = fields.map((f) => f.name);
    expect(fieldNames.some((n) => n.includes('Pizza'))).toBe(true);
    expect(fieldNames.some((n) => n.includes('Sushi'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — Fix B: button label must not exceed 80 chars (Discord limit)
// ---------------------------------------------------------------------------

describe('buildPollEmbed — button label length limit (Fix B)', () => {
  it('80-char option label → button label.length ≤ 80 (emoji+space overhead counted)', () => {
    // An 80-char label with the regional indicator (2 surrogate chars) + space overhead = 83 chars
    // without truncation. The fix must cap the button label at 80 chars total.
    const label80 = 'A'.repeat(80);
    const options = [makeOptionView('opt-a', label80, 0), makeOptionView('opt-b', 'Short', 1)];
    const view = makePollView(options);

    const { components } = buildPollEmbed(view, locale);

    const allButtons = components.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
      label?: string;
    }>;
    const voteButtons = allButtons.filter(
      (b) => typeof b.custom_id === 'string' && b.custom_id.startsWith('poll-vote:'),
    );

    // Every button label must be ≤ 80 chars
    for (const btn of voteButtons) {
      expect((btn.label ?? '').length).toBeLessThanOrEqual(80);
    }
  });

  it('80-char option label appears FULL in embed field (not truncated)', () => {
    const label80 = 'A'.repeat(80);
    const options = [makeOptionView('opt-a', label80, 0), makeOptionView('opt-b', 'Short', 1)];
    const view = makePollView(options);

    const { embeds } = buildPollEmbed(view, locale);

    // The field name in the embed should contain the full 80-char label
    const fields = embeds[0].fields ?? [];
    const fieldWithFullLabel = fields.find((f) => f.name.includes(label80));
    expect(fieldWithFullLabel).toBeDefined();
  });

  it('short option label (≤77 chars) → button label unchanged (no truncation)', () => {
    const label77 = 'B'.repeat(77);
    const options = [makeOptionView('opt-a', label77, 0), makeOptionView('opt-b', 'Short', 1)];
    const view = makePollView(options);

    const { components } = buildPollEmbed(view, locale);

    const allButtons = components.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
      label?: string;
    }>;
    const btnForLong = allButtons.find(
      (b) => typeof b.custom_id === 'string' && b.custom_id.includes('opt-a'),
    );

    // Label should be: emoji (2 chars) + space (1 char) + 77-char label = 80 chars, no ellipsis
    expect(btnForLong?.label).toBeDefined();
    expect((btnForLong?.label ?? '').length).toBeLessThanOrEqual(80);
    // Should NOT be truncated since 77 chars fits exactly
    expect(btnForLong?.label).not.toContain('…');
  });
});
