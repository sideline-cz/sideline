import { Schema } from 'effect';
import { Snowflake } from '~/models/Discord.js';
import { PollId, PollOptionId, PollStatus } from '~/models/Poll.js';

export class PollOptionView extends Schema.Class<PollOptionView>('PollOptionView')({
  option_id: PollOptionId,
  label: Schema.String,
  position: Schema.Number,
  vote_count: Schema.Number,
}) {}

export class PollView extends Schema.Class<PollView>('PollView')({
  poll_id: PollId,
  discord_channel_id: Snowflake,
  discord_message_id: Schema.OptionFromNullOr(Snowflake),
  question: Schema.String,
  status: PollStatus,
  multiple: Schema.Boolean,
  allowed_role_id: Schema.OptionFromNullOr(Snowflake),
  deadline: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
  total_votes: Schema.Number,
  options: Schema.Array(PollOptionView),
  my_option_ids: Schema.Array(PollOptionId),
}) {}

export class CastVoteResult extends Schema.Class<CastVoteResult>('CastVoteResult')({
  view: PollView,
  my_option_ids: Schema.Array(PollOptionId),
  action: Schema.Literals(['added', 'removed', 'moved', 'counted', 'retracted']),
}) {}

export class AddOptionResult extends Schema.Class<AddOptionResult>('AddOptionResult')({
  option_id: PollOptionId,
  view: PollView,
}) {}

export class PollGuildNotFound extends Schema.TaggedErrorClass<PollGuildNotFound>()(
  'PollGuildNotFound',
  {},
) {}

export class PollNotMember extends Schema.TaggedErrorClass<PollNotMember>()('PollNotMember', {}) {}

export class PollForbidden extends Schema.TaggedErrorClass<PollForbidden>()('PollForbidden', {}) {}

export class PollNotFound extends Schema.TaggedErrorClass<PollNotFound>()('PollNotFound', {}) {}

export class PollClosed extends Schema.TaggedErrorClass<PollClosed>()('PollClosed', {}) {}

export class PollOptionNotFound extends Schema.TaggedErrorClass<PollOptionNotFound>()(
  'PollOptionNotFound',
  {},
) {}

export class PollOptionLimitReached extends Schema.TaggedErrorClass<PollOptionLimitReached>()(
  'PollOptionLimitReached',
  {},
) {}

export class PollDuplicateOption extends Schema.TaggedErrorClass<PollDuplicateOption>()(
  'PollDuplicateOption',
  {},
) {}

export class PollAddOptionForbidden extends Schema.TaggedErrorClass<PollAddOptionForbidden>()(
  'PollAddOptionForbidden',
  {},
) {}

export class PollTooFewOptions extends Schema.TaggedErrorClass<PollTooFewOptions>()(
  'PollTooFewOptions',
  {},
) {}

export class PollTooManyOptions extends Schema.TaggedErrorClass<PollTooManyOptions>()(
  'PollTooManyOptions',
  {},
) {}

export class PollOptionTooLong extends Schema.TaggedErrorClass<PollOptionTooLong>()(
  'PollOptionTooLong',
  {},
) {}

export class PollInvalidDeadline extends Schema.TaggedErrorClass<PollInvalidDeadline>()(
  'PollInvalidDeadline',
  {},
) {}

export class PollDeadlineInPast extends Schema.TaggedErrorClass<PollDeadlineInPast>()(
  'PollDeadlineInPast',
  {},
) {}
