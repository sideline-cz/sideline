/**
 * The read-only in-app AI assistant (plan §3): one capabilities endpoint and one chat
 * endpoint, team-scoped. `EntityRef` is the typed view-model union every card in the answer
 * is rendered from — the model never controls a fact the user can act on, only which
 * server-held entity is shown and which sentence mentions it. `degradedReason` is a closed
 * union resolved client-side through a label map, never a sentinel embedded in `answer`.
 */
import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import * as EventApi from '~/api/EventApi.js';
import * as GroupApi from '~/api/GroupApi.js';
import * as Roster from '~/api/Roster.js';
import * as TrainingTypeApi from '~/api/TrainingTypeApi.js';
import { AiActionName, AiActionProposalId } from '~/models/AiActionProposal.js';
import { EventType } from '~/models/Event.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const ChatRole = Schema.Literals(['user', 'assistant']);
export type ChatRole = typeof ChatRole.Type;

export class ChatMessage extends Schema.Class<ChatMessage>('AiChatMessage')({
  role: ChatRole,
  content: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(2000)),
  ),
}) {}

export const ChatRequest = Schema.Struct({
  messages: Schema.Array(ChatMessage).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(20)),
  ),
});
export type ChatRequest = Schema.Schema.Type<typeof ChatRequest>;

/**
 * Closed union. The client maps it through an explicit `Record<DegradedReason, () => string>`
 * (the `applications/web/src/lib/event-labels.ts:13` idiom) — NEVER `tr(runtimeString)`.
 * Present exactly when `generated === false`.
 */
export const DegradedReason = Schema.Literals([
  'not_configured', // no LLM is configured (stub client)
  'disabled', // AI_CHAT_ENABLED is off
  'provider_error', // LlmError, or any defect caught by the catchCause net
  'too_many_steps', // MAX_TOOL_ITERATIONS exhausted
  'empty_answer', // the model returned no usable content
]);
export type DegradedReason = Schema.Schema.Type<typeof DegradedReason>;

export class Capabilities extends Schema.Class<Capabilities>('AiChatCapabilities')({
  enabled: Schema.Boolean,
}) {}

/**
 * The per-turn opaque marker token (plan §4). 4 chars from a 32-character unambiguous
 * alphabet — NOT an index, and deliberately not orderable.
 */
export const RefToken = Schema.String.pipe(
  Schema.check(Schema.isMinLength(4)),
  Schema.check(Schema.isMaxLength(4)),
);
export type RefToken = typeof RefToken.Type;

/**
 * The five `EntityRef`/`SearchHit` variants' fields, hoisted out so both unions are built from
 * the same records — `EntityRef` is a `SearchHit` plus the per-turn `ref` token, and there is no
 * other way for the two to drift apart. `kind` is the discriminant, precedent
 * `TeamGenerationApi.GenerationWarning`, with `kind` in place of `_tag`. Each variant carries
 * exactly what the assistant's result card consumes, as typed data, and reuses the existing
 * per-entity list schema wherever one already exists — so an assistant card and the entity's
 * own list page are fed by the same shape and cannot drift.
 *
 * `member` is the one exception: `Roster.RosterPlayer` carries `discordId`, `userId`,
 * `username`, `birthDate`, `gender` and `permissions` — PII this surface must never ship. It is
 * a bespoke, allow-listed projection instead. `discordId` is not itself a field on the wire, but
 * it remains DERIVABLE from `avatarUrl` (the server embeds the snowflake in the Discord CDN
 * URL path) — at parity with `PlayerCard.tsx` under the same `member:view` gate, not a new
 * exposure this surface introduces.
 */
const eventFields = { kind: Schema.Literal('event'), event: EventApi.EventInfo } as const;
const memberFields = {
  kind: Schema.Literal('member'),
  memberId: TeamMemberId,
  displayName: Schema.String,
  avatarUrl: Schema.OptionFromNullOr(Schema.String),
  jerseyNumber: Schema.OptionFromNullOr(Schema.Number),
  roleNames: Schema.Array(Schema.String),
  effectiveRoles: Schema.Array(Roster.EffectiveRole),
  active: Schema.Boolean,
} as const;
const groupFields = { kind: Schema.Literal('group'), group: GroupApi.GroupInfo } as const;
const rosterFields = { kind: Schema.Literal('roster'), roster: Roster.RosterInfo } as const;
const trainingTypeFields = {
  kind: Schema.Literal('trainingType'),
  trainingType: TrainingTypeApi.TrainingTypeInfo,
} as const;

/**
 * Every variant of `EntityRef` minus the per-turn `ref` token — what a read tool emits before
 * `ChatAgent` mints the turn's token, and what the command-palette search endpoint returns
 * directly (that endpoint has no notion of a chat turn). A hit's identity is `"<kind>:<id>"`
 * (`SearchApi.searchHitId`), not `ref` — `SearchHit` carries no `ref` field at all.
 */
export const SearchHit = Schema.Union([
  Schema.Struct(eventFields),
  Schema.Struct(memberFields),
  Schema.Struct(groupFields),
  Schema.Struct(rosterFields),
  Schema.Struct(trainingTypeFields),
]);
export type SearchHit = Schema.Schema.Type<typeof SearchHit>;

/**
 * The typed view-model union `references` is built from — `SearchHit`'s field records plus the
 * per-turn `ref` token. Spreading the field record first puts `ref` LAST in the encoded object
 * (same keys and values as before this was split out of `SearchHit`, but NOT the same key
 * order — see the domain test for why that distinction matters to the guard assertion).
 */
export const EntityRef = Schema.Union([
  Schema.Struct({ ...eventFields, ref: RefToken }),
  Schema.Struct({ ...memberFields, ref: RefToken }),
  Schema.Struct({ ...groupFields, ref: RefToken }),
  Schema.Struct({ ...rosterFields, ref: RefToken }),
  Schema.Struct({ ...trainingTypeFields, ref: RefToken }),
]);
export type EntityRef = Schema.Schema.Type<typeof EntityRef>;

/**
 * The write path (plan §4-§5): the model never writes directly. `chat` may return a `Proposal`
 * — a closed, typed summary of one pending action — which the client renders as a confirmation
 * card and the user must explicitly confirm or reject via `confirmProposal`/`rejectProposal`.
 * `confirmProposal` takes NO payload: the action's data lives entirely server-side, keyed by
 * `proposalId`, so there is nothing on the wire for a client to tamper with before confirming.
 * Do not add a `payload:` to `confirmProposal` "for symmetry" — that absence is the point.
 */
export const ProposalFieldKey = Schema.Literals([
  'title',
  'eventType',
  'start',
  'end',
  'trainingType',
  'ownerGroup',
  'memberGroup',
  'location',
  'description',
]);
export type ProposalFieldKey = typeof ProposalFieldKey.Type;

/**
 * `type`, not `_tag` — these are view-model variants, matching `EntityRef.kind` above
 * (`packages/domain/AGENTS.md` -> "Model-Cited Entities" rule 3 reserves `_tag` for tagged
 * errors). Uniform `value` key; `none` carries nothing. There is no `allDay` boolean anywhere:
 * all-day is carried by `start`/`end` arriving as `date` instead of `instant`, so a card saying
 * "All day: yes" next to a time is structurally impossible. `date` crosses as a bare
 * `YYYY-MM-DD` string, never a `DateTime` — the client must never parse it into a `Date` (that
 * would re-introduce a client-side off-by-one-day around the reader's timezone).
 */
export const ProposalFieldValue = Schema.Union([
  Schema.Struct({ type: Schema.Literal('text'), value: Schema.String }),
  Schema.Struct({ type: Schema.Literal('instant'), value: Schemas.DateTimeFromIsoString }),
  Schema.Struct({ type: Schema.Literal('date'), value: Schema.String }), // team-local YYYY-MM-DD
  Schema.Struct({ type: Schema.Literal('eventType'), value: EventType }),
  Schema.Struct({ type: Schema.Literal('none') }),
]);
export type ProposalFieldValue = Schema.Schema.Type<typeof ProposalFieldValue>;

export class ProposalField extends Schema.Class<ProposalField>('AiProposalField')({
  key: ProposalFieldKey,
  value: ProposalFieldValue,
}) {}

/**
 * A pending action awaiting user confirmation. `summary` is always all nine
 * `ProposalFieldKey`s (a field the action left unset still appears, as `{ type: 'none' }`) so
 * the card renders a fixed layout, never a jagged one driven by what the model happened to fill.
 */
export class Proposal extends Schema.Class<Proposal>('AiProposal')({
  id: AiActionProposalId,
  action: AiActionName,
  summary: Schema.Array(ProposalField),
  expiresAt: Schemas.DateTimeFromIsoString,
}) {}

export class ChatResponse extends Schema.Class<ChatResponse>('AiChatResponse')({
  answer: Schema.String,
  generated: Schema.Boolean,
  degradedReason: Schema.OptionFromNullOr(DegradedReason),
  references: Schema.Array(EntityRef),
  proposal: Schema.OptionFromNullOr(Proposal),
}) {}

export class AiChatForbidden extends Schema.TaggedErrorClass<AiChatForbidden>()(
  'AiChatForbidden',
  {},
) {}

export class AiChatRateLimited extends Schema.TaggedErrorClass<AiChatRateLimited>()(
  'AiChatRateLimited',
  { retryAfterSeconds: Schema.Int },
) {}

// --- Proposal confirm/reject errors ---

export class AiProposalNotFound extends Schema.TaggedErrorClass<AiProposalNotFound>()(
  'AiProposalNotFound',
  {},
) {}

export class AiProposalAlreadyUsed extends Schema.TaggedErrorClass<AiProposalAlreadyUsed>()(
  'AiProposalAlreadyUsed',
  {},
) {}

export class AiProposalExpired extends Schema.TaggedErrorClass<AiProposalExpired>()(
  'AiProposalExpired',
  {},
) {}

export class AiProposalActionForbidden extends Schema.TaggedErrorClass<AiProposalActionForbidden>()(
  'AiProposalActionForbidden',
  {},
) {}

export class AiChatApiGroup extends HttpApiGroup.make('aiChat')
  .add(
    HttpApiEndpoint.get('getCapabilities', '/teams/:teamId/ai/capabilities', {
      success: Capabilities,
      error: AiChatForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('chat', '/teams/:teamId/ai/chat', {
      success: ChatResponse,
      error: [
        AiChatForbidden.pipe(HttpApiSchema.status(403)),
        AiChatRateLimited.pipe(HttpApiSchema.status(429)),
      ],
      payload: ChatRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    // Deliberately no `payload:` — see the doc comment above `ProposalFieldKey`. The action's
    // data was already persisted server-side by the `propose` tool call; confirming only needs
    // to know WHICH pending proposal to execute, and that's the path param.
    HttpApiEndpoint.post('confirmProposal', '/teams/:teamId/ai/proposals/:proposalId/confirm', {
      success: EventApi.EventInfo.pipe(HttpApiSchema.status(201)),
      error: [
        AiChatForbidden.pipe(HttpApiSchema.status(403)),
        AiProposalNotFound.pipe(HttpApiSchema.status(404)),
        AiProposalAlreadyUsed.pipe(HttpApiSchema.status(409)),
        AiProposalExpired.pipe(HttpApiSchema.status(410)),
        AiProposalActionForbidden.pipe(HttpApiSchema.status(403)),
      ],
      params: { teamId: TeamId, proposalId: AiActionProposalId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('rejectProposal', '/teams/:teamId/ai/proposals/:proposalId/reject', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        AiChatForbidden.pipe(HttpApiSchema.status(403)),
        AiProposalNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, proposalId: AiActionProposalId },
    }).middleware(AuthMiddleware),
  ) {}
