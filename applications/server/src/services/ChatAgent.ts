/**
 * `ChatAgent` — the read-only in-app AI assistant's tool-calling loop. Plan
 * `.work-plans/ai-app-interaction.md` §5 (the loop), §4 (reference tokens),
 * §9 (history truncation).
 *
 * Per `applications/server/AGENTS.md`, `Effect.gen` is permitted only inside
 * a service's own `make`; every function in this file — `make` included —
 * is built from `Effect.Do.pipe`/plain combinators instead, since none of
 * them need generator-style branching.
 *
 * `respond`'s signature is fixed by the plan at `(ctx, history) =>
 * Effect.Effect<ChatAgentResult>` — `E = never`. `systemPrompt.ts` needs a
 * `teamName` that `ToolContext` does not carry, so `respond` resolves it
 * itself, ambiently, via `TeamsRepository.findById(ctx.teamId)` — the same
 * pattern `group.ts`/`auth.ts`/`roster.ts`/`team.ts`/`channel.ts` already
 * use to go from an id to a name. Consequently `ChatAgent.Default` itself
 * requires `LlmClient` and every read-tool repository (captured once, at
 * construction, exactly like `deps.llm`) so that the returned `respond`
 * effect can have `R = never`.
 */
import type { AiActionProposal, AiChatApi } from '@sideline/domain';
import { Array as Arr, Cause, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { hasPermission } from '~/api/permissions.js';
import { AiActionProposalsRepository } from '~/repositories/AiActionProposalsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { ACTION_REGISTRY } from '~/services/ai/actions.js';
import { computeCurrentDatetime } from '~/services/ai/currentDatetime.js';
import {
  currentDatetime,
  listEvents,
  listGroups,
  listMembers,
  listRosters,
  listTrainingTypes,
} from '~/services/ai/readTools.js';
import { buildTokenMap, entityKeyOf, mintToken } from '~/services/ai/refTokens.js';
import {
  ALL_TOOLS,
  CurrentDatetimeSchema,
  ListEventsSchema,
  ListGroupsSchema,
  ListMembersSchema,
  ListRostersSchema,
  ListTrainingTypesSchema,
  visibleTools,
} from '~/services/ai/registry.js';
import { buildSystemPrompt } from '~/services/ai/systemPrompt.js';
import type { ToolContext, ToolExecutionResult } from '~/services/ai/toolTypes.js';
import { proposeAction } from '~/services/ai/writeTools.js';
import {
  type ChatWithToolsResult,
  type LlmChatMessage,
  LlmClient,
  type LlmToolCall,
  STUB_UNAVAILABLE_MARKER,
} from '~/services/LlmClient.js';

// ---------------------------------------------------------------------------
// Loop / budget constants — plan §5.
// ---------------------------------------------------------------------------

const MAX_TOOL_ITERATIONS = 5;
const MAX_TOOL_CALLS_PER_TURN = 8;
const TOOL_RESULT_CHAR_BUDGET = 6000;
const TOTAL_TOOL_CHAR_BUDGET = 20000;
const HISTORY_CHAR_BUDGET = 8000;
const MAX_REFERENCES = 20;
// Lowered from 900: at ~4 chars/token that permitted ~3-4k characters, well past
// `ChatMessage.content`'s 2000-char wire cap (`packages/domain/src/api/AiChatApi.ts`) — which
// applies to BOTH roles, so a >2000-char answer, once replayed verbatim as history on the next
// turn, would 400 forever. 450 tokens keeps a real answer comfortably clear of that cap in
// practice; `finish` below still clamps defensively so the cap can never be exceeded regardless
// of what the provider actually returns (BLOCKER fix).
const MAX_TOKENS = 450;
// Mirrors `ChatMessage.content`'s wire cap exactly (`packages/domain/src/api/AiChatApi.ts`) —
// `finish` must never hand back an `answer` longer than what the client can echo back as history
// on the next turn.
const MAX_ANSWER_CHARS = 2000;

// ---------------------------------------------------------------------------
// Public result shape
// ---------------------------------------------------------------------------

export interface ChatAgentResult {
  readonly answer: string;
  readonly generated: boolean;
  readonly degradedReason: Option.Option<AiChatApi.DegradedReason>;
  readonly references: ReadonlyArray<AiChatApi.EntityRef>;
  /** A pending write the client renders as a confirmation card — `None` on every degraded turn
   *  (a turn with no answer text ships no card, plan §16). */
  readonly proposal: Option.Option<AiChatApi.Proposal>;
}

export interface ChatAgentService {
  readonly respond: (
    ctx: ToolContext,
    history: ReadonlyArray<AiChatApi.ChatMessage>,
  ) => Effect.Effect<ChatAgentResult>;
}

// ---------------------------------------------------------------------------
// Reference-marker stripping (plan §4, parts 2 & 3) — pure, exported,
// unit-testable without the loop.
// ---------------------------------------------------------------------------

const MARKER = /\s*\[\[ref:([a-z0-9]{4})\]\]\s*/g;

/**
 * Validates every `[[ref:<token>]]` marker in `answer` against THIS TURN's
 * token map. A token that is not in `tokens` — stale, invented, guessed, or
 * beyond the per-turn cap — is removed together with its surrounding
 * whitespace, leaving no double space and no orphaned punctuation. A known
 * token is left exactly as written.
 */
export const stripUnknownMarkers = (
  answer: string,
  tokens: ReadonlyMap<string, number>,
): string => {
  let droppedAny = false;
  const resolved = answer.replace(MARKER, (whole, token: string) => {
    if (tokens.has(token)) {
      return whole;
    }
    droppedAny = true;
    return ' ';
  });
  // The whitespace/punctuation normalisers below only exist to clean up AFTER a marker was
  // actually removed (closing the gap it left behind) — running them unconditionally on every
  // answer, including the overwhelming majority that cite nothing but valid tokens, is pure
  // waste. `resolved === answer` whenever nothing was dropped, so this is a no-op fast path, not
  // a behaviour change.
  return droppedAny
    ? resolved
        .replace(/\s+(?=[.,;:!?])/g, '')
        .replace(/ {2,}/g, ' ')
        .trim()
    : resolved.trim();
};

/**
 * Removes EVERY syntactically valid marker, unconditionally — applied to
 * every inbound `role: 'assistant'` message before it is seeded into the
 * prompt, so the model never sees a token from an earlier turn as an
 * in-context example to copy.
 */
export const stripAllMarkers = (text: string): string =>
  text
    .replace(MARKER, ' ')
    .replace(/\s+(?=[.,;:!?])/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();

// ---------------------------------------------------------------------------
// Dependencies captured once at construction (mirrors `deps.llm` in the
// plan's pseudocode, extended to every read-tool repository so `respond`'s
// returned effect can have R = never).
// ---------------------------------------------------------------------------

interface AgentDeps {
  readonly llm: ServiceMap.Service.Shape<typeof LlmClient>;
  readonly events: ServiceMap.Service.Shape<typeof EventsRepository>;
  readonly groups: ServiceMap.Service.Shape<typeof GroupsRepository>;
  readonly trainingTypes: ServiceMap.Service.Shape<typeof TrainingTypesRepository>;
  readonly rosters: ServiceMap.Service.Shape<typeof RostersRepository>;
  readonly members: ServiceMap.Service.Shape<typeof TeamMembersRepository>;
  readonly teams: ServiceMap.Service.Shape<typeof TeamsRepository>;
  readonly proposals: ServiceMap.Service.Shape<typeof AiActionProposalsRepository>;
}

// ---------------------------------------------------------------------------
// Loop state
// ---------------------------------------------------------------------------

interface LoopState {
  readonly messages: ReadonlyArray<LlmChatMessage>;
  readonly references: ReadonlyArray<AiChatApi.EntityRef>;
  /** ref token -> position in `references`. Rebuilt from scratch every turn. */
  readonly tokens: ReadonlyMap<string, number>;
  /** "kind:id" -> token, for cross-call dedup within the turn. */
  readonly entityKeys: ReadonlyMap<string, string>;
  readonly iteration: number;
  readonly toolCallsUsed: number;
  readonly toolCharsUsed: number;
  /** At most one pending proposal per turn (blocker 8) — set once a `propose_*` call succeeds,
   *  never cleared within the turn. */
  readonly proposal: Option.Option<AiChatApi.Proposal>;
}

const fallback = (
  references: ReadonlyArray<AiChatApi.EntityRef>,
  reason: AiChatApi.DegradedReason,
): ChatAgentResult => ({
  answer: '',
  generated: false,
  degradedReason: Option.some(reason),
  references,
  // A degraded turn never ships a card — the answer text explaining it is missing, so the user
  // would have no context for what the card is proposing.
  proposal: Option.none(),
});

/**
 * Clamps `text` to `MAX_ANSWER_CHARS` (BLOCKER fix) — the server-side backstop that makes the
 * wire cap on `ChatMessage.content` unbreakable regardless of `MAX_TOKENS` or what a given
 * provider actually returns. Cuts at the last word boundary within the limit, then — since
 * `stripUnknownMarkers` has already run and left only VALID `[[ref:<token>]]` markers in place —
 * drops a dangling, unclosed `[[…` fragment rather than ship half a marker as literal text.
 */
const clampAnswer = (text: string): string => {
  if (text.length <= MAX_ANSWER_CHARS) {
    return text;
  }
  const sliced = text.slice(0, MAX_ANSWER_CHARS);
  const lastSpace = sliced.lastIndexOf(' ');
  const atWordBoundary = lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced;
  const lastOpen = atWordBoundary.lastIndexOf('[[');
  const lastClose = atWordBoundary.lastIndexOf(']]');
  const safe = lastOpen > lastClose ? atWordBoundary.slice(0, lastOpen) : atWordBoundary;
  return safe.trimEnd();
};

const finish = (res: ChatWithToolsResult, state: LoopState): ChatAgentResult => {
  const raw = Option.getOrElse(res.content, () => '');
  if (raw === STUB_UNAVAILABLE_MARKER) {
    return fallback(state.references, 'not_configured');
  }
  const answer = clampAnswer(stripUnknownMarkers(raw, state.tokens));
  return answer.length === 0
    ? fallback(state.references, 'empty_answer')
    : {
        answer,
        generated: true,
        degradedReason: Option.none(),
        references: state.references,
        proposal: state.proposal,
      };
};

/**
 * `finishReason` (decoded in `LlmClient.ts`, otherwise unused) is worth a signal even at the
 * lower `MAX_TOKENS = 450`: a long, citation-heavy answer can still be cut mid-sentence by the
 * provider, and today that ships as `generated: true` with nothing to tell an operator it
 * happened. Log-only, deliberately: a `degradedReason` literal for this is the more correct
 * long-term fix, but that closed union is also consumed by the web client's
 * `degradedReasonLabels` map, owned by the concurrent web-side pass over this same review — so
 * adding a literal here without that coordination would ship a value the client cannot render.
 * Flagged in the review response rather than guessed at.
 */
const logIfTruncated = (res: ChatWithToolsResult): Effect.Effect<void> =>
  res.finishReason === 'length'
    ? Effect.logWarning('ChatAgent: model answer truncated by max_tokens').pipe(
        Effect.annotateLogs({ finishReason: res.finishReason }),
      )
    : Effect.void;

// ---------------------------------------------------------------------------
// Per-call dispatch (plan §5's dispatch table). Never fails — every outcome
// is encoded as a `CallOutcome`, never a typed/defect failure.
// ---------------------------------------------------------------------------

interface CallOutcome {
  readonly content: string;
  readonly newReferences: ReadonlyArray<AiChatApi.EntityRef>;
  readonly proposal?: AiChatApi.Proposal | undefined;
}

const bareError = (body: Record<string, unknown>): CallOutcome => ({
  content: JSON.stringify(body),
  newReferences: [],
});

type ExecuteOutcome =
  | { readonly _tag: 'invalidArguments'; readonly detail: string }
  | { readonly _tag: 'ok'; readonly result: ToolExecutionResult };

const invalidArguments = (detail: string): Effect.Effect<ExecuteOutcome> =>
  Effect.succeed<ExecuteOutcome>({ _tag: 'invalidArguments', detail });

/**
 * Decodes the provider's raw tool-call arguments against the EXACT schema the
 * executor accepts, then runs it. A decode failure is reported as
 * `invalidArguments`, never raised — so every branch of the dispatch table
 * below is a single line and cannot drift from its siblings.
 */
const decodeAndRun = <S extends Schema.Decoder<unknown>>(
  schema: S,
  parsedArgs: unknown,
  run: (args: S['Type']) => Effect.Effect<ToolExecutionResult>,
): Effect.Effect<ExecuteOutcome> => {
  let args: S['Type'];
  try {
    args = Schema.decodeUnknownSync(schema)(parsedArgs);
  } catch (e) {
    return invalidArguments(Schema.isSchemaError(e) ? e.message : String(e));
  }
  return run(args).pipe(Effect.map((result): ExecuteOutcome => ({ _tag: 'ok', result })));
};

const executeTool = (
  deps: AgentDeps,
  ctx: ToolContext,
  name: string,
  parsedArgs: unknown,
): Effect.Effect<ExecuteOutcome> => {
  switch (name) {
    case 'current_datetime':
      return decodeAndRun(CurrentDatetimeSchema, parsedArgs, (args) => currentDatetime(args, ctx));
    case 'list_events':
      return decodeAndRun(ListEventsSchema, parsedArgs, (args) =>
        Effect.provideService(listEvents(args, ctx), EventsRepository, deps.events),
      );
    case 'list_training_types':
      return decodeAndRun(ListTrainingTypesSchema, parsedArgs, (args) =>
        Effect.provideService(
          listTrainingTypes(args, ctx),
          TrainingTypesRepository,
          deps.trainingTypes,
        ),
      );
    case 'list_groups':
      return decodeAndRun(ListGroupsSchema, parsedArgs, (args) =>
        Effect.provideService(listGroups(args, ctx), GroupsRepository, deps.groups),
      );
    case 'list_members':
      return decodeAndRun(ListMembersSchema, parsedArgs, (args) =>
        Effect.provideService(listMembers(args, ctx), TeamMembersRepository, deps.members),
      );
    case 'list_rosters':
      return decodeAndRun(ListRostersSchema, parsedArgs, (args) =>
        Effect.provideService(listRosters(args, ctx), RostersRepository, deps.rosters),
      );
    default:
      // Unreachable: `executeTool` is only ever called with a name already
      // confirmed present in `ALL_TOOLS` (module-load invariant: exactly 6).
      return invalidArguments(`unrecognized tool: ${name}`);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Arr.isArray(value);

const isErrorResult = (result: unknown): result is { readonly error: string } =>
  isRecord(result) && typeof result.error === 'string';

const hasItemsArray = (
  result: Record<string, unknown>,
): result is { readonly items: ReadonlyArray<Record<string, unknown>> } =>
  Arr.isArray(result.items);

interface RemapResult {
  readonly items: ReadonlyArray<Record<string, unknown>>;
  readonly newRefs: ReadonlyArray<{
    readonly index: number;
    readonly entityRef: AiChatApi.EntityRef;
  }>;
}

/**
 * Re-mints/re-dedupes the executor's own per-call rows into THIS TURN's token space
 * (plan §4, part 1; `.work-plans/command-palette-search.md` §B): an entity already seen this
 * turn (in an earlier call, or earlier in this same call's rows) reuses its first token; a
 * genuinely new entity gets a fresh one as long as the per-turn cap has not been reached; beyond
 * the cap the row is kept unchanged (no `ref` to add). `hits` carry no `ref` of their own — this
 * is the only place a token that ever ships is minted, by CONSTRUCTING `EntityRef` from a
 * `SearchHit` (`{ ...hit, ref: token }`), not overwriting a placeholder field.
 */
const remapCallReferences = (
  state: LoopState,
  hits: ReadonlyArray<AiChatApi.SearchHit>,
  items: ReadonlyArray<Record<string, unknown>>,
): RemapResult => {
  const usedTokens = new Set(state.tokens.keys());
  const entityKeys = new Map(state.entityKeys);
  let capUsed = state.references.length;
  const newRefs: Array<{ index: number; entityRef: AiChatApi.EntityRef }> = [];

  const remappedItems = items.map((item, index) => {
    const hit = hits[index];
    if (hit === undefined) {
      return item;
    }
    const key = entityKeyOf(hit);
    const existingToken = entityKeys.get(key);
    if (existingToken !== undefined) {
      return { ...item, ref: existingToken };
    }
    if (capUsed >= MAX_REFERENCES) {
      return item;
    }
    const token = mintToken(usedTokens);
    entityKeys.set(key, token);
    capUsed += 1;
    newRefs.push({ index, entityRef: { ...hit, ref: token } });
    return { ...item, ref: token };
  });

  return { items: remappedItems, newRefs };
};

/**
 * Applies the per-tool-result char budget (plan §5's dispatch table) by
 * dropping WHOLE rows from the tail — never truncating mid-row — until the
 * serialized envelope fits, marking `truncated: true` when it had to.
 *
 * Binary-searches the largest kept prefix `k` rather than decrementing by one and
 * re-`JSON.stringify`-ing the whole prefix every pass (MAJOR finding 1): that walk was O(n^2) —
 * measured 3913ms for 5000 rows, a single-threaded stall given `{ concurrency: 1 }` and up to 8
 * tool calls per turn. Serialized size is monotonic in row count, so a standard "largest k
 * satisfying a monotonic predicate" binary search applies: O(log n) `JSON.stringify` calls
 * instead of up to n.
 */
const truncateForBudget = (
  items: ReadonlyArray<Record<string, unknown>>,
): { readonly content: string; readonly keptCount: number } => {
  const full = JSON.stringify({ untrusted_data: items, truncated: false });
  if (full.length <= TOOL_RESULT_CHAR_BUDGET) {
    return { content: full, keptCount: items.length };
  }

  let lo = 0;
  let hi = items.length - 1;
  let bestK = 0;
  let bestContent = JSON.stringify({ untrusted_data: [], truncated: true });
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = JSON.stringify({ untrusted_data: items.slice(0, mid), truncated: true });
    if (candidate.length <= TOOL_RESULT_CHAR_BUDGET) {
      bestK = mid;
      bestContent = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { content: bestContent, keptCount: bestK };
};

/**
 * Turns a successful `ToolExecutionResult` into the model-facing envelope.
 * Only success results get `{"untrusted_data": …}` — errors are fed back
 * bare (handled by the caller before this is reached).
 */
const processToolExecution = (state: LoopState, execResult: ToolExecutionResult): CallOutcome => {
  const { result } = execResult;

  if (isErrorResult(result)) {
    return bareError(result);
  }

  if (!isRecord(result) || !hasItemsArray(result)) {
    return {
      content: JSON.stringify({ untrusted_data: result, truncated: false }),
      newReferences: [],
    };
  }

  const { items: remappedItems, newRefs } = remapCallReferences(
    state,
    execResult.hits,
    result.items,
  );
  const { content, keptCount } = truncateForBudget(remappedItems);
  const newReferences = newRefs
    .filter((entry) => entry.index < keptCount)
    .map((entry) => entry.entityRef);

  return { content, newReferences };
};

const capToTotalBudget = (state: LoopState, outcome: CallOutcome): CallOutcome =>
  state.toolCharsUsed + outcome.content.length > TOTAL_TOOL_CHAR_BUDGET
    ? bareError({ error: 'budget_exceeded' })
    : outcome;

const isKnownAction = (action: string): action is AiActionProposal.AiActionName =>
  action in ACTION_REGISTRY;

/**
 * The `propose_*` dispatch — kept OUT of `executeTool`'s switch on purpose (a `case
 * 'propose_create_event':` there would stop the registry's compile-error property at
 * `executeTool`, since its `default:` silently answers `unrecognized tool` for any action added
 * to `ACTION_REGISTRY` later without a matching `case`). Dispatches generically off
 * `tool.name.slice('propose_'.length)` against `ACTION_REGISTRY` instead.
 *
 * Deliberately bypasses BOTH `processToolExecution` (its non-`items` arm would wrap the result
 * as `{"untrusted_data":…}` — wrong: a server-minted proposal id is not untrusted data) and
 * `capToTotalBudget` (which replaces the whole `CallOutcome`, dropping `proposal` — the row would
 * be written with no card ever reaching the client). The envelope here is a few dozen bytes and
 * minted by us, so exempting it from the char budget costs nothing.
 */
const dispatchProposeCall = (
  deps: AgentDeps,
  ctx: ToolContext,
  state: LoopState,
  toolName: string,
  parsedArgs: unknown,
): Effect.Effect<CallOutcome> => {
  if (Option.isSome(state.proposal)) {
    // Blocker 8: at most one proposal per reply. The model is told this in the system prompt;
    // this is the enforcement.
    return Effect.succeed(
      bareError({
        error: 'proposal_already_pending',
        detail:
          'Only one change may be proposed per reply. Tell the user you will do the next one ' +
          'after they confirm this one.',
      }),
    );
  }

  const action = toolName.slice('propose_'.length);
  if (!isKnownAction(action)) {
    // Unreachable in practice: `ALL_TOOLS` (registry.ts) only ever offers a `propose_<name>`
    // entry built FROM `ACTION_REGISTRY`, so `tool` was already resolved from that same catalogue
    // by the caller. Encoded rather than thrown, matching every other outcome in this function.
    return Effect.succeed(bareError({ error: 'unknown_tool' }));
  }

  return proposeAction(action, parsedArgs, ctx).pipe(
    Effect.provideService(GroupsRepository, deps.groups),
    Effect.provideService(TrainingTypesRepository, deps.trainingTypes),
    Effect.provideService(AiActionProposalsRepository, deps.proposals),
    Effect.map(
      (outcome): CallOutcome => ({
        content: JSON.stringify(outcome.result), // BARE, not untrusted_data
        newReferences: [],
        proposal: outcome.proposal,
      }),
    ),
  );
};

const dispatchOneCall = (
  deps: AgentDeps,
  ctx: ToolContext,
  state: LoopState,
  call: LlmToolCall,
): Effect.Effect<CallOutcome> => {
  const tool = ALL_TOOLS.find((t) => t.name === call.name);
  if (tool === undefined) {
    return Effect.succeed(bareError({ error: 'unknown_tool' }));
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(call.argumentsJson) as unknown;
  } catch {
    return Effect.succeed(bareError({ error: 'invalid_arguments' }));
  }

  if (tool.name.startsWith('propose_')) {
    return dispatchProposeCall(deps, ctx, state, tool.name, parsedArgs);
  }

  return executeTool(deps, ctx, tool.name, parsedArgs).pipe(
    Effect.map((outcome) => {
      if (outcome._tag === 'invalidArguments') {
        return bareError({ error: 'invalid_arguments', detail: outcome.detail });
      }
      return capToTotalBudget(state, processToolExecution(state, outcome.result));
    }),
  );
};

const commitOutcome = (state: LoopState, outcome: CallOutcome): LoopState => {
  // A propose outcome always has `newReferences.length === 0` (it mints no `EntityRef`) and
  // takes THIS branch — the `references`-accumulating branch below never runs for it. Both
  // branches must carry `proposal` forward, or a propose outcome's card would be silently
  // dropped from `LoopState` the moment it took this early return.
  if (outcome.newReferences.length === 0) {
    return {
      ...state,
      toolCharsUsed: state.toolCharsUsed + outcome.content.length,
      proposal: outcome.proposal !== undefined ? Option.some(outcome.proposal) : state.proposal,
    };
  }
  const references = [...state.references, ...outcome.newReferences];
  const entityKeys = new Map(state.entityKeys);
  for (const ref of outcome.newReferences) {
    entityKeys.set(entityKeyOf(ref), ref.ref);
  }
  return {
    ...state,
    references,
    entityKeys,
    tokens: buildTokenMap(references),
    toolCharsUsed: state.toolCharsUsed + outcome.content.length,
    proposal: outcome.proposal !== undefined ? Option.some(outcome.proposal) : state.proposal,
  };
};

/**
 * Executes at most `MAX_TOOL_CALLS_PER_TURN - state.toolCallsUsed` calls, in
 * declaration order, with `{ concurrency: 1 }` — REQUIRED, not incidental:
 * it is what makes the running `LoopState` fold (threaded through the
 * closed-over `running` box, updated once per completed call, never
 * interleaved) safe without a `Ref`, same reasoning as `ctx.canSeeGroup`
 * (toolTypes.ts). Appends the assistant tool-call entry verbatim, followed
 * by one `role: 'tool'` message per call (including the calls that never
 * ran because the per-turn budget was already spent). Never fails.
 */
const runToolCalls = (
  deps: AgentDeps,
  ctx: ToolContext,
  state: LoopState,
  res: ChatWithToolsResult,
): Effect.Effect<LoopState> => {
  const budgetRemaining = Math.max(MAX_TOOL_CALLS_PER_TURN - state.toolCallsUsed, 0);
  const toRun = res.toolCalls.slice(0, budgetRemaining);
  const overBudget = res.toolCalls.slice(toRun.length);

  let running = state;

  return Effect.forEach(
    toRun,
    (call) =>
      dispatchOneCall(deps, ctx, running, call).pipe(
        Effect.map((outcome) => {
          running = commitOutcome(running, outcome);
          return { toolCallId: call.id, content: outcome.content };
        }),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.map((executed) => {
      const overBudgetMessages = overBudget.map((call) => ({
        toolCallId: call.id,
        content: JSON.stringify({ error: 'tool_budget_exceeded' }),
      }));
      const toolMessages: ReadonlyArray<LlmChatMessage> = [...executed, ...overBudgetMessages].map(
        (entry) => ({ role: 'tool', toolCallId: entry.toolCallId, content: entry.content }),
      );
      const assistantMessage: LlmChatMessage = {
        role: 'assistant',
        content: Option.getOrElse(res.content, () => ''),
        toolCalls: res.toolCalls,
      };
      return {
        ...running,
        messages: [...running.messages, assistantMessage, ...toolMessages],
        iteration: running.iteration + 1,
        toolCallsUsed: running.toolCallsUsed + toRun.length,
      };
    }),
  );
};

// ---------------------------------------------------------------------------
// The loop — `Effect.suspend` self-recursion over an explicit state record.
// `Effect.iterate`/`Effect.loop` do not exist in effect@4.0.0-beta.40, and
// `Effect.whileLoop` threads state only through a mutable closure variable
// and returns `Effect<void>`, so it cannot carry this accumulator (plan §1,
// finding 1 / §5). `flatMap` trampolines, so this recursion is stack-safe —
// and bounded at `MAX_TOOL_ITERATIONS` regardless.
// ---------------------------------------------------------------------------

const step = (
  deps: AgentDeps,
  ctx: ToolContext,
  state: LoopState,
): Effect.Effect<ChatAgentResult> =>
  Effect.suspend(() =>
    state.iteration >= MAX_TOOL_ITERATIONS
      ? Effect.succeed(fallback(state.references, 'too_many_steps'))
      : deps.llm
          .chatWithTools({
            messages: state.messages,
            tools: visibleTools(ctx),
            maxTokens: MAX_TOKENS,
          })
          .pipe(
            Effect.flatMap((res) =>
              Arr.isReadonlyArrayEmpty(res.toolCalls)
                ? logIfTruncated(res).pipe(Effect.as(finish(res, state)))
                : runToolCalls(deps, ctx, state, res).pipe(
                    Effect.flatMap((next) => step(deps, ctx, next)),
                  ),
            ),
            Effect.tapError((e) =>
              Effect.logWarning('ChatAgent: LLM turn failed').pipe(
                Effect.annotateLogs({ error: e.message }),
              ),
            ),
            Effect.catchTag('LlmError', () =>
              Effect.succeed(fallback(state.references, 'provider_error')),
            ),
          ),
  );

// ---------------------------------------------------------------------------
// History seeding (plan §9) — every inbound `role: 'assistant'` message is
// stripped of markers before it seeds the prompt; the oldest WHOLE messages
// are dropped once the budget is exceeded, the newest message always kept.
// ---------------------------------------------------------------------------

const toLlmMessage = (message: AiChatApi.ChatMessage): LlmChatMessage =>
  message.role === 'assistant'
    ? { role: 'assistant', content: stripAllMarkers(message.content), toolCalls: [] }
    : { role: 'user', content: message.content };

const truncateHistory = (
  messages: ReadonlyArray<LlmChatMessage>,
): ReadonlyArray<LlmChatMessage> => {
  const kept: Array<LlmChatMessage> = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined) {
      continue;
    }
    if (kept.length > 0 && used + message.content.length > HISTORY_CHAR_BUDGET) {
      break;
    }
    kept.unshift(message);
    used += message.content.length;
  }
  return kept;
};

const buildSeededHistory = (
  history: ReadonlyArray<AiChatApi.ChatMessage>,
): ReadonlyArray<LlmChatMessage> => truncateHistory(history.map(toLlmMessage));

// ---------------------------------------------------------------------------
// respond — seeds the state and runs the loop. The whole body is wrapped in
// `Effect.catchCause` so that `E = never` is EARNED, not asserted:
// `Effect.catchTag('LlmError', …)` inside `step` only catches the one typed
// failure `chatWithTools` can produce; it does not catch defects (a
// `JSON.stringify` that throws, a malformed-projection die, a synchronous
// throw inside a tool executor's repository call), and any of those would
// otherwise escape as a 500 on a page whose whole error contract is "two
// tags, no 500" (plan §10).
//
// The handler re-raises a cause that is ONLY interruption (`Cause.hasInterruptsOnly`) instead of
// degrading it to `provider_error` (CONCERN 8): a client disconnect mid-turn interrupts the
// fiber, and swallowing that — logging a full `Cause.pretty` as an "unexpected failure" and
// returning a 200 nobody will ever read — is both a false-alarm log and a defeated cancellation.
// A genuine defect (anything that also carries a `Die`/`Fail` reason) still degrades exactly as
// before.
// ---------------------------------------------------------------------------

const respond = (
  deps: AgentDeps,
  ctx: ToolContext,
  history: ReadonlyArray<AiChatApi.ChatMessage>,
): Effect.Effect<ChatAgentResult> =>
  Effect.Do.pipe(
    Effect.bind('team', () => deps.teams.findById(ctx.teamId)),
    Effect.bind('nowInfo', () => computeCurrentDatetime(ctx.teamTimezone)),
    Effect.let('teamName', ({ team }) =>
      Option.match(team, { onNone: () => 'your team', onSome: (t) => t.name }),
    ),
    Effect.let('systemPrompt', ({ teamName, nowInfo }) =>
      buildSystemPrompt({
        teamName,
        teamTimezone: ctx.teamTimezone,
        todayTeamLocal: nowInfo.todayTeamLocal,
        canPropose: hasPermission(ctx.membership, 'event:create'),
      }),
    ),
    Effect.let(
      'initialState',
      ({ systemPrompt }): LoopState => ({
        messages: [{ role: 'system', content: systemPrompt }, ...buildSeededHistory(history)],
        references: [],
        tokens: new Map(),
        entityKeys: new Map(),
        iteration: 0,
        toolCallsUsed: 0,
        toolCharsUsed: 0,
        proposal: Option.none(),
      }),
    ),
    Effect.flatMap(({ initialState }) =>
      deps.llm.configured
        ? step(deps, ctx, initialState)
        : Effect.succeed(fallback([], 'not_configured')),
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logError('ChatAgent: unexpected failure').pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            Effect.as(fallback([], 'provider_error')),
          ),
    ),
  );

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const make: Effect.Effect<
  ChatAgentService,
  never,
  | LlmClient
  | EventsRepository
  | GroupsRepository
  | TrainingTypesRepository
  | RostersRepository
  | TeamMembersRepository
  | TeamsRepository
  | AiActionProposalsRepository
> = Effect.Do.pipe(
  Effect.bind('llm', () => LlmClient.asEffect()),
  Effect.bind('events', () => EventsRepository.asEffect()),
  Effect.bind('groups', () => GroupsRepository.asEffect()),
  Effect.bind('trainingTypes', () => TrainingTypesRepository.asEffect()),
  Effect.bind('rosters', () => RostersRepository.asEffect()),
  Effect.bind('members', () => TeamMembersRepository.asEffect()),
  Effect.bind('teams', () => TeamsRepository.asEffect()),
  Effect.bind('proposals', () => AiActionProposalsRepository.asEffect()),
  Effect.map(
    (deps): ChatAgentService => ({
      respond: (ctx, history) => respond(deps, ctx, history),
    }),
  ),
);

export class ChatAgent extends ServiceMap.Service<ChatAgent, ChatAgentService>()('api/ChatAgent') {
  static readonly Default = Layer.effect(ChatAgent, make);
}
