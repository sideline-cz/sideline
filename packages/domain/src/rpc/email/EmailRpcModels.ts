import { Schema } from 'effect';

export class EmailApprovalForbidden extends Schema.TaggedErrorClass<EmailApprovalForbidden>()(
  'EmailApprovalForbidden',
  {},
) {}

export class EmailRpcMessageNotFound extends Schema.TaggedErrorClass<EmailRpcMessageNotFound>()(
  'EmailRpcMessageNotFound',
  {},
) {}

export class EmailContentView extends Schema.Class<EmailContentView>('EmailContentView')({
  subject: Schema.String,
  from_address: Schema.String,
  short_summary: Schema.OptionFromNullOr(Schema.String),
  summary: Schema.OptionFromNullOr(Schema.String),
  body: Schema.String,
}) {}
