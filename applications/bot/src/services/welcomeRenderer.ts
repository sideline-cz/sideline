import type { APIEmbed, APIEmbedField } from 'discord-api-types/v10';
import { Option } from 'effect';

export const buildWelcomeEmbed = (params: {
  readonly rendered: string;
  readonly groupName: Option.Option<string>;
  readonly colorInt: number;
  readonly memberDisplayName: string;
}): APIEmbed => {
  const fields: APIEmbedField[] = [];

  if (Option.isSome(params.groupName)) {
    fields.push({ name: 'Group', value: params.groupName.value, inline: true });
  }

  return {
    color: params.colorInt,
    description: params.rendered,
    author: { name: params.memberDisplayName },
    ...(fields.length > 0 ? { fields } : {}),
  };
};

export const buildSystemLogEmbed = (params: {
  readonly username: string;
  readonly memberId: string;
  readonly inviteCode: Option.Option<string>;
  readonly inviterId: Option.Option<string>;
  readonly groupName: Option.Option<string>;
}): APIEmbed => {
  const fields: APIEmbedField[] = [
    { name: 'Member', value: `<@${params.memberId}> (${params.username})`, inline: false },
    {
      name: 'Invite code',
      value: Option.getOrElse(params.inviteCode, () => '—'),
      inline: true,
    },
  ];

  if (Option.isSome(params.inviterId)) {
    fields.push({ name: 'Inviter', value: `<@${params.inviterId.value}>`, inline: true });
  }

  if (Option.isSome(params.groupName)) {
    fields.push({ name: 'Group', value: params.groupName.value, inline: true });
  }

  return {
    title: 'Member joined',
    fields,
  };
};
