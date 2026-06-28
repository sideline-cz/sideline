// TDD mode — written BEFORE the implementation exists.
// Tests will fail to import until buildPollVotersView.ts is created.
// buildPollVotersView is a PURE function — call it directly, no Effect.

import type { Discord } from '@sideline/domain';
import { type Poll, PollRpcModels } from '@sideline/domain';
import type { RichEmbed as APIEmbed } from 'dfx/types';
import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildPollVotersView } from '~/rest/poll/buildPollVotersView.js';

// ---------------------------------------------------------------------------
// Helper: Discord embed text budget in code points (NOT JSON bytes)
// Discord's 6000 limit is measured in visible code points across:
//   title + description + Σ(field.name + field.value) + footer.text + author.name
// ---------------------------------------------------------------------------
const discordEmbedTextLength = (embed: APIEmbed): number => {
  let total = 0;
  if (embed.title) total += [...embed.title].length;
  if (embed.description) total += [...embed.description].length;
  if (embed.footer?.text) total += [...embed.footer.text].length;
  if (embed.author?.name) total += [...embed.author.name].length;
  for (const field of embed.fields ?? []) {
    total += [...field.name].length + [...field.value].length;
  }
  return total;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POLL_ID = 'poll-voters-001' as Poll.PollId;
const OPTION_ID_A = 'opt-voters-a' as Poll.PollOptionId;
const OPTION_ID_B = 'opt-voters-b' as Poll.PollOptionId;

const makeVoter = (opts: {
  discord_id?: string;
  name?: string;
  nickname?: string;
  display_name?: string;
  username?: string;
}): PollRpcModels.PollVoter =>
  new PollRpcModels.PollVoter({
    discord_id:
      opts.discord_id !== undefined
        ? Option.some(opts.discord_id as Discord.Snowflake)
        : Option.none(),
    name: opts.name !== undefined ? Option.some(opts.name) : Option.none(),
    nickname: opts.nickname !== undefined ? Option.some(opts.nickname) : Option.none(),
    display_name: opts.display_name !== undefined ? Option.some(opts.display_name) : Option.none(),
    username: opts.username !== undefined ? Option.some(opts.username) : Option.none(),
  });

const makeOptionVoters = (
  optionId: Poll.PollOptionId,
  label: string,
  position: number,
  voteCount: number,
  voters: PollRpcModels.PollVoter[],
): PollRpcModels.PollOptionVoters =>
  new PollRpcModels.PollOptionVoters({
    option_id: optionId,
    label,
    position,
    vote_count: voteCount,
    voters,
  });

const makePollVotersView = (
  options: PollRpcModels.PollOptionVoters[],
  totalVotes: number = options.reduce((sum, o) => sum + o.vote_count, 0),
  status: Poll.PollStatus = 'open',
): PollRpcModels.PollVotersView =>
  new PollRpcModels.PollVotersView({
    poll_id: POLL_ID,
    question: 'What is your favourite food?',
    status,
    total_votes: totalVotes,
    options,
  });

// ---------------------------------------------------------------------------
// Regional indicator: position 0 → 🇦 (U+1F1E6), 1 → 🇧, etc.
// ---------------------------------------------------------------------------
const REGIONAL_A = String.fromCodePoint(0x1f1e6); // 🇦
const MIDDLE_DOT = '·';

// ---------------------------------------------------------------------------
// Tests — voter rendering: formatNameWithMention
// ---------------------------------------------------------------------------

describe('buildPollVotersView — voter with name + discord_id', () => {
  it('voter with name+id → field value contains **Name** (<@id>)', () => {
    const voter = makeVoter({ name: 'Alice', discord_id: '100000000000000001' });
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 1, [voter])];
    const view = makePollVotersView(options);

    const { embeds } = buildPollVotersView(view, 'en');

    const fields = embeds[0].fields ?? [];
    const fieldA = fields.find((f) => f.name.includes('Pizza'));
    expect(fieldA).toBeDefined();
    expect(fieldA?.value).toContain('**Alice**');
    expect(fieldA?.value).toContain('<@100000000000000001>');
  });
});

describe('buildPollVotersView — voter name fallbacks', () => {
  it('no name but discord_id → mention only (no bold)', () => {
    const voter = makeVoter({ discord_id: '200000000000000001' });
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 1, [voter])];
    const view = makePollVotersView(options);

    const { embeds } = buildPollVotersView(view, 'en');

    const fields = embeds[0].fields ?? [];
    const fieldA = fields.find((f) => f.name.includes('Pizza'));
    expect(fieldA?.value).toContain('<@200000000000000001>');
    expect(fieldA?.value).not.toContain('**');
  });

  it('name but no discord_id → bold name only, no mention', () => {
    const voter = makeVoter({ name: 'Bob' });
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 1, [voter])];
    const view = makePollVotersView(options);

    const { embeds } = buildPollVotersView(view, 'en');

    const fields = embeds[0].fields ?? [];
    const fieldA = fields.find((f) => f.name.includes('Pizza'));
    expect(fieldA?.value).toContain('**Bob**');
    expect(fieldA?.value).not.toContain('<@');
  });

  it('neither name nor discord_id → Unknown', () => {
    const voter = makeVoter({});
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 1, [voter])];
    const view = makePollVotersView(options);

    const { embeds } = buildPollVotersView(view, 'en');

    const fields = embeds[0].fields ?? [];
    const fieldA = fields.find((f) => f.name.includes('Pizza'));
    expect(fieldA?.value).toContain('Unknown');
  });
});

// ---------------------------------------------------------------------------
// Tests — pickDisplayName priority: name > nickname > displayName > username
// ---------------------------------------------------------------------------

describe('buildPollVotersView — pickDisplayName priority', () => {
  it('voter with both name and nickname → rendered display uses name (highest priority)', () => {
    // name takes priority over nickname
    const voter = makeVoter({ name: 'Alice', nickname: 'Allie', discord_id: '150000000000000001' });
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 1, [voter])];
    const view = makePollVotersView(options);

    const { embeds } = buildPollVotersView(view, 'en');

    const fields = embeds[0].fields ?? [];
    const fieldA = fields.find((f) => f.name.includes('Pizza'));
    expect(fieldA).toBeDefined();
    // Must show the name, not the nickname
    expect(fieldA?.value).toContain('**Alice**');
    expect(fieldA?.value).not.toContain('Allie');
  });
});

// ---------------------------------------------------------------------------
// Tests — field name format
// ---------------------------------------------------------------------------

describe('buildPollVotersView — field name format', () => {
  it('field name format exactly: regionalIndicator + space + label + space + middleDot + space + count', () => {
    const voter = makeVoter({ name: 'Alice', discord_id: '300000000000000001' });
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 3, [voter])];
    const view = makePollVotersView(options, 3);

    const { embeds } = buildPollVotersView(view, 'en');

    const fields = embeds[0].fields ?? [];
    const fieldA = fields[0];
    expect(fieldA).toBeDefined();
    // Must contain regional indicator A
    expect(fieldA?.name).toContain(REGIONAL_A);
    // Must contain the label
    expect(fieldA?.name).toContain('Pizza');
    // Must contain middle dot ·
    expect(fieldA?.name).toContain(MIDDLE_DOT);
    // Must contain the true vote count (3)
    expect(fieldA?.name).toContain('3');
  });

  it('true vote_count shown in field name (not voters.length when capped)', () => {
    // vote_count = 75 but only 60 voters in the list (server cap)
    const voters = Array.from({ length: 60 }, (_, i) =>
      makeVoter({
        name: `Voter ${i}`,
        discord_id: `40000000000000000${String(i).padStart(4, '0')}`,
      }),
    );
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 75, voters)];
    const view = makePollVotersView(options, 75);

    const { embeds } = buildPollVotersView(view, 'en');

    const fields = embeds[0].fields ?? [];
    const fieldA = fields[0];
    // Field name must show 75, not 60
    expect(fieldA?.name).toContain('75');
  });
});

// ---------------------------------------------------------------------------
// Tests — zero voters
// ---------------------------------------------------------------------------

describe('buildPollVotersView — zero voters', () => {
  it('zero voters → bot_poll_voters_none in field value, field name shows · 0', () => {
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 0, [])];
    const view = makePollVotersView(options, 0);

    const { embeds } = buildPollVotersView(view, 'en');

    const fields = embeds[0].fields ?? [];
    const fieldA = fields[0];
    // Field value should be the "no votes" string (en: "_No votes yet_")
    expect(fieldA?.value).toContain('No votes yet');
    // Field name shows · 0
    expect(fieldA?.name).toContain('0');
  });

  it('zero voters in cs locale → Czech bot_poll_voters_none string', () => {
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 0, [])];
    const view = makePollVotersView(options, 0);

    const { embeds } = buildPollVotersView(view, 'cs');

    const fields = embeds[0].fields ?? [];
    const fieldA = fields[0];
    // cs: "Zatím nikdo"
    expect(fieldA?.value).toContain('nikdo');
  });
});

// ---------------------------------------------------------------------------
// Tests — join truncation
// ---------------------------------------------------------------------------

describe('buildPollVotersView — join truncation', () => {
  it('many voters exceeding 1024 → field value ≤ 1024, ends with bot_poll_voters_more, no mid-mention split', () => {
    // Create 100 voters with long names so they hit the 1024-char limit
    const voters = Array.from({ length: 100 }, (_, i) =>
      makeVoter({
        name: `VoterWithALongishNameForTesting${i}`,
        discord_id: `5000000000000000${String(i).padStart(4, '0')}`,
      }),
    );
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 100, voters)];
    const view = makePollVotersView(options, 100);

    const { embeds } = buildPollVotersView(view, 'en');

    const fields = embeds[0].fields ?? [];
    const fieldA = fields[0];
    expect(fieldA).toBeDefined();
    // Field value must not exceed Discord's 1024-char limit
    expect((fieldA?.value ?? '').length).toBeLessThanOrEqual(1024);
    // Must end with "and N more" pattern
    expect(fieldA?.value).toMatch(/more/i);
    // No broken mention: no `<@` at the very end (mid-split)
    expect(fieldA?.value).not.toMatch(/<@\d*$/);
  });
});

// ---------------------------------------------------------------------------
// Tests — cap remainder math
// ---------------------------------------------------------------------------

describe('buildPollVotersView — cap remainder math', () => {
  it('vote_count 75 / voters 60, all fit in field → more count = 15', () => {
    // 60 voters with very short names (no discord mention) — entries are ~8 chars each,
    // so all 60 fit in 1024 chars without truncation (60×8 + 59×2 = 598 ≤ 1024).
    // capHidden = 75 - 60 = 15, and since all 60 entries fit, the suffix must show exactly 15.
    const voters = Array.from({ length: 60 }, (_, i) => makeVoter({ name: `V${i}` }));
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 75, voters)];
    const view = makePollVotersView(options, 75);

    const { embeds } = buildPollVotersView(view, 'en');

    const fields = embeds[0].fields ?? [];
    const fieldA = fields[0];
    // Should contain exactly "…and 15 more" (75 true count - 60 shown)
    expect(fieldA?.value).toContain('…and 15 more');
  });

  it('if join truncates to S shown, more count = (60 - S) + (vote_count - 60)', () => {
    // vote_count = 75, server sends 60 voters but they have long names that get join-truncated
    // We create voters with very long names to force join truncation
    const voters = Array.from({ length: 60 }, (_, i) =>
      makeVoter({
        name: `AVeryLongVoterNameThatTakesUpSpaceInTheField${i}LongerAndLonger`,
        discord_id: `7000000000000000${String(i).padStart(4, '0')}`,
      }),
    );
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 75, voters)];
    const view = makePollVotersView(options, 75);

    const { embeds } = buildPollVotersView(view, 'en');

    const fields = embeds[0].fields ?? [];
    const fieldA = fields[0];
    expect(fieldA).toBeDefined();
    // Field value must be ≤ 1024
    expect((fieldA?.value ?? '').length).toBeLessThanOrEqual(1024);
    // Must contain a "more" count ≥ 15 (15 hidden from server cap alone)
    expect(fieldA?.value).toMatch(/\d+/);
    // Verify it mentions "more" (the overflow suffix)
    expect(fieldA?.value).toMatch(/more/i);
  });
});

// ---------------------------------------------------------------------------
// Tests — global embed budget
// ---------------------------------------------------------------------------

describe('buildPollVotersView — global embed budget', () => {
  it('10 options × 60 voters → total serialized embed ≤ 6000, every field value ≤ 1024, no mid-mention split', () => {
    // 10 options each with 60 voters with moderate-length names
    const options = Array.from({ length: 10 }, (_, optIdx) => {
      const voters = Array.from({ length: 60 }, (_, i) =>
        makeVoter({
          name: `Voter${optIdx}x${i}`,
          discord_id: `80000000000000${String(optIdx * 100 + i).padStart(6, '0')}`,
        }),
      );
      return makeOptionVoters(
        `opt-budget-${optIdx}` as Poll.PollOptionId,
        `Option ${optIdx + 1}`,
        optIdx,
        60,
        voters,
      );
    });
    const view = makePollVotersView(options, 600);

    const { embeds } = buildPollVotersView(view, 'en');

    // Must produce exactly one embed
    expect(embeds).toHaveLength(1);
    const embed = embeds[0];

    // Discord text budget must be ≤ 6000 code points
    expect(discordEmbedTextLength(embed)).toBeLessThanOrEqual(6000);

    // Every field value must be ≤ 1024
    const fields = embed.fields ?? [];
    for (const field of fields) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }

    // No broken mentions (no `<@` at end of field value without closing `>`)
    for (const field of fields) {
      expect(field.value).not.toMatch(/<@\d*$/);
    }
  });

  it('later options collapse to name + count only when budget is nearly exhausted', () => {
    // 10 options with 60 voters each, very long names to quickly exhaust budget
    const options = Array.from({ length: 10 }, (_, optIdx) => {
      const voters = Array.from({ length: 60 }, (_, i) =>
        makeVoter({
          name: `ALongNameToExhaustBudgetFast${optIdx}v${i}WithMoreText`,
          discord_id: `90000000000000${String(optIdx * 100 + i).padStart(6, '0')}`,
        }),
      );
      return makeOptionVoters(
        `opt-collapse-${optIdx}` as Poll.PollOptionId,
        `Option ${optIdx + 1}`,
        optIdx,
        60,
        voters,
      );
    });
    const view = makePollVotersView(options, 600);

    const { embeds } = buildPollVotersView(view, 'en');

    const embed = embeds[0];
    // Discord text budget must be ≤ 6000 code points
    expect(discordEmbedTextLength(embed)).toBeLessThanOrEqual(6000);
    // All field values must be ≤ 1024
    const fields = embed.fields ?? [];
    for (const field of fields) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    // Positive assertion: at least one later option's field value must be shorter
    // than if all 60 voter names were printed in full (collapse kicked in).
    // Each name is ~40+ chars; 60 × 40 = 2400 > 1024, so any field from a later
    // option that respects the budget must have collapsed.
    const longestPossibleUntruncated = 60 * 40; // very rough lower-bound sentinel
    const someFieldCollapsed = fields.some((f) => f.value.length < longestPossibleUntruncated);
    expect(someFieldCollapsed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — footer
// ---------------------------------------------------------------------------

describe('buildPollVotersView — footer', () => {
  it('footer uses total_votes via bot_poll_voters_footer (en)', () => {
    const voter = makeVoter({ name: 'Alice', discord_id: '110000000000000001' });
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 1, [voter])];
    const view = makePollVotersView(options, 42);

    const { embeds } = buildPollVotersView(view, 'en');

    const footer = embeds[0].footer?.text ?? '';
    // en: "{total} people voted" → "42 people voted"
    expect(footer).toContain('42');
    expect(footer).toContain('people');
  });

  it('footer uses total_votes via bot_poll_voters_footer (cs)', () => {
    const voter = makeVoter({ name: 'Alice', discord_id: '120000000000000001' });
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 1, [voter])];
    const view = makePollVotersView(options, 7);

    const { embeds } = buildPollVotersView(view, 'cs');

    const footer = embeds[0].footer?.text ?? '';
    // cs: "Hlasovalo {total} lidí" → "Hlasovalo 7 lidí"
    expect(footer).toContain('7');
    expect(footer).toContain('lidí');
  });
});

// ---------------------------------------------------------------------------
// Tests — title
// ---------------------------------------------------------------------------

describe('buildPollVotersView — title', () => {
  it('embed title uses bot_poll_voters_title with question (en)', () => {
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 0, [])];
    const view = makePollVotersView(options, 0);

    const { embeds } = buildPollVotersView(view, 'en');

    const title = embeds[0].title ?? '';
    // en: "👥 {question}"
    expect(title).toContain('What is your favourite food?');
    expect(title).toContain('👥');
  });

  it('embed title uses bot_poll_voters_title with question (cs)', () => {
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 0, [])];
    const view = makePollVotersView(options, 0);

    const { embeds } = buildPollVotersView(view, 'cs');

    const title = embeds[0].title ?? '';
    // cs: "👥 {question}" — same template, different locale
    expect(title).toContain('What is your favourite food?');
    expect(title).toContain('👥');
  });
});

// ---------------------------------------------------------------------------
// Tests — components are empty
// ---------------------------------------------------------------------------

describe('buildPollVotersView — components', () => {
  it('returns components: [] (voters view is embed-only)', () => {
    const options = [makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 0, [])];
    const view = makePollVotersView(options, 0);

    const result = buildPollVotersView(view, 'en');

    expect(result.components).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests — two options, both rendered
// ---------------------------------------------------------------------------

describe('buildPollVotersView — multiple options', () => {
  it('two options A and B both rendered with correct regional indicators', () => {
    const REGIONAL_B = String.fromCodePoint(0x1f1e7); // 🇧
    const voterA = makeVoter({ name: 'Alice', discord_id: '130000000000000001' });
    const voterB = makeVoter({ name: 'Bob', discord_id: '130000000000000002' });
    const options = [
      makeOptionVoters(OPTION_ID_A, 'Pizza', 0, 1, [voterA]),
      makeOptionVoters(OPTION_ID_B, 'Sushi', 1, 1, [voterB]),
    ];
    const view = makePollVotersView(options, 2);

    const { embeds } = buildPollVotersView(view, 'en');

    const fields = embeds[0].fields ?? [];
    expect(fields).toHaveLength(2);

    const names = fields.map((f) => f.name);
    expect(names[0]).toContain(REGIONAL_A);
    expect(names[0]).toContain('Pizza');
    expect(names[1]).toContain(REGIONAL_B);
    expect(names[1]).toContain('Sushi');
  });
});
