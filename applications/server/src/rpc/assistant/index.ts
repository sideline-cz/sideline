/**
 * The bot's door into the AI assistant (`/assistant` threads). Every turn, confirm and reject runs
 * through `services/ai/turns.ts` — the exact path the web's `api/ai-chat.ts` uses — as the
 * Discord user's linked Sideline account, with that account's team membership and permissions.
 */
import {
  type AiActionProposal,
  type AiChatApi,
  AssistantRpcGroup,
  AssistantRpcModels,
  type Discord,
} from '@sideline/domain';
import { Effect, Option } from 'effect';
import { DiscordAssistantThreadsRepository } from '~/repositories/DiscordAssistantThreadsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AiChatEnabledConfig } from '~/services/AiChatEnabledConfig.js';
import type { ConfirmResult } from '~/services/ai/actions.js';
import { chatTurn, confirmTurn, rejectTurn } from '~/services/ai/turns.js';
import type { ChatAgentResult } from '~/services/ChatAgent.js';
import { LlmClient } from '~/services/LlmClient.js';

type TurnServices =
  | Effect.Services<ReturnType<typeof chatTurn>>
  | Effect.Services<ReturnType<typeof confirmTurn>>
  | Effect.Services<ReturnType<typeof rejectTurn>>;

const MARKER = /\[\[ref:([a-z0-9]{4})\]\]/g;

const entityName = (ref: AiChatApi.EntityRef): string => {
  switch (ref.kind) {
    case 'event':
      return ref.event.title;
    case 'member':
      return ref.displayName;
    case 'group':
      return ref.group.name;
    case 'roster':
      return ref.roster.name;
    case 'trainingType':
      return ref.trainingType.name;
    case 'role':
      return ref.role.name;
    case 'expense':
      return ref.description;
  }
};

/** Discord has no entity card: each cited `[[ref:xxxx]]` becomes the entity's name in bold. */
export const renderAnswer = (
  answer: string,
  references: ReadonlyArray<AiChatApi.EntityRef>,
): string =>
  answer.replace(MARKER, (_whole, token: string) => {
    const ref = references.find((r) => r.ref === token);
    return ref === undefined ? '' : `**${entityName(ref)}**`;
  });

export const toAssistantTurn = (result: ChatAgentResult): AssistantRpcModels.AssistantTurn => ({
  answer: renderAnswer(result.answer, result.references),
  degraded_reason: Option.getOrNull(result.degradedReason),
  proposal: Option.getOrNull(result.proposal),
});

const toOutcome = (result: ConfirmResult): AssistantRpcModels.AssistantConfirmOutcome => {
  switch (result.kind) {
    case 'event_created':
      return 'created';
    case 'discord_queued':
      return 'queued';
    case 'event_updated':
    case 'event_cancelled':
    case 'attendance_confirmed':
    case 'rsvp_submitted':
    case 'applied':
      return 'applied';
  }
};

export const AssistantRpcLive = Effect.Do.pipe(
  Effect.bind('teams', () => TeamsRepository.asEffect()),
  Effect.bind('users', () => UsersRepository.asEffect()),
  Effect.bind('members', () => TeamMembersRepository.asEffect()),
  Effect.bind('threads', () => DiscordAssistantThreadsRepository.asEffect()),
  Effect.bind('llm', () => LlmClient.asEffect()),
  Effect.bind('aiChatEnabledConfig', () => AiChatEnabledConfig.asEffect()),
  // Captured once so the handlers' `R` is `never` — a service acquired inside an RPC handler
  // leaks into the group's requirements and fails the build far away, in `run.ts`.
  Effect.bind('turnServices', () => Effect.services<TurnServices>()),
  Effect.map(({ teams, users, members, threads, llm, aiChatEnabledConfig, turnServices }) => {
    const notLinked = new AssistantRpcModels.AssistantNotLinked();
    const notMember = new AssistantRpcModels.AssistantNotMember();

    /** Guild → team, Discord account → user → active membership. */
    const resolveActor = (guildId: Discord.Snowflake, discordUserId: Discord.Snowflake) =>
      Effect.Do.pipe(
        Effect.bind('user', () =>
          users
            .findByDiscordId(discordUserId)
            .pipe(
              Effect.flatMap(
                Option.match({ onNone: () => Effect.fail(notLinked), onSome: Effect.succeed }),
              ),
            ),
        ),
        Effect.bind('team', () =>
          teams
            .findByGuildId(guildId)
            .pipe(
              Effect.flatMap(
                Option.match({ onNone: () => Effect.fail(notMember), onSome: Effect.succeed }),
              ),
            ),
        ),
        Effect.bind('membership', ({ team, user }) =>
          members
            .findMembershipByIds(team.id, user.id)
            .pipe(
              Effect.flatMap(
                Option.match({ onNone: () => Effect.fail(notMember), onSome: Effect.succeed }),
              ),
            ),
        ),
      );

    type Actor = {
      readonly guild_id: Discord.Snowflake;
      readonly discord_user_id: Discord.Snowflake;
    };
    type ProposalPayload = Actor & { readonly proposal_id: AiActionProposal.AiActionProposalId };

    return {
      'Assistant/Authorize': ({ guild_id, discord_user_id }: Actor) =>
        resolveActor(guild_id, discord_user_id).pipe(
          Effect.andThen(aiChatEnabledConfig.asEffect),
          Effect.map((enabled) => ({ enabled: enabled && llm.configured })),
        ),

      'Assistant/RegisterThread': ({
        guild_id,
        discord_user_id,
        thread_id,
      }: Actor & { readonly thread_id: Discord.Snowflake }) =>
        resolveActor(guild_id, discord_user_id).pipe(
          Effect.flatMap(({ team, user }) =>
            threads.insert({ thread_id, team_id: team.id, user_id: user.id }),
          ),
        ),

      'Assistant/GetThreadOwner': ({ thread_id }: { readonly thread_id: Discord.Snowflake }) =>
        threads.findByThreadId(thread_id).pipe(
          Effect.map(
            Option.match({
              onNone: () => null,
              onSome: (row) => ({
                owner_discord_id: row.owner_discord_id,
                locale: row.owner_locale,
              }),
            }),
          ),
        ),

      'Assistant/Chat': ({
        thread_id,
        discord_user_id,
        messages,
      }: {
        readonly thread_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
        readonly messages: ReadonlyArray<AiChatApi.ChatMessage>;
      }) =>
        Effect.Do.pipe(
          Effect.bind('thread', () =>
            threads.findByThreadId(thread_id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new AssistantRpcModels.AssistantThreadNotFound()),
                  onSome: (row) =>
                    row.owner_discord_id === discord_user_id
                      ? Effect.succeed(row)
                      : Effect.fail(new AssistantRpcModels.AssistantThreadNotFound()),
                }),
              ),
            ),
          ),
          Effect.bind('membership', ({ thread }) =>
            members
              .findMembershipByIds(thread.team_id, thread.user_id)
              .pipe(
                Effect.flatMap(
                  Option.match({ onNone: () => Effect.fail(notMember), onSome: Effect.succeed }),
                ),
              ),
          ),
          Effect.flatMap(({ thread, membership }) =>
            chatTurn(thread.team_id, membership, messages).pipe(
              Effect.provideServices(turnServices),
            ),
          ),
          Effect.map(toAssistantTurn),
        ),

      'Assistant/ConfirmProposal': ({ guild_id, discord_user_id, proposal_id }: ProposalPayload) =>
        resolveActor(guild_id, discord_user_id).pipe(
          Effect.flatMap(({ team, membership }) =>
            confirmTurn(team.id, membership, proposal_id).pipe(
              Effect.provideServices(turnServices),
            ),
          ),
          Effect.map(({ result, action }) => ({ outcome: toOutcome(result), action })),
        ),

      'Assistant/RejectProposal': ({ guild_id, discord_user_id, proposal_id }: ProposalPayload) =>
        resolveActor(guild_id, discord_user_id).pipe(
          Effect.flatMap(({ team, membership }) =>
            rejectTurn(team.id, membership, proposal_id).pipe(Effect.provideServices(turnServices)),
          ),
        ),
    };
  }),
  (handlers) => AssistantRpcGroup.AssistantRpcGroup.toLayer(handlers),
);
