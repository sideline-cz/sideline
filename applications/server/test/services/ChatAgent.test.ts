// Spec for the `ChatAgent` tool-calling loop — plan
// `.work-plans/ai-app-interaction.md` §5 (loop) / §4 (reference-token
// mechanism) / §9 (history truncation) / §13.4 (this file's exact spec).
//
// This file imports `src/services/ChatAgent.ts` directly — `src/services/ai/refTokens.ts` is an
// internal dependency of `ChatAgent.ts`, not imported here.
//
// `LlmClient` is fully scripted/faked (a queue of canned `chatWithTools`
// results, FIFO, one per model call, recording every call's full input). Tool
// EXECUTION is real: this file drives the actual `readTools.ts` executors
// (via `ChatAgent`'s internal dispatch) against mock repositories, exactly
// like `aiTools.test.ts` does for the executors directly. That is the only
// way to exercise the real per-turn reference-token accumulation (§4), which
// lives in `ChatAgent`, not in the individual executors (each executor mints
// its OWN token per row via `toolTypes.ts#buildListResult` — see that file's
// comment: "`ChatAgent` (§4/§5) re-dedupes and re-mints across the whole turn
// (multiple tool calls) ON TOP OF this"). Consequently this file's dedup/cap
// assertions (13/16/17/18) treat "the same token embedded in the tool-result
// JSON and in `references`" as the observable contract, not an internal
// implementation detail: whatever `ChatAgent` ultimately writes into the
// `role:'tool'` message IS by definition what the model saw, so extracting a
// token from the RECORDED message content and asserting it also appears in
// `result.references` is a black-box assertion, not a white-box one.
//
// Contract decisions made here (flag deviations against these, not against a
// re-guess of the plan's own pseudocode):
//
//   - `ChatAgent` is a `ServiceMap.Service` (`ChatAgent.Default`, matching
//     `LlmClient`'s and `EventRosterProvisioningService`'s shape) whose
//     service shape is `{ respond: (ctx: ToolContext, history) =>
//     Effect.Effect<ChatAgentResult> }`. `ChatAgentResult` has exactly the
//     four fields from plan §5: `answer`, `generated`, `degradedReason`
//     (`Option.Option<AiChatApi.DegradedReason>`), `references`.
//   - `ChatAgent.Default`'s OWN construction needs `LlmClient` (it captures
//     `deps.llm` once). Tool dispatch resolves the five read-tool
//     repositories (`EventsRepository`, `GroupsRepository`,
//     `TrainingTypesRepository`, `RostersRepository`, `TeamMembersRepository`)
//     the SAME way `listEvents` etc. do in `aiTools.test.ts` — ambiently, via
//     each executor's own `XRepository.asEffect()`. This file's `buildLayer`
//     helper is deliberately defensive about which of the two plausible
//     wiring shapes (repos required by `ChatAgent.Default`'s own
//     construction vs. required only by `respond(...)`'s returned effect)
//     the developer picks: it chains `Layer.provide` for every dependency
//     onto `ChatAgent.Default` AND merges the same mock layers in flat
//     alongside it, which is correct under EITHER shape (`Layer.provide`
//     with an unneeded dependency is inert; the flat merge exposes the
//     services to the ambient environment `respond`'s own effect can read
//     from). See `EventRosterProvisioningService.test.ts` (chained
//     `Layer.provide`) vs. `AchievementEvaluator.test.ts` (flat
//     `Layer.mergeAll`) for the two precedents this reconciles.
//   - The five loop/budget constants from plan §5
//     (`MAX_TOOL_ITERATIONS = 5`, `MAX_TOOL_CALLS_PER_TURN = 8`,
//     `TOOL_RESULT_CHAR_BUDGET = 6000`, `MAX_REFERENCES = 20`,
//     `HISTORY_CHAR_BUDGET = 8000`) are pinned as LOCAL literals in this file
//     rather than imported from `ChatAgent.ts` — the plan's own pseudocode
//     declares them as unexported `const`s, and `currentDatetime.test.ts` /
//     `jsonSchema.test.ts` establish the precedent of a TDD spec pinning the
//     plan's stated numbers directly rather than requiring new exports. If
//     the developer changes a value, this file is the regression the plan
//     text promises.
//   - Per plan §5's dispatch table, the tool-result JSON on success is
//     `{"untrusted_data": [...], "truncated": <bool>}`; each row on the
//     `untrusted_data` array carries `ref` (the token) unless it is beyond
//     the per-turn `MAX_REFERENCES` cap, in which case the key is simply
//     absent (the row itself is NOT dropped — plan §4/§13.4 case 17 says
//     "carry no ref key", not "are omitted").
//   - AMBIGUITY FLAGGED (see the tester's final report for the long
//     version): plan §8's tool table lists `current_datetime`'s backing call
//     as "clock + `TeamSettingsRepository.findByTeamId`", and the task
//     prompt's "Required layers/mocks" list for this file includes
//     `ActivityTypes, TeamSettings`. Neither is exercised: the ALREADY-FIXED
//     `aiTools.test.ts` contract (and the real `src/services/ai/toolTypes.ts`
//     / `currentDatetime.ts` already on disk) has `ToolContext.teamTimezone`
//     resolved ONCE by the caller (the chat handler, step 7) and threaded in
//     — `current_datetime`'s executor and `computeCurrentDatetime(zone)` are
//     both pure with respect to `teamTimezone`, touching no repository at
//     all. None of the 6 registered tools (`current_datetime`, `list_events`,
//     `list_training_types`, `list_groups`, `list_members`, `list_rosters`)
//     touches `ActivityTypesRepository` or `TeamSettingsRepository`, so this
//     file does not mock them.
//   - AMBIGUITY FLAGGED, found while writing this file: `src/services/ai/
//     systemPrompt.ts` (already on disk, written concurrently with this file
//     — see the tester's final report) requires `teamName` to build the
//     system prompt, but `ToolContext` (`toolTypes.ts`) carries no such
//     field, and plan §5's `respond` signature is fixed at exactly
//     `(ctx, history)`. The only reading that keeps both of those true is
//     that `ChatAgent.respond` resolves `teamName` itself, ambiently, most
//     plausibly via `TeamsRepository.findById(ctx.teamId)` (the pattern used
//     everywhere else in this codebase — `group.ts`, `auth.ts`, `roster.ts`,
//     `team.ts`, `channel.ts`). This file provides a defensive
//     `TeamsRepository` mock (`makeTeamsLayer`) so it keeps compiling and
//     passing under that guess; if the real mechanism differs the mock is
//     simply unused (harmless), but the developer should confirm this is
//     really how `teamName` gets resolved, since nothing in the plan text
//     says so explicitly.

import { describe, expect, it } from '@effect/vitest';
import type { Event, GroupModel, Role, Team, TeamMember, TrainingType } from '@sideline/domain';
import { AiChatApi } from '@sideline/domain';
import { Cause, DateTime, Effect, Exit, Fiber, Layer, Option } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { EventsRepository, EventWithDetails } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { MembershipWithRole, TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import type { ToolContext } from '~/services/ai/toolTypes.js';
import { ChatAgent } from '~/services/ChatAgent.js';
import {
  type ChatWithToolsInput,
  type ChatWithToolsResult,
  type LlmChatMessage,
  LlmClient,
  LlmError,
  type LlmToolCall,
  STUB_UNAVAILABLE_MARKER,
} from '~/services/LlmClient.js';

// ---------------------------------------------------------------------------
// Pinned plan §5 constants — see header comment for why these are literals,
// not imports.
// ---------------------------------------------------------------------------

const MAX_TOOL_ITERATIONS = 5;
const MAX_TOOL_CALLS_PER_TURN = 8;
const TOOL_RESULT_CHAR_BUDGET = 6000;
const MAX_REFERENCES = 20;

// ---------------------------------------------------------------------------
// Test ids
// ---------------------------------------------------------------------------

const TEAM_A = '00000000-0000-0000-0000-00000000a001' as Team.TeamId;
const TEAM_B = '00000000-0000-0000-0000-00000000b001' as Team.TeamId;
const MEMBER_A1 = '00000000-0000-0000-0000-0000000a0001' as TeamMember.TeamMemberId;
const USER_1 = 'user-1' as never;

const EVENT_A1 = '00000000-0000-0000-0000-0000000ea001' as Event.EventId;
const EVENT_A2 = '00000000-0000-0000-0000-0000000ea002' as Event.EventId;
const EVENT_B1 = '00000000-0000-0000-0000-0000000eb001' as Event.EventId;
const eventIdN = (n: number): Event.EventId =>
  `00000000-0000-0000-0000-e${String(n).padStart(11, '0')}` as Event.EventId;

const TT_A1 = '00000000-0000-0000-0000-0000000ta001' as TrainingType.TrainingTypeId;
const TT_A2 = '00000000-0000-0000-0000-0000000ta002' as TrainingType.TrainingTypeId;
const TT_A3 = '00000000-0000-0000-0000-0000000ta003' as TrainingType.TrainingTypeId;

const ADMIN_PERMISSIONS: ReadonlyArray<Role.Permission> = [
  'member:view',
  'roster:view',
  'group:manage',
  'team:manage',
];

// ---------------------------------------------------------------------------
// Fixture builders (event / training-type rows — same shape as
// `aiTools.test.ts`'s builders, trimmed to what this file needs)
// ---------------------------------------------------------------------------

interface EventOverrides {
  readonly id?: Event.EventId;
  readonly team_id?: Team.TeamId;
  readonly title?: string;
}

const buildEvent = (overrides: EventOverrides = {}): EventWithDetails =>
  new EventWithDetails({
    id: overrides.id ?? EVENT_A1,
    team_id: overrides.team_id ?? TEAM_A,
    training_type_id: Option.none(),
    event_type: 'training',
    title: overrides.title ?? 'Practice',
    description: Option.none(),
    image_url: Option.none(),
    start_at: DateTime.makeUnsafe(Date.parse('2026-06-01T10:00:00.000Z')),
    end_at: Option.none(),
    location: Option.none(),
    location_url: Option.none(),
    status: 'active',
    created_by: MEMBER_A1,
    training_type_name: Option.none(),
    created_by_name: Option.none(),
    series_id: Option.none(),
    series_modified: false,
    owner_group_id: Option.none(),
    owner_group_name: Option.none(),
    member_group_id: Option.none(),
    member_group_name: Option.none(),
    reminder_sent_at: Option.none(),
    claimed_by: Option.none(),
    claimer_name: Option.none(),
    claim_discord_channel_id: Option.none(),
    claim_discord_message_id: Option.none(),
    all_day: false,
    personal_messages_dirty_at: Option.none(),
    start_date: '2026-06-01',
    end_date: '2026-06-01',
    timezone: 'Europe/Prague',
  });

interface TrainingTypeRow {
  readonly id: TrainingType.TrainingTypeId;
  readonly team_id: Team.TeamId;
  readonly name: string;
  readonly owner_group_name: Option.Option<string>;
  readonly member_group_name: Option.Option<string>;
}

const buildTrainingTypeRow = (overrides: Partial<TrainingTypeRow> = {}): TrainingTypeRow => ({
  id: overrides.id ?? TT_A1,
  team_id: overrides.team_id ?? TEAM_A,
  name: overrides.name ?? 'Fitness',
  owner_group_name: overrides.owner_group_name ?? Option.none(),
  member_group_name: overrides.member_group_name ?? Option.none(),
});

// ---------------------------------------------------------------------------
// Mock repository layers
// ---------------------------------------------------------------------------

const makeEventsLayer = (rows: ReadonlyArray<EventWithDetails>) =>
  Layer.succeed(EventsRepository, {
    findEventsByTeamId: (teamId: Team.TeamId) =>
      Effect.succeed(rows.filter((r) => r.team_id === teamId)),
    findEventByIdWithDetails: (id: Event.EventId) =>
      Effect.succeed(Option.fromNullishOr(rows.find((r) => r.id === id))),
  } as never);

const makeGroupsLayer = () =>
  Layer.succeed(GroupsRepository, {
    findGroupsByTeamId: () => Effect.succeed([]),
  } as never);

const makeTrainingTypesLayer = (rows: ReadonlyArray<TrainingTypeRow>) =>
  Layer.succeed(TrainingTypesRepository, {
    findTrainingTypesByTeamId: (teamId: Team.TeamId) =>
      Effect.succeed(rows.filter((r) => r.team_id === teamId)),
  } as never);

const makeRostersLayer = () =>
  Layer.succeed(RostersRepository, {
    findByTeamId: () => Effect.succeed([]),
  } as never);

const makeMembersLayer = () =>
  Layer.succeed(TeamMembersRepository, {
    findRosterByTeam: () => Effect.succeed([]),
  } as never);

/**
 * Defensive mock, not required by any of the 6 read tools. `systemPrompt.ts`
 * (already on disk — see this file's header comment) needs a `teamName`
 * that `ToolContext` does not carry, so `ChatAgent.respond` almost certainly
 * resolves it via `TeamsRepository.findById(ctx.teamId)` ambiently. Provided
 * here so the whole file keeps compiling and passing regardless of whether
 * that guess is exactly right — if `ChatAgent.respond` needs a DIFFERENT
 * repository/mechanism for `teamName`, this layer is simply unused and
 * harmless (see `Layer.provide` being a no-op for an unneeded dependency).
 */
const makeTeamsLayer = () =>
  Layer.succeed(TeamsRepository, {
    findById: () => Effect.succeed(Option.some({ name: 'Testing FC' } as never)),
  } as never);

// ---------------------------------------------------------------------------
// ToolContext builder
// ---------------------------------------------------------------------------

const buildMembership = (
  overrides: Partial<{ permissions: ReadonlyArray<Role.Permission> }> = {},
): MembershipWithRole =>
  new MembershipWithRole({
    id: MEMBER_A1,
    team_id: TEAM_A,
    user_id: USER_1,
    active: true,
    role_names: ['Admin'],
    permissions: overrides.permissions ?? ADMIN_PERMISSIONS,
    is_profile_complete: true,
    require_complete_profile: Option.none(),
  });

const buildCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  teamId: TEAM_A,
  membership: buildMembership(),
  teamTimezone: 'Europe/Prague',
  canSeeGroup: (_groupId: Option.Option<GroupModel.GroupId>) => Effect.succeed(true),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Scripted LlmClient fake — a FIFO queue of canned `chatWithTools` results,
// recording every call's full input (so the loop's prompt construction can
// be asserted, per the task brief). Some scenarios (13/17/18) need the
// SCRIPTED MODEL to react to a server-minted token it could not have known
// in advance (tokens are minted at runtime, inside the real tool
// executors) — `dynamicText` lets a script step build its answer from the
// PREVIOUS round's recorded `messages`.
// ---------------------------------------------------------------------------

type ScriptEntry =
  | { readonly kind: 'result'; readonly value: ChatWithToolsResult }
  | { readonly kind: 'fail'; readonly error: LlmError }
  | { readonly kind: 'die'; readonly error: unknown }
  | { readonly kind: 'interrupt' }
  | {
      readonly kind: 'dynamic';
      readonly build: (input: ChatWithToolsInput) => ChatWithToolsResult;
    };

const textResult = (content: string): ScriptEntry => ({
  kind: 'result',
  value: { content: Option.some(content), toolCalls: [], finishReason: 'stop' },
});

const optionResult = (content: Option.Option<string>): ScriptEntry => ({
  kind: 'result',
  value: { content, toolCalls: [], finishReason: 'stop' },
});

const toolCallResult = (
  content: Option.Option<string>,
  calls: ReadonlyArray<LlmToolCall>,
): ScriptEntry => ({
  kind: 'result',
  value: { content, toolCalls: calls, finishReason: 'tool_calls' },
});

const dynamicText = (build: (input: ChatWithToolsInput) => string): ScriptEntry => ({
  kind: 'dynamic',
  build: (input) => ({ content: Option.some(build(input)), toolCalls: [], finishReason: 'stop' }),
});

const failWith = (error: LlmError): ScriptEntry => ({ kind: 'fail', error });
const dieWith = (error: unknown): ScriptEntry => ({ kind: 'die', error });
const interruptEntry: ScriptEntry = { kind: 'interrupt' };

interface ScriptedLlm {
  readonly layer: Layer.Layer<LlmClient>;
  readonly calls: Array<ChatWithToolsInput>;
}

const makeScriptedLlm = (script: ReadonlyArray<ScriptEntry>, configured = true): ScriptedLlm => {
  const calls: Array<ChatWithToolsInput> = [];
  const layer = Layer.succeed(LlmClient, {
    _tag: 'api/LlmClient' as const,
    summarizeEmail: () => Effect.die(new Error('scripted LlmClient: summarizeEmail unused')),
    generateRatingInsight: () =>
      Effect.die(new Error('scripted LlmClient: generateRatingInsight unused')),
    estimateRatingFromDescription: () =>
      Effect.die(new Error('scripted LlmClient: estimateRatingFromDescription unused')),
    summarizeChannel: () => Effect.die(new Error('scripted LlmClient: summarizeChannel unused')),
    configured,
    chatWithTools: (input: ChatWithToolsInput) => {
      const entry = script[calls.length];
      calls.push(input);
      if (entry === undefined) {
        return Effect.die(
          new Error(
            `scripted LlmClient: ran out of canned responses at call ${String(calls.length)}`,
          ),
        );
      }
      switch (entry.kind) {
        case 'result':
          return Effect.succeed(entry.value);
        case 'dynamic':
          return Effect.succeed(entry.build(input));
        case 'fail':
          return Effect.fail(entry.error);
        case 'die':
          return Effect.die(entry.error);
        case 'interrupt':
          return Effect.interrupt;
      }
    },
  } as never);
  return { layer, calls };
};

// ---------------------------------------------------------------------------
// Layer / run helpers
// ---------------------------------------------------------------------------

interface Fixtures {
  readonly events?: ReadonlyArray<EventWithDetails>;
  readonly trainingTypes?: ReadonlyArray<TrainingTypeRow>;
}

const buildLayer = (llmLayer: Layer.Layer<LlmClient>, fixtures: Fixtures = {}) => {
  const eventsLayer = makeEventsLayer(fixtures.events ?? []);
  const groupsLayer = makeGroupsLayer();
  const trainingTypesLayer = makeTrainingTypesLayer(fixtures.trainingTypes ?? []);
  const rostersLayer = makeRostersLayer();
  const membersLayer = makeMembersLayer();
  const teamsLayer = makeTeamsLayer();

  return Layer.mergeAll(
    ChatAgent.Default.pipe(
      Layer.provide(llmLayer),
      Layer.provide(eventsLayer),
      Layer.provide(groupsLayer),
      Layer.provide(trainingTypesLayer),
      Layer.provide(rostersLayer),
      Layer.provide(membersLayer),
      Layer.provide(teamsLayer),
    ),
    eventsLayer,
    groupsLayer,
    trainingTypesLayer,
    rostersLayer,
    membersLayer,
    teamsLayer,
  );
};

const runRespond = (
  ctx: ToolContext,
  history: ReadonlyArray<AiChatApi.ChatMessage>,
  llmLayer: Layer.Layer<LlmClient>,
  fixtures: Fixtures = {},
) =>
  ChatAgent.asEffect().pipe(
    Effect.flatMap((agent) => agent.respond(ctx, history)),
    Effect.result,
    Effect.provide(buildLayer(llmLayer, fixtures)),
  );

const userMsg = (content: string): AiChatApi.ChatMessage =>
  new AiChatApi.ChatMessage({ role: 'user', content });
const assistantMsg = (content: string): AiChatApi.ChatMessage =>
  new AiChatApi.ChatMessage({ role: 'assistant', content });

// ---------------------------------------------------------------------------
// Message-inspection helpers
// ---------------------------------------------------------------------------

type ToolMessage = Extract<LlmChatMessage, { readonly role: 'tool' }>;
type AssistantMessage = Extract<LlmChatMessage, { readonly role: 'assistant' }>;

const toolMessages = (messages: ReadonlyArray<LlmChatMessage>): ReadonlyArray<ToolMessage> =>
  messages.filter((m): m is ToolMessage => m.role === 'tool');

const assistantMessages = (
  messages: ReadonlyArray<LlmChatMessage>,
): ReadonlyArray<AssistantMessage> =>
  messages.filter((m): m is AssistantMessage => m.role === 'assistant');

interface UntrustedRow {
  readonly ref?: string;
  readonly [key: string]: unknown;
}
interface ToolResultJson {
  readonly untrusted_data?: ReadonlyArray<UntrustedRow>;
  readonly truncated?: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

const parseToolContent = (msg: ToolMessage): ToolResultJson =>
  JSON.parse(msg.content) as ToolResultJson;

/** Refs minted by the MOST RECENT tool round reflected in `messages`. */
const lastToolResultRefs = (messages: ReadonlyArray<LlmChatMessage>): ReadonlyArray<string> => {
  const last = toolMessages(messages).at(-1);
  if (!last) return [];
  return (parseToolContent(last).untrusted_data ?? [])
    .map((r) => r.ref)
    .filter((r): r is string => typeof r === 'string');
};

/** Every ref minted across EVERY tool round reflected in `messages`. */
const allToolResultRefs = (messages: ReadonlyArray<LlmChatMessage>): ReadonlyArray<string> =>
  toolMessages(messages).flatMap((m) =>
    (parseToolContent(m).untrusted_data ?? [])
      .map((r) => r.ref)
      .filter((r): r is string => typeof r === 'string'),
  );

// ---------------------------------------------------------------------------
// 1. Plain answer, no tools
// ---------------------------------------------------------------------------

describe('ChatAgent.respond — plain answer', () => {
  it.effect('one text result → answer matches, references empty, exactly 1 model call', () =>
    Effect.gen(function* () {
      const scripted = makeScriptedLlm([textResult('Hello there!')]);
      const outcome = yield* runRespond(buildCtx(), [userMsg('Hi')], scripted.layer);

      expect(outcome._tag).toBe('Success');
      if (outcome._tag !== 'Success') return;

      expect(outcome.success.answer).toBe('Hello there!');
      expect(outcome.success.generated).toBe(true);
      expect(Option.isNone(outcome.success.degradedReason)).toBe(true);
      expect(outcome.success.references).toEqual([]);
      expect(scripted.calls).toHaveLength(1);
    }),
  );
});

// ---------------------------------------------------------------------------
// 2 & 3. Multi-round tool use
// ---------------------------------------------------------------------------

describe('ChatAgent.respond — multi-round tool use', () => {
  it.effect(
    'one tool round → 2 model calls; the 2nd call carries the assistant tool-call entry verbatim plus a matching role:tool entry',
    () =>
      Effect.gen(function* () {
        const events = [buildEvent({ id: EVENT_A1, title: 'Practice A' })];
        const call: LlmToolCall = { id: 'call-1', name: 'list_events', argumentsJson: '{}' };
        const scripted = makeScriptedLlm([
          toolCallResult(Option.some('Let me check.'), [call]),
          textResult('You have one event.'),
        ]);

        const outcome = yield* runRespond(
          buildCtx(),
          [userMsg('What events are there?')],
          scripted.layer,
          { events },
        );

        expect(outcome._tag).toBe('Success');
        if (outcome._tag !== 'Success') return;
        expect(outcome.success.answer).toBe('You have one event.');
        expect(scripted.calls).toHaveLength(2);

        const round2 = scripted.calls[1]?.messages ?? [];
        const assistant = assistantMessages(round2).find((m) =>
          m.toolCalls.some((c) => c.id === 'call-1'),
        );
        expect(assistant).toBeDefined();
        expect(assistant?.content).toBe('Let me check.');
        expect(assistant?.toolCalls).toEqual([call]);

        const toolMsg = toolMessages(round2).find((m) => m.toolCallId === 'call-1');
        expect(toolMsg).toBeDefined();
        if (toolMsg) {
          const parsed = parseToolContent(toolMsg);
          expect(parsed.untrusted_data).toBeDefined();
        }
      }),
  );

  it.effect('two sequential tool rounds → 3 model calls, both tool results present in order', () =>
    Effect.gen(function* () {
      const events = [buildEvent({ id: EVENT_A1, title: 'Practice A' })];
      const trainingTypes = [buildTrainingTypeRow({ id: TT_A1, name: 'Fitness' })];
      const call1: LlmToolCall = { id: 'e-call', name: 'list_events', argumentsJson: '{}' };
      const call2: LlmToolCall = { id: 't-call', name: 'list_training_types', argumentsJson: '{}' };
      const scripted = makeScriptedLlm([
        toolCallResult(Option.none(), [call1]),
        toolCallResult(Option.none(), [call2]),
        textResult('Done.'),
      ]);

      const outcome = yield* runRespond(
        buildCtx(),
        [userMsg('Tell me about the team')],
        scripted.layer,
        {
          events,
          trainingTypes,
        },
      );

      expect(outcome._tag).toBe('Success');
      if (outcome._tag !== 'Success') return;
      expect(scripted.calls).toHaveLength(3);

      const round3 = scripted.calls[2]?.messages ?? [];
      const toolMsgs = toolMessages(round3);
      expect(toolMsgs).toHaveLength(2);
      expect(toolMsgs[0]?.toolCallId).toBe('e-call');
      expect(toolMsgs[1]?.toolCallId).toBe('t-call');
    }),
  );
});

// ---------------------------------------------------------------------------
// 4 / 4b. Iteration cap and empty answer
// ---------------------------------------------------------------------------

describe('ChatAgent.respond — degradation: iteration cap and empty answer', () => {
  it.effect(
    'a model that always calls a tool produces exactly MAX_TOOL_ITERATIONS calls, degrades, keeps partial references, never throws',
    () =>
      Effect.gen(function* () {
        const events = [buildEvent({ id: EVENT_A1, title: 'Loop Event' })];
        const call: LlmToolCall = { id: 'loop', name: 'list_events', argumentsJson: '{}' };
        // more entries than the cap — proves the cap stops the loop, not the script running out
        const scripted = makeScriptedLlm(
          Array.from({ length: MAX_TOOL_ITERATIONS + 3 }, () =>
            toolCallResult(Option.none(), [call]),
          ),
        );

        const outcome = yield* runRespond(buildCtx(), [userMsg('Loop please')], scripted.layer, {
          events,
        });

        expect(outcome._tag).toBe('Success');
        if (outcome._tag !== 'Success') return;

        expect(outcome.success.generated).toBe(false);
        expect(Option.isSome(outcome.success.degradedReason)).toBe(true);
        if (Option.isSome(outcome.success.degradedReason)) {
          expect(outcome.success.degradedReason.value).toBe('too_many_steps');
        }
        expect(outcome.success.answer).toBe('');
        expect(outcome.success.references.length).toBeGreaterThan(0);
        expect(scripted.calls).toHaveLength(MAX_TOOL_ITERATIONS);
      }),
  );

  it.effect('final model turn with no content (None) degrades to empty_answer', () =>
    Effect.gen(function* () {
      const scripted = makeScriptedLlm([optionResult(Option.none())]);
      const outcome = yield* runRespond(buildCtx(), [userMsg('Hi')], scripted.layer);

      expect(outcome._tag).toBe('Success');
      if (outcome._tag !== 'Success') return;
      expect(outcome.success.generated).toBe(false);
      expect(Option.isSome(outcome.success.degradedReason)).toBe(true);
      if (Option.isSome(outcome.success.degradedReason)) {
        expect(outcome.success.degradedReason.value).toBe('empty_answer');
      }
      expect(outcome.success.answer).toBe('');
    }),
  );

  it.effect('final model turn with whitespace-only content degrades to empty_answer', () =>
    Effect.gen(function* () {
      const scripted = makeScriptedLlm([optionResult(Option.some('   \n  '))]);
      const outcome = yield* runRespond(buildCtx(), [userMsg('Hi')], scripted.layer);

      expect(outcome._tag).toBe('Success');
      if (outcome._tag !== 'Success') return;
      expect(outcome.success.generated).toBe(false);
      expect(Option.isSome(outcome.success.degradedReason)).toBe(true);
      if (Option.isSome(outcome.success.degradedReason)) {
        expect(outcome.success.degradedReason.value).toBe('empty_answer');
      }
      expect(outcome.success.answer).toBe('');
    }),
  );
});

// ---------------------------------------------------------------------------
// 5. Tool-call budget
// ---------------------------------------------------------------------------

describe('ChatAgent.respond — per-turn tool-call budget', () => {
  it.effect(
    'a response with MAX_TOOL_CALLS_PER_TURN + 2 calls executes only the budget, the extras get tool_budget_exceeded',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(new Date('2026-01-15T12:00:00.000Z').getTime());
        const total = MAX_TOOL_CALLS_PER_TURN + 2;
        const calls: ReadonlyArray<LlmToolCall> = Array.from({ length: total }, (_, i) => ({
          id: `c${String(i)}`,
          name: 'current_datetime',
          argumentsJson: '{}',
        }));
        const scripted = makeScriptedLlm([toolCallResult(Option.none(), calls), textResult('Ok.')]);

        const outcome = yield* runRespond(buildCtx(), [userMsg('spam tools')], scripted.layer);

        expect(outcome._tag).toBe('Success');
        if (outcome._tag !== 'Success') return;

        const round2 = scripted.calls[1]?.messages ?? [];
        const toolMsgs = toolMessages(round2);
        expect(toolMsgs).toHaveLength(total);
        for (let i = 0; i < total; i += 1) {
          expect(toolMsgs[i]?.toolCallId).toBe(`c${String(i)}`);
        }
        for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN; i += 1) {
          const parsed = parseToolContent(toolMsgs[i] as ToolMessage);
          expect(parsed.error).not.toBe('tool_budget_exceeded');
        }
        for (let i = MAX_TOOL_CALLS_PER_TURN; i < total; i += 1) {
          const parsed = parseToolContent(toolMsgs[i] as ToolMessage);
          expect(parsed).toEqual({ error: 'tool_budget_exceeded' });
        }
      }),
  );
});

// ---------------------------------------------------------------------------
// 6-8. Per-call dispatch never fails
// ---------------------------------------------------------------------------

describe('ChatAgent.respond — dispatch never fails, loop continues', () => {
  it.effect('unknown tool name → {"error":"unknown_tool"}, loop continues', () =>
    Effect.gen(function* () {
      const call: LlmToolCall = { id: 'x1', name: 'delete_everything', argumentsJson: '{}' };
      const scripted = makeScriptedLlm([toolCallResult(Option.none(), [call]), textResult('OK.')]);

      const outcome = yield* runRespond(buildCtx(), [userMsg('do something bad')], scripted.layer);

      expect(outcome._tag).toBe('Success');
      if (outcome._tag !== 'Success') return;
      expect(outcome.success.generated).toBe(true);
      expect(outcome.success.answer).toBe('OK.');

      const toolMsg = toolMessages(scripted.calls[1]?.messages ?? [])[0];
      expect(toolMsg).toBeDefined();
      if (toolMsg) expect(JSON.parse(toolMsg.content)).toEqual({ error: 'unknown_tool' });
    }),
  );

  it.effect('unparseable arguments JSON → {"error":"invalid_arguments"} (no detail key)', () =>
    Effect.gen(function* () {
      const call: LlmToolCall = { id: 'y1', name: 'list_events', argumentsJson: '{oops' };
      const scripted = makeScriptedLlm([toolCallResult(Option.none(), [call]), textResult('OK.')]);

      const outcome = yield* runRespond(buildCtx(), [userMsg('list events')], scripted.layer);

      expect(outcome._tag).toBe('Success');
      if (outcome._tag !== 'Success') return;

      const toolMsg = toolMessages(scripted.calls[1]?.messages ?? [])[0];
      expect(toolMsg).toBeDefined();
      if (toolMsg) {
        const parsed = JSON.parse(toolMsg.content) as Record<string, unknown>;
        expect(parsed).toEqual({ error: 'invalid_arguments' });
      }
    }),
  );

  it.effect('schema-invalid arguments → {"error":"invalid_arguments","detail":...}', () =>
    Effect.gen(function* () {
      const call: LlmToolCall = {
        id: 'z1',
        name: 'list_events',
        argumentsJson: JSON.stringify({ limit: 'many' }),
      };
      const scripted = makeScriptedLlm([toolCallResult(Option.none(), [call]), textResult('OK.')]);

      const outcome = yield* runRespond(buildCtx(), [userMsg('list events')], scripted.layer);

      expect(outcome._tag).toBe('Success');
      if (outcome._tag !== 'Success') return;

      const toolMsg = toolMessages(scripted.calls[1]?.messages ?? [])[0];
      expect(toolMsg).toBeDefined();
      if (toolMsg) {
        const parsed = JSON.parse(toolMsg.content) as Record<string, unknown>;
        expect(parsed.error).toBe('invalid_arguments');
        expect(typeof parsed.detail).toBe('string');
        expect((parsed.detail as string).length).toBeGreaterThan(0);
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// 9 / 9b. LlmError and defects — degradation is total, E = never is earned
// ---------------------------------------------------------------------------

describe('ChatAgent.respond — E = never is earned, not asserted', () => {
  it.effect('LlmError degrades to provider_error; the Effect still SUCCEEDS', () =>
    Effect.gen(function* () {
      const scripted = makeScriptedLlm([failWith(new LlmError({ message: 'boom' }))]);
      const outcome = yield* runRespond(buildCtx(), [userMsg('Hi')], scripted.layer);

      expect(outcome._tag).toBe('Success');
      if (outcome._tag !== 'Success') return;
      expect(outcome.success.generated).toBe(false);
      expect(Option.isSome(outcome.success.degradedReason)).toBe(true);
      if (Option.isSome(outcome.success.degradedReason)) {
        expect(outcome.success.degradedReason.value).toBe('provider_error');
      }
      expect(outcome.success.answer).toBe('');
      expect(outcome.success.references).toEqual([]);
      // the sentinel bug this contract exists to prevent: never a raw i18n key
      expect(outcome.success.answer).not.toContain('assistant_');
    }),
  );

  it.effect(
    'a defect (plain Error die, e.g. a JSON.stringify-throws / malformed-projection class) also degrades — Effect.catchTag alone would NOT catch this',
    () =>
      Effect.gen(function* () {
        const scripted = makeScriptedLlm([
          dieWith(new Error('malformed projection, not an LlmError')),
        ]);
        const outcome = yield* runRespond(buildCtx(), [userMsg('Hi')], scripted.layer);

        expect(outcome._tag).toBe('Success');
        if (outcome._tag !== 'Success') return;
        expect(outcome.success.generated).toBe(false);
        expect(Option.isSome(outcome.success.degradedReason)).toBe(true);
        if (Option.isSome(outcome.success.degradedReason)) {
          expect(outcome.success.degradedReason.value).toBe('provider_error');
        }
        expect(outcome.success.answer).toBe('');
      }),
  );

  it.effect(
    'a defect thrown synchronously by a tool executor also degrades, not just LLM-side defects',
    () =>
      Effect.gen(function* () {
        // A tool call naming a real, permitted tool, but with a repository mock
        // whose method throws SYNCHRONOUSLY (not `Effect.die`, an actual thrown
        // JS exception) inside the Effect body — the class of bug the plan's
        // `Effect.catchCause` wrapper exists to contain, regardless of WHERE in
        // the pipeline the defect originates.
        const throwingEventsLayer = Layer.succeed(EventsRepository, {
          findEventsByTeamId: () => {
            throw new Error('synchronous defect inside a repository call');
          },
          findEventByIdWithDetails: () => Effect.succeed(Option.none()),
        } as never);

        const call: LlmToolCall = { id: 'boom', name: 'list_events', argumentsJson: '{}' };
        const scripted = makeScriptedLlm([
          toolCallResult(Option.none(), [call]),
          textResult('unreachable'),
        ]);

        const layer = Layer.mergeAll(
          ChatAgent.Default.pipe(
            Layer.provide(scripted.layer),
            Layer.provide(throwingEventsLayer),
            Layer.provide(makeGroupsLayer()),
            Layer.provide(makeTrainingTypesLayer([])),
            Layer.provide(makeRostersLayer()),
            Layer.provide(makeMembersLayer()),
            Layer.provide(makeTeamsLayer()),
          ),
          throwingEventsLayer,
          makeGroupsLayer(),
          makeTrainingTypesLayer([]),
          makeRostersLayer(),
          makeMembersLayer(),
          makeTeamsLayer(),
        );

        const outcome = yield* ChatAgent.asEffect().pipe(
          Effect.flatMap((agent) => agent.respond(buildCtx(), [userMsg('list events')])),
          Effect.result,
          Effect.provide(layer),
        );

        expect(outcome._tag).toBe('Success');
        if (outcome._tag !== 'Success') return;
        expect(outcome.success.generated).toBe(false);
        expect(Option.isSome(outcome.success.degradedReason)).toBe(true);
        if (Option.isSome(outcome.success.degradedReason)) {
          expect(outcome.success.degradedReason.value).toBe('provider_error');
        }
        expect(outcome.success.answer).toBe('');
      }),
  );

  it.effect(
    'an interrupted fiber (e.g. a client disconnect mid-turn) is RE-RAISED, not swallowed into a provider_error success (CONCERN 8)',
    () =>
      Effect.gen(function* () {
        // Run `respond` in its OWN forked fiber and `Fiber.join` it (rather than `Effect.result`
        // in the test's own fiber, as every other test here does): `Effect.interrupt` is a
        // SELF-interrupt of whatever fiber runs it, so scripting the LLM mock to call it
        // directly would otherwise interrupt the test's own fiber before any assertion could
        // run. Joining a forked child fiber and wrapping THAT in `Effect.exit` is the standard
        // way to observe a fiber's own interruption as an ordinary value.
        const scripted = makeScriptedLlm([interruptEntry]);
        const effect = ChatAgent.asEffect().pipe(
          Effect.flatMap((agent) => agent.respond(buildCtx(), [userMsg('Hi')])),
          Effect.provide(buildLayer(scripted.layer)),
        );
        const fiber = yield* effect.pipe(Effect.forkChild);
        const exit = yield* Effect.exit(Fiber.join(fiber));

        // NOT an `Exit.Success` carrying `provider_error` — `Cause.hasInterruptsOnly` must have
        // re-raised the cause instead of the safety net degrading it, same as any other caught
        // effect would surface an interrupt.
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        }
      }),
  );
});

// ---------------------------------------------------------------------------
// 10. Stub / not-configured
// ---------------------------------------------------------------------------

describe('ChatAgent.respond — stub LlmClient (not configured)', () => {
  it.effect('STUB_UNAVAILABLE_MARKER degrades to not_configured with zero tool executions', () =>
    Effect.gen(function* () {
      const scripted = makeScriptedLlm([textResult(STUB_UNAVAILABLE_MARKER)], false);
      const outcome = yield* runRespond(buildCtx(), [userMsg('Hi')], scripted.layer);

      expect(outcome._tag).toBe('Success');
      if (outcome._tag !== 'Success') return;
      expect(outcome.success.generated).toBe(false);
      expect(Option.isSome(outcome.success.degradedReason)).toBe(true);
      if (Option.isSome(outcome.success.degradedReason)) {
        expect(outcome.success.degradedReason.value).toBe('not_configured');
      }
      expect(outcome.success.answer).toBe('');
      expect(outcome.success.references).toEqual([]);
    }),
  );
});

// ---------------------------------------------------------------------------
// 11. Result truncation
// ---------------------------------------------------------------------------

describe('ChatAgent.respond — per-tool-result char budget', () => {
  it.effect(
    'a tool whose backing repository returns 5000 rows serializes to <= TOOL_RESULT_CHAR_BUDGET, carrying truncated:true',
    () =>
      Effect.gen(function* () {
        const longTitle = 'X'.repeat(400);
        const events = Array.from({ length: 5000 }, (_, i) =>
          buildEvent({ id: eventIdN(i), title: `${longTitle}-${String(i)}` }),
        );
        // No `limit` — MAJOR finding 1: an earlier version of this test passed `{"limit":50}`,
        // which sliced the 5000 rows down to 50 in `readTools.ts` BEFORE `truncateForBudget`
        // ever ran, so the budget path this test claims to exercise never actually fired. The
        // whole point of the 5000-row fixture is to drive `truncateForBudget`'s binary search
        // over the full, unbounded row set.
        const call: LlmToolCall = {
          id: 'huge',
          name: 'list_events',
          argumentsJson: JSON.stringify({}),
        };
        const scripted = makeScriptedLlm([
          toolCallResult(Option.none(), [call]),
          textResult('Noted.'),
        ]);

        const outcome = yield* runRespond(
          buildCtx(),
          [userMsg('list all events')],
          scripted.layer,
          {
            events,
          },
        );

        expect(outcome._tag).toBe('Success');
        if (outcome._tag !== 'Success') return;

        const toolMsg = toolMessages(scripted.calls[1]?.messages ?? [])[0];
        expect(toolMsg).toBeDefined();
        if (toolMsg) {
          expect(toolMsg.content.length).toBeLessThanOrEqual(TOOL_RESULT_CHAR_BUDGET);
          const parsed = parseToolContent(toolMsg);
          expect(parsed.truncated).toBe(true);
        }
      }),
  );
});

// ---------------------------------------------------------------------------
// 11b. Answer length clamp (BLOCKER — a long answer used to permanently break the
// conversation: `ChatMessage.content` is capped at 2000 chars for BOTH roles
// (`packages/domain/src/api/AiChatApi.ts`), the client replays `answer` verbatim as history on
// the next turn, and `finish` applied no clamp — so any turn whose answer exceeded 2000 chars
// made every subsequent turn 400 identically, forever, even on retry.)
// ---------------------------------------------------------------------------

describe('ChatAgent.respond — answer length clamp', () => {
  it.effect(
    'a scripted ~900-token answer (well past MAX_TOKENS=450) is clamped to <= 2000 chars, at a word boundary, before it ever reaches the client',
    () =>
      Effect.gen(function* () {
        // ~900 "tokens" (space-separated words), each several characters — comfortably past the
        // 2000-char wire cap regardless of the model's actual MAX_TOKENS setting, since this is
        // scripted content, not something the provider's own limit constrains.
        const words = Array.from({ length: 900 }, (_, i) => `answerword${String(i)}`);
        const longAnswer = words.join(' ');
        const scripted = makeScriptedLlm([textResult(longAnswer)]);

        const outcome = yield* runRespond(
          buildCtx(),
          [userMsg('Tell me everything about the team')],
          scripted.layer,
        );

        expect(outcome._tag).toBe('Success');
        if (outcome._tag !== 'Success') return;
        expect(outcome.success.generated).toBe(true);
        expect(outcome.success.answer.length).toBeLessThanOrEqual(2000);
        // Clamped at a word boundary — the answer is a verbatim PREFIX of the model's output,
        // never a mid-word cut.
        expect(longAnswer.startsWith(outcome.success.answer)).toBe(true);
      }),
  );
});

// ---------------------------------------------------------------------------
// 12. History truncation
// ---------------------------------------------------------------------------

describe('ChatAgent.respond — history truncation', () => {
  const padded = (marker: string): string => (marker + 'x'.repeat(2000)).slice(0, 2000);

  it.effect(
    '20 messages x 2000 chars: oldest whole messages dropped, newest user message always present, no partial message',
    () =>
      Effect.gen(function* () {
        const historyMessages: ReadonlyArray<AiChatApi.ChatMessage> = Array.from(
          { length: 20 },
          (_, i) => {
            const role: AiChatApi.ChatRole = i === 19 || i % 2 === 0 ? 'user' : 'assistant';
            return new AiChatApi.ChatMessage({
              role,
              content: padded(`M${String(i).padStart(2, '0')}_`),
            });
          },
        );
        const scripted = makeScriptedLlm([textResult('Sure.')]);

        const outcome = yield* runRespond(buildCtx(), historyMessages, scripted.layer);

        expect(outcome._tag).toBe('Success');
        if (outcome._tag !== 'Success') return;
        expect(scripted.calls).toHaveLength(1);

        const seeded = (scripted.calls[0]?.messages ?? []).filter((m) => m.role !== 'system');
        const originalContents = historyMessages.map((m) => m.content);

        // every seeded message is a COMPLETE original message, never a slice
        for (const m of seeded) {
          expect(originalContents).toContain(m.content);
        }

        // the newest user message (the last of the 20) is always present, and last
        expect(seeded.at(-1)?.content).toBe(historyMessages.at(-1)?.content);

        // truncation actually happened: 20 * 2000 = 40000 chars >> 8000 budget
        expect(seeded.length).toBeLessThan(20);
        expect(seeded.length).toBeGreaterThan(0);

        // the kept messages are a contiguous SUFFIX of the original 20 (oldest dropped)
        const keptIndices = seeded.map((m) =>
          historyMessages.findIndex((h) => h.content === m.content),
        );
        const expectedIndices = Array.from(
          { length: seeded.length },
          (_, i) => 20 - seeded.length + i,
        );
        expect(keptIndices).toEqual(expectedIndices);
      }),
  );
});

// ---------------------------------------------------------------------------
// 13-18. Reference-token security tests
// ---------------------------------------------------------------------------

describe('ChatAgent.respond — reference-token security (plan §4)', () => {
  it.effect(
    '13a. unknown marker is stripped WITH its surrounding whitespace, leaving no double space or orphaned punctuation',
    () =>
      Effect.gen(function* () {
        const events = [
          buildEvent({ id: EVENT_A1, title: 'One' }),
          buildEvent({ id: EVENT_A2, title: 'Two' }),
        ];
        const call: LlmToolCall = { id: 'r1', name: 'list_events', argumentsJson: '{}' };
        const scripted = makeScriptedLlm([
          toolCallResult(Option.none(), [call]),
          dynamicText((input) => {
            const refs = lastToolResultRefs(input.messages);
            return `See [[ref:${refs[0]}]] and [[ref:zzzz]] for details.`;
          }),
        ]);

        const outcome = yield* runRespond(buildCtx(), [userMsg('list events')], scripted.layer, {
          events,
        });

        expect(outcome._tag).toBe('Success');
        if (outcome._tag !== 'Success') return;
        expect(outcome.success.references).toHaveLength(2);
        const expected = `See [[ref:${outcome.success.references[0]?.ref}]] and for details.`;
        expect(outcome.success.answer).toBe(expected);
      }),
  );

  it.effect('13b. unknown marker before punctuation: "Check [[ref:zzzz]]." -> "Check."', () =>
    Effect.gen(function* () {
      const scripted = makeScriptedLlm([textResult('Check [[ref:zzzz]].')]);
      const outcome = yield* runRespond(buildCtx(), [userMsg('Hi')], scripted.layer);

      expect(outcome._tag).toBe('Success');
      if (outcome._tag !== 'Success') return;
      expect(outcome.success.answer).toBe('Check.');
      expect(outcome.success.references).toEqual([]);
    }),
  );

  it.effect('13c. leading unknown marker is trimmed: "[[ref:zzzz]] leads." -> "leads."', () =>
    Effect.gen(function* () {
      const scripted = makeScriptedLlm([textResult('[[ref:zzzz]] leads.')]);
      const outcome = yield* runRespond(buildCtx(), [userMsg('Hi')], scripted.layer);

      expect(outcome._tag).toBe('Success');
      if (outcome._tag !== 'Success') return;
      expect(outcome.success.answer).toBe('leads.');
    }),
  );

  it.effect(
    '14. a fabricated marker with ZERO tool calls proves the model cannot invent a link to a row it was never shown',
    () =>
      Effect.gen(function* () {
        const scripted = makeScriptedLlm([textResult('Look at [[ref:a1b2]].')]);
        const outcome = yield* runRespond(buildCtx(), [userMsg('Hi')], scripted.layer);

        expect(outcome._tag).toBe('Success');
        if (outcome._tag !== 'Success') return;
        expect(outcome.success.references).toEqual([]);
        expect(outcome.success.answer).not.toContain('[[ref:');
        expect(outcome.success.answer).toBe('Look at.');
      }),
  );

  it.effect(
    '15. cross-team fabrication: a marker cited after a not_found tool round (zero references) is stripped',
    () =>
      Effect.gen(function* () {
        const foreignEvent = buildEvent({
          id: EVENT_B1,
          team_id: TEAM_B,
          title: 'Secret Team B Event',
        });
        const call: LlmToolCall = {
          id: 'x',
          name: 'list_events',
          argumentsJson: JSON.stringify({ eventId: EVENT_B1 }),
        };
        const scripted = makeScriptedLlm([
          toolCallResult(Option.none(), [call]),
          textResult('Found: [[ref:abcd]].'),
        ]);

        const outcome = yield* runRespond(
          buildCtx({ teamId: TEAM_A }),
          [userMsg('find that other event')],
          scripted.layer,
          { events: [foreignEvent] },
        );

        expect(outcome._tag).toBe('Success');
        if (outcome._tag !== 'Success') return;
        expect(outcome.success.references).toEqual([]);
        expect(outcome.success.answer).not.toContain('[[ref:');

        const toolMsg = toolMessages(scripted.calls[1]?.messages ?? [])[0];
        expect(toolMsg).toBeDefined();
        if (toolMsg) expect(JSON.parse(toolMsg.content)).toEqual({ error: 'not_found' });
      }),
  );

  it.effect(
    '16. tokens are server-minted, unique, opaque and NOT positional — the model-facing JSON carries the exact same tokens',
    () =>
      Effect.gen(function* () {
        const events = [
          buildEvent({ id: EVENT_A1, title: 'Ev1' }),
          buildEvent({ id: EVENT_A2, title: 'Ev2' }),
        ];
        const trainingTypes = [
          buildTrainingTypeRow({ id: TT_A1, name: 'T1' }),
          buildTrainingTypeRow({ id: TT_A2, name: 'T2' }),
          buildTrainingTypeRow({ id: TT_A3, name: 'T3' }),
        ];
        const call1: LlmToolCall = { id: 'e', name: 'list_events', argumentsJson: '{}' };
        const call2: LlmToolCall = { id: 't', name: 'list_training_types', argumentsJson: '{}' };
        const scripted = makeScriptedLlm([
          toolCallResult(Option.none(), [call1]),
          toolCallResult(Option.none(), [call2]),
          textResult('Here you go.'),
        ]);

        const outcome = yield* runRespond(
          buildCtx(),
          [userMsg('give me everything')],
          scripted.layer,
          {
            events,
            trainingTypes,
          },
        );

        expect(outcome._tag).toBe('Success');
        if (outcome._tag !== 'Success') return;

        const refs = outcome.success.references;
        expect(refs).toHaveLength(5);
        const tokens = refs.map((r) => r.ref);
        expect(new Set(tokens).size).toBe(5);
        for (const token of tokens) {
          expect(token).toMatch(/^[a-z0-9]{4}$/);
        }
        refs.forEach((r, i) => {
          expect(r.ref).not.toBe(String(i));
        });

        const modelFacingRefs = allToolResultRefs(scripted.calls[2]?.messages ?? []);
        expect([...new Set(modelFacingRefs)].sort()).toEqual([...new Set(tokens)].sort());
      }),
  );

  it.effect(
    '17a. dedup: the same entity across two rounds keeps ONE reference, and the token minted on first sight is reused (not re-minted) in round 2',
    () =>
      Effect.gen(function* () {
        const events = [buildEvent({ id: EVENT_A1, title: 'Solo' })];
        const call1: LlmToolCall = { id: 'a', name: 'list_events', argumentsJson: '{}' };
        const call2: LlmToolCall = { id: 'b', name: 'list_events', argumentsJson: '{}' };
        const scripted = makeScriptedLlm([
          toolCallResult(Option.none(), [call1]),
          toolCallResult(Option.none(), [call2]),
          textResult('Ok.'),
        ]);

        const outcome = yield* runRespond(
          buildCtx(),
          [userMsg('list events twice')],
          scripted.layer,
          {
            events,
          },
        );

        expect(outcome._tag).toBe('Success');
        if (outcome._tag !== 'Success') return;
        expect(outcome.success.references).toHaveLength(1);
        const finalToken = outcome.success.references[0]?.ref;

        const round1Ref = lastToolResultRefs(scripted.calls[1]?.messages ?? [])[0];
        const round2Ref = lastToolResultRefs(scripted.calls[2]?.messages ?? [])[0];
        expect(round1Ref).toBe(finalToken);
        expect(round2Ref).toBe(finalToken);
      }),
  );

  it.effect(
    '17b. cap: 30 distinct entities in one round -> references capped at MAX_REFERENCES, rows beyond the cap carry no ref key (rows are not dropped)',
    () =>
      Effect.gen(function* () {
        const events = Array.from({ length: 30 }, (_, i) =>
          buildEvent({ id: eventIdN(i), title: `Ev${String(i)}` }),
        );
        const call: LlmToolCall = {
          id: 'cap',
          name: 'list_events',
          argumentsJson: JSON.stringify({ limit: 30 }),
        };
        const scripted = makeScriptedLlm([
          toolCallResult(Option.none(), [call]),
          textResult('Ok.'),
        ]);

        const outcome = yield* runRespond(buildCtx(), [userMsg('list all 30')], scripted.layer, {
          events,
        });

        expect(outcome._tag).toBe('Success');
        if (outcome._tag !== 'Success') return;
        expect(outcome.success.references).toHaveLength(MAX_REFERENCES);

        const toolMsg = toolMessages(scripted.calls[1]?.messages ?? [])[0];
        expect(toolMsg).toBeDefined();
        if (toolMsg) {
          const parsed = parseToolContent(toolMsg);
          const rows = parsed.untrusted_data ?? [];
          expect(rows).toHaveLength(30);
          for (let i = 0; i < MAX_REFERENCES; i += 1) {
            expect(typeof rows[i]?.ref).toBe('string');
          }
          for (let i = MAX_REFERENCES; i < 30; i += 1) {
            expect(rows[i] && 'ref' in rows[i]!).toBe(false);
          }
        }
      }),
  );

  it.effect(
    '18. cross-turn markers cannot mis-resolve: a stale token from turn 1 is stripped from BOTH the seeded turn-2 prompt and the turn-2 answer',
    () =>
      Effect.gen(function* () {
        const events = [buildEvent({ id: EVENT_A1, title: 'Practice' })];
        const call: LlmToolCall = { id: 'z1', name: 'list_events', argumentsJson: '{}' };

        // --- turn 1: mints a live reference and cites it -------------------
        const scripted1 = makeScriptedLlm([
          toolCallResult(Option.none(), [call]),
          dynamicText((input) => {
            const refs = lastToolResultRefs(input.messages);
            return `Upcoming: [[ref:${refs[0]}]]`;
          }),
        ]);
        const outcome1 = yield* runRespond(buildCtx(), [userMsg('What events?')], scripted1.layer, {
          events,
        });
        expect(outcome1._tag).toBe('Success');
        if (outcome1._tag !== 'Success') return;
        expect(outcome1.success.references).toHaveLength(1);
        const staleToken = outcome1.success.references[0]?.ref ?? '';
        expect(outcome1.success.answer).toBe(`Upcoming: [[ref:${staleToken}]]`);

        // --- turn 2: the stale token is fed back verbatim as history --------
        const history2: ReadonlyArray<AiChatApi.ChatMessage> = [
          userMsg('What events?'),
          assistantMsg(outcome1.success.answer),
          userMsg('And next week?'),
        ];
        const scripted2 = makeScriptedLlm([textResult(`Still: [[ref:${staleToken}]]`)]);
        const outcome2 = yield* runRespond(buildCtx(), history2, scripted2.layer, { events });

        expect(outcome2._tag).toBe('Success');
        if (outcome2._tag !== 'Success') return;

        // (a) inbound assistant history is stripped before seeding the prompt.
        // The `system` message is exempt from this check: the system prompt is
        // expected to EXPLAIN the `[[ref:<token>]]` citation syntax to the model
        // (instructional text, not a citation of any entity), so only the
        // history-derived (user/assistant) messages are asserted marker-free.
        expect(scripted2.calls).toHaveLength(1);
        const seeded = (scripted2.calls[0]?.messages ?? []).filter((m) => m.role !== 'system');
        expect(seeded.every((m) => !m.content.includes('[[ref:'))).toBe(true);

        // (b) the stale token does NOT resolve against turn 2's (empty) token map
        expect(outcome2.success.answer).not.toContain('[[ref:');
        expect(outcome2.success.references).toEqual([]);
      }),
  );
});
