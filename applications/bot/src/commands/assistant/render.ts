/**
 * Pure Discord rendering for `/assistant` threads: the conversation history the server sees, the
 * 2000-char message split, and the proposal confirmation card. The card mirrors the web's
 * `AssistantProposalCard` field-for-field, with the same translation keys, so a proposal reads
 * the same on both surfaces.
 */
import type { AiChatApi, EventRsvp } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import * as Discord from 'dfx/types';
import type { Locale } from '~/locale.js';
import { toDiscordTimestamp } from '~/rest/discordTimestamp.js';
import { formatMoney } from '~/rest/finance/formatMoney.js';

export const DISCORD_MESSAGE_LIMIT = 2000;
// The server's wire caps (`AiChatApi.ChatRequest`): 20 messages of at most 2000 chars each.
export const HISTORY_MAX_MESSAGES = 20;
const CHAT_MESSAGE_MAX = 2000;

export const CONFIRM_PREFIX = 'ai-confirm:';
export const REJECT_PREFIX = 'ai-reject:';

/** Split `text` into Discord-sized chunks, preferring paragraph, then line, then word breaks. */
export const splitMessage = (text: string, limit = DISCORD_MESSAGE_LIMIT): Array<string> => {
  const chunks: Array<string> = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = [
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      window.lastIndexOf(' '),
    ].find((i) => i > limit / 2);
    const at = cut ?? limit;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
};

export interface ThreadMessage {
  readonly author: { readonly id: string; readonly bot?: boolean | null | undefined };
  readonly content: string;
}

/**
 * The thread as the assistant's history, oldest first. The owner's messages are `user` turns, the
 * bot's are `assistant` turns, everyone else's are ignored. Consecutive messages of one role are
 * joined (a long reply is split across several Discord messages), and the history starts at a
 * user turn so the greeting never leads it.
 */
export const buildHistory = (
  newestFirst: ReadonlyArray<ThreadMessage>,
  ownerId: string,
): Array<{ role: AiChatApi.ChatRole; content: string }> => {
  const turns: Array<{ role: AiChatApi.ChatRole; content: string }> = [];
  for (const msg of [...newestFirst].reverse()) {
    const content = msg.content.trim();
    if (content === '') continue;
    const role = msg.author.id === ownerId ? 'user' : msg.author.bot === true ? 'assistant' : null;
    if (role === null) continue;
    const last = turns.at(-1);
    if (last?.role === role) {
      last.content = `${last.content}\n\n${content}`;
    } else {
      turns.push({ role, content });
    }
  }
  const recent = turns.slice(-HISTORY_MAX_MESSAGES);
  const firstUser = recent.findIndex((t) => t.role === 'user');
  return (firstUser === -1 ? [] : recent.slice(firstUser)).map((t) => ({
    role: t.role,
    content: t.content.slice(0, CHAT_MESSAGE_MAX),
  }));
};

const fieldLabels: Record<AiChatApi.ProposalFieldKey, (l: Locale) => string> = {
  title: (locale) => m.event_title({}, { locale }),
  eventType: (locale) => m.event_eventType({}, { locale }),
  start: (locale) => m.assistant_proposal_field_start({}, { locale }),
  end: (locale) => m.assistant_proposal_field_end({}, { locale }),
  trainingType: (locale) => m.event_trainingType({}, { locale }),
  ownerGroup: (locale) => m.event_ownerGroup({}, { locale }),
  memberGroup: (locale) => m.event_memberGroup({}, { locale }),
  location: (locale) => m.event_location({}, { locale }),
  description: (locale) => m.event_description({}, { locale }),
  channel: (locale) => m.assistant_proposal_field_channel({}, { locale }),
  emoji: (locale) => m.channels_emojiLabel({}, { locale }),
  discordName: (locale) => m.channels_namePreview({}, { locale }),
  group: (locale) => m.assistant_proposal_field_group({}, { locale }),
  currentAccess: (locale) => m.assistant_proposal_field_currentAccess({}, { locale }),
  access: (locale) => m.channels_accessLevel_label({}, { locale }),
  archiveCategory: (locale) => m.assistant_proposal_field_archiveCategory({}, { locale }),
  event: (locale) => m.assistant_proposal_field_event({}, { locale }),
  present: (locale) => m.assistant_proposal_field_present({}, { locale }),
  absent: (locale) => m.assistant_proposal_field_absent({}, { locale }),
  response: (locale) => m.assistant_proposal_field_response({}, { locale }),
  message: (locale) => m.assistant_proposal_field_message({}, { locale }),
  member: (locale) => m.assistant_proposal_field_member({}, { locale }),
  roster: (locale) => m.assistant_proposal_field_roster({}, { locale }),
  fee: (locale) => m.assistant_proposal_field_fee({}, { locale }),
  amount: (locale) => m.assistant_proposal_field_amount({}, { locale }),
  date: (locale) => m.assistant_proposal_field_date({}, { locale }),
  method: (locale) => m.assistant_proposal_field_method({}, { locale }),
  note: (locale) => m.assistant_proposal_field_note({}, { locale }),
  category: (locale) => m.assistant_proposal_field_category({}, { locale }),
  plan: (locale) => m.assistant_proposal_field_plan({}, { locale }),
  pricePerTraining: (locale) => m.assistant_proposal_field_pricePerTraining({}, { locale }),
};

const proposalTitles: Record<AiChatApi.Proposal['action'], (l: Locale) => string> = {
  create_event: (locale) => m.assistant_proposal_createEvent_title({}, { locale }),
  create_discord_channel: (locale) =>
    m.assistant_proposal_createDiscordChannel_title({}, { locale }),
  set_discord_channel_access: (locale) =>
    m.assistant_proposal_setDiscordChannelAccess_title({}, { locale }),
  archive_discord_channel: (locale) =>
    m.assistant_proposal_archiveDiscordChannel_title({}, { locale }),
  update_event: (locale) => m.assistant_proposal_updateEvent_title({}, { locale }),
  cancel_event: (locale) => m.assistant_proposal_cancelEvent_title({}, { locale }),
  mark_attendance: (locale) => m.assistant_proposal_markAttendance_title({}, { locale }),
  set_my_rsvp: (locale) => m.assistant_proposal_setMyRsvp_title({}, { locale }),
  set_member_rsvp: (locale) => m.assistant_proposal_setMemberRsvp_title({}, { locale }),
  create_group: (locale) => m.assistant_proposal_createGroup_title({}, { locale }),
  add_group_member: (locale) => m.assistant_proposal_addGroupMember_title({}, { locale }),
  remove_group_member: (locale) => m.assistant_proposal_removeGroupMember_title({}, { locale }),
  create_roster: (locale) => m.assistant_proposal_createRoster_title({}, { locale }),
  add_roster_member: (locale) => m.assistant_proposal_addRosterMember_title({}, { locale }),
  remove_roster_member: (locale) => m.assistant_proposal_removeRosterMember_title({}, { locale }),
  record_payment: (locale) => m.assistant_proposal_recordPayment_title({}, { locale }),
  create_expense: (locale) => m.assistant_proposal_createExpense_title({}, { locale }),
  assign_membership_plan: (locale) =>
    m.assistant_proposal_assignMembershipPlan_title({}, { locale }),
};

const confirmLabels: Record<AiChatApi.Proposal['action'], (l: Locale) => string> = {
  create_event: (locale) => m.assistant_proposal_createEvent_confirm({}, { locale }),
  create_discord_channel: (locale) =>
    m.assistant_proposal_createDiscordChannel_confirm({}, { locale }),
  set_discord_channel_access: (locale) =>
    m.assistant_proposal_setDiscordChannelAccess_confirm({}, { locale }),
  archive_discord_channel: (locale) =>
    m.assistant_proposal_archiveDiscordChannel_confirm({}, { locale }),
  update_event: (locale) => m.assistant_proposal_updateEvent_confirm({}, { locale }),
  cancel_event: (locale) => m.assistant_proposal_cancelEvent_confirm({}, { locale }),
  mark_attendance: (locale) => m.assistant_proposal_markAttendance_confirm({}, { locale }),
  set_my_rsvp: (locale) => m.assistant_proposal_setMyRsvp_confirm({}, { locale }),
  set_member_rsvp: (locale) => m.assistant_proposal_setMemberRsvp_confirm({}, { locale }),
  create_group: (locale) => m.assistant_proposal_createGroup_confirm({}, { locale }),
  add_group_member: (locale) => m.assistant_proposal_addGroupMember_confirm({}, { locale }),
  remove_group_member: (locale) => m.assistant_proposal_removeGroupMember_confirm({}, { locale }),
  create_roster: (locale) => m.assistant_proposal_createRoster_confirm({}, { locale }),
  add_roster_member: (locale) => m.assistant_proposal_addRosterMember_confirm({}, { locale }),
  remove_roster_member: (locale) => m.assistant_proposal_removeRosterMember_confirm({}, { locale }),
  record_payment: (locale) => m.assistant_proposal_recordPayment_confirm({}, { locale }),
  create_expense: (locale) => m.assistant_proposal_createExpense_confirm({}, { locale }),
  assign_membership_plan: (locale) =>
    m.assistant_proposal_assignMembershipPlan_confirm({}, { locale }),
};

export const confirmedLabels: Record<AiChatApi.Proposal['action'], (l: Locale) => string> = {
  create_event: (locale) => m.assistant_proposal_createEvent_confirmed({}, { locale }),
  create_discord_channel: (locale) =>
    m.assistant_proposal_createDiscordChannel_confirmed({}, { locale }),
  set_discord_channel_access: (locale) =>
    m.assistant_proposal_setDiscordChannelAccess_confirmed({}, { locale }),
  archive_discord_channel: (locale) =>
    m.assistant_proposal_archiveDiscordChannel_confirmed({}, { locale }),
  update_event: (locale) => m.assistant_proposal_updateEvent_confirmed({}, { locale }),
  cancel_event: (locale) => m.assistant_proposal_cancelEvent_confirmed({}, { locale }),
  mark_attendance: (locale) => m.assistant_proposal_markAttendance_confirmed({}, { locale }),
  set_my_rsvp: (locale) => m.assistant_proposal_setMyRsvp_confirmed({}, { locale }),
  set_member_rsvp: (locale) => m.assistant_proposal_setMemberRsvp_confirmed({}, { locale }),
  create_group: (locale) => m.assistant_proposal_createGroup_confirmed({}, { locale }),
  add_group_member: (locale) => m.assistant_proposal_addGroupMember_confirmed({}, { locale }),
  remove_group_member: (locale) => m.assistant_proposal_removeGroupMember_confirmed({}, { locale }),
  create_roster: (locale) => m.assistant_proposal_createRoster_confirmed({}, { locale }),
  add_roster_member: (locale) => m.assistant_proposal_addRosterMember_confirmed({}, { locale }),
  remove_roster_member: (locale) =>
    m.assistant_proposal_removeRosterMember_confirmed({}, { locale }),
  record_payment: (locale) => m.assistant_proposal_recordPayment_confirmed({}, { locale }),
  create_expense: (locale) => m.assistant_proposal_createExpense_confirmed({}, { locale }),
  assign_membership_plan: (locale) =>
    m.assistant_proposal_assignMembershipPlan_confirmed({}, { locale }),
};

const accessLabels: Record<AiChatApi.ProposalAccessLevel, (l: Locale) => string> = {
  VIEW: (locale) => m.channels_accessLevel_view({}, { locale }),
  EDIT: (locale) => m.channels_accessLevel_edit({}, { locale }),
  ADMIN: (locale) => m.channels_accessLevel_admin({}, { locale }),
  NONE: (locale) => m.assistant_proposal_accessNone({}, { locale }),
};

const rsvpLabels: Record<EventRsvp.RsvpResponse, (l: Locale) => string> = {
  yes: (locale) => m.rsvp_yes({}, { locale }),
  coming_later: (locale) => m.rsvp_comingLater({}, { locale }),
  maybe: (locale) => m.rsvp_maybe({}, { locale }),
  no: (locale) => m.rsvp_no({}, { locale }),
};

const eventTypeLabels = {
  training: (locale: Locale) => m.event_type_training({}, { locale }),
  match: (locale: Locale) => m.event_type_match({}, { locale }),
  tournament: (locale: Locale) => m.event_type_tournament({}, { locale }),
  meeting: (locale: Locale) => m.event_type_meeting({}, { locale }),
  social: (locale: Locale) => m.event_type_social({}, { locale }),
  other: (locale: Locale) => m.event_type_other({}, { locale }),
};

const paymentMethodLabels = {
  cash: (locale: Locale) => m.finance_payment_method_cash({}, { locale }),
  bank_transfer: (locale: Locale) => m.finance_payment_method_bank_transfer({}, { locale }),
  credit: (locale: Locale) => m.finance_payment_method_credit({}, { locale }),
};

const expenseCategoryLabels = {
  fields: (locale: Locale) => m.expense_category_fields({}, { locale }),
  equipment: (locale: Locale) => m.expense_category_equipment({}, { locale }),
  travel: (locale: Locale) => m.expense_category_travel({}, { locale }),
  tournaments: (locale: Locale) => m.expense_category_tournaments({}, { locale }),
  other: (locale: Locale) => m.expense_category_other({}, { locale }),
};

const formatValue = (value: AiChatApi.ProposalFieldValue, locale: Locale): string => {
  switch (value.type) {
    case 'text':
      return value.value === '' ? '—' : value.value;
    case 'instant':
      return toDiscordTimestamp(value.value, 'f');
    case 'date':
      // A team-local calendar date: shown verbatim, never re-zoned.
      return value.value;
    case 'eventType':
      return eventTypeLabels[value.value](locale);
    case 'accessLevel':
      return accessLabels[value.value](locale);
    case 'rsvpResponse':
      return rsvpLabels[value.value](locale);
    case 'money':
      return formatMoney(value.value.amountMinor, value.value.currency, locale);
    case 'paymentMethod':
      return paymentMethodLabels[value.value](locale);
    case 'expenseCategory':
      return expenseCategoryLabels[value.value](locale);
    case 'planName':
      return value.value ?? m.membershipPlan_defaultName({}, { locale });
    case 'none':
      return m.assistant_proposal_fieldNotSet({}, { locale });
  }
};

// Discord caps: 25 embed fields, 1024 chars per field value.
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The confirmation card: one embed listing every field, plus Confirm / Discard buttons. */
export const buildProposalMessage = (proposal: AiChatApi.Proposal, locale: Locale) => ({
  embeds: [
    {
      title: proposalTitles[proposal.action](locale),
      color: 0x5865f2,
      fields: proposal.summary.slice(0, 25).map((field) => ({
        name: fieldLabels[field.key](locale),
        value: clip(formatValue(field.value, locale), 1024),
        inline: false,
      })),
      description: m.assistant_proposal_expiresAt(
        { time: toDiscordTimestamp(proposal.expiresAt, 't') },
        { locale },
      ),
    },
  ],
  components: [
    UI.row([
      UI.button({
        style: Discord.ButtonStyleTypes.SUCCESS,
        label: confirmLabels[proposal.action](locale),
        custom_id: `${CONFIRM_PREFIX}${proposal.id}`,
      }),
      UI.button({
        style: Discord.ButtonStyleTypes.SECONDARY,
        label: m.assistant_proposal_reject({}, { locale }),
        custom_id: `${REJECT_PREFIX}${proposal.id}`,
      }),
    ]),
  ],
});
