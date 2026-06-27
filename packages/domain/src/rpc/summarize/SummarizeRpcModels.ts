import { Schema } from 'effect';

export class TranscriptMessage extends Schema.Class<TranscriptMessage>('TranscriptMessage')({
  author: Schema.String,
  content: Schema.String,
  timestamp: Schema.DateTimeUtc,
}) {}

export class SummarizeChannelInput extends Schema.Class<SummarizeChannelInput>(
  'SummarizeChannelInput',
)({
  messages: Schema.Array(TranscriptMessage),
  channelName: Schema.OptionFromNullOr(Schema.String),
  locale: Schema.Literals(['en', 'cs']),
}) {}

export class SummarizeChannelResult extends Schema.Class<SummarizeChannelResult>(
  'SummarizeChannelResult',
)({
  summary: Schema.String,
  generated: Schema.Boolean,
  summarizedCount: Schema.Number,
}) {}
