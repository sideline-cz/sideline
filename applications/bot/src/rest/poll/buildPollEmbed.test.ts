// TDD mode — written BEFORE the implementation changes land.
// The public board is now aggregate-only: no poll-vote: buttons, one poll-open: button.
// Tests will fail on the OLD implementation (which still emits poll-vote: buttons).
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
    deadline,
    // totalVotes defaults to the sum of all option vote_counts when not provided explicitly.
    total_votes:
      totalVotes !== undefined ? totalVotes : options.reduce((sum, o) => sum + o.vote_count, 0),
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
// Tests — public board has ZERO poll-vote: buttons (aggregate only)
// ---------------------------------------------------------------------------

describe('buildPollEmbed — public board has no poll-vote buttons (aggregate only)', () => {
  it('open poll → ZERO poll-vote: buttons in components', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0),
      makeOptionView('opt-b', 'Sushi', 1),
      makeOptionView('opt-c', 'Tacos', 2),
    ];
    const view = makePollView(options);

    const { components } = buildPollEmbed(view, locale);

    const voteButtons = components
      .flatMap((row) => (row as any).components ?? [])
      .filter((c: any) => typeof c.custom_id === 'string' && c.custom_id.startsWith('poll-vote:'));
    expect(voteButtons).toHaveLength(0);
  });

  it('my_option_ids set — board STILL has zero poll-vote: buttons (no per-user leak)', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0, 1),
      makeOptionView('opt-b', 'Sushi', 1, 0),
    ];
    const view = makePollView(options, ['opt-a' as Poll.PollOptionId]);

    const { components } = buildPollEmbed(view, locale);

    const voteButtons = components
      .flatMap((row) => (row as any).components ?? [])
      .filter((c: any) => typeof c.custom_id === 'string' && c.custom_id.startsWith('poll-vote:'));
    expect(voteButtons).toHaveLength(0);
  });

  it('multi-choice with two my_option_ids → board still has zero poll-vote: buttons', () => {
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

    const voteButtons = components
      .flatMap((row) => (row as any).components ?? [])
      .filter((c: any) => typeof c.custom_id === 'string' && c.custom_id.startsWith('poll-vote:'));
    expect(voteButtons).toHaveLength(0);
  });

  it('no my_option_ids → board has zero poll-vote: buttons', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options, []); // no my_option_ids

    const { components } = buildPollEmbed(view, locale);

    const voteButtons = components
      .flatMap((row) => (row as any).components ?? [])
      .filter((c: any) => typeof c.custom_id === 'string' && c.custom_id.startsWith('poll-vote:'));
    expect(voteButtons).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — public board has exactly one poll-open: button
// ---------------------------------------------------------------------------

describe('buildPollEmbed — public board has exactly one poll-open: button', () => {
  it('open poll → exactly one button with custom_id poll-open:{pollId}', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options);

    const { components } = buildPollEmbed(view, locale);

    const openButtons = components
      .flatMap((row) => (row as any).components ?? [])
      .filter(
        (c: any) => typeof c.custom_id === 'string' && c.custom_id === `poll-open:${POLL_ID}`,
      );
    expect(openButtons).toHaveLength(1);
  });

  it('poll-open: button appears on ALL open polls regardless of my_option_ids', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0)];
    const view = makePollView(options, ['opt-a' as Poll.PollOptionId]);

    const { components } = buildPollEmbed(view, locale);

    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);
    expect(allCustomIds.some((id) => id === `poll-open:${POLL_ID}`)).toBe(true);
  });

  it('closed poll → NO poll-open: button', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0, 3),
      makeOptionView('opt-b', 'Sushi', 1, 1),
    ];
    const view = makePollView(options, [], 'closed');

    const { components } = buildPollEmbed(view, locale);

    const openButtons = components
      .flatMap((row) => (row as any).components ?? [])
      .filter((c: any) => typeof c.custom_id === 'string' && c.custom_id.startsWith('poll-open:'));
    expect(openButtons).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — row layout: aggregate fields (not vote buttons)
// ---------------------------------------------------------------------------

describe('buildPollEmbed — row layout (aggregate fields)', () => {
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
    expect(fields.length).toBeGreaterThanOrEqual(3);

    const names = fields.map((f) => f.name);
    const hasA = names.some((n) => n.includes(REGIONAL_A));
    const hasB = names.some((n) => n.includes(REGIONAL_B));
    const hasC = names.some((n) => n.includes(REGIONAL_C));
    expect(hasA).toBe(true);
    expect(hasB).toBe(true);
    expect(hasC).toBe(true);
  });

  it('9 options — 9 fields in the embed', () => {
    const options = Array.from({ length: 9 }, (_, i) =>
      makeOptionView(`opt-${i}`, `Option ${i + 1}`, i),
    );
    const view = makePollView(options);

    const { embeds } = buildPollEmbed(view, locale);

    const fields = embeds[0].fields ?? [];
    expect(fields.length).toBeGreaterThanOrEqual(9);
  });
});

// ---------------------------------------------------------------------------
// Tests — closed poll: no components at all
// ---------------------------------------------------------------------------

describe('buildPollEmbed — closed poll behavior', () => {
  it('closed poll → no poll-vote:, no poll-open:, no poll-add:, no poll-close: buttons; only poll-voters: remains', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0, 3),
      makeOptionView('opt-b', 'Sushi', 1, 1),
    ];
    const view = makePollView(options, [], 'closed');

    const { components } = buildPollEmbed(view, locale);

    // Closed board must NOT have vote/open/add/close buttons
    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);
    expect(allCustomIds.every((id) => !id?.startsWith('poll-vote:'))).toBe(true);
    expect(allCustomIds.every((id) => !id?.startsWith('poll-open:'))).toBe(true);
    expect(allCustomIds.every((id) => !id?.startsWith('poll-add:'))).toBe(true);
    expect(allCustomIds.every((id) => !id?.startsWith('poll-close:'))).toBe(true);
    // But the voters button IS present
    expect(allCustomIds.some((id) => id?.startsWith('poll-voters:'))).toBe(true);
  });

  it('closed poll → no poll-add: or poll-close: buttons', () => {
    const options = [
      makeOptionView('opt-a', 'Pizza', 0, 5),
      makeOptionView('opt-b', 'Sushi', 1, 2),
    ];
    const view = makePollView(options, [], 'closed');

    const { components } = buildPollEmbed(view, locale);

    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);

    expect(allCustomIds.every((id) => !id?.startsWith('poll-add:'))).toBe(true);
    expect(allCustomIds.every((id) => !id?.startsWith('poll-close:'))).toBe(true);
  });

  it('open poll → poll-add: and poll-close: action buttons present', () => {
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
    const embedJson = JSON.stringify(embeds);
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
// Tests — custom_id formats (poll-add, poll-close, poll-open)
// ---------------------------------------------------------------------------

describe('buildPollEmbed — custom_id formats', () => {
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

  it('vote button custom_id format: poll-open:{pollId} (aggregate board vote entry-point)', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = makePollView(options, [], 'open');

    const { components } = buildPollEmbed(view, locale);

    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);

    const openBtn = allCustomIds.find((id) => id === `poll-open:${POLL_ID}`);
    expect(openBtn).toBeDefined();
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
    expect(embedJson).not.toMatch(/<t:\d+/);
  });

  it('deadline Some → embed contains <t:{unix}:R> relative timestamp', () => {
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];

    const futureUnix = 4000000000; // far future
    const deadline = Option.some(DateTime.fromDateUnsafe(new Date(futureUnix * 1000)));

    const view = makePollView(options, [], 'open', false, deadline);

    const { embeds } = buildPollEmbed(view, locale);

    const embedJson = JSON.stringify(embeds);
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

  it('question of 300 chars → embed title truncated to ≤256 chars', () => {
    const question300 = 'Q'.repeat(300);
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = new PollRpcModels.PollView({
      poll_id: POLL_ID,
      discord_channel_id: CHANNEL_ID,
      discord_message_id: Option.some(MESSAGE_ID),
      question: question300,
      status: 'open',
      multiple: false,
      allowed_role_id: Option.none(),
      deadline: Option.none(),
      total_votes: 0,
      options,
      my_option_ids: [],
    });

    const { embeds } = buildPollEmbed(view, locale);

    expect(embeds[0].title).toBeDefined();
    expect((embeds[0].title ?? '').length).toBeLessThanOrEqual(256);
    expect(embeds[0].title).toMatch(/…$/);
  });

  it('question of exactly 253 chars → embed title is exactly 256 chars (no truncation)', () => {
    const question253 = 'Q'.repeat(253);
    const options = [makeOptionView('opt-a', 'Pizza', 0), makeOptionView('opt-b', 'Sushi', 1)];
    const view = new PollRpcModels.PollView({
      poll_id: POLL_ID,
      discord_channel_id: CHANNEL_ID,
      discord_message_id: Option.some(MESSAGE_ID),
      question: question253,
      status: 'open',
      multiple: false,
      allowed_role_id: Option.none(),
      deadline: Option.none(),
      total_votes: 0,
      options,
      my_option_ids: [],
    });

    const { embeds } = buildPollEmbed(view, locale);

    expect(embeds[0].title).toBeDefined();
    expect((embeds[0].title ?? '').length).toBe(256);
    expect(embeds[0].title).not.toMatch(/…$/);
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
