/**
 * The read-only in-app AI assistant (plan §3): one capabilities endpoint and one chat
 * endpoint, team-scoped. `EntityRef` is the typed view-model union every card in the answer
 * is rendered from — the model never controls a fact the user can act on, only which
 * server-held entity is shown and which sentence mentions it. `degradedReason` is a closed
 * union resolved client-side through a label map, never a sentinel embedded in `answer`.
 */
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import * as EventApi from '~/api/EventApi.js';
import * as GroupApi from '~/api/GroupApi.js';
import * as Roster from '~/api/Roster.js';
import * as TrainingTypeApi from '~/api/TrainingTypeApi.js';
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
 * The typed view-model union `references` is built from. Discriminated on `kind`, precedent
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
export const EntityRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('event'), ref: RefToken, event: EventApi.EventInfo }),
  Schema.Struct({
    kind: Schema.Literal('member'),
    ref: RefToken,
    memberId: TeamMemberId,
    displayName: Schema.String,
    avatarUrl: Schema.OptionFromNullOr(Schema.String),
    jerseyNumber: Schema.OptionFromNullOr(Schema.Number),
    roleNames: Schema.Array(Schema.String),
    effectiveRoles: Schema.Array(Roster.EffectiveRole),
    active: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal('group'), ref: RefToken, group: GroupApi.GroupInfo }),
  Schema.Struct({ kind: Schema.Literal('roster'), ref: RefToken, roster: Roster.RosterInfo }),
  Schema.Struct({
    kind: Schema.Literal('trainingType'),
    ref: RefToken,
    trainingType: TrainingTypeApi.TrainingTypeInfo,
  }),
]);
export type EntityRef = Schema.Schema.Type<typeof EntityRef>;

export class ChatResponse extends Schema.Class<ChatResponse>('AiChatResponse')({
  answer: Schema.String,
  generated: Schema.Boolean,
  degradedReason: Schema.OptionFromNullOr(DegradedReason),
  references: Schema.Array(EntityRef),
}) {}

export class AiChatForbidden extends Schema.TaggedErrorClass<AiChatForbidden>()(
  'AiChatForbidden',
  {},
) {}

export class AiChatRateLimited extends Schema.TaggedErrorClass<AiChatRateLimited>()(
  'AiChatRateLimited',
  { retryAfterSeconds: Schema.Int },
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
  ) {}
